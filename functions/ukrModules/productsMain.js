// functions/ukrModules/productsMain.js
// Основний склад «Мій склад» з UkrSklad (заміна price_full.csv + Google Drive).
// Агент шле лише змінені товари (op "upsert") та зниклі (op "delete").
// Логіка запису та ж, що в performUkrSkladSync (ukrsklad.js): canonical brand/article, masterData,
// upsertProduct. id товару UkrSklad (ukrId) зберігається як products.ukrSkladId.
const Joi = require("joi");
const logger = require("firebase-functions/logger");
const {
  db,
  APP_ID,
  normalizeBrand,
  normalizeBrandKey,
  normalizeArticle,
  getProductMasterData,
  upsertProduct,
  removeProduct,
} = require("../shared");

const SUPPLIER = "Мій склад";

const str = (v, max = 500) => {
  const s = (v ?? "").toString().trim();
  return max ? (s.length > max ? s.slice(0, max) : s) : s;
};
const price = Joi.number().allow(null).default(null);

const upsertItem = Joi.object({
  op: Joi.string().valid("upsert").default("upsert"),
  ukrId: Joi.string().pattern(/^\d{1,20}$/).required(),
  groupId: Joi.string().max(20).allow("").default(""),
  brand: Joi.string().max(200).allow("").default(""),
  code: Joi.string().max(200).allow("").default(""),
  name: Joi.string().max(600).allow("").default(""),
  pricePurchase: price,
  priceRetail: price,
  priceWholesale: price,
  priceSpecial1: price,
  priceSpecial2: price,
  priceSpecial3: price,
  amount: Joi.number().default(0),
  add: Joi.string().max(200).allow("").default(""),
  minimum: price,
  pack: price,
  supplier: Joi.string().max(200).allow("").default(""),
});
const deleteItem = Joi.object({
  op: Joi.string().valid("delete").required(),
  ukrId: Joi.string().pattern(/^\d{1,20}$/).required(),
});
const payloadSchema = Joi.array()
  .items(Joi.alternatives().try(deleteItem, upsertItem))
  .max(1000);

const productsCol = () => db.collection(`/artifacts/${APP_ID}/public/data/products`);

async function applyUpsert(it) {
  const brandRaw = str(it.brand || "N/A");
  const idRaw = it.code || "";
  if (!idRaw || !brandRaw || brandRaw === "N/A") return "skipped";

  const normalizedBrand = await normalizeBrand(brandRaw);
  const normalizedArticle = normalizeArticle(idRaw);
  if (!normalizedBrand || !normalizedArticle) return "skipped";

  const masterData = await getProductMasterData(normalizeBrandKey(normalizedBrand), normalizedArticle);
  const canonicalBrand = masterData?.brand ? masterData.brand : normalizedBrand;
  const idToUse = masterData ? masterData.id : idRaw;
  const stock = it.amount <= 0 ? 0 : it.amount;

  const docId = await upsertProduct({
    supplier: SUPPLIER,
    brand: canonicalBrand,
    id: idToUse,
    name: masterData?.correctName || str(it.name),
    stock,
    publicPrices: {
      "роздріб": it.priceRetail,
      "ціна опт": it.priceWholesale,
      "ціна 1": it.priceSpecial1,
      "ціна 2": it.priceSpecial2,
      "ціна 3": it.priceSpecial3,
    },
    categories: masterData?.categories || null,
    pack: masterData?.pack || null,
    tolerances: masterData?.tolerances || null,
    synonyms: masterData?.synonyms || [],
    ukrSkladId: str(it.ukrId),
    ukrSkladGroupId: str(it.groupId),
    minStock: it.minimum,
    lastSupplier: it.supplier,
    // не створюємо нові товари з нульовим залишком
    createIfMissing: stock > 0,
  });
  return docId ? "upserted" : "skippedZero";
}

async function applyDelete(it) {
  const snap = await productsCol().where("ukrSkladId", "==", String(it.ukrId)).limit(1).get();
  if (snap.empty) return "skipped";
  const p = snap.docs[0].data();
  if (!(p.offers || []).some((o) => o.supplier === SUPPLIER)) return "skipped";
  await removeProduct({ supplier: SUPPLIER, id: p.id, brand: p.brand });
  return "deleted";
}

async function apply(items) {
  const result = { upserted: 0, deleted: 0, skipped: 0, skippedZero: 0, failed: 0 };
  const CONCURRENCY = 10;
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const part = items.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      part.map((it) => (it.op === "delete" ? applyDelete(it) : applyUpsert(it)))
    );
    settled.forEach((s, j) => {
      if (s.status === "fulfilled") {
        result[s.value] = (result[s.value] || 0) + 1;
      } else {
        result.failed++;
        logger.error("productsMain item failed", { ukrId: part[j].ukrId, error: String(s.reason?.message || s.reason) });
      }
    });
  }
  if (result.failed > 0) {
    // агент не позначить пакет як доставлений і повторить усі позиції
    throw new Error(`productsMain: ${result.failed} item(s) failed`);
  }
  return result;
}

module.exports = { name: "productsMain", payloadSchema, apply };
