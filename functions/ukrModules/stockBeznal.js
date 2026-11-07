// functions/ukrModules/stockBeznal.js
// Залишки складу «БЕЗГОТІВКА» з UkrSklad (приватно, не потрапляє в каталог клієнтів).
// Колекція: /artifacts/{APP_ID}/private/data/accStockBeznal/{tovarId}
// Режим snapshot: агент надсилає повний поточний набір позицій із залишком > 0.
const Joi = require("joi");
const { FieldValue } = require("firebase-admin/firestore");
const { db, APP_ID } = require("../shared");

const itemSchema = Joi.object({
  tovarId: Joi.string().pattern(/^\d{1,20}$/).required(),
  name: Joi.string().max(300).allow("").required(),
  kod: Joi.string().max(100).allow("").default(""),
  qty: Joi.number().required(),
});
const payloadSchema = Joi.array().items(itemSchema).max(5000);

const stockCol = () => db.collection(`/artifacts/${APP_ID}/private/data/accStockBeznal`);
const productsCol = () => db.collection(`/artifacts/${APP_ID}/public/data/products`);

async function findProductDocId(tovarId) {
  // один where, без складеного індексу; id товару в Укрсклад = products.ukrSkladId
  const snap = await productsCol().where("ukrSkladId", "==", String(tovarId)).limit(1).get();
  return snap.empty ? null : snap.docs[0].id;
}

async function apply(items) {
  const result = { upserted: 0, skipped: 0, deleted: 0 };
  const incoming = new Map(
    items.filter((i) => Number(i.qty) > 0).map((i) => [i.tovarId, i])
  );

  const existingSnap = await stockCol().get();
  const existing = new Map(existingSnap.docs.map((d) => [d.id, d.data()]));

  let batch = db.batch();
  let ops = 0;
  const commits = [];
  const push = (fn) => {
    fn(batch);
    if (++ops >= 400) {
      commits.push(batch.commit());
      batch = db.batch();
      ops = 0;
    }
  };

  for (const [tovarId, item] of incoming) {
    const old = existing.get(tovarId);
    if (old && old.qty === item.qty && old.name === item.name && old.kod === item.kod) {
      result.skipped++;
      continue;
    }
    const productDocId = old?.productDocId ?? (await findProductDocId(tovarId));
    push((b) =>
      b.set(stockCol().doc(tovarId), {
        tovarId,
        name: item.name,
        kod: item.kod,
        qty: item.qty,
        productDocId: productDocId || null,
        updatedAt: FieldValue.serverTimestamp(),
      })
    );
    result.upserted++;
  }

  for (const id of existing.keys()) {
    if (!incoming.has(id)) {
      push((b) => b.delete(stockCol().doc(id)));
      result.deleted++;
    }
  }

  if (ops > 0) commits.push(batch.commit());
  await Promise.all(commits);
  return result;
}

module.exports = {
  name: "stockBeznal",
  payloadSchema,
  apply,
};
