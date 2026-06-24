import React, { useEffect, useState } from "react";
import { collection, getDocs, query, orderBy, doc, deleteDoc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../../firebase-config";

const appId = import.meta.env.VITE_PROJECT_ID || "embryo-project";

export default function RegistrationRequestsTab({ setStatus }) {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadRequests = async () => {
    setLoading(true);
    try {
      const requestsCol = collection(db, `/artifacts/${appId}/public/data/registrationRequests`);
      const q = query(requestsCol, orderBy("createdAt", "desc"));
      const snap = await getDocs(q);
      const requestsList = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setRequests(requestsList);
    } catch (e) {
      console.error("Помилка завантаження заявок:", e);
      setStatus?.({ type: "error", message: "Не вдалося завантажити заявки" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRequests();
  }, []);

  const handleDelete = async (requestId) => {
    if (!confirm("Видалити цю заявку?")) return;
    
    try {
      const requestRef = doc(db, `/artifacts/${appId}/public/data/registrationRequests/${requestId}`);
      await deleteDoc(requestRef);
      
      // Зменшуємо лічильник
      try {
        const decrementFn = httpsCallable(functions, "decrementRegistrationRequestsCounter");
        await decrementFn();
      } catch (e) {
        console.warn("Не вдалося оновити лічильник:", e);
      }
      
      setRequests(prev => prev.filter(r => r.id !== requestId));
      setStatus?.({ type: "success", message: "Заявку видалено" });
    } catch (e) {
      console.error("Помилка видалення заявки:", e);
      setStatus?.({ type: "error", message: "Не вдалося видалити заявку" });
    }
  };

  const formatDate = (timestamp) => {
    if (!timestamp) return "—";
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleString("uk-UA");
  };

  return (
    <div className="bg-white rounded-2xl shadow p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">Заявки на реєстрацію та відновлення пароля</h2>
        <button
          onClick={loadRequests}
          className="px-4 py-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700"
        >
          Оновити
        </button>
      </div>

      {loading ? (
        <div className="text-center py-8 text-gray-500">Завантаження...</div>
      ) : requests.length === 0 ? (
        <div className="text-center py-8 text-gray-500">Немає заявок</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-2 text-left">Тип</th>
                <th className="px-4 py-2 text-left">Телефон</th>
                <th className="px-4 py-2 text-left">Ім'я</th>
                <th className="px-4 py-2 text-left">Email</th>
                <th className="px-4 py-2 text-left">Дата створення</th>
                <th className="px-4 py-2 text-left">Дії</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((request) => (
                <tr key={request.id} className="border-t">
                  <td className="px-4 py-2">
                    <span className={`px-2 py-1 rounded text-xs ${
                      request.type === "registration" 
                        ? "bg-blue-100 text-blue-800" 
                        : "bg-orange-100 text-orange-800"
                    }`}>
                      {request.type === "registration" ? "Реєстрація" : "Відновлення пароля"}
                    </span>
                  </td>
                  <td className="px-4 py-2">{request.phone || "—"}</td>
                  <td className="px-4 py-2">{request.name || "—"}</td>
                  <td className="px-4 py-2">{request.email || "—"}</td>
                  <td className="px-4 py-2">{formatDate(request.createdAt)}</td>
                  <td className="px-4 py-2">
                    <button
                      onClick={() => handleDelete(request.id)}
                      className="px-3 py-1 rounded bg-red-100 text-red-800 hover:bg-red-200 text-sm"
                    >
                      Видалити
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

