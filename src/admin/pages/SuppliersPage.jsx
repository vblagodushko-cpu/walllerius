import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  collection, doc, getDocs, setDoc, updateDoc, deleteDoc,
  query, where, writeBatch, onSnapshot, Timestamp
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../../firebase-config";

const appId = import.meta.env.VITE_PROJECT_ID;
if (!appId) {
  console.error("VITE_PROJECT_ID environment variable is required");
}

const primary = "px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white shadow";
const secondary = "px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200";
const danger = "px-3 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white";

/** ---------- Small UI ---------- */
function Modal({ title, onClose, children, wide=false }) {
  return (
    <div className="fixed inset-0 bg-black/40 z-50 grid place-items-center p-4">
      <div className={`bg-white rounded-2xl shadow-xl w-full ${wide ? "max-w-5xl" : "max-w-3xl"} max-h-[90vh] overflow-y-auto`}>
        <div className="sticky top-0 bg-white border-b p-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button onClick={onClose} className="text-2xl text-slate-500" aria-label="close">×</button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}

/** ---------- Column mapping modal for XLSX/CSV ---------- */
function ColumnMapModal({ headers, rows, supplier, onCancel, onConfirm }) {
  // Завантажуємо збережену конфігурацію
  const savedConfig = supplier?.importConfig || null;
  
  const [startRow, setStartRow] = useState(savedConfig?.startRow ?? 0);
  const [isImporting, setIsImporting] = useState(false);
  const [importResult, setImportResult] = useState(null); // { success: true/false, message: "" }
  
  // Отримуємо заголовки з правильного рядка
  const currentHeaders = useMemo(() => {
    if (headers && headers.length > 0) return headers;
    const headerRow = rows[startRow] || [];
    return headerRow.map((h) => String(h || "").trim());
  }, [headers, rows, startRow]);
  
  // heuristics to preselect
  const autoPick = (aliases) => {
    if (!currentHeaders || currentHeaders.length === 0) return "";
    const idx = currentHeaders.findIndex((h) => aliases.some((a) => String(h || "").toLowerCase().includes(a)));
    return idx >= 0 ? idx : "";
  };

  const [brandIdx, setBrandIdx] = useState(() => {
    if (savedConfig?.brandIdx != null) return savedConfig.brandIdx;
    // Використовуємо перший рядок для autoPick при ініціалізації
    const initHeaders = headers && headers.length > 0 ? headers : (rows[0] || []).map((h) => String(h || "").trim());
    const idx = initHeaders.findIndex((h) => ["бренд","brand","виробник","manufacturer"].some((a) => String(h || "").toLowerCase().includes(a)));
    return idx >= 0 ? idx : "";
  });
  const [idIdx, setIdIdx] = useState(() => {
    if (savedConfig?.idIdx != null) return savedConfig.idIdx;
    const initHeaders = headers && headers.length > 0 ? headers : (rows[0] || []).map((h) => String(h || "").trim());
    const idx = initHeaders.findIndex((h) => ["артикул","код","sku","id","article"].some((a) => String(h || "").toLowerCase().includes(a)));
    return idx >= 0 ? idx : "";
  });
  const [nameIdx, setNameIdx] = useState(() => {
    if (savedConfig?.nameIdx != null) return savedConfig.nameIdx;
    const initHeaders = headers && headers.length > 0 ? headers : (rows[0] || []).map((h) => String(h || "").trim());
    const idx = initHeaders.findIndex((h) => ["опис","назва","товар","name","desc"].some((a) => String(h || "").toLowerCase().includes(a)));
    return idx >= 0 ? idx : "";
  });
  const [stockIdx, setStockIdx] = useState(() => {
    if (savedConfig?.stockIdx != null) return savedConfig.stockIdx;
    const initHeaders = headers && headers.length > 0 ? headers : (rows[0] || []).map((h) => String(h || "").trim());
    const idx = initHeaders.findIndex((h) => ["наяв","залиш","stock","к-сть","qty","quantity"].some((a) => String(h || "").toLowerCase().includes(a)));
    return idx >= 0 ? idx : "";
  });
  const [priceIdx, setPriceIdx] = useState(() => {
    if (savedConfig?.priceIdx != null) return savedConfig.priceIdx;
    const initHeaders = headers && headers.length > 0 ? headers : (rows[0] || []).map((h) => String(h || "").trim());
    const idx = initHeaders.findIndex((h) => ["ціна","price","прайс","retail"].some((a) => String(h || "").toLowerCase().includes(a)));
    return idx >= 0 ? idx : "";
  });
  const [saveConfig, setSaveConfig] = useState(true); // Чекбокс "Зберегти конфігурацію"

  // Оновлюємо індекси коли startRow змінюється (якщо вони не валідні)
  useEffect(() => {
    if (currentHeaders.length === 0) return;
    const maxIdx = currentHeaders.length - 1;
    if (brandIdx !== "" && Number(brandIdx) > maxIdx) setBrandIdx("");
    if (idIdx !== "" && Number(idIdx) > maxIdx) setIdIdx("");
    if (nameIdx !== "" && Number(nameIdx) > maxIdx) setNameIdx("");
    if (stockIdx !== "" && Number(stockIdx) > maxIdx) setStockIdx("");
    if (priceIdx !== "" && Number(priceIdx) > maxIdx) setPriceIdx("");
  }, [startRow, currentHeaders.length]);

  const firstRows = rows.slice(Math.max(0, startRow), Math.max(0, startRow) + 5);

  const valid = brandIdx !== "" && idIdx !== "" && nameIdx !== "" && stockIdx !== "" && priceIdx !== "";

  const select = (label, value, setValue) => (
    <label className="block">
      <span className="text-sm text-slate-600">{label}</span>
      <select className="mt-1 p-2 border rounded w-full" value={value} onChange={(e)=>setValue(e.target.value)}>
        <option value="">— оберіть колонку —</option>
        {currentHeaders.map((h, i) => (
          <option key={i} value={i}>{h || `(порожньо ${i})`}</option>
        ))}
      </select>
    </label>
  );

  const previewCell = (row, idx) => {
    if (idx === "") return <span className="text-slate-400">—</span>;
    const v = row[Number(idx)];
    return <span>{String(v ?? "")}</span>;
  };

  const handleImport = async () => {
    if (!valid || isImporting) return;
    
    setIsImporting(true);
    setImportResult(null);
    
    try {
      const result = await onConfirm({
        startRow: Number(startRow),
        brandIdx: Number(brandIdx),
        idIdx: Number(idIdx),
        nameIdx: Number(nameIdx),
        stockIdx: Number(stockIdx),
        priceIdx: Number(priceIdx),
        saveConfig: saveConfig
      });
      
      // Якщо onConfirm не викинув помилку - імпорт запущено
      setImportResult({ 
        success: true, 
        message: result?.message || "Імпорт запущено. Результат буде показано пізніше." 
      });
      
      // Автоматично закрити модалку через 2 секунди після запуску
      setTimeout(() => {
        onCancel();
      }, 2000);
    } catch (error) {
      setImportResult({ 
        success: false, 
        message: error?.message || "Помилка імпорту" 
      });
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <Modal title="Зіставлення колонок" onClose={onCancel} wide>
      {/* Інформація про збережену конфігурацію */}
      {savedConfig && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-green-800">
                ✓ Знайдено збережену конфігурацію для "{supplier?.name || 'постачальника'}"
              </p>
              <p className="text-xs text-green-600 mt-1">
                Початок таблиці: рядок {savedConfig.startRow + 1}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setStartRow(savedConfig.startRow ?? 0);
                setBrandIdx(savedConfig.brandIdx ?? "");
                setIdIdx(savedConfig.idIdx ?? "");
                setNameIdx(savedConfig.nameIdx ?? "");
                setStockIdx(savedConfig.stockIdx ?? "");
                setPriceIdx(savedConfig.priceIdx ?? "");
              }}
              className="px-3 py-1 text-sm bg-green-600 hover:bg-green-700 text-white rounded"
            >
              Застосувати
            </button>
          </div>
        </div>
      )}

      {/* Блок вибору початкового рядка */}
      <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded">
        <label className="block text-sm font-medium mb-2">
          Початок таблиці (пропустити рядків зверху):
        </label>
        <div className="flex items-center gap-3">
          <input
            type="number"
            min="0"
            max={Math.max(0, rows.length - 1)}
            value={startRow}
            onChange={(e) => {
              const val = Math.max(0, Math.min(rows.length - 1, Number(e.target.value) || 0));
              setStartRow(val);
            }}
            className="w-24 p-2 border rounded"
          />
          <span className="text-sm text-gray-600">
            (Рядок {startRow + 1} буде використано як заголовок)
          </span>
        </div>
        {/* Попередній перегляд перших рядків */}
        <div className="mt-3 text-xs text-gray-600">
          <p className="font-medium mb-1">Попередній перегляд (перші 5 рядків):</p>
          <div className="bg-white border rounded p-2 max-h-32 overflow-y-auto">
            {rows.slice(0, Math.min(5, rows.length)).map((row, idx) => (
              <div 
                key={idx} 
                className={`text-xs font-mono py-1 px-2 cursor-pointer hover:bg-gray-100 ${
                  idx === startRow ? 'bg-yellow-200 font-bold' : ''
                }`}
                onClick={() => setStartRow(idx)}
                title="Натисніть щоб вибрати цей рядок як заголовок"
              >
                Рядок {idx + 1}: {row.slice(0, 3).map(c => String(c || '').slice(0, 20)).join(' | ')}...
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
        {select("Бренд", brandIdx, setBrandIdx)}
        {select("Артикул / Код", idIdx, setIdIdx)}
        {select("Назва", nameIdx, setNameIdx)}
        {select("Наявність", stockIdx, setStockIdx)}
        {select("Ціна", priceIdx, setPriceIdx)}
      </div>

      <div className="mt-4 border rounded overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-2 text-left">Бренд</th>
              <th className="px-3 py-2 text-left">Артикул</th>
              <th className="px-3 py-2 text-left">Назва</th>
              <th className="px-3 py-2 text-left">Наявність</th>
              <th className="px-3 py-2 text-left">Ціна</th>
            </tr>
          </thead>
          <tbody>
            {firstRows.map((r, idx) => (
              <tr key={idx} className="border-t">
                <td className="px-3 py-2">{previewCell(r, brandIdx)}</td>
                <td className="px-3 py-2">{previewCell(r, idIdx)}</td>
                <td className="px-3 py-2">{previewCell(r, nameIdx)}</td>
                <td className="px-3 py-2">{previewCell(r, stockIdx)}</td>
                <td className="px-3 py-2">{previewCell(r, priceIdx)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Чекбокс збереження конфігурації */}
      {supplier?.id && !isImporting && (
        <div className="mt-4 p-3 bg-gray-50 border rounded">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={saveConfig}
              onChange={(e) => setSaveConfig(e.target.checked)}
              className="w-4 h-4"
              disabled={isImporting}
            />
            <span className="text-sm">
              Зберегти цю конфігурацію для "{supplier.name}" (буде використано при наступному імпорті)
            </span>
          </label>
        </div>
      )}

      {/* Індикатор завантаження */}
      {isImporting && (
        <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded">
          <div className="flex items-center gap-3">
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
            <div>
              <p className="text-sm font-medium text-blue-800">Імпорт у прогресі...</p>
              <p className="text-xs text-blue-600 mt-1">Будь ласка, зачекайте. Це може зайняти кілька хвилин.</p>
            </div>
          </div>
        </div>
      )}

      {/* Результат імпорту */}
      {importResult && !isImporting && (
        <div className={`mt-4 p-4 rounded ${
          importResult.success 
            ? 'bg-green-50 border border-green-200' 
            : 'bg-red-50 border border-red-200'
        }`}>
          <div className="flex items-center gap-2">
            {importResult.success ? (
              <span className="text-green-600 text-xl">✓</span>
            ) : (
              <span className="text-red-600 text-xl">✗</span>
            )}
            <div className="flex-1">
              <p className={`text-sm font-medium ${
                importResult.success ? 'text-green-800' : 'text-red-800'
              }`}>
                {importResult.message}
              </p>
              {importResult.success && (
                <p className="text-xs text-green-600 mt-1">
                  Модалка закриється автоматично через кілька секунд...
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <button 
          className={secondary} 
          onClick={onCancel}
          disabled={isImporting && !importResult}
        >
          {isImporting && !importResult ? "Зачекайте..." : "Скасувати"}
        </button>
        <button
          className={`${primary} disabled:opacity-60 disabled:cursor-not-allowed`}
          disabled={!valid || isImporting}
          onClick={handleImport}
        >
          {isImporting ? (
            <span className="flex items-center gap-2">
              <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></span>
              Імпорт...
            </span>
          ) : (
            "Імпортувати"
          )}
        </button>
      </div>
    </Modal>
  );
}

/** ---------- Supplier settings modal ---------- */
function SupplierModal({ initial, onClose, onSaved, setStatus }) {
  const [name, setName] = useState(initial?.name || "");
  const [comment, setComment] = useState(initial?.comment || "");
  const [updateMethod, setUpdateMethod] = useState(initial?.updateMethod || "manual"); // manual | auto_url
  const [priceListUrl, setPriceListUrl] = useState(initial?.priceListUrl || "");
  const [schedule, setSchedule] = useState(initial?.schedule || ""); // Cron schedule (для збереження)
  const [autoUpdate, setAutoUpdate] = useState(initial?.autoUpdate !== false); // За замовчуванням true
  const [filterPriceListByMasterData, setFilterPriceListByMasterData] = useState(initial?.filterPriceListByMasterData === true);
  
  // UI state для розкладу
  const [scheduleHour, setScheduleHour] = useState(8);
  const [scheduleMinute, setScheduleMinute] = useState(0);
  const [scheduleDays, setScheduleDays] = useState([1,2,3,4,5]); // Пн-Пт за замовчуванням

  // Markups: роздріб, ціна 1, ціна 2, ціна 3, ціна опт
  const [mRetail, setMRetail] = useState(initial?.rules?.["роздріб"] ?? "");
  const [m1, setM1] = useState(initial?.rules?.["ціна 1"] ?? "");
  const [m2, setM2] = useState(initial?.rules?.["ціна 2"] ?? "");
  const [m3, setM3] = useState(initial?.rules?.["ціна 3"] ?? "");
  const [mOpt, setMOpt] = useState(initial?.rules?.["ціна опт"] ?? "");

  // Парсинг cron виразу у UI стан
  const parseScheduleToUI = (cronStr) => {
    if (!cronStr || !cronStr.trim()) {
      setScheduleHour(8);
      setScheduleMinute(0);
      setScheduleDays([1,2,3,4,5]);
      return;
    }
    const parts = cronStr.trim().split(/\s+/);
    if (parts.length >= 5) {
      const minute = Number(parts[0]) || 0;
      const hour = Number(parts[1]) || 8;
      setScheduleMinute(minute);
      setScheduleHour(hour);
      
      // Парсинг днів: "1-5" -> [1,2,3,4,5], "*" -> [1,2,3,4,5,6,7], "0,6" -> [0,6]
      const daysPart = parts[4];
      let days = [];
      if (daysPart === "*") {
        days = [1,2,3,4,5,6,7];
      } else if (daysPart.includes("-")) {
        const [start, end] = daysPart.split("-").map(Number);
        days = Array.from({length: end-start+1}, (_,i) => start+i);
      } else if (daysPart.includes(",")) {
        days = daysPart.split(",").map(Number);
      } else {
        days = [Number(daysPart)];
      }
      setScheduleDays(days);
    }
  };

  // Генерація cron виразу з UI стану
  const generateScheduleFromUI = () => {
    const minute = scheduleMinute;
    const hour = scheduleHour;
    let daysStr = "*";
    
    if (scheduleDays.length === 0) {
      daysStr = "*"; // Якщо нічого не обрано - всі дні
    } else {
      const sortedDays = [...scheduleDays].sort((a,b) => a-b);
      const sortedStr = sortedDays.join(",");
      
      if (sortedDays.length === 7 && sortedStr === "0,1,2,3,4,5,6") {
        daysStr = "*"; // Всі дні
      } else if (sortedDays.length === 5 && sortedStr === "1,2,3,4,5") {
        daysStr = "1-5"; // Будні (Пн-Пт)
      } else if (sortedDays.length === 2 && sortedStr === "0,6") {
        daysStr = "0,6"; // Вихідні (Нд, Сб)
      } else {
        daysStr = sortedStr;
      }
    }
    
    return `${minute} ${hour} * * ${daysStr}`;
  };

  // Парсинг при завантаженні постачальника
  useEffect(() => {
    if (initial?.schedule) {
      parseScheduleToUI(initial.schedule);
    } else {
      // Якщо немає розкладу - встановлюємо дефолтні значення
      setScheduleHour(8);
      setScheduleMinute(0);
      setScheduleDays([1,2,3,4,5]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial?.id]); // Парсимо тільки при зміні постачальника

  const deleteImportConfig = async () => {
    if (!confirm("Видалити збережену конфігурацію імпорту?")) return;
    try {
      await updateDoc(
        doc(db, `/artifacts/${appId}/public/data/suppliers`, initial.id),
        { importConfig: null }
      );
      setStatus?.({ type: "success", message: "Конфігурацію видалено." });
      onSaved?.(); // Перезавантажити список
    } catch (e) {
      setStatus?.({ type: "error", message: e?.message || "Помилка видалення" });
    }
  };

  const save = async (e) => {
  e.preventDefault();
  try {
    // Валідація: якщо увімкнено автоматичне оновлення, має бути обрано хоча б один день
    if (autoUpdate && scheduleDays.length === 0) {
      setStatus?.({ type: "error", message: "Оберіть хоча б один день тижня для автоматичного оновлення" });
      return;
    }

    const id = initial?.id || doc(collection(db, `/artifacts/${appId}/public/data/suppliers`)).id;

    // 1) сам постачальник
    const scheduleToSave = autoUpdate ? generateScheduleFromUI() : null;
    await setDoc(doc(db, `/artifacts/${appId}/public/data/suppliers`, id), {
      id, name, comment, updateMethod, priceListUrl, schedule: scheduleToSave, autoUpdate,
      filterPriceListByMasterData: filterPriceListByMasterData || false
    }, { merge: true });

    // 2) правила ціноутворення — пишемо і map, і плоскі UA-ключі + supplierId
    const rulesMap = {
      "роздріб": mRetail === "" ? "" : Number(mRetail),
      "ціна 1":  m1 === "" ? "" : Number(m1),
      "ціна 2":  m2 === "" ? "" : Number(m2),
      "ціна 3":  m3 === "" ? "" : Number(m3),
      "ціна опт": mOpt === "" ? "" : Number(mOpt),
    };

    await setDoc(doc(db, `/artifacts/${appId}/public/data/pricingRules`, id), {
      supplierId: id,           // ← ключ для пошуку при рандомних ID
      rules: rulesMap,          // вкладений map
      // плоскі UA-ключі для сумісності:
      ...rulesMap
    }, { merge: true });

    setStatus?.({ type: "success", message: "Налаштування збережено." });
    onSaved?.();
    onClose();
  } catch (e2) {
    setStatus?.({ type: "error", message: e2?.message || "Помилка збереження" });
  }
};

  return (
    <Modal title={initial ? "Налаштувати постачальника" : "Додати постачальника"} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <div>
          <label className="block text-sm">Назва</label>
          <input className="mt-1 w-full p-2 border rounded" value={name} onChange={e=>setName(e.target.value)} required />
        </div>
        <div>
          <label className="block text-sm">Коментар / умови</label>
          <input className="mt-1 w-full p-2 border rounded" value={comment} onChange={e=>setComment(e.target.value)} />
        </div>

        {/* Markups */}
        <div className="grid grid-cols-1 sm:grid-cols-5 gap-4">
          <div>
            <label className="block text-sm">роздріб, %</label>
            <input className="mt-1 w-full p-2 border rounded" value={mRetail} onChange={e=>setMRetail(e.target.value)} type="number" placeholder="0" />
          </div>
          <div>
            <label className="block text-sm">ціна 1, %</label>
            <input className="mt-1 w-full p-2 border rounded" value={m1} onChange={e=>setM1(e.target.value)} type="number" placeholder="0" />
          </div>
          <div>
            <label className="block text-sm">ціна 2, %</label>
            <input className="mt-1 w-full p-2 border rounded" value={m2} onChange={e=>setM2(e.target.value)} type="number" placeholder="0" />
          </div>
          <div>
            <label className="block text-sm">ціна 3, %</label>
            <input className="mt-1 w-full p-2 border rounded" value={m3} onChange={e=>setM3(e.target.value)} type="number" placeholder="0" />
          </div>
          <div>
            <label className="block text-sm">ціна опт, %</label>
            <input className="mt-1 w-full p-2 border rounded" value={mOpt} onChange={e=>setMOpt(e.target.value)} type="number" placeholder="0" />
          </div>
        </div>

        {/* Фільтр прайсу по мастерданих */}
        <div className="border-t pt-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={filterPriceListByMasterData}
              onChange={(e) => setFilterPriceListByMasterData(e.target.checked)}
              className="w-4 h-4"
            />
            <span className="text-sm font-medium">Фільтрувати прайс по мастерданих</span>
          </label>
          <p className="text-xs text-slate-500 mt-1 ml-6">
            При імпорті зберігати лише позиції, які є в мастерданих (мастила); позиції без мастерданих не зберігати і видалити з каталогу для цього постачальника.
          </p>
        </div>

        {/* Update method/URL — інформаційний блок (кнопки винесені у список) */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-t pt-4">
          <div>
            <label className="block text-sm">Метод оновлення</label>
            <select className="mt-1 w-full p-2 border rounded" value={updateMethod} onChange={e=>setUpdateMethod(e.target.value)}>
              <option value="manual">Файл (.csv/.xlsx)</option>
              <option value="auto_url">URL (авто)</option>
            </select>
          </div>
          <div>
            <label className="block text-sm">URL прайсу (для авто)</label>
            <input className="mt-1 w-full p-2 border rounded" value={priceListUrl} onChange={e=>setPriceListUrl(e.target.value)} placeholder="https://..." />
          </div>
        </div>

        {/* Автоматичне оновлення та розклад */}
        {updateMethod === "auto_url" && (
          <div className="border-t pt-4 space-y-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input 
                type="checkbox" 
                checked={autoUpdate} 
                onChange={e => setAutoUpdate(e.target.checked)}
                className="w-4 h-4"
              />
              <span className="text-sm font-medium">Автоматичне оновлення за розкладом</span>
            </label>
            
            {autoUpdate && (
              <>
                <div className="space-y-3">
                  <label className="block text-sm font-medium">Час оновлення</label>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-slate-600 mb-1">Година</label>
                      <select 
                        className="w-full p-2 border rounded"
                        value={scheduleHour}
                        onChange={e => setScheduleHour(Number(e.target.value))}
                      >
                        {Array.from({length: 24}, (_, i) => (
                          <option key={i} value={i}>{String(i).padStart(2, '0')}:00</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-slate-600 mb-1">Хвилина</label>
                      <select 
                        className="w-full p-2 border rounded"
                        value={scheduleMinute}
                        onChange={e => setScheduleMinute(Number(e.target.value))}
                      >
                        <option value={0}>00</option>
                        <option value={15}>15</option>
                        <option value={30}>30</option>
                        <option value={45}>45</option>
                      </select>
                    </div>
                  </div>
                  
                  <div>
                    <label className="block text-xs text-slate-600 mb-2">Дні тижня</label>
                    <div className="flex flex-wrap gap-2">
                      {[
                        {value: 1, label: 'Пн'},
                        {value: 2, label: 'Вт'},
                        {value: 3, label: 'Ср'},
                        {value: 4, label: 'Чт'},
                        {value: 5, label: 'Пт'},
                        {value: 6, label: 'Сб'},
                        {value: 0, label: 'Нд'}
                      ].map(day => (
                        <label key={day.value} className="flex items-center gap-1 cursor-pointer px-2 py-1 rounded border border-slate-200 hover:bg-slate-50">
                          <input
                            type="checkbox"
                            checked={scheduleDays.includes(day.value)}
                            onChange={e => {
                              if (e.target.checked) {
                                setScheduleDays([...scheduleDays, day.value]);
                              } else {
                                setScheduleDays(scheduleDays.filter(d => d !== day.value));
                              }
                            }}
                            className="w-4 h-4"
                          />
                          <span className="text-sm">{day.label}</span>
                        </label>
                      ))}
                    </div>
                    {scheduleDays.length === 0 && (
                      <p className="text-xs text-red-500 mt-1">Оберіть хоча б один день тижня</p>
                    )}
                  </div>
                  
                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-2">
                    <p className="text-xs text-slate-600">
                      Розклад: <code className="bg-white px-1.5 py-0.5 rounded font-mono text-xs">{generateScheduleFromUI()}</code>
                    </p>
                  </div>
                </div>
                
                <div className="bg-orange-50 border border-orange-200 rounded-lg p-3">
                  <p className="text-xs text-orange-800 font-medium mb-1">⚠️ Рекомендація:</p>
                  <p className="text-xs text-orange-700">
                    Краще налаштовувати завантаження в будь-який час <strong>крім проміжку 10:00-17:00</strong>, 
                    особливо на початку години (10:00, 11:00, 12:00...), щоб уникнути конфліктів з UkrSklad синхронізацією.
                  </p>
                  <p className="text-xs text-orange-700 mt-1">
                    <strong>Важливо:</strong> Планувальник запускається щогодини о :00. Для надійності використовуйте час на початку години (00, 15, 30, 45 хвилин).
                  </p>
                </div>
              </>
            )}
          </div>
        )}

        {/* Збережена конфігурація імпорту */}
        {initial?.id && initial?.importConfig && (
          <div className="border-t pt-4">
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium">Збережена конфігурація імпорту</label>
              <button
                type="button"
                onClick={deleteImportConfig}
                className="px-3 py-1 text-xs bg-red-100 hover:bg-red-200 text-red-700 rounded"
              >
                Видалити
              </button>
            </div>
            <div className="text-xs text-gray-600 bg-gray-50 p-2 rounded">
              <p>Початок таблиці: рядок {initial.importConfig.startRow + 1}</p>
              <p className="mt-1">
                Колонки: Бренд={initial.importConfig.brandIdx + 1}, 
                Артикул={initial.importConfig.idIdx + 1}, 
                Назва={initial.importConfig.nameIdx + 1}, 
                Наявність={initial.importConfig.stockIdx + 1}, 
                Ціна={initial.importConfig.priceIdx + 1}
              </p>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-3">
          <button type="button" className={secondary} onClick={onClose}>Скасувати</button>
          <button className={primary}>Зберегти</button>
        </div>
      </form>
    </Modal>
  );
}

/** ---------- Main SuppliersPage ---------- */
export default function SuppliersPage({ setStatus }) {
  const [items, setItems] = useState([]);
  const [editing, setEditing] = useState(null);
  const [updatingUrls, setUpdatingUrls] = useState(new Set()); // Set of supplier IDs being updated

  // XLSX mapping modal state
  const [mapModal, setMapModal] = useState(null); // { supplier, headers, rows }
  const importJobUnsubscribeRef = useRef(null); // Для cleanup підписки на job

  const fileInputRef = useRef(null);
  const fileSupplierRef = useRef(null);

  const load = async () => {
  // 1) постачальники
  const snap = await getDocs(collection(db, `/artifacts/${appId}/public/data/suppliers`));
  const list = snap.docs.map(d => ({ 
    id: d.id, 
    ...d.data(),
    importConfig: d.data().importConfig || null // Додаємо importConfig
  }));

  // 2) швидка мапа правил за id документа
  const rulesSnap = await getDocs(collection(db, `/artifacts/${appId}/public/data/pricingRules`));
  const rulesByDocId = Object.fromEntries(rulesSnap.docs.map(d => [d.id, d.data()]));

  // 3) підливка: якщо правила не знайдені по docId — шукаємо по supplierId
  for (const s of list) {
    let pr = rulesByDocId[s.id];
    if (!pr) {
      const qSnap = await getDocs(
        query(collection(db, `/artifacts/${appId}/public/data/pricingRules`), where("supplierId", "==", s.id))
      );
      pr = qSnap.docs[0]?.data();
    }
    s.rules = pr?.rules || {
      // якщо плоскі UA-ключі збережені без rules
      "роздріб": pr?.["роздріб"],
      "ціна 1":  pr?.["ціна 1"],
      "ціна 2":  pr?.["ціна 2"],
      "ціна 3":  pr?.["ціна 3"],
      "ціна опт": pr?.["ціна опт"],
    };
  }

  setItems(list);
};


  useEffect(() => { load(); }, []);

  const removeSupplier = async (s) => {
    if (!confirm(`Видалити постачальника "${s.name}" і ВСІ його товари?`)) return;
    try {
      await deleteDoc(doc(db, `/artifacts/${appId}/public/data/suppliers`, s.id));
      const qRef = query(collection(db, `/artifacts/${appId}/public/data/products`), where("supplier","==", s.name));
      const snap = await getDocs(qRef);
      const batch = writeBatch(db);
      snap.forEach(d => batch.delete(d.ref));
      await batch.commit();
      setStatus?.({ type: "success", message: "Постачальника і товари видалено." });
      load();
    } catch (e) {
      setStatus?.({ type: "error", message: e?.message || "Помилка видалення" });
    }
  };

  const updateFromUrl = async (s) => {
    if (!s.priceListUrl) { 
      setStatus?.({ type: "error", message: "Не вказано URL прайсу в налаштуваннях постачальника." }); 
      return; 
    }
    
    // Додаємо в список оновлюваних
    setUpdatingUrls(prev => new Set(prev).add(s.id));
    
    try {
      setStatus?.({ type: "info", message: `Запуск оновлення прайсу для "${s.name}"… Це може зайняти кілька хвилин.` });
      
      // Створюємо job документ для відстеження
      const jobId = `import_url_${s.id}_${Date.now()}`;
      const jobRef = doc(db, `/artifacts/${appId}/private/data/importJobs/${jobId}`);
      
      await setDoc(jobRef, {
        supplierId: s.id,
        supplierName: s.name,
        status: "running",
        createdAt: Timestamp.now(),
        type: "url_import",
        url: s.priceListUrl
      });
      
      // Викликаємо функцію (не чекаємо результат)
      const call = httpsCallable(functions, "importSupplierCsv");
      call({ 
        url: s.priceListUrl, 
        supplier: { id: s.id, name: s.name },
        jobId
      }).catch((error) => {
        // Якщо помилка при запуску
        updateDoc(jobRef, {
          status: "failed",
          completedAt: Timestamp.now(),
          error: error?.message || "Помилка запуску імпорту"
        });
      });
      
      // Підписуємося на зміни job документа
      const unsubscribe = onSnapshot(jobRef, (snap) => {
        if (!snap.exists()) {
          setUpdatingUrls(prev => {
            const next = new Set(prev);
            next.delete(s.id);
            return next;
          });
          return;
        }
        
        const jobData = snap.data();
        
        if (jobData.status === "completed") {
          let message = `Прайс для "${s.name}" оновлено успішно.`;
          if (jobData.result?.ok !== undefined) {
            message += ` Оброблено: ${jobData.result.ok} товарів.`;
            if (jobData.result.skipped > 0) {
              message += ` Пропущено: ${jobData.result.skipped} рядків.`;
            }
            if (jobData.result.removed > 0) {
              message += ` Видалено: ${jobData.result.removed} товарів з нульовою наявністю.`;
            }
          }
          setStatus?.({ type: "success", message });
          unsubscribe();
          setUpdatingUrls(prev => {
            const next = new Set(prev);
            next.delete(s.id);
            return next;
          });
        } else if (jobData.status === "failed") {
          setStatus?.({ type: "error", message: `Помилка оновлення прайсу для "${s.name}": ${jobData.error || "Не вдалося оновити прайс"}` });
          unsubscribe();
          setUpdatingUrls(prev => {
            const next = new Set(prev);
            next.delete(s.id);
            return next;
          });
        }
      }, (error) => {
        console.error("Помилка підписки на job:", error);
        setStatus?.({ type: "error", message: `Помилка відстеження оновлення: ${error.message}` });
        setUpdatingUrls(prev => {
          const next = new Set(prev);
          next.delete(s.id);
          return next;
        });
      });
      
    } catch (e) {
      setStatus?.({ type: "error", message: `Помилка запуску оновлення: ${e?.message || "Не вдалося запустити оновлення"}` });
      setUpdatingUrls(prev => {
        const next = new Set(prev);
        next.delete(s.id);
        return next;
      });
    }
  };

  const triggerFilePick = (s) => {
    if (!window.XLSX) {
      setStatus?.({ type: "error", message: "Бібліотека XLSX не підключена у admin.html" });
      return;
    }
    fileSupplierRef.current = s;
    fileInputRef.current?.click();
  };

  const onFileChange = (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e2) => {
      try {
        const wb = window.XLSX.read(e2.target.result, { type: "binary" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
        // Зберігаємо ВСІ рядки (включаючи зайві зверху)
        if (!rows.length) throw new Error("Порожній файл або нечитабельний вміст.");
        setMapModal({ 
          supplier: fileSupplierRef.current, 
          headers: null, // Буде встановлено після вибору startRow
          rows: rows, // ВСІ рядки
          allRows: rows // Зберігаємо оригінал
        });
      } catch (err) {
        setStatus?.({ type: "error", message: err?.message || "Помилка читання файлу" });
      }
    };
    reader.readAsBinaryString(file);
  };

  const doImportWithMapping = async (map) => {
    const s = mapModal.supplier;
    const allRows = mapModal.rows || mapModal.allRows || []; // Всі рядки
    const startRow = map.startRow || 0; // Початок таблиці
    
    // Пропускаємо рядки до startRow, потім беремо заголовки і дані
    const headers = (allRows[startRow] || []).map((h) => String(h || "").trim());
    const body = allRows.slice(startRow + 1); // Дані після заголовка

    const toNumber = (v) => {
      const str = String(v ?? "").replace(",", ".").trim();
      const n = Number(str);
      if (Number.isFinite(n)) return n;
      const m = str.match(/-?\d+(\.\d+)?/);
      return m ? Number(m[0]) : 0;
    };

    const toInt = (v) => {
      const m = String(v ?? "").match(/-?\d+/);
      return m ? parseInt(m[0], 10) : 0;
    };

    const normId = (v) => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

    // Збір помилок валідації для попереднього перегляду
    const validationErrors = [];
    
    const data = body.map((r, idx) => {
      const brand = String(r[map.brandIdx] ?? "").trim();
      const id = normId(r[map.idIdx]);
      const name = String(r[map.nameIdx] ?? "").trim();
      const stock = toInt(r[map.stockIdx]);
      const price = toNumber(r[map.priceIdx]);
      
      // ВАЛІДАЦІЯ: пропускаємо якщо немає обов'язкових полів
      if (!brand || !id) {
        if (validationErrors.length < 5) {
          validationErrors.push({ 
            row: idx + startRow + 2, // +2 бо startRow індекс і +1 для заголовка
            reason: "Відсутні бренд або артикул"
          });
        }
        return null;
      }
      
      if (price <= 0) {
        if (validationErrors.length < 5) {
          validationErrors.push({ 
            row: idx + startRow + 2,
            reason: "Ціна відсутня або дорівнює нулю",
            productKey: `${brand}-${id}`
          });
        }
        return null;
      }
      
      if (stock <= 0) {
        if (validationErrors.length < 5) {
          validationErrors.push({ 
            row: idx + startRow + 2,
            reason: "Кількість відсутня або дорівнює нулю",
            productKey: `${brand}-${id}`
          });
        }
        return null;
      }
      
      return { brand, id, name, stock, price, supplier: s.name };
    }).filter(Boolean);

    if (!data.length) { 
      let errorMsg = "Немає валідних рядків для імпорту. ";
      if (validationErrors.length > 0) {
        errorMsg += "Приклади помилок: " + validationErrors.map(e => `рядок ${e.row}: ${e.reason}`).join("; ");
      } else {
        errorMsg += "Перевірте, що всі рядки мають: бренд, артикул, ціну > 0, кількість > 0.";
      }
      setStatus?.({ type: "error", message: errorMsg }); 
      return; 
    }
    
    // Попередження про пропущені рядки
    const skippedCount = body.length - data.length;
    if (skippedCount > 0) {
      const warningMsg = `Увага: буде пропущено ${skippedCount} рядків з помилками валідації. ` +
        (validationErrors.length > 0 
          ? "Приклади: " + validationErrors.map(e => `рядок ${e.row}: ${e.reason}`).join("; ")
          : "");
      if (!confirm(warningMsg + "\n\nПродовжити імпорт?")) {
        return;
      }
    }

    // Перевірка обмеження перед імпортом
    const MAX_PRODUCTS = 3000;
    if (data.length > MAX_PRODUCTS) {
      setStatus?.({ 
        type: "error", 
        message: `⚠️ Перевищено обмеження: максимум ${MAX_PRODUCTS} товарів на прайс. Знайдено: ${data.length}. Будь ласка, розбийте прайс на частини або видаліть зайві рядки.` 
      });
      return;
    }

    // Попередження, якщо близько до ліміту
    if (data.length > MAX_PRODUCTS * 0.9) {
      const confirmed = confirm(
        `⚠️ Увага: знайдено ${data.length} товарів (близько до ліміту ${MAX_PRODUCTS}). Продовжити імпорт?`
      );
      if (!confirmed) return;
    }

    try {
      // Зберігаємо конфігурацію ПЕРЕД запуском імпорту (щоб точно виконалося до закриття модалки)
      if (map.saveConfig && s.id) {
        try {
          const config = {
            startRow: startRow,
            brandIdx: map.brandIdx,
            idIdx: map.idIdx,
            nameIdx: map.nameIdx,
            stockIdx: map.stockIdx,
            priceIdx: map.priceIdx
          };
          
          await updateDoc(
            doc(db, `/artifacts/${appId}/public/data/suppliers`, s.id),
            { importConfig: config }
          );
          console.log("Конфігурацію збережено успішно");
        } catch (configError) {
          console.error("Не вдалося зберегти конфігурацію", configError);
          setStatus?.({ 
            type: "warning", 
            message: `Імпорт буде запущено, але не вдалося зберегти конфігурацію: ${configError?.message || "невідома помилка"}` 
          });
        }
      }
      
      // Створюємо jobId для асинхронної обробки
      const jobId = `import-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const jobRef = doc(db, `/artifacts/${appId}/private/data/importJobs`, jobId);
      
      // Створюємо документ зі статусом "running"
      await setDoc(jobRef, {
        status: "running",
        supplierId: s.id,
        supplierName: s.name,
        startedAt: Timestamp.now(),
        completedAt: null,
        result: null,
        error: null
      });
      
      setStatus?.({ type: "info", message: `Імпорт ${data.length} рядків запущено…` });
      
      // Викликаємо функцію з jobId (не чекаємо результат)
      const call = httpsCallable(functions, "manualPriceListUpdate");
      call({ 
        supplier: { id: s.id, name: s.name }, 
        data,
        jobId 
      }).catch((error) => {
        // Якщо помилка при запуску - оновлюємо статус
        updateDoc(jobRef, {
          status: "failed",
          completedAt: Timestamp.now(),
          error: error?.message || "Помилка запуску імпорту"
        });
      });
      
      // Підписуємося на зміни job документа
      const unsubscribeFn = onSnapshot(jobRef, (snap) => {
        if (!snap.exists()) {
          if (importJobUnsubscribeRef.current) {
            importJobUnsubscribeRef.current();
            importJobUnsubscribeRef.current = null;
          }
          return;
        }
        
        const jobData = snap.data();
        
        if (jobData.status === "completed") {
          if (importJobUnsubscribeRef.current) {
            importJobUnsubscribeRef.current();
            importJobUnsubscribeRef.current = null;
          }
          
          const result = jobData.result || {};
          let message = "Імпорт завершено успішно.";
          if (result.skipped > 0) {
            message += ` Пропущено ${result.skipped} рядків (відсутні обов'язкові поля).`;
          }
          if (result.validationErrors && result.validationErrors.length > 0) {
            const errorsPreview = result.validationErrors.slice(0, 3)
              .map(e => `${e.productKey || `${e.brand || ''}-${e.article || ''}`}: ${e.reason}`)
              .join('; ');
            message += ` Приклади: ${errorsPreview}`;
          }
          if (result.removed > 0) {
            message += ` Видалено ${result.removed} товарів з нульовою наявністю.`;
          }
          if (result.filteredOut != null && result.filteredOut > 0) {
            message += ` Пропущено по мастерданих: ${result.filteredOut}.`;
          }
          
          setStatus?.({ type: "success", message });
          load(); // Перезавантажуємо список
        } else if (jobData.status === "failed") {
          if (importJobUnsubscribeRef.current) {
            importJobUnsubscribeRef.current();
            importJobUnsubscribeRef.current = null;
          }
          setStatus?.({ type: "error", message: jobData.error || "Помилка імпорту" });
        }
      }, (error) => {
        console.error("Помилка підписки на job:", error);
        if (importJobUnsubscribeRef.current) {
          importJobUnsubscribeRef.current();
          importJobUnsubscribeRef.current = null;
        }
      });
      
      // Зберігаємо unsubscribe для cleanup
      importJobUnsubscribeRef.current = unsubscribeFn;
      
      // Повертаємо успіх одразу (не чекаємо завершення)
      return { success: true, message: "Імпорт запущено", jobId };
    } catch (e) {
      setStatus?.({ type: "error", message: e?.message || "Не вдалося запустити імпорт" });
      throw e;
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow p-3 sm:p-6">
      
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
        onChange={onFileChange}
      />

      {/* Column mapping modal */}
      {mapModal && (
        <ColumnMapModal
          supplier={mapModal.supplier}
          headers={mapModal.headers}
          rows={mapModal.rows || mapModal.allRows || []}
          onCancel={() => {
            // Cleanup підписки при закритті модалки
            if (importJobUnsubscribeRef.current) {
              importJobUnsubscribeRef.current();
              importJobUnsubscribeRef.current = null;
            }
            setMapModal(null);
          }}
          onConfirm={doImportWithMapping}
        />
      )}

      {/* Supplier settings modal */}
      {editing && (
        <SupplierModal
          initial={editing}
          onClose={()=>setEditing(null)}
          onSaved={load}
          setStatus={setStatus}
        />
      )}

      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-4">
        <h2 className="text-2xl font-semibold">Постачальники</h2>
        <button className={primary} onClick={()=>setEditing({})}>Додати постачальника</button>
      </div>

      {items.length === 0 ? (
        <div className="text-slate-500">Постачальників ще немає.</div>
      ) : (
        <div className="space-y-3">
          {items.map((s) => (
            <div key={s.id} className="p-4 border rounded-xl flex flex-col gap-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex-1">
                  <div className="font-semibold">{s.name}</div>
                  {s.comment && <div className="text-sm text-slate-500">{s.comment}</div>}
                  <div className="text-xs text-slate-500 mt-1">
                    Націнки: {" "}
                    {["роздріб","ціна 1","ціна 2","ціна 3","ціна опт"].map((g, i) => (
                      <span key={g}>
                        {i ? " · " : ""}{g}: {s.rules?.[g] ?? "—"}%
                      </span>
                    ))}
                  </div>
                  {s.schedule && (
                    <div className="text-xs text-blue-600 mt-1">
                      📅 Розклад: <code className="bg-blue-50 px-1 rounded">{s.schedule}</code>
                    </div>
                  )}
                </div>
                <div className="flex gap-2 flex-wrap">
                  <button className={secondary + " text-sm"} onClick={()=>setEditing(s)}>Налаштувати</button>
                  <button className={secondary + " text-sm"} onClick={()=>triggerFilePick(s)}>Завантажити прайс</button>
                  <button
                    className={`${secondary} text-sm ${!s.priceListUrl || updatingUrls.has(s.id) ? "opacity-60 cursor-not-allowed" : ""}`}
                    onClick={()=>s.priceListUrl && !updatingUrls.has(s.id) ? updateFromUrl(s) : null}
                    title={s.priceListUrl ? (updatingUrls.has(s.id) ? "Оновлення в процесі..." : "") : "Вкажіть URL у налаштуваннях постачальника"}
                    disabled={!s.priceListUrl || updatingUrls.has(s.id)}
                  >
                    {updatingUrls.has(s.id) ? (
                      <span className="flex items-center gap-2">
                        <span className="animate-spin rounded-full h-3 w-3 border-b-2 border-current"></span>
                        Оновлення...
                      </span>
                    ) : (
                      "Оновити прайс (URL)"
                    )}
                  </button>
                  <button className={danger + " text-sm"} onClick={()=>removeSupplier(s)}>Видалити</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
