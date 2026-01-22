// functions/ukrsklad.js
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const { google } = require("googleapis");
const iconv = require("iconv-lite");
const Papa = require("papaparse");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { normalizeBrand, normalizeArticle, getProductMasterData, upsertProduct, removeProduct } = require("./shared");

const db = getFirestore();
const APP_ID = process.env.APP_ID || "embryo-project";
const REGION = process.env.FUNCTION_REGION || "europe-central2";

// --------- helpers ----------
const str = (v, max = 500) => {
  const s = (v ?? "").toString().trim();
  return max ? (s.length > max ? s.slice(0, max) : s) : s;
};
const num = (v) => (v == null || v === "" ? null : Number(String(v).replace(",", ".")));

// глибоке порівняння без updatedAt
const isEqual = (a, b) => {
  const skip = (o) => {
    if (!o || typeof o !== "object") return o;
    const { updatedAt, ...rest } = o;
    return JSON.parse(JSON.stringify(rest));
  };
  try {
    return JSON.stringify(skip(a)) === JSON.stringify(skip(b));
  } catch {
    return false;
  }
};

// --------- core sync logic ----------
async function performUkrSkladSync(forceSync = false) {
  try {
    logger.info("Starting SMART UkrSklad sync...");

      // твої константи
      const FOLDER_ID = "1iAKEi_ixZYwxz18t2BrFoOw85maFCclP";
      const FILENAME = "price_full.csv";

      const syncStateRef = db.doc(`/artifacts/${APP_ID}/public/meta/syncState/syncState`);
      // 1) знаходимо останній файл у папці
      const gauth = new google.auth.GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      });
      const drive = google.drive({ version: "v3", auth: gauth });
      const res = await drive.files.list({
        q: `'${FOLDER_ID}' in parents AND name = '${FILENAME}' AND trashed = false`,
        fields: "files(id, name, modifiedTime)",
      });

      if (!res.data.files || res.data.files.length === 0) {
        logger.warn(`UkrSklad sync: File '${FILENAME}' not found on Google Drive.`);
        return;
      }

      const driveFile = res.data.files[0];
      const driveFileModifiedTime = new Date(driveFile.modifiedTime);

      // 2) перевіряємо, чи новіший файл (якщо не forceSync)
      if (!forceSync) {
        const syncStateSnap = await syncStateRef.get();
        if (syncStateSnap.exists) {
          const lastSyncTime = syncStateSnap.data().ukrSkladLastSyncTime?.toDate();
          if (lastSyncTime && driveFileModifiedTime <= lastSyncTime) {
            logger.info(`Skipping sync. File '${FILENAME}' is not new.`);
            return { skipped: true, message: "Файл не новіший за останню синхронізацію" };
          }
        }
      }

      // 3) читаємо CSV (cp1251, ';')
      const contentResp = await drive.files.get(
        { fileId: driveFile.id, alt: "media" },
        { responseType: "arraybuffer" }
      );
      const csvData = iconv.decode(Buffer.from(contentResp.data), "cp1251");
      const parsedCsv = Papa.parse(csvData, { header: true, skipEmptyLines: true, delimiter: ";" });
      const rows = parsedCsv.data;

      const publicProductsCol = db.collection(`/artifacts/${APP_ID}/public/data/products`);
      const supplierProductsCol = db.collection(`/artifacts/${APP_ID}/public/data/supplierProducts`);
      const supplierNorm = "Мій склад";

      // 4) Нормалізація та збір ключів (оптимізація)
      const normalizedProductKeys = new Set(); // brand-article (канонічний)
      const rowsToProcess = []; // Зберігаємо нормалізовані дані для обробки
      const uniqueMasterDataKeys = new Set(); // для батч-завантаження masterData

      for (const row of rows) {
        const brandRaw = str((row["brand"] || "N/A").trim());
        const idRaw = row["code"] || "";
        if (!idRaw || !brandRaw || brandRaw === "N/A") continue;

        const normalizedBrand = await normalizeBrand(brandRaw);
        const normalizedArticle = normalizeArticle(idRaw);
        if (!normalizedBrand || !normalizedArticle) continue;

        const productKey = `${normalizedBrand}-${normalizedArticle}`;
        normalizedProductKeys.add(productKey);
        
        // Збираємо унікальні ключі для masterData
        uniqueMasterDataKeys.add(`${normalizedBrand}__${normalizedArticle}`);
        
        rowsToProcess.push({ 
          row, 
          normalizedBrand, 
          normalizedArticle, 
          productKey,
          brandRaw,
          idRaw
        });
      }

      // 5) Батч-завантаження masterData для унікальних ключів
      const masterDataMap = new Map();
      for (const key of uniqueMasterDataKeys) {
        const [brand, article] = key.split('__');
        const masterData = await getProductMasterData(brand, article);
        if (masterData) {
          masterDataMap.set(key, masterData);
        }
      }

      // 6) Завантаження існуючих пропозицій через supplierProducts
      const supplierProductsSnap = await supplierProductsCol
        .where("supplier", "==", supplierNorm)
        .get();
      
      const existingMap = new Map(); // canonicalKey → { productDocId, data }
      const toRemoveList = []; // для cleanup
      
      // Розділяємо на ті, що є в CSV (для читання) та ті, що відсутні (для видалення)
      const productDocIdsToRead = [];
      supplierProductsSnap.forEach(doc => {
        const data = doc.data();
        const productKey = data.productKey;
        // збираємо docIds для читання; ключ нормалізуємо пізніше за канонічним brand/article із продукту
          productDocIdsToRead.push(data.productDocId);
        // зберігаємо raw key на випадок, якщо продукт не знайдеться (можливе видалення)
        toRemoveList.push({ productKey, productDocId: data.productDocId });
      });
      
      // Читаємо товари батчами по 30
      const READ_CHUNK = 30;
      for (let i = 0; i < productDocIdsToRead.length; i += READ_CHUNK) {
        const part = productDocIdsToRead.slice(i, i + READ_CHUNK);
        const productsSnap = await publicProductsCol
          .where("__name__", "in", part)
          .get();
        
        productsSnap.forEach(doc => {
          const data = doc.data();
          // Використовуємо canonical поля якщо є, інакше fallback до brand-id
          const canonicalBrand = data.canonicalBrand || data.brand;
          const canonicalArticle = data.canonicalArticle || data.id;
          const canonicalKey = `${canonicalBrand}-${canonicalArticle}`;
          existingMap.set(canonicalKey, { productDocId: doc.id, data });
        });
      }

      // 7) Підготовка операцій для upsert
      const operationsToUpsert = [];
      const operationsToRemove = [];

      for (const { row, normalizedBrand, normalizedArticle, productKey, brandRaw, idRaw } of rowsToProcess) {
        try {
          const stock = num(row["amount"]) ?? 0;
        const publicPrices = {
          "роздріб": num(row["price_retail"]),
          "ціна опт": num(row["price_wholesale"]),
          "ціна 1": num(row["price_special_1"]),
          "ціна 2": num(row["price_special_2"]),
          "ціна 3": num(row["price_special_3"]),
        };

          // Отримуємо masterData з кешу
          const masterDataKey = `${normalizedBrand}__${normalizedArticle}`;
          const masterData = masterDataMap.get(masterDataKey);
          
          // Канонічні значення (якщо masterData знайдені по синоніму)
          const canonicalArticle = masterData ? normalizeArticle(masterData.id) : normalizedArticle;
          const canonicalBrand   = masterData?.brand ? masterData.brand : normalizedBrand;
          const idToUse          = masterData ? masterData.id : idRaw; // id залишається істина, але беремо канонічний, якщо він є
          
          // Додаємо канонічний ключ до бажаних, щоб cleanup не видалив
          const canonicalKey = `${canonicalBrand}-${canonicalArticle}`;
          normalizedProductKeys.add(canonicalKey);

          // Якщо stock <= 0 — готуємо видалення канонічного запису
          if (stock <= 0) {
            const existing = existingMap.get(canonicalKey) || existingMap.get(productKey);
            if (existing) {
              operationsToRemove.push({
                productKey: canonicalKey,
                productDocId: existing.productDocId,
                id: existing.data?.id,
                brand: existing.data?.brand
              });
            }
            continue;
          }

          // Обробка pack (тільки якщо немає masterData)
          const pack = masterData ? null : (() => {
            const raw = String(row["Pack"] || "").trim();
            const match = raw.match(/\d+[.,]?\d*/);
            if (!match) return null;
            const normalized = match[0].replace(",", ".");
            const packNum = parseFloat(normalized);
            return isNaN(packNum) ? null : String(packNum);
          })();

          operationsToUpsert.push({
            supplier: supplierNorm,
            normalizedBrand,
            normalizedArticle,
            canonicalBrand,
            canonicalArticle,
            rawId: idToUse,
            name: masterData?.correctName || str(row["name"] || ""),
            stock,
            publicPrices,
            purchase: num(row["price_purchase"]) ?? 0,
            categories: masterData?.categories || null, // Завжди з masterData, не парсити з CSV
            pack: masterData?.pack || pack,
            tolerances: masterData?.tolerances || null,
            synonyms: masterData?.synonyms || [],
            needsReview: !masterData,
            ukrSkladId: str(row["ID"]),
            ukrSkladGroupId: str(row["group_id"]),
            minStock: num(row["minimum"]),
            productKey: canonicalKey
          });
        } catch (e) {
          logger.error("Row preparation failed", { 
            error: String(e), 
            stack: e.stack,
            productKey,
            supplier: supplierNorm
          });
        }
      }

      const keepKeys = new Set(operationsToUpsert.map(op => op.productKey));
        
      // Додаємо товари для видалення з cleanup
      for (const { productKey, productDocId } of toRemoveList) {
        // Якщо ми щойно готуємо upsert для цього canonicalKey — не видаляємо
        if (keepKeys.has(productKey)) continue;
        try {
          const productDoc = await publicProductsCol.doc(productDocId).get();
          if (!productDoc.exists) {
            logger.debug("Product not found for removal", { productKey, productDocId });
            continue;
          }
          
          const data = productDoc.data();
          // Використовуємо canonical поля для ключа
          const canonicalBrand = data.canonicalBrand || data.brand;
          const canonicalArticle = data.canonicalArticle || data.id;
          const canonicalKey = `${canonicalBrand}-${canonicalArticle}`;
          
          // Перевіряємо, чи не в keepKeys
          if (keepKeys.has(canonicalKey)) continue;
          
          operationsToRemove.push({
            productKey: canonicalKey,
            productDocId,
            id: data.id,
            brand: data.brand
          });
        } catch (e) {
          logger.warn("Failed to prepare removal", { productKey, error: e.message });
        }
      }

      // 8) Батч-виконання upsert з обмеженням concurrency
      const CONCURRENCY_LIMIT = 15;
      
      logger.info("performUkrSkladSync: starting batch upsert", { 
        toUpsert: operationsToUpsert.length,
        toRemove: operationsToRemove.length,
        supplier: supplierNorm
      });

      // Обробка upsert батчами
      for (let i = 0; i < operationsToUpsert.length; i += CONCURRENCY_LIMIT) {
        const batch = operationsToUpsert.slice(i, i + CONCURRENCY_LIMIT);
        const promises = batch.map(async (op) => {
          try {
            await upsertProduct({
              supplier: op.supplier,
              brand: op.canonicalBrand,        // формуємо docId за канонічним brand
              id: op.rawId,                    // тут вже канонічний id, якщо masterData знайдені
              canonicalBrand: op.canonicalBrand,
              canonicalArticle: op.canonicalArticle,
              name: op.name,
              stock: op.stock,
              publicPrices: op.publicPrices,
              purchase: op.purchase,
              categories: op.categories,
              pack: op.pack,
              tolerances: op.tolerances,
              synonyms: op.synonyms,
              needsReview: op.needsReview,
              ukrSkladId: op.ukrSkladId,
              ukrSkladGroupId: op.ukrSkladGroupId,
              minStock: op.minStock
            });
            return { success: true, productKey: op.productKey };
          } catch (e) {
            logger.error("Upsert failed", { productKey: op.productKey, error: e.message });
            return { success: false, productKey: op.productKey, error: e.message };
          }
        });
        
        await Promise.allSettled(promises);
      }

      // 9) Батч-видалення з обмеженням concurrency
      for (let i = 0; i < operationsToRemove.length; i += CONCURRENCY_LIMIT) {
        const batch = operationsToRemove.slice(i, i + CONCURRENCY_LIMIT);
        const promises = batch.map(async (op) => {
          try {
            // Перевірка перед видаленням
            const productDoc = await publicProductsCol.doc(op.productDocId).get();
            if (!productDoc.exists) {
              logger.debug("Product already deleted", { productKey: op.productKey });
              return { success: true, productKey: op.productKey, skipped: true };
            }
            
            const data = productDoc.data();
            // Перевіряємо, чи є offer від постачальника
            const hasOffer = data.offers?.some(o => o.supplier === supplierNorm);
            if (!hasOffer) {
              logger.debug("Offer already removed", { productKey: op.productKey });
              return { success: true, productKey: op.productKey, skipped: true };
            }
            
            await removeProduct({
              supplier: supplierNorm,
              id: op.id || data.id,
              brand: op.brand || data.brand
            });
            return { success: true, productKey: op.productKey };
          } catch (e) {
            logger.warn("Remove failed", { productKey: op.productKey, error: e.message });
            return { success: false, productKey: op.productKey, error: e.message };
          }
        });
        
        await Promise.allSettled(promises);
      }

      // 10) Оновлюємо syncState
      await syncStateRef.set(
        { ukrSkladLastSyncTime: driveFileModifiedTime, lastAttemptAt: FieldValue.serverTimestamp() },
        { merge: true }
      );

      logger.info("SMART UkrSklad sync finished successfully (with private costs).");
      return { success: true, message: "Синхронізація завершена успішно" };
    } catch (e) {
      logger.error("SMART UkrSklad sync error:", e);
      throw e;
    }
}

// --------- currency rates sync ----------
async function syncCurrencyRates() {
  try {
    logger.info("Starting currency rates sync...");
    
    const FOLDER_ID = "1iAKEi_ixZYwxz18t2BrFoOw85maFCclP";
    const FILENAME = "currency.csv";
    
    const currencyRatesRef = db.doc(`/artifacts/${APP_ID}/public/meta/currencyRates/uahToEur`);
    
    // 1) Знаходимо файл у папці
    const gauth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
    const drive = google.drive({ version: "v3", auth: gauth });
    const res = await drive.files.list({
      q: `'${FOLDER_ID}' in parents AND name = '${FILENAME}' AND trashed = false`,
      fields: "files(id, name, modifiedTime)",
    });
    
    if (!res.data.files || res.data.files.length === 0) {
      logger.warn(`Currency sync: File '${FILENAME}' not found on Google Drive.`);
      return;
    }
    
    const driveFile = res.data.files[0];
    const driveFileModifiedTime = new Date(driveFile.modifiedTime);
    
    // 2) Перевіряємо, чи новіший файл
    const currencyRatesSnap = await currencyRatesRef.get();
    if (currencyRatesSnap.exists) {
      const lastSyncTime = currencyRatesSnap.data().lastSyncTime?.toDate();
      if (lastSyncTime && driveFileModifiedTime <= lastSyncTime) {
        logger.info(`Skipping currency sync. File '${FILENAME}' is not new.`);
        return { skipped: true };
      }
    }
    
    // 3) Читаємо CSV (cp1251, ';')
    const contentResp = await drive.files.get(
      { fileId: driveFile.id, alt: "media" },
      { responseType: "arraybuffer" }
    );
    const csvData = iconv.decode(Buffer.from(contentResp.data), "cp1251");
    const parsedCsv = Papa.parse(csvData, {
      header: true,
      delimiter: ";",
      skipEmptyLines: true,
    });
    
    // 4) Знаходимо рядок з id=2 (UAH) та беремо rate
    const uahRow = parsedCsv.data.find(row => String(row.id || "").trim() === "2");
    if (!uahRow || !uahRow.rate) {
      logger.warn("Currency sync: UAH row (id=2) not found or rate is missing.");
      return;
    }
    
    const rate = num(uahRow.rate);
    if (!rate || rate <= 0) {
      logger.warn(`Currency sync: Invalid rate value: ${uahRow.rate}`);
      return;
    }
    
    // 5) Зберігаємо курс в Firestore
    await currencyRatesRef.set({
      rate: rate,
      updatedAt: FieldValue.serverTimestamp(),
      sourceFile: FILENAME,
      lastSyncTime: driveFileModifiedTime,
    }, { merge: true });
    
    logger.info(`Currency sync finished. UAH to EUR rate: ${rate}`);
    return { success: true, rate };
  } catch (e) {
    logger.error("Currency sync error:", e);
    throw e;
  }
}

// --------- scheduled sync ----------
// Scheduled sync для курсів валют (раз на день о 08:00)
exports.currencyRatesSync = onSchedule(
  {
    schedule: "0 8 * * *", // 08:00 щодня
    timeZone: "Europe/Kyiv",
    region: REGION,
  },
  async () => {
    try {
      await syncCurrencyRates();
    } catch (e) {
      logger.error("currencyRatesSync error:", e);
    }
  }
);

exports.ukrSkladSync = onSchedule(
  { 
    schedule: "0 9-17/2 * * 1-5", // Кожні 2 години з 9 до 17 (9, 11, 13, 15, 17)
    timeZone: "Europe/Kyiv", 
    region: REGION,
    maxInstances: 1,  // Обмеження: тільки один екземпляр одночасно
  },
  async () => {
    try {
      await performUkrSkladSync(false);
    } catch (e) {
      logger.error("Scheduled ukrSkladSync failed:", e);
    }
  }
);

// --------- callable function for manual trigger ----------
exports.triggerUkrSkladSync = onCall({ 
  region: REGION, 
  cors: true,
  timeoutSeconds: 3600  // 60 хвилин (максимум для callable)
}, async (request) => {
  // Перевірка прав адміна
  if (!request.auth?.token?.admin) {
    throw new HttpsError("permission-denied", "Тільки для адмінів");
  }
  
  const forceSync = request.data?.force === true;
  
  try {
    const result = await performUkrSkladSync(forceSync);
    return result || { success: true, message: "Синхронізація завершена" };
  } catch (e) {
    logger.error("Manual UkrSklad sync error:", e);
    throw new HttpsError("internal", e.message || "Помилка синхронізації");
  }
});
