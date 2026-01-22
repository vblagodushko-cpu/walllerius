// functions/shared.js — common helpers for Firestore & products
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const logger = require("firebase-functions/logger");
const db = getFirestore();
const APP_ID = process.env.APP_ID || "embryo-project";

// Cache variables
let productMasterDataCache = null;
let brandSynonymsCache = null; // Map of normalizedOldBrand -> canonicalBrand
let cacheExpiry = 0;



const str = (v, max = 500) => {
  const s = (v ?? "").toString().trim();
  return s.length > max ? s.slice(0, max) : s;
};
const num = (v) => {
  if (v === null || v === undefined) return null;
  const m = String(v).replace(",", ".").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const normalizeArticle = (v) =>
  str(v, 200).toUpperCase().replace(/\s+/g, "").replace(/[^\w.-]/g, "");

// Normalize brand key for lookup (case-insensitive, whitespace-normalized)
function normalizeBrandKey(v) {
  if (v == null) return "";
  // Replace all unicode spaces (incl. NBSP) with normal space, collapse multiples
  const uniformSpace = String(v).replace(/[\s\u00A0]+/g, " ");
  return uniformSpace.trim().toLowerCase();
}

const normalizeBrand = async (v) => {
  const display = str(v, 120).replace(/\s{2,}/g, " ").trim();
  if (!display) return display;

  await loadAllCaches();
  const key = normalizeBrandKey(display);
  return brandSynonymsCache.get(key) || display;
};
const normalizeSupplier = (v) => str(v, 120).replace(/\s{2,}/g, " ").trim();

// Load all caches function
async function loadAllCaches() {
  // #region agent log
  const loadStart = Date.now();
  const cacheValid = Date.now() < cacheExpiry && productMasterDataCache && brandSynonymsCache;
  fetch('http://127.0.0.1:7242/ingest/43d36951-e2f3-464b-a260-765b59298148',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'shared.js:47',message:'loadAllCaches: entry',data:{cacheValid,currentTime:Date.now(),cacheExpiry},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
  // #endregion

  if (Date.now() < cacheExpiry && productMasterDataCache && brandSynonymsCache) {
    return; // Cache is still valid
  }
  
  try {
    // #region agent log
    const beforeLoad = Date.now();
    // #endregion

    const [masterDataSnap, brandsSnap] = await Promise.all([
      db.collection(`/artifacts/${APP_ID}/public/data/productMasterData`).get(),
      db.collection(`/artifacts/${APP_ID}/public/data/brandSynonyms`).get()
    ]);
    
    // #region agent log
    const loadTime = Date.now() - beforeLoad;
    fetch('http://127.0.0.1:7242/ingest/43d36951-e2f3-464b-a260-765b59298148',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'shared.js:56',message:'loadAllCaches: after load',data:{loadTimeMs:loadTime,masterDataCount:masterDataSnap.size,brandsCount:brandsSnap.size},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
    // #endregion
    
    // Cache product master data
    productMasterDataCache = new Map();
    masterDataSnap.docs.forEach(doc => {
      const data = doc.data();
      // Нормалізуємо основний артикул для індексації
      const normalizedId = normalizeArticle(data.id || "");
      const key = `${data.brand}__${normalizedId}`;
      productMasterDataCache.set(key, data);
      
      // Also index by synonyms for quick lookup (нормалізуємо синоніми)
      if (data.synonyms && Array.isArray(data.synonyms)) {
        data.synonyms.forEach(syn => {
          const normalizedSyn = normalizeArticle(syn);
          const synKey = `${data.brand}__${normalizedSyn}`;
          // Зберігаємо прапорець _isSynonym для логування, але дозволяємо повертати дані
          productMasterDataCache.set(synKey, { ...data, _isSynonym: true });
        });
      }
    });
    
    // Cache brand synonyms (keys normalized for case/space insensitivity)
    brandSynonymsCache = new Map();
    brandsSnap.docs.forEach(doc => {
      const data = doc.data() || {};
      const oldKey = normalizeBrandKey(data.old);
      if (!oldKey) return;
      brandSynonymsCache.set(oldKey, data.canonical);
    });
    
    cacheExpiry = Date.now() + 10 * 60 * 60 * 1000; // 10 годин (актуальний протягом робочого дня 09-17)
    logger.info("Caches loaded", { 
      masterDataCount: masterDataSnap.size, 
      brandSynonymsCount: brandsSnap.size 
    });
  } catch (e) {
    logger.error("Failed to load caches", { error: e.message });
    throw e;
  }
}

// Updated function to get product master data with caching
async function getProductMasterData(brand, article) {
  await loadAllCaches();
  
  // Нормалізуємо артикул для пошуку
  const normalizedArticle = normalizeArticle(article);
  const key = `${brand}__${normalizedArticle}`;
  
  // Спочатку шукаємо по основному артикулу
  const directData = productMasterDataCache.get(key);
  if (directData && !directData._isSynonym) {
    return directData;
  }
  
  // Якщо не знайдено - шукаємо по синонімах (вони також нормалізовані в кеші)
  if (directData && directData._isSynonym) {
    // Знайдено по синоніму - логуємо для моніторингу
    logger.debug("Master data found via synonym", { brand, article, normalizedArticle });
    // Повертаємо дані, прибравши прапорець _isSynonym для консистентності
    const { _isSynonym, ...cleanData } = directData;
    return cleanData;
  }
  
  return null;
}

/**
 * Знайти канонічний артикул для будь-якого артикулу (по всіх брендах)
 * Повертає { canonicalArticle, foundViaSynonym } або null
 */
async function findCanonicalArticleByAnyFormat(article) {
  await loadAllCaches();
  const normalizedSearch = normalizeArticle(article);
  if (!normalizedSearch) return null;
  
  for (const [key, data] of productMasterDataCache.entries()) {
    const parts = key.split('__');
    if (parts.length !== 2) continue;
    
    const [brand, cachedArticle] = parts;
    
    // Перевіряємо основний артикул
    if (normalizeArticle(cachedArticle) === normalizedSearch) {
      return {
        canonicalArticle: normalizeArticle(data.id),
        foundViaSynonym: data._isSynonym || false
      };
    }
    
    // Перевіряємо синоніми
    if (data.synonyms && Array.isArray(data.synonyms)) {
      for (const syn of data.synonyms) {
        if (normalizeArticle(syn) === normalizedSearch) {
          return {
            canonicalArticle: normalizeArticle(data.id),
            foundViaSynonym: true
          };
        }
      }
    }
  }
  
  // Якщо не знайдено - повертаємо нормалізований як канонічний
  return {
    canonicalArticle: normalizedSearch,
    foundViaSynonym: false
  };
}

const isAdminReq = (req) => {
  if (!req?.auth?.token?.admin) {
    const { HttpsError } = require("firebase-functions/v2/https");
    throw new HttpsError("permission-denied", "Admin token required");
  }
  return true;
};


async function upsertProduct({ supplier, brand, id, name, stock, publicPrices, purchase, categories, pack, tolerances, needsReview, synonyms, ukrSkladId, ukrSkladGroupId, minStock, prices }) {
  supplier = normalizeSupplier(supplier);
  brand = await normalizeBrand(brand);
  const article = normalizeArticle(id);
  const stockNum = Number.isFinite(stock) ? stock : (num(stock) ?? 0);
  const purchaseNum = Number.isFinite(purchase) ? purchase : (num(purchase) ?? 0);
  if (!supplier || !brand || !article) throw new Error("upsertProduct: supplier/brand/id required.");

  // НОВИЙ docId (без supplier)
  const docId = `${brand}-${article}`
    .replace(/\s+/g, "-")
    .replace(/[^\w.-]/g, "_");

  const productKey = docId; // brand-article
  const productRef = db.doc(`/artifacts/${APP_ID}/public/data/products/${docId}`);
  const costRef = db.doc(`/artifacts/${APP_ID}/private/data/productCosts/${docId}`);
  const supplierProductRef = db.doc(`/artifacts/${APP_ID}/public/data/supplierProducts/${supplier}-${productKey}`);

  // Використовуємо транзакцію для безпечного оновлення offers[]
  return await db.runTransaction(async (tx) => {
    const productSnap = await tx.get(productRef);
    const costSnap = await tx.get(costRef);
    
    const exists = productSnap.exists;
    logger.info("upsertProduct: transaction", { docId, supplier, brand, article, exists });
    
    let productData = exists ? productSnap.data() : {};
    let costData = costSnap.exists ? costSnap.data() : {};
    
    // Оновлення базових полів (тільки якщо не встановлені або оновлюємо)
    if (!productData.brand) productData.brand = brand;
    if (!productData.id) productData.id = article;
    // Оновлюємо name завжди, якщо передано (навіть якщо порожнє)
    if (name !== undefined && name !== null) {
      productData.name = str(name, 500);
    } else if (!productData.name) {
      // Якщо name не передано і не встановлено - встановлюємо порожнє
      productData.name = "";
    }
    if (categories !== undefined) productData.categories = categories;
    if (pack !== undefined) productData.pack = pack;
    if (tolerances !== undefined) productData.tolerances = tolerances;
    if (needsReview !== undefined) productData.needsReview = needsReview;
    if (synonyms !== undefined) productData.synonyms = Array.isArray(synonyms) ? synonyms : [];
    
    // Оновлення offers[]
    if (!productData.offers) productData.offers = [];
    
    const offerIndex = productData.offers.findIndex(o => o.supplier === supplier);
    const newOffer = {
    supplier,
    stock: stockNum || 0,
    publicPrices: Object.fromEntries(
      Object.entries(publicPrices || {}).map(([k, v]) => [k, round2(v)])
    ),
      updatedAt: Timestamp.now()
    };
    
    // Додаткові поля для "Мій склад"
    if (supplier === "Мій склад") {
      if (ukrSkladId !== undefined) newOffer.ukrSkladId = str(ukrSkladId, 200);
      if (ukrSkladGroupId !== undefined) newOffer.ukrSkladGroupId = str(ukrSkladGroupId, 200);
      if (minStock !== undefined) newOffer.minStock = Number.isFinite(minStock) ? minStock : (num(minStock) ?? null);
    }
    
    if (offerIndex >= 0) {
      productData.offers[offerIndex] = newOffer;
    } else {
      productData.offers.push(newOffer);
    }
    
    // Оновлення purchaseBySupplier
    if (!costData.purchaseBySupplier) costData.purchaseBySupplier = {};
    if (purchaseNum > 0) {
      costData.purchaseBySupplier[supplier] = purchaseNum;
    }
    
    productData.updatedAt = FieldValue.serverTimestamp();
    costData.updatedAt = FieldValue.serverTimestamp();
    
    // Перевірка, що productData містить мінімальні поля
    if (!productData.brand || !productData.id) {
      logger.error("upsertProduct: missing required fields", { docId, brand: productData.brand, id: productData.id });
      throw new Error(`upsertProduct: missing required fields (brand: ${productData.brand}, id: ${productData.id})`);
    }
    
    // Запис
    tx.set(productRef, productData, { merge: true });
    tx.set(costRef, costData, { merge: true });
    
    // Оновлення supplierProducts
    tx.set(supplierProductRef, {
      productDocId: docId,
      supplier,
      productKey,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    
    logger.info("upsertProduct: transaction commit", { docId, offersCount: productData.offers?.length || 0 });
    
  return docId;
  });
}

async function removeProduct({ supplier, id, brand }) {
  const supplierNorm = normalizeSupplier(supplier);
  const article = normalizeArticle(id);
  if (!supplierNorm || !article) return;

  const publicColl = db.collection(`/artifacts/${APP_ID}/public/data/products`);
  const privateBase = `/artifacts/${APP_ID}/private/data/productCosts`;
  const supplierProductsCol = db.collection(`/artifacts/${APP_ID}/public/data/supplierProducts`);

  // Нормалізуємо brand для формування docId (ДО транзакції)
  let brandNorm = null;
  let productRef = null;

  if (brand) {
    brandNorm = await normalizeBrand(brand);
    const docId = `${brandNorm}-${article}`
      .replace(/\s+/g, "-")
      .replace(/[^\w.-]/g, "_");
    productRef = publicColl.doc(docId);
  } else {
    // Якщо немає brand - шукаємо по article (рідкісний випадок)
    const snap = await publicColl.where("id", "==", article).limit(1).get();
    if (snap.empty) return;
    productRef = snap.docs[0].ref;
  }

  // Використовуємо транзакцію для безпечного видалення пропозиції
  return await db.runTransaction(async (tx) => {
    const productSnap = await tx.get(productRef);
    if (!productSnap.exists) return;
    
    const productData = productSnap.data();

    // Перевіряємо, чи є пропозиція від постачальника
    if (!productData.offers || !Array.isArray(productData.offers)) return;
    
    const offerIndex = productData.offers.findIndex(o => o.supplier === supplierNorm);
    if (offerIndex === -1) return; // Пропозиції немає

    // Видаляємо пропозицію з масиву
    const updatedOffers = [...productData.offers];
    updatedOffers.splice(offerIndex, 1);
    
    const costRef = db.doc(`${privateBase}/${productRef.id}`);
    const costSnap = await tx.get(costRef);
    let costData = costSnap.exists ? costSnap.data() : {};

    // Видаляємо purchaseBySupplier[supplier]
    if (costData.purchaseBySupplier && costData.purchaseBySupplier[supplierNorm]) {
      delete costData.purchaseBySupplier[supplierNorm];
    }

    // Якщо offers[] стає порожнім - видаляємо весь документ
    if (updatedOffers.length === 0) {
      tx.delete(productRef);
      tx.delete(costRef);
    } else {
      // Оновлюємо документ без видаленої пропозиції
      const updatedProductData = {
        ...productData,
        offers: updatedOffers,
        updatedAt: FieldValue.serverTimestamp()
      };
      tx.set(productRef, updatedProductData, { merge: true });
      
      if (costSnap.exists) {
        costData.updatedAt = FieldValue.serverTimestamp();
        tx.set(costRef, costData, { merge: true });
      }
    }

    // Видаляємо запис з supplierProducts
    const productKey = `${productData.brand}-${productData.id}`;
    const supplierProductRef = supplierProductsCol.doc(`${supplierNorm}-${productKey}`);
    tx.delete(supplierProductRef);
  });
}

module.exports = {
  db,
  APP_ID,
  FieldValue,
  str,
  num,
  round2,
  normalizeArticle,
  normalizeBrand,
  normalizeSupplier,
  isAdminReq,
  upsertProduct,
  removeProduct,
  getProductMasterData,
  findCanonicalArticleByAnyFormat,
  _getProductMasterDataCache: () => productMasterDataCache,
};
