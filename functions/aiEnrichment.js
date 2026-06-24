/**
 * AI-пропозиції для master-даних товару (Етап 1: текст, без автозбереження).
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const { getFirestore } = require("firebase-admin/firestore");
const {
  APP_ID,
  normalizeArticle,
  normalizeBrandKey,
  getProductMasterData,
  str,
  normalizePack,
} = require("./shared");
const {
  parseToleranceTags,
  toleranceGroupsFromTags,
} = require("./shared/tolerances");

const db = getFirestore();
const REGION = process.env.FUNCTION_REGION || "europe-central2";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

function getGeminiApiKey() {
  return String(process.env.GEMINI_API_KEY || "").trim();
}
const MAX_DETAIL_BODY = 80000;
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

const ALLOWED_FIELDS = new Set([
  "correctName",
  "categories",
  "pack",
  "tolerances",
  "synonyms",
  "detailBody",
]);

/** @type {Map<string, { count: number, resetAt: number }>} */
const rateLimitByUid = new Map();

/** @type {{ names: string[], expiresAt: number } | null} */
let categoryCache = null;

function checkRateLimit(uid) {
  const now = Date.now();
  let entry = rateLimitByUid.get(uid);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitByUid.set(uid, entry);
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    throw new HttpsError(
      "resource-exhausted",
      "Ліміт AI-запитів вичерпано. Спробуйте пізніше."
    );
  }
  entry.count += 1;
}

async function loadCategoryNames() {
  const now = Date.now();
  if (categoryCache && now < categoryCache.expiresAt) {
    return categoryCache.names;
  }
  const snap = await db.collection(`/artifacts/${APP_ID}/public/meta/categories`).get();
  const names = [];
  const seen = new Set();
  snap.docs.forEach((docSnap) => {
    const data = docSnap.data() || {};
    const name = str(data.name || docSnap.id, 120).trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    names.push(name);
  });
  names.sort((a, b) => a.localeCompare(b, "uk"));
  categoryCache = { names, expiresAt: now + 60 * 60 * 1000 };
  return names;
}

function cleanList(value, maxItems = 80, maxLen = 120) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value
    .map((item) => str(item, maxLen))
    .filter(Boolean)
    .filter((item) => {
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxItems);
}

function isFieldMissing(field, product, master) {
  if (field === "correctName") {
    return !str(master?.correctName || product?.name || "", 500).trim();
  }
  if (field === "categories") {
    const cats = Array.isArray(master?.categories)
      ? master.categories
      : (Array.isArray(product?.categories) ? product.categories : []);
    return cats.length === 0;
  }
  if (field === "pack") {
    return !str(master?.pack || product?.pack || "", 200).trim();
  }
  if (field === "tolerances") {
    return !str(master?.tolerances || product?.tolerances || "", 500).trim();
  }
  if (field === "synonyms") {
    const syns = Array.isArray(master?.synonyms)
      ? master.synonyms
      : (Array.isArray(product?.synonyms) ? product.synonyms : []);
    return syns.length === 0;
  }
  if (field === "detailBody") return true;
  return false;
}

function resolveTargetFields(requested, product, master, includeDetailBody, detailBodyExists) {
  const base = requested.length
    ? requested.filter((f) => ALLOWED_FIELDS.has(f))
    : ["correctName", "categories", "pack", "tolerances", "synonyms"];

  const fields = base.filter((field) => {
    if (field === "detailBody") {
      return includeDetailBody && !detailBodyExists;
    }
    return isFieldMissing(field, product, master);
  });

  if (includeDetailBody && !detailBodyExists && !fields.includes("detailBody")) {
    fields.push("detailBody");
  }

  return fields;
}

function parseGeminiJson(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("Порожня відповідь моделі.");
  try {
    return JSON.parse(trimmed);
  } catch {
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) return JSON.parse(fence[1].trim());
    throw new Error("Не вдалося розпарсити JSON від моделі.");
  }
}

async function callGemini(apiKey, systemPrompt, userPrompt) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}` +
    `:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    logger.warn("Gemini API error", { status: res.status, body: errText.slice(0, 300) });
    throw new HttpsError(
      "internal",
      "AI-сервіс тимчасово недоступний. Спробуйте пізніше."
    );
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new HttpsError("internal", "AI не повернув результат.");
  }
  return {
    parsed: parseGeminiJson(text),
    tokensUsed: Number(data?.usageMetadata?.totalTokenCount || 0),
  };
}

function sanitizeSuggestion(raw, targetFields, allowedCategories) {
  const allowedSet = new Set(allowedCategories.map((c) => c.toLowerCase()));
  const categoryByLower = new Map(
    allowedCategories.map((c) => [c.toLowerCase(), c])
  );

  const suggestion = {};
  const confidence = {};

  if (targetFields.includes("correctName")) {
    suggestion.correctName = str(raw.correctName, 500);
    confidence.correctName = clamp01(raw?.confidence?.correctName);
  }
  if (targetFields.includes("categories")) {
    const picked = cleanList(raw.categories, 50, 120)
      .filter((name) => allowedSet.has(name.toLowerCase()))
      .map((name) => categoryByLower.get(name.toLowerCase()) || name)
      .slice(0, 3);
    suggestion.categories = picked;
    confidence.categories = clamp01(raw?.confidence?.categories);
  }
  if (targetFields.includes("pack")) {
    suggestion.pack = normalizePack(raw.pack);
    confidence.pack = clamp01(raw?.confidence?.pack);
  }
  if (targetFields.includes("tolerances")) {
    suggestion.tolerances = str(raw.tolerances, 500);
    suggestion.toleranceTags = parseToleranceTags(suggestion.tolerances);
    suggestion.toleranceGroups = toleranceGroupsFromTags(suggestion.toleranceTags);
    confidence.tolerances = clamp01(raw?.confidence?.tolerances);
  }
  if (targetFields.includes("synonyms")) {
    suggestion.synonyms = cleanList(raw.synonyms, 100, 120)
      .map(normalizeArticle)
      .filter(Boolean);
    confidence.synonyms = clamp01(raw?.confidence?.synonyms);
  }
  if (targetFields.includes("detailBody")) {
    suggestion.detailBody = str(raw.detailBody, MAX_DETAIL_BODY);
    confidence.detailBody = clamp01(raw?.confidence?.detailBody);
  }

  return {
    suggestion,
    confidence,
    notes: str(raw.notes, 1000),
  };
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function buildPrompt({
  brand,
  id,
  productName,
  master,
  targetFields,
  categoryNames,
}) {
  const existing = {
    correctName: str(master?.correctName || "", 500),
    categories: Array.isArray(master?.categories) ? master.categories : [],
    pack: str(master?.pack || "", 200),
    tolerances: str(master?.tolerances || "", 500),
    synonyms: Array.isArray(master?.synonyms) ? master.synonyms : [],
  };

  return JSON.stringify(
    {
      task: "fill_missing_product_fields",
      brand,
      id,
      currentName: productName,
      existingMaster: existing,
      fieldsToFill: targetFields,
      allowedCategories: categoryNames,
      rules: [
        "Відповідь українською.",
        "Заповнюй лише fieldsToFill.",
        "categories — тільки з allowedCategories (1–3 шт.).",
        "synonyms — альтернативні написання артикулу, не інші товари.",
        "tolerances — пиши людським текстом, але тільки реальні стандарти/допуски: ACEA, API, ILSAC, JASO, MB, VW, BMW, Renault, Ford, GM, ZF, MAN, DOT, ISO, SAE.",
        "pack — об'єм у літрах, лише число без одиниць: \"0.2\", \"1\", \"4\", \"5\", \"20\". Не пиши \"200 мл\", \"4л\", \"4 л\", \"1L\". 200 мл → \"0.2\". Для штучних товарів (фільтри, свічки) — порожній рядок.",
        "Якщо даних недостатньо — порожній рядок або [] і поясни в notes.",
        "Не вигадуй OEM/стандарти без впевненості.",
      ],
      responseSchema: {
        correctName: "string",
        categories: ["string"],
        pack: "string (літри, число без одиниць)",
        tolerances: "string",
        synonyms: ["string"],
        detailBody: "string",
        notes: "string",
        confidence: {
          correctName: 0,
          categories: 0,
          pack: 0,
          tolerances: 0,
          synonyms: 0,
          detailBody: 0,
        },
      },
    },
    null,
    2
  );
}

const SYSTEM_PROMPT =
  "Ти каталогіст B2B автозапчастин та автохімії в Україні. " +
  "Повертай лише валідний JSON за responseSchema. Без markdown.";

exports.suggestProductEnrichment = onCall(
  { region: REGION, cors: true },
  async (request) => {
    if (!request.auth?.token?.admin) {
      throw new HttpsError("permission-denied", "Потрібен адмін-доступ.");
    }

    const apiKey = getGeminiApiKey();
    if (!apiKey) {
      throw new HttpsError(
        "failed-precondition",
        "GEMINI_API_KEY не налаштовано на сервері."
      );
    }

    checkRateLimit(request.auth.uid);

    const {
      productDocId,
      brand,
      id,
      missingFields,
      includeDetailBody = true,
    } = request.data || {};

    const cleanProductDocId = str(productDocId, 200);
    const cleanBrand = str(brand, 120).replace(/\s{2,}/g, " ").trim();
    const cleanId = normalizeArticle(id);

    if (!cleanProductDocId || !cleanBrand || !cleanId) {
      throw new HttpsError("invalid-argument", "productDocId, brand та id обов'язкові.");
    }

    const productRef = db.doc(`/artifacts/${APP_ID}/public/data/products/${cleanProductDocId}`);
    const [productSnap, master, categoryNames] = await Promise.all([
      productRef.get(),
      getProductMasterData(cleanBrand, cleanId).catch(() => null),
      loadCategoryNames(),
    ]);

    if (!productSnap.exists) {
      throw new HttpsError("not-found", "Товар не знайдено.");
    }

    const product = productSnap.data() || {};
    const productBrand = str(product.brand, 120).replace(/\s{2,}/g, " ").trim();
    const productArticle = normalizeArticle(product.id);
    if (
      normalizeBrandKey(productBrand) !== normalizeBrandKey(cleanBrand) ||
      productArticle !== cleanId
    ) {
      throw new HttpsError("failed-precondition", "brand/id товару не збігаються.");
    }

    let detailBodyExists = false;
    if (includeDetailBody) {
      const detailSnap = await productRef.collection("details").doc("main").get();
      detailBodyExists = Boolean(str(detailSnap.data()?.body || "", 100).trim());
    }

    const requestedFields = Array.isArray(missingFields)
      ? missingFields.filter((f) => ALLOWED_FIELDS.has(f) || f === "detailBody")
      : [];

    const targetFields = resolveTargetFields(
      requestedFields,
      product,
      master,
      includeDetailBody,
      detailBodyExists
    );

    if (!targetFields.length) {
      return {
        success: true,
        suggestion: {},
        confidence: {},
        notes: "Усі обрані поля вже заповнені.",
        targetFields: [],
        model: GEMINI_MODEL,
        tokensUsed: 0,
      };
    }

    const userPrompt = buildPrompt({
      brand: productBrand,
      id: cleanId,
      productName: str(product.name, 500),
      master,
      targetFields,
      categoryNames,
    });

    const { parsed, tokensUsed } = await callGemini(apiKey, SYSTEM_PROMPT, userPrompt);
    const { suggestion, confidence, notes } = sanitizeSuggestion(
      parsed,
      targetFields,
      categoryNames
    );

    logger.info("Product enrichment suggested", {
      uid: request.auth.uid,
      productDocId: cleanProductDocId,
      targetFields,
      tokensUsed,
    });

    return {
      success: true,
      suggestion,
      confidence,
      notes,
      targetFields,
      model: GEMINI_MODEL,
      tokensUsed,
    };
  }
);
