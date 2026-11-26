// functions/ukrModules/currencyRates.js
// Курс UAH→EUR з UkrSklad через локальний агент (ukrIngest), замість currency.csv на Google Drive.
// Агент шле рядки валют: id=2 / code=UAH — це курс до базової (EUR), як у старому CSV.
const Joi = require("joi");
const logger = require("firebase-functions/logger");
const { FieldValue } = require("firebase-admin/firestore");
const { db, APP_ID } = require("../shared");

const rateValue = Joi.alternatives().try(
  Joi.number().positive().max(1e6),
  Joi.string().max(20)
);

const itemSchema = Joi.object({
  id: Joi.alternatives().try(Joi.string().max(20), Joi.number()).optional(),
  code: Joi.string().max(8).allow("").optional(),
  name: Joi.string().max(80).allow("").optional(),
  rate: rateValue.required(),
}).required();

const payloadSchema = Joi.array().items(itemSchema).min(1).max(50);

function parseRate(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value.trim().replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function pickUahRate(items) {
  const rows = (Array.isArray(items) ? items : []).map((it) => ({
    ...it,
    rate: parseRate(it && it.rate),
  }));
  const byCode = rows.find((it) => String(it.code || "").trim().toUpperCase() === "UAH" && it.rate > 0);
  if (byCode) return byCode.rate;
  const byId = rows.find((it) => String(it.id ?? "").trim() === "2" && it.rate > 0);
  if (byId) return byId.rate;
  if (rows.length === 1 && rows[0].rate > 0) return rows[0].rate;
  return null;
}

/** Курс на конверті запиту, не всередині рядків товарів. */
function rateFromEnvelope(body) {
  if (!body || typeof body !== "object") return null;
  for (const key of ["uahRate", "currencyRate", "uahToEur", "kurs"]) {
    const n = parseRate(body[key]);
    if (n > 5 && n < 500) return n;
  }
  return null;
}

async function applyRate(rate, sourceFile) {
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
      sourceFile: sourceFile || "agent",
      lastSyncTime: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  // Прапорець: розклад currencyRatesSync з Drive більше не перезаписує курс
  await syncStateRef.set({ currencySource: "agent" }, { merge: true });

  logger.info("currencyRates from agent", { rate, previous, sourceFile });
  return { rate, previous, updated: previous == null || Math.abs(previous - rate) >= 1e-9 };
}

async function apply(items) {
  return applyRate(pickUahRate(items), "agent");
}

module.exports = {
  name: "currencyRates",
  payloadSchema,
  apply,
  parseRate,
  pickUahRate,
  rateFromEnvelope,
  applyRate,
};
