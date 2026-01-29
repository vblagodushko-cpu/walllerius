// src/admin/AdminApp.jsx
import React, { useEffect, useState } from "react";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";
import { auth, db } from "../firebase-config";
import AdminLayout from "./components/AdminLayout.jsx";
import TopNav from "./components/TopNav.jsx";
import OrdersPage from "./pages/OrdersPage.jsx";
import ProductsPage from "./pages/ProductsPage.jsx";
import SuppliersPage from "./pages/SuppliersPage.jsx";
import ClientsPage from "./pages/ClientsPage.jsx";
import DataPage from "./pages/DataPage.jsx";
import ExportPage from "./pages/ExportPage.jsx";
import PurchasesPage from "./pages/PurchasesPage.jsx";
import OrdersExportPage from "./pages/OrdersExportPage.jsx";
import AdminLogin from "./components/AdminLogin.jsx";
import { logger } from "../utils/logger.js";

function Placeholder({ title }) {
  return (
    <div className="bg-white rounded-2xl shadow p-6 text-gray-600">
      {title} — сторінка в розробці.
    </div>
  );
}

// ⚠️ Без setStatus тут!
const NAV = [
  { key: "orders",    label: "Замовлення",     page: <OrdersPage /> },
  { key: "products",  label: "Товари",         page: <ProductsPage /> },
  { key: "purchases", label: "ЗАКУПКИ",        page: null }, // Обробляється окремо
  { key: "suppliers", label: "Постачальники",  page: <Placeholder title="Постачальники" /> },
  { key: "export",    label: "Експорт",        page: <Placeholder title="Експорт" /> },
  { key: "clients",   label: "Клієнти",        page: null }, // Обробляється окремо
  { key: "data",      label: "Дані",           page: <DataPage /> },
  { key: "ordersExport", label: "Вигрузка замовлень", page: null }, // Обробляється окремо
];

export default function AdminApp() {
  const [user, setUser] = useState(null);
  const [active, setActive] = useState("orders");
  const [orderCounts, setOrderCounts] = useState({ new: 0, partial: 0 });
  const [pendingRequestsCount, setPendingRequestsCount] = useState(0);
  const [notificationDismissed, setNotificationDismissed] = useState(false);

  // статус-банер
  const [status, setStatus] = useState(null);
  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(null), 3000);
    return () => clearTimeout(t);
  }, [status]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUser(u));
    return () => unsub();
  }, []);

  // Load and update order counts in real-time
  useEffect(() => {
    if (!user) return;
    
    const appId = import.meta.env.VITE_PROJECT_ID;
    if (!appId) {
      logger.error("VITE_PROJECT_ID environment variable is required");
      return;
    }
    const orderCountsRef = doc(db, `/artifacts/${appId}/public/meta/counters/orderCounts`);
    
    // Use onSnapshot for real-time updates
    const unsubscribe = onSnapshot(
      orderCountsRef,
      (snap) => {
        if (snap.exists()) {
          const data = snap.data();
          setOrderCounts({
            new: Number(data.new) || 0,
            partial: Number(data.partial) || 0,
          });
        } else {
          // Якщо документ не існує, встановити 0
          setOrderCounts({ new: 0, partial: 0 });
        }
      },
      (error) => {
        logger.warn("Failed to load order counts", error);
        // При помилці також встановити 0
        setOrderCounts({ new: 0, partial: 0 });
      }
    );
    
    return () => unsubscribe();
  }, [user]);
    
  // Load and update registration requests count in real-time
  useEffect(() => {
    if (!user) return;
    
    const appId = import.meta.env.VITE_PROJECT_ID;
    if (!appId) {
      logger.error("VITE_PROJECT_ID environment variable is required");
      return;
    }
    const requestsCountRef = doc(db, `/artifacts/${appId}/public/meta/counters/registrationRequestsCount`);
    
    const unsubscribe = onSnapshot(
      requestsCountRef,
      (snap) => {
        if (snap.exists()) {
          const data = snap.data();
          const total = Number(data.total) || 0;
          setPendingRequestsCount(total);
          // Показуємо нотифікацію, якщо є нові заявки
          if (total > 0) {
            setNotificationDismissed(false);
          }
        } else {
          setPendingRequestsCount(0);
        }
      },
      (error) => {
        logger.warn("Failed to load registration requests count", error);
        setPendingRequestsCount(0);
      }
    );
    
    return () => unsubscribe();
  }, [user]);

  const rightArea = user ? (
    <div className="flex items-center gap-3">
      <span className="hidden sm:block text-sm text-gray-600">{user.email || "admin"}</span>
      <button
        className="px-3 py-2 rounded-xl text-sm bg-gray-100 hover:bg-gray-200"
        onClick={() => signOut(auth)}
      >
        Вийти
      </button>
    </div>
  ) : null;

  if (!user) {
    return (
      <AdminLayout title="Project ROZA — Адмін" right={null}>
        <AdminLogin />
      </AdminLayout>
    );
  }

  const current = NAV.find(n => n.key === active || n.label === active) || NAV[0];

  return (
    <AdminLayout title="Project ROZA — Адмін" right={rightArea}>
      <div className="mb-5">
        <TopNav items={NAV} value={active} onChange={setActive} orderCounts={orderCounts} pendingRequestsCount={pendingRequestsCount} />
      </div>

      {/* Нотифікація про нові заявки */}
      {pendingRequestsCount > 0 && !notificationDismissed && (
        <div className="fixed top-4 right-4 bg-yellow-100 border border-yellow-300 rounded-lg p-4 shadow-lg z-50 max-w-md">
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <p className="font-semibold text-yellow-800">Нові заявки!</p>
              <p className="text-sm text-yellow-700">
                {pendingRequestsCount === 1 
                  ? "Є 1 нова заявка на реєстрацію або відновлення пароля"
                  : `Є ${pendingRequestsCount} нових заявок на реєстрацію або відновлення пароля`}
              </p>
            </div>
            <button
              onClick={() => setNotificationDismissed(true)}
              className="text-yellow-600 hover:text-yellow-800 text-xl"
              aria-label="Закрити"
            >
              ×
            </button>
            <button
              onClick={() => {
                setActive("clients");
                setNotificationDismissed(true);
                // Перехід на вкладку заявок буде через prop initialTab
              }}
              className="px-3 py-1 rounded bg-yellow-600 hover:bg-yellow-700 text-white text-sm"
            >
              Перейти
            </button>
          </div>
        </div>
      )}

      {status && (
        <div
          className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-[100] px-4 py-2 rounded-lg shadow-lg ${
            status.type === "error"
              ? "bg-red-100 text-red-800"
              : status.type === "success"
              ? "bg-green-100 text-green-800"
              : "bg-slate-100 text-slate-800"
          }`}
        >
          {status.message}
        </div>
      )}

      {/* Тут підміняємо сторінки, яким треба setStatus */}
      {current.key === "orders"
        ? <OrdersPage setStatus={setStatus} />
        : current.key === "purchases"
        ? <PurchasesPage setStatus={setStatus} />
        : current.key === "ordersExport"
        ? <OrdersExportPage setStatus={setStatus} />
        : current.key === "suppliers"
        ? <SuppliersPage setStatus={setStatus} />
        : current.key === "export"
        ? <ExportPage setStatus={setStatus} />
        : current.key === "clients"
        ? <ClientsPage initialTab={pendingRequestsCount > 0 && !notificationDismissed ? "requests" : "clients"} setStatus={setStatus} />
        : current.page}
    </AdminLayout>
  );
}
