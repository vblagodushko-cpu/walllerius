// functions/ukrModules/currencyRates.js
// Курс UAH→EUR з UkrSklad через локальний агент (ukrIngest), замість currency.csv на Google Drive.
// Агент шле рядки валют: id=2 / code=UAH — це курс до базової (EUR), як у старому CSV.
const Joi = require("joi");
const logger = require("firebase-functions/logger");
const { FieldValue } = require("firebase-admin/firestore");
const { db, APP_ID } = require("../shared");

const itemSchema = Joi.object({
  id: Joi.alternatives().try(Joi.string().max(20), Joi.number()).optional(),
  code: Joi.string().max(8).allow("").optional(),
  name: Joi.string().max(80).allow("").optional(),
  rate: Joi.number().positive().max(1e6).required(),
}).required();

const payloadSchema = Joi.array().items(itemSchema).min(1).max(50);

function pickUahRate(items) {
  const byCode = items.find((it) => String(it.code || "").trim().toUpperCase() === "UAH");
  if (byCode) return Number(byCode.rate);
  const byId = items.find((it) => String(it.id ?? "").trim() === "2");
  if (byId) return Number(byId.rate);
  if (items.length === 1) return Number(items[0].rate);
  return null;
}

async function apply(items) {
  const rate = pickUahRate(items);
  if (!rate || !(rate > 0)) {
    throw new Error("currencyRates: немає рядка UAH (id=2 або code=UAH)");
  }

  const currencyRatesRef = db.doc(`/artifacts/${APP_ID}/public/meta/currencyRates/uahToEur`);
  const syncStateRef = db.doc(`/artifacts/${APP_ID}/public/meta/syncState/syncState`);
  const previousSnap = await currencyRatesRef.get();
  const previous = previousSnap.exists ? Number(previousSnap.data().rate) || null : null;

  await currencyRatesRef.set(
    {
      rate,
      updatedAt: FieldValue.serverTimestamp(),
      sourceFile: "agent",
      lastSyncTime: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  // Прапорець: розклад currencyRatesSync з Drive більше не перезаписує курс
  await syncStateRef.set({ currencySource: "agent" }, { merge: true });

  logger.info("currencyRates from agent", { rate, previous });
  return { rate, previous, updated: previous == null || Math.abs(previous - rate) >= 1e-9 };
}

module.exports = { name: "currencyRates", payloadSchema, apply };
