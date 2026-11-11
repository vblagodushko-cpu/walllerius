import React, { useState } from 'react';

function Field({ label, value }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-stone-500">{label}</div>
      <div className="mt-0.5 font-medium text-stone-900">{value || '—'}</div>
    </div>
  );
}

export default function ProfilePanel({ client, user, onChangePassword, changing, onLogout }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [show, setShow] = useState(false);
  const [msg, setMsg] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setMsg(null);
    if (newPassword.length < 6) {
      setMsg({ type: 'error', text: 'Новий пароль має містити щонайменше 6 символів.' });
      return;
    }
    if (newPassword !== confirmPassword) {
      setMsg({ type: 'error', text: 'Паролі не співпадають.' });
      return;
    }
    try {
      await onChangePassword(currentPassword, newPassword, confirmPassword);
      setMsg({ type: 'success', text: 'Пароль змінено.' });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setMsg({ type: 'error', text: err?.message || 'Не вдалося змінити пароль.' });
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <section className="rounded-2xl border border-stone-200 bg-white p-5">
        <h2 className="text-lg font-semibold">Профіль</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Назва" value={client?.name} />
          <Field label="Телефон" value={client?.phone || user?.phoneNumber} />
          <Field label="Email" value={client?.email || user?.email} />
          <Field label="Адреса" value={client?.address} />
          <Field label="Категорія ціни" value={client?.priceType} />
        </div>
        <p className="mt-4 text-sm text-stone-500">
          Вхід у портал — номер телефону у форматі 050XXXXXXX і пароль.
        </p>
        <button type="button" className="mt-4 rounded-xl bg-stone-100 px-4 py-2 text-sm hover:bg-stone-200" onClick={onLogout}>Вийти</button>
      </section>

      <form onSubmit={submit} className="rounded-2xl border border-stone-200 bg-white p-5">
        <h3 className="text-base font-semibold">Змінити пароль</h3>
        {msg ? (
          <div className={`mt-3 rounded-xl px-3 py-2 text-sm ${msg.type === 'success' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`}>{msg.text}</div>
        ) : null}
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="block text-sm text-stone-600">
            Поточний пароль
            <input type={show ? 'text' : 'password'} required autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} className="mt-1 w-full rounded-xl border border-stone-200 px-3 py-2" />
          </label>
          <label className="mt-6 inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
            Показати паролі
          </label>
          <label className="block text-sm text-stone-600">
            Новий пароль
            <input type={show ? 'text' : 'password'} required minLength={6} autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="mt-1 w-full rounded-xl border border-stone-200 px-3 py-2" />
          </label>
          <label className="block text-sm text-stone-600">
            Підтвердити
            <input type={show ? 'text' : 'password'} required minLength={6} autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className="mt-1 w-full rounded-xl border border-stone-200 px-3 py-2" />
          </label>
        </div>
        <button type="submit" disabled={changing} className="mt-4 rounded-xl bg-indigo-700 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-800 disabled:opacity-50">
          {changing ? 'Зберігаємо…' : 'Змінити пароль'}
        </button>
      </form>
    </div>
  );
}
