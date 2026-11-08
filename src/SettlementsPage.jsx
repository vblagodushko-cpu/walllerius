import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { httpsCallable } from "firebase/functions";
import { collection, getDocs, limit, orderBy, query, startAfter, Timestamp, where } from "firebase/firestore";
import { db, functions } from "./firebase-config";

// Взаєморозрахунки: журнал операцій з Firestore (його веде локальний агент з UkrSklad, без Google Drive).
// Читаємо порціями (limit + startAfter) за обраний період, без onSnapshot.
// Сальдо після кожної операції береться з поля balanceAfter. Видаткова накладна відкривається через getDocDetails.
const APP_ID = import.meta.env.VITE_PROJECT_ID;
const PAGE_SIZE = 100;
const EXPORT_PAGE_SIZE = 500;

const isoDay = (d) => d.toISOString().slice(0, 10);
const tsMs = (v) => (v?.seconds ? v.seconds * 1000 : v ? Date.parse(v) : 0) || 0;
const num = (v) => Number(v || 0);

const fmtDate = (v) => {
  const ms = tsMs(v);
  if (!ms) return "";
  // Дата зберігається як 12:00 UTC, тому показуємо її в UTC - без зсуву на сусідній день
  return new Date(ms).toLocaleDateString("uk-UA", { timeZone: "UTC" });
};

const isDelivery = (row) =>
  !!row?.docNumber &&
  (row?.docCode === "VNAKL" ||
    row?.docType === 1 ||
    row?.docType === "1" ||
    (typeof row?.docType === "string" && row.docType.toLowerCase().includes("видаткова")));

// Нові зверху: за датою, всередині дня за seq (порядок проведення в обліку)
const sortDesc = (a, b) => tsMs(b.date) - tsMs(a.date) || num(b.seq) - num(a.seq);

const SettlementsPage = ({ balances, client, user }) => {
  const clientCode = String(user?.uid || "");

  const [currencyFilter, setCurrencyFilter] = useState("EUR");
  const [dateRange, setDateRange] = useState(() => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 30);
    return { start: isoDay(start), end: isoDay(end) };
  });

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadError, setLoadError] = useState("");
  const lastDocRef = useRef(null);
  const requestId = useRef(0);

  // Modal state for document lines
  const [docLines, setDocLines] = useState([]);
  const [docMeta, setDocMeta] = useState(null);
  const [docModalOpen, setDocModalOpen] = useState(false);
  const [loadingDoc, setLoadingDoc] = useState(false);

  const buildQuery = useCallback(
    (range, currency, pageSize, after) => {
      const from = Timestamp.fromDate(new Date(`${range.start}T00:00:00Z`));
      const to = Timestamp.fromDate(new Date(`${range.end}T23:59:59Z`));
      const parts = [
        where("date", ">=", from),
        where("date", "<=", to),
        orderBy("date", "desc"),
        limit(pageSize),
      ];
      if (after) parts.push(startAfter(after));
      return query(
        collection(db, `/artifacts/${APP_ID}/public/data/settlements/${clientCode}/ledger-${currency}`),
        ...parts
      );
    },
    [clientCode]
  );

  // Перша порція (або нова після зміни фільтрів)
  const loadFirst = useCallback(
    async (range = dateRange, currency = currencyFilter) => {
      if (!clientCode) return;
      const myId = ++requestId.current;
      setLoading(true);
      setLoadError("");
      try {
        const snap = await getDocs(buildQuery(range, currency, PAGE_SIZE, null));
        if (myId !== requestId.current) return;
        lastDocRef.current = snap.docs[snap.docs.length - 1] || null;
        setRows(snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort(sortDesc));
        setHasMore(snap.docs.length === PAGE_SIZE);
      } catch (e) {
        if (myId !== requestId.current) return;
        console.error(e);
        setRows([]);
        setHasMore(false);
        setLoadError("Не вдалося завантажити дані. Спробуйте ще раз.");
      } finally {
        if (myId === requestId.current) setLoading(false);
      }
    },
    [buildQuery, clientCode, currencyFilter, dateRange]
  );

  const loadMore = useCallback(async () => {
    if (!hasMore || loading || !lastDocRef.current) return;
    const myId = requestId.current;
    setLoading(true);
    try {
      const snap = await getDocs(buildQuery(dateRange, currencyFilter, PAGE_SIZE, lastDocRef.current));
      if (myId !== requestId.current) return;
      lastDocRef.current = snap.docs[snap.docs.length - 1] || lastDocRef.current;
      const next = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setRows((prev) => [...prev, ...next].sort(sortDesc));
      setHasMore(snap.docs.length === PAGE_SIZE);
    } catch (e) {
      console.error(e);
      setLoadError("Не вдалося завантажити наступну порцію.");
    } finally {
      if (myId === requestId.current) setLoading(false);
    }
  }, [buildQuery, currencyFilter, dateRange, hasMore, loading]);

  // Автозавантаження при вході та при зміні валюти; період застосовується кнопкою "Показати"
  useEffect(() => {
    loadFirst(dateRange, currencyFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currencyFilter, clientCode]);

  // Drill-down handler
  const openDoc = useCallback(
    async (row) => {
      try {
        if (!isDelivery(row)) return;
        setLoadingDoc(true);
        setDocMeta({ number: row.docNumber, currency: row.currency || currencyFilter, date: row.date });

        // clientCode не потрібен - backend бере його з /private/data/clientsAuth/{uid}
        const resp = await httpsCallable(functions, "getDocDetails")({
          type: 1,
          docNumber: row.docNumber,
          currency: row.currency || currencyFilter,
        });
        setDocLines(resp?.data?.items ? resp.data.items : []);
        setDocModalOpen(true);
      } catch (e) {
        console.error(e);
        const errorCode = e?.code || e?.details?.code || "";
        const errorMessage = e?.message || "";
        if (
          errorCode === "not-found" ||
          String(errorCode).includes("not-found") ||
          errorMessage.includes("не знайдено") ||
          errorMessage.includes("not-found")
        ) {
          alert("Документ не знайдено. Можливо документ застарілий, зверніться до менеджера для отримання документу.");
        } else {
          alert(errorMessage || "Не вдалося завантажити документ");
        }
      } finally {
        setLoadingDoc(false);
      }
    },
    [currencyFilter]
  );

  const hasSaldo = useMemo(() => rows.some((r) => r.balanceAfter !== undefined && r.balanceAfter !== null), [rows]);
  const currentBalance = Number(balances?.[currencyFilter] || 0);

  const handleExport = async () => {
    try {
      if (typeof window.XLSX === "undefined") {
        alert("Бібліотека XLSX не підключена.");
        return;
      }
      // Для експорту дочитуємо весь період (порціями), якщо на екрані лише частина
      let all = rows;
      if (hasMore) {
        setLoading(true);
        all = [];
        let after = null;
        for (;;) {
          const snap = await getDocs(buildQuery(dateRange, currencyFilter, EXPORT_PAGE_SIZE, after));
          all.push(...snap.docs.map((d) => ({ id: d.id, ...d.data() })));
          after = snap.docs[snap.docs.length - 1] || null;
          if (snap.docs.length < EXPORT_PAGE_SIZE || !after) break;
        }
        all.sort(sortDesc);
        setLoading(false);
      }

      const withSaldo = all.some((r) => r.balanceAfter !== undefined && r.balanceAfter !== null);
      const data = [];

      if (withSaldo && all.length > 0) {
        const oldest = all[all.length - 1];
        const startBal = num(oldest.balanceAfter) - num(oldest.delta);
        data.push({ "Дата": "Початковий баланс", "Тип": startBal.toFixed(2) });
        data.push({}, {});
      }

      const header = { "Дата": "Дата", "Тип": "Тип", "Номер": "Номер", "Прихід (+)": "Прихід (+)", "Витрата (-)": "Витрата (-)" };
      if (withSaldo) header["Сальдо"] = "Сальдо";
      header["Валюта"] = "Валюта";
      data.push(header);

      for (const item of all) {
        data.push({
          "Дата": fmtDate(item.date),
          "Тип": item.docType,
          "Номер": item.docNumber,
          "Прихід (+)": item.income > 0 ? num(item.income).toFixed(2) : "",
          "Витрата (-)": item.expense > 0 ? num(item.expense).toFixed(2) : "",
          ...(withSaldo ? { "Сальдо": num(item.balanceAfter).toFixed(2) } : {}),
          "Валюта": item.currency || currencyFilter,
        });
      }
      data.push({}, {});

      const finalBalance = withSaldo && all.length > 0 ? num(all[0].balanceAfter) : currentBalance;
      data.push({ "Дата": "Баланс на кінець", "Тип": finalBalance.toFixed(2) });

      const ws = window.XLSX.utils.json_to_sheet(data, { skipHeader: true });
      const cols = [{ wch: 12 }, { wch: 30 }, { wch: 15 }, { wch: 12 }, { wch: 12 }];
      if (withSaldo) cols.push({ wch: 12 });
      cols.push({ wch: 8 });
      ws["!cols"] = cols;

      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, "Взаєморозрахунки");
      window.XLSX.writeFile(wb, `zvirka_${clientCode || "0"}_${currencyFilter}.xlsx`);
    } catch (e) {
      console.error(e);
      setLoading(false);
      alert("Експорт не вдався");
    }
  };

  const currencies = useMemo(() => {
    const list = ["EUR", "UAH"];
    if (balances && Object.prototype.hasOwnProperty.call(balances, "USD")) list.push("USD");
    return list;
  }, [balances]);

  return (
    <div className="bg-white p-6 rounded-lg shadow-md">
      <div className="mb-4">
        <h2 className="text-xl font-semibold mb-4">Звірка</h2>

        <div className="flex flex-wrap items-end gap-4 mb-4">
          <div>
            <label className="block text-sm mb-1">Валюта</label>
            <div className="flex border rounded-lg overflow-hidden">
              {currencies.map((cur, i) => (
                <button
                  key={cur}
                  type="button"
                  onClick={() => setCurrencyFilter(cur)}
                  className={`px-4 py-2 text-sm font-medium transition-colors ${i > 0 ? "border-l" : ""} ${
                    currencyFilter === cur ? "bg-indigo-600 text-white" : "bg-white text-gray-700 hover:bg-gray-50"
                  }`}
                >
                  {cur}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-sm mb-1">Початок</label>
            <input
              type="date"
              className="border rounded px-3 py-2"
              value={dateRange.start}
              onChange={(e) => setDateRange((r) => ({ ...r, start: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-sm mb-1">Кінець</label>
            <input
              type="date"
              className="border rounded px-3 py-2"
              value={dateRange.end}
              onChange={(e) => setDateRange((r) => ({ ...r, end: e.target.value }))}
            />
          </div>
          <button
            className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => loadFirst(dateRange, currencyFilter)}
            disabled={loading || !dateRange.start || !dateRange.end || dateRange.start > dateRange.end}
            type="button"
          >
            {loading ? "Завантаження..." : "Показати"}
          </button>
          <button
            className="ml-auto bg-gray-100 hover:bg-gray-200 px-4 py-2 rounded disabled:opacity-50"
            onClick={handleExport}
            disabled={loading || rows.length === 0}
            type="button"
          >
            Експорт в Excel
          </button>
        </div>

        <div className="text-sm text-gray-600">
          Поточний баланс {currencyFilter}:{" "}
          <b className={currentBalance >= 0 ? "text-green-700" : "text-red-700"}>{currentBalance.toFixed(2)}</b>
        </div>
      </div>

      {loadError && <div className="mb-3 text-sm text-red-600">{loadError}</div>}

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b">
              <th className="text-left p-2">Дата</th>
              <th className="text-left p-2">Тип</th>
              <th className="text-left p-2">Документ</th>
              <th className="text-right p-2">Прихід (+)</th>
              <th className="text-right p-2">Витрата (-)</th>
              {hasSaldo && <th className="text-right p-2">Сальдо</th>}
              <th className="text-left p-2">Валюта</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b hover:bg-gray-50">
                <td className="p-2">{fmtDate(r.date)}</td>
                <td className="p-2">{r.docType}</td>
                <td className="p-2">
                  {isDelivery(r) ? (
                    <button className="text-blue-600 underline" onClick={() => openDoc(r)} type="button">
                      {r.docNumber}
                    </button>
                  ) : (
                    r.docNumber || "-"
                  )}
                </td>
                <td className="p-2 text-right">{r.income > 0 ? num(r.income).toFixed(2) : ""}</td>
                <td className="p-2 text-right">{r.expense > 0 ? num(r.expense).toFixed(2) : ""}</td>
                {hasSaldo && <td className="p-2 text-right">{num(r.balanceAfter).toFixed(2)}</td>}
                <td className="p-2">{r.currency || currencyFilter}</td>
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr>
                <td className="p-4 text-center text-gray-500" colSpan={hasSaldo ? 7 : 6}>
                  Немає даних за обраний період/валюту
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {hasMore && (
        <div className="mt-4 text-center">
          <button
            className="bg-gray-100 hover:bg-gray-200 px-4 py-2 rounded disabled:opacity-50"
            onClick={loadMore}
            disabled={loading}
            type="button"
          >
            {loading ? "Завантаження..." : "Показати ще (старіші)"}
          </button>
        </div>
      )}

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
                <div className="overflow-auto max-h-[65vh]">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left p-2">Код</th>
                        <th className="text-left p-2">Найменування</th>
                        <th className="text-right p-2">К-сть</th>
                        <th className="text-right p-2">Ціна</th>
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
                          <td className="p-2 text-right">{l.qty != null ? String(Number(l.qty)) : ""}</td>
                          <td className="p-2 text-right">{l.price != null ? Number(l.price).toFixed(2) : ""}</td>
                          <td className="p-2 text-right">{l.sum != null ? Number(l.sum).toFixed(2) : ""}</td>
                          <td className="p-2">{l.unit || ""}</td>
                          <td className="p-2">{l.note || ""}</td>
                        </tr>
                      ))}
                      {docLines.length === 0 && (
                        <tr>
                          <td className="p-4 text-center text-gray-500" colSpan={7}>
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
