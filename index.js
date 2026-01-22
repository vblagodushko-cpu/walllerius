/**
 * Project ROZA — Cloud Functions (Unified)
 * Region: process.env.FUNCTIONS_REGION || ""
 *
 * Експорти (v2):
 *  - setClientPassword      (callable, admin)  — встановити/оновити passwordHash (bcrypt)
 *  - clientLogin            (callable)         — логін клієнта (phone/password) → custom token
 *  - placeOrder             (callable)         — створення замовлення з послідовним номером
 *  - manualPriceListUpdate  (callable, admin)  — ручне оновлення товарів постачальника
 *  - deleteAllProducts      (callable, admin)  — батчеве видалення всіх товарів
 *  - processPriceList       (callable)         — імпорт CSV прайсу з URL (UTF-8)
 *  - priceUpdateScheduler   (scheduler)        — автооновлення прайсів
 *  - ukrSkladSync           (scheduler)        — синхронізація прайсу з Google Drive (cp1251, ';')
 *  - test                   (callable)         — ping
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

const axios = require("axios");
const Papa = require("papaparse");
const iconv = require("iconv-lite");
const { google } = require("googleapis");
const bcrypt = require("bcryptjs");
const xlsx = require("xlsx"); // лишаємо для сумісності, якщо знадобиться

initializeApp();
const db = getFirestore();
const auth = getAuth();

const REGION = process.env.FUNCTIONS_REGION || "europe-central2";

/* ------------------------------ helpers ------------------------------ */

function getAppId() {
  try {
    const cfg = process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG) : null;
    return (cfg && cfg.projectId) || process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "embryo-project";
  } catch (_) {
    return process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "embryo-project";
  }
}
const APP_ID = "embryo-project"

const str = (x, max = 400) => (x == null ? "" : String(x)).slice(0, max);
const isAdminReq = (req) => !!(req?.auth?.token?.admin === true);
const isEqual = (obj1, obj2) => {
  const keys1 = Object.keys(obj1);
  const keys2 = Object.keys(obj2);
  if (keys1.length !== keys2.length) return false;
  for (const key of keys1) {
    const val1 = obj1[key];
    const val2 = obj2[key];
    const areObjects = typeof val1 === 'object' && val1 !== null && typeof val2 === 'object' && val2 !== null;
    if ((areObjects && !isEqual(val1, val2)) || (!areObjects && val1 !== val2)) {
      return false;
    }
  }
  return true;
};

// callable: видати admin:true поточному користувачу, якщо він у allowlist
exports.syncAdminClaim = onCall({ region: REGION, cors: true }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Потрібно увійти.");
  const record = await auth.getUser(request.auth.uid);
  const email = (record.email || "").toLowerCase();
  if (!email) throw new HttpsError("failed-precondition", "В акаунті нема email.");

  // 1) allowlist з env: ADMIN_ALLOWLIST="a@b.com,c@d.com"
  const envList = (process.env.ADMIN_ALLOWLIST || "")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  let allowed = envList.includes(email);

  // 2) allowlist у Firestore: /artifacts/<APP_ID>/public/meta/adminAllowlist/<email>
  if (!allowed) {
    const ref = db.doc(`/artifacts/${APP_ID}/public/meta/adminAllowlist/${email}`);
    const snap = await ref.get();
    allowed = snap.exists;
  }

  if (!allowed) return { admin: false, reason: "not_in_allowlist" };

  const claims = record.customClaims || {};
  if (claims.admin === true) return { admin: true, already: true };

  await auth.setCustomUserClaims(record.uid, { ...claims, admin: true });
  await db.doc(`/artifacts/${APP_ID}/public/meta/adminAllowlist/${email}`)
    .set({ uid: record.uid, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

  return { admin: true };
});
/* --------------------------- AUTH: set password --------------------------- */

exports.setClientPassword = onCall({ region: REGION, cors: true }, async (request) => {
  if (!isAdminReq(request)) throw new HttpsError("permission-denied", "Потрібен адмін-доступ.");
  const clientId = str(request.data?.clientId, 128);
  const password = str(request.data?.password, 200);
  if (!clientId || !password) throw new HttpsError("invalid-argument", "Потрібні clientId і password.");
  if (password.length < 6) throw new HttpsError("invalid-argument", "Пароль має бути не менше 6 символів.");

  const salt = await bcrypt.genSalt(10);
  const passwordHash = await bcrypt.hash(password, salt);

  const ref = db.collection(`/artifacts/${APP_ID}/public/data/clients`).doc(clientId);
  await ref.set({ passwordHash }, { merge: true });
  logger.info(`Password updated for client ${clientId}`);
  return { success: true };
});

/* --------------------------- AUTH: client login --------------------------- */

exports.clientLogin = onCall({ region: REGION, cors: true }, async (request) => {
  const phone = str(request.data?.phone, 64).trim();
  const password = str(request.data?.password, 200);
  if (!phone || !password) throw new HttpsError("invalid-argument", "Телефон і пароль обов’язкові.");

  const q = await db
    .collection(`/artifacts/${APP_ID}/public/data/clients`)
    .where("phone", "==", phone)
    .limit(1)
    .get();

  if (q.empty) throw new HttpsError("not-found", "Клієнта з таким телефоном не знайдено.");
  const doc = q.docs[0];
  const data = doc.data();

  const hash = data.passwordHash;
  if (!hash) throw new HttpsError("permission-denied", "Для цього клієнта не встановлено пароль.");
  const ok = await bcrypt.compare(password, hash);
  if (!ok) throw new HttpsError("unauthenticated", "Невірний пароль.");

  const uid = str(doc.id, 128);
  try {
    await auth.getUser(uid);
  } catch (e) {
    if (e && e.code === "auth/user-not-found") {
      await auth.createUser({ uid, phoneNumber: phone });
    } else {
      throw e;
    }
  }

  const token = await auth.createCustomToken(uid, { client: true });
  logger.info(`Successful clientLogin for ${uid}`);
  return { token };
});

/* ---------------------- AUTH: client change password ---------------------- */
exports.clientChangePassword = onCall({ region: REGION, cors: true }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Потрібна авторизація.");
  }

  const { currentPassword, newPassword, confirmPassword } = request.data;
  if (!currentPassword || !newPassword || !confirmPassword) {
    throw new HttpsError("invalid-argument", "Всі поля обов'язкові.");
  }
  if (newPassword.length < 6) {
    throw new HttpsError("invalid-argument", "Новий пароль має бути не менше 6 символів.");
  }
  if (newPassword !== confirmPassword) {
    throw new HttpsError("invalid-argument", "Нові паролі не співпадають.");
  }

  const clientRef = db.collection(`/artifacts/${APP_ID}/public/data/clients`).doc(uid);
  const clientSnap = await clientRef.get();

  if (!clientSnap.exists) {
    throw new HttpsError("not-found", "Дані клієнта не знайдено.");
  }

  const clientData = clientSnap.data();
  const currentHash = clientData.passwordHash;

  if (!currentHash) {
    throw new HttpsError("failed-precondition", "Для цього акаунту не встановлено пароль.");
  }

  // Перевіряємо поточний пароль
  const isMatch = await bcrypt.compare(currentPassword, currentHash);
  if (!isMatch) {
    throw new HttpsError("unauthenticated", "Невірний поточний пароль.");
  }

  // Створюємо новий хеш і оновлюємо
  const salt = await bcrypt.genSalt(10);
  const newPasswordHash = await bcrypt.hash(newPassword, salt);

  await clientRef.update({ passwordHash: newPasswordHash });

  logger.info(`Password changed successfully for client ${uid}`);
  return { success: true, message: "Пароль успішно змінено!" };
});

/* ------------------------- PRICE LIST: common helpers ---------------------- */

async function downloadAndParseCsv(url) {
  // 1) Спробувати завантажити CSV з таймаутом і обмеженням розміру
  let resp;
  try {
    resp = await axios.get(url, {
      responseType: 'arraybuffer',       // отримаємо «сирі» байти, а не текст
      timeout: 20000,                    // 20 cекунд — якщо довше, вважаємо це помилкою
      maxContentLength: 20 * 1024 * 1024, // максимум 20 МБ
      validateStatus: (s) => s >= 200 && s < 400, // 2xx/3xx — ок, решта — помилка
    });
  } catch (err) {
    // Наприклад, таймаут або мережевий збій
    logger.error('CSV download failed', { url, message: err.message });
    throw new HttpsError('unavailable', `Не вдалося завантажити CSV: ${err.message}`);
  }

  // 2) Базова валідація заголовків
  const contentType = String(resp.headers?.['content-type'] || '').toLowerCase();
  const looksLikeCsv =
    contentType.includes('text/csv') ||
    contentType.includes('application/vnd.ms-excel') || // дехто віддає старий MIME
    contentType.includes('text/plain');

  if (!looksLikeCsv) {
    // Дуже часто це HTML-логін або помилка сервера
    const head = Buffer.from(resp.data).toString('utf8').slice(0, 200).trim();
    if (contentType.includes('text/html') || head.startsWith('<!DOCTYPE') || head.startsWith('<html')) {
      logger.error('Looks like HTML instead of CSV', { url, contentType, head });
      throw new HttpsError('permission-denied', 'Постачальник віддав HTML (можливо, потрібна авторизація або URL застарів).');
    }
    // Не падаємо жорстко: просто попереджаємо і пробуємо парсити як текст
    logger.warn('Suspicious content-type for CSV', { url, contentType });
  }

  // 3) Перетворити байти у текст (UTF-8) і перевірити наповнення
  const buf = Buffer.from(resp.data);
  if (buf.length < 20) {
    logger.error('CSV too small / empty', { url, bytes: buf.length });
    throw new HttpsError('data-loss', 'CSV порожній або підозріло малий.');
  }

  const text = buf.toString('utf8');
  if (!text.includes('\n')) {
    logger.error('CSV has no line breaks', { url, preview: text.slice(0, 120) });
    throw new HttpsError('data-loss', 'CSV не містить рядків (можливо, це не CSV).');
  }

  // 4) Парсимо CSV у масив об’єктів
  const parsed = Papa.parse(text, {
    header: true,           // перший рядок — заголовки колонок
    skipEmptyLines: true,
    dynamicTyping: true,    // числа перетворює у числа
    transformHeader: (h) => (h || '').trim(), // прибрати лишні пробіли у хедерах
  });

  if (parsed.errors && parsed.errors.length) {
    logger.warn('CSV parse warnings', { url, errors: parsed.errors.slice(0, 3) });
  }

  const rows = parsed.data?.filter(Boolean) || [];
  if (rows.length === 0) {
    logger.error('CSV parsed but no data rows', { url });
    throw new HttpsError('data-loss', 'CSV розпарсено, але немає жодного рядка даних.');
  }

  // (опційно) Можемо перевірити мінімальний набір колонок
  // const required = ['code','name','brand']; // приклад
  // const miss = required.filter(k => !(k in rows[0]));
  // if (miss.length) {
  //   logger.error('CSV missing required columns', { url, miss });
  //   throw new HttpsError('failed-precondition', `В CSV немає обовʼязкових колонок: ${miss.join(', ')}`);
  // }

  return rows; // масив об’єктів — далі йде твоя логіка processSupplierPriceList
}

// ==================== processSupplierPriceList (Wipe & Replace) ====================
const toNum = (v) => {
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

async function processSupplierPriceList(data, supplier) {
  if (!supplier || !supplier.id || !supplier.name || !Array.isArray(data)) {
    throw new HttpsError('invalid-argument', 'Invalid supplier/data in processSupplierPriceList');
  }

  const productsCol = db.collection(`/artifacts/${APP_ID}/public/data/products`);
  const supplierName = str(supplier.name, 200);

  // 1) Remove previous supplier products
  const oldSnap = await productsCol.where('supplier', '==', supplierName).get();
  if (!oldSnap.empty) {
    let batch = db.batch();
    let count = 0;
    for (const d of oldSnap.docs) {
      batch.delete(d.ref);
      if (++count % 400 === 0) { await batch.commit(); batch = db.batch(); }
    }
    await batch.commit();
  }

  // 2) Insert new rows
  let batch = db.batch();
  let count = 0;
  for (const row of data) {
    const brand = str(row.brand || row.Brand || row.Бренд, 200);
    const article = str(
      row.id || row.code || row.article || row.Code || row.Код || row.Артикул,
      200
    );
    const name = str(row.name || row.Name || row.Найменування || row.Опис, 600);
    const price = toNum(
      row.price || row.Price || row.Ціна || row['Ціна (eur)'] || row['Ціна (EUR)'] || row['Ціна, eur']
    );
    const stock = toNum(
      row.stock || row.Stock || row.Кількість || row['Наявно, шт'] || row.amount
    );
    if (!brand || !article) continue;

    const docId = `${supplierName}-${brand}-${article}`
      .replace(/\s+/g, '-')
      .replace(/[^\w.-]/g, '_');

    const product = {
      supplier: supplierName,
      brand,
      id: article,
      name,
      price,
      stock,
      updatedAt: FieldValue.serverTimestamp(),
    };
    batch.set(productsCol.doc(docId), product);
    if (++count % 400 == 0) { await batch.commit(); batch = db.batch(); }
  }
  await batch.commit();

  // 3) Mark supplier updated
  await db
    .collection(`/artifacts/${APP_ID}/public/data/suppliers`)
    .doc(str(supplier.id, 128))
    .set({ lastUpdated: FieldValue.serverTimestamp() }, { merge: true });

  logger.info(`processSupplierPriceList: updated ${count} items for ${supplierName}`);
  return { success: true, updated: count };
}
// ================== end processSupplierPriceList ====================



/* ------------------------- PRICE LIST: callables --------------------------- */

exports.processPriceList = onCall({ region: REGION, cors: true }, async (request) => {
  const supplierId = str(request.data?.supplierId, 128);
  const supplierName = str(request.data?.supplierName, 200);
  const url = str(request.data?.url, 2000);
  if (!supplierId || !supplierName || !url) {
    throw new HttpsError("invalid-argument", "Вкажіть supplierId, supplierName, url.");
  }
  const data = await downloadAndParseCsv(url);
  return await processSupplierPriceList(data, { id: supplierId, name: supplierName });
});

exports.manualPriceListUpdate = onCall({ region: REGION, cors: true }, async (request) => {
  if (!isAdminReq(request)) throw new HttpsError("permission-denied", "Потрібен адмін-доступ.");
  const supplier = request.data?.supplier;
  const data = request.data?.data;
  if (!supplier || !supplier.id || !supplier.name || !Array.isArray(data)) {
    throw new HttpsError("invalid-argument", "Потрібні supplier {id,name} та масив data.");
  }

  const productsCol = db.collection(`/artifacts/${APP_ID}/public/data/products`);

  // wipe previous
  const old = await productsCol.where("supplier", "==", supplier.name).get();
  const batch = db.batch();
  old.docs.forEach((d) => batch.delete(d.ref));
  data.forEach((item) => {
    const docId = `${supplier.name}-${str(item.brand, 200)}-${str(item.id, 200)}`
      .replace(/\s+/g, "-")
      .replace(/\//g, "_");
    batch.set(productsCol.doc(docId), item);
  });
  await batch.commit();

  await db
    .collection(`/artifacts/${APP_ID}/public/data/suppliers`)
    .doc(str(supplier.id, 128))
    .set({ lastUpdated: FieldValue.serverTimestamp() }, { merge: true });

  return { success: true, message: `Оновлено ${data.length} позицій для ${supplier.name}.` };
});

exports.deleteAllProducts = onCall({ region: REGION, cors: true }, async (request) => {
  if (!isAdminReq(request)) throw new HttpsError("permission-denied", "Потрібен адмін-доступ.");
  const col = db.collection(`/artifacts/${APP_ID}/public/data/products`);
  let deleted = 0;
  while (true) {
    const snap = await col.limit(500).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    deleted += snap.size;
  }
  return { deleted };
});

/* -------------------------- PRICE LIST: schedulers ------------------------- */

exports.priceUpdateScheduler = onSchedule(
  { schedule: "0,30 * * * 1-5", timeZone: "Europe/Kyiv", region: REGION },
  async () => {
    const suppliersRef = db.collection(`/artifacts/${APP_ID}/public/data/suppliers`);
    const snap = await suppliersRef.where("updateMethod", "==", "auto_url").get();
    if (snap.empty) return null;

    // Поточний час у Києві
    const now = new Date();
    const parts = new Intl.DateTimeFormat('uk-UA', {
      timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(now);
    const hhNow = Number(parts.find(p => p.type === 'hour').value);
    const mmNow = Number(parts.find(p => p.type === 'minute').value);
    const currentMinutes = hhNow * 60 + mmNow;

    // Дата «сьогодні» у Києві (для коректної перевірки lastUpdated)
    const fmtDateKyiv = (d) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(d);
    const todayKyiv = fmtDateKyiv(now);

    const jobs = [];
    snap.forEach((doc) => {
      const supplier = { id: doc.id, ...doc.data() };
      if (!supplier.priceListUrl || !supplier.scheduleTime) return;

      const lastUpdatedDateKyiv = supplier.lastUpdated
        ? fmtDateKyiv(supplier.lastUpdated.toDate())
        : null;
      if (lastUpdatedDateKyiv === todayKyiv) return;

      const [hh, mm] = String(supplier.scheduleTime).split(':');
      const H = Math.max(0, Math.min(23, Number(hh)));
      const M = Math.max(0, Math.min(59, Number(mm)));
      const scheduled = H * 60 + M;

      // Вікно 60 хв із переходом через північ
      const MIN_PER_DAY = 24 * 60;
      const delta = (currentMinutes - scheduled + MIN_PER_DAY) % MIN_PER_DAY; // 0..1439
      if (delta < 60) {
        jobs.push(
          downloadAndParseCsv(supplier.priceListUrl)
            .then((data) => processSupplierPriceList(data, supplier))
            .catch((err) => logger.error(`Scheduler ${supplier.name}:`, err))
        );
      }
    });

    if (jobs.length) await Promise.all(jobs);
    return null;
  }
);
/* ----------------------------- UKRSKLAD SYNC (SMART) ------------------------------ */
/* ----------------------------- UKRSKLAD SYNC (SMART V2 with Logging) ------------------------------ */
exports.ukrSkladSync = onSchedule(
  { schedule: "*/15 9-17 * * 1-5", timeZone: "Europe/Kyiv", region: REGION },
  async () => {
    logger.info("Starting SMART UkrSklad sync...");
    const productsCol = db.collection(`/artifacts/${APP_ID}/public/data/products`);
    const FOLDER_ID = "17Q4p-fgPEygJp_sOftV15cIv340Pz1R3";
    const FILENAME = "price_full.csv";

    try {
      // --- Фаза 1: Підготовка ---
      const gauth = new google.auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/drive.readonly"] });
      const drive = google.drive({ version: "v3", auth: gauth });
      const res = await drive.files.list({
        q: `'${FOLDER_ID}' in parents AND name = '${FILENAME}' AND trashed = false`,
        fields: "files(id, name)",
      });
      if (!res.data.files || res.data.files.length === 0) {
        logger.warn("UkrSklad sync: File not found on Google Drive.");
        return;
      }
      const contentResp = await drive.files.get({ fileId: res.data.files[0].id, alt: "media" }, { responseType: "arraybuffer" });
      const csvData = iconv.decode(Buffer.from(contentResp.data), "cp1251");
      let parsedCsv = Papa.parse(csvData, { header: true, skipEmptyLines: true, delimiter: ";" });
  if (!parsedCsv.meta || (parsedCsv.meta.fields && parsedCsv.meta.fields.length <= 1)) { parsedCsv = Papa.parse(csvData, { header: true, skipEmptyLines: true, delimiter: ',' }); }
if (parsedCsv.errors.length) throw new Error("CSV parse failed");
      
      // +++ ДІАГНОСТИЧНЕ ЛОГУВАННЯ +++
      if (parsedCsv.data.length > 0) {
        logger.info("CSV Headers:", Object.keys(parsedCsv.data[0]));
        logger.info("First data row:", parsedCsv.data[0]);
      }
      // ++++++++++++++++++++++++++++++

      const productsFromFile = parsedCsv.data;

      const existingProductsSnap = await productsCol.where("supplier", "==", "Мій склад").get();
      const existingProductsMap = new Map();
      existingProductsSnap.forEach(doc => {
        existingProductsMap.set(doc.id, doc.data());
      });
      logger.info(`Found ${productsFromFile.length} products in CSV and ${existingProductsMap.size} existing products in DB.`);

      // --- Фаза 2: Оновлення та Створення ---
      let writeBatch = db.batch();
      let operationsCount = 0;
      const BATCH_LIMIT = 400;

      for (const row of productsFromFile) {
        const brand = str((row["brand"] || "N/A").trim());
        const code = str((row["code"] || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, ""));
        if (!brand || brand === "N/A" || !code) continue;

        const docId = `Мій склад-${brand}-${code}`;
        const num = (v) => v == null || v === '' ? null : Number(String(v).replace(',', '.'));
        
        const newProductData = {
          supplier: "Мій склад",
          brand, code,
          name: str(row["name"] || ""),
          stock: num(row["amount"]) ?? 0,
          ukrSkladId: str(row["ID"]),
          ukrSkladGroupId: str(row["group_id"]),
          pack: str(row["Pack"], 50),
          minStock: num(row["minimum"]),
          prices: {
            purchase: num(row["price_purchase"]),
            retail: num(row["price_retail"]),
            wholesale: num(row["price_wholesale"]),
            special1: num(row["price_special_1"]),
            special2: num(row["price_special_2"]),
            special3: num(row["price_special_3"]),
          },
        };

        const existingProduct = existingProductsMap.get(docId);

        if (existingProduct) {
          const { updatedAt: oldTimestamp, ...dataToCompare } = existingProduct;
          if (!isEqual(newProductData, dataToCompare)) {
            writeBatch.update(productsCol.doc(docId), { ...newProductData, updatedAt: FieldValue.serverTimestamp() });
            operationsCount++;
          }
          existingProductsMap.delete(docId);
        } else {
          writeBatch.set(productsCol.doc(docId), { ...newProductData, updatedAt: FieldValue.serverTimestamp() });
          operationsCount++;
        }

        if (operationsCount >= BATCH_LIMIT) {
          await writeBatch.commit();
          writeBatch = db.batch();
          operationsCount = 0;
        }
      }

      if (operationsCount > 0) {
        await writeBatch.commit();
        writeBatch = db.batch();
        operationsCount = 0;
      }
      
      // --- Фаза 3: Видалення застарілого ---
      const productsToDelete = Array.from(existingProductsMap.keys());
      if (productsToDelete.length > 0) {
        logger.info(`Deleting ${productsToDelete.length} obsolete products...`);
        for (const docId of productsToDelete) {
          writeBatch.delete(productsCol.doc(docId));
          operationsCount++;
          if (operationsCount >= BATCH_LIMIT) {
            await writeBatch.commit();
            writeBatch = db.batch();
            operationsCount = 0;
          }
        }
        if (operationsCount > 0) {
          await writeBatch.commit();
        }
      }

      logger.info("SMART UkrSklad sync finished successfully.");
    } catch (e) {
      logger.error("SMART UkrSklad sync error:", e);
    }
  }
);
/* ---------------------------------- TEST ---------------------------------- */

exports.test = onCall({ region: REGION, cors: true }, async () => {
  return { ok: true, at: new Date().toISOString(), appId: APP_ID, region: REGION };
});




/* ------------------------------- placeOrderV2 ------------------------------ */
/**
 * Safer order creation:
 * - Idempotent via clientRequestId
 * - Server-side price recomputation based on current product price and pricingRules
 */
exports.placeOrderV2 = onCall({ region: REGION, cors: true }, async (request) => {
  const uid = request.auth?.uid || null;
  if (!uid) throw new HttpsError("unauthenticated", "Потрібна авторизація.");
  const { items = [], clientRequestId, clientName, clientPhone, clientEmail } = request.data || {};
  if (!Array.isArray(items) || !items.length)
    throw new HttpsError("invalid-argument", "Кошик порожній або некоректний.");

  const lockId = str(clientRequestId || "", 128);
  if (lockId) {
    const dup = await db
      .collection(`/artifacts/${APP_ID}/public/data/orders`)
      .where("clientRequestId", "==", lockId)
      .limit(1)
      .get();
    if (!dup.empty) {
      const d = dup.docs[0];
      return { orderId: d.id, orderNumber: d.get("orderNumber") || null, reused: true };
    }
  }

  // recompute prices
  const productsCol = db.collection(`/artifacts/${APP_ID}/public/data/products`);
  const suppliersCol = db.collection(`/artifacts/${APP_ID}/public/data/suppliers`);
  const pricingCol = db.collection(`/artifacts/${APP_ID}/public/data/pricingRules`);
  const priceType = request.auth?.token?.priceType || "ціна 1";

  const normItems = [];
  let total = 0;

  for (const it of items.slice(0, 300)) {
    const brand = str(it.brand, 200);
    const id = str(it.id || it.productId, 200);
    const supplier = str(it.supplier || it.vendor || "", 200);
    const qty = Math.max(1, Number(it.quantity || 1));

    // snapshot product
    const q = await productsCol
      .where("brand","==", brand)
      .where("id","==", id)
      .where("supplier","==", supplier)
      .limit(1).get();
    if (q.empty) throw new HttpsError("not-found", `Товар ${brand} ${id} (${supplier}) не знайдено.`);
    const p = q.docs[0].data();

    // markup
    let markup = 0;
    if (supplier === "Мій склад") {
      // TODO: прочитати з налаштувань або зберігати у suppliers[id="own"].
      markup = 20;
    } else {
      const sSnap = await suppliersCol.where("name","==", supplier).limit(1).get();
      const sid = sSnap.empty ? null : sSnap.docs[0].id;
      if (sid) {
        const pr = await pricingCol.doc(sid).get();
        markup = pr.exists ? (pr.data().rules?.[priceType] || 0) : 0;
      }
    }

    const unit = Number(p.price) * (1 + (Number(markup)||0)/100);
    const lineTotal = unit * qty;
    total += lineTotal;

    normItems.push({
      id,
      docId: p.docId || null,
      name: str(p.name || it.name, 600),
      brand,
      price: Number(unit.toFixed(2)),
      quantity: qty,
      sku: str(it.sku || "", 200),
      supplier,
      unitBase: Number(p.price),
      markup,
      lineTotal: Number(lineTotal.toFixed(2)),
      source: "server-recalc",
    });
  }

  // order number (reuse old logic)
  const legacyCounterRef = db.doc(`/artifacts/${APP_ID}/public/meta/counters/orders`); // { seq }
  const newCounterRef = db.doc(`/artifacts/${APP_ID}/public/data/meta/counters`); // { orderSeq }
  let orderNumber = null;
  await db.runTransaction(async (tx) => {
    const legacySnap = await tx.get(legacyCounterRef);
    if (legacySnap.exists) {
      const next = (legacySnap.get("seq") || 0) + 1;
      tx.set(legacyCounterRef, { seq: next, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      orderNumber = next;
    } else {
      const newSnap = await tx.get(newCounterRef);
      const current = newSnap.exists ? newSnap.get("orderSeq") || 0 : 0;
      const next = current + 1;
      tx.set(newCounterRef, { orderSeq: next, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      orderNumber = next;
    }
  });

  const ref = db.collection(`/artifacts/${APP_ID}/public/data/orders`).doc();
  await ref.set({
    clientId: uid,
    items: normItems,
    total: Number(total.toFixed(2)),
    status: "Нове",
    orderNumber,
    clientRequestId: lockId || null,
    clientName: str(clientName, 200),
    clientPhone: str(clientPhone, 50),
    clientEmail: str(clientEmail, 200),
    createdAt: FieldValue.serverTimestamp(),
    source: "portal-v2",
    pricingSnapshot: { priceType },
  });

  return { orderId: ref.id, orderNumber, total: Number(total.toFixed(2)) };
});
