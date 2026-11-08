// functions/warehouse.js — Warehouse price list URL management
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const crypto = require("crypto");
const Papa = require("papaparse");
const admin = require("firebase-admin");
const storage = admin.storage();
const {
  db, APP_ID, FieldValue, isAdminReq
} = require("./shared");

const REGION = process.env.FUNCTION_REGION || "europe-central2";

// Функція для отримання товарів складу
async function getWarehouseProducts() {
  const productsCol = db.collection(`/artifacts/${APP_ID}/public/data/products`);
  // Офер «Мій склад» мають лише товари з ukrSkladId (синк ставить його разом з офером;
  // покриття перевірено: 1027 з оферем = 1027 з ukrSkladId). Один where, без складеного індексу.
  const snapshot = await productsCol.where("ukrSkladId", ">", "").get();
  logger.info("getWarehouseProducts: read", { docs: snapshot.size });
  
  const products = [];
  snapshot.forEach(doc => {
    const data = doc.data();
    // Перевіряємо, чи є офер від "Мій склад" з stock > 0
    const offer = data.offers?.find(o => o.supplier === "Мій склад");
    if (offer && (offer.stock || 0) > 0) {
      products.push({
        id: doc.id,
        ...data,
        offer
      });
    }
  });
  
  return products;
}

const VALID_PRICE_TYPES = ["роздріб", "ціна 1", "ціна 2", "ціна 3", "ціна опт"];

// Приводить правила клієнта до єдиного вигляду (як на порталі/в placeOrderV2):
// підтримує старі поля globalDiscount/globalMarkup та discount/markup у правилах.
function normalizeClientRules(data) {
  if (!data) return null;
  let globalAdjustment = 0;
  if (data.globalAdjustment !== undefined) {
    globalAdjustment = Number(data.globalAdjustment || 0);
  } else {
    globalAdjustment = Number(data.globalMarkup || 0) - Number(data.globalDiscount || 0);
  }
  const rules = Array.isArray(data.rules)
    ? data.rules.map((rule) => {
        if (rule.adjustment !== undefined) return rule;
        return { ...rule, adjustment: Number(rule.markup || 0) - Number(rule.discount || 0) };
      })
    : [];
  return { globalAdjustment, rules };
}

/**
 * Завантажує контекст ціноутворення клієнта:
 *  - clientId за clientsAuth.code (приватна колекція, лише бекенд)
 *  - priceType з public clients/{clientId} (як на порталі; fallback "роздріб")
 *  - персональні правила clientPricingRules/{clientId} (можуть бути відсутні)
 * Повертає null лише коли клієнта немає взагалі.
 */
async function loadClientPricingContext(clientCode) {
  const clientAuthCol = db.collection(`/artifacts/${APP_ID}/private/data/clientsAuth`);
  const clientSnap = await clientAuthCol.where("code", "==", String(clientCode).trim()).limit(1).get();

  if (clientSnap.empty) {
    return null;
  }

  const clientId = clientSnap.docs[0].id;
  const base = `/artifacts/${APP_ID}/public/data`;
  const [profileSnap, rulesSnap] = await db.getAll(
    db.doc(`${base}/clients/${clientId}`),
    db.doc(`${base}/clientPricingRules/${clientId}`)
  );

  const fromProfile = profileSnap.exists ? profileSnap.data()?.priceType : null;
  const priceType = VALID_PRICE_TYPES.includes(fromProfile) ? fromProfile : "роздріб";

  return {
    clientId,
    priceType,
    rules: rulesSnap.exists ? normalizeClientRules(rulesSnap.data()) : null,
  };
}

// Функція для пошуку правила в масиві правил
function findRule(pricingRules, type, brand, id, supplier) {
  if (!pricingRules || !pricingRules.rules || !Array.isArray(pricingRules.rules)) {
    return null;
  }
  
  for (const rule of pricingRules.rules) {
    if (rule.type === "product" && rule.brand === brand && rule.id === id) {
      return rule;
    }
    if (rule.type === "brand" && rule.brand === brand) {
      return rule;
    }
    if (rule.type === "supplier" && rule.supplier === supplier) {
      return rule;
    }
  }
  return null;
}

// Функція для розрахунку ціни з правилами клієнта
// Повертає об'єкт: { price, priceGroup, defaultPriceGroup, hasAdjustment }
function calculatePriceWithRules(product, offer, pricingRules, defaultPriceGroup) {
  if (!offer || !offer.publicPrices) {
    return {
      price: 0,
      priceGroup: defaultPriceGroup || "роздріб",
      defaultPriceGroup: defaultPriceGroup || "роздріб",
      hasAdjustment: false
    };
  }
  
  let priceGroup = defaultPriceGroup || "роздріб";
  let adjustment = 0;
  let hasRuleAdjustment = false;
  
  if (pricingRules && pricingRules.rules) {
    const productRule = findRule(pricingRules, "product", product.brand, product.id, null);
    if (productRule) {
      priceGroup = productRule.priceGroup;
      adjustment = Number(productRule.adjustment || 0);
      hasRuleAdjustment = adjustment !== 0;
    } else {
      const brandRule = findRule(pricingRules, "brand", product.brand, null, null);
      if (brandRule) {
        priceGroup = brandRule.priceGroup;
        adjustment = Number(brandRule.adjustment || 0);
        hasRuleAdjustment = adjustment !== 0;
      } else {
        const supplierRule = findRule(pricingRules, "supplier", null, null, offer.supplier);
        if (supplierRule) {
          priceGroup = supplierRule.priceGroup;
          adjustment = Number(supplierRule.adjustment || 0);
          hasRuleAdjustment = adjustment !== 0;
        }
      }
    }
  }
  
  let basePrice = offer.publicPrices[priceGroup];
  if (!basePrice || basePrice <= 0) {
    basePrice = offer.publicPrices.роздріб;
    if (!basePrice || basePrice <= 0) {
      return {
        price: 0,
        priceGroup: defaultPriceGroup || "роздріб",
        defaultPriceGroup: defaultPriceGroup || "роздріб",
        hasAdjustment: false
      };
    }
  }
  
  let price = basePrice;
  // Застосовуємо персональний adjustment (може бути негативним для знижки або позитивним для націнки)
  price = price * (1 + adjustment/100);
  
  // Перевіряємо загальний adjustment
  let hasGlobalAdjustment = false;
  if (pricingRules) {
    const globalAdjustment = Number(pricingRules.globalAdjustment || 0);
    if (globalAdjustment !== 0) {
      price = price * (1 + globalAdjustment/100);
      hasGlobalAdjustment = true;
    }
  }
  
  const finalPrice = Math.ceil(price * 100) / 100;
  const hasAdjustment = hasRuleAdjustment || hasGlobalAdjustment;
  
  return {
    price: finalPrice,
    priceGroup: priceGroup,
    defaultPriceGroup: defaultPriceGroup || "роздріб",
    hasAdjustment: hasAdjustment
  };
}

// Функція для округлення ціни
function roundPrice(price) {
  return Math.round(price * 100) / 100;
}

// Функція для генерації CSV з продуктів
const WAREHOUSE_CSV_HEADER = ["brand", "id", "name", "stock", "price"];

// clientContext: { priceType, rules } з loadClientPricingContext (для режиму «ціни клієнта»)
async function generateCsvFromProducts(products, priceType, clientCode, clientContext) {
  const rows = [WAREHOUSE_CSV_HEADER];
  
  for (const product of products) {
    const offer = product.offers?.find(o => o.supplier === "Мій склад");
    if (!offer || !offer.publicPrices) continue;
    
    const stock = offer.stock || 0;
    if (stock <= 0) continue;
    
    let price = 0;
    if (clientCode && clientContext) {
      // Як на порталі: старт з priceType клієнта, зверху його персональні правила (якщо є)
      const priceResult = calculatePriceWithRules(
        { brand: product.brand, id: product.id },
        offer,
        clientContext.rules,
        clientContext.priceType
      );
      price = priceResult.price;
    } else if (priceType) {
      // Використовуємо стандартну ціну
      price = Number(offer.publicPrices[priceType]) || 0;
    }
    
    if (price <= 0) continue; // Пропускаємо товари без ціни
    
    rows.push([
      product.brand || "",
      product.id || "",
      product.name || "",
      String(stock),
      String(roundPrice(price))
    ]);
  }
  
  // Генеруємо CSV з усіма полями в лапках
  const csv = Papa.unparse(rows, {
    header: false,
    delimiter: ",",
    quoteChar: '"',
    escapeChar: '"',
    quotes: true, // Обгортати всі поля в лапки
    quoteHeaders: true
  });
  
  return csv;
}

/**
 * generateWarehousePriceListUrl - згенерувати URL для прайс-листу складу
 */
exports.generateWarehousePriceListUrl = onCall({ region: REGION, cors: true }, async (request) => {
  if (!isAdminReq(request)) throw new HttpsError("permission-denied", "Потрібен адмін-доступ.");
  
  const { priceType, clientCode } = request.data || {};
  
  // Валідація
  if (!priceType && !clientCode) {
    throw new HttpsError("invalid-argument", "Потрібен priceType або clientCode.");
  }
  
  if (priceType && clientCode) {
    throw new HttpsError("invalid-argument", "Можна вказати тільки priceType або clientCode, не обидва.");
  }
  
  // Валідація клієнта, якщо вказано
  let clientContext = null;
  if (clientCode) {
    if (typeof clientCode !== "string" || clientCode.trim().length > 128) {
      throw new HttpsError("invalid-argument", "Некоректний clientCode.");
    }
    clientContext = await loadClientPricingContext(clientCode);
    if (!clientContext) {
      throw new HttpsError("not-found", `Клієнт з кодом "${clientCode.trim()}" не знайдено.`);
    }
  }
  
  // Генерація унікального токену
  const token = crypto.randomBytes(16).toString("hex");
  const fileName = `warehouse_price_list_${token}.csv`;
  
  // Отримуємо товари складу
  const products = await getWarehouseProducts();
  
  // Генеруємо CSV
  const csvContent = await generateCsvFromProducts(products, priceType, clientCode, clientContext);
  
  // Зберігаємо в Cloud Storage
  const bucket = storage.bucket();
  const file = bucket.file(fileName);
  
  await file.save(csvContent, {
    metadata: {
      contentType: "text/csv; charset=utf-8",
      cacheControl: "public, max-age=3600"
    }
  });
  
  // Робимо файл публічним
  await file.makePublic();
  
  // Публічний URL
  const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
  
  // Збереження в Firestore
  const urlData = {
    token,
    url: publicUrl,
    filePath: fileName,
    isActive: true,
    createdAt: FieldValue.serverTimestamp(),
    lastUpdated: FieldValue.serverTimestamp(),
  };
  
  if (priceType) {
    urlData.priceType = priceType;
  } else {
    urlData.clientCode = String(clientCode).trim();
  }
  
  await db.collection(`/artifacts/${APP_ID}/public/data/warehousePriceListUrls`).add(urlData);
  
  logger.info(`Warehouse price list URL generated: ${publicUrl} (${priceType || `client: ${clientCode}`})`);
  
  return { success: true, url: publicUrl, token };
});

/**
 * deleteWarehousePriceListUrl - видалити URL прайс-листу складу
 */
exports.deleteWarehousePriceListUrl = onCall({ region: REGION, cors: true }, async (request) => {
  if (!isAdminReq(request)) throw new HttpsError("permission-denied", "Потрібен адмін-доступ.");
  
  const { token } = request.data || {};
  
  if (!token || typeof token !== "string") {
    throw new HttpsError("invalid-argument", "Потрібен token.");
  }
  
  // Пошук URL за токеном
  const urlsCol = db.collection(`/artifacts/${APP_ID}/public/data/warehousePriceListUrls`);
  const snap = await urlsCol.where("token", "==", token).limit(1).get();
  
  if (snap.empty) {
    throw new HttpsError("not-found", "URL з таким токеном не знайдено.");
  }
  
  const docData = snap.docs[0].data();
  const filePath = docData.filePath;
  
  // Видаляємо файл з Cloud Storage
  if (filePath) {
    try {
      const bucket = storage.bucket();
      const file = bucket.file(filePath);
      await file.delete();
    } catch (e) {
      logger.warn(`Failed to delete file ${filePath}:`, e);
    }
  }
  
  // Видаляємо запис з Firestore
  await snap.docs[0].ref.delete();
  
  logger.info(`Warehouse price list URL deleted: ${token}`);
  
  return { success: true, message: "URL видалено." };
});

/**
 * updateWarehousePriceList - оновити прайс-лист складу (scheduled, щодня 06:00)
 */
exports.updateWarehousePriceList = onSchedule(
  {
    region: REGION,
    schedule: "0 6 * * *", // Щодня о 06:00
    timeZone: "Europe/Kyiv"
  },
  async () => {
    try {
      const urlsCol = db.collection(`/artifacts/${APP_ID}/public/data/warehousePriceListUrls`);
      const activeUrls = await urlsCol.where("isActive", "==", true).get();
      
      if (activeUrls.empty) {
        logger.info("No active warehouse price list URLs to update");
        return;
      }
      
      // Отримуємо товари складу один раз
      const products = await getWarehouseProducts();
      
      const bucket = storage.bucket();
      
      // Оновлюємо кожен URL
      for (const doc of activeUrls.docs) {
        try {
          const urlData = doc.data();
          const { priceType, clientCode, filePath, token } = urlData;
          
          if (!filePath) {
            logger.warn(`Skipping URL ${token}: no filePath`);
            continue;
          }
          
          // Завантажуємо контекст цін клієнта (priceType + правила), якщо потрібно
          let clientContext = null;
          if (clientCode) {
            clientContext = await loadClientPricingContext(clientCode);
            if (!clientContext) {
              logger.warn(`Client ${clientCode} not found, skipping URL ${token}`);
              continue;
            }
          }
          
          // Генеруємо новий CSV
          const csvContent = await generateCsvFromProducts(products, priceType, clientCode, clientContext);
          
          // Оновлюємо файл в Cloud Storage
          const file = bucket.file(filePath);
          await file.save(csvContent, {
            metadata: {
              contentType: "text/csv; charset=utf-8",
              cacheControl: "public, max-age=3600"
            }
          });
          
          // Оновлюємо timestamp в Firestore
          await doc.ref.update({
            lastUpdated: FieldValue.serverTimestamp()
          });
          
          logger.info(`Updated warehouse price list: ${token}`);
        } catch (e) {
          logger.error(`Error updating warehouse price list ${doc.id}:`, e);
        }
      }
      
      logger.info(`Updated ${activeUrls.size} warehouse price list URLs`);
    } catch (e) {
      logger.error("Error in updateWarehousePriceList:", e);
    }
  }
);
