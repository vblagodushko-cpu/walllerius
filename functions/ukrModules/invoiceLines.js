// functions/ukrModules/invoiceLines.js
// Рядки видаткових накладних з UkrSklad (заміна CSV на Google Drive для getDocDetails).
// Одна накладна = один документ у ПРИВАТНІЙ колекції (клієнт напряму її не читає, лише callable getDocDetails
// після перевірки, що накладна є в журналі взаєморозрахунків цього клієнта):
//   /artifacts/{APP_ID}/private/data/invoiceLines/{docId}  (docId = VNAKL.NUM = docId з журналу)
const Joi = require("joi");
const { FieldValue } = require("firebase-admin/firestore");
const { db, APP_ID } = require("../shared");

const str = (max) => Joi.string().max(max).allow("").default("");
const lineSchema = Joi.object({
  code: str(60),
  name: str(250),
  qty: Joi.number().min(-1e9).max(1e9).required(),
  price: Joi.number().min(-1e9).max(1e9).required(),
  discount: Joi.number().min(-1e9).max(1e9).default(0),
  sum: Joi.number().min(-1e12).max(1e12).required(),
  unit: str(20),
});

const upsertSchema = Joi.object({
  op: Joi.string().valid("upsert").required(),
  docId: Joi.string().pattern(/^\d{1,20}$/).required(),
  clientId: Joi.string().pattern(/^\d{1,12}$/).required(),
  currency: Joi.string().valid("EUR", "USD", "UAH").required(),
  docNumber: Joi.string().max(60).required(),
  date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
  lines: Joi.array().items(lineSchema).max(1000).required(),
});
const deleteSchema = Joi.object({
  op: Joi.string().valid("delete").required(),
  docId: Joi.string().pattern(/^\d{1,20}$/).required(),
});

const payloadSchema = Joi.array().items(Joi.alternatives().try(upsertSchema, deleteSchema)).max(500);

const BATCH = 200;

async function apply(items) {
  const col = db.collection(`/artifacts/${APP_ID}/private/data/invoiceLines`);
  let upserted = 0;
  let deleted = 0;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = db.batch();
    for (const it of items.slice(i, i + BATCH)) {
      const ref = col.doc(it.docId);
      if (it.op === "delete") {
        batch.delete(ref);
        deleted += 1;
      } else {
        batch.set(ref, {
          clientId: it.clientId,
          currency: it.currency,
          docNumber: it.docNumber,
          date: it.date,
          lines: it.lines,
          updatedAt: FieldValue.serverTimestamp(),
        });
        upserted += 1;
      }
    }
    await batch.commit();
  }
  return { upserted, deleted };
}

module.exports = { name: "invoiceLines", payloadSchema, apply };
