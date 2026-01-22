// functions/suppliers.js — CSV import & manual upload with pricing rules
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const axios = require("axios");
const Papa = require("papaparse");
const {
  db, APP_ID, round2, FieldValue,
  normalizeBrand, normalizeSupplier, normalizeArticle, upsertProduct, removeProduct, isAdminReq, getProductMasterData
} = require("./shared");
const { schemas, validateData, validateArray } = require("./shared/validation");
const Joi = require('joi');

const REGION = process.env.FUNCTION_REGION || "europe-central2";

const pctValue = (x) => {
  if (x == null || x === "") return 0;
  const s = String(x).trim().replace(",", ".").replace("%", "");
  const n = Number(s);
  return Number.isFinite(n) ? n / 100 : 0;
};
const pick = (o, keys) => {
  for (const k of keys) {
    const v = o?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return undefined;
};
const toStock = (v) => {
  if (Number.isFinite(v)) return Math.max(0, Math.floor(v));
  const s = String(v ?? "").toLowerCase();
  if (!s) return 0;
  if (/(чека|ожида|нет|відсут)/.test(s)) return 0;
  const m = s.match(/-?\d+([.,]\d+)?/);
  return m ? Math.max(0, Math.floor(Number(m[0].replace(",", ".")))) : 0;
};
const toPrice = (v) => {
  if (Number.isFinite(v)) return round2(v);
  const m = String(v ?? "").replace(/\s/g, "").replace(",", ".").match(/-?\d+(\.\d+)?/);
  return round2(m ? Number(m[0]) : 0);
};

function parseRuleObject(obj) {
  if (!obj) return null;
  const flatEn = {
    retail: pctValue(pick(obj, ["retailPercent", "retail"])),
    p1: pctValue(pick(obj, ["price1Percent", "p1", "price1"])),
    p2: pctValue(pick(obj, ["price2Percent", "p2", "price2"])),
    p3: pctValue(pick(obj, ["price3Percent", "p3", "price3"])),
    wholesale: pctValue(pick(obj, ["wholesalePercent", "wholesale", "optPercent"])),
  };
  if (flatEn.retail || flatEn.p1 || flatEn.p2 || flatEn.p3 || flatEn.wholesale) return flatEn;

  const flatUa = {
    retail: pctValue(obj["роздріб"]),
    p1: pctValue(obj["ціна 1"]),
    p2: pctValue(obj["ціна 2"]),
    p3: pctValue(obj["ціна 3"]),
    wholesale: pctValue(obj["ціна опт"]),
  };
  if (flatUa.retail || flatUa.p1 || flatUa.p2 || flatUa.p3 || flatUa.wholesale) return flatUa;

  const nested = obj.rules || obj.markups || obj.pricing;
  if (nested) {
    return {
      retail: pctValue(pick(nested, ["retail", "роздріб"])),
      p1: pctValue(pick(nested, ["p1", "price1", "ціна 1"])),
      p2: pctValue(pick(nested, ["p2", "price2", "ціна 2"])),
      p3: pctValue(pick(nested, ["p3", "price3", "ціна 3"])),
      wholesale: pctValue(pick(nested, ["wholesale", "опт", "ціна опт"])),
    };
  }
  return null;
}

async function loadPricingRules(supplierIdRaw) {
  const supplierId = normalizeSupplier(supplierIdRaw || "");

  let snap = await db.doc(`/artifacts/${APP_ID}/public/data/pricingRules/${supplierId}`).get();
  if (snap.exists) {
    const r = parseRuleObject(snap.data());
    if (r) return r;
  }

  const col = db.collection(`/artifacts/${APP_ID}/public/data/pricingRules`);
  let q = await col.where("supplierId", "==", supplierId).limit(1).get();
  if (!q.empty) {
    const r = parseRuleObject(q.docs[0].data());
    if (r) return r;
  }
  for (const field of ["supplier", "code", "id", "name"]) {
    q = await col.where(field, "==", supplierId).limit(1).get();
    if (!q.empty) {
      const r = parseRuleObject(q.docs[0].data());
      if (r) return r;
    }
  }

  const sSnap = await db.doc(`/artifacts/${APP_ID}/public/data/suppliers/${supplierId}`).get();
  if (sSnap.exists) {
    const r = parseRuleObject(sSnap.data());
    if (r) return r;
  }

  return { retail: 0, p1: 0, p2: 0, p3: 0, wholesale: 0 };
}

async function buildPublicPrices(purchase, supplierId) {
  const r = await loadPricingRules(supplierId);
  const apply = (p) => round2(purchase * (1 + p));
  return {
    "роздріб": apply(r.retail),
    "ціна 1":  apply(r.p1),
    "ціна 2":  apply(r.p2),
    "ціна 3":  apply(r.p3),
    "ціна опт": apply(r.wholesale),
  };
}

async function processAndSaveProducts(rows, supplier) {
  const supplierNorm = normalizeSupplier(supplier?.name || supplier?.id || "manual");
  const supplierId = String(supplier?.id || supplierNorm);
  
  // Обмеження на кількість товарів
  const MAX_PRODUCTS = 3000;
  if (rows.length > MAX_PRODUCTS) {
    throw new Error(`Перевищено обмеження: максимум ${MAX_PRODUCTS} товарів на прайс. Знайдено: ${rows.length}. Будь ласка, розбийте прайс на частини.`);
  }
  
  let ok = 0, skipped = 0, removed = 0;

  // Крок 1: Нормалізація та збір ключів (оптимізація)
  const normalizedProductKeys = new Set(); // brand-article
  const rowsToProcess = []; // Зберігаємо нормалізовані дані для обробки

  for (const row of rows) {
    const brandRaw = pick(row, ["brand","Бренд","бренд"]) || "";
    const idRaw = pick(row, ["id","article","code","Артикул","Код","артикул","код"]) || "";
    if (!idRaw || !brandRaw) { skipped++; continue; }

    const normalizedBrand = await normalizeBrand(brandRaw);
    const article = normalizeArticle(idRaw);
    if (!article) { skipped++; continue; }

    const productKey = `${normalizedBrand}-${article}`;
    normalizedProductKeys.add(productKey);
    
    rowsToProcess.push({ row, normalizedBrand, article, productKey });
  }

  // Крок 2: Оптимізація з supplierProducts (читання існуючих товарів)
  const supplierProductsCol = db.collection(`/artifacts/${APP_ID}/public/data/supplierProducts`);
  const productsCol = db.collection(`/artifacts/${APP_ID}/public/data/products`);
  
  const supplierProductsSnap = await supplierProductsCol
    .where("supplier", "==", supplierNorm)
    .get();
  
  const existingMap = new Map(); // productKey → { productDocId, data }
  
  // Фільтруємо тільки ті, які є в CSV
  const productDocIdsToRead = [];
  supplierProductsSnap.forEach(doc => {
    const data = doc.data();
    const productKey = data.productKey;
    
    if (normalizedProductKeys.has(productKey)) {
      existingMap.set(productKey, { productDocId: data.productDocId });
      productDocIdsToRead.push(data.productDocId);
    }
  });
  
  // Читаємо товари батчами по 30
  const CHUNK = 30;
  for (let i = 0; i < productDocIdsToRead.length; i += CHUNK) {
    const part = productDocIdsToRead.slice(i, i + CHUNK);
    const productsSnap = await productsCol
      .where("__name__", "in", part)
      .get();
    
    productsSnap.forEach(doc => {
      const data = doc.data();
      const productKey = `${data.brand}-${data.id}`;
      if (existingMap.has(productKey)) {
        existingMap.get(productKey).data = data;
      }
    });
  }

  // Крок 3: Обробка кожного рядка
  logger.info("processAndSaveProducts: starting processing", { 
    totalRows: rowsToProcess.length, 
    supplier: supplierNorm,
    existingProductsCount: existingMap.size
  });
  for (const { row, normalizedBrand, article, productKey } of rowsToProcess) {
    try {
      const name = pick(row, ["name","Назва","Найменування","найменування"]) || "";
      const stock = toStock(pick(row, ["stock","amount","qty","Наявність","Кількість","кількість","наличие"]));
      const price = toPrice(pick(row, ["price","Ціна","purchase","base_price","cost","ціна"]));

      if (stock <= 0) { 
        await removeProduct({ supplier: supplierNorm, id: article, brand: normalizedBrand }); 
        removed++; 
        continue; 
      }

      const publicPrices = await buildPublicPrices(price, supplierId);
      const masterData = await getProductMasterData(normalizedBrand, article);
      
      // Використовуємо канонічний id з masterData, якщо він є, інакше оригінальний з рядка
      const rawId = row.id || row.code || row.article || row.Артикул || row.Код || row.артикул || row.код;
      const productId = masterData?.id || rawId;
      
      if (masterData) {
        await upsertProduct({
          supplier: supplierNorm,
          brand: normalizedBrand,
          id: productId,
          name: masterData.correctName || name,
          stock,
          publicPrices,
          categories: masterData.categories || null,
          pack: masterData.pack || null,
          tolerances: masterData.tolerances || null,
          synonyms: masterData.synonyms || [],
          needsReview: false,
        });
      } else {
        await upsertProduct({
          supplier: supplierNorm,
          brand: normalizedBrand,
          id: productId,
          name,
        stock,
        publicPrices,
          categories: null,
          pack: null,
          tolerances: null,
          needsReview: true,
      });
      }
      ok++;
    } catch (e) {
      logger.error("Row skipped", { 
        error: String(e), 
        stack: e.stack,
        productKey,
        supplier: supplierNorm,
        row: JSON.stringify(row).slice(0, 200)
      });
      skipped++;
    }
  }
  
  logger.info("processAndSaveProducts: finished processing", { 
    ok, 
    skipped, 
    removed, 
    total: rows.length,
    supplier: supplierNorm
  });

  // Cleanup: видалити пропозиції, яких немає в новому прайсі
  // Використовуємо supplierProducts для швидкого пошуку
  const supplierProductsToCheck = [];
  supplierProductsSnap.forEach(doc => {
    const data = doc.data();
    const productKey = data.productKey;
    
    // Якщо товар НЕ в новому CSV - потрібно видалити пропозицію
    if (!normalizedProductKeys.has(productKey)) {
      supplierProductsToCheck.push({ productKey, productDocId: data.productDocId });
    }
  });
  
  // Видаляємо пропозиції
  for (const { productKey, productDocId } of supplierProductsToCheck) {
    try {
      // Читаємо товар
      const productDoc = await productsCol.doc(productDocId).get();
      if (!productDoc.exists) continue;
      
      const data = productDoc.data();
      
      // Видаляємо пропозицію від постачальника
      await removeProduct({
        supplier: supplierNorm,
        id: data.id,
        brand: data.brand
      });
      
      // removeProduct автоматично видалить документ, якщо offers[] стане порожнім
      // removeProduct також видалить запис з supplierProducts
    } catch (e) {
      logger.warn("Failed to remove product offer", { productKey, error: e.message });
    }
  }

  return { ok, skipped, removed, total: rows.length };
}

async function parseCsvFromUrlUtf8_STRICT(url) {
  // Підтримує http:// і https://
  const resp = await axios.get(url, { responseType: "arraybuffer", timeout: 30000 });
  const text = Buffer.from(resp.data).toString("utf8");

  // Парсимо БЕЗ header, жорстко по індексу; поважає лапки і кому
  const parsed = Papa.parse(text, {
    header: false,
    skipEmptyLines: true,
    delimiter: ",",
    quoteChar: '"',
    dynamicTyping: false,
  });

  // Очікуємо 5 колонок у такому порядку:
  // 0: Бренд, 1: id, 2: назва, 3: кількість, 4: Ціна
  const rows = [];
  for (const r of parsed.data) {
    if (!Array.isArray(r)) continue;
    if (r.length < 5) continue;

    // Можливий заголовок у першому рядку — пропустимо його
    const maybeHeader = (val) => String(val ?? "").trim().toLowerCase();
    if (
      maybeHeader(r[0]).includes("бренд") ||
      maybeHeader(r[1]) === "id" ||
      maybeHeader(r[2]).includes("назва") ||
      maybeHeader(r[3]).includes("кільк") ||
      maybeHeader(r[4]).includes("цiна") || maybeHeader(r[4]).includes("ціна")
    ) {
      continue;
    }

    const brand = String(r[0] ?? "").trim();
    const id    = String(r[1] ?? "").trim();
    const name  = String(r[2] ?? "").trim();

    // кількість → ціле число ≥ 0
    const stockStr = String(r[3] ?? "").replace(/\s/g, "").replace(",", ".");
    const stock = Math.max(0, Math.floor(Number(stockStr || "0") || 0));

    // ціна → число з крапкою
    const priceStr = String(r[4] ?? "").replace(/\s/g, "").replace(",", ".");
    const price = Number(priceStr || "0") || 0;

    // пропускаємо порожні рядки
    if (!brand || !id) continue;

    rows.push({ brand, id, name, stock, price });
  }

  return rows;
}
exports.importSupplierCsv = onCall({ 
  region: REGION, 
  cors: true,
  timeoutSeconds: 3600,  // 60 хвилин (максимум для callable)
  memory: "512MiB"
}, async (req) => {
  isAdminReq(req);
  
  // Validate input data
  const importSchema = Joi.object({
    url: Joi.string().uri().required(),
    supplier: schemas.supplier.optional(),
    jobId: Joi.string().optional()
  });
  const validatedData = validateData(importSchema, req.data, "CSV import request");
  const { url, supplier, jobId } = validatedData;

  // Якщо є jobId - оновлюємо статус
  let jobRef = null;
  if (jobId) {
    jobRef = db.doc(`/artifacts/${APP_ID}/private/data/importJobs/${jobId}`);
    try {
      await jobRef.update({ status: "running" });
    } catch (e) {
      logger.warn("Failed to update job status to running", { jobId, error: e.message });
    }
  }

  try {
  // читаємо CSV строго за порядком колонок
  const rows = await parseCsvFromUrlUtf8_STRICT(url);

  // Перевірка обмеження
  const MAX_PRODUCTS = 3000;
  if (rows.length > MAX_PRODUCTS) {
      const error = `Перевищено обмеження: максимум ${MAX_PRODUCTS} товарів на прайс. Знайдено: ${rows.length}. Будь ласка, розбийте прайс на частини.`;
      if (jobRef) {
        await jobRef.update({
          status: "failed",
          completedAt: FieldValue.serverTimestamp(),
          error
        });
      }
      throw new HttpsError("invalid-argument", error);
  }

  // ВАЖЛИВО: supplier.id має бути кодом постачальника (щоб знайти pricingRules)
  const sup = supplier?.id
    ? supplier
    : { id: supplier?.id || supplier?.name || "url", name: supplier?.name || "url" };

  const result = await processAndSaveProducts(rows, sup);
    
    // Оновлюємо job з результатом
    if (jobRef) {
      await jobRef.update({
        status: "completed",
        completedAt: FieldValue.serverTimestamp(),
        result: result
      });
    }
    
  return result;
  } catch (e) {
    // Оновлюємо job з помилкою
    if (jobRef) {
      try {
        await jobRef.update({
          status: "failed",
          completedAt: FieldValue.serverTimestamp(),
          error: e.message || String(e)
        });
      } catch (updateError) {
        logger.warn("Failed to update job status to failed", { jobId, error: updateError.message });
      }
    }
    throw e;
  }
});

exports.manualPriceListUpdate = onCall({ 
  region: REGION, 
  cors: true,
  timeoutSeconds: 1800  // 30 хвилин (для обробки великих прайсів)
}, async (req) => {
  isAdminReq(req);
  
  // Validate input data
  const manualUpdateSchema = Joi.object({
    rows: Joi.array().items(schemas.product).optional(),
    data: Joi.array().items(schemas.product).optional(),
    items: Joi.array().items(schemas.product).optional(),
    rawRows: Joi.array().items(Joi.array()).optional(),
    mapping: Joi.object().optional(),
    supplier: schemas.supplier.optional()
  }).or('rows', 'data', 'items', 'rawRows');
  
  const validatedData = validateData(manualUpdateSchema, req.data, "Manual price list update");
  let { rows, data, items, rawRows, mapping, supplier } = validatedData;
  
  rows = Array.isArray(rows) ? rows
       : Array.isArray(data) ? data
       : Array.isArray(items) ? items
       : Array.isArray(rawRows) ? rawRows
       : null;

  if (Array.isArray(rows[0]) && mapping && typeof mapping === "object") {
    const header = rows[0];
    const nameToIndex = Object.fromEntries(header.map((h, i) => [String(h).trim(), i]));
    const toVal = (r, colName) => {
      const idx = nameToIndex[String(colName).trim()];
      return idx != null ? r[idx] : undefined;
    };
    const converted = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      converted.push({
        [mapping.brand || "brand"]: toVal(r, mapping.brand),
        [mapping.id || "id"]: toVal(r, mapping.id),
        [mapping.name || "name"]: toVal(r, mapping.name),
        [mapping.stock || "stock"]: toVal(r, mapping.stock),
        [mapping.price || "price"]: toVal(r, mapping.price),
      });
    }
    rows = converted;
  }

  const sup = supplier?.id ? supplier : { id: supplier?.id || supplier?.name || "manual", name: supplier?.name || "manual" };
  
  // Перевірка обмеження
  const MAX_PRODUCTS = 3000;
  if (rows && rows.length > MAX_PRODUCTS) {
    throw new HttpsError(
      "invalid-argument",
      `Перевищено обмеження: максимум ${MAX_PRODUCTS} товарів на прайс. Знайдено: ${rows.length}. Будь ласка, розбийте прайс на частини.`
    );
  }
  
  const res = await processAndSaveProducts(rows, sup);
  return res;
});

// Функція для перевірки чи потрібно завантажувати прайс за розкладом
function shouldUpdateBySchedule(schedule, lastUpdateTime) {
  const now = new Date();
  const nowKyiv = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
  
  // Перевірка чи не завантажували сьогодні
  if (lastUpdateTime) {
    const lastUpdate = lastUpdateTime.toDate ? lastUpdateTime.toDate() : new Date(lastUpdateTime);
    const lastUpdateKyiv = new Date(lastUpdate.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
    
    // Перевіряємо чи це той самий день
    const todayStr = nowKyiv.toISOString().split('T')[0];
    const lastUpdateStr = lastUpdateKyiv.toISOString().split('T')[0];
    
    if (todayStr === lastUpdateStr) {
      // Вже завантажували сьогодні - пропускаємо
      return false;
    }
  }
  
  // Якщо schedule не вказано - завантажуємо (для сумісності зі старими налаштуваннями)
  if (!schedule) return true;
  
  try {
    // Парсимо cron вираз: "минута година * * дні"
    // Приклад: "30 8 * * 1-5" = щодня 8:30 у будні
    const parts = schedule.trim().split(/\s+/);
    if (parts.length < 5) return true; // Якщо невалідний schedule - завантажуємо
    
    const [minute, hour, , , days] = parts;
    
    // Перевірка дня тижня (0=неділя, 6=субота)
    const dayOfWeek = nowKyiv.getDay();
    let dayMatch = false;
    
    if (days === "*") {
      dayMatch = true;
    } else if (days.includes("-")) {
      const [start, end] = days.split("-").map(Number);
      dayMatch = dayOfWeek >= start && dayOfWeek <= end;
    } else if (days.includes(",")) {
      dayMatch = days.split(",").map(Number).includes(dayOfWeek);
    } else {
      dayMatch = Number(days) === dayOfWeek;
    }
    
    if (!dayMatch) return false;
    
    // Перевірка години та хвилини
    const scheduleHour = Number(hour);
    const scheduleMinute = Number(minute);
    const currentHour = nowKyiv.getHours();
    const currentMinute = nowKyiv.getMinutes();
    
    // Перевіряємо чи поточний час відповідає розкладу (з допуском ±5 хвилин для надійності)
    if (currentHour === scheduleHour && Math.abs(currentMinute - scheduleMinute) <= 5) {
      return true;
    }
    
    return false;
  } catch (e) {
    logger.warn("shouldUpdateBySchedule: parse error", { schedule, error: e.message });
    return true; // При помилці парсингу - завантажуємо для безпеки
  }
}

exports.priceUpdateScheduler = onSchedule(
  {
    region: REGION,
    schedule: "0 7 * * 1-5",   // 07:00 щодня у будні (Europe/Kyiv) - до UkrSklad синхронізації
    timeZone: "Europe/Kyiv",
    maxInstances: 1,  // Обмеження: тільки один екземпляр одночасно
    timeoutSeconds: 540,
    memory: "512MiB"
  },
  async () => {
    try {
      const col = db.collection(`/artifacts/${APP_ID}/public/data/suppliers`);
      const snap = await col.get();
      
      const suppliersToUpdate = [];
      
      // Збираємо всіх постачальників яких потрібно оновити
      for (const d of snap.docs) {
        const { name, priceListUrl, autoUpdate, schedule, lastUpdateTime } = d.data() || {};
        
        // Пропускаємо якщо немає URL або autoUpdate вимкнено
        if (!name || !priceListUrl || autoUpdate === false) continue;
        
        // Перевіряємо чи потрібно завантажувати (перевірка розкладу + чи не завантажували сьогодні)
        if (!shouldUpdateBySchedule(schedule, lastUpdateTime)) {
          continue;
        }
        
        suppliersToUpdate.push({ doc: d, name, priceListUrl, schedule });
      }
      
      if (suppliersToUpdate.length === 0) {
        return;
      }
      
      // Обробляємо всіх постачальників послідовно
      for (const { doc: d, name, priceListUrl } of suppliersToUpdate) {
        try {
          // строгий парсер: "Бренд","id","назва","кількість","Ціна"
          const rows = await parseCsvFromUrlUtf8_STRICT(priceListUrl);
          await processAndSaveProducts(rows, { id: d.id, name });
          
          // Оновлюємо lastUpdateTime
          await d.ref.update({ 
            lastUpdateTime: FieldValue.serverTimestamp() 
          });
        } catch (e) {
          logger.error("priceUpdateScheduler: failed for supplier", { 
            supplier: name, 
            error: e.message
          });
          // Продовжуємо обробку інших постачальників навіть якщо один не вдався
        }
      }
    } catch (e) {
      logger.error("priceUpdateScheduler: error", { error: e.message, stack: e.stack });
    }
  }
);
