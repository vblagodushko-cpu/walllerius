// src/admin/pages/OrdersPage.jsx
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  collection, orderBy, query, doc, updateDoc, limit, startAfter, runTransaction, where, getDoc,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../../firebase-config";
import usePagedQuery from "../hooks/usePagedQuery";
import PaginatorButton from "../components/PaginatorButton.jsx";

const appId = import.meta.env.VITE_PROJECT_ID;
if (!appId) {
  console.error("VITE_PROJECT_ID environment variable is required");
}

/* ------------------------------ Small Modal ------------------------------ */
function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-[min(1000px,96vw)] max-h-[90vh] overflow-auto">
        <div className="px-5 py-4 border-b flex items-center justify-between">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button className="px-3 py-1 rounded bg-slate-100 hover:bg-slate-200" onClick={onClose}>Закрити</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

/* ------------------------- Order processing modal ------------------------ */
function OrderProcessingModal({ order, onClose, onSaved, setStatus, selectedCurrency = 'EUR', uahRate = null }) {
  const [items, setItems] = useState(() =>
    (order.items || []).map((it) => ({
      ...it,
      quantity: it.quantity ?? 0,
      quantityCancelled: it.quantityCancelled ?? 0,
      quantityConfirmed: it.quantityConfirmed ?? (it.quantity ?? 0),
      lineStatus:
        it.lineStatus ||
        (it.supplier === "Мій склад"
          ? "Виконано"
          : (it.quantity ?? 0) > 0
          ? "Замовлено у постачальника"
          : "Очікує підтвердження"),
    }))
  );
  const [saving, setSaving] = useState(false);
  
  // Локальний стейт валюти для модалки
  const [modalCurrency, setModalCurrency] = useState(selectedCurrency);
  
  // Залишки для товарів зі складу (для виявлення нестачі)
  const [stockMap, setStockMap] = useState({});
  
  // Завантаження залишків тільки для товарів "Мій склад"
  useEffect(() => {
    const loadWarehouseStocks = async () => {
      const map = {};
      const warehouseItems = items.filter(it => it.supplier === "Мій склад" && it.docId);
      
      for (const it of warehouseItems) {
        try {
          const productRef = doc(db, `/artifacts/${appId}/public/data/products`, it.docId);
          const snap = await getDoc(productRef);
          if (snap.exists()) {
            const data = snap.data();
            const offer = (data.offers || []).find(o => o.supplier === "Мій склад");
            map[it.docId] = offer?.stock ?? 0;
          }
        } catch (e) {
          console.warn("Failed to load stock for", it.docId, e);
        }
      }
      setStockMap(map);
    };
    if (items.length > 0) {
      loadWarehouseStocks();
    }
  }, [items.length]);
  
  // Хелпер для конвертації ціни
  const convertPrice = useCallback((priceEur) => {
    const price = parseFloat(priceEur) || 0;
    if (modalCurrency === 'UAH' && uahRate && uahRate > 0) {
      return Math.round(price * uahRate * 100) / 100;
    }
    return Math.round(price * 100) / 100;
  }, [modalCurrency, uahRate]);

  const currencySymbol = modalCurrency === 'EUR' ? '€' : '₴';

  const totalToIssue = useMemo(() => {
    let total = items.reduce(
        (s, it) =>
          s +
          (parseFloat(it.price) || parseFloat(it.unitPrice) || 0) *
            (it.quantityConfirmed || 0),
        0
    );
    
    // Конвертація валюти
    if (modalCurrency === 'UAH' && uahRate && uahRate > 0) {
      total = total * uahRate;
      total = Math.round(total * 100) / 100;
    }
    
    return total;
  }, [items, modalCurrency, uahRate]);

  const recompute = useCallback(
    (idx, newCancelled) => {
      const next = [...items];
      const ordered = parseInt(next[idx].quantity || 0, 10);
      const cancelled = Math.max(
        0,
        Math.min(ordered, parseInt(newCancelled || 0, 10) || 0)
      );
      next[idx].quantityCancelled = cancelled;
      next[idx].quantityConfirmed = ordered - cancelled;
      if (next[idx].supplier === "Мій склад") next[idx].lineStatus = "Виконано";
      else if (next[idx].quantityConfirmed > 0)
        next[idx].lineStatus = "Замовлено у постачальника";
      setItems(next);
    },
    [items]
  );

  const quickConfirmAll = (idx) => {
    const next = [...items];
    next[idx].quantityCancelled = 0;
    next[idx].quantityConfirmed = next[idx].quantity;
    next[idx].lineStatus =
      next[idx].supplier === "Мій склад"
        ? "Виконано"
        : "Замовлено у постачальника";
    setItems(next);
  };

  const setLineStatus = (idx, val) => {
    const next = [...items];
    next[idx].lineStatus = val;
    setItems(next);
  };

  const calcOverallStatus = (its) => {
    const st = its.map((x) => x.lineStatus);
    if (st.every((s) => s === "Виконано"))
      return {
        status: "Завершено",
        hasCancellations: its.some((i) => (i.quantityCancelled || 0) > 0),
      };
    if (st.some((s) => s === "Замовлено у постачальника"))
      return {
        status: "Частково виконано",
        hasCancellations: its.some((i) => (i.quantityCancelled || 0) > 0),
      };
    return {
      status: "Нове",
      hasCancellations: its.some((i) => (i.quantityCancelled || 0) > 0),
    };
  };

  const save = async () => {
    setSaving(true);
    setStatus?.({ type: "info", message: "Збереження змін…" });
    try {
      const orderRef = doc(
        db,
        `/artifacts/${appId}/public/data/orders`,
        order.id
      );
      const oldStatus = order.status || "Нове";
      const { status: newStatus, hasCancellations } = calcOverallStatus(items);
      
      // Update order
      await updateDoc(orderRef, { items, status: newStatus, hasCancellations });
      
      // Update order counts if status changed
      if (oldStatus !== newStatus) {
        const orderCountsRef = doc(db, `/artifacts/${appId}/public/meta/counters/orderCounts`);
        try {
          await runTransaction(db, async (tx) => {
            const countsSnap = await tx.get(orderCountsRef);
            const current = countsSnap.exists ? countsSnap.data() : { new: 0, partial: 0 };
            let newCount = Number(current.new) || 0;
            let partialCount = Number(current.partial) || 0;
            
            // Decrease old status
            if (oldStatus === "Нове") {
              newCount = Math.max(0, newCount - 1);
            } else if (oldStatus === "Частково виконано") {
              partialCount = Math.max(0, partialCount - 1);
            }
            
            // Increase new status
            if (newStatus === "Нове") {
              newCount = newCount + 1;
            } else if (newStatus === "Частково виконано") {
              partialCount = partialCount + 1;
            }
            
            tx.set(orderCountsRef, {
              new: newCount,
              partial: partialCount,
              lastUpdated: new Date(),
            }, { merge: true });
          });
        } catch (e) {
          console.warn("Failed to update order counts", e);
          // Не блокуємо оновлення замовлення при помилці підрахунку
        }
      }
      
      setStatus?.({
        type: "success",
        message: `Замовлення оновлено. Новий статус: ${newStatus}`,
      });
      onSaved?.();
      onClose();
    } catch (e) {
      setStatus?.({ type: "error", message: e?.message || "Помилка збереження" });
    } finally {
      setSaving(false);
    }
  };

  // Визначення кольору рядка за статусом
  const getRowClass = (lineStatus) => {
    if (lineStatus === "Виконано") return "bg-green-50";
    if (lineStatus === "Замовлено у постачальника") return "bg-amber-50";
    return "";
  };

  return (
    <Modal
      title={`Замовлення №${order.orderNumber || order.id?.slice(0, 6)}`}
      onClose={onClose}
    >
      <div className="space-y-4">
        {/* Заголовок з інформацією та перемикачем валют */}
        <div className="flex flex-wrap items-start justify-between gap-3 pb-3 border-b">
          <div>
            <div className="font-semibold text-lg">
              {order.clientName}
            </div>
            <div className="text-sm text-slate-500">
              {order.clientPhone || "—"} • {order.createdAt?.seconds
                ? new Date(order.createdAt.seconds * 1000).toLocaleString()
                : "—"}
            </div>
          </div>
          
          {/* Перемикач валют */}
          <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-1">
            <button
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                modalCurrency === 'EUR' ? 'bg-white shadow text-indigo-600' : 'text-slate-600 hover:text-slate-800'
              }`}
              onClick={() => setModalCurrency('EUR')}
            >
              EUR €
            </button>
            <button
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                modalCurrency === 'UAH' ? 'bg-white shadow text-indigo-600' : 'text-slate-600 hover:text-slate-800'
              }`}
              onClick={() => setModalCurrency('UAH')}
              disabled={!uahRate}
              title={!uahRate ? "Курс UAH недоступний" : ""}
            >
              UAH ₴
            </button>
          </div>
        </div>

        {/* Таблиця товарів */}
        <div className="overflow-x-auto border rounded-lg">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-600 text-xs uppercase tracking-wide sticky top-0">
              <tr>
                <th className="px-2 py-2">Постачальник</th>
                <th className="px-2 py-2">Бренд</th>
                <th className="px-2 py-2">Артикул</th>
                <th className="px-2 py-2 max-w-[200px]">Назва</th>
                <th className="px-2 py-2 text-right">Ціна</th>
                <th className="px-2 py-2 text-center">Залишок</th>
                <th className="px-2 py-2 text-center">Замовл.</th>
                <th className="px-2 py-2 text-center">Скас.</th>
                <th className="px-2 py-2 text-center">Підтв.</th>
                <th className="px-2 py-2 text-right">Сума</th>
                <th className="px-2 py-2">Статус</th>
                <th className="px-2 py-2 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, idx) => {
                const unitPrice = parseFloat(it.price) || parseFloat(it.unitPrice) || 0;
                const lineSum = convertPrice(unitPrice * (it.quantityConfirmed || 0));
                
                return (
                  <tr key={idx} className={`border-t ${getRowClass(it.lineStatus)}`}>
                    {/* Постачальник */}
                    <td className="px-2 py-1.5">
                      {it.supplier === "Мій склад" ? (
                        <span className="text-green-700 font-medium text-xs">Склад</span>
                      ) : (
                        <span className="text-slate-600 text-xs">{it.supplier || "—"}</span>
                      )}
                    </td>
                    {/* Бренд */}
                    <td className="px-2 py-1.5 font-medium text-xs">{it.brand}</td>
                    {/* Артикул + кнопка копіювання */}
                    <td className="px-2 py-1.5 font-mono text-xs">
                      <div className="flex items-center gap-1">
                        <span>{it.id}</span>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(it.id || '');
                          }}
                          className="p-0.5 rounded hover:bg-slate-200 text-slate-400 hover:text-slate-600 transition-colors"
                          title="Копіювати артикул"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                          </svg>
                        </button>
                      </div>
                    </td>
                    {/* Назва (з переносом) */}
                    <td className="px-2 py-1.5 text-xs max-w-[200px] break-words whitespace-normal" title={it.name}>
                      {it.name}
                    </td>
                    {/* Ціна */}
                    <td className="px-2 py-1.5 text-right text-xs">
                      {convertPrice(unitPrice).toFixed(2)} {currencySymbol}
                    </td>
                    {/* Залишок */}
                    <td className="px-2 py-1.5 text-center text-xs text-slate-500">
                      {(() => {
                        // Тільки для "Мій склад" перевіряємо нестачу
                        if (it.supplier === "Мій склад" && it.docId && stockMap[it.docId] !== undefined) {
                          const stock = stockMap[it.docId];
                          if (it.quantity > stock) {
                            // Нестача — показуємо залишок
                            return <span className="text-red-600 font-medium">{stock}</span>;
                          }
                        }
                        return "—";
                      })()}
                    </td>
                    {/* Замовлено */}
                    <td className={`px-2 py-1.5 text-center font-medium ${
                      // Червоний фон якщо замовлено більше ніж є на складі
                      it.supplier === "Мій склад" && 
                      it.docId && 
                      stockMap[it.docId] !== undefined && 
                      it.quantity > stockMap[it.docId]
                        ? "bg-red-100 text-red-700 rounded"
                        : ""
                    }`}>
                      {it.quantity}
                    </td>
                    {/* Скасовано */}
                    <td className="px-2 py-1.5 text-center">
                      <input
                        type="number"
                        min={0}
                        max={it.quantity || 0}
                        value={it.quantityCancelled ?? 0}
                        onChange={(e) => recompute(idx, e.target.value)}
                        className="w-14 p-1 text-center border rounded text-xs"
                      />
                    </td>
                    {/* Підтверджено */}
                    <td className="px-2 py-1.5 text-center font-medium text-green-700">
                      {it.quantityConfirmed ?? 0}
                    </td>
                    {/* Сума */}
                    <td className="px-2 py-1.5 text-right font-medium text-xs">
                      {lineSum.toFixed(2)} {currencySymbol}
                    </td>
                    {/* Статус - кольоровий текст */}
                    <td className="px-2 py-1.5">
                      <select
                        value={it.lineStatus || ""}
                        onChange={(e) => setLineStatus(idx, e.target.value)}
                        className={`p-1 border rounded text-xs w-full max-w-[140px] font-medium ${
                          it.lineStatus === "Виконано" 
                            ? "text-green-600 bg-green-50 border-green-200" 
                            : it.lineStatus === "Замовлено у постачальника"
                            ? "text-blue-600 bg-blue-50 border-blue-200"
                            : "text-red-600 bg-red-50 border-red-200"
                        }`}
                      >
                        <option value="Очікує підтвердження">Очікує підтвердження</option>
                        <option value="Замовлено у постачальника">Замовлено у постачальника</option>
                        <option value="Виконано">Виконано</option>
                      </select>
                    </td>
                    {/* Кнопка "Підтв. все" - компактна галочка */}
                    <td className="px-2 py-1.5 text-center">
                      <button
                        onClick={() => quickConfirmAll(idx)}
                        className="p-1.5 rounded hover:bg-green-100 text-green-600 transition-colors"
                        title="Підтвердити все"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                );
              })}
              {!items.length && (
                <tr>
                  <td className="p-6 text-center text-slate-400" colSpan={12}>
                    Порожньо
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Футер з сумою та кнопками */}
        <div className="flex items-center justify-between pt-3 border-t">
          <div className="text-lg font-semibold text-slate-700">
            Сума до відвантаження: <span className="text-indigo-600">{totalToIssue.toFixed(2)} {currencySymbol}</span>
          </div>
          <div className="flex gap-2">
            <button
              className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-60"
              onClick={save}
              disabled={saving}
            >
              {saving ? "Збереження..." : "Зберегти зміни"}
            </button>
            <button
              className="px-4 py-2 rounded-lg bg-slate-100 hover:bg-slate-200"
              onClick={onClose}
            >
              Закрити
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* --------------------------------- Page ---------------------------------- */
export default function OrdersPage() {
  const [statusFilter, setStatusFilter] = useState("all"); // "all" | "new" | "partial" | "completed" | "archived"
  const [selectedCurrency, setSelectedCurrency] = useState(() => localStorage.getItem('adminSelectedCurrency') || 'EUR');
  const [uahRate, setUahRate] = useState(null);
  
  const qFactory = useCallback(
    (...mods) => {
      const baseQuery = collection(db, `/artifacts/${appId}/public/data/orders`);
      const conditions = [];
      
      if (statusFilter === "new") {
        conditions.push(where("status", "==", "Нове"));
        conditions.push(where("archived", "==", false));
      } else if (statusFilter === "partial") {
        conditions.push(where("status", "==", "Частково виконано"));
        conditions.push(where("archived", "==", false));
      } else if (statusFilter === "completed") {
        conditions.push(where("status", "==", "Завершено"));
        conditions.push(where("archived", "==", false));
      } else if (statusFilter === "archived") {
        conditions.push(where("archived", "==", true));
      }
      // "all" - no status filter, exclude archived
      if (statusFilter === "all") {
        conditions.push(where("archived", "==", false));
      }
      
      conditions.push(orderBy("createdAt", "desc"));
      return query(baseQuery, ...conditions, ...mods);
    },
    [statusFilter]
  );

  const pager = usePagedQuery(qFactory, 20);
  const [modalOrder, setModalOrder] = useState(null);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    pager.loadFirst();
  }, [qFactory, pager.loadFirst]);

  // Завантаження курсу валют
  useEffect(() => {
    const loadUahRate = async () => {
      try {
        const getCurrencyRate = httpsCallable(functions, 'getCurrencyRate');
        const result = await getCurrencyRate();
        if (result.data?.rate) {
          setUahRate(result.data.rate);
        }
      } catch (e) {
        console.warn("Failed to load UAH rate", e);
      }
    };
    loadUahRate();
  }, []);

  // авто-очищення повідомлень
  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(null), 3000);
    return () => clearTimeout(t);
  }, [status]);

  return (
    <div className="bg-white rounded-2xl shadow p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">Замовлення</h2>
        {status && (
          <div
            className={`text-sm px-3 py-1 rounded ${
              status.type === "error"
                ? "bg-red-100 text-red-700"
                : status.type === "success"
                ? "bg-green-100 text-green-700"
                : "bg-slate-100 text-slate-700"
            }`}
          >
            {status.message}
          </div>
        )}
      </div>

      {/* Currency selector */}
      <div className="flex items-center gap-2 mb-4">
        <span className="text-sm font-medium text-gray-700 whitespace-nowrap">Валюта:</span>
        <label className="flex items-center gap-2 cursor-pointer">
          <div className="relative inline-flex items-center">
            <input
              type="checkbox"
              checked={selectedCurrency === 'UAH'}
              onChange={(e) => {
                const newCurrency = e.target.checked ? 'UAH' : 'EUR';
                setSelectedCurrency(newCurrency);
                localStorage.setItem('adminSelectedCurrency', newCurrency);
              }}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-indigo-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
          </div>
          <span className="text-sm text-gray-700 whitespace-nowrap">{selectedCurrency === 'EUR' ? 'EUR' : 'UAH'}</span>
        </label>
      </div>

      {/* Status filters */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <button
          onClick={() => setStatusFilter("all")}
          className={`px-3 py-1.5 rounded-lg text-sm ${
            statusFilter === "all"
              ? "bg-indigo-600 text-white"
              : "bg-gray-100 hover:bg-gray-200"
          }`}
        >
          ВСІ
        </button>
        <button
          onClick={() => setStatusFilter("new")}
          className={`px-3 py-1.5 rounded-lg text-sm ${
            statusFilter === "new"
              ? "bg-indigo-600 text-white"
              : "bg-gray-100 hover:bg-gray-200"
          }`}
        >
          НОВІ
        </button>
        <button
          onClick={() => setStatusFilter("partial")}
          className={`px-3 py-1.5 rounded-lg text-sm ${
            statusFilter === "partial"
              ? "bg-indigo-600 text-white"
              : "bg-gray-100 hover:bg-gray-200"
          }`}
        >
          ЧАСТКОВО ВИКОНАНІ
        </button>
        <button
          onClick={() => setStatusFilter("completed")}
          className={`px-3 py-1.5 rounded-lg text-sm ${
            statusFilter === "completed"
              ? "bg-indigo-600 text-white"
              : "bg-gray-100 hover:bg-gray-200"
          }`}
        >
          ЗАВЕРШЕНІ
        </button>
        <button
          onClick={() => setStatusFilter("archived")}
          className={`px-3 py-1.5 rounded-lg text-sm ${
            statusFilter === "archived"
              ? "bg-indigo-600 text-white"
              : "bg-gray-100 hover:bg-gray-200"
          }`}
        >
          АРХІВ
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="text-left text-gray-500">
            <tr>
              <th className="p-2">№</th>
              <th className="p-2">Клієнт</th>
              <th className="p-2">Сума</th>
              <th className="p-2">Статус</th>
              <th className="p-2">Дата</th>
              <th className="p-2">Дії</th>
            </tr>
          </thead>
          <tbody>
            {pager.items.map((o) => (
              <tr
                key={o.id}
                className="border-t hover:bg-slate-50 cursor-pointer"
                onClick={() => setModalOrder({ id: o.id, ...o })}
              >
                <td className="p-2">{o.orderNumber || o.id.slice(-6)}</td>
                <td className="p-2">{o.clientName || o.clientId}</td>
                <td className="p-2">
                  {(() => {
                    let total = o.total || 0;
                    if (selectedCurrency === 'UAH' && uahRate && uahRate > 0 && total > 0) {
                      total = total * uahRate;
                      total = Math.round(total * 100) / 100;
                    }
                    const currencySymbol = selectedCurrency === 'EUR' ? '€' : '₴';
                    return total > 0 ? `${total.toFixed(2)} ${currencySymbol}` : "—";
                  })()}
                </td>
                <td className="p-2">{o.status || "Нове"}</td>
                <td className="p-2">
                  {o.createdAt?.toDate
                    ? o.createdAt.toDate().toLocaleString()
                    : "—"}
                </td>
                <td className="p-2">
                  <button
                    className="px-3 py-1 rounded bg-slate-100 hover:bg-slate-200"
                    onClick={(e) => {
                      e.stopPropagation();
                      setModalOrder({ id: o.id, ...o });
                    }}
                  >
                    Обробити
                  </button>
                </td>
              </tr>
            ))}
            {!pager.items.length && (
              <tr>
                <td className="p-6 text-center text-slate-400" colSpan={6}>
                  Немає замовлень.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <PaginatorButton
        onClick={pager.loadMore}
        disabled={pager.exhausted}
        loading={pager.loading}
      />

      {modalOrder && (
        <OrderProcessingModal
          order={modalOrder}
          onClose={() => setModalOrder(null)}
          onSaved={() => pager.reloadFirst?.() || pager.loadFirst()}
          setStatus={setStatus}
          selectedCurrency={selectedCurrency}
          uahRate={uahRate}
        />
      )}
    </div>
  );
}
