import React, { useCallback, useEffect, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../../firebase-config";
import ClientPricingModal from "../components/ClientPricingModal.jsx";
import RegistrationRequestsTab from "../components/RegistrationRequestsTab.jsx";
import Tabs from "../components/Tabs.jsx";
import { useClientSearch } from "../hooks/useClientSearch.js";

const appId = import.meta.env.VITE_PROJECT_ID || "embryo-project";
const PAGE = 50;
const CLIENTS_PATH = `/artifacts/${appId}/public/data/clients`;

/** Модалка редагування клієнта */
function EditClientModal({ client, onClose, onSaved }) {
  const [name, setName] = useState(client?.name || "");
  const [phone, setPhone] = useState(client?.phone || "");
  const [email, setEmail] = useState(client?.email || "");
  const [address, setAddress] = useState(client?.address || "");
  const [priceType, setPriceType] = useState(client?.priceType || "роздріб");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const priceTypes = ["роздріб", "ціна 1", "ціна 2", "ціна 3", "ціна опт"];

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const updateClient = httpsCallable(functions, "updateClient");
      await updateClient({
        clientId: client.id,
        name: name.trim() || undefined,
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        address: address.trim() || undefined,
        priceType: priceType || undefined
      });
      onSaved?.();
      onClose();
    } catch (e) {
      setError(e?.message || "Помилка збереження");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 grid place-items-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b p-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Редагувати клієнта: {client.id}</h3>
          <button onClick={onClose} className="text-2xl text-slate-500" aria-label="close">×</button>
        </div>
        <div className="p-6">
          <form onSubmit={save} className="space-y-4">
            {error && (
              <div className="p-3 bg-red-100 text-red-700 rounded-lg text-sm">{error}</div>
            )}
            
            <div>
              <label className="block text-sm font-medium mb-1">Назва клієнта</label>
              <input
                type="text"
                className="w-full p-2 border rounded-lg"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Назва клієнта"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Телефон</label>
              <input
                type="text"
                className="w-full p-2 border rounded-lg"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="0XXXXXXXXX"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Email</label>
              <input
                type="email"
                className="w-full p-2 border rounded-lg"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="email@example.com"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Адреса</label>
              <textarea
                className="w-full p-2 border rounded-lg"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Адреса доставки"
                rows={3}
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Категорія цін</label>
              <select
                className="w-full p-2 border rounded-lg"
                value={priceType}
                onChange={(e) => setPriceType(e.target.value)}
              >
                {priceTypes.map((pt) => (
                  <option key={pt} value={pt}>{pt}</option>
                ))}
              </select>
            </div>

            <div className="flex gap-2 justify-end pt-4">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200"
              >
                Скасувати
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50"
              >
                {saving ? "Збереження..." : "Зберегти"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

/** Модалка встановлення пароля з генерацією тексту для копіювання */
function SetPasswordModal({ client, onClose }) {
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  // Текст для копіювання
  const messageText = `🔑 Ваш доступ до порталу Olimp Auto (масла та технічні рідини)

🌐 Сайт: oil.olimp-auto.biz
👤 Логін: ${client?.phone || ""}
🔐 Пароль: ${password}

Рекомендуємо змінити пароль після першого входу.
З питань звертайтесь за телефоном: +380503727044 Валерій`;

  const handleSave = async (e) => {
    e.preventDefault();
    setError(null);
    
    if (!password || password.length < 4) {
      setError("Пароль має бути не менше 4 символів");
      return;
    }
    
    setSaving(true);
    try {
      const call = httpsCallable(functions, "setClientPassword");
      await call({ clientId: client.id, password });
      setSaved(true);
    } catch (e) {
      console.error(e);
      setError(e?.message || "Не вдалося оновити пароль");
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(messageText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error("Failed to copy", e);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 grid place-items-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b p-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">
            Пароль: {client?.name || client?.id}
          </h3>
          <button onClick={onClose} className="text-2xl text-slate-500 hover:text-slate-700" aria-label="close">×</button>
        </div>
        
        <div className="p-6 space-y-4">
          {error && (
            <div className="p-3 bg-red-100 text-red-700 rounded-lg text-sm">{error}</div>
          )}
          
          {!saved ? (
            <form onSubmit={handleSave} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Новий пароль</label>
                <input
                  type="text"
                  className="w-full p-2 border rounded-lg font-mono"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Введіть пароль"
                  autoFocus
                />
              </div>
              
              <button
                type="submit"
                disabled={saving || !password}
                className="w-full px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50"
              >
                {saving ? "Збереження..." : "Зберегти пароль"}
              </button>
            </form>
          ) : (
            <div className="p-3 bg-green-100 text-green-700 rounded-lg text-sm">
              ✓ Пароль успішно встановлено
            </div>
          )}
          
          {/* Блок з текстом для копіювання - показуємо якщо є пароль */}
          {password && (
            <div className="border-t pt-4 mt-4">
              <div className="text-sm font-medium mb-2 text-slate-600">
                📋 Текст для клієнта:
              </div>
              <div className="bg-slate-50 border rounded-lg p-3 text-sm whitespace-pre-wrap font-mono">
                {messageText}
              </div>
              <button
                onClick={handleCopy}
                className={`mt-3 w-full px-4 py-2 rounded-lg flex items-center justify-center gap-2 transition-colors ${
                  copied 
                    ? "bg-green-100 text-green-700 border border-green-300" 
                    : "bg-slate-100 hover:bg-slate-200 text-slate-700"
                }`}
              >
                {copied ? (
                  <>✓ Скопійовано!</>
                ) : (
                  <>📋 Копіювати текст</>
                )}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Модалка створення нового клієнта */
function CreateClientModal({ onClose, onSaved, setStatus }) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [priceType, setPriceType] = useState("роздріб");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const priceTypes = ["роздріб", "ціна 1", "ціна 2", "ціна 3", "ціна опт"];

  const validate = () => {
    if (!id.trim()) return "ID обов'язковий";
    if (!/^[a-zA-Z0-9]+$/.test(id.trim())) return "ID може містити лише латиницю та цифри";
    if (!name.trim()) return "Назва обов'язкова";
    if (!phone.trim()) return "Телефон обов'язковий";
    if (!/^0\d{9}$/.test(phone.trim())) return "Телефон має бути у форматі 0XXXXXXXXX (10 цифр)";
    if (!address.trim()) return "Адреса обов'язкова";
    if (password && password.length < 6) return "Пароль має бути не менше 6 символів";
    return null;
  };

  const save = async (e) => {
    e.preventDefault();
    const validationError = validate();
    if (validationError) { setError(validationError); return; }

    setSaving(true);
    setError(null);
    try {
      const createClient = httpsCallable(functions, "createClient");
      await createClient({
        id: id.trim(),
        name: name.trim(),
        phone: phone.trim(),
        email: email.trim() || undefined,
        address: address.trim(),
        priceType,
        password: password.trim() || undefined,
      });
      setStatus?.({ type: "success", message: `Клієнт ${name.trim()} (${id.trim()}) створений.` });
      onSaved?.();
    } catch (e) {
      setError(e?.message || "Помилка створення клієнта");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 grid place-items-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b p-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Новий клієнт</h3>
          <button onClick={onClose} className="text-2xl text-slate-500 hover:text-slate-700" aria-label="close">×</button>
        </div>
        <div className="p-6">
          <form onSubmit={save} className="space-y-4">
            {error && (
              <div className="p-3 bg-red-100 text-red-700 rounded-lg text-sm">{error}</div>
            )}

            <div>
              <label className="block text-sm font-medium mb-1">
                ID <span className="text-red-500">*</span>
                <span className="text-gray-400 font-normal ml-1">(код в UkrSklad, лише латиниця та цифри)</span>
              </label>
              <input
                type="text"
                className="w-full p-2 border rounded-lg"
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="напр. 12345"
                autoFocus
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">
                Назва клієнта <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                className="w-full p-2 border rounded-lg"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Назва організації або ФОП"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">
                Телефон <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                className="w-full p-2 border rounded-lg"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="0XXXXXXXXX"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">
                Адреса <span className="text-red-500">*</span>
              </label>
              <textarea
                className="w-full p-2 border rounded-lg"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Адреса доставки"
                rows={3}
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">
                Категорія цін <span className="text-red-500">*</span>
              </label>
              <select
                className="w-full p-2 border rounded-lg"
                value={priceType}
                onChange={(e) => setPriceType(e.target.value)}
              >
                {priceTypes.map((pt) => (
                  <option key={pt} value={pt}>{pt}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Email</label>
              <input
                type="email"
                className="w-full p-2 border rounded-lg"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="email@example.com"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">
                Пароль для входу
                <span className="text-gray-400 font-normal ml-1">(опційно, мін. 6 символів)</span>
              </label>
              <input
                type="text"
                className="w-full p-2 border rounded-lg font-mono"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Залиште порожнім, щоб не встановлювати"
              />
            </div>

            <div className="flex gap-2 justify-end pt-4 border-t">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200"
              >
                Скасувати
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50"
              >
                {saving ? "Збереження..." : "Створити клієнта"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

/**
 * Admin › ClientsPage
 * - колонки: Код (id), Назва (name), Телефон (phone), Категорія цін, Дії (Пароль)
 * - «розумний пошук»: за кодом, телефоном або назвою. Натиснути Enter.
 * - пагінація: локальна (після фільтрації)
 */
export default function ClientsPage({ initialTab = "clients", setStatus }) {
  const [activeTab, setActiveTab] = useState(initialTab);
  const [creatingClient, setCreatingClient] = useState(false);
  const [editingClient, setEditingClient] = useState(null);
  const [pricingClient, setPricingClient] = useState(null);
  const [passwordClient, setPasswordClient] = useState(null);
  const [displayCount, setDisplayCount] = useState(PAGE);

  // Використовуємо спільний хук для пошуку клієнтів
  const {
    searchQuery: search,
    setSearchQuery: setSearch,
    appliedQuery: applied,
    filteredClients: filteredItems,
    loading,
    invalidateCache,
    applySearch,
  } = useClientSearch({
    debounceMs: 0, // Без debounce, застосування по Enter
    maxResults: null, // Без обмеження
    autoLoad: true,
  });

  const onKeyDown = (e) => {
    if (e.key === "Enter") {
      applySearch();
    }
  };

  const tabsItems = [
    { key: "clients", label: "Клієнти" },
    { key: "requests", label: "Заявки" }
  ];

  if (activeTab === "requests") {
    return (
      <div>
        <div className="mb-4">
          <Tabs items={tabsItems} value={activeTab} onChange={setActiveTab} />
        </div>
        <RegistrationRequestsTab setStatus={setStatus} />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4">
        <Tabs items={tabsItems} value={activeTab} onChange={setActiveTab} />
      </div>
      <div className="bg-white rounded-2xl shadow p-3 sm:p-4">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-3 gap-2">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold">Клієнти</h2>
            <button
              className="px-3 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 text-sm"
              onClick={() => setCreatingClient(true)}
            >
              + Новий клієнт
            </button>
          </div>
          <input
            className="p-2 border rounded w-full sm:min-w-[320px]"
            placeholder="Пошук: код, телефон або назва — Enter"
            value={search}
            onChange={(e)=>setSearch(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="text-left text-gray-500 bg-gray-50">
            <tr>
              <th className="p-2">Код клієнта</th>
              <th className="p-2">Назва клієнта</th>
              <th className="p-2">Телефон</th>
              <th className="p-2">Категорія цін</th>
              <th className="p-2">Дії</th>
            </tr>
          </thead>
          <tbody>
            {filteredItems.slice(0, displayCount).map((c) => (
              <tr key={c.id} className="border-t">
                <td className="p-2 whitespace-nowrap">{c.id}</td>
                <td className="p-2">{c.name || "—"}</td>
                <td className="p-2 whitespace-nowrap">{c.phone || "—"}</td>
                <td className="p-2 whitespace-nowrap">
                  {c.priceType || c.priceCategory || c.tier || "—"}
                </td>
                <td className="p-2">
                  <div className="flex gap-2">
                    <button
                      className="px-3 py-1 rounded bg-indigo-100 hover:bg-indigo-200 text-indigo-700"
                      onClick={() => setEditingClient(c)}
                    >
                      Редагувати
                    </button>
                    <button
                      className="px-3 py-1 rounded bg-green-100 hover:bg-green-200 text-green-700"
                      onClick={() => setPricingClient(c)}
                    >
                      Цінова політика
                    </button>
                    <button
                      className="px-3 py-1 rounded bg-slate-100 hover:bg-slate-200"
                      onClick={() => setPasswordClient(c)}
                    >
                      Пароль
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {filteredItems.length === 0 && (
              <tr>
                <td className="p-2 text-center text-gray-500" colSpan={5}>
                  {loading ? "Завантаження…" : "Немає даних"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Пагінація та статистика */}
      <div className="flex items-center justify-between mt-3">
        <div className="text-sm text-gray-500">
          {applied ? `Знайдено: ${filteredItems.length}` : `Всього: ${filteredItems.length}`} клієнтів
          {displayCount < filteredItems.length && ` (показано ${displayCount})`}
        </div>
        {displayCount < filteredItems.length && (
          <button
            onClick={() => setDisplayCount(prev => prev + PAGE)}
            className="px-4 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-sm"
          >
            Показати ще {PAGE}
          </button>
        )}
      </div>

      {creatingClient && (
        <CreateClientModal
          onClose={() => setCreatingClient(false)}
          onSaved={() => { setCreatingClient(false); invalidateCache(); }}
          setStatus={setStatus}
        />
      )}

      {editingClient && (
        <EditClientModal
          client={editingClient}
          onClose={() => setEditingClient(null)}
          onSaved={() => {
            setEditingClient(null);
            invalidateCache(); // Скинути кеш клієнтів та перезавантажити
          }}
        />
      )}

      {pricingClient && (
        <ClientPricingModal
          client={pricingClient}
          onClose={() => setPricingClient(null)}
        />
      )}

      {passwordClient && (
        <SetPasswordModal
          client={passwordClient}
          onClose={() => setPasswordClient(null)}
        />
      )}
      </div>
    </div>
  );
}
