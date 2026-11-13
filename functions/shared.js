// functions/shared.js — common helpers for Firestore & products
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

// Переконаємося, що admin ініціалізований перед викликом getFirestore
if (!admin.apps.length) {
  admin.initializeApp();
}
const db = getFirestore();

const APP_ID = process.env.APP_ID || "embryo-project";

// Cache variables
let productMasterDataCache = null;
let brandSynonymsCache = null; // Map of normalizedOldBrand -> canonicalBrand
let cacheExpiry = 0;
/** Одночасні виклики getProductMasterData (монітор тощо) не мають паралельно перезавантажувати кеш. */
let loadAllCachesInFlight = null;

function clearMasterDataCache() {
  productMasterDataCache = null;
  brandSynonymsCache = null;
  cacheExpiry = 0;
  productDocIdCache.clear();
}



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

/** Літри без одиниць: "4", "0.2" (не "200 мл", не "4л"). */
function formatPackLiters(liters) {
  const v = Math.round(liters * 1000) / 1000;
  if (!Number.isFinite(v) || v <= 0) return "";
  if (Number.isInteger(v)) return String(v);
  return String(v).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function normalizePack(value) {
  const raw = str(value, 200);
  if (!raw) return "";

  const compact = raw.replace(/\s+/g, "").toLowerCase();

  const mlCompact = compact.match(/^(\d+(?:[.,]\d+)?)(?:мл|ml)$/i);
  if (mlCompact) {
    return formatPackLiters(parseFloat(mlCompact[1].replace(",", ".")) / 1000);
  }

  const literCompact = compact.match(/^(\d+(?:[.,]\d+)?)(?:л|l|літр|litre|liter)s?\.?$/i);
  if (literCompact) {
    return formatPackLiters(parseFloat(literCompact[1].replace(",", ".")));
  }

  const plainNum = raw.match(/^(\d+(?:[.,]\d+)?)$/);
  if (plainNum) {
    return formatPackLiters(parseFloat(plainNum[1].replace(",", ".")));
  }

  const embeddedLiter = raw.match(/(\d+(?:[.,]\d+)?)\s*(?:л|l|літр(?:а|ів)?)\b/i);
  if (embeddedLiter) {
    return formatPackLiters(parseFloat(embeddedLiter[1].replace(",", ".")));
  }

  const embeddedMl = raw.match(/(\d+(?:[.,]\d+)?)\s*(?:мл|ml)\b/i);
  if (embeddedMl) {
    return formatPackLiters(parseFloat(embeddedMl[1].replace(",", ".")) / 1000);
  }

  return raw;
}

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

/** docId з уже нормалізованого бренду й артикула. Регістр бренду входить в id. */
function buildProductDocId(brand, article) {
  const sanitizedBrand = sanitizeDocId(brand);
  return `${sanitizedBrand}-${article}`
    .replace(/\s+/g, "-")
    .replace(/[^\w.-]/g, "_");
}

// Щоб повторні рядки одного прайсу не робили зайвий where на кожен upsert.
const productDocIdCache = new Map();
const PRODUCT_DOC_CACHE_MS = 15 * 60 * 1000;

/**
 * Картка з тим самим артикулом і брендом (без урахування регістру) вже може
 * мати інший docId (старий регістр, до синоніма). Пишемо в неї, а не створюємо другу.
 * Якщо є документ з канонічним docId — він головний.
 */
async function resolveProductDocId(brand, article) {
  const cacheKey = `${normalizeBrandKey(brand)}__${article}`;
  const hit = productDocIdCache.get(cacheKey);
  if (hit && hit.exp > Date.now()) return hit.id;

  const canonicalId = buildProductDocId(brand, article);
  const snap = await db
    .collection(`/artifacts/${APP_ID}/public/data/products`)
    .where("id", "==", article)
    .limit(25)
    .get();

  const brandKey = normalizeBrandKey(brand);
  const matches = snap.docs.filter(
    (d) => normalizeBrandKey(d.data()?.brand) === brandKey
  );
  const exact = matches.find((d) => d.id === canonicalId);
  let chosen = canonicalId;
  if (exact) {
    chosen = exact.id;
  } else if (matches.length) {
    matches.sort((a, b) => {
      const ta = a.data()?.updatedAt?.toMillis?.() || 0;
      const tb = b.data()?.updatedAt?.toMillis?.() || 0;
      return tb - ta;
    });
    chosen = matches[0].id;
    logger.info("resolveProductDocId: існуюча картка замість нової", {
      canonicalId,
      chosen,
      article,
    });
  }

  productDocIdCache.set(cacheKey, { id: chosen, exp: Date.now() + PRODUCT_DOC_CACHE_MS });
  return chosen;
}

/**
 * Sanitize document ID - замінює небезпечні символи (/, \, та інші) на безпечні
 * Використовується для брендів, які можуть містити "/" (наприклад, "Citroen/Peugeot")
 */
function sanitizeDocId(docId) {
  if (!docId) return "";
  // Замінюємо / на _, інші небезпечні символи також
  return String(docId)
    .replace(/\//g, "_")
    .replace(/\\/g, "_")
    .replace(/[^\w.-]/g, (m) => (m === "-" || m === "." ? m : "_"));
}

// Load all caches function (single-flight: паралельні виклики чекають один і той самий завантаження)
async function loadAllCaches() {
  while (true) {
    if (Date.now() < cacheExpiry && productMasterDataCache && brandSynonymsCache) {
      return;
    }
    if (loadAllCachesInFlight) {
      await loadAllCachesInFlight;
      continue;
    }

    loadAllCachesInFlight = (async () => {
      try {
        const [masterDataSnap, brandsSnap] = await Promise.all([
          db.collection(`/artifacts/${APP_ID}/public/data/productMasterData`).get(),
          db.collection(`/artifacts/${APP_ID}/public/data/brandSynonyms`).get(),
        ]);

        productMasterDataCache = new Map();
        masterDataSnap.docs.forEach((doc) => {
          const data = doc.data();
          const row = { ...data, _masterFirestoreId: doc.id };
          const normalizedId = normalizeArticle(data.id || "");
          const brandKey = normalizeBrandKey(data.brand || "");
          const key = `${brandKey}__${normalizedId}`;
          productMasterDataCache.set(key, row);

          if (data.synonyms && Array.isArray(data.synonyms)) {
            data.synonyms.forEach((syn) => {
              const normalizedSyn = normalizeArticle(syn);
              const synKey = `${brandKey}__${normalizedSyn}`;
              productMasterDataCache.set(synKey, { ...row, _isSynonym: true });
            });
          }
        });

        brandSynonymsCache = new Map();
        brandsSnap.docs.forEach((doc) => {
          const data = doc.data() || {};
          const oldKey = normalizeBrandKey(data.old);
          if (!oldKey) return;
          brandSynonymsCache.set(oldKey, data.canonical);
        });

        cacheExpiry = Date.now() + 10 * 60 * 60 * 1000;
        logger.info("Caches loaded", {
          masterDataCount: masterDataSnap.size,
          brandSynonymsCount: brandsSnap.size,
        });
      } catch (e) {
        logger.error("Failed to load caches", { error: e.message });
        throw e;
      } finally {
        loadAllCachesInFlight = null;
      }
    })();

    await loadAllCachesInFlight;
  }
}

/** Прибирає службові поля кешу перед поверненням у синки / API. */
function stripMasterCacheInternalFields(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const { _masterFirestoreId, _isSynonym, ...rest } = obj;
  return rest;
}

// Updated function to get product master data with caching
async function getProductMasterData(brand, article) {
  await loadAllCaches();

  const normalizedArticle = normalizeArticle(article);
  const key = `${normalizeBrandKey(brand)}__${normalizedArticle}`;

  const directData = productMasterDataCache.get(key);
  if (directData && !directData._isSynonym) {
    return stripMasterCacheInternalFields(directData);
  }

  if (directData && directData._isSynonym) {
    logger.debug("Master data found via synonym", { brand, article, normalizedArticle });
    const { _isSynonym, ...cleanData } = directData;
    return stripMasterCacheInternalFields(cleanData);
  }

  return null;
}

/**
 * Фізичний id документа productMasterData (як у Firestore), після того самого резолву що getProductMasterData.
 * Для update/delete — щоб не будувати docId з рядка бренду на картці товару.
 */
async function resolveProductMasterFirestoreId(brand, article) {
  await loadAllCaches();
  const normalizedArticle = normalizeArticle(article);
  const key = `${normalizeBrandKey(brand)}__${normalizedArticle}`;
  const directData = productMasterDataCache.get(key);
  if (!directData) return null;
  const firestoreId = directData._masterFirestoreId;
  if (!firestoreId) return null;
  if (directData._isSynonym) {
    const { _isSynonym, ...rest } = directData;
    return { firestoreId, row: stripMasterCacheInternalFields(rest) };
  }
  return { firestoreId, row: stripMasterCacheInternalFields(directData) };
}

/** Fallback doc id для нової картки (як раніше в updateProductMasterData). */
function defaultProductMasterDocId(displayBrand, articleNorm) {
  const b = str(displayBrand, 120).replace(/\s{2,}/g, " ").trim();
  return `${b}__${articleNorm}`;
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


// createIfMissing === false: не створювати новий товар (повертає null); наявний оновлюється як завжди.
async function upsertProduct({ supplier, brand, id, name, stock, publicPrices, categories, pack, tolerances, synonyms, ukrSkladId, ukrSkladGroupId, minStock, lastSupplier, prices, createIfMissing }) {
  supplier = normalizeSupplier(supplier);
  brand = await normalizeBrand(brand);
  const article = normalizeArticle(id);
  const stockNum = Number.isFinite(stock) ? stock : (num(stock) ?? 0);
  if (!supplier || !brand || !article) throw new Error("upsertProduct: supplier/brand/id required.");

  const docId = await resolveProductDocId(brand, article);
  const productKey = docId;
  const productRef = db.doc(`/artifacts/${APP_ID}/public/data/products/${docId}`);
  const supplierProductRef = db.doc(`/artifacts/${APP_ID}/public/data/supplierProducts/${supplier}-${productKey}`);

  // Використовуємо транзакцію для безпечного оновлення offers[]
  return await db.runTransaction(async (tx) => {
    const productSnap = await tx.get(productRef);
    
    const exists = productSnap.exists;
    if (!exists && createIfMissing === false) return null;
    logger.info("upsertProduct: transaction", { docId, supplier, brand, article, exists });
    
    let productData = exists ? productSnap.data() : {};
    
    // Завжди канонічний brand з normalizeBrand (синоніми) — інакше лишаються старі варіанти регістру
    productData.brand = brand;
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
    if (synonyms !== undefined) productData.synonyms = Array.isArray(synonyms) ? synonyms : [];
    // Зберігаємо останнього постачальника з UkrSklad CSV (тільки якщо передано і не порожнє)
    if (lastSupplier !== undefined && lastSupplier && String(lastSupplier).trim()) {
      productData.lastSupplier = str(lastSupplier, 200);
    }
    
    // Зберігаємо ukrSkladId, ukrSkladGroupId, minStock в корінь продукту (тільки для "Мій склад")
    if (supplier === "Мій склад") {
      if (ukrSkladId !== undefined && ukrSkladId !== null && String(ukrSkladId).trim()) {
        productData.ukrSkladId = str(ukrSkladId, 200);
      }
      if (ukrSkladGroupId !== undefined && ukrSkladGroupId !== null && String(ukrSkladGroupId).trim()) {
        productData.ukrSkladGroupId = str(ukrSkladGroupId, 200);
      }
      if (minStock !== undefined) {
        productData.minStock = Number.isFinite(minStock) ? minStock : (num(minStock) ?? null);
      }
    }
    
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
    
    if (offerIndex >= 0) {
      productData.offers[offerIndex] = newOffer;
    } else {
      productData.offers.push(newOffer);
    }
    
    productData.updatedAt = FieldValue.serverTimestamp();
    
    // Перевірка, що productData містить мінімальні поля
    if (!productData.brand || !productData.id) {
      logger.error("upsertProduct: missing required fields", { docId, brand: productData.brand, id: productData.id });
      throw new Error(`upsertProduct: missing required fields (brand: ${productData.brand}, id: ${productData.id})`);
    }
    
    // Запис
    tx.set(productRef, productData, { merge: true });
    
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
  const supplierProductsCol = db.collection(`/artifacts/${APP_ID}/public/data/supplierProducts`);

  let refs = [];
  if (brand) {
    const brandNorm = await normalizeBrand(brand);
    const snap = await publicColl.where("id", "==", article).limit(25).get();
    const brandKey = normalizeBrandKey(brandNorm);
    const matches = snap.docs.filter(
      (d) => normalizeBrandKey(d.data()?.brand) === brandKey
    );
    refs = matches.length
      ? matches.map((d) => d.ref)
      : [publicColl.doc(buildProductDocId(brandNorm, article))];
    productDocIdCache.delete(`${brandKey}__${article}`);
  } else {
    const snap = await publicColl.where("id", "==", article).limit(1).get();
    if (snap.empty) return;
    refs = [snap.docs[0].ref];
  }

  for (const productRef of refs) {
    await db.runTransaction(async (tx) => {
      const productSnap = await tx.get(productRef);
      if (!productSnap.exists) return;

      const productData = productSnap.data();
      if (!productData.offers || !Array.isArray(productData.offers)) return;

      const offerIndex = productData.offers.findIndex((o) => o.supplier === supplierNorm);
      if (offerIndex === -1) return;

      const updatedOffers = [...productData.offers];
      updatedOffers.splice(offerIndex, 1);

      if (updatedOffers.length === 0) {
        tx.delete(productRef);
      } else {
        tx.set(
          productRef,
          {
            ...productData,
            offers: updatedOffers,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }

      tx.delete(supplierProductsCol.doc(`${supplierNorm}-${productRef.id}`));
    });
  }
}

function categoryListKey(list) {
  return (Array.isArray(list) ? list : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .sort()
    .join("\u0001");
}

/**
 * Після редагування майстер-картки записує її категорії в усі картки каталогу
 * з тим самим брендом і артикулом (і з синонімом артикула, якщо це код, а не в'язкість).
 * Порожній список категорій нічого не стирає.
 */
async function syncCatalogCategoriesForMaster({ brand, article, synonyms, categories }) {
  const next = (Array.isArray(categories) ? categories : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  if (!next.length || !brand) return { scanned: 0, updated: 0 };

  const { looksLikeSpecNotArticle } = require("./articleSynonyms");
  const brandKey = normalizeBrandKey(brand);
  const ids = new Set();
  const addArticle = (value, { allowSpec = false } = {}) => {
    const raw = String(value || "").trim();
    const norm = normalizeArticle(value);
    if (!norm || (!allowSpec && (norm.length < 4 || looksLikeSpecNotArticle(norm)))) return;
    if (raw) ids.add(raw);
    ids.add(norm);
  };
  addArticle(article, { allowSpec: true });
  (Array.isArray(synonyms) ? synonyms : []).forEach((item) => addArticle(item));

  const col = db.collection(`/artifacts/${APP_ID}/public/data/products`);
  const nextKey = categoryListKey(next);
  let scanned = 0;
  let updated = 0;
  let batch = db.batch();
  let ops = 0;

  const commit = async () => {
    if (!ops) return;
    await batch.commit();
    batch = db.batch();
    ops = 0;
  };

  for (const id of ids) {
    const snap = await col.where("id", "==", id).limit(40).get();
    for (const docSnap of snap.docs) {
      const data = docSnap.data() || {};
      if (normalizeBrandKey(data.brand) !== brandKey) continue;
      scanned += 1;
      if (categoryListKey(data.categories) === nextKey) continue;
      batch.set(
        docSnap.ref,
        {
          categories: next,
          masterDataUpdatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      ops += 1;
      updated += 1;
      if (ops >= 400) await commit();
    }
  }
  await commit();
  return { scanned, updated };
}

module.exports = {
  db,
  APP_ID,
  FieldValue,
  str,
  num,
  round2,
  normalizePack,
  normalizeArticle,
  normalizeBrand,
  normalizeBrandKey,
  normalizeSupplier,
  sanitizeDocId,
  isAdminReq,
  upsertProduct,
  removeProduct,
  getProductMasterData,
  resolveProductMasterFirestoreId,
  defaultProductMasterDocId,
  findCanonicalArticleByAnyFormat,
  clearMasterDataCache,
  categoryListKey,
  syncCatalogCategoriesForMaster,
  _getProductMasterDataCache: () => productMasterDataCache,
};
