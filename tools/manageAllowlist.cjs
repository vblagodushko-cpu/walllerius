// Usage:
//   node manageAllowlist.js list
//   node manageAllowlist.js add boss@company.com
//   node manageAllowlist.js remove boss@company.com
//
// Requires GOOGLE_APPLICATION_CREDENTIALS env pointing to service account JSON.
const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp({ credential: applicationDefault() });

function getProjectId() {
  try { return JSON.parse(process.env.FIREBASE_CONFIG || '{}').projectId; } catch { return process.env.GCLOUD_PROJECT; }
}
const APP_ID = getProjectId();

async function main() {
  const [cmd, email] = process.argv.slice(2);
  const db = getFirestore();
  const ref = db.doc(`artifacts/${APP_ID}/private/config/auth/adminAllowlist`);
  const snap = await ref.get();
  let emails = [];
  if (snap.exists) {
    emails = Array.isArray(snap.data()?.emails) ? snap.data().emails : [];
  }
  const norm = (s) => String(s||'').trim().toLowerCase();
  if (cmd === 'list') {
    console.log(emails);
    return;
  }
  if (cmd === 'add') {
    if (!email) throw new Error('Provide email to add');
    const e = norm(email);
    if (!emails.map(norm).includes(e)) emails.push(email);
    await ref.set({ emails }, { merge: true });
    console.log('Added', email);
    return;
  }
  if (cmd === 'remove') {
    if (!email) throw new Error('Provide email to remove');
    const e = norm(email);
    emails = emails.filter(x => norm(x) !== e);
    await ref.set({ emails }, { merge: true });
    console.log('Removed', email);
    return;
  }
  throw new Error('Unknown command. Use: list | add <email> | remove <email>');
}

main().catch(e => { console.error(e); process.exit(1); });