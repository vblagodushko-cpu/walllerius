const admin = require("firebase-admin");
const { initializeApp, applicationDefault } = require("firebase-admin/app");

if (!admin.apps.length) {
  try {
    initializeApp({ credential: applicationDefault() });
  } catch (e) {
    console.error("Помилка ініціалізації Firebase Admin:", e.message);
    console.log("Переконайся, що встановлено gcloud CLI та виконано: gcloud auth application-default login");
    process.exit(1);
  }
}

const db = admin.firestore();
const auth = admin.auth();
const APP_ID = "embryo-project";
const EMAIL = "v.blagodushko@gmail.com";

async function checkAdminStatus() {
  const emailLower = EMAIL.toLowerCase();
  console.log(`\n🔍 Перевірка прав адміністратора для: ${emailLower}\n`);
  
  const result = {
    email: emailLower,
    inEnvAllowlist: false,
    inFirestoreAllowlist: false,
    userExists: false,
    uid: null,
    hasAdminClaim: false,
  };
  
  // Перевірка Firestore allowlist
  console.log("1️⃣ Перевірка Firestore allowlist...");
  try {
    const ref = db.doc(`/artifacts/${APP_ID}/public/meta/adminAllowlist/${emailLower}`);
    const snap = await ref.get();
    result.inFirestoreAllowlist = snap.exists;
    
    if (snap.exists) {
      const data = snap.data();
      result.uid = data.uid || null;
      console.log(`   ✅ Email знайдено в allowlist`);
      console.log(`   📋 Дані:`, JSON.stringify(data, null, 2));
    } else {
      console.log(`   ❌ Email НЕ знайдено в allowlist`);
      console.log(`   📍 Шлях: /artifacts/${APP_ID}/public/meta/adminAllowlist/${emailLower}`);
    }
  } catch (e) {
    console.log(`   ⚠️ Помилка перевірки: ${e.message}`);
  }
  
  // Перевірка чи існує користувач в Firebase Auth
  console.log("\n2️⃣ Перевірка Firebase Authentication...");
  try {
    const userRecord = await auth.getUserByEmail(emailLower);
    result.userExists = true;
    result.uid = userRecord.uid;
    console.log(`   ✅ Користувач існує`);
    console.log(`   🆔 UID: ${userRecord.uid}`);
    console.log(`   📧 Email: ${userRecord.email}`);
    console.log(`   ✅ Email verified: ${userRecord.emailVerified}`);
    console.log(`   🔐 Disabled: ${userRecord.disabled}`);
    
    // Перевірка custom claims
    const claims = userRecord.customClaims || {};
    result.hasAdminClaim = claims.admin === true;
    console.log(`\n3️⃣ Перевірка custom claims...`);
    if (result.hasAdminClaim) {
      console.log(`   ✅ Admin claim встановлено: admin = true`);
    } else {
      console.log(`   ❌ Admin claim НЕ встановлено`);
      console.log(`   📋 Поточні claims:`, JSON.stringify(claims, null, 2));
    }
    
    // Перевірка провайдерів
    console.log(`\n4️⃣ Перевірка провайдерів автентифікації...`);
    const providers = userRecord.providerData || [];
    console.log(`   Провайдери:`, providers.map(p => `${p.providerId} (${p.email || p.uid})`).join(", ") || "немає");
    
    // Перевірка чи є email/password провайдер
    const hasEmailPassword = providers.some(p => p.providerId === "password");
    console.log(`   Email/Password провайдер: ${hasEmailPassword ? "✅ Так" : "❌ Ні"}`);
    
    if (!hasEmailPassword) {
      console.log(`   ⚠️ УВАГА: Користувач не має email/password провайдера!`);
      console.log(`   Це означає, що він не може увійти через signInWithEmailAndPassword`);
    }
    
  } catch (e) {
    if (e.code === "auth/user-not-found") {
      result.userExists = false;
      console.log(`   ❌ Користувач НЕ знайдено в Firebase Authentication`);
    } else {
      console.log(`   ⚠️ Помилка: ${e.message} (code: ${e.code})`);
    }
  }
  
  // Підсумок
  console.log(`\n📊 ПІДСУМОК:`);
  console.log(`   Email: ${result.email}`);
  console.log(`   В Firestore allowlist: ${result.inFirestoreAllowlist ? "✅ Так" : "❌ Ні"}`);
  console.log(`   Користувач існує: ${result.userExists ? "✅ Так" : "❌ Ні"}`);
  console.log(`   UID: ${result.uid || "не знайдено"}`);
  console.log(`   Admin claim: ${result.hasAdminClaim ? "✅ Так" : "❌ Ні"}`);
  
  if (!result.userExists) {
    console.log(`\n⚠️ ПРОБЛЕМА: Користувач не існує в Firebase Authentication`);
    console.log(`   Рішення: Створити користувача через Firebase Console або функцію createAdminUser`);
  } else if (!result.inFirestoreAllowlist) {
    console.log(`\n⚠️ ПРОБЛЕМА: Email не в allowlist`);
    console.log(`   Рішення: Додати документ в Firestore:`);
    console.log(`   Колекція: /artifacts/${APP_ID}/public/meta/adminAllowlist`);
    console.log(`   Документ ID: ${emailLower}`);
  } else if (!result.hasAdminClaim) {
    console.log(`\n⚠️ ПРОБЛЕМА: Admin claim не встановлено`);
    console.log(`   Рішення: Після входу викликати syncAdminClaim, який встановить claim`);
  } else {
    console.log(`\n✅ ВСЕ ДОБРЕ: Користувач має права адміністратора`);
  }
  
  return result;
}

checkAdminStatus().catch(err => {
  console.error("\n❌ Помилка:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});

























