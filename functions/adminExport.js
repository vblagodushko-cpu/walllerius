// functions/adminExport.js — адмін-експорт прайсів (callable)
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const { db, APP_ID, isAdminReq } = require("./shared");

const REGION = process.env.FUNCTION_REGION || "europe-central2";

const VALID_PRICE_TYPES = new Set([
  "роздріб",
  "ціна 1",
  "ціна 2",
  "ціна 3",
  "ціна опт",
]);

/**
 * getProductsForAdmin — рядки для CSV/XLSX на сторінці «Експорт».
 * Один рядок = один офер (supplier); фільтри як у ExportPage.jsx.
 */
exports.getProductsForAdmin = onCall({ region: REGION, cors: true }, async (request) => {
  if (!isAdminReq(request)) {
    throw new HttpsError("permission-denied", "Потрібен адмін-доступ.");
  }

  const {
    supplier = null,
    brandPrefix = null,
    stockOnly = false,
    priceType = "роздріб",
    limit = 200000,
  } = request.data || {};

  const supplierFilter =
    supplier && String(supplier).trim() ? String(supplier).trim() : null;
  const prefix = brandPrefix && String(brandPrefix).trim()
    ? String(brandPrefix).trim().toUpperCase()
    : null;
  const onlyInStock = Boolean(stockOnly);
  const priceKey = VALID_PRICE_TYPES.has(priceType) ? priceType : "роздріб";
  const maxRows = Math.min(Math.max(1, Number(limit) || 50000), 200000);

  const productsCol = db.collection(`/artifacts/${APP_ID}/public/data/products`);
  const snapshot = await productsCol.get();

  const items = [];

  for (const docSnap of snapshot.docs) {
    if (items.length >= maxRows) break;

    const data = docSnap.data() || {};
    const brand = String(data.brand || "").trim();
    if (prefix && !brand.toUpperCase().startsWith(prefix)) continue;

    const offers = Array.isArray(data.offers) ? data.offers : [];
    for (const offer of offers) {
      if (items.length >= maxRows) break;

      const offerSupplier = String(offer?.supplier || "").trim();
      if (supplierFilter && offerSupplier !== supplierFilter) continue;

      const stock = Number(offer?.stock) || 0;
      if (onlyInStock && stock <= 0) continue;

      const publicPrices =
        offer?.publicPrices && typeof offer.publicPrices === "object"
          ? offer.publicPrices
          : {};

      items.push({
        docId: docSnap.id,
        id: data.id || docSnap.id,
        brand,
        name: data.name || "",
        stock,
        publicPrices,
        supplier: offerSupplier,
        priceKey,
      });
    }
  }

  logger.info("getProductsForAdmin", {
    rows: items.length,
    supplier: supplierFilter || "all",
    stockOnly: onlyInStock,
    priceType: priceKey,
  });

  return { items };
});
