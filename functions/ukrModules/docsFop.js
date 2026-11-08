// functions/ukrModules/docsFop.js
// Документи фірми «ФОП Благодушко» з UkrSklad: видаткові, прибуткові, рахунки-фактури.
// Приватні колекції: /artifacts/{APP_ID}/private/data/accDocs_<type>/{ukrDocId}
//   підколекція lines/{0001..}
const Joi = require("joi");
const { Timestamp, FieldValue } = require("firebase-admin/firestore");
const { db, APP_ID } = require("../shared");

const DOC_COLLECTIONS = {
  vydatkova: "accDocs_vydatkova",
  prybutkova: "accDocs_prybutkova",
  rakhunok: "accDocs_rakhunok",
};

const lineSchema = Joi.object({
  lineNum: Joi.number().integer().min(1).max(9999).required(),
  tovarId: Joi.string().max(30).allow("").required(),
  name: Joi.string().max(300).allow("").required(),
  qty: Joi.number().required(),
  price: Joi.number().allow(null).required(),
  pricePdv: Joi.number().allow(null).optional(),
  sum: Joi.number().allow(null).required(),
  sumPdv: Joi.number().allow(null).optional(),
  pdvSum: Joi.number().allow(null).optional(),
  unit: Joi.string().max(30).allow("").default(""),
});

const upsertSchema = Joi.object({
  op: Joi.string().valid("upsert").required(),
  docType: Joi.string().valid(...Object.keys(DOC_COLLECTIONS)).required(),
  ukrDocId: Joi.string().pattern(/^\d{1,20}$/).required(),
  number: Joi.string().max(60).allow("").required(),
  date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
  clientId: Joi.string().max(30).allow("").required(),
  clientName: Joi.string().max(300).allow("").required(),
  sum: Joi.number().allow(null).required(),
  sumBase: Joi.number().allow(null).required(),
  sumPdv: Joi.number().allow(null).required(),
  pdvAmount: Joi.number().allow(null).optional(),
  currency: Joi.string().max(8).allow("").required(),
  paid: Joi.boolean().required(),
  modifyTime: Joi.string().max(40).allow("").required(),
  hash: Joi.string().max(64).required(),
  lines: Joi.array().items(lineSchema).max(1000).required(),
});

const deleteSchema = Joi.object({
  op: Joi.string().valid("delete").required(),
  docType: Joi.string().valid(...Object.keys(DOC_COLLECTIONS)).required(),
  ukrDocId: Joi.string().pattern(/^\d{1,20}$/).required(),
});

const itemSchema = Joi.alternatives().try(upsertSchema, deleteSchema);
const payloadSchema = Joi.array().items(itemSchema).max(200);

const col = (docType) =>
  db.collection(`/artifacts/${APP_ID}/private/data/${DOC_COLLECTIONS[docType]}`);
const pad = (n) => String(n).padStart(4, "0");

function dateToTimestamp(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return Timestamp.fromDate(new Date(Date.UTC(y, m - 1, d, 12, 0, 0)));
}

function parseModifyTime(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? null : Timestamp.fromDate(d);
}

/** Пакетний запис із лімітом операцій. */
function makeWriter() {
  let batch = db.batch();
  let ops = 0;
  const LIMIT = 400;
  const flushes = [];
  const add = (fn) => {
    fn(batch);
    ops++;
    if (ops >= LIMIT) {
      flushes.push(batch.commit());
      batch = db.batch();
      ops = 0;
    }
  };
  const finish = async () => {
    if (ops > 0) flushes.push(batch.commit());
    await Promise.all(flushes);
  };
  return { add, finish };
}

async function apply(items) {
  const result = { upserted: 0, skipped: 0, deleted: 0 };
  const upserts = items.filter((i) => i.op === "upsert");
  const deletes = items.filter((i) => i.op === "delete");

  // існуючі шапки (hash, linesCount) - одним getAll
  const refs = upserts.map((i) => col(i.docType).doc(i.ukrDocId));
  const existing = new Map();
  for (let i = 0; i < refs.length; i += 300) {
    const snaps = await db.getAll(...refs.slice(i, i + 300));
    snaps.forEach((s) => {
      if (s.exists) existing.set(s.ref.path, s.data());
    });
  }

  const writer = makeWriter();
  upserts.forEach((item, idx) => {
    const ref = refs[idx];
    const old = existing.get(ref.path);
    const linesVer = 2;
    const needLineRefresh = (old?.linesSchemaVersion ?? 1) < linesVer;
    if (old && old.hash === item.hash && !needLineRefresh) {
      result.skipped++;
      return;
    }
    const header = {
      docType: item.docType,
      ukrDocId: item.ukrDocId,
      number: item.number,
      date: dateToTimestamp(item.date),
      dateStr: item.date,
      clientId: item.clientId,
      clientName: item.clientName,
      sum: item.sum,
      sumBase: item.sumBase,
      sumPdv: item.sumPdv,
      pdvAmount: item.pdvAmount ?? null,
      currency: item.currency,
      paid: item.paid,
      modifyTime: parseModifyTime(item.modifyTime),
      hash: item.hash,
      linesCount: item.lines.length,
      linesSchemaVersion: linesVer,
      updatedAt: FieldValue.serverTimestamp(),
    };
    writer.add((b) => b.set(ref, header));
    for (const l of item.lines) {
      writer.add((b) =>
        b.set(ref.collection("lines").doc(pad(l.lineNum)), {
          lineNum: l.lineNum,
          tovarId: l.tovarId,
          name: l.name,
          qty: l.qty,
          price: l.price,
          pricePdv: l.pricePdv ?? null,
          sum: l.sum,
          sumPdv: l.sumPdv ?? null,
          pdvSum: l.pdvSum ?? null,
          unit: l.unit,
        })
      );
    }
    // прибрати зайві старі рядки, якщо документ став коротшим
    const oldCount = Number(old?.linesCount) || 0;
    for (let n = item.lines.length + 1; n <= oldCount; n++) {
      writer.add((b) => b.delete(ref.collection("lines").doc(pad(n))));
    }
    result.upserted++;
  });
  await writer.finish();

  for (const item of deletes) {
    await db.recursiveDelete(col(item.docType).doc(item.ukrDocId));
    result.deleted++;
  }
  return result;
}

module.exports = {
  name: "docsFop",
  DOC_COLLECTIONS,
  payloadSchema,
  apply,
};
