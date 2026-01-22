import React, { useState, useMemo, useCallback } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase-config";

// Settlements page with "drill-down" into delivery note (type=1) via callable getDocDetails
const SettlementsPage = ({ items, balances, client, user }) => {
  // Кеш для завантажених з Drive даних (на сесію)
  const [driveCache, setDriveCache] = useState(new Map());
  
  // Filters
  const [currencyFilter, setCurrencyFilter] = useState("EUR"); // По замовчуванню EUR
  const [dateRange, setDateRange] = useState(() => {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 15); // Останні 15 днів
    return {
      start: startDate.toISOString().slice(0, 10),
      end: endDate.toISOString().slice(0, 10),
    };
  });
  
  // Стан для завантаження з Drive
  const [loadingFromDrive, setLoadingFromDrive] = useState(false);
  const [driveItems, setDriveItems] = useState([]);
  const [driveStartingBalance, setDriveStartingBalance] = useState(0);

  // Modal state for document lines
  const [docLines, setDocLines] = useState([]);
  const [docMeta, setDocMeta] = useState(null);
  const [docModalOpen, setDocModalOpen] = useState(false);
  const [loadingDoc, setLoadingDoc] = useState(false);

  // Drill-down handler
  const openDoc = useCallback(async (row) => {
    try {
      const isDelivery =
        row?.docNumber &&
        (row?.docType === 1 ||
          row?.docType === "1" ||
          (typeof row?.docType === "string" && row.docType.toLowerCase().includes("видаткова")));
      if (!isDelivery) return; // only delivery notes

      setLoadingDoc(true);
      setDocMeta({ number: row.docNumber, currency: row.currency || "UAH", date: row.date });

      // clientCode не потрібен - backend бере його з /private/data/clientsAuth/{uid}
      const payload = {
        type: 1,                          // explicitly use type 1
        docNumber: row.docNumber,         // e.g. "П10-16909"
        currency: row.currency || (currencyFilter || "UAH"),
      };

      const resp = await httpsCallable(functions, "getDocDetails")(payload);
      setDocLines((resp?.data && resp.data.items) ? resp.data.items : []);
      setDocModalOpen(true);
    } catch (e) {
      console.error(e);
      // Перевіряємо чи це помилка "not-found" (документ не знайдено)
      const errorCode = e?.code || e?.details?.code || "";
      const errorMessage = e?.message || "";
      if (errorCode === "not-found" || errorCode.includes("not-found") || 
          errorMessage.includes("не знайдено") || errorMessage.includes("not-found")) {
        alert("Документ не знайдено. Можливо документ застарілий, зверніться до менеджера для отримання документу.");
      } else {
        alert(errorMessage || "Не вдалося завантажити документ");
      }
    } finally {
      setLoadingDoc(false);
    }
  }, [client, currencyFilter]);

  // Об'єднуємо збережені дані та дані з Drive
  const allItems = useMemo(() => {
    if (driveItems.length > 0) {
      return driveItems;
    }
    return items || [];
  }, [items, driveItems]);
  
  // Фільтрація для об'єднаних даних
  const filteredItems = useMemo(() => {
    if (!Array.isArray(allItems)) return [];
    const start = new Date(dateRange.start); start.setHours(0, 0, 0, 0);
    const end = new Date(dateRange.end); end.setHours(23, 59, 59, 999);
    return allItems.filter(item => {
      // Підтримка різних форматів дати
      let itemDate;
      if (item?.date?.seconds) {
        itemDate = new Date(item.date.seconds * 1000);
      } else if (item?.date) {
        itemDate = new Date(item.date);
      } else {
        return false;
      }
      const isCurrencyMatch = (item.currency || "UAH") === currencyFilter;
      const isDateMatch = itemDate >= start && itemDate <= end;
      return isCurrencyMatch && isDateMatch;
    });
  }, [allItems, currencyFilter, dateRange]);

  // Running balance тільки для даних з Drive
  const itemsWithBalance = useMemo(() => {
    // Для локальних даних (15 днів) не рахуємо running balance
    if (driveItems.length === 0) {
      // Просто сортуємо від нових до старих для відображення
      return [...filteredItems].sort((a, b) => {
        const dateA = a?.date?.seconds ? a.date.seconds * 1000 : Date.parse(a.date || 0);
        const dateB = b?.date?.seconds ? b.date.seconds * 1000 : Date.parse(b.date || 0);
        return dateB - dateA; // від нових до старих
      });
    }
    
    // Для даних з Drive рахуємо running balance
    // Спочатку сортуємо від старих до нових для правильного running balance
    const list = [...filteredItems].sort((a, b) => {
      const dateA = a?.date ? new Date(a.date).getTime() : 0;
      const dateB = b?.date ? new Date(b.date).getTime() : 0;
      return dateA - dateB; // від старих до нових для правильного running balance
    });
    
    // Обчислюємо running balance від старих до нових, починаючи з driveStartingBalance
    let bal = driveStartingBalance || 0;
    const withBalance = list.map(it => {
      bal += Number(it.delta || 0);
      return { ...it, runningBalance: bal };
    });
    
    // Перевертаємо список, щоб найсвіжіші були зверху
    return withBalance.reverse();
  }, [filteredItems, driveItems.length, driveStartingBalance]);

  const fmtDate = (v) => {
    if (!v) return "";
    let ts;
    if (v?.seconds) {
      ts = v.seconds * 1000;
    } else if (typeof v === "string") {
      ts = Date.parse(v);
    } else {
      ts = new Date(v).getTime();
    }
    if (!ts || isNaN(ts)) return "";
    return new Date(ts).toLocaleDateString("uk-UA");
  };

  // Завантаження повної історії з Google Drive
  const handleLoadFromDrive = useCallback(async () => {
    const cacheKey = `${currencyFilter}_${dateRange.start}_${dateRange.end}`;
    
    // Перевірка кешу
    if (driveCache.has(cacheKey)) {
      const cached = driveCache.get(cacheKey);
      setDriveItems(cached.items || cached);
      setDriveStartingBalance(cached.startingBalance || 0);
      return;
    }
    
    setLoadingFromDrive(true);
    try {
      const call = httpsCallable(functions, "getSettlementsFromDrive");
      const resp = await call({
        currency: currencyFilter,
        startDate: dateRange.start,
        endDate: dateRange.end,
      });
      
      const loadedItems = resp?.data?.items || [];
      const startingBalance = resp?.data?.startingBalance || 0;
      
      setDriveItems(loadedItems);
      setDriveStartingBalance(startingBalance);
      
      // Зберігаємо в кеш
      const newCache = new Map(driveCache);
      newCache.set(cacheKey, { items: loadedItems, startingBalance });
      setDriveCache(newCache);
    } catch (e) {
      console.error(e);
      alert(e?.message || "Не вдалося завантажити дані з Google Drive");
    } finally {
      setLoadingFromDrive(false);
    }
  }, [currencyFilter, dateRange, driveCache]);

  const handleExport = () => {
    try {
      if (typeof window.XLSX === "undefined") {
        alert("Бібліотека XLSX не підключена.");
        return;
      }
      
      // Отримуємо clientCode з user.uid
      const clientCode = user?.uid || "0";
      
      // Формуємо дані для експорту
      const dataToExport = [];
      
      // Додаємо початковий баланс (тільки якщо є дані з Drive)
      if (driveItems.length > 0 && driveStartingBalance !== undefined) {
        const startingBalanceRow = {};
        startingBalanceRow["Дата"] = "Початковий баланс";
        startingBalanceRow["Тип"] = Number(driveStartingBalance).toFixed(2); // Значення в колонці B
        startingBalanceRow["Номер"] = "";
        startingBalanceRow["Прихід (+)"] = "";
        startingBalanceRow["Витрата (-)"] = "";
        if (driveItems.length > 0) {
          startingBalanceRow["Сальдо"] = "";
        }
        startingBalanceRow["Валюта"] = "";
        dataToExport.push(startingBalanceRow);
        
        // Два порожні рядки після початкового балансу
        dataToExport.push({});
        dataToExport.push({});
      }
      
      // Заголовки таблиці
      const headersRow = {};
      headersRow["Дата"] = "Дата";
      headersRow["Тип"] = "Тип";
      headersRow["Номер"] = "Номер";
      headersRow["Прихід (+)"] = "Прихід (+)";
      headersRow["Витрата (-)"] = "Витрата (-)";
      if (driveItems.length > 0) {
        headersRow["Сальдо"] = "Сальдо";
      }
      headersRow["Валюта"] = "Валюта";
      dataToExport.push(headersRow);
      
      // Додаємо операції
      const operationsData = itemsWithBalance.map(item => ({
        "Дата": fmtDate(item.date),
        "Тип": item.docType,
        "Номер": item.docNumber,
        "Прихід (+)": item.income > 0 ? Number(item.income).toFixed(2) : "",
        "Витрата (-)": item.expense > 0 ? Number(item.expense).toFixed(2) : "",
        ...(driveItems.length > 0 ? { "Сальдо": Number(item.runningBalance || 0).toFixed(2) } : {}),
        "Валюта": item.currency || currencyFilter,
      }));
      dataToExport.push(...operationsData);
      
      // Два порожні рядки після операцій
      dataToExport.push({});
      dataToExport.push({});
      
      // Додаємо баланс на кінець
      let finalBalance = 0;
      if (driveItems.length > 0 && itemsWithBalance.length > 0) {
        // Останній runningBalance з таблиці (якщо є дані з Drive)
        const lastItem = itemsWithBalance[itemsWithBalance.length - 1];
        finalBalance = Number(lastItem.runningBalance || 0);
      } else {
        // Поточний баланс з balances (якщо немає даних з Drive)
        finalBalance = Number(balances?.[currencyFilter] || 0);
      }
      
      const finalBalanceRow = {};
      finalBalanceRow["Дата"] = "Баланс на кінець";
      finalBalanceRow["Тип"] = finalBalance.toFixed(2); // Значення в колонці B
      finalBalanceRow["Номер"] = "";
      finalBalanceRow["Прихід (+)"] = "";
      finalBalanceRow["Витрата (-)"] = "";
      if (driveItems.length > 0) {
        finalBalanceRow["Сальдо"] = "";
      }
      finalBalanceRow["Валюта"] = "";
      dataToExport.push(finalBalanceRow);
      
      // Створюємо Excel файл
      const ws = window.XLSX.utils.json_to_sheet(dataToExport, { skipHeader: true });
      
      // Налаштування ширини колонок
      const colWidths = [
        { wch: 12 }, // Дата
        { wch: 30 }, // Тип
        { wch: 15 }, // Номер
        { wch: 12 }, // Прихід (+)
        { wch: 12 }, // Витрата (-)
      ];
      if (driveItems.length > 0) {
        colWidths.push({ wch: 12 }); // Сальдо
      }
      colWidths.push({ wch: 8 }); // Валюта
      ws['!cols'] = colWidths;
      
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, "Взаєморозрахунки");
      
      // Назва файлу: zvirka_{clientCode}_{currency}.xlsx
      const fileName = `zvirka_${clientCode}_${currencyFilter}.xlsx`;
      window.XLSX.writeFile(wb, fileName);
    } catch (e) {
      console.error(e);
      alert("Експорт не вдався");
    }
  };

  // Дані для відображення
  const displayItems = itemsWithBalance;

  return (
    <div className="bg-white p-6 rounded-lg shadow-md">
      <div className="mb-4">
        <h2 className="text-xl font-semibold mb-4">Звірка</h2>
        
        {/* Фільтри */}
        <div className="flex flex-wrap items-end gap-4 mb-4">
          {/* Toggle кнопки для валюти (пігулка-касула) */}
          <div>
            <label className="block text-sm mb-1">Валюта</label>
            <div className="flex border rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={() => {
                  setCurrencyFilter("EUR");
                  setDriveItems([]);
                  setDriveStartingBalance(0);
                }}
                className={`px-4 py-2 text-sm font-medium transition-colors ${
                  currencyFilter === "EUR"
                    ? "bg-indigo-600 text-white"
                    : "bg-white text-gray-700 hover:bg-gray-50"
                }`}
              >
                EUR
              </button>
              <button
                type="button"
                onClick={() => {
                  setCurrencyFilter("UAH");
                  setDriveItems([]);
                  setDriveStartingBalance(0);
                }}
                className={`px-4 py-2 text-sm font-medium transition-colors border-l ${
                  currencyFilter === "UAH"
                    ? "bg-indigo-600 text-white"
                    : "bg-white text-gray-700 hover:bg-gray-50"
                }`}
              >
                UAH
              </button>
            </div>
          </div>
          <div>
            <label className="block text-sm mb-1">Початок</label>
            <input
              type="date"
              className="border rounded px-3 py-2"
              value={dateRange.start}
              onChange={(e) => {
                setDateRange(r => ({ ...r, start: e.target.value }));
                setDriveItems([]);
                setDriveStartingBalance(0);
              }}
            />
          </div>
          <div>
            <label className="block text-sm mb-1">Кінець</label>
            <input
              type="date"
              className="border rounded px-3 py-2"
              value={dateRange.end}
              onChange={(e) => {
                setDateRange(r => ({ ...r, end: e.target.value }));
                setDriveItems([]);
                setDriveStartingBalance(0);
              }}
            />
          </div>
          <button
            className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleLoadFromDrive}
            disabled={loadingFromDrive}
            type="button"
          >
            {loadingFromDrive ? "Завантаження..." : "Сформувати звірку"}
          </button>
          <button
            className="ml-auto bg-gray-100 hover:bg-gray-200 px-4 py-2 rounded"
            onClick={handleExport}
            type="button"
          >
            Експорт в Excel
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b">
              <th className="text-left p-2">Дата</th>
              <th className="text-left p-2">Тип</th>
              <th className="text-left p-2">Документ</th>
              <th className="text-right p-2">Прихід (+)</th>
              <th className="text-right p-2">Витрата (-)</th>
              {driveItems.length > 0 && <th className="text-right p-2">Сальдо</th>}
              <th className="text-left p-2">Валюта</th>
            </tr>
          </thead>
          <tbody>
            {displayItems.map((r, idx) => (
              <tr key={idx} className="border-b hover:bg-gray-50">
                <td className="p-2">{fmtDate(r.date)}</td>
                <td className="p-2">{r.docType}</td>
                <td className="p-2">
                  {(r.docNumber &&
                    (r.docType === 1 ||
                      r.docType === "1" ||
                      (typeof r.docType === "string" && r.docType.toLowerCase().includes("видаткова")))
                  ) ? (
                    <button
                      className="text-blue-600 underline"
                      onClick={() => openDoc(r)}
                      type="button"
                    >
                      {r.docNumber}
                    </button>
                  ) : (
                    r.docNumber || "-"
                  )}
                </td>
                <td className="p-2 text-right">{r.income > 0 ? r.income.toFixed(2) : ""}</td>
                <td className="p-2 text-right">{r.expense > 0 ? r.expense.toFixed(2) : ""}</td>
                {driveItems.length > 0 && <td className="p-2 text-right">{Number(r.runningBalance || 0).toFixed(2)}</td>}
                <td className="p-2">{r.currency || "UAH"}</td>
              </tr>
            ))}
            {displayItems.length === 0 && (
              <tr>
                <td className="p-4 text-center text-gray-500" colSpan={driveItems.length > 0 ? 7 : 6}>
                  Немає даних за обраний період/валюту
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Modal for document lines */}
      {docModalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-[min(960px,92vw)] max-h-[85vh] overflow-hidden">
            <div className="p-4 border-b flex items-center justify-between">
              <div className="font-semibold">
                Видаткова накладна {docMeta?.number} ({docMeta?.currency || "UAH"})
              </div>
              <button className="px-3 py-1 rounded bg-gray-100 hover:bg-gray-200" onClick={() => setDocModalOpen(false)}>
                Закрити
              </button>
            </div>
            <div className="p-4">
              {loadingDoc ? (
                <div className="p-8 text-center">Завантаження документа…</div>
              ) : (
                <div className="overflow-auto">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left p-2">Код</th>
                        <th className="text-left p-2">Найменування</th>
                        <th className="text-right p-2">К-сть</th>
                        <th className="text-right p-2">Ціна</th>
                        <th className="text-right p-2">Знижка</th>
                        <th className="text-right p-2">Сума</th>
                        <th className="text-left p-2">Од.</th>
                        <th className="text-left p-2">Прим.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {docLines.map((l, i) => (
                        <tr key={i} className="border-b">
                          <td className="p-2">{l.code || ""}</td>
                          <td className="p-2">{l.name || ""}</td>
                          <td className="p-2 text-right">{(l.qty ?? "").toString()}</td>
                          <td className="p-2 text-right">{(l.price ?? "").toString()}</td>
                          <td className="p-2 text-right">{(l.discount ?? "").toString()}</td>
                          <td className="p-2 text-right">{(l.sum ?? "").toString()}</td>
                          <td className="p-2">{l.unit || ""}</td>
                          <td className="p-2">{l.note || ""}</td>
                        </tr>
                      ))}
                      {docLines.length === 0 && (
                        <tr>
                          <td className="p-4 text-center text-gray-500" colSpan={8}>
                            Порожній документ
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SettlementsPage;
