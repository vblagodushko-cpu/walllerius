// src/buh/BuhApp.jsx — окрема сторінка бухгалтера (/buh).
// Доступ: custom claim admin (пізніше також accountant). Дані тільки через callable, без onSnapshot.
import React, { useCallback, useEffect, useState } from "react";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import { auth, functions } from "../firebase-config";
import AdminLayout from "../admin/components/AdminLayout.jsx";
import AdminLogin from "../admin/components/AdminLogin.jsx";

const TABS = [
  { key: "vydatkova", label: "Видаткові накладні" },
  { key: "prybutkova", label: "Прибуткові накладні" },
  { key: "rakhunok", label: "Рахунки-фактури" },
  { key: "stock", label: "Залишки (безготівка)" },
];

const PAGE_SIZE = 50;

const pad2 = (n) => String(n).padStart(2, "0");
const toYmd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
function defaultRange() {
  const now = new Date();
  return { from: toYmd(new Date(now.getFullYear(), now.getMonth(), 1)), to: toYmd(now) };
}
const fmtMoney = (v) =>
  v == null ? "—" : Number(v).toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtQty = (v) =>
  v == null ? "—" : Number(v).toLocaleString("uk-UA", { maximumFractionDigits: 3 });
const fmtDate = (ymd) => (ymd ? ymd.split("-").reverse().join(".") : "");

const callDocs = httpsCallable(functions, "getAccountingDocs");
const callLines = httpsCallable(functions, "getAccountingDocLines");
const callStock = httpsCallable(functions, "getAccountingStock");

async function copyText(text) {
  const s = String(text || "").trim();
  if (!s) return false;
  try {
    await navigator.clipboard.writeText(s);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = s;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

function CopyNameButton({ name }) {
  const [status, setStatus] = useState("idle"); // idle | ok | err

  const onCopy = async (e) => {
    e.stopPropagation();
    const ok = await copyText(name);
    setStatus(ok ? "ok" : "err");
    window.setTimeout(() => setStatus("idle"), 1600);
  };

  const label =
    status === "ok" ? "Скопійовано" : status === "err" ? "Помилка" : "Копіювати назву";

  return (
    <button
      type="button"
      onClick={onCopy}
      title={label}
      aria-label={label}
      className={`shrink-0 p-1 rounded border text-xs leading-none ${
        status === "ok"
          ? "border-green-300 bg-green-50 text-green-700"
          : status === "err"
            ? "border-red-300 bg-red-50 text-red-600"
            : "border-gray-200 text-gray-500 hover:bg-gray-100 hover:text-gray-800"
      }`}
    >
      {status === "ok" ? "✓" : "⎘"}
    </button>
  );
}

function LinesModal({ docType, doc, onClose }) {
  const [lines, setLines] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    callLines({ docType, ukrDocId: doc.ukrDocId })
      .then((r) => alive && setLines(r.data?.lines || []))
      .catch(() => alive && setErr("Не вдалося завантажити рядки."));
    return () => {
      alive = false;
    };
  }, [docType, doc.ukrDocId]);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-4xl max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b flex items-center justify-between gap-4">
          <div>
            <div className="font-semibold">Документ № {doc.number} від {fmtDate(doc.dateStr)}</div>
            <div className="text-sm text-gray-500">{doc.clientName}</div>
            <div className="text-xs text-gray-600 mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
              <span>без ПДВ: {fmtMoney(doc.sum)}</span>
              <span>ПДВ: {fmtMoney(doc.pdvAmount)}</span>
              <span className="font-medium">з ПДВ: {fmtMoney(doc.sumPdv)}</span>
            </div>
          </div>
          <button className="text-2xl text-gray-500 hover:text-gray-800" onClick={onClose} aria-label="Закрити">
            ×
          </button>
        </div>
        <div className="overflow-auto p-4">
          {err && <div className="text-red-600">{err}</div>}
          {!err && lines === null && <div className="text-gray-500">Завантаження…</div>}
          {lines && (
            <table className="w-full text-sm">
              <thead className="text-left text-gray-500 border-b">
                <tr>
                  <th className="py-2 pr-2">#</th>
                  <th className="py-2 pr-2">Назва</th>
                  <th className="py-2 pr-2">Од.</th>
                  <th className="py-2 pr-2 text-right">К-сть</th>
                  <th className="py-2 pr-2 text-right">Ціна</th>
                  <th className="py-2 pr-2 text-right">Ціна з ПДВ</th>
                  <th className="py-2 pr-2 text-right">Сума</th>
                  <th className="py-2 pr-2 text-right">ПДВ</th>
                  <th className="py-2 text-right">Сума з ПДВ</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.lineNum} className="border-b last:border-0">
                    <td className="py-1.5 pr-2 text-gray-500">{l.lineNum}</td>
                    <td className="py-1.5 pr-2">
                      <div className="flex items-start gap-1.5 min-w-0">
                        <span className="min-w-0 break-words">{l.name}</span>
                        <CopyNameButton name={l.name} />
                      </div>
                    </td>
                    <td className="py-1.5 pr-2">{l.unit}</td>
                    <td className="py-1.5 pr-2 text-right">{fmtQty(l.qty)}</td>
                    <td className="py-1.5 pr-2 text-right">{fmtMoney(l.price)}</td>
                    <td className="py-1.5 pr-2 text-right">{fmtMoney(l.pricePdv)}</td>
                    <td className="py-1.5 pr-2 text-right">{fmtMoney(l.sum)}</td>
                    <td className="py-1.5 pr-2 text-right">{fmtMoney(l.pdvSum)}</td>
                    <td className="py-1.5 text-right">{fmtMoney(l.sumPdv)}</td>
                  </tr>
                ))}
                {lines.length === 0 && (
                  <tr>
                    <td colSpan={9} className="py-4 text-center text-gray-500">
                      Рядків немає.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function DocsTab({ docType, onSync }) {
  const [range, setRange] = useState(defaultRange);
  const [applied, setApplied] = useState(range);
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [openDoc, setOpenDoc] = useState(null);

  const load = useCallback(
    async (reset, nextCursor) => {
      setLoading(true);
      setErr("");
      try {
        const r = await callDocs({
          docType,
          from: applied.from || null,
          to: applied.to || null,
          pageSize: PAGE_SIZE,
          cursor: reset ? null : nextCursor,
        });
        const data = r.data || {};
        setItems((prev) => (reset ? data.items || [] : [...prev, ...(data.items || [])]));
        setCursor(data.nextCursor || null);
        if (reset && data.sync) onSync(data.sync);
      } catch (e) {
        setErr("Не вдалося завантажити документи.");
      } finally {
        setLoading(false);
      }
    },
    [docType, applied, onSync]
  );

  useEffect(() => {
    load(true);
  }, [load]);

  const totalNet = items.reduce((s, d) => s + (Number(d.sum) || 0), 0);
  const totalPdv = items.reduce((s, d) => s + (Number(d.pdvAmount) || 0), 0);
  const totalGross = items.reduce((s, d) => s + (Number(d.sumPdv) || 0), 0);

  return (
    <div>
      <form
        className="flex flex-wrap items-end gap-3 mb-4"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(range);
        }}
      >
        <label className="text-sm">
          <div className="text-gray-600 mb-1">Від</div>
          <input
            type="date"
            className="border rounded px-2 py-1"
            value={range.from}
            onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
          />
        </label>
        <label className="text-sm">
          <div className="text-gray-600 mb-1">До</div>
          <input
            type="date"
            className="border rounded px-2 py-1"
            value={range.to}
            onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
          />
        </label>
        <button type="submit" className="px-4 py-1.5 rounded bg-indigo-600 text-white hover:bg-indigo-700">
          Показати
        </button>
        <button
          type="button"
          className="px-3 py-1.5 rounded border hover:bg-gray-50"
          onClick={() => {
            const r = defaultRange();
            setRange(r);
            setApplied(r);
          }}
        >
          Поточний місяць
        </button>
      </form>

      {err && <div className="mb-3 text-red-600">{err}</div>}

      <div className="bg-white rounded-xl border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-gray-500 border-b bg-gray-50">
            <tr>
              <th className="px-3 py-2">№</th>
              <th className="px-3 py-2">Дата</th>
              <th className="px-3 py-2">Клієнт</th>
              <th className="px-3 py-2 text-right">Сума без ПДВ</th>
              <th className="px-3 py-2 text-right">ПДВ</th>
              <th className="px-3 py-2 text-right">Сума з ПДВ</th>
              <th className="px-3 py-2">Рядків</th>
            </tr>
          </thead>
          <tbody>
            {items.map((d) => (
              <tr
                key={d.ukrDocId}
                className="border-b last:border-0 hover:bg-indigo-50 cursor-pointer"
                onClick={() => setOpenDoc(d)}
              >
                <td className="px-3 py-2 font-medium">{d.number}</td>
                <td className="px-3 py-2 whitespace-nowrap">{fmtDate(d.dateStr)}</td>
                <td className="px-3 py-2">{d.clientName}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">{fmtMoney(d.sum)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">{fmtMoney(d.pdvAmount)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap font-medium">{fmtMoney(d.sumPdv)}</td>
                <td className="px-3 py-2">{d.linesCount}</td>
              </tr>
            ))}
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-gray-500">
                  Документів за цей період немає.
                </td>
              </tr>
            )}
          </tbody>
          {items.length > 0 && (
            <tfoot className="bg-gray-50 border-t">
              <tr>
                <td colSpan={3} className="px-3 py-2 text-right text-gray-600">
                  Разом (завантажено {items.length}):
                </td>
                <td className="px-3 py-2 text-right font-semibold whitespace-nowrap">{fmtMoney(totalNet)}</td>
                <td className="px-3 py-2 text-right font-semibold whitespace-nowrap">{fmtMoney(totalPdv)}</td>
                <td className="px-3 py-2 text-right font-semibold whitespace-nowrap">{fmtMoney(totalGross)}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div className="mt-3 flex items-center gap-3">
        {loading && <span className="text-gray-500 text-sm">Завантаження…</span>}
        {cursor && !loading && (
          <button className="px-4 py-1.5 rounded border hover:bg-gray-50" onClick={() => load(false, cursor)}>
            Ще
          </button>
        )}
      </div>

      {openDoc && <LinesModal docType={docType} doc={openDoc} onClose={() => setOpenDoc(null)} />}
    </div>
  );
}

function StockTab({ onSync }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query.trim().toLowerCase()), 400);
    return () => window.clearTimeout(t);
  }, [query]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr("");
    callStock()
      .then((r) => {
        if (!alive) return;
        setItems(r.data?.items || []);
        if (r.data?.sync) onSync(r.data.sync);
      })
      .catch(() => alive && setErr("Не вдалося завантажити залишки."))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [onSync]);

  const shown = debounced
    ? items.filter(
        (i) => i.name.toLowerCase().includes(debounced) || String(i.kod).toLowerCase().includes(debounced)
      )
    : items;

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <label className="text-sm">
          <div className="text-gray-600 mb-1">Пошук за назвою або кодом</div>
          <input
            type="search"
            className="border rounded px-2 py-1 w-72"
            placeholder="Почніть вводити…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="text-sm text-gray-500 pb-1.5">
          Склад «безготівка» · позицій: {shown.length}
          {debounced && ` з ${items.length}`}
        </div>
      </div>

      {err && <div className="mb-3 text-red-600">{err}</div>}

      <div className="bg-white rounded-xl border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-gray-500 border-b bg-gray-50">
            <tr>
              <th className="px-3 py-2">Код</th>
              <th className="px-3 py-2">Назва</th>
              <th className="px-3 py-2">Од.</th>
              <th className="px-3 py-2 text-right">К-сть</th>
              <th className="px-3 py-2 text-right" title="Ціна останнього приходу, грн">
                Закуп. ціна
              </th>
              <th className="px-3 py-2 text-right">Ціна з ПДВ</th>
              <th className="px-3 py-2 text-right">Сума</th>
              <th className="px-3 py-2 text-right">Сума з ПДВ</th>
              <th className="px-3 py-2">Останній прихід</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((i) => (
              <tr key={i.tovarId} className="border-b last:border-0">
                <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{i.kod}</td>
                <td className="px-3 py-2">
                  <div className="flex items-start gap-1.5 min-w-0">
                    <span className="min-w-0 break-words">{i.name}</span>
                    <CopyNameButton name={i.name} />
                  </div>
                </td>
                <td className="px-3 py-2">{i.unit}</td>
                <td className="px-3 py-2 text-right font-medium">{fmtQty(i.qty)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  {fmtMoney(i.costPrice)}
                  {i.costConverted && (
                    <span className="text-amber-600" title="Перераховано з валюти приходу за поточним курсом">
                      *
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">{fmtMoney(i.costPricePdv)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">{fmtMoney(i.sumCost)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">{fmtMoney(i.sumCostPdv)}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {i.lastReceiptDate ? fmtDate(i.lastReceiptDate) : "—"}
                  {i.lastReceiptNumber && <span className="text-gray-500"> № {i.lastReceiptNumber}</span>}
                </td>
              </tr>
            ))}
            {!loading && shown.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-gray-500">
                  {items.length === 0 ? "На складі немає залишків." : "Нічого не знайдено."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {loading && <div className="mt-3 text-sm text-gray-500">Завантаження…</div>}
    </div>
  );
}

export default function BuhApp() {
  const [user, setUser] = useState(undefined); // undefined = ще перевіряємо
  const [allowed, setAllowed] = useState(null);
  const [tab, setTab] = useState(TABS[0].key);
  const [sync, setSync] = useState(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      setAllowed(null);
      if (!u) return;
      const hasAccess = (t) => t.claims.admin === true || t.claims.accountant === true;
      try {
        let t = await u.getIdTokenResult();
        if (!hasAccess(t)) {
          // claim міг ще не встановитись одразу після входу: синхронізуємо та оновлюємо токен
          try {
            await httpsCallable(functions, "syncAdminClaim")();
            t = await u.getIdTokenResult(true);
          } catch {
            /* лишаємо як є */
          }
        }
        setAllowed(hasAccess(t));
      } catch {
        setAllowed(false);
      }
    });
    return () => unsub();
  }, []);

  if (user === undefined) {
    return <div className="min-h-screen grid place-items-center text-gray-500">Завантаження…</div>;
  }
  if (!user) return <AdminLogin title="Вхід до бухгалтерії" requireAdmin={false} />;
  if (allowed === null) {
    return <div className="min-h-screen grid place-items-center text-gray-500">Перевірка доступу…</div>;
  }
  if (!allowed) {
    return (
      <div className="min-h-screen grid place-items-center">
        <div className="bg-white border rounded-xl p-6 text-center space-y-3">
          <div className="font-semibold">Немає доступу</div>
          <button className="px-4 py-1.5 rounded border hover:bg-gray-50" onClick={() => signOut(auth)}>
            Вийти
          </button>
        </div>
      </div>
    );
  }

  const right = (
    <div className="flex items-center gap-3 text-sm">
      <span className="text-gray-600">{user.email}</span>
      <button className="px-3 py-1 rounded border hover:bg-gray-50" onClick={() => signOut(auth)}>
        Вийти
      </button>
    </div>
  );

  return (
    <AdminLayout title="Бухгалтерія — ФОП Благодушко" right={right}>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex gap-2">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-1.5 rounded-lg border ${
                tab === t.key ? "bg-indigo-600 text-white border-indigo-600" : "bg-white hover:bg-gray-50"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="text-xs text-gray-500">
          Остання синхронізація:{" "}
          {sync?.lastIngestAtMs ? new Date(sync.lastIngestAtMs).toLocaleString("uk-UA") : "ще не було"}
        </div>
      </div>
      {tab === "stock" ? (
        <StockTab key="stock" onSync={setSync} />
      ) : (
        <DocsTab key={tab} docType={tab} onSync={setSync} />
      )}
    </AdminLayout>
  );
}
