// Перерахунок бейджів замовлень з реальних документів.
// Інкремент у placeOrder роз’їжджався, коли статус міняли поза тією транзакцією.
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const { FieldValue } = require("firebase-admin/firestore");
const { db, APP_ID } = require("./shared");

const REGION = process.env.FUNCTION_REGION || "europe-central2";

function ordersCol() {
  return db.collection(`/artifacts/${APP_ID}/public/data/orders`);
}

async function countOpen(status) {
  const snap = await ordersCol()
    .where("status", "==", status)
    .where("archived", "==", false)
    .count()
    .get();
  return Number(snap.data().count) || 0;
}

async function recountOrderBadges() {
  const [nextNew, partial] = await Promise.all([
    countOpen("Нове"),
    countOpen("Частково виконано"),
  ]);
  const counts = { new: nextNew, partial };
  await db.doc(`/artifacts/${APP_ID}/public/meta/counters/orderCounts`).set(
    { ...counts, lastUpdated: FieldValue.serverTimestamp() },
    { merge: true }
  );
  return counts;
}

exports.recountOrderBadges = recountOrderBadges;

exports.onOrderCountsSync = onDocumentWritten(
  {
    document: `artifacts/${APP_ID}/public/data/orders/{orderId}`,
    region: REGION,
  },
  async (event) => {
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    const mark = (row) => (row ? `${row.status || ""}|${row.archived === true}` : "");
    if (mark(before) === mark(after)) return;
    try {
      const counts = await recountOrderBadges();
      logger.info("order badge recount", { orderId: event.params.orderId, ...counts });
    } catch (e) {
      logger.error("order badge recount failed", { orderId: event.params.orderId, error: e.message });
    }
  }
);
