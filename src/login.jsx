// src/login.jsx
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

import { auth, functions } from './firebase-config.js';
import {
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  signInWithCustomToken,
  onAuthStateChanged,
  signOut,
} from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';

const PATHS = { login: '/login.html', portal: '/portal.html' };
const AUTO_REDIRECT_IF_LOGGED_IN = false;

function HeaderNav() {
  return (
    <div className="w-full bg-white border-b sticky top-0 z-40">
      <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
        <div className="font-semibold">Project ROZA — Вхід</div>
        <nav className="text-sm space-x-4">
          <a href={PATHS.login} className="text-indigo-600 hover:underline">Вхід</a>
          <a href={PATHS.portal} className="text-gray-600 hover:underline">Портал</a>
        </nav>
      </div>
    </div>
  );
}

// Форматування телефону: 10 цифр без плюса (0501234567)
function formatPhone(value) {
  let digits = value.replace(/\D/g, '');
  // Якщо починається з 380 - замінюємо на 0
  if (digits.startsWith('380')) {
    digits = '0' + digits.slice(3);
  }
  // Якщо не починається з 0 - додаємо 0
  if (digits.length > 0 && !digits.startsWith('0')) {
    digits = '0' + digits;
  }
  // Обмежуємо до 10 цифр
  if (digits.length > 10) {
    digits = digits.slice(0, 10);
  }
  return digits;
}

function LoginPage() {
  const [activeTab, setActiveTab] = useState('login'); // 'login' | 'register' | 'reset'
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [user, setUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [justLoggedOut, setJustLoggedOut] = useState(false);
  
  // Реєстрація
  const [regName, setRegName] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPhone, setRegPhone] = useState('');
  const [regLoading, setRegLoading] = useState(false);
  const [regError, setRegError] = useState('');
  const [regSuccess, setRegSuccess] = useState(false);
  
  // Відновлення пароля
  const [resetPhone, setResetPhone] = useState('');
  const [resetLoading, setResetLoading] = useState(false);
  const [resetError, setResetError] = useState('');
  const [resetSuccess, setResetSuccess] = useState(false);

  useEffect(() => {
    let unsub = () => {};
    (async () => {
      // Якщо прийшли після logout — гарантуємо повний вихід і чекаємо стан null
      try {
        const url = new URL(window.location.href);
        if (url.searchParams.get('logged_out') === '1') {
          try { await signOut(auth); } catch {}
          await new Promise((resolve) => {
            const uunsub = onAuthStateChanged(auth, (u) => {
              if (!u) { uunsub(); resolve(); }
            });
          });
          setUser(null);
          setJustLoggedOut(true);
          // прибираємо прапорець із URL
          url.searchParams.delete('logged_out');
          const cleaned = url.pathname + (url.searchParams.toString() ? ('?' + url.searchParams.toString()) : '') + url.hash;
          window.history.replaceState({}, '', cleaned);
        }
      } catch {}

      unsub = onAuthStateChanged(auth, (u) => {
        setUser(u);
        setAuthChecked(true);
        if (u && AUTO_REDIRECT_IF_LOGGED_IN) {
          window.location.replace(PATHS.portal);
        }
      });
    })();
    return () => unsub();
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      // ВАЖЛИВО: persistence до входу
      await setPersistence(auth, remember ? browserLocalPersistence : browserSessionPersistence);

      const clientLogin = httpsCallable(functions, 'clientLogin');
      const result = await clientLogin({ phone: formatPhone(phone), password });
      const token = result?.data?.token;
      if (!token) throw new Error('Не отримав токен авторизації');

      await signInWithCustomToken(auth, token);
      try { sessionStorage.setItem('roza_client_phone', phone); } catch {}
      window.location.replace(PATHS.portal);
    } catch (err) {
      console.error(err);
      setError(err.message || 'Помилка входу');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setRegError('');
    setRegSuccess(false);
    setRegLoading(true);
    try {
      const submitRegistrationRequest = httpsCallable(functions, 'submitRegistrationRequest');
      await submitRegistrationRequest({
        phone: formatPhone(regPhone),
        name: regName.trim() || undefined,
        email: regEmail.trim() || undefined
      });
      setRegSuccess(true);
      setRegName('');
      setRegEmail('');
      setRegPhone('');
    } catch (err) {
      console.error(err);
      setRegError(err.message || 'Помилка створення заявки');
    } finally {
      setRegLoading(false);
    }
  };

  const handleReset = async (e) => {
    e.preventDefault();
    setResetError('');
    setResetSuccess(false);
    setResetLoading(true);
    try {
      const submitPasswordResetRequest = httpsCallable(functions, 'submitPasswordResetRequest');
      await submitPasswordResetRequest({
        phone: formatPhone(resetPhone)
      });
      setResetSuccess(true);
      setResetPhone('');
    } catch (err) {
      console.error(err);
      setResetError(err.message || 'Помилка створення заявки');
    } finally {
      setResetLoading(false);
    }
  };

  const signOutAndSwitch = async () => {
    try { await signOut(auth); } finally { window.location.replace(PATHS.login + '?logged_out=1'); }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-purple-50">
      <HeaderNav />
      <div className="flex items-center justify-center p-4 min-h-[calc(100vh-80px)]">
        <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-6 mt-6">
          {authChecked && user && !AUTO_REDIRECT_IF_LOGGED_IN && !justLoggedOut && (
            <div className="mb-4 text-sm bg-green-50 border border-green-200 rounded p-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>Ви вже авторизовані.</div>
                <div className="flex items-center gap-2">
                  <a href={PATHS.portal} className="px-3 py-1 rounded bg-green-600 text-white hover:opacity-90">Перейти в портал</a>
                  <button onClick={signOutAndSwitch} className="px-3 py-1 rounded border">Вийти</button>
                </div>
              </div>
            </div>
          )}
          {justLoggedOut && (
            <div className="mb-4 text-sm bg-blue-50 border border-blue-200 rounded p-3">
              Ви вийшли з облікового запису.
            </div>
          )}

          {/* Таби */}
          <div className="flex gap-2 mb-6 border-b">
            <button
              onClick={() => setActiveTab('login')}
              className={`px-4 py-2 font-medium text-sm transition-colors ${
                activeTab === 'login'
                  ? 'border-b-2 border-indigo-600 text-indigo-600'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Вхід
            </button>
            <button
              onClick={() => setActiveTab('register')}
              className={`px-4 py-2 font-medium text-sm transition-colors ${
                activeTab === 'register'
                  ? 'border-b-2 border-indigo-600 text-indigo-600'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Реєстрація
            </button>
            <button
              onClick={() => setActiveTab('reset')}
              className={`px-4 py-2 font-medium text-sm transition-colors ${
                activeTab === 'reset'
                  ? 'border-b-2 border-indigo-600 text-indigo-600'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Відновлення пароля
            </button>
          </div>

          {/* Форма входу */}
          {activeTab === 'login' && (
            <>
              <h1 className="text-xl font-semibold mb-4">Вхід у клієнтський портал</h1>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm mb-1" htmlFor="phone">Телефон</label>
                  <input id="phone"
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(formatPhone(e.target.value))}
                    className="w-full border rounded-lg px-3 py-2"
                    placeholder="0501234567"
                    required
                    name="phone"
                    maxLength={10}
                  />
                  <p className="text-xs text-gray-500 mt-1">Формат: 10 цифр без плюса</p>
                </div>
                <div>
                  <label className="block text-sm mb-1" htmlFor="password">Пароль</label>
                  <input id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full border rounded-lg px-3 py-2"
                    placeholder="*******"
                    required
                    name="password"
                  />
                </div>
                <div className="flex items-center justify-between">
                  <label className="inline-flex items-center gap-2 text-sm select-none">
                    <input
                      type="checkbox"
                      className="rounded border-gray-300"
                      checked={remember}
                      onChange={(e) => setRemember(e.target.checked)}
                      name="rememberMe"
                    />
                    Пам'ятати мене
                  </label>
                </div>

                {error && <div className="text-red-600 text-sm bg-red-50 border border-red-200 rounded p-2">{error}</div>}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full rounded-lg px-3 py-2 bg-indigo-600 text-white disabled:bg-indigo-400 disabled:cursor-not-allowed hover:bg-indigo-700 transition-colors"
                >
                  {loading ? 'Перевірка…' : 'Увійти'}
                </button>
              </form>
            </>
          )}

          {/* Форма реєстрації */}
          {activeTab === 'register' && (
            <>
              <h1 className="text-xl font-semibold mb-4">Реєстрація</h1>
              <p className="text-sm text-gray-600 mb-4">
                Подайте заявку на реєстрацію. Менеджер зв'яжеться з вами для підтвердження.
              </p>
              <form onSubmit={handleRegister} className="space-y-4">
                <div>
                  <label className="block text-sm mb-1" htmlFor="reg-phone">Телефон *</label>
                  <input id="reg-phone"
                    type="tel"
                    value={regPhone}
                    onChange={(e) => setRegPhone(formatPhone(e.target.value))}
                    className="w-full border rounded-lg px-3 py-2"
                    placeholder="0501234567"
                    required
                    name="phone"
                    maxLength={10}
                  />
                  <p className="text-xs text-gray-500 mt-1">Формат: 10 цифр без плюса</p>
                </div>
                <div>
                  <label className="block text-sm mb-1" htmlFor="reg-name">Ім'я</label>
                  <input id="reg-name"
                    type="text"
                    value={regName}
                    onChange={(e) => setRegName(e.target.value)}
                    className="w-full border rounded-lg px-3 py-2"
                    placeholder="Ваше ім'я"
                    name="name"
                  />
                </div>
                <div>
                  <label className="block text-sm mb-1" htmlFor="reg-email">Email</label>
                  <input id="reg-email"
                    type="email"
                    value={regEmail}
                    onChange={(e) => setRegEmail(e.target.value)}
                    className="w-full border rounded-lg px-3 py-2"
                    placeholder="email@example.com"
                    name="email"
                  />
                </div>

                {regError && <div className="text-red-600 text-sm bg-red-50 border border-red-200 rounded p-2">{regError}</div>}
                {regSuccess && (
                  <div className="text-green-700 text-sm bg-green-50 border border-green-200 rounded p-2">
                    ✓ Заявку на реєстрацію створено. Менеджер зв'яжеться з вами.
                  </div>
                )}

                <button
                  type="submit"
                  disabled={regLoading}
                  className="w-full rounded-lg px-3 py-2 bg-indigo-600 text-white disabled:bg-indigo-400 disabled:cursor-not-allowed hover:bg-indigo-700 transition-colors"
                >
                  {regLoading ? 'Відправка…' : 'Подати заявку'}
                </button>
              </form>
            </>
          )}

          {/* Форма відновлення пароля */}
          {activeTab === 'reset' && (
            <>
              <h1 className="text-xl font-semibold mb-4">Відновлення пароля</h1>
              <p className="text-sm text-gray-600 mb-4">
                Подайте заявку на відновлення пароля. Менеджер зв'яжеться з вами.
              </p>
              <form onSubmit={handleReset} className="space-y-4">
                <div>
                  <label className="block text-sm mb-1" htmlFor="reset-phone">Телефон *</label>
                  <input id="reset-phone"
                    type="tel"
                    value={resetPhone}
                    onChange={(e) => setResetPhone(formatPhone(e.target.value))}
                    className="w-full border rounded-lg px-3 py-2"
                    placeholder="0501234567"
                    required
                    name="phone"
                    maxLength={10}
                  />
                  <p className="text-xs text-gray-500 mt-1">Формат: 10 цифр без плюса</p>
                </div>

                {resetError && <div className="text-red-600 text-sm bg-red-50 border border-red-200 rounded p-2">{resetError}</div>}
                {resetSuccess && (
                  <div className="text-green-700 text-sm bg-green-50 border border-green-200 rounded p-2">
                    ✓ Заявку на відновлення пароля створено. Менеджер зв'яжеться з вами.
                  </div>
                )}

                <button
                  type="submit"
                  disabled={resetLoading}
                  className="w-full rounded-lg px-3 py-2 bg-indigo-600 text-white disabled:bg-indigo-400 disabled:cursor-not-allowed hover:bg-indigo-700 transition-colors"
                >
                  {resetLoading ? 'Відправка…' : 'Подати заявку'}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
      
      {/* Footer */}
      <footer className="text-center text-sm text-gray-500 py-6">
        <p>© 2025 Project ROZA. Всі права захищені.</p>
      </footer>
    </div>
  );
}

// --- self-mount: створить #root, якщо його нема
(function mount() {
  let el = document.getElementById('root');
  if (!el) { el = document.createElement('div'); el.id = 'root'; document.body.appendChild(el); }
  const root = createRoot(el);
  root.render(<React.StrictMode><LoginPage /></React.StrictMode>);
})();
export default LoginPage;
