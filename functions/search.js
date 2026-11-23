// functions/search.js
const { onCall } = require("firebase-functions/v2/https");
const { getFirestore } = require("firebase-admin/firestore");
const logger = require("firebase-functions/logger");
const { normalizeArticle, normalizeBrandKey, APP_ID, listProductMasterCards } = require("./shared");
const { compactArticle, suggestMasterCards, matchMasterPhrase } = require("./articleKey");

const db = getFirestore();
const REGION = process.env.FUNCTION_REGION || "europe-central2";
const COMPACT_INDEX_TTL_MS = 10 * 60 * 60 * 1000;

let compactIndex = null;
let compactIndexExpiry = 0;
let compactIndexFlight = null;

function addCompactHit(index, code, docId, via) {
  const key = compactArticle(code);
  if (!key || key.length < 4) return;
  if (!index.has(key)) index.set(key, []);
  const list = index.get(key);
  if (list.length >= 50 || list.some((item) => item.docId === docId)) return;
  list.push({ docId, via });
}

async function loadCompactIndex(productsCol) {
  if (compactIndex && Date.now() < compactIndexExpiry) return compactIndex;
  if (compactIndexFlight) return compactIndexFlight;

  compactIndexFlight = (async () => {
    const snap = await productsCol.select("id", "synonyms").get();
    const index = new Map();
    snap.docs.forEach((doc) => {
      const data = doc.data() || {};
      addCompactHit(index, data.id, doc.id, "id");
      (Array.isArray(data.synonyms) ? data.synonyms : []).forEach((syn) => {
        addCompactHit(index, syn, doc.id, "synonym");
      });
    });
    compactIndex = index;
    compactIndexExpiry = Date.now() + COMPACT_INDEX_TTL_MS;
    logger.info("Article compact index loaded", { products: snap.size, keys: index.size });
    return index;
  })().finally(() => {
    compactIndexFlight = null;
  });

  return compactIndexFlight;
}

async function findByArticleKeys(productsCol, keys) {
  const allProducts = new Map();
  let idHits = 0;
  let synonymHits = 0;

  const snaps = await Promise.all(keys.flatMap((key) => [
    productsCol.where("id", "==", key).limit(50).get(),
    productsCol.where("synonyms", "array-contains", key).limit(50).get(),
  ]));

  snaps.forEach((snap, index) => {
    const viaSynonym = index % 2 === 1;
    if (viaSynonym) synonymHits += snap.size;
    else idHits += snap.size;
    snap.docs.forEach((doc) => {
      allProducts.set(doc.id, { docId: doc.id, ...doc.data() });
    });
  });

  return { allProducts, idHits, synonymHits };
}

/**
 * Пошук товарів по артикулу (з підтримкою синонімів).
 * Дефіс і крапка в запиті не обов'язкові: 0888080845-BB знаходить 08880-80845-BB.
 * id товару не змінюється.
 */
exports.searchProductsByArticle = onCall(
  { region: REGION, cors: true },
  async (request) => {
    const { HttpsError } = require("firebase-functions/v2/https");
    if (!request.auth?.uid) {
      throw new HttpsError("unauthenticated", "Потрібна авторизація.");
    }

    const { article } = request.data || {};

    if (!article || typeof article !== "string") {
      return { ok: false, error: "Артикул обов'язковий", products: [] };
    }

    const normalizedArticle = normalizeArticle(article);
    const compact = normalizedArticle.replace(/[.-]/g, "");
    const keys = [...new Set([normalizedArticle, compact].filter(Boolean))];
    if (!normalizedArticle || !keys.length) {
      return { ok: false, error: "Невірний артикул", products: [] };
    }

    const productsCol = db.collection(`/artifacts/${APP_ID}/public/data/products`);
    const found = await findByArticleKeys(productsCol, keys);
    let { allProducts, idHits, synonymHits } = found;

    if (!allProducts.size && compact.length >= 4) {
      const index = await loadCompactIndex(productsCol);
      const hits = index.get(compact) || [];
      if (hits.length) {
        const refs = hits.map((hit) => productsCol.doc(hit.docId));
        const docs = await db.getAll(...refs);
        docs.forEach((doc) => {
          if (!doc.exists) return;
          allProducts.set(doc.id, { docId: doc.id, ...doc.data() });
        });
        hits.forEach((hit) => {
          if (hit.via === "synonym") synonymHits += 1;
          else idHits += 1;
        });
      }
    }

    const products = Array.from(allProducts.values());
    const foundViaSynonym = synonymHits > 0 && idHits === 0;

    return {
      ok: true,
      products,
      foundViaSynonym,
      searchedArticle: article,
      canonicalArticle: products[0]?.id || normalizedArticle,
      count: products.length,
    };
  }
);

exports.suggestMasterProducts = onCall(
  { region: REGION, cors: true },
  async (request) => {
    const { HttpsError } = require("firebase-functions/v2/https");
    if (!request.auth?.uid) {
      throw new HttpsError("unauthenticated", "Потрібна авторизація.");
    }
    const q = String(request.data?.q || "").slice(0, 80);
    if (q.trim().length < 2) return { ok: true, items: [] };
    const cards = await listProductMasterCards();
    return { ok: true, items: suggestMasterCards(cards, q, 8) };
  }
);

async function productsForMasterHits(productsCol, hits) {
  const ids = [...new Set(hits.map((hit) => hit.id).filter(Boolean))].slice(0, 30);
  if (!ids.length) return [];
  const byId = new Map();
  const snap = await productsCol.where("id", "in", ids).get();
  snap.docs.forEach((doc) => {
    const data = doc.data() || {};
    const list = byId.get(data.id) || [];
    list.push({ docId: doc.id, ...data });
    byId.set(data.id, list);
  });
  const products = [];
  const seen = new Set();
  hits.forEach((hit) => {
    const candidates = byId.get(hit.id) || [];
    const brandKey = normalizeBrandKey(hit.brand);
    const match = candidates.find((product) => normalizeBrandKey(product.brand) === brandKey) || candidates[0];
    if (!match || seen.has(match.docId)) return;
    seen.add(match.docId);
    products.push(match);
  });
  return products;
}

/**
 * Запасний портал: точний артикул по каталогу, інакше фраза по майстер-картках
 * (бренд, назва, в’язкість, допуск, фасовка, категорія) і їхні товари з ціною.
 */
exports.searchCatalog = onCall(
  { region: REGION, cors: true },
  async (request) => {
    const { HttpsError } = require("firebase-functions/v2/https");
    if (!request.auth?.uid) {
      throw new HttpsError("unauthenticated", "Потрібна авторизація.");
    }
    const q = String(request.data?.q || request.data?.article || "").trim().slice(0, 80);
    if (!q) return { ok: false, error: "Запит обов'язковий", products: [] };

    const productsCol = db.collection(`/artifacts/${APP_ID}/public/data/products`);
    const normalizedArticle = normalizeArticle(q);
    const compact = normalizedArticle.replace(/[.-]/g, "");
    const keys = [...new Set([normalizedArticle, compact].filter(Boolean))];
    const found = keys.length ? await findByArticleKeys(productsCol, keys) : { allProducts: new Map(), idHits: 0, synonymHits: 0 };
    let { allProducts, idHits, synonymHits } = found;
    const looksLikeArticle = !/\s/.test(q) && compact.length >= 4;

    if (!allProducts.size && looksLikeArticle) {
      const index = await loadCompactIndex(productsCol);
      const hits = index.get(compact) || [];
      if (hits.length) {
        const refs = hits.map((hit) => productsCol.doc(hit.docId));
        const docs = await db.getAll(...refs);
        docs.forEach((doc) => {
          if (!doc.exists) return;
          allProducts.set(doc.id, { docId: doc.id, ...doc.data() });
        });
        hits.forEach((hit) => {
          if (hit.via === "synonym") synonymHits += 1;
          else idHits += 1;
        });
      }
    }

    if (allProducts.size) {
      const products = Array.from(allProducts.values());
      return {
        ok: true,
        products,
        interpreted: false,
        foundViaSynonym: synonymHits > 0 && idHits === 0,
        count: products.length,
      };
    }

    const cards = await listProductMasterCards();
    const offset = Math.max(0, Math.floor(Number(request.data?.offset) || 0));
    const page = matchMasterPhrase(cards, q, { limit: 30, offset });
    const products = await productsForMasterHits(productsCol, page.hits);
    const nextOffset = offset + page.hits.length;
    return {
      ok: true,
      products,
      interpreted: true,
      hasMore: nextOffset < page.total,
      nextOffset,
      count: products.length,
    };
  }
);
