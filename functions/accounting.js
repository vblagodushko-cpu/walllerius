// functions/accounting.js — API сторінки бухгалтера (/buh). Приватні колекції читаються тільки тут.
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { Timestamp } = require("firebase-admin/firestore");
const Joi = require("joi");
const { db, APP_ID } = require("./shared");
const { DOC_COLLECTIONS } = require("./ukrModules/docsFop");

const REGION = process.env.FUNCTION_REGION || "europe-central2";

/** Зараз: admin. Пізніше роль бухгалтера: custom claim accountant === true. */
function isAccountingReq(request) {
  const t = request?.auth?.token;
  return !!t && (t.admin === true || t.accountant === true);
}
function assertAccounting(request) {
  if (!isAccountingReq(request)) {
    throw new HttpsError("permission-denied", "Немає доступу.");
  }
}

const ymd = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);
const listSchema = Joi.object({
  docType: Joi.string().valid(...Object.keys(DOC_COLLECTIONS)).required(),
  from: ymd.allow(null, ""),
  to: ymd.allow(null, ""),
  pageSize: Joi.number().integer().min(1).max(200).default(50),
  cursor: Joi.string().pattern(/^\d{1,20}$/).allow(null, ""),
});
const linesSchema = Joi.object({
  docType: Joi.string().valid(...Object.keys(DOC_COLLECTIONS)).required(),
  ukrDocId: Joi.string().pattern(/^\d{1,20}$/).required(),
});

const col = (docType) =>
  db.collection(`/artifacts/${APP_ID}/private/data/${DOC_COLLECTIONS[docType]}`);

function validate(schema, data) {
  const { value, error } = schema.validate(data || {}, { stripUnknown: true });
  if (error) throw new HttpsError("invalid-argument", "Некоректні параметри.");
  return value;
}
const dayStart = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return Timestamp.fromDate(new Date(Date.UTC(y, m - 1, d, 0, 0, 0)));
};
const dayEnd = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return Timestamp.fromDate(new Date(Date.UTC(y, m - 1, d, 23, 59, 59)));
};

/** getAccountingDocs: сторінка документів типу за діапазоном дат (getDocs + limit + startAfter). */
exports.getAccountingDocs = onCall({ region: REGION, cors: true }, async (request) => {
  assertAccounting(request);
  const { docType, from, to, pageSize, cursor } = validate(listSchema, request.data);

  let q = col(docType);
  if (from) q = q.where("date", ">=", dayStart(from));
  if (to) q = q.where("date", "<=", dayEnd(to));
  q = q.orderBy("date", "desc");

  if (cursor) {
    const cursorSnap = await col(docType).doc(cursor).get();
    if (cursorSnap.exists) q = q.startAfter(cursorSnap);
  }

  const snap = await q.limit(pageSize).get();
  const items = snap.docs.map((d) => {
    const x = d.data();
    return {
      ukrDocId: d.id,
      number: x.number,
      dateStr: x.dateStr,
      clientId: x.clientId,
      clientName: x.clientName,
      sum: x.sum,
      sumBase: x.sumBase,
      sumPdv: x.sumPdv,
      pdvAmount: x.pdvAmount ?? (x.sumPdv != null && x.sum != null ? Math.round((x.sumPdv - x.sum) * 100) / 100 : null),
      currency: x.currency,
      paid: x.paid === true,
      linesCount: x.linesCount || 0,
    };
  });

  let sync = null;
  if (!cursor) {
    const s = await db.doc(`/artifacts/${APP_ID}/private/data/accSync/docsFop`).get();
    const at = s.exists ? s.data().lastIngestAt : null;
    sync = { lastIngestAtMs: at?.toMillis ? at.toMillis() : null };
  }

  return {
    items,
    nextCursor: snap.size === pageSize ? snap.docs[snap.docs.length - 1].id : null,
    sync,
  };
});

/** getAccountingStock: залишки складу БЕЗГОТІВКА (приватна колекція accStockBeznal). */
exports.getAccountingStock = onCall({ region: REGION, cors: true }, async (request) => {
  assertAccounting(request);
  const [snap, syncSnap] = await Promise.all([
    db.collection(`/artifacts/${APP_ID}/private/data/accStockBeznal`).orderBy("name").limit(1000).get(),
    db.doc(`/artifacts/${APP_ID}/private/data/accSync/stockBeznal`).get(),
  ]);
  const items = snap.docs.map((d) => {
    const x = d.data();
    return {
      tovarId: d.id,
      kod: x.kod || "",
      name: x.name || "",
      unit: x.unit || "",
      qty: x.qty ?? 0,
      costPrice: x.costPrice ?? null,
      costPricePdv: x.costPricePdv ?? null,
      sumCost: x.sumCost ?? null,
      sumCostPdv: x.sumCostPdv ?? null,
      lastReceiptDate: x.lastReceiptDate || "",
      lastReceiptNumber: x.lastReceiptNumber || "",
      costConverted: x.costConverted === true,
    };
  });
  const at = syncSnap.exists ? syncSnap.data().lastIngestAt : null;
  return { items, sync: { lastIngestAtMs: at?.toMillis ? at.toMillis() : null } };
});

/** getAccountingDocLines: рядки одного документа. */
exports.getAccountingDocLines = onCall({ region: REGION, cors: true }, async (request) => {
  assertAccounting(request);
  const { docType, ukrDocId } = validate(linesSchema, request.data);
  const snap = await col(docType).doc(ukrDocId).collection("lines").orderBy("lineNum").limit(1000).get();
  return {
    lines: snap.docs.map((d) => {
      const x = d.data();
      return {
        lineNum: x.lineNum,
        tovarId: x.tovarId,
        name: x.name,
        qty: x.qty,
        price: x.price,
        pricePdv: x.pricePdv ?? null,
        sum: x.sum,
        sumPdv: x.sumPdv ?? null,
        pdvSum: x.pdvSum ?? null,
        unit: x.unit,
      };
    }),
  };
});
