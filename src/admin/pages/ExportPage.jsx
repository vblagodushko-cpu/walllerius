import React, { useEffect, useMemo, useState } from "react";
import { collection, getDocs, query, where, orderBy } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../../firebase-config";

const appId = import.meta.env.VITE_PROJECT_ID || "embryo-project";

const primary = "px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white shadow";
const secondary = "px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200";

function toCsvValue(v) {
  if (v == null) return "";
  const s = String(v);
  if (s.includes(",") || s.includes(";") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function ExportPage({ setStatus }) {
  const [suppliers, setSuppliers] = useState([]);
  const [supplier, setSupplier] = useState("all");
  const [priceType, setPriceType] = useState("роздріб"); // default
  const [brandPrefix, setBrandPrefix] = useState("");
  const [stockOnly, setStockOnly] = useState(true);
  const [busy, setBusy] = useState(false);

  // load suppliers for filter
  useEffect(() => {
    (async () => {
      try {
        const snap = await getDocs(collection(db, `/artifacts/${appId}/public/data/suppliers`));
        const list = snap.docs.map(d => {
          const data = d.data() || {};
          return data.name || data.title || d.id;
        }).filter(Boolean).sort((a,b)=>String(a).localeCompare(String(b), "uk"));
        setSuppliers(list);
      } catch (e) {
        console.error(e);
      }
    })();
  }, []);

  const exportFetch = async () => {
    setBusy(true);
    setStatus?.(null);
    try {
      const call = httpsCallable(functions, "getProductsForAdmin");
      const payload = {
        supplier: supplier === "all" ? null : supplier,
        brandPrefix: brandPrefix.trim() || null,
        stockOnly: !!stockOnly,
        priceType: priceType || "роздріб",
        limit: 200000 // сервер сам відріже якщо треба
      };
      const { data } = await call(payload);
      // очікуємо масив продуктів
      const rows = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
      return rows.map(p => ({
        id: p.id,
        brand: p.brand || "",
        name: p.name || "",
        stock: p.stock ?? 0,
        price: (p.publicPrices && (p.publicPrices[priceType] ?? p.publicPrices["ціна 1"] ?? p.publicPrices["роздріб"] ?? p.publicPrices["ціна опт"])) || 0,
        supplier: p.supplier || ""
      }));
    } catch (e) {
      console.error(e);
      setStatus?.({ type: "error", message: e?.message || "Помилка отримання даних" });
      return [];
    } finally {
      setBusy(false);
    }
  };

  const onExportCSV = async () => {
    const items = await exportFetch();
    if (!items.length) { setStatus?.({ type:"info", message:"Немає даних для експорту" }); return; }
    const header = ["brand","id","name","stock","price","supplier"];
    const lines = [
      header.join(";"),
      ...items.map(r => header.map(k => toCsvValue(r[k])).join(";"))
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const fname = `export_${supplier === "all" ? "all" : supplier}_${priceType}.csv`;
    downloadBlob(fname, blob);
    setStatus?.({ type:"success", message:`CSV збережено (${items.length} рядків)` });
  };

  const onExportXLSX = async () => {
    if (!window.XLSX) { setStatus?.({ type:"error", message:"XLSX бібліотека не підключена в admin.html" }); return; }
    const items = await exportFetch();
    if (!items.length) { setStatus?.({ type:"info", message:"Немає даних для експорту" }); return; }
    const ws = window.XLSX.utils.json_to_sheet(items);
    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, "Products");
    const wbout = window.XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const blob = new Blob([wbout], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const fname = `export_${supplier === "all" ? "all" : supplier}_${priceType}.xlsx`;
    downloadBlob(fname, blob);
    setStatus?.({ type:"success", message:`XLSX збережено (${items.length} рядків)` });
  };

  // ===== Warehouse Price List URL Generation =====
  const [warehouseUrls, setWarehouseUrls] = useState([]);
  const [warehouseUrlType, setWarehouseUrlType] = useState("standard"); // "standard" | "client"
  const [warehousePriceType, setWarehousePriceType] = useState("ціна 1");
  const [warehouseClientCode, setWarehouseClientCode] = useState("");
  const [warehouseBusy, setWarehouseBusy] = useState(false);

  // Завантаження списку URL
  useEffect(() => {
    const loadUrls = async () => {
      try {
        const urlsCol = collection(db, `/artifacts/${appId}/public/data/warehousePriceListUrls`);
        const q = query(urlsCol, where("isActive", "==", true), orderBy("createdAt", "desc"));
        const snap = await getDocs(q);
        const urls = snap.docs.map(d => ({
          id: d.id,
          ...d.data()
        }));
        setWarehouseUrls(urls);
      } catch (e) {
        console.error("Error loading warehouse URLs", e);
      }
    };
    loadUrls();
  }, []);

  const generateWarehouseUrl = async () => {
    setWarehouseBusy(true);
    setStatus?.(null);
    try {
      const generateFn = httpsCallable(functions, "generateWarehousePriceListUrl");
      const payload = warehouseUrlType === "standard" 
        ? { priceType: warehousePriceType }
        : { clientCode: warehouseClientCode.trim() };
      
      const { data } = await generateFn(payload);
      
      if (data.success) {
        setStatus?.({ type: "success", message: `URL згенеровано: ${data.url}` });
        // Оновлюємо список
        const urlsCol = collection(db, `/artifacts/${appId}/public/data/warehousePriceListUrls`);
        const q = query(urlsCol, where("isActive", "==", true), orderBy("createdAt", "desc"));
        const snap = await getDocs(q);
        const urls = snap.docs.map(d => ({
          id: d.id,
          ...d.data()
        }));
        setWarehouseUrls(urls);
        // Очищаємо поля
        setWarehouseClientCode("");
      }
    } catch (e) {
      console.error(e);
      setStatus?.({ type: "error", message: e?.message || "Помилка генерації URL" });
    } finally {
      setWarehouseBusy(false);
    }
  };

  const deleteWarehouseUrl = async (token) => {
    if (!confirm("Видалити цей URL?")) return;
    
    setWarehouseBusy(true);
    setStatus?.(null);
    try {
      const deleteFn = httpsCallable(functions, "deleteWarehousePriceListUrl");
      await deleteFn({ token });
      setStatus?.({ type: "success", message: "URL видалено" });
      // Оновлюємо список
      setWarehouseUrls(warehouseUrls.filter(u => u.token !== token));
    } catch (e) {
      console.error(e);
      setStatus?.({ type: "error", message: e?.message || "Помилка видалення URL" });
    } finally {
      setWarehouseBusy(false);
    }
  };

  const copyUrl = (url) => {
    navigator.clipboard.writeText(url);
    setStatus?.({ type: "success", message: "URL скопійовано в буфер обміну" });
  };

  const formatDate = (timestamp) => {
    if (!timestamp) return "-";
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleString("uk-UA");
  };

  return (
    <div className="space-y-6">
      {/* Експорт прайсів (існуючий розділ) */}
    <div className="bg-white p-6 rounded-2xl shadow">
      <h2 className="text-2xl font-semibold mb-4">Експорт прайсів</h2>

      <div className="grid grid-cols-1 md:grid-cols-5 gap-3 mb-4">
        <label className="block">
          <span className="text-sm text-slate-600">Постачальник</span>
          <select className="mt-1 p-2 border rounded w-full" value={supplier} onChange={(e)=>setSupplier(e.target.value)}>
            <option value="all">Усі</option>
            {suppliers.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>

        <label className="block">
          <span className="text-sm text-slate-600">Категорія ціни</span>
          <select className="mt-1 p-2 border rounded w-full" value={priceType} onChange={(e)=>setPriceType(e.target.value)}>
            <option value="роздріб">роздріб</option>
            <option value="ціна 1">ціна 1</option>
            <option value="ціна 2">ціна 2</option>
            <option value="ціна 3">ціна 3</option>
            <option value="ціна опт">ціна опт</option>
          </select>
        </label>

        <label className="block">
          <span className="text-sm text-slate-600">Бренд (префікс)</span>
          <input className="mt-1 p-2 border rounded w-full" value={brandPrefix} onChange={(e)=>setBrandPrefix(e.target.value)} placeholder="напр. BOS" />
        </label>

        <label className="block">
          <span className="text-sm text-slate-600">Лише в наявності</span>
          <div className="mt-2">
            <input type="checkbox" checked={stockOnly} onChange={(e)=>setStockOnly(e.target.checked)} />{" "}
            <span className="text-sm">так</span>
          </div>
        </label>
      </div>

      <div className="flex gap-2">
        <button className={`${primary} disabled:opacity-60`} onClick={onExportCSV} disabled={busy}>Експорт CSV</button>
        <button className={`${secondary} disabled:opacity-60`} onClick={onExportXLSX} disabled={busy}>Експорт XLSX</button>
      </div>

      <p className="text-xs text-slate-500 mt-3">
        Дані отримуються через callable-функцію <code>getProductsForAdmin</code> на бекенді, без масових читань з браузера.
      </p>
      </div>

      {/* Прайс складу (новий розділ) */}
      <div className="bg-white p-6 rounded-2xl shadow">
        <h2 className="text-2xl font-semibold mb-4">Прайс складу (стабільні URL)</h2>
        
        {/* Генерація нового URL */}
        <div className="mb-6 p-4 bg-slate-50 rounded-lg">
          <h3 className="text-lg font-medium mb-3">Згенерувати новий URL</h3>
          
          <div className="mb-3">
            <label className="flex items-center gap-2 mb-2">
              <input
                type="radio"
                checked={warehouseUrlType === "standard"}
                onChange={() => setWarehouseUrlType("standard")}
                disabled={warehouseBusy}
              />
              <span>Стандартна ціна</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={warehouseUrlType === "client"}
                onChange={() => setWarehouseUrlType("client")}
                disabled={warehouseBusy}
              />
              <span>Ціни клієнта</span>
            </label>
          </div>

          {warehouseUrlType === "standard" ? (
            <div className="mb-3">
              <label className="block text-sm text-slate-600 mb-1">Категорія ціни</label>
              <select
                className="p-2 border rounded w-full"
                value={warehousePriceType}
                onChange={(e) => setWarehousePriceType(e.target.value)}
                disabled={warehouseBusy}
              >
                <option value="ціна 1">ціна 1</option>
                <option value="ціна 2">ціна 2</option>
                <option value="ціна 3">ціна 3</option>
                <option value="ціна опт">ціна опт</option>
                <option value="роздріб">роздріб</option>
              </select>
            </div>
          ) : (
            <div className="mb-3">
              <label className="block text-sm text-slate-600 mb-1">Код клієнта</label>
              <input
                type="text"
                className="p-2 border rounded w-full"
                value={warehouseClientCode}
                onChange={(e) => setWarehouseClientCode(e.target.value)}
                placeholder="Введіть код клієнта"
                disabled={warehouseBusy}
              />
            </div>
          )}

          <button
            className={`${primary} disabled:opacity-60`}
            onClick={generateWarehouseUrl}
            disabled={warehouseBusy || (warehouseUrlType === "client" && !warehouseClientCode.trim())}
          >
            {warehouseBusy ? "Генерація..." : "Згенерувати URL"}
          </button>
        </div>

        {/* Список активних URL */}
        <div>
          <h3 className="text-lg font-medium mb-3">Активні URL</h3>
          {warehouseUrls.length === 0 ? (
            <p className="text-slate-500">Немає активних URL</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="bg-slate-100">
                    <th className="border p-2 text-left">URL</th>
                    <th className="border p-2 text-left">Тип ціни</th>
                    <th className="border p-2 text-left">Створено</th>
                    <th className="border p-2 text-left">Оновлено</th>
                    <th className="border p-2 text-left">Дії</th>
                  </tr>
                </thead>
                <tbody>
                  {warehouseUrls.map((url) => (
                    <tr key={url.token}>
                      <td className="border p-2">
                        <code className="text-xs break-all">{url.url}</code>
                      </td>
                      <td className="border p-2">
                        {url.priceType ? (
                          <span className="text-sm">{url.priceType}</span>
                        ) : url.clientCode ? (
                          <span className="text-sm">Клієнт: {url.clientCode}</span>
                        ) : (
                          <span className="text-sm text-slate-400">-</span>
                        )}
                      </td>
                      <td className="border p-2 text-sm">{formatDate(url.createdAt)}</td>
                      <td className="border p-2 text-sm">{formatDate(url.lastUpdated)}</td>
                      <td className="border p-2">
                        <div className="flex gap-2">
                          <button
                            className="text-xs px-2 py-1 bg-blue-100 hover:bg-blue-200 rounded"
                            onClick={() => copyUrl(url.url)}
                            disabled={warehouseBusy}
                          >
                            Копіювати
                          </button>
                          <button
                            className="text-xs px-2 py-1 bg-red-100 hover:bg-red-200 rounded"
                            onClick={() => deleteWarehouseUrl(url.token)}
                            disabled={warehouseBusy}
                          >
                            Видалити
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <p className="text-xs text-slate-500 mt-3">
          URL генерується один раз і залишається стабільним. Ціни оновлюються щодня автоматично о 06:00.
        </p>
      </div>
    </div>
  );
}
