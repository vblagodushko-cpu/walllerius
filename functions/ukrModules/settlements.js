// functions/ukrModules/settlements.js
// Взаєморозрахунки з клієнтами з UkrSklad (заміна CSV на Google Drive + settlementsSyncIncremental).
// Агент шле по журналу (клієнт + валюта): змінені операції (upserts), видалені ключі (deletes),
// баланс і кількість (в останній частині), а для нового журналу ще allKeys (прибрати зайве зі старого синку).
// Схема Firestore та ключі операцій (YYYYMMDD-КОД-id) ті самі, що в settlements.js, тож портал не змінюється;
// додається поле balanceAfter (накопичене сальдо після операції).
const Joi = require("joi");
const logger = require("firebase-functions/logger");
const { FieldValue } = require("firebase-admin/firestore");
const { db, APP_ID } = require("../shared");

const KEY = Joi.string().pattern(/^\d{8}-[A-Z]{1,12}-\d{1,20}$/);
const money = Joi.number().min(-1e12).max(1e12).required();

const opSchema = Joi.object({
  key: KEY.required(),
  seq: Joi.number().integer().min(1).required(),
  date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
  docNumber: Joi.string().max(60).allow("").default(""),
  docType: Joi.string().max(100).required(),
  docCode: Joi.string().valid("VNAKL", "PKAS", "VKAS", "VZNAKL", "PNAKL").required(),
  docId: Joi.string().pattern(/^\d{1,20}$/).required(),
  expense: money,
  income: money,
  delta: money,
  balanceAfter: money,
});

const ledgerItem = Joi.object({
  clientId: Joi.string().pattern(/^\d{1,12}$/).required(),
  currency: Joi.string().valid("EUR", "USD", "UAH").required(),
  upserts: Joi.array().items(opSchema).max(500).default([]),
  deletes: Joi.array().items(KEY).max(500).default([]),
  balance: Joi.number().min(-1e12).max(1e12),
  count: Joi.number().integer().min(0),
  allKeys: Joi.array().items(KEY).max(50000),
});

const payloadSchema = Joi.array().items(ledgerItem).max(500);

const BATCH = 400;

function noonUtc(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

async function commitOps(ops) {
  for (let i = 0; i < ops.length; i += BATCH) {
    const batch = db.batch();
    for (const fn of ops.slice(i, i + BATCH)) fn(batch);
    await batch.commit();
  }
}

async function applyLedger(it, totals) {
  const base = db.collection(`/artifacts/${APP_ID}/public/data/settlements`).doc(it.clientId);
  const ledgerCol = base.collection(`ledger-${it.currency}`);
  const balanceRef = base.collection("balances").doc(it.currency);
  const ops = [];

  // Новий журнал: старі документи, яких немає в агента (напр. непроведені), прибираємо
  if (Array.isArray(it.allKeys)) {
    const keep = new Set(it.allKeys);
    const existing = await ledgerCol.select().get();
    existing.forEach((d) => {
      if (!keep.has(d.id)) {
        ops.push((b) => b.delete(d.ref));
        totals.orphans += 1;
      }
    });
  }
  for (const k of it.deletes) {
    ops.push((b) => b.delete(ledgerCol.doc(k)));
    totals.deleted += 1;
  }
  for (const o of it.upserts) {
    ops.push((b) =>
      b.set(
        ledgerCol.doc(o.key),
        {
          seq: o.seq,
          date: noonUtc(o.date),
          docNumber: o.docNumber,
          docType: o.docType,
          docCode: o.docCode,
          docId: o.docId,
          expense: o.expense,
          income: o.income,
          delta: o.delta,
          balanceAfter: o.balanceAfter,
          currency: it.currency,
          clientCode: it.clientId,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
    );
    totals.upserted += 1;
  }
  await commitOps(ops);

  if (it.balance !== undefined) {
    await balanceRef.set(
      {
        balance: it.balance,
        count: it.count ?? null,
        lastImportedAt: FieldValue.serverTimestamp(),
        sourceFile: "agent",
        clientCode: it.clientId,
        currency: it.currency,
      },
      { merge: true }
    );
    totals.balances += 1;
  }
}

async function apply(items) {
  const totals = { ledgers: items.length, upserted: 0, deleted: 0, orphans: 0, balances: 0 };
  const CONCURRENCY = 4;
  // Частини одного журналу мають іти по порядку - групуємо по ключу (клієнт|валюта)
  const byLedger = new Map();
  for (const it of items) {
    const k = `${it.clientId}|${it.currency}`;
    if (!byLedger.has(k)) byLedger.set(k, []);
    byLedger.get(k).push(it);
  }
  const groups = [...byLedger.values()];
  let failed = 0;
  for (let i = 0; i < groups.length; i += CONCURRENCY) {
    const part = groups.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      part.map(async (list) => {
        for (const it of list) await applyLedger(it, totals);
      })
    );
    settled.forEach((s, j) => {
      if (s.status === "rejected") {
        failed += 1;
        logger.error("settlements ledger failed", {
          clientId: part[j][0].clientId,
          currency: part[j][0].currency,
          error: String(s.reason?.message || s.reason),
        });
      }
    });
  }
  if (failed > 0) throw new Error(`settlements: ${failed} ledger(s) failed`);
  return totals;
}

module.exports = { name: "settlements", payloadSchema, apply };
