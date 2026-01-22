/**
 * settlements.js — Оптимізований синк взаєморозрахунків (Project ROZA)
 * 
 * Логіка:
 *  - Пропускаємо файли, які не оновилися (перевірка по modifiedTime)
 *  - Обчислюємо баланс від початку (сума всіх delta з файлу)
 *  - Зберігаємо тільки операції за останні 15 днів для швидкого відображення
 *  - При кожній синхронізації перезаписуємо операції за 15 днів (видаляємо старі, додаємо нові)
 * 
 * Розклад:
 *  - Будні (13:00, 18:00): синхронізація оновлених файлів
 */
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const iconv = require("iconv-lite");
const Papa = require("papaparse");
const { google } = require("googleapis");

const db = getFirestore();

/** Константи з env, з фолбеком */
const REGION = process.env.FUNCTION_REGION || "europe-central2";
const APP_ID = process.env.APP_ID || "embryo-project";

/** ID папки Google Drive з файлами взаєморозрахунків */
const FOLDER_ID = "1ak0Ut14CDJSJB7Gy37k6EYs3HkigIk0C";

/* ------------------------- helpers ------------------------- */
function parseSettlementsDate(dateStr) {
  const s = String(dateStr).trim().replace(/\./g, "-");
  const parts = s.split("-");
  if (parts.length !== 3) return null;
  const day = parts[0].length === 4 ? parts[2] : parts[0];
  const month = parts[1];
  const year = parts[0].length === 4 ? parts[0] : parts[2];
  const d = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12, 0, 0));
  return d.toString() !== "Invalid Date" ? d : null;
}
function parseSettlementsNumber(str) {
  if (str == null) return 0;
  const s = String(str).replace(/\s/g, "").replace("+", "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
function parseSettlementsFileName(fileName) {
  // очікуємо NAME як <CLIENTCODE>_<CCY>.csv (наприклад 00010_UAH.csv, 00021_EUR.csv)
  // Формат: 5 цифр з ведучими нулями (або будь-яка кількість цифр) + підкреслення + валюта
  const m = String(fileName).match(/^(\d+)_([A-Z]{3})\.csv$/i);
  if (!m) return null;
  const clientCodeFromFile = m[1];
  // Зберігаємо clientCode як є (з ведучими нулями, якщо вони є)
  // Але для сумісності також нормалізуємо (прибираємо ведучі нулі)
  const normalizedClientCode = String(parseInt(clientCodeFromFile, 10));
  return { clientCode: normalizedClientCode, currency: m[2].toUpperCase() };
}
function rfc3339DaysAgo(days) {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString();
}
async function listCsvFiles({ drive, folderId, sinceDays }) {
  const filters = [`'${folderId}' in parents`, `mimeType='text/csv'`, `trashed=false`];
  if (sinceDays != null) filters.push(`modifiedTime >= '${rfc3339DaysAgo(sinceDays)}'`);
  const q = filters.join(" and ");
  const res = await drive.files.list({
    q,
    fields: "files(id,name,modifiedTime,md5Checksum,size)",
    orderBy: "modifiedTime desc",
    pageSize: 1000,
  });
  return res.data.files || [];
}
async function downloadCsvCp1251({ drive, fileId }) {
  const contentResp = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
  const csvData = iconv.decode(Buffer.from(contentResp.data), "cp1251");
  const parsedCsv = Papa.parse(csvData, { header: true, skipEmptyLines: true, delimiter: ";" });
  return parsedCsv.data;
}
function stableDocKey(row) {
  // як і раніше: YYYYMMDD-<docTypeCode>-<document_id>
  const docDate = parseSettlementsDate(row.document_date);
  if (!docDate) return null;
  const ymd = docDate.toISOString().slice(0, 10).replace(/-/g, "");
  const docCode = String(row.document_type_code || "").trim();
  const docId = String(row.document_id || "").trim();
  return `${ymd}-${docCode}-${docId}`;
}
async function commitInBatches(ops) {
  // ops: масив функцій, кожна приймає batch і додає операцію
  const CHUNK = 400;
  for (let i = 0; i < ops.length; i += CHUNK) {
    const batch = db.batch();
    for (const fn of ops.slice(i, i + CHUNK)) fn(batch);
    await batch.commit();
  }
}

function getDaysAgoDate(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d;
}

function isDateWithinLastNDays(date, days) {
  if (!date) return false;
  const dateObj = date instanceof Date ? date : date.toDate ? date.toDate() : new Date(date);
  const cutoffDate = getDaysAgoDate(days);
  return dateObj >= cutoffDate;
}

/* ---------------------- core sync ---------------------- */
async function settlementsSyncCore() {
  logger.info("Settlements sync started.");

  const gauth = new google.auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/drive"] });
  const drive = google.drive({ version: "v3", auth: gauth });

  // 1) Отримуємо список всіх CSV файлів
  const files = await listCsvFiles({ drive, folderId: FOLDER_ID, sinceDays: null });
  if (!files.length) {
    logger.info("No settlement files found to process.");
    return;
  }
  logger.info(`Total files found: ${files.length}`);

  const DAYS_TO_KEEP = 15; // Зберігаємо операції за останні 15 днів
  const cutoffDate = getDaysAgoDate(DAYS_TO_KEEP);

  for (const file of files) {
    const meta = parseSettlementsFileName(file.name);
    if (!meta) {
      logger.warn(`Skip invalid file name: ${file.name}`);
      continue;
    }
    const { clientCode, currency } = meta;

    const baseRef = db.collection(`/artifacts/${APP_ID}/public/data/settlements`).doc(clientCode);
    const ledgerColRef = baseRef.collection(`ledger-${currency}`);
    const balanceRef = baseRef.collection("balances").doc(currency);

    // 2) Перевірка чи файл оновився
    const driveFileModifiedTime = new Date(file.modifiedTime);
    const balanceSnap = await balanceRef.get();
    
    if (balanceSnap.exists) {
      const lastSyncTime = balanceSnap.data().sourceFileModifiedTime?.toDate?.() || balanceSnap.data().sourceFileModifiedTime;
      if (lastSyncTime && driveFileModifiedTime <= new Date(lastSyncTime)) {
        logger.info(`Skip ${file.name} (not newer than ${new Date(lastSyncTime).toISOString()})`);
        continue;
      }
    }

    logger.info(`Processing ${file.name}...`);

    // 3) Завантажуємо CSV та перетворюємо рядки
    const rows = (await downloadCsvCp1251({ drive, fileId: file.id })).filter((r) => r.document_date && r.document_id);

    // 4) Обчислюємо баланс від початку (сума всіх delta)
    let totalBalance = 0;
    const recentRows = []; // Операції за останні 15 днів

    for (const row of rows) {
      const delta = parseSettlementsNumber(row.amount);
      totalBalance += delta;

      const docDate = parseSettlementsDate(row.document_date);
      if (docDate && isDateWithinLastNDays(docDate, DAYS_TO_KEEP)) {
        recentRows.push(row);
      }
    }

    // 5) Отримуємо всі існуючі операції за 15 днів для видалення
    const existingSnap = await ledgerColRef.get();
    const existingKeys = new Set();
    existingSnap.forEach((doc) => {
      const docData = doc.data();
      if (docData.date && isDateWithinLastNDays(docData.date, DAYS_TO_KEEP)) {
        existingKeys.add(doc.id);
      }
    });

    // 6) Будуємо операції: видалення старих + додавання нових
    const ops = [];
    const newKeys = new Set();

    // Видаляємо операції, які не входять в останні 15 днів
    for (const key of existingKeys) {
      ops.push((batch) => batch.delete(ledgerColRef.doc(key)));
    }

    // Додаємо операції за останні 15 днів
    for (const row of recentRows) {
      const key = stableDocKey(row);
      if (!key) continue;
      newKeys.add(key);

      const docDate = parseSettlementsDate(row.document_date);
      const newDocData = {
        seq: Number(row.sequence),
        date: docDate,
        docNumber: String(row.document_number || "").trim(),
        docType: String(row.document_type || "").trim(),
        docCode: String(row.document_type_code || "").trim(),
        docId: String(row.document_id || "").trim(),
        expense: parseSettlementsNumber(row.expense),
        income: parseSettlementsNumber(row.income),
        delta: parseSettlementsNumber(row.amount),
        currency,
        clientCode,
        updatedAt: FieldValue.serverTimestamp(),
      };
      ops.push((batch) => batch.set(ledgerColRef.doc(key), newDocData, { merge: true }));
    }

    await commitInBatches(ops);

    // 7) Зберігаємо баланс та метадані
    await balanceRef.set(
      {
        balance: totalBalance,
        count: recentRows.length, // Кількість збережених операцій
        lastImportedAt: FieldValue.serverTimestamp(),
        sourceFile: file.name,
        sourceFileModifiedTime: driveFileModifiedTime,
        clientCode,
        currency,
      },
      { merge: true }
    );

    logger.info(
      `Synced ${file.name}. Balance ${clientCode}/${currency}: ${totalBalance.toFixed(2)}; ` +
      `Saved ${recentRows.length} recent operations; wrote=${ops.length}`
    );
  }

  logger.info("Settlements sync finished.");
}

/* ---------------------- schedules ---------------------- */
// Будні: синхронізація оновлених файлів (13:00 та 18:00)
exports.settlementsSyncIncremental = onSchedule(
  { 
    schedule: "0 13,18 * * 1-5", 
    timeZone: "Europe/Kyiv", 
    region: REGION,
    timeoutSeconds: 540, // <--- Додано: 9 хвилин на виконання
    memory: "512MiB"     // <--- Додано: більше пам'яті для обробки CSV
  },
  async () => {
    await settlementsSyncCore();
  }
);
