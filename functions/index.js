
/**
 * Project ROZA — Cloud Functions (entry, full)
 * Region: europe-central2
 * App ID: embryo-project
 *
 * Exports:
 *  - syncAdminClaim
 *  - placeOrderV2 (optimized: pricingRules cache + batch get)
 *  - test
 *  - deleteAllProducts
 *  - everything from: auth.js, suppliers.js, ukrsklad.js, settlements.js
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

// ⚠️ ІНІЦІАЛІЗАЦІЯ ПЕРЕД ВСІМА require інших модулів (щоб shared.js, suppliers.js тощо могли використовувати getFirestore)
if (!admin.apps.length) admin.initializeApp();

const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const DOCS_FOLDER_ID = process.env.DOCS_FOLDER_ID || "1ydQGtuQ4l5vHK0fbidGekKmsysWpBup_";

const db = getFirestore();
const auth = getAuth();

const REGION = process.env.FUNCTION_REGION || "europe-central2";
const APP_ID = process.env.APP_ID || "embryo-project";
if (!process.env.APP_ID) {
  logger.warn("APP_ID environment variable is not set. Using fallback 'embryo-project'. This should be set in production.");
}

// Rate limiting configuration
const RATE_LIMIT_CONFIG = {
  maxInstances: 100,
  concurrency: 80,
  minInstances: 0
};

// Rate limiting для публічних функцій (реєстрація, відновлення пароля)
const PUBLIC_RATE_LIMIT = {
  maxInstances: 10,
  concurrency: 5,
  minInstances: 0
};
const SETTLEMENTS_FOLDER_ID = "1ak0Ut14CDJSJB7Gy37k6EYs3HkigIk0C";

/* --------------------------- small helpers --------------------------- */
const str = (x, max = 400) => (x == null ? "" : String(x)).slice(0, max);

const path = require("path");
const { google } = require("googleapis");
const Papa = require("papaparse");
const iconv = require("iconv-lite");

function makeDocKey({ type, docNumber, clientCode, currency }) {
  return `${String(type).trim()}__${String(docNumber).trim().toUpperCase()}__${String(clientCode).trim()}__${String(currency).trim().toUpperCase()}`;
}

function parseFilename(name) {
  const base = path.basename(name || "");
  // Формат: type_docNumber_clientCode_currency.csv
  // Приклад: 12_223_471_EUR.csv
  // 12 - тип документу
  // 223 - номер документу
  // 471 - номер клієнта
  // EUR - валюта
  const m = base.match(/^(\d+)_([^_]+)_(\d+)_([A-Z]{3})\.csv$/i);
  if (!m) return null;
  return {
    type: Number(m[1]),
    docNumber: m[2],
    clientCode: m[3],
    currency: m[4].toUpperCase()
  };
}
async function mkDrive() {
  const gauth = new google.auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/drive.readonly"] });
  return google.drive({ version: "v3", auth: await gauth.getClient() });
}
function parseCsvBuffer(buf) {
  let txt; try { txt = iconv.decode(buf, "cp1251"); } catch { /* ignore */ }
  if (!txt || txt.split("\n").length < 2) txt = buf.toString("utf8");
  let parsed = Papa.parse(txt, { header: true, skipEmptyLines: true, delimiter: ";" });
  if (parsed.meta?.fields?.length <= 1) parsed = Papa.parse(txt, { header: true, skipEmptyLines: true, delimiter: "," });
  const rows = (parsed.data || []).filter(Boolean);
  if (!rows.length) throw new Error("Документ порожній або не розпізнаний");
  return rows;
}



/* ------------------------------ exports ------------------------------ */
/**
 * syncAdminClaim — ensure current authed user has admin custom claim if whitelisted.
 * Allowlist sources:
 *  - Env: ADMIN_ALLOWLIST = "email1@example.com,email2@example.com"
 *  - Firestore: /artifacts/<APP_ID>/public/meta/adminAllowlist/<email>
 */
exports.syncAdminClaim = onCall({ region: REGION, cors: true }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Потрібно увійти.");
  const record = await auth.getUser(request.auth.uid);
  const email = (record.email || "").toLowerCase();
  if (!email) throw new HttpsError("failed-precondition", "В акаунті нема email.");
  const envList = (process.env.ADMIN_ALLOWLIST || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  let allowed = envList.includes(email);
  if (!allowed) {
    const ref = db.doc(`/artifacts/${APP_ID}/public/meta/adminAllowlist/${email}`);
    const snap = await ref.get();
    allowed = snap.exists;
  }
  if (!allowed) return { admin: false, reason: "not_in_allowlist" };
  const claims = record.customClaims || {};
  if (claims.admin === true) return { admin: true, already: true };
  await auth.setCustomUserClaims(record.uid, { ...claims, admin: true });
  await db.doc(`/artifacts/${APP_ID}/public/meta/adminAllowlist/${email}`).set(
    { uid: record.uid, updatedAt: FieldValue.serverTimestamp() },
    { merge: true }
  );
  return { admin: true };
});

/**
 * checkAdminStatus - перевірити статус адміністратора для email
 * Використовується для діагностики проблем з доступом
 */
exports.checkAdminStatus = onCall({ region: REGION, cors: true }, async (request) => {
  const { email } = request.data || {};
  if (!email) {
    throw new HttpsError("invalid-argument", "Email обов'язковий.");
  }
  
  const emailLower = String(email).trim().toLowerCase();
  const result = {
    email: emailLower,
    inEnvAllowlist: false,
    inFirestoreAllowlist: false,
    userExists: false,
    uid: null,
    hasAdminClaim: false,
    status: "unknown"
  };
  
  // Перевірка env allowlist
  const envList = (process.env.ADMIN_ALLOWLIST || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  result.inEnvAllowlist = envList.includes(emailLower);
  
  // Перевірка Firestore allowlist
  const ref = db.doc(`/artifacts/${APP_ID}/public/meta/adminAllowlist/${emailLower}`);
  const snap = await ref.get();
  result.inFirestoreAllowlist = snap.exists;
  if (snap.exists) {
    const data = snap.data();
    result.uid = data.uid || null;
  }
  
  // Перевірка чи існує користувач в Firebase Auth
  try {
    const userRecord = await auth.getUserByEmail(emailLower);
    result.userExists = true;
    result.uid = userRecord.uid;
    
    // Перевірка custom claims
    const claims = userRecord.customClaims || {};
    result.hasAdminClaim = claims.admin === true;
  } catch (e) {
    if (e.code === "auth/user-not-found") {
      result.userExists = false;
    } else {
      result.error = e.message;
    }
  }
  
  // Визначення статусу
  if (!result.userExists) {
    result.status = "user_not_found";
    result.message = "Користувач не існує в Firebase Authentication. Потрібно створити користувача.";
  } else if (!result.inEnvAllowlist && !result.inFirestoreAllowlist) {
    result.status = "not_in_allowlist";
    result.message = "Email не в списку адміністраторів. Потрібно додати в allowlist.";
  } else if (!result.hasAdminClaim) {
    result.status = "no_admin_claim";
    result.message = "Email в allowlist, але admin claim не встановлено. Потрібно викликати syncAdminClaim після входу.";
  } else {
    result.status = "admin";
    result.message = "Користувач має права адміністратора.";
  }
  
  return result;
});

/**
 * clearMasterDataCache - очистити кеш майстер-даних
 * Потрібен адмін-доступ
 */
exports.clearMasterDataCache = onCall({ region: REGION, cors: true }, async (request) => {
  if (!request.auth?.token?.admin) {
    throw new HttpsError("permission-denied", "Потрібен адмін-доступ.");
  }

  const { clearMasterDataCache } = require("./shared");
  clearMasterDataCache();

  logger.info("Master data cache cleared by admin", { uid: request.auth.uid });

  return {
    success: true,
    message: "Кеш майстер-даних очищено. Наступний запит завантажить оновлені дані."
  };
});

/**
 * resetAdminPassword - скинути пароль адміністратора
 * Працює без автентифікації для першого адміна або з адмін-доступом
 */
exports.resetAdminPassword = onCall({ region: REGION, cors: true }, async (request) => {
  const { email, newPassword } = request.data || {};
  if (!email || !newPassword) {
    throw new HttpsError("invalid-argument", "Email та новий пароль обов'язкові.");
  }
  
  if (newPassword.length < 6) {
    throw new HttpsError("invalid-argument", "Пароль має бути не менше 6 символів.");
  }
  
  const emailLower = String(email).trim().toLowerCase();
  
  // Перевірка: якщо вже є адміни, потрібен адмін-доступ
  const adminAllowlistRef = db.collection(`/artifacts/${APP_ID}/public/meta/adminAllowlist`);
  const existingAdmins = await adminAllowlistRef.limit(1).get();
  
  if (!existingAdmins.empty) {
    // Якщо вже є адміни - потрібен адмін-доступ
    if (!request.auth?.token?.admin) {
      throw new HttpsError("permission-denied", "Потрібен адмін-доступ для скидання паролю.");
    }
  }
  
  // Перевірка чи email в allowlist
  const allowlistRef = db.doc(`/artifacts/${APP_ID}/public/meta/adminAllowlist/${emailLower}`);
  const allowlistSnap = await allowlistRef.get();
  if (!allowlistSnap.exists) {
    throw new HttpsError("not-found", "Email не знайдено в списку адміністраторів.");
  }
  
  // Знаходимо користувача
  let userRecord;
  try {
    userRecord = await auth.getUserByEmail(emailLower);
  } catch (e) {
    if (e.code === "auth/user-not-found") {
      throw new HttpsError("not-found", "Користувач не знайдено в Firebase Authentication.");
    }
    throw new HttpsError("internal", `Помилка пошуку користувача: ${e.message}`);
  }
  
  // Оновлюємо пароль
  await auth.updateUser(userRecord.uid, {
    password: String(newPassword),
  });
  
  logger.info(`Password reset for admin: ${emailLower} (${userRecord.uid})`);
  
  return { 
    success: true, 
    message: `Пароль для ${emailLower} успішно скинуто`,
    uid: userRecord.uid 
  };
});

/* ------------------------- placeOrderV2 (optimized) ------------------------ */
/**
 * Input:
 *  - items: [{ docId? , supplier, brand, id, qty }]
 *  - client: (optional client meta)
 *  - priceCategory: "роздріб" | "ціна 1" | "ціна 2" | "ціна 3" | "ціна опт"
 *  - note: string
 *
 * Behavior:
 *  - Fetch all product docs with getAll (minimize reads)
 *  - Prefer product.publicPrices[category]
 *  - If missing — compute from pricingRules (cached per request, 1 read per supplier)
 */
const VALID_CATEGORIES = ["роздріб","ціна 1","ціна 2","ціна 3","ціна опт"];

function normalizeSupplierId(x) {
  return String(x || "").trim().toLowerCase();
}
function pctToFactor(p) {
  const n = Number(p);
  if (!Number.isFinite(n)) return 1;
  return 1 + n / 100;
}
function pick(obj, arr) {
  for (const k of arr) {
    if (obj && obj[k] != null && String(obj[k]).trim() !== "") return obj[k];
  }
  return undefined;
}
function parseRulesObject(src) {
  if (!src) return null;
  const flatUA = {
    retail: Number(pick(src, ["роздріб", "retailPercent"])),
    p1:     Number(pick(src, ["ціна 1","price1Percent","p1"])),
    p2:     Number(pick(src, ["ціна 2","price2Percent","p2"])),
    p3:     Number(pick(src, ["ціна 3","price3Percent","p3"])),
    opt:    Number(pick(src, ["ціна опт","wholesalePercent","optPercent"])),
  };
  if ([flatUA.retail,flatUA.p1,flatUA.p2,flatUA.p3,flatUA.opt].some(x => Number.isFinite(x))) return flatUA;

  const nested = src.rules || src.markups || src.pricing;
  if (nested) {
    return {
      retail: Number(pick(nested, ["роздріб","retail"])),
      p1:     Number(pick(nested, ["ціна 1","price1","p1"])),
      p2:     Number(pick(nested, ["ціна 2","price2","p2"])),
      p3:     Number(pick(nested, ["ціна 3","price3","p3"])),
      opt:    Number(pick(nested, ["ціна опт","wholesale","opt"])),
    };
  }
  return null;
}
async function makeRulesLoader() {
  const cache = new Map(); // key = supplierId (normalized)
  const coll = db.collection(`/artifacts/${APP_ID}/public/data/pricingRules`);
  return async function getRulesFor(supplierIdRaw) {
    const key = normalizeSupplierId(supplierIdRaw);
    if (!key) return { retail:0, p1:0, p2:0, p3:0, opt:0 };
    if (cache.has(key)) return cache.get(key);
    // 1) try doc with id == supplierId
    let snap = await coll.doc(key).get();
    let obj = snap.exists ? snap.data() : null;
    // 2) otherwise query by supplierId field (random doc id case)
    if (!obj) {
      const q = await coll.where("supplierId", "==", key).limit(1).get();
      if (!q.empty) obj = q.docs[0].data();
    }
    // 3) fallback: try suppliers/{id}
    if (!obj) {
      const sSnap = await db.doc(`/artifacts/${APP_ID}/public/data/suppliers/${key}`).get();
      if (sSnap.exists) obj = sSnap.data();
    }
    const rules = parseRulesObject(obj) || { retail:0, p1:0, p2:0, p3:0, opt:0 };
    cache.set(key, rules);
    return rules;
  };
}
function computePriceFromRules(purchase, rules, category) {
  const factors = {
    "роздріб": pctToFactor(rules.retail),
    "ціна 1": pctToFactor(rules.p1),
    "ціна 2": pctToFactor(rules.p2),
    "ціна 3": pctToFactor(rules.p3),
    "ціна опт": pctToFactor(rules.opt),
  };
  const f = factors[category] || 1;
  const v = Math.round((Number(purchase||0) * f) * 100) / 100;
  return v;
}

exports.placeOrderV2 = onCall({ 
  region: REGION, 
  cors: true,
  maxInstances: RATE_LIMIT_CONFIG.maxInstances,
  concurrency: RATE_LIMIT_CONFIG.concurrency
}, async (req) => {
  const uid = req.auth?.uid || null;
  if (!uid) throw new HttpsError("unauthenticated", "Потрібна авторизація.");
  const { items = [], clientRequestId, clientName, clientPhone, clientEmail, priceCategory, note } = req.data || {};
  if (!Array.isArray(items) || !items.length) {
    throw new HttpsError("invalid-argument", "Кошик порожній або некоректний.");
  }
  // Визначаємо категорію ціни:
  // 1) якщо фронт явно передав валідний priceCategory → використовуємо його;
  // 2) інакше намагаємося взяти priceType з профілю клієнта;
  // 3) fallback → "ціна 1".
  let category = VALID_CATEGORIES.includes(priceCategory) ? priceCategory : null;
  if (!category) {
    try {
      const clientRef = db.doc(`/artifacts/${APP_ID}/public/data/clients/${uid}`);
      const clientSnap = await clientRef.get();
      if (clientSnap.exists) {
        const clientData = clientSnap.data();
        const fromProfile = clientData && clientData.priceType;
        category = VALID_CATEGORIES.includes(fromProfile) ? fromProfile : "ціна 1";
      } else {
        category = "ціна 1";
      }
    } catch (e) {
      logger.warn("placeOrderV2: failed to load client priceType, using fallback", { uid, error: String(e && e.message || e) });
      category = "ціна 1";
    }
  }

  // Idempotency by clientRequestId
  const lockId = str(clientRequestId || "", 128);
  if (lockId) {
    const dup = await db.collection(`/artifacts/${APP_ID}/public/data/orders`)
      .where("clientRequestId", "==", lockId).limit(1).get();
    if (!dup.empty) {
      const d = dup.docs[0];
      return { orderId: d.id, orderNumber: d.get("orderNumber") || null, reused: true };
    }
  }

  // Prepare product queries (по brand+id, без supplier)
  const productQueries = [];
  const byIndex = [];
  const { normalizeBrand, normalizeArticle } = require("./shared");
  
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    let docId = it.docId;
    let supplier = String(it.supplier || "").trim();
    
    if (!docId) {
      const brand = String(it.brand || "").trim();
      const id = String(it.id || "").trim().toUpperCase();
      if (!brand || !id) {
        throw new HttpsError("invalid-argument", "item без docId має містити brand, id.");
      }
      // НОВИЙ docId (без supplier)
      docId = `${brand}-${id}`.replace(/\s+/g,"-").replace(/[^\w.-]/g,"_");
    }
    
    if (!supplier) {
      throw new HttpsError("invalid-argument", "item має містити supplier для вибору пропозиції.");
    }
    
    productQueries.push({
      docId,
      supplier,
      brand: it.brand,
      id: it.id
    });
    byIndex.push({ i, docId, supplier, qty: Math.max(1, Number(it.qty ?? it.quantity ?? 1)) });
  }

  // Batch get products
  const prodRefs = productQueries.map(q => db.doc(`/artifacts/${APP_ID}/public/data/products/${q.docId}`));
  const snaps = await db.getAll(...prodRefs);
  const getRulesFor = await makeRulesLoader();

  // Завантажуємо правила ціноутворення клієнта
  let clientPricingRules = null;
  try {
    const rulesRef = db.doc(`/artifacts/${APP_ID}/public/data/clientPricingRules/${uid}`);
    const rulesSnap = await rulesRef.get();
    if (rulesSnap.exists) {
      const data = rulesSnap.data();
      // Міграція: якщо є старі поля, конвертуємо
      let globalAdjustment = 0;
      if (data.globalAdjustment !== undefined) {
        globalAdjustment = Number(data.globalAdjustment || 0);
      } else {
        const discount = Number(data.globalDiscount || 0);
        const markup = Number(data.globalMarkup || 0);
        globalAdjustment = markup - discount;
      }
      
      const rules = Array.isArray(data.rules) ? data.rules.map(rule => {
        if (rule.adjustment !== undefined) return rule;
        const discount = Number(rule.discount || 0);
        const markup = Number(rule.markup || 0);
        return { ...rule, adjustment: markup - discount };
      }) : [];
      
      clientPricingRules = {
        globalAdjustment,
        rules
      };
    }
  } catch (e) {
    logger.warn("Failed to load client pricing rules", e);
  }

  // Helper функція для знаходження правила
  const findRule = (rules, type, brand, id, supplier) => {
    if (!rules || !rules.rules || !Array.isArray(rules.rules)) return null;
    for (const rule of rules.rules) {
      if (rule.type === "product" && type === "product" && rule.brand === brand && rule.id === id) return rule;
      if (rule.type === "brand" && type === "brand" && rule.brand === brand) return rule;
      if (rule.type === "supplier" && type === "supplier" && rule.supplier === supplier) return rule;
    }
    return null;
  };

  // Helper функція для обчислення ціни з правилами
  // Повертає об'єкт: { price, priceGroup, defaultPriceGroup, hasAdjustment }
  const calculatePriceWithRules = (product, offer, defaultPriceGroup) => {
    if (!offer || !offer.publicPrices) {
      return {
        price: 0,
        priceGroup: defaultPriceGroup || "роздріб",
        defaultPriceGroup: defaultPriceGroup || "роздріб",
        hasAdjustment: false
      };
    }

    // Стартуємо з defaultPriceGroup (наприклад, client.priceType або переданий priceCategory)
    let priceGroup = defaultPriceGroup || "роздріб";
    let adjustment = 0;
    let hasRuleAdjustment = false;
    
    if (clientPricingRules && clientPricingRules.rules) {
      const productRule = findRule(clientPricingRules, "product", product.brand, product.id, null);
      if (productRule) {
        priceGroup = productRule.priceGroup;
        adjustment = Number(productRule.adjustment || 0);
        hasRuleAdjustment = adjustment !== 0;
      } else {
        const brandRule = findRule(clientPricingRules, "brand", product.brand, null, null);
        if (brandRule) {
          priceGroup = brandRule.priceGroup;
          adjustment = Number(brandRule.adjustment || 0);
          hasRuleAdjustment = adjustment !== 0;
        } else {
          const supplierRule = findRule(clientPricingRules, "supplier", null, null, offer.supplier);
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
    if (clientPricingRules) {
      const globalAdjustment = Number(clientPricingRules.globalAdjustment || 0);
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
  };

  const orderItems = [];
  let total = 0;

  for (let k = 0; k < snaps.length; k++) {
    const snap = snaps[k];
    const meta = byIndex[k];
    if (!snap.exists) {
      throw new HttpsError("not-found", `Товар не знайдено: ${meta.docId}`);
    }
    const p = snap.data();
    const qty = meta.qty;
    const supplierNorm = String(meta.supplier || "").trim();

    // Знаходимо пропозицію від постачальника
    const offer = p.offers && Array.isArray(p.offers) 
      ? p.offers.find(o => o.supplier === supplierNorm)
      : null;
    
    if (!offer) {
      throw new HttpsError("not-found", `Пропозиція від постачальника "${supplierNorm}" не знайдена для товару ${meta.docId}`);
    }

    // Обчислюємо ціну з урахуванням правил клієнта
    let unitPrice = 0;
    let priceGroup = category;
    let defaultPriceGroup = category;
    let hasAdjustment = false;
    
    if (clientPricingRules) {
      const priceBefore = offer?.publicPrices?.[category] || offer?.publicPrices?.["роздріб"] || 0;
      const priceResult = calculatePriceWithRules(
        { brand: p.brand, id: p.id },
        offer,
        category
      );
      unitPrice = priceResult.price;
      priceGroup = priceResult.priceGroup;
      defaultPriceGroup = priceResult.defaultPriceGroup;
      hasAdjustment = priceResult.hasAdjustment;
      
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/43d36951-e2f3-464b-a260-765b59298148',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'index.js:541',message:'placeOrderV2: price calculation with client rules',data:{docId:meta.docId,category,priceBefore,priceAfter:unitPrice,hasClientRules:!!clientPricingRules},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
      // #endregion
    } else {
      // Стара логіка (fallback)
      unitPrice = Number(offer?.publicPrices?.[category]);
      if (!Number.isFinite(unitPrice)) {
        const rules = await getRulesFor(supplierNorm);
        const retail = Number(offer?.publicPrices?.["роздріб"]);
        if (Number.isFinite(retail) && category !== "роздріб") {
          const fRetail = 1 + (rules.retail||0)/100;
          const fCat = 1 + ({
            "ціна 1": rules.p1,
            "ціна 2": rules.p2,
            "ціна 3": rules.p3,
            "ціна опт": rules.opt,
          }[category] || 0)/100;
          unitPrice = Math.round(retail * (fCat / (fRetail || 1)) * 100) / 100;
        } else {
          unitPrice = retail ?? 0;
        }
      }
      
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/43d36951-e2f3-464b-a260-765b59298148',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'index.js:566',message:'placeOrderV2: price calculation fallback',data:{docId:meta.docId,category,unitPrice},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
      // #endregion
    }

    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      throw new HttpsError("failed-precondition", `Нема валідної ціни для ${meta.docId} (${category}).`);
    }

    const lineTotal = Math.round(unitPrice * qty * 100) / 100;
    total = Math.round((total + lineTotal) * 100) / 100;

    orderItems.push({
      id: p.id,
      docId: snap.id,
      name: str(p.name, 600),
      brand: p.brand,
      supplier: supplierNorm,
      price: unitPrice,
      quantity: qty,
      lineStatus: "Очікує підтвердження",
      quantityConfirmed: qty,
      quantityCancelled: 0,
      // Метадані про цінову політику
      priceGroup: priceGroup,
      defaultPriceGroup: defaultPriceGroup,
      hasAdjustment: hasAdjustment,
    });
  }

  // Order number (transactional counter)
  const counterRef = db.doc(`/artifacts/${APP_ID}/public/meta/counters/counters`);
  let orderNumber = null;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    const next = (snap.exists ? snap.data().orderSeq || 0 : 0) + 1;
    tx.set(counterRef, { orderSeq: next }, { merge: true });
    orderNumber = next;
  });

  // Create order
  const ref = db.collection(`/artifacts/${APP_ID}/public/data/orders`).doc();
  await ref.set({
    clientId: uid,
    items: orderItems,
    total: total,
    status: "Нове",
    orderNumber,
    archived: false,
    clientRequestId: lockId || null,
    clientName: str(clientName, 200),
    clientPhone: str(clientPhone, 50),
    clientEmail: str(clientEmail, 200),
    note: str(note, 2000),
    createdAt: FieldValue.serverTimestamp(),
    source: "portal-v2",
  });

  // Update order counts (status is "Нове")
  const orderCountsRef = db.doc(`/artifacts/${APP_ID}/public/meta/counters/orderCounts`);
  try {
    await db.runTransaction(async (tx) => {
      const countsSnap = await tx.get(orderCountsRef);
      const current = countsSnap.exists ? countsSnap.data() : { new: 0, partial: 0 };
      tx.set(orderCountsRef, {
        new: (current.new || 0) + 1,
        partial: current.partial || 0,
        lastUpdated: FieldValue.serverTimestamp(),
      }, { merge: true });
    });
  } catch (e) {
    logger.warn("Failed to update order counts", e);
    // Не блокуємо створення замовлення при помилці підрахунку
  }

  logger.info("placeOrderV2 created", { orderId: ref.id, items: items.length, total });
  return { orderId: ref.id, orderNumber, total };
});

const { onSchedule } = require("firebase-functions/v2/scheduler");

// Archive completed orders older than 15 days
exports.archiveOldCompletedOrders = onSchedule(
  {
    schedule: "0 3 * * *", // Every day at 03:00
    timeZone: "Europe/Kyiv",
    region: REGION,
  },
  async () => {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - 15);
      
      const ordersRef = db.collection(`/artifacts/${APP_ID}/public/data/orders`);
      const oldCompleted = await ordersRef
        .where("status", "==", "Завершено")
        .get();
      
      const batches = [];
      let currentBatch = db.batch();
      let batchCount = 0;
      let totalCount = 0;
      
      for (const docSnap of oldCompleted.docs) {
        const data = docSnap.data();
        // Skip if already archived
        if (data.archived === true) continue;
        
        const createdAt = data.createdAt?.toDate?.() || data.createdAt;
        if (createdAt && createdAt < cutoffDate) {
          currentBatch.update(docSnap.ref, { archived: true });
          batchCount++;
          totalCount++;
          
          if (batchCount >= 500) {
            batches.push(currentBatch);
            currentBatch = db.batch();
            batchCount = 0;
          }
        }
      }
      
      if (batchCount > 0) {
        batches.push(currentBatch);
      }
      
      for (const b of batches) {
        await b.commit();
      }
      
      logger.info(`Archived ${totalCount} completed orders older than 15 days`);
    } catch (e) {
      logger.error("archiveOldCompletedOrders error", { error: e.message, stack: e.stack });
    }
  }
);

exports.indexDocsFromDrive = onSchedule(
  { schedule: "0 9-18 * * 1-5", timeZone: "Europe/Kyiv", region: REGION },
  async () => {
    if (!DOCS_FOLDER_ID) return null;
    const drive = await mkDrive();
    const res = await drive.files.list({
      q: `'${DOCS_FOLDER_ID}' in parents and mimeType='text/csv' and trashed=false`,
      fields: "files(id,name,size,modifiedTime)",
      pageSize: 1000,
    });
    const files = res.data.files || [];
    for (const f of files) {
      const meta = parseFilename(f.name);
      if (!meta) continue;
      const key = makeDocKey(meta);
      await db.doc(`/artifacts/${APP_ID}/private/data/docsIndex/${key}`).set({
        driveFileId: f.id,
        name: f.name,
        size: Number(f.size||0),
        modifiedTime: f.modifiedTime || null,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    return null;
  }
);

// ===== callable: видати рядки документа за type/docNumber/clientCode/currency =====
// ===== callable: показ рядків видаткової накладної =====
exports.getDocDetails = onCall({ region: REGION, cors: true }, async (request) => {
  // 0) автентифікація
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Потрібна авторизація.");

  // 0.1) rate-limit (N запитів / хвилина на uid)
  const RATE_LIMIT = 30;
  const WINDOW_MS  = 60 * 1000;
  const rateRef = db.doc(`/artifacts/${APP_ID}/private/security/ratelimit/${uid}`);
  await db.runTransaction(async (tx) => {
    const now = Date.now();
    const snap = await tx.get(rateRef);
    const data = snap.exists ? snap.data() : {};
    const windowStart = Number(data?.windowStart || 0);
    let count = Number(data?.count || 0);

    if (!windowStart || now - windowStart >= WINDOW_MS) {
      // нове вікно
      tx.set(rateRef, { windowStart: now, count: 1 }, { merge: true });
    } else {
      if (count >= RATE_LIMIT) throw new HttpsError("resource-exhausted", "Занадто багато запитів.");
      tx.update(rateRef, { count: count + 1 });
    }
  });

  // 1) вхідні параметри + нормалізація
  const { type, docNumber, currency } = request.data || {};
  const t   = Number(type);
  const num = String(docNumber || "").trim();
  const cur = String(currency || "").trim().toUpperCase();
  if (!t || !num || !cur) {
    throw new HttpsError("invalid-argument", "Вкажіть: type, docNumber, currency.");
  }

  // 2) Використовуємо uid напряму як clientCode з fallback на clientsAuth
  let code = String(uid).trim();
  try {
    const mapRef = db.doc(`/artifacts/${APP_ID}/private/data/clientsAuth/${uid}`);
    const mapSnap = await mapRef.get();
    const codeFromAuth = String(mapSnap.get("code") || "").trim();
    if (codeFromAuth) {
      code = codeFromAuth;
    }
  } catch (e) {
    // Якщо не вдалося прочитати з clientsAuth, використовуємо uid
    logger.warn(`Could not read clientCode from clientsAuth for ${uid}, using uid directly`);
  }

  // 2) Перевірка існування клієнта
  const clientSnap = await db.doc(`/artifacts/${APP_ID}/public/data/clients/${code}`).get();
  if (!clientSnap.exists) throw new HttpsError("permission-denied", "Немає доступу до документа.");

  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/43d36951-e2f3-464b-a260-765b59298148',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'index.js:778',message:'getDocDetails: entry',data:{uid,code,type:t,docNumber:num,currency:cur},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
  // #endregion

  // 3) Шукаємо файл безпосередньо в Google Drive (без індексації)
  // Доступ дозволено до всіх документів з clientCode користувача
  const drive = await mkDrive();
  const fileName = `${t}_${num}_${code}_${cur}.csv`;
  
  // #region agent log
  const driveSearchStart = Date.now();
  // #endregion
  
  const filesResp = await drive.files.list({
    q: `name='${fileName}' and '${DOCS_FOLDER_ID}' in parents and mimeType='text/csv' and trashed=false`,
    fields: "files(id,name)",
    pageSize: 1,
  });
  
  // #region agent log
  const driveSearchTime = Date.now() - driveSearchStart;
  fetch('http://127.0.0.1:7242/ingest/43d36951-e2f3-464b-a260-765b59298148',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'index.js:789',message:'getDocDetails: drive search result',data:{fileName,found:filesResp.data.files?.length>0,driveSearchTimeMs:driveSearchTime},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
  // #endregion
  
  if (!filesResp.data.files || filesResp.data.files.length === 0) {
    throw new HttpsError("not-found", `Документ не знайдено: ${fileName}`);
  }
  
  const fileId = filesResp.data.files[0].id;

  // 5) Завантажуємо CSV з Drive, парсимо
  const fileResp = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
  const rows = parseCsvBuffer(Buffer.from(fileResp.data));

  // 6) Мапінг під твій формат (code|name|cnt|price|discount|total)
  const items = rows.map(r => ({
    code:  String(r.code || r.Код || r.Артикул || r.sku || "").trim(),
    name:  String(r.name || r.Найменування || r.Опис || "").trim(),
    qty:   Number(r.cnt || r.qty || r.Кількість || r.amount || r.кількість || 0),
    price: Number(String(r.price || r.Ціна || r['Ціна з ПДВ'] || 0).replace(',', '.')),
    discount: Number(String(r.discount || r['Знижка'] || 0).replace(',', '.')),
    sum:   Number(String(r.total || r.sum || r.Сума || r['Сума з ПДВ'] || 0).replace(',', '.')),
    unit:  String(r.unit || r.од || r.Одиниця || "").trim(),
    note:  String(r.note || r.Примітка || "").trim(),
  }));

  // 7) Аудит успішного видачі
  await db.collection(`/artifacts/${APP_ID}/private/security/auditLogs`).add({
    at: FieldValue.serverTimestamp(),
    uid, clientCode: code, docNumber: num, currency: cur, type: t,
    status: "ok", fileName: fileName
  });

  return { items, cached: false };
});

// ===== callable: завантажити повну історію взаєморозрахунків з Google Drive =====
/* --------------------------- Client Pricing Rules --------------------------- */
/**
 * getClientPricingRules - отримати персональні правила ціноутворення для клієнта
 */
exports.getCurrencyRate = onCall({ region: REGION, cors: true }, async (request) => {
  try {
    const currencyRatesRef = db.doc(`/artifacts/${APP_ID}/public/meta/currencyRates/uahToEur`);
    const snap = await currencyRatesRef.get();
    
    if (!snap.exists) {
      return { rate: null, updatedAt: null, error: "Currency rate not found" };
    }
    
    const data = snap.data();
    return {
      rate: data.rate || null,
      updatedAt: data.updatedAt || null,
    };
  } catch (e) {
    logger.error("getCurrencyRate error:", e);
    throw new HttpsError("internal", "Failed to get currency rate");
  }
});

exports.getClientPricingRules = onCall({ region: REGION, cors: true }, async (request) => {
  const { clientId } = request.data || {};
  if (!clientId) throw new HttpsError("invalid-argument", "clientId обов'язковий");
  
  const rulesRef = db.doc(`/artifacts/${APP_ID}/public/data/clientPricingRules/${clientId}`);
  const snap = await rulesRef.get();
  
  if (!snap.exists) {
    return {
      globalAdjustment: 0,
      rules: []
    };
  }
  
  const data = snap.data();
  // Міграція: якщо є старі поля, конвертуємо в adjustment
  let globalAdjustment = 0;
  if (data.globalAdjustment !== undefined) {
    globalAdjustment = Number(data.globalAdjustment || 0);
  } else {
    // Конвертація зі старих полів (для сумісності)
    const discount = Number(data.globalDiscount || 0);
    const markup = Number(data.globalMarkup || 0);
    globalAdjustment = markup - discount; // Якщо discount=2, markup=0 → adjustment=-2
  }
  
  // Конвертація правил
  const rules = Array.isArray(data.rules) ? data.rules.map(rule => {
    if (rule.adjustment !== undefined) {
      return rule;
    }
    // Конвертація зі старих полів
    const discount = Number(rule.discount || 0);
    const markup = Number(rule.markup || 0);
    return {
      ...rule,
      adjustment: markup - discount
    };
  }) : [];
  
  return {
    globalAdjustment,
    rules
  };
});

/**
 * setClientPricingRules - зберегти персональні правила ціноутворення для клієнта
 */
exports.setClientPricingRules = onCall({ region: REGION, cors: true }, async (request) => {
  // Перевірка адміна
  if (!request.auth?.token?.admin) {
    throw new HttpsError("permission-denied", "Потрібні права адміна");
  }
  
  const { clientId, globalAdjustment, rules } = request.data || {};
  if (!clientId) throw new HttpsError("invalid-argument", "clientId обов'язковий");
  
  // Валідація
  const validAdjustment = Math.max(-100, Math.min(100, Number(globalAdjustment || 0)));
  
  if (!Array.isArray(rules)) {
    throw new HttpsError("invalid-argument", "rules має бути масивом");
  }
  
  // Валідація правил
  const validPriceGroups = ["роздріб", "ціна 1", "ціна 2", "ціна 3", "ціна опт"];
  const validTypes = ["product", "brand", "supplier"];
  
  const validatedRules = [];
  for (const rule of rules) {
    if (!validTypes.includes(rule.type)) {
      throw new HttpsError("invalid-argument", `Невірний тип правила: ${rule.type}`);
    }
    if (!validPriceGroups.includes(rule.priceGroup)) {
      throw new HttpsError("invalid-argument", `Невірна градація: ${rule.priceGroup}`);
    }
    
    // Міграція: якщо є старі поля, конвертуємо
    let adjustment = 0;
    if (rule.adjustment !== undefined) {
      adjustment = Math.max(-100, Math.min(100, Number(rule.adjustment || 0)));
    } else {
      // Конвертація зі старих полів (для сумісності)
      const discount = Number(rule.discount || 0);
      const markup = Number(rule.markup || 0);
      adjustment = markup - discount;
    }
    
    const validatedRule = {
      type: rule.type,
      priceGroup: rule.priceGroup,
      adjustment: adjustment
    };
    
    if (rule.type === "product") {
      if (!rule.brand || !rule.id) {
        throw new HttpsError("invalid-argument", "Правило типу 'product' має містити brand та id");
      }
      validatedRule.brand = String(rule.brand).trim();
      validatedRule.id = String(rule.id).trim().toUpperCase();
    } else if (rule.type === "brand") {
      if (!rule.brand) {
        throw new HttpsError("invalid-argument", "Правило типу 'brand' має містити brand");
      }
      validatedRule.brand = String(rule.brand).trim();
    } else if (rule.type === "supplier") {
      if (!rule.supplier) {
        throw new HttpsError("invalid-argument", "Правило типу 'supplier' має містити supplier");
      }
      validatedRule.supplier = String(rule.supplier).trim();
    }
    
    validatedRules.push(validatedRule);
  }
  
  // Збереження
  const rulesRef = db.doc(`/artifacts/${APP_ID}/public/data/clientPricingRules/${clientId}`);
  await rulesRef.set({
    globalAdjustment: validAdjustment,
    rules: validatedRules,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: false });
  
  return { success: true, message: "Правила збережено" };
});

exports.getSettlementsFromDrive = onCall({ region: REGION, cors: true }, async (request) => {
  // 0) автентифікація
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Потрібна авторизація.");

  // 1) вхідні параметри
  const { currency, startDate, endDate } = request.data || {};
  const cur = String(currency || "").trim().toUpperCase();
  if (!cur) throw new HttpsError("invalid-argument", "Вкажіть currency.");

  // 2) Використовуємо uid напряму як clientCode
  // (згідно з auth.js, code встановлюється як String(clientId), тобто code === uid)
  // Але спробуємо спочатку отримати з clientsAuth, якщо не знайдено - використовуємо uid
  let code = String(uid).trim();
  try {
    const mapRef = db.doc(`/artifacts/${APP_ID}/private/data/clientsAuth/${uid}`);
    const mapSnap = await mapRef.get();
    const codeFromAuth = String(mapSnap.get("code") || "").trim();
    if (codeFromAuth) {
      code = codeFromAuth;
    }
  } catch (e) {
    // Якщо не вдалося прочитати з clientsAuth, використовуємо uid
    logger.warn(`Could not read clientCode from clientsAuth for ${uid}, using uid directly`);
  }

  // 3) Знаходимо файл у Google Drive
  // Формат файлу: 00010_UAH.csv (5 цифр з ведучими нулями + валюта)
  // Але code може бути без ведучих нулів, тому шукаємо обидва варіанти
  const drive = await mkDrive();
  
  // Формуємо code з ведучими нулями (5 цифр)
  const paddedCode = String(code).padStart(5, '0');
  const fileName1 = `${paddedCode}_${cur}.csv`;
  const fileName2 = `${code}_${cur}.csv`; // На випадок, якщо файл без ведучих нулів
  
  // Шукаємо файл (спочатку з ведучими нулями, потім без)
  let filesResp = await drive.files.list({
    q: `name='${fileName1}' and '${SETTLEMENTS_FOLDER_ID}' in parents and mimeType='text/csv' and trashed=false`,
    fields: "files(id,name)",
    pageSize: 1,
  });
  
  if (!filesResp.data.files || filesResp.data.files.length === 0) {
    // Якщо не знайдено, шукаємо без ведучих нулів
    filesResp = await drive.files.list({
      q: `name='${fileName2}' and '${SETTLEMENTS_FOLDER_ID}' in parents and mimeType='text/csv' and trashed=false`,
      fields: "files(id,name)",
      pageSize: 1,
    });
  }

  if (!filesResp.data.files || filesResp.data.files.length === 0) {
    throw new HttpsError("not-found", `Файл ${fileName1} або ${fileName2} не знайдено.`);
  }

  const fileId = filesResp.data.files[0].id;

  // 4) Завантажуємо та парсимо CSV
  const fileResp = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
  const rows = parseCsvBuffer(Buffer.from(fileResp.data));

  // 5) Фільтруємо за датами та розраховуємо startingBalance
  let filteredRows = rows;
  let startingBalance = 0;
  
  if (startDate || endDate) {
    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate) : null;
    if (end) end.setHours(23, 59, 59, 999);

    // Розраховуємо баланс на початок періоду (сума всіх delta до startDate)
    if (start) {
      for (const row of rows) {
        const docDate = parseSettlementsDate(row.document_date);
        if (docDate && docDate < start) {
          startingBalance += parseSettlementsNumber(row.amount);
        }
      }
    }

    filteredRows = rows.filter((row) => {
      const docDate = parseSettlementsDate(row.document_date);
      if (!docDate) return false;
      if (start && docDate < start) return false;
      if (end && docDate > end) return false;
      return true;
    });
  }

  // 6) Перетворюємо в формат для фронту
  const items = filteredRows.map((row) => {
    const docDate = parseSettlementsDate(row.document_date);
    return {
      date: docDate ? docDate.toISOString() : null,
      docNumber: String(row.document_number || "").trim(),
      docType: String(row.document_type || "").trim(),
      docCode: String(row.document_type_code || "").trim(),
      docId: String(row.document_id || "").trim(),
      expense: parseSettlementsNumber(row.expense),
      income: parseSettlementsNumber(row.income),
      delta: parseSettlementsNumber(row.amount),
      currency: cur,
      seq: Number(row.sequence) || 0,
    };
  });

  // 7) Сортуємо за датою
  items.sort((a, b) => {
    const dateA = a.date ? new Date(a.date).getTime() : 0;
    const dateB = b.date ? new Date(b.date).getTime() : 0;
    return dateB - dateA; // від нових до старих
  });

  return { items, total: items.length, startingBalance };
});

// Допоміжна функція для парсингу дати (як у settlements.js)
function parseSettlementsDate(dateStr) {
  if (!dateStr) return null;
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

/* --------------------------- Client Management --------------------------- */
const { schemas, validateData } = require("./shared/validation");
const bcrypt = require("bcryptjs");

const isAdminReq = (req) => (req?.auth?.token || {}).admin === true;

// Helper для встановлення паролю (логіка з auth.js)
async function setClientPasswordHelper(clientId, password) {
  const hash = await bcrypt.hash(password, 10);
  const authDocRef = db.doc(`/artifacts/${APP_ID}/private/data/clientsAuth/${clientId}`);
  await authDocRef.set(
    {
      passwordHash: hash,
      code: String(clientId),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  
  // Гарантуємо існування користувача з UID = clientId
  try {
    await auth.getUser(clientId);
  } catch {
    await auth.createUser({ uid: clientId });
  }
  
  // Встановлюємо custom claim clientCode
  try {
    await auth.setCustomUserClaims(clientId, { clientCode: String(clientId) });
  } catch (e) {
    logger.warn("setCustomUserClaims failed:", e?.message || e);
  }
}

/**
 * createClient - створити нового клієнта
 */
exports.createClient = onCall({ region: REGION, cors: true }, async (request) => {
  if (!isAdminReq(request)) throw new HttpsError("permission-denied", "Потрібен адмін-доступ.");
  
  const { id, name, phone, email, address, priceType, password } = validateData(schemas.createClient, request.data, "Client creation");

  // Перевірка унікальності ID
  const existingClient = await db.doc(`/artifacts/${APP_ID}/public/data/clients/${id}`).get();
  if (existingClient.exists) {
    throw new HttpsError("already-exists", `Клієнт з ID "${id}" вже існує.`);
  }

  // Перевірка унікальності телефону
  const existingPhone = await db.collection(`/artifacts/${APP_ID}/public/data/clients`).where("phone", "==", phone).limit(1).get();
  if (!existingPhone.empty) {
    throw new HttpsError("already-exists", `Клієнт з телефоном "${phone}" вже існує.`);
  }

  await db.doc(`/artifacts/${APP_ID}/public/data/clients/${id}`).set({
    id, name, phone, email: email || "", address: address || "", priceType: priceType || "роздріб",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  if (password && password.trim()) {
    await setClientPasswordHelper(id, password);
  }

  return { success: true, message: `Клієнт ${name} (${id}) створений.` };
});

/**
 * updateClient - оновити існуючого клієнта
 */
exports.updateClient = onCall({ region: REGION, cors: true }, async (request) => {
  if (!isAdminReq(request)) throw new HttpsError("permission-denied", "Потрібен адмін-доступ.");
  
  const { clientId, name, phone, email, address, priceType, password } = validateData(schemas.updateClient, request.data, "Client update");

  const clientRef = db.doc(`/artifacts/${APP_ID}/public/data/clients/${clientId}`);
  const clientSnap = await clientRef.get();
  if (!clientSnap.exists) {
    throw new HttpsError("not-found", `Клієнт з ID "${clientId}" не знайдений.`);
  }

  // Перевірка унікальності телефону (якщо змінено)
  if (phone && phone !== clientSnap.data().phone) {
    const existingPhone = await db.collection(`/artifacts/${APP_ID}/public/data/clients`).where("phone", "==", phone).limit(1).get();
    if (!existingPhone.empty) {
      throw new HttpsError("already-exists", `Клієнт з телефоном "${phone}" вже існує.`);
    }
  }

  const updateData = {
    updatedAt: FieldValue.serverTimestamp(),
  };
  
  if (name !== undefined) updateData.name = name;
  if (phone !== undefined) updateData.phone = phone;
  if (email !== undefined) updateData.email = email || "";
  if (address !== undefined) updateData.address = address || "";
  if (priceType !== undefined) updateData.priceType = priceType;

  await clientRef.update(updateData);

  if (password && password.trim()) {
    await setClientPasswordHelper(clientId, password);
  }

  return { success: true, message: `Клієнт ${name || clientId} (${clientId}) оновлений.` };
});

/**
 * deleteClient - видалити клієнта
 */
exports.deleteClient = onCall({ region: REGION, cors: true }, async (request) => {
  if (!isAdminReq(request)) throw new HttpsError("permission-denied", "Потрібен адмін-доступ.");
  
  const { clientId } = validateData(schemas.deleteClient, request.data, "Client deletion");
  
  const clientRef = db.doc(`/artifacts/${APP_ID}/public/data/clients/${clientId}`);
  const clientSnap = await clientRef.get();
  if (!clientSnap.exists) {
    throw new HttpsError("not-found", `Клієнт з ID "${clientId}" не знайдений.`);
  }
  
  // Видалення Auth користувача
  try {
    await auth.deleteUser(clientId);
  } catch (e) {
    // Якщо користувач не існує - це нормально
    if (e.code !== 'auth/user-not-found') {
      logger.warn(`Failed to delete auth user ${clientId}:`, e);
    }
  }
  
  // Видалення даних авторизації
  const authRef = db.doc(`/artifacts/${APP_ID}/private/data/clientsAuth/${clientId}`);
  try {
    await authRef.delete();
  } catch (e) {
    // Якщо документ не існує - це нормально
    logger.warn(`Failed to delete auth data for ${clientId}:`, e);
  }
  
  // Видалення документа клієнта
  await clientRef.delete();
  
  return { success: true, message: `Клієнт ${clientId} видалено.` };
});

/**
 * updateRegistrationRequestsCounter - оновити лічильник заявок
 */
async function updateRegistrationRequestsCounter() {
  const counterRef = db.doc(`/artifacts/${APP_ID}/public/meta/counters/registrationRequestsCount`);
  const counterSnap = await counterRef.get();
  const currentTotal = counterSnap.exists ? (counterSnap.data().total || 0) : 0;
  await counterRef.set({
    total: currentTotal + 1,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
}

/**
 * decrementRegistrationRequestsCounter - зменшити лічильник заявок
 */
async function decrementRegistrationRequestsCounter() {
  const counterRef = db.doc(`/artifacts/${APP_ID}/public/meta/counters/registrationRequestsCount`);
  const counterSnap = await counterRef.get();
  const currentTotal = counterSnap.exists ? (counterSnap.data().total || 0) : 0;
  if (currentTotal > 0) {
    await counterRef.set({
      total: currentTotal - 1,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  }
}

/**
 * decrementRegistrationRequestsCounter - callable версія для виклику з фронтенду
 */
exports.decrementRegistrationRequestsCounter = onCall({ region: REGION, cors: true }, async (request) => {
  if (!isAdminReq(request)) throw new HttpsError("permission-denied", "Потрібен адмін-доступ.");
  await decrementRegistrationRequestsCounter();
  return { success: true };
});

/**
 * submitRegistrationRequest - створити заявку на реєстрацію
 */
exports.submitRegistrationRequest = onCall({ 
  region: REGION, 
  cors: true,
  maxInstances: PUBLIC_RATE_LIMIT.maxInstances,
  concurrency: PUBLIC_RATE_LIMIT.concurrency
}, async (request) => {
  const { phone, name, email } = validateData(schemas.registrationRequest, request.data, "Registration request");
  
  // Перевірка, чи клієнт вже існує
  const existingClient = await db.collection(`/artifacts/${APP_ID}/public/data/clients`).where("phone", "==", phone).limit(1).get();
  if (!existingClient.empty) {
    throw new HttpsError("already-exists", "Клієнт з таким телефоном вже зареєстрований.");
  }
  
  // Перевірка, чи вже є pending заявка з таким телефоном
  const existingRequest = await db.collection(`/artifacts/${APP_ID}/public/data/registrationRequests`)
    .where("phone", "==", phone)
    .limit(1)
    .get();
  
  if (!existingRequest.empty) {
    throw new HttpsError("already-exists", "Заявка з таким телефоном вже існує.");
  }
  
  // Створюємо заявку
  const requestRef = db.collection(`/artifacts/${APP_ID}/public/data/registrationRequests`).doc();
  await requestRef.set({
    phone,
    name: name || "",
    email: email || "",
    type: "registration",
    createdAt: FieldValue.serverTimestamp(),
    requestId: requestRef.id
  });
  
  // Оновлюємо лічильник
  await updateRegistrationRequestsCounter();
  
  return { success: true, message: "Заявку на реєстрацію створено. Менеджер зв'яжеться з вами." };
});

/**
 * submitPasswordResetRequest - створити заявку на відновлення пароля
 */
exports.submitPasswordResetRequest = onCall({ 
  region: REGION, 
  cors: true,
  maxInstances: PUBLIC_RATE_LIMIT.maxInstances,
  concurrency: PUBLIC_RATE_LIMIT.concurrency
}, async (request) => {
  const { phone } = validateData(schemas.passwordResetRequest, request.data, "Password reset request");
  
  // Перевірка, чи клієнт існує
  const existingClient = await db.collection(`/artifacts/${APP_ID}/public/data/clients`).where("phone", "==", phone).limit(1).get();
  if (existingClient.empty) {
    throw new HttpsError("not-found", "Клієнт з таким телефоном не знайдений.");
  }
  
  // Перевірка, чи вже є pending заявка з таким телефоном
  const existingRequest = await db.collection(`/artifacts/${APP_ID}/public/data/registrationRequests`)
    .where("phone", "==", phone)
    .where("type", "==", "passwordReset")
    .limit(1)
    .get();
  
  if (!existingRequest.empty) {
    throw new HttpsError("already-exists", "Заявка на відновлення пароля вже існує.");
  }
  
  // Створюємо заявку
  const requestRef = db.collection(`/artifacts/${APP_ID}/public/data/registrationRequests`).doc();
  await requestRef.set({
    phone,
    type: "passwordReset",
    createdAt: FieldValue.serverTimestamp(),
    requestId: requestRef.id
  });
  
  // Оновлюємо лічильник
  await updateRegistrationRequestsCounter();
  
  return { success: true, message: "Заявку на відновлення пароля створено. Менеджер зв'яжеться з вами." };
});

/* ------------------------------ featured products ------------------------------ */
/**
 * addFeaturedProduct — додати товар до рекомендованих
 */
exports.addFeaturedProduct = onCall({ region: REGION, cors: true }, async (request) => {
  if (!request.auth?.token?.admin) {
    throw new HttpsError("permission-denied", "Потрібні права адміністратора.");
  }
  
  const { brand, id } = request.data || {};
  if (!brand || !id) {
    throw new HttpsError("invalid-argument", "brand та id обов'язкові.");
  }
  
  const featuredRef = db.doc(`/artifacts/${APP_ID}/public/data/featuredProducts/main`);
  const snap = await featuredRef.get();
  const items = snap.exists ? (snap.data().items || []) : [];
  
  // Перевірка, чи товар вже є
  const exists = items.some(item => item.brand === brand && item.id === id);
  if (exists) {
    throw new HttpsError("already-exists", "Товар вже в рекомендованих.");
  }
  
  items.push({ brand, id, addedAt: Timestamp.now() });
  await featuredRef.set({ items }, { merge: true });
  
  logger.info(`Featured product added: ${brand} ${id}`);
  return { success: true };
});

/**
 * removeFeaturedProduct — видалити товар з рекомендованих
 */
exports.removeFeaturedProduct = onCall({ region: REGION, cors: true }, async (request) => {
  if (!request.auth?.token?.admin) {
    throw new HttpsError("permission-denied", "Потрібні права адміністратора.");
  }
  
  const { brand, id } = request.data || {};
  if (!brand || !id) {
    throw new HttpsError("invalid-argument", "brand та id обов'язкові.");
  }
  
  const featuredRef = db.doc(`/artifacts/${APP_ID}/public/data/featuredProducts/main`);
  const snap = await featuredRef.get();
  if (!snap.exists) {
    return { success: true };
  }
  
  const items = (snap.data().items || []).filter(item => !(item.brand === brand && item.id === id));
  await featuredRef.set({ items }, { merge: true });
  
  logger.info(`Featured product removed: ${brand} ${id}`);
  return { success: true };
});

/* ------------------------------ misc ------------------------------ */
exports.test = onCall({ region: REGION, cors: true }, async () => {
  return { ok: true, at: new Date().toISOString(), appId: APP_ID, region: REGION };
});

// search
exports.searchProductsByArticle = require("./search").searchProductsByArticle;

// maintenance
exports.deleteAllProducts  = require("./maintenance").deleteAllProducts;
exports.clearBrandsCache   = require("./maintenance").clearBrandsCache;
exports.rebuildBrandsCache = require("./maintenance").rebuildBrandsCache;
exports.findBrandDuplicates= require("./maintenance").findBrandDuplicates;
exports.deleteAllSettlements = require("./maintenance").deleteAllSettlements;
exports.weeklyRebuildBrandsCache = require("./maintenance").weeklyRebuildBrandsCache;

// Compose other modules (auth / suppliers / ukrsklad / settlements)
// Використовуємо try-catch для сумісності, але логуємо помилки детальніше
try { 
  Object.assign(exports, require("./auth")); 
} catch (e) { 
  logger.warn("auth module not found or failed to load", String(e));
  if (e.stack) logger.warn("auth module error stack", e.stack);
}
try { 
  Object.assign(exports, require("./suppliers")); 
} catch (e) { 
  logger.warn("suppliers module not found or failed to load", String(e));
  if (e.stack) logger.warn("suppliers module error stack", e.stack);
}
try { 
  Object.assign(exports, require("./ukrsklad")); 
} catch (e) { 
  logger.warn("ukrsklad module not found or failed to load", String(e));
  if (e.stack) logger.warn("ukrsklad module error stack", e.stack);
}
try { 
  Object.assign(exports, require("./settlements")); 
} catch (e) { 
  logger.warn("settlements module not found or failed to load", String(e));
  if (e.stack) logger.warn("settlements module error stack", e.stack);
}
try { 
  Object.assign(exports, require("./warehouse")); 
} catch (e) { 
  logger.warn("warehouse module not found or failed to load", String(e));
  if (e.stack) logger.warn("warehouse module error stack", e.stack);
}
