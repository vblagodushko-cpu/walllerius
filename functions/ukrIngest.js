// functions/ukrIngest.js — прийом даних від локального агента UkrSklad (mini-wms).
// POST JSON: { module, agentVersion, items: [...] }, заголовок Authorization: Bearer <UKR_AGENT_TOKEN>
// Токен: firebase functions:secrets:set UKR_AGENT_TOKEN
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const crypto = require("crypto");
const { FieldValue } = require("firebase-admin/firestore");
const { db, APP_ID } = require("./shared");
const { modules } = require("./ukrModules");
const currencyRates = require("./ukrModules/currencyRates");

const MODULE_ALIASES = {
  currency: "currencyRates",
  currencies: "currencyRates",
  currencyRate: "currencyRates",
  valuta: "currencyRates",
  kurs: "currencyRates",
  rates: "currencyRates",
};

const REGION = process.env.FUNCTION_REGION || "europe-central2";
const UKR_AGENT_TOKEN = defineSecret("UKR_AGENT_TOKEN");

function tokenOk(headerValue, secret) {
  const m = /^Bearer\s+(.+)$/i.exec(String(headerValue || ""));
  if (!m || !secret) return false;
  const a = crypto.createHash("sha256").update(m[1].trim()).digest();
  const b = crypto.createHash("sha256").update(String(secret).trim()).digest();
  return crypto.timingSafeEqual(a, b);
}

exports.ukrIngest = onRequest(
  {
    region: REGION,
    cors: false,
    secrets: [UKR_AGENT_TOKEN],
    maxInstances: 2,
    timeoutSeconds: 300,
    memory: "512MiB",
  },
  async (req, res) => {
    // Уніфікована відповідь для будь-якої відмови доступу
    if (req.method !== "POST" || !tokenOk(req.get("authorization"), UKR_AGENT_TOKEN.value())) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }

    const body = req.body || {};
    const moduleName = String(body.module || "");
    const item0 = Array.isArray(body.items) ? body.items[0] : null;
    logger.info("ukrIngest request", {
      module: moduleName.slice(0, 40),
      keys: Object.keys(body).slice(0, 20),
      itemKeys: item0 && typeof item0 === "object" ? Object.keys(item0).slice(0, 30) : [],
      size: Array.isArray(body.items) ? body.items.length : null,
    });

    const envelopeRate = currencyRates.rateFromEnvelope(body);
    if (envelopeRate) {
      try {
        await currencyRates.applyRate(envelopeRate, "agent-envelope");
      } catch (e) {
        logger.warn("ukrIngest currency envelope failed", { message: e.message });
      }
    }

    const mod = modules[MODULE_ALIASES[moduleName] || moduleName];
    if (!mod) {
      logger.warn("ukrIngest unknown module", { module: moduleName.slice(0, 40) });
      res.status(400).json({ ok: false, error: "invalid_request" });
      return;
    }

    const { value: items, error } = mod.payloadSchema.validate(body.items, {
      abortEarly: true,
      stripUnknown: true,
    });
    if (error) {
      logger.warn("ukrIngest validation failed", { module: mod.name, message: error.message });
      res.status(400).json({ ok: false, error: "invalid_request", detail: error.message });
      return;
    }

    try {
      const result = await mod.apply(items);
      await db.doc(`/artifacts/${APP_ID}/private/data/accSync/${mod.name}`).set(
        {
          lastIngestAt: FieldValue.serverTimestamp(),
          agentVersion: String(body.agentVersion || "").slice(0, 40),
          lastBatchSize: items.length,
          lastResult: result,
        },
        { merge: true }
      );
      logger.info("ukrIngest ok", { module: mod.name, size: items.length, result });
      res.json({ ok: true, result });
    } catch (e) {
      logger.error("ukrIngest apply failed", { module: mod.name, error: e.message });
      res.status(500).json({ ok: false, error: "internal" });
    }
  }
);
