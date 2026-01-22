import React, { useState } from "react";
import { signInWithEmailAndPassword, signOut } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import { auth, functions } from "../../firebase-config";

export default function AdminLogin() {
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const userCredential = await signInWithEmailAndPassword(auth, email, pass);
      const user = userCredential.user;
      
      // Встановлюємо адмін-клейм та оновлюємо токен
      try {
        const syncResult = await httpsCallable(functions, "syncAdminClaim")();
        if (syncResult?.data?.admin === false) {
          setErr("Ваш email не в списку адмінів");
          await signOut(auth);
          return;
        }
        // ВАЖЛИВО: оновлюємо токен після встановлення claim
        // Це потрібно, щоб Firestore rules побачили admin: true
        await user.getIdToken(true);
      } catch (syncErr) {
        // logger не доступний тут, але це критична помилка, тому залишаємо console.error
        console.error("syncAdminClaim error:", syncErr);
        setErr("Помилка перевірки прав адміністратора");
        await signOut(auth);
        return;
      }
    } catch (e2) {
      setErr(e2?.message || "Помилка входу");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-[60vh] grid place-items-center">
      <form onSubmit={submit} className="bg-white p-6 rounded-2xl shadow w-full max-w-md space-y-4">
        <div className="text-xl font-semibold text-center">Вхід до адмін-панелі</div>
        <div>
          <label className="block text-sm text-slate-600">Email</label>
          <input
            type="email"
            className="mt-1 w-full p-2 border rounded"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="block text-sm text-slate-600">Пароль</label>
          <input
            type="password"
            className="mt-1 w-full p-2 border rounded"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            required
          />
        </div>
        {err && <div className="text-sm text-red-600">{err}</div>}
        <button className="px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white w-full" disabled={busy}>
          {busy ? "Вхід…" : "Увійти"}
        </button>
      </form>
    </div>
  );
}
