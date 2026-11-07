// checkAdminClaim.mjs (ESM)
// Usage:
//   setx GOOGLE_APPLICATION_CREDENTIALS "C:\\keys\\roza-admin.json"
//   $env:GOOGLE_APPLICATION_CREDENTIALS="C:\\keys\\roza-admin.json"
//   node .\checkAdminClaim.mjs <UID>
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

initializeApp({ credential: applicationDefault() });

const [, , uid] = process.argv;
if (!uid) {
  console.error('Usage: node checkAdminClaim.mjs <UID>');
  process.exit(1);
}
try {
  const user = await getAuth().getUser(uid);
  console.log(JSON.stringify({
    uid: user.uid,
    email: user.email,
    emailVerified: user.emailVerified,
    customClaims: user.customClaims || {}
  }, null, 2));
} catch (err) {
  console.error('Failed to fetch user:', err?.message || err);
  process.exit(1);
}