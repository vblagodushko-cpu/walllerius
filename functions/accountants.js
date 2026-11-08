// functions/accountants.js — керування єдиним бухгалтером (доступ до /buh). Тільки для адміна.
// Картка: /artifacts/{APP_ID}/private/data/accountantUser/current  { uid, email, disabled, updatedAt }
// Пароль зберігає лише Firebase Auth; у Firestore його немає.
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const Joi = require("joi");
const { db, APP_ID } = require("./shared");

const REGION = process.env.FUNCTION_REGION || "europe-central2";
const auth = getAuth();

const cardRef = () => db.doc(`/artifacts/${APP_ID}/private/data/accountantUser/current`);

function assertAdmin(request) {
  if (request?.auth?.token?.admin !== true) {
    throw new HttpsError("permission-denied", "Потрібен адмін-доступ.");
  }
}

const setSchema = Joi.object({
  email: Joi.string().trim().lowercase().email().max(200).required(),
  password: Joi.string().min(10).max(100).required(),
});

function validate(schema, data) {
  const { value, error } = schema.validate(data || {}, { stripUnknown: true });
  if (error) throw new HttpsError("invalid-argument", "Некоректні дані (пароль мінімум 10 символів).");
  return value;
}

/** Знімає роль бухгалтера з акаунта і вимикає його. Адмінські та клієнтські акаунти не чіпає. */
async function disableAccountant(uid) {
  let rec;
  try {
    rec = await auth.getUser(uid);
  } catch {
    return;
  }
  const { accountant, ...rest } = rec.customClaims || {};
  if (rest.admin === true || rest.clientCode) return;
  await auth.setCustomUserClaims(uid, rest);
  await auth.updateUser(uid, { disabled: true });
  await auth.revokeRefreshTokens(uid);
}

/** getAccountant: поточний бухгалтер (email + статус). */
exports.getAccountant = onCall({ region: REGION, cors: true }, async (request) => {
  assertAdmin(request);
  const snap = await cardRef().get();
  if (!snap.exists) return { accountant: null };
  const d = snap.data();
  return {
    accountant: {
      email: d.email || "",
      disabled: d.disabled === true,
      updatedAtMs: d.updatedAt?.toMillis ? d.updatedAt.toMillis() : null,
    },
  };
});

/** setAccountant: створити бухгалтера або скинути пароль (той самий email). */
exports.setAccountant = onCall({ region: REGION, cors: true }, async (request) => {
  assertAdmin(request);
  const { email, password } = validate(setSchema, request.data);

  let rec = null;
  try {
    rec = await auth.getUserByEmail(email);
  } catch (e) {
    if (e.code !== "auth/user-not-found") throw new HttpsError("internal", "Не вдалося зберегти.");
  }

  const claims = rec?.customClaims || {};
  if (rec && (claims.admin === true || claims.clientCode)) {
    throw new HttpsError("failed-precondition", "Цей email не можна використати для бухгалтера.");
  }

  // якщо раніше був інший бухгалтер — відкликаємо його
  const prev = await cardRef().get();
  if (prev.exists && prev.data().uid && (!rec || prev.data().uid !== rec.uid)) {
    await disableAccountant(prev.data().uid);
  }

  try {
    if (rec) {
      await auth.updateUser(rec.uid, { password, disabled: false });
    } else {
      rec = await auth.createUser({ email, password, disabled: false });
    }
    await auth.setCustomUserClaims(rec.uid, { ...claims, accountant: true });
    await auth.revokeRefreshTokens(rec.uid);
  } catch {
    throw new HttpsError("internal", "Не вдалося зберегти.");
  }

  await cardRef().set({
    uid: rec.uid,
    email,
    disabled: false,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { ok: true };
});

/** revokeAccountant: відкликати доступ. */
exports.revokeAccountant = onCall({ region: REGION, cors: true }, async (request) => {
  assertAdmin(request);
  const snap = await cardRef().get();
  if (!snap.exists) return { ok: true };
  const { uid } = snap.data();
  if (uid) await disableAccountant(uid);
  await cardRef().set({ disabled: true, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true };
});
