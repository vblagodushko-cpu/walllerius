// src/firebase-config.js
import { initializeApp, getApps } from 'firebase/app';
import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';
import { getAuth } from 'firebase/auth';
import { getFunctions } from 'firebase/functions';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_API_KEY,
  authDomain: import.meta.env.VITE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_APP_ID,
};

// 1) App
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

// 2) AppCheck (debug on localhost)
try {
  if (!window.__ROZA_APPCHECK_INIT__) {
    if (location.hostname === 'localhost') {
      // Enable AppCheck debug mode automatically for local dev
      // (token will be printed in console by SDK once)
      // eslint-disable-next-line no-undef
      self.FIREBASE_APPCHECK_DEBUG_TOKEN = true
    }
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(import.meta.env.VITE_RECAPTCHA_KEY),
      isTokenAutoRefreshEnabled: true,
    });
    window.__ROZA_APPCHECK_INIT__ = true;
  }
} catch (e) {
  // ignore duplicate init in HMR
  console.debug('AppCheck init skipped:', e?.message || e);
}

// 3) Exports
export const auth = getAuth(app);
const REGION = import.meta.env.VITE_FUNCTIONS_REGION || undefined;
export const functions = getFunctions(app, import.meta.env.VITE_FUNCTIONS_REGION || 'europe-central2');
export const db = getFirestore(app);
// ---- тільки для локальної відладки (localhost) ----
if (location.hostname === 'localhost') {
  // робимо зручні хелпери в консолі
  // eslint-disable-next-line no-undef
  window.__app = app;
  // eslint-disable-next-line no-undef
  window.__auth = auth;
  // eslint-disable-next-line no-undef
  window.__db = db;
  // eslint-disable-next-line no-undef
  window.__functions = functions;
}
