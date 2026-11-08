// src/admin/pages/SecurityPage.jsx — «Безпека»: керування доступом. Дані тільки через callable.
import React, { useCallback, useEffect, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../../firebase-config";
import Tabs from "../components/Tabs.jsx";

const callGet = httpsCallable(functions, "getAccountant");
const callSet = httpsCallable(functions, "setAccountant");
const callRevoke = httpsCallable(functions, "revokeAccountant");

const SUBTABS = [{ key: "accountant", label: "Бухгалтерія" }];

function genPassword() {
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const buf = new Uint32Array(14);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => chars[n % chars.length]).join("");
}

function AccountantTab({ setStatus }) {
  const [current, setCurrent] = useState(undefined); // undefined = завантаження, null = немає
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null); // { email, password } — показуємо один раз

  const load = useCallback(async () => {
    try {
      const r = await callGet();
      const a = r.data?.accountant || null;
      setCurrent(a);
      if (a?.email) setEmail((prev) => prev || a.email);
    } catch {
      setCurrent(null);
      setStatus?.({ type: "error", message: "Не вдалося завантажити дані бухгалтера." });
    }
  }, [setStatus]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (e) => {
    e.preventDefault();
    if (password.length < 10) {
      setStatus?.({ type: "error", message: "Пароль — мінімум 10 символів." });
      return;
    }
    setBusy(true);
    try {
      await callSet({ email: email.trim(), password });
      setSaved({ email: email.trim().toLowerCase(), password });
      setPassword("");
      setShowPass(false);
      setStatus?.({ type: "success", message: "Бухгалтера збережено." });
      await load();
    } catch (err) {
      const msg =
        err?.code === "functions/failed-precondition"
          ? "Цей email не можна використати для бухгалтера."
          : err?.code === "functions/invalid-argument"
          ? "Некоректний email або пароль (мінімум 10 символів)."
          : "Не вдалося зберегти.";
      setStatus?.({ type: "error", message: msg });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!window.confirm("Відкликати доступ бухгалтера?")) return;
    setBusy(true);
    try {
      await callRevoke();
      setSaved(null);
      setStatus?.({ type: "success", message: "Доступ відкликано." });
      await load();
    } catch {
      setStatus?.({ type: "error", message: "Не вдалося відкликати доступ." });
    } finally {
      setBusy(false);
    }
  };

  const active = current && !current.disabled;
  const buhUrl = `${window.location.origin}/buh`;

  return (
    <div className="space-y-4 max-w-xl">
      <div className="bg-white rounded-2xl shadow p-5">
        <div className="text-sm text-gray-500 mb-1">Поточний бухгалтер</div>
        {current === undefined ? (
          <div className="text-gray-500">Завантаження…</div>
        ) : current ? (
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="font-medium">{current.email}</div>
              <div className={active ? "text-green-700 text-sm" : "text-red-600 text-sm"}>
                {active ? "Доступ активний" : "Доступ відкликано"}
              </div>
            </div>
            {active && (
              <button
                className="px-3 py-1.5 rounded-xl text-sm border border-red-300 text-red-700 hover:bg-red-50"
                onClick={revoke}
                disabled={busy}
              >
                Відкликати доступ
              </button>
            )}
          </div>
        ) : (
          <div className="text-gray-600">Не призначено.</div>
        )}
      </div>

      <form onSubmit={save} className="bg-white rounded-2xl shadow p-5 space-y-3">
        <div className="font-semibold">{current ? "Змінити пароль / призначити іншого" : "Призначити бухгалтера"}</div>
        <label className="block text-sm">
          <div className="text-gray-600 mb-1">Email (логін)</div>
          <input
            type="email"
            className="w-full border rounded px-2 py-1.5"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label className="block text-sm">
          <div className="text-gray-600 mb-1">Пароль (мінімум 10 символів)</div>
          <div className="flex gap-2">
            <input
              type={showPass ? "text" : "password"}
              className="flex-1 border rounded px-2 py-1.5"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
            <button
              type="button"
              className="px-3 rounded border hover:bg-gray-50"
              onClick={() => {
                setPassword(genPassword());
                setShowPass(true);
              }}
            >
              Згенерувати
            </button>
          </div>
        </label>
        <button
          className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-60"
          disabled={busy}
        >
          {busy ? "Збереження…" : "Зберегти"}
        </button>
        <div className="text-xs text-gray-500">
          Зміна пароля розлогінює бухгалтера на всіх пристроях. Бухгалтер входить на {buhUrl}.
        </div>
      </form>

      {saved && (
        <div className="bg-yellow-50 border border-yellow-300 rounded-2xl p-4 text-sm space-y-1">
          <div className="font-semibold">Передайте бухгалтеру (пароль показується один раз):</div>
          <div>Адреса: {buhUrl}</div>
          <div>Логін: {saved.email}</div>
          <div>
            Пароль: <span className="font-mono">{saved.password}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function SecurityPage({ setStatus }) {
  const [sub, setSub] = useState(SUBTABS[0].key);
  return (
    <div className="space-y-4">
      <Tabs items={SUBTABS} value={sub} onChange={setSub} />
      {sub === "accountant" && <AccountantTab setStatus={setStatus} />}
    </div>
  );
}
