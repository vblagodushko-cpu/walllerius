// functions/auth.js
const REGION = process.env.FUNCTION_REGION || "europe-central2";
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const bcrypt = require("bcryptjs");
const { schemas, validateData } = require("./shared/validation");

const db = getFirestore();
const auth = getAuth();
const APP_ID = process.env.APP_ID || "embryo-project";
if (!process.env.APP_ID) {
  // logger не доступний тут, тому використовуємо console для попередження
  if (process.env.NODE_ENV !== 'production') {
    console.warn("APP_ID environment variable is not set. Using fallback 'embryo-project'.");
  }
}

const str = (v, max = 500) => {
  const s = (v ?? "").toString().trim();
  return s.length > max ? s.slice(0, max) : s;
};
const isAdminReq = (req) => (req?.auth?.token || {}).admin === true;
const privateClientAuthPath = (uid) => `/artifacts/${APP_ID}/private/data/clientsAuth/${uid}`;

// 1) Адмін встановлює пароль
exports.setClientPassword = onCall({ region: REGION, cors: true }, async (req) => {
  if (!isAdminReq(req)) throw new HttpsError("permission-denied", "Потрібен адмін-доступ.");

  // Validate and clean input data
  const validatedData = validateData(schemas.adminPassword, req.data, "Admin password setting");
  const { clientId, password } = validatedData;

  // 1) хеш паролю
  const hash = await bcrypt.hash(password, 10);

  // 2) зберігаємо у приватну картку клієнта:
  //    - passwordHash (як і раніше)
  //    - code: "<clientId>"  ← ЦЕ ГОЛОВНЕ для getDocDetails
  const authDocRef = db.doc(privateClientAuthPath(clientId));
  await authDocRef.set(
    {
      passwordHash: hash,
      code: String(clientId), // прив'язка uid → clientCode
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  // 3) гарантуємо існування користувача з UID = clientId
  try {
    await auth.getUser(clientId);
  } catch {
    await auth.createUser({ uid: clientId });
  }

  // 4) (опційно) виставимо custom claim clientCode
  //    Не обов'язково для роботи getDocDetails, але може згодитись у правилах/інших функціях.
  try {
    await auth.setCustomUserClaims(clientId, { clientCode: String(clientId) });
  } catch (e) {
    console.warn("setCustomUserClaims failed:", e?.message || e);
  }

  return { ok: true };
});


// 2) Логін клієнта
exports.clientLogin = onCall({ 
  region: REGION, 
  cors: true,
  maxInstances: 20,
  concurrency: 10
}, async (req) => {
  // Validate and clean input data
  const validatedData = validateData(schemas.clientAuth, req.data, "Client login");
  const { password, phone, clientId: rawClientId } = validatedData;

  // нормалізація під формат 050xxxxxxx
  const normalizePhone10 = (s) => {
    let d = (s || "").replace(/\D/g, "");     // тільки цифри
    if (d.startsWith("380")) d = "0" + d.slice(3);
    else if (d.startsWith("38")) d = "0" + d.slice(2);
    if (d.length === 9) d = "0" + d;          // наприклад 501234567 -> 0501234567
    if (d.length !== 10 || d[0] !== "0") return null;
    return d;
  };

  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/43d36951-e2f3-464b-a260-765b59298148',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'auth.js:90',message:'clientLogin: entry',data:{hasRawClientId:!!rawClientId,phone},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
  // #endregion

  let clientId = rawClientId;
  if (!clientId) {
    const phone10 = normalizePhone10(phone);
    if (!phone10) throw new HttpsError("invalid-argument", "Телефон має бути у форматі 050XXXXXXX.");
    const clientsCol = getFirestore().collection(`/artifacts/${APP_ID}/public/data/clients`);
    const snap = await clientsCol.where("phone", "==", phone10).limit(1).get();
    if (snap.empty) throw new HttpsError("not-found", "Клієнт за телефоном не знайдений.");
    const foundDocId = snap.docs[0].id;
    const foundDocData = snap.docs[0].data();
    clientId = foundDocId; // uid == id документа
    
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/43d36951-e2f3-464b-a260-765b59298148',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'auth.js:97',message:'clientLogin: found client by phone',data:{phone10,foundDocId,foundDocIdField:foundDocData.id,clientId},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
    // #endregion
  }

  const ref  = getFirestore().doc(`/artifacts/${APP_ID}/private/data/clientsAuth/${clientId}`);
  const doc  = await ref.get();
  if (!doc.exists) throw new HttpsError("not-found", "Обліковий запис не знайдено.");

  const hash = doc.data()?.passwordHash || "";
  const ok   = hash && (await bcrypt.compare(password, hash));
  if (!ok) throw new HttpsError("unauthenticated", "Невірний пароль.");

  try { await auth.getUser(clientId); } catch { await auth.createUser({ uid: clientId }); }
  const token = await auth.createCustomToken(clientId, { role: "client" });
  return { token, uid: clientId };
});

// 3) Клієнт змінює пароль у порталі
exports.clientChangePassword = onCall({ region: REGION, cors: true }, async (req) => {
  const uid = str(req?.auth?.uid, 128);
  if (!uid) throw new HttpsError("unauthenticated", "Увійдіть у систему.");
  
  // Validate and clean input data
  const validatedData = validateData(schemas.passwordChange, req.data, "Password change");
  const { currentPassword, newPassword } = validatedData;
  const ref = db.doc(privateClientAuthPath(uid));
  const snap = await ref.get();
  const hash = snap.data()?.passwordHash || "";
  const ok = hash && (await bcrypt.compare(currentPassword, hash));
  if (!ok) throw new HttpsError("unauthenticated", "Поточний пароль невірний.");
  const newHash = await bcrypt.hash(newPassword, 10);
  await ref.set({ passwordHash: newHash, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true, message: "Пароль змінено" };
});

