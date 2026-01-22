// functions/search.js
const { onCall } = require("firebase-functions/v2/https");
const { getFirestore } = require("firebase-admin/firestore");
const { normalizeArticle, APP_ID } = require("./shared");

const db = getFirestore();
const REGION = process.env.FUNCTION_REGION || "europe-central2";

/**
 * Пошук товарів по артикулу (з підтримкою синонімів)
 * Шукає в товарах через id та synonyms array-contains (не залежить від кешу майстер-даних)
 */
exports.searchProductsByArticle = onCall(
  { region: REGION, cors: true },
  async (request) => {
    const { article } = request.data || {};
    
    if (!article || typeof article !== "string") {
      return { ok: false, error: "Артикул обов'язковий", products: [] };
    }

    // Нормалізуємо артикул для пошуку
    const normalizedArticle = normalizeArticle(article);
    if (!normalizedArticle) {
      return { ok: false, error: "Невірний артикул", products: [] };
    }
    
    const productsCol = db.collection(`/artifacts/${APP_ID}/public/data/products`);
    
    // Query 1: Пошук по основному артикулу
    const snap1 = await productsCol
      .where("id", "==", normalizedArticle)
      .limit(50)
      .get();
    
    // Query 2: Пошук по синонімах
    const snap2 = await productsCol
      .where("synonyms", "array-contains", normalizedArticle)
      .limit(50)
      .get();
    
    // Об'єднуємо та дедуплікуємо результати
    // Товари тепер містять offers[] з пропозиціями від різних постачальників
    const allProducts = new Map();
    snap1.docs.forEach(doc => {
      allProducts.set(doc.id, { docId: doc.id, ...doc.data() });
    });
    snap2.docs.forEach(doc => {
      allProducts.set(doc.id, { docId: doc.id, ...doc.data() });
    });
    
    const products = Array.from(allProducts.values());
    const foundViaSynonym = snap2.size > 0 && snap1.size === 0;
    
    return {
      ok: true,
      products, // Кожен товар містить offers[] з пропозиціями від постачальників
      foundViaSynonym,
      searchedArticle: article,
      canonicalArticle: normalizedArticle,
      count: products.length
    };
  }
);

