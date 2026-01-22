const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const db = getFirestore();
const APP_ID = process.env.APP_ID || "embryo-project";
const REGION = process.env.FUNCTION_REGION || "europe-central2";
const isAdminReq = (req) => (req?.auth?.token || {}).admin === true;

// functions/index.js
const CHUNK = 500;

exports.deleteAllProducts = onCall({ region: REGION, cors: true }, async (request) => {
  if (!isAdminReq(request)) throw new HttpsError("permission-denied", "Потрібен адмін-доступ.");

  const publicCol  = db.collection(`/artifacts/${APP_ID}/public/data/products`);
  const privateCol = db.collection(`/artifacts/${APP_ID}/private/data/productCosts`);

  let deletedPublic = 0;
  let deletedPrivate = 0;

  // 1) Видаляємо всі публічні товари порціями
  while (true) {
    const snap = await publicCol.limit(CHUNK).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    deletedPublic += snap.size;
  }

  // 2) Видаляємо всі приватні ціни порціями
  while (true) {
    const snap = await privateCol.limit(CHUNK).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    deletedPrivate += snap.size;
  }

  return { deletedPublic, deletedPrivate, ok: true };
});

/**
 * Очистити кеш брендів: видаляє всі документи з /public/meta/brands
 */
exports.clearBrandsCache = onCall({ region: REGION, cors: true }, async (request) => {
  if (!isAdminReq(request)) throw new HttpsError("permission-denied", "Потрібен адмін-доступ.");

  const col = db.collection(`/artifacts/${APP_ID}/public/meta/brands`);
  let deleted = 0;

  while (true) {
    const snap = await col.limit(CHUNK).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    deleted += snap.size;
  }

  return { ok: true, deleted };
});

/**
 * Спільна логіка перебудови кешу брендів
 */
async function rebuildBrandsCacheInternal() {
  const products = db.collection(`/artifacts/${APP_ID}/public/data/products`);
  const brandsCol = db.collection(`/artifacts/${APP_ID}/public/meta/brands`);

  // Збираємо унікальні варіанти брендів
  const variants = new Map(); // key: lcBrand -> Set(variants)
  let lastDoc = null;
  const PAGE = 1000;

  while (true) {
    let q = products.select("brand").orderBy("brand").limit(PAGE);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;

    snap.docs.forEach((d) => {
      const b = (d.get("brand") || "").toString().replace(/\s{2,}/g, " ").trim();
      if (!b) return;
      const key = b.toLowerCase();
      if (!variants.has(key)) variants.set(key, new Set());
      variants.get(key).add(b);
    });

    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < PAGE) break;
  }

  // Очищаємо існуючу колекцію brands
  while (true) {
    const snap = await brandsCol.limit(CHUNK).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }

  // Записуємо оновлений кеш
  let batch = db.batch();
  let ops = 0;
  let written = 0;
  for (const [lc, setVar] of variants.entries()) {
    const arr = Array.from(setVar.values()).sort();
    const canonical = arr[0];
    // Санитизуємо document ID: / . # $ [ ] -> - (Firestore не дозволяє ці символи в document ID)
    const safeDocId = lc.replace(/\//g, "-").replace(/[.#$\[\]]/g, "-").replace(/-+/g, "-").slice(0, 150);
    const docRef = brandsCol.doc(safeDocId);
    batch.set(
      docRef,
      { name: canonical, canonical, variants: arr, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
    ops++; written++;
    if (ops >= CHUNK) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();

  return written;
}

/**
 * Перебудувати кеш брендів (callable для адмін-панелі)
 */
exports.rebuildBrandsCache = onCall({ region: REGION, cors: true }, async (request) => {
  if (!isAdminReq(request)) throw new HttpsError("permission-denied", "Потрібен адмін-доступ.");

  const written = await rebuildBrandsCacheInternal();
  return { ok: true, written };
});

/**
 * Знайти можливі дублікати брендів (групи різних варіантів одного lower-case ключа)
 */
exports.findBrandDuplicates = onCall({ region: REGION, cors: true }, async (request) => {
  if (!isAdminReq(request)) throw new HttpsError("permission-denied", "Потрібен адмін-доступ.");

  const products = db.collection(`/artifacts/${APP_ID}/public/data/products`);
  const variants = new Map();
  let lastDoc = null;
  const PAGE = 1000;

  while (true) {
    let q = products.select("brand").orderBy("brand").limit(PAGE);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;

    snap.docs.forEach((d) => {
      const b = (d.get("brand") || "").toString().replace(/\s{2,}/g, " ").trim();
      if (!b) return;
      const key = b.toLowerCase();
      if (!variants.has(key)) variants.set(key, new Set());
      variants.get(key).add(b);
    });

    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < PAGE) break;
  }

  const duplicates = [];
  for (const [lc, setVar] of variants.entries()) {
    const arr = Array.from(setVar.values()).sort();
    if (arr.length > 1) duplicates.push({ lc, variants: arr, count: arr.length });
  }
  duplicates.sort((a, b) => b.count - a.count);

  return { ok: true, duplicates };
});

/**
 * Видалити всі ledger-операції та баланси взаєморозрахунків
 */
exports.deleteAllSettlements = onCall({ region: REGION, cors: true }, async (request) => {
  if (!isAdminReq(request)) throw new HttpsError("permission-denied", "Потрібен адмін-доступ.");

  const settlementsBase = db.collection(`/artifacts/${APP_ID}/public/data/settlements`);
  let deletedLedgers = 0;
  let deletedBalances = 0;
  let processedClients = 0;

  // Отримуємо всіх клієнтів з settlements
  const clientsSnap = await settlementsBase.get();
  
  for (const clientDoc of clientsSnap.docs) {
    const clientCode = clientDoc.id;
    processedClients++;

    // Видаляємо ledger-UAH
    const ledgerUahCol = clientDoc.ref.collection("ledger-UAH");
    while (true) {
      const snap = await ledgerUahCol.limit(CHUNK).get();
      if (snap.empty) break;
      const batch = db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      deletedLedgers += snap.size;
    }

    // Видаляємо ledger-EUR
    const ledgerEurCol = clientDoc.ref.collection("ledger-EUR");
    while (true) {
      const snap = await ledgerEurCol.limit(CHUNK).get();
      if (snap.empty) break;
      const batch = db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      deletedLedgers += snap.size;
    }

    // Видаляємо баланси
    const balancesCol = clientDoc.ref.collection("balances");
    const balancesSnap = await balancesCol.get();
    if (!balancesSnap.empty) {
      const batch = db.batch();
      balancesSnap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      deletedBalances += balancesSnap.size;
    }
  }

  return { 
    ok: true, 
    processedClients, 
    deletedLedgers, 
    deletedBalances 
  };
});

/**
 * Тижневе автоматичне оновлення кешу брендів (субота, 02:00)
 */
exports.weeklyRebuildBrandsCache = onSchedule(
  {
    region: REGION,
    schedule: "0 2 * * 6",  // Субота, 02:00 (Europe/Kyiv)
    timeZone: "Europe/Kyiv",
  },
  async () => {
    const logger = require("firebase-functions/logger");
    try {
      const written = await rebuildBrandsCacheInternal();
      logger.info("Weekly brands cache rebuild completed", { brandsCount: written });
    } catch (e) {
      logger.error("Weekly brands cache rebuild failed", { error: e.message });
      throw e;
    }
  }
);
