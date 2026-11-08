/**
 * М'яке резервування складу «Мій склад».
 * - warehouseReserved на корені products (синк offers його не затирає)
 * - журнал /private/data/reservations/{orderId}
 * - placeOrderV2 атомарно резервує; тригер синхронізує зміни статусів рядків
 */
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const { db, APP_ID, FieldValue } = require("./shared");

const REGION = process.env.FUNCTION_REGION || "europe-central2";
const WAREHOUSE = "Мій склад";
const OPEN_STATUSES = new Set(["Нове", "Частково виконано"]);

function reservationsCol() {
  return db.collection(`/artifacts/${APP_ID}/private/data/reservations`);
}
function reservationsRef(orderId) {
  return reservationsCol().doc(String(orderId));
}
function productRef(docId) {
  return db.doc(`/artifacts/${APP_ID}/public/data/products/${docId}`);
}

function availableFromProductData(data) {
  const offer = (data?.offers || []).find((o) => o?.supplier === WAREHOUSE);
  const stock = Number(offer?.stock) || 0;
  const reserved = Number(data?.warehouseReserved) || 0;
  return Math.max(0, stock - reserved);
}

/**
 * Скільки зараз має утримуватись під замовлення (по docId).
 * 0 якщо замовлення закрите/видалене або рядок «Виконано»/повністю скасований.
 */
function computeHeldMap(orderData) {
  const map = {};
  if (!orderData) return map;
  if (orderData.archived === true) return map;
  const status = orderData.status || "";
  if (!OPEN_STATUSES.has(status)) return map;

  for (const it of orderData.items || []) {
    if (!it || it.supplier !== WAREHOUSE || !it.docId) continue;
    if (it.lineStatus === "Виконано") continue;
    const qty = Number(it.quantity) || 0;
    const cancelled = Number(it.quantityCancelled) || 0;
    const active = Math.max(0, qty - cancelled);
    if (active <= 0) continue;
    const reservedQty = Number(it.reservedQty) || 0;
    const held = Math.min(reservedQty, active);
    if (held <= 0) continue;
    const id = String(it.docId);
    map[id] = (map[id] || 0) + held;
  }
  return map;
}

/**
 * Ідемпотентно підганяє журнал і warehouseReserved під desiredMap.
 */
async function applyReservationDiff(orderId, desiredMap) {
  const journalRef = reservationsRef(orderId);
  const desired = desiredMap || {};

  await db.runTransaction(async (tx) => {
    const jSnap = await tx.get(journalRef);
    const current = jSnap.exists ? (jSnap.data().items || {}) : {};
    const allIds = new Set([...Object.keys(current), ...Object.keys(desired)]);

    const deltas = [];
    for (const docId of allIds) {
      const cur = Number(current[docId]) || 0;
      const des = Number(desired[docId]) || 0;
      const delta = des - cur;
      if (delta !== 0) deltas.push({ docId, delta, ref: productRef(docId) });
    }

    for (const d of deltas) {
      d.snap = await tx.get(d.ref);
    }

    for (const d of deltas) {
      const prev = d.snap.exists ? Number(d.snap.data().warehouseReserved) || 0 : 0;
      const next = Math.max(0, Math.round((prev + d.delta) * 1000) / 1000);
      tx.set(d.ref, { warehouseReserved: next }, { merge: true });
    }

    if (Object.keys(desired).length === 0) {
      if (jSnap.exists) tx.delete(journalRef);
    } else {
      tx.set(
        journalRef,
        { items: desired, updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
    }
  });
}

/**
 * Атомарно резервує під нові рядки всередині tx (усі product snaps уже прочитані).
 * Мутує orderItems (reservedQty). Повертає map для журналу.
 */
function claimReservationsInTx(tx, orderItems, productSnapsByDocId) {
  const demand = {};
  for (const it of orderItems) {
    if (it.supplier !== WAREHOUSE || !it.docId) {
      it.reservedQty = 0;
      continue;
    }
    const id = String(it.docId);
    demand[id] = (demand[id] || 0) + (Number(it.quantity) || 0);
  }

  const claimed = {};
  for (const [docId, want] of Object.entries(demand)) {
    const snap = productSnapsByDocId.get(docId);
    if (!snap || !snap.exists) {
      claimed[docId] = 0;
      continue;
    }
    const data = snap.data();
    const take = Math.min(want, availableFromProductData(data));
    claimed[docId] = take;
    if (take > 0) {
      const prev = Number(data.warehouseReserved) || 0;
      tx.set(productRef(docId), { warehouseReserved: prev + take }, { merge: true });
    }
  }

  const remaining = { ...claimed };
  const journal = {};
  for (const it of orderItems) {
    if (it.supplier !== WAREHOUSE || !it.docId) continue;
    const id = String(it.docId);
    const qty = Number(it.quantity) || 0;
    const left = remaining[id] || 0;
    const give = Math.min(qty, left);
    it.reservedQty = give;
    remaining[id] = left - give;
    if (give > 0) journal[id] = (journal[id] || 0) + give;
  }
  return journal;
}

/** Тригер: будь-яка зміна/видалення замовлення підганяє резерв. */
exports.onOrderReservationSync = onDocumentWritten(
  {
    document: `artifacts/${APP_ID}/public/data/orders/{orderId}`,
    region: REGION,
    retry: true,
  },
  async (event) => {
    const orderId = event.params.orderId;
    try {
      const after = event.data?.after;
      const desired = after?.exists ? computeHeldMap(after.data()) : {};
      await applyReservationDiff(orderId, desired);
    } catch (e) {
      logger.error("onOrderReservationSync failed", {
        orderId,
        error: String(e && e.message || e),
      });
      throw e;
    }
  }
);

/** Нічна звірка: журнали відкритих замовлень + сироти + абсолютний warehouseReserved. */
exports.reconcileReservations = onSchedule(
  {
    schedule: "30 3 * * *",
    timeZone: "Europe/Kyiv",
    region: REGION,
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async () => {
    const ordersCol = db.collection(`/artifacts/${APP_ID}/public/data/orders`);
    let synced = 0;
    let cleared = 0;

    for (const st of OPEN_STATUSES) {
      let last = null;
      for (;;) {
        let q = ordersCol.where("status", "==", st).orderBy("__name__").limit(100);
        if (last) q = q.startAfter(last);
        const snap = await q.get();
        if (snap.empty) break;
        for (const d of snap.docs) {
          await applyReservationDiff(d.id, computeHeldMap(d.data()));
          synced += 1;
        }
        last = snap.docs[snap.docs.length - 1];
        if (snap.size < 100) break;
      }
    }

    // Сироти: журнал без відкритого замовлення
    let resLast = null;
    for (;;) {
      let q = reservationsCol().orderBy("__name__").limit(100);
      if (resLast) q = q.startAfter(resLast);
      const snap = await q.get();
      if (snap.empty) break;
      for (const d of snap.docs) {
        const orderSnap = await ordersCol.doc(d.id).get();
        const held = orderSnap.exists ? computeHeldMap(orderSnap.data()) : {};
        if (Object.keys(held).length === 0) {
          await applyReservationDiff(d.id, {});
          cleared += 1;
        }
      }
      resLast = snap.docs[snap.docs.length - 1];
      if (snap.size < 100) break;
    }

    // Абсолютна сума з журналів → warehouseReserved
    const totals = {};
    let jLast = null;
    for (;;) {
      let q = reservationsCol().orderBy("__name__").limit(200);
      if (jLast) q = q.startAfter(jLast);
      const snap = await q.get();
      if (snap.empty) break;
      for (const d of snap.docs) {
        const items = d.data().items || {};
        for (const [docId, qty] of Object.entries(items)) {
          totals[docId] = (totals[docId] || 0) + (Number(qty) || 0);
        }
      }
      jLast = snap.docs[snap.docs.length - 1];
      if (snap.size < 200) break;
    }

    let fixedProducts = 0;
    const docIds = Object.keys(totals);
    for (let i = 0; i < docIds.length; i += 40) {
      const chunk = docIds.slice(i, i + 40);
      const refs = chunk.map((id) => productRef(id));
      const snaps = await db.getAll(...refs);
      const batch = db.batch();
      let batchN = 0;
      for (let k = 0; k < snaps.length; k++) {
        const want = Math.max(0, totals[chunk[k]] || 0);
        const have = snaps[k].exists ? Number(snaps[k].data().warehouseReserved) || 0 : 0;
        if (have === want) continue;
        batch.set(refs[k], { warehouseReserved: want }, { merge: true });
        batchN += 1;
        fixedProducts += 1;
      }
      if (batchN) await batch.commit();
    }

    logger.info("reconcileReservations done", { synced, cleared, fixedProducts, journalProducts: docIds.length });
  }
);

module.exports.WAREHOUSE_SUPPLIER = WAREHOUSE;
module.exports.computeHeldMap = computeHeldMap;
module.exports.applyReservationDiff = applyReservationDiff;
module.exports.availableFromProductData = availableFromProductData;
module.exports.claimReservationsInTx = claimReservationsInTx;
module.exports.reservationsRef = reservationsRef;
module.exports.productRef = productRef;
