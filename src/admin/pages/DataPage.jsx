import React, { useEffect, useMemo, useState } from "react";
import {
  collection, doc, getDocs, setDoc, writeBatch,
  query, where, orderBy, limit, startAfter, updateDoc, serverTimestamp, deleteDoc
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
const highReads = "px-3 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white";
const moderateReads = "px-3 py-2 rounded-xl bg-orange-600 hover:bg-orange-700 text-white";

/** ---------- small UI ---------- */
function Tabs({ value, onChange, items }) {
  return (
    <div className="flex gap-2 flex-wrap mb-4">
      {items.map((it) => (
        <button
          key={it.key}
          onClick={() => onChange(it.key)}
          className={`px-3 py-2 rounded-2xl text-sm ${value===it.key ? "bg-indigo-600 text-white" : "bg-slate-100 hover:bg-slate-200"}`}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

function Section({ title, children, right }) {
  return (
    <div className="bg-white rounded-2xl shadow p-5 mb-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold">{title}</h3>
        {right || null}
      </div>
      {children}
    </div>
  );
}

function needXLSX() {
  if (!window.XLSX) throw new Error("Потрібна бібліотека XLSX: додай <script src='https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'></script> у admin.html");
}

/** ---------- helpers ---------- */
// Нормалізація артикулу (аналогічно до normalizeArticle в shared.js)
const normId = (v) => {
  const s = String(v ?? "").trim().toUpperCase();
  return s.replace(/\s+/g, "").replace(/[^\w.-]/g, "");
};
const normPhone = (s) => String(s || "").replace(/\D/g, "");

// Безпечний docId для Firestore: прибирає / . # $ [ ] та нормалізує прогалини
const safeDocId = (s) =>
  String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\/.#$\[\]]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 150);

async function batchedSet(path, records, makeIdFn) {
  // пишемо пачками до 450 записів (ліміт 500 на батч)
  const chunk = 450;
  for (let i=0; i<records.length; i+=chunk) {
    const batch = writeBatch(db);
    records.slice(i, i+chunk).forEach(r => {
      const id = makeIdFn(r);
      batch.set(doc(db, path, id), r, { merge: true });
    });
    await batch.commit();
  }
}

/** ---------- 1) Import Clients ---------- */
function ImportClients({ setStatus }) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);

  const parseFile = (file) => new Promise((resolve,reject) => {
    needXLSX();
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = window.XLSX.read(e.target.result, { type: "binary" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
        const headers = rows[0].map(h => String(h||"").trim());
        const body = rows.slice(1);
        resolve({ headers, body });
      } catch (err) { reject(err); }
    };
    reader.onerror = reject;
    reader.readAsBinaryString(file);
  });

  const onFile = async (ev) => {
    const f = ev.target.files?.[0];
    ev.target.value = "";
    if (!f) return;
    try {
      const { headers, body } = await parseFile(f);
      setPreview({ headers, body });
    } catch (e) {
      setStatus?.({ type:"error", message: e?.message || "Не вдалося прочитати файл" });
    }
  };

  const autoPick = (headers, aliases) => {
    const idx = headers.findIndex(h => aliases.some(a => h.toLowerCase().includes(a)));
    return idx >= 0 ? idx : null;
  };

  const importNow = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const H = preview.headers;
      const iId   = autoPick(H, ["id","код"]);
      const iName = autoPick(H, ["підпр","назв","піб","name"]);
      const iAddr = autoPick(H, ["адрес","address"]);
      const iTel  = autoPick(H, ["тел","phone","моб"]);
      const iMail = autoPick(H, ["mail","email","е-mail","e-mail"]);
      const iTier = autoPick(H, ["тип цін","катег","tier","price"]);

      const records = preview.body.map(r => {
        const id = String(r[iId] ?? "").trim();
        if (!id) return null;
        const name = String(r[iName] ?? "").trim();
        const priceRaw = String(r[iTier] ?? "").toLowerCase();
        // просте мапування типів (можеш підкрутити під свої правила)
        let priceType = "роздріб";
        if (/(^|\D)1(\D|$)/.test(priceRaw) || /цiна 1|цена 1|прайс1/.test(priceRaw)) priceType = "ціна 1";
        if (/(^|\D)2(\D|$)/.test(priceRaw) || /цiна 2|цена 2/.test(priceRaw)) priceType = "ціна 2";
        if (/(^|\D)3(\D|$)/.test(priceRaw) || /цiна 3|цена 3/.test(priceRaw)) priceType = "ціна 3";
        if (/опт|wholesale/.test(priceRaw)) priceType = "ціна опт";
        return {
          id,
          name,
          address: String(r[iAddr] ?? "").trim(),
          phone: normPhone(r[iTel]),
          email: String(r[iMail] ?? "").trim(),
          priceType
        };
      }).filter(Boolean);

      await batchedSet(
        `/artifacts/${appId}/public/data/clients`,
        records,
        (r) => r.id
      );
      setStatus?.({ type:"success", message:`Імпортовано клієнтів: ${records.length}` });
      setPreview(null);
    } catch (e) {
      setStatus?.({ type:"error", message: e?.message || "Помилка імпорту" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Імпорт клієнтів" right={
      <label className={secondary}>
        Обрати файл
        <input type="file" accept=".xlsx,.csv" className="hidden" onChange={onFile} />
      </label>
    }>
      {!preview ? (
        <div>
        <p className="text-sm text-slate-600">
          Завантаж XLSX/CSV із колонками на кшталт: <b>ID</b>, <b>Підприємство/ПІБ</b>, <b>Адреса</b>, <b>Телефони</b>, <b>E‑mail</b>, <b>Тип ціни</b>.
          Поля зіставляються автоматично (можна підкоригувати у файлі й повторити).
        </p>
          <p className="text-sm text-orange-600 mt-2 font-medium">
            ⚠️ Увага: Клієнти, яких немає в новому файлі, не видаляються автоматично. Імпорт оновлює існуючі записи та додає нові.
          </p>
        </div>
      ) : (
        <div>
          <div className="text-sm mb-2">Знайдено рядків: <b>{preview.body.length}</b></div>
          <p className="text-sm text-orange-600 mb-2 font-medium">
            ⚠️ Клієнти, яких немає в файлі, залишаться в базі без змін.
          </p>
          <button className={`${primary} disabled:opacity-60`} disabled={busy} onClick={importNow}>
            Імпортувати
          </button>
        </div>
      )}
    </Section>
  );
}

/** ---------- 2) Brand tools ---------- */
function BrandTools({ setStatus }) {
  const [brandsText, setBrandsText] = useState("");
  const [canonical, setCanonical] = useState("");
  const [busy, setBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);

  const brands = useMemo(() => brandsText.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean), [brandsText]);

  const saveSynonyms = async () => {
    if (!brands.length || !canonical) return;
    try {
      const docs = brands.map(b => ({ old: b, canonical }));
      await batchedSet(`/artifacts/${appId}/public/data/brandSynonyms`, docs, (r) => safeDocId(r.old));
      setStatus?.({ type:"success", message: "Синоніми брендів збережено." });
    } catch (e) {
      setStatus?.({ type:"error", message: e?.message || "Помилка збереження" });
    }
  };

  const rewriteProducts = async () => {
    if (!brands.length || !canonical) return;
    if (!confirm(`Замінити brand на "${canonical}" у товарах з брендами: ${brands.join(", ")} ?`)) return;
    setBusy(true);
    try {
      for (const b of brands) {
        let anchor = null;
        while (true) {
          const q = anchor
            ? query(collection(db, `/artifacts/${appId}/public/data/products`), where("brand","==", b), orderBy("id"), startAfter(anchor), limit(500))
            : query(collection(db, `/artifacts/${appId}/public/data/products`), where("brand","==", b), orderBy("id"), limit(500));
          const snap = await getDocs(q);
          if (snap.empty) break;
          const batch = writeBatch(db);
          snap.docs.forEach(d => batch.update(d.ref, { brand: canonical }));
          await batch.commit();
          anchor = snap.docs[snap.docs.length - 1];
          if (snap.size < 500) break;
        }
      }
      setStatus?.({ type:"success", message:"Оновлено товари. (Може зайняти час при великих обсягах)" });
    } catch (e) {
      setStatus?.({ type:"error", message: e?.message || "Помилка оновлення товарів" });
    } finally {
      setBusy(false);
    }
  };

  const exportSynonyms = async () => {
    try {
      needXLSX();
      const snap = await getDocs(collection(db, `/artifacts/${appId}/public/data/brandSynonyms`));
      const rowsMap = new Map();
      snap.docs.forEach(d => {
        const data = d.data() || {};
        const can = String(data.canonical || "").trim();
        const old = String(data.old || "").trim();
        if (!can || !old) return;
        if (!rowsMap.has(can)) rowsMap.set(can, new Set());
        rowsMap.get(can).add(old);
      });
      const data = [["Канонічний","Синонім"]];
      for (const [can, setOld] of rowsMap.entries()) {
        data.push([can, Array.from(setOld.values()).join(",")]);
      }
      const ws = window.XLSX.utils.aoa_to_sheet(data);
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, "Синоніми брендів");
      window.XLSX.writeFile(wb, "brand_synonyms.xlsx");
      setStatus?.({ type:"success", message:"Експортовано синоніми" });
    } catch (e) {
      setStatus?.({ type:"error", message: e?.message || "Помилка експорту" });
    }
  };

  const exportBrandDuplicatesXLSX = async () => {
    try {
      needXLSX();
      const call = httpsCallable(functions, "findBrandDuplicates");
      const { data } = await call();
      const dup = data?.duplicates || [];
      const rows = [["Ключ групи","Варіанти (через кому)","Кількість"]];
      dup.forEach(g => rows.push([g.lc || "", (g.variants || []).join(", "), (g.variants || []).length]));
      const ws = window.XLSX.utils.aoa_to_sheet(rows);
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, "Дублікати брендів");
      window.XLSX.writeFile(wb, "brand_duplicates.xlsx");
      setStatus?.({ type:"success", message:`Експортовано груп: ${dup.length}` });
    } catch (e) {
      setStatus?.({ type:"error", message: e?.message || "Помилка експорту дублікатів" });
    }
  };

  const generateSynonymTemplateFromDuplicates = async () => {
    try {
      needXLSX();
      const call = httpsCallable(functions, "findBrandDuplicates");
      const { data } = await call();
      const dup = data?.duplicates || [];
      // Формуємо чернетку: Canonical, Synonym — перший варіант як канонічний
      const rows = [["Канонічний","Синонім"]];
      dup.forEach(g => {
        const variants = (g.variants || []).filter(Boolean);
        if (variants.length === 0) return;
        const canonicalGuess = variants[0];
        variants.slice(1).forEach(v => rows.push([canonicalGuess, v]));
      });
      const ws = window.XLSX.utils.aoa_to_sheet(rows);
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, "Чернетка синонімів");
      window.XLSX.writeFile(wb, "brand_synonyms_draft.xlsx");
      setStatus?.({ type:"success", message:`Згенеровано рядків: ${rows.length - 1}` });
    } catch (e) {
      setStatus?.({ type:"error", message: e?.message || "Помилка генерації чернетки" });
    }
  };

  const importSynonymsFromFile = (ev) => {
    const f = ev.target.files?.[0];
    ev.target.value = "";
    if (!f) return;
    setImportBusy(true);
    try {
      needXLSX();
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const wb = window.XLSX.read(e.target.result, { type: "binary" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
          if (!rows.length) throw new Error("Файл порожній");
          const headers = rows[0].map(h => String(h||"").trim().toLowerCase());
          const idxCan = headers.findIndex(h => h.includes("канон") || h.includes("canonical") || h.includes("brand"));
          const idxSyn = headers.findIndex(h => h.includes("синонім") || h.includes("synonym"));
          
          // Підтримуємо два формати:
          // 1. Тільки канонічна колонка (без синонімів) - автоматично створюємо запис
          // 2. Канонічна + синоніми - використовуємо обидві
          const hasCanonical = idxCan >= 0;
          const hasSynonyms = idxSyn >= 0;
          
          if (!hasCanonical) throw new Error("Очікується колонка: Канонічний (або Brand)");
          
          const body = rows.slice(1);
          const pairs = [];
          const seenKeys = new Set(); // Щоб уникнути дублікатів через однакові lowercase ключі
          
          for (const r of body) {
            const can = String(r[idxCan]||"").trim();
            if (!can) continue;
            
            // Якщо є колонка синонімів - обробляємо її
            if (hasSynonyms) {
              const synStr = String(r[idxSyn]||"").trim();
              if (synStr) {
                const syns = synStr.split(/[,;]+/).map(s=>s.trim()).filter(Boolean);
                for (const s of syns) {
                  const key = safeDocId(s); // lowercase ключ
                  if (!seenKeys.has(key)) {
                    pairs.push({ old: s, canonical: can });
                    seenKeys.add(key);
                  }
                }
              }
            }
            
            // АВТОМАТИЧНО: Створюємо запис для канонічної назви
            // Оскільки document ID нормалізується до lowercase через safeDocId,
            // а normalizeBrandKey теж приводить до lowercase, один запис покриє всі варіанти регістру
            // Наприклад: { old: "Total", canonical: "Total" } з docId="total" 
            // покриє "Total", "TOTAL", "total" через normalizeBrandKey
            const canonicalKey = safeDocId(can);
            if (!seenKeys.has(canonicalKey)) {
              // Використовуємо канонічну назву як "old", щоб вона теж нормалізувалася до себе
              pairs.push({ old: can, canonical: can });
              seenKeys.add(canonicalKey);
            }
          }
          
          if (!pairs.length) throw new Error("Не знайдено записів");
          
          // КРОК 1: Видаляємо всі старі записи
          const synonymsCol = collection(db, `/artifacts/${appId}/public/data/brandSynonyms`);
          const oldSnap = await getDocs(synonymsCol);
          let deleteCount = 0;
          
          // Видаляємо батчами по 450 (ліміт Firestore = 500)
          const deleteChunk = 450;
          for (let i = 0; i < oldSnap.docs.length; i += deleteChunk) {
            const docsToDelete = oldSnap.docs.slice(i, i + deleteChunk);
            if (docsToDelete.length === 0) break;
            
            const deleteBatch = writeBatch(db);
            docsToDelete.forEach(d => {
              deleteBatch.delete(d.ref);
              deleteCount++;
            });
            await deleteBatch.commit();
          }
          
          // КРОК 2: Записуємо нові записи (без merge для точності)
          const chunk = 450;
          for (let i=0; i<pairs.length; i+=chunk) {
            const batch = writeBatch(db);
            pairs.slice(i, i+chunk).forEach(r => {
              const id = safeDocId(r.old);
              batch.set(doc(db, `/artifacts/${appId}/public/data/brandSynonyms`, id), r);
            });
            await batch.commit();
          }
          
          setStatus?.({ 
            type:"success", 
            message:`Імпортовано: ${pairs.length} записів. Видалено старих: ${deleteCount}` 
          });
        } catch (e2) {
          setStatus?.({ type:"error", message: e2?.message || "Помилка імпорту" });
        } finally {
          setImportBusy(false);
        }
      };
      reader.readAsBinaryString(f);
    } catch (e) {
      setImportBusy(false);
      setStatus?.({ type:"error", message: e?.message || "Помилка читання файлу" });
    }
  };

  return (
    <>
    <Section title="Керування брендами">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <label className="block md:col-span-2">
          <span className="text-sm text-slate-600">Старі бренди (через кому або новий рядок)</span>
          <textarea className="mt-1 p-2 border rounded w-full min-h-[80px]" value={brandsText} onChange={(e)=>setBrandsText(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-sm text-slate-600">Канонічна назва</span>
          <input className="mt-1 p-2 border rounded w-full" value={canonical} onChange={(e)=>setCanonical(e.target.value)} placeholder="напр. BOSCH" />
        </label>
      </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <button 
            className={secondary} 
            onClick={saveSynonyms}
            title="Зберігає відповідність старих назв брендів канонічним (використовується при імпорті прайсів). Мало reads."
          >
            Зберегти синоніми
          </button>
          <button 
            className={`${highReads} disabled:opacity-60`} 
            disabled={busy} 
            onClick={rewriteProducts}
            title="Замінює стару назву бренду на канонічну у всіх товарах. ⚠️ ВИКОРИСТОВУЄ БАГАТО READS (читає всі товари з певним брендом)."
          >
          Перезаписати brand у товарах
        </button>
          <button 
            className={moderateReads} 
            onClick={exportSynonyms}
            title="Експортує всі синоніми брендів у форматі Excel для редагування. Помірно reads."
          >
            Експортувати XLSX
          </button>
          <label 
            className={`${moderateReads} cursor-pointer`}
            title="Імпортує синоніми брендів з Excel файлу (колонки: Канонічний, Синонім). Помірно reads."
          >
            Імпортувати XLSX
            <input type="file" accept=".xlsx,.csv" className="hidden" onChange={importSynonymsFromFile} disabled={importBusy} />
          </label>
          <button
            className={highReads}
            onClick={async () => {
              try {
                const call = httpsCallable(functions, "findBrandDuplicates");
                const { data } = await call();
                const dup = data?.duplicates || [];
                if (dup.length === 0) {
                  setStatus?.({ type: "success", message: "Дублікатів не знайдено" });
                  return;
                }
                alert(
                  `Знайдено груп дублікатів: ${dup.length}\n\n` +
                  dup.slice(0, 20).map(g => `• ${g.lc}: ${g.variants.join(" | ")}`).join("\n") +
                  (dup.length > 20 ? `\n...ще ${dup.length - 20}` : "")
                );
              } catch (e) {
                setStatus?.({ type: "error", message: e?.message || "Помилка пошуку дублікатів" });
              }
            }}
            title="Шукає групи схожих назв брендів (різний регістр, пробіли) для подальшого створення синонімів. ⚠️ ВИКОРИСТОВУЄ ДУЖЕ БАГАТО READS (читає всі товари в базі)."
          >
            Знайти дублікати брендів
          </button>
          <button 
            className={highReads} 
            onClick={exportBrandDuplicatesXLSX}
            title="Експортує список всіх дублікатів брендів для аналізу (формат: ключ групи, варіанти, кількість). ⚠️ ВИКОРИСТОВУЄ ДУЖЕ БАГАТО READS."
          >
            Експортувати дублікати XLSX
          </button>
          <button 
            className={highReads} 
            onClick={generateSynonymTemplateFromDuplicates}
            title="Створює готовий Excel файл для імпорту синонімів (формат: Канонічний | Синонім). Перший варіант стає канонічним, інші — синонімами. ⚠️ ВИКОРИСТОВУЄ ДУЖЕ БАГАТО READS."
          >
            Згенерувати шаблон синонімів
          </button>
      </div>
      <p className="text-xs text-slate-500 mt-2">
        Порада: спочатку збережи синоніми — їх може використати імпортер прайсів. Перезапис товарів може зайняти час і виконати багато записів.
      </p>
    </Section>

      <Section title="Кеш брендів">
        <div className="flex flex-wrap gap-2 mb-3">
          <button
            className={moderateReads}
            onClick={async () => {
              try {
                const call = httpsCallable(functions, "clearBrandsCache");
                const { data } = await call();
                setStatus?.({ type: "success", message: `Кеш очищено: видалено ${data?.deleted ?? 0}` });
              } catch (e) {
                setStatus?.({ type: "error", message: e?.message || "Помилка очищення кешу" });
              }
            }}
            title="Видаляє всі записи з кешу брендів (після оновлення синонімів). Помірно reads."
          >
            Очистити кеш брендів
          </button>

          <button
            className={highReads}
            onClick={async () => {
              try {
                const call = httpsCallable(functions, "rebuildBrandsCache");
                const { data } = await call();
                setStatus?.({ type: "success", message: `Перебудовано: ${data?.written ?? 0}` });
              } catch (e) {
                setStatus?.({ type: "error", message: e?.message || "Помилка перебудови кешу" });
              }
            }}
            title="Повністю перебудовує кеш брендів з усіх товарів у базі (виконується автоматично щосуботи). ⚠️ ВИКОРИСТОВУЄ ДУЖЕ БАГАТО READS (читає всі товари)."
          >
            Перебудувати кеш брендів
          </button>
        </div>
        <p className="text-xs text-slate-500">
          Порада: якщо помітили дублікати, спершу оновіть синоніми брендів у даних, потім натисніть «Очистити кеш» і «Перебудувати кеш» — наступні імпорти підтягнуть канонічні назви.
        </p>
      </Section>
    </>
  );
}

/** ---------- 3) Product Master Data import ---------- */
function ImportProductMasterData({ setStatus }) {
  const [count, setCount] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportingAll, setExportingAll] = useState(false);

  const exportAllMasterData = async () => {
    if (!window.XLSX) {
      setStatus?.({ type: "error", message: "Потрібна бібліотека XLSX" });
      return;
    }
    setExportingAll(true);
    try {
      const snap = await getDocs(collection(db, `/artifacts/${appId}/public/data/productMasterData`));
      if (snap.empty) {
        setStatus?.({ type: "success", message: "Майстер-дані порожні" });
        return;
      }
      const data = snap.docs.map(d => {
        const r = d.data();
        return {
          "Бренд": r.brand ?? "",
          "Артикул": r.id ?? "",
          "Правильна назва": r.correctName ?? "",
          "Категорії": Array.isArray(r.categories) ? r.categories.join(", ") : (r.categories ?? ""),
          "Фасування": r.pack ?? "",
          "Допуски": r.tolerances ?? "",
          "Синоніми артикулів": Array.isArray(r.synonyms) ? r.synonyms.join(", ") : (r.synonyms ?? ""),
        };
      });

      const ws = window.XLSX.utils.json_to_sheet(data);
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, "Майстер-дані");
      window.XLSX.writeFile(wb, `master-data-${Date.now()}.xlsx`);
      setStatus?.({ type: "success", message: `Експортовано ${data.length} записів майстер-даних` });
    } catch (e) {
      setStatus?.({ type: "error", message: e?.message || "Помилка експорту" });
    } finally {
      setExportingAll(false);
    }
  };

  const exportProductsForReview = async () => {
    if (!window.XLSX) {
      setStatus?.({ type: "error", message: "Потрібна бібліотека XLSX" });
      return;
    }
    setExporting(true);
    try {
      const call = httpsCallable(functions, "monitorProductMasterData");
      const PAGE = 100;
      const MAX_PAGES = 200;
      let cursor = null;
      const all = [];
      let truncated = false;
      for (let page = 0; page < MAX_PAGES; page++) {
        const { data } = await call({
          supplier: "Мій склад",
          fields: ["masterExists"],
          pageSize: PAGE,
          cursor,
        });
        const rows = Array.isArray(data?.rows) ? data.rows : [];
        all.push(...rows);
        if (rows.length === 0) break;
        if (!data?.hasMore) break;
        cursor = data.nextCursor != null ? data.nextCursor : null;
        if (cursor == null) break;
        if (page === MAX_PAGES - 1 && data.hasMore) truncated = true;
      }

      if (all.length === 0) {
        setStatus?.({
          type: "success",
          message: "✅ Для «Мій склад» не знайдено позицій без master-картки (за поточним сканом).",
        });
        return;
      }

      const dataRows = all.map((row) => ({
        "Бренд": row.brand,
        "Артикул": row.id,
        "Назва (з каталогу)": row.name,
        "Постачальник": row.supplier ?? "Мій склад",
        "Залишок": row.stock,
        "Бракує": (row.missingFields || []).join(", "),
        "Синоніми артикулів": "",
        "Правильна назва": "",
        "Допуски": "",
        "Категорії": "",
        "Фасування": "",
      }));

      const ws = window.XLSX.utils.json_to_sheet(dataRows);
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, "Без master-картки");
      window.XLSX.writeFile(wb, `products-no-master-${Date.now()}.xlsx`);

      setStatus?.({
        type: "success",
        message:
          `Експортовано ${dataRows.length} позицій постачальника «Мій склад» без запису в productMasterData` +
          (truncated ? " (можливе обмеження сторінок експорту — уточни в Товари › Майстер-дані)." : "."),
      });
    } catch (e) {
      setStatus?.({ type: "error", message: e?.message || "Помилка експорту" });
    } finally {
      setExporting(false);
    }
  };

  const parseMasterXlsx = (file) => new Promise((resolve, reject) => {
    needXLSX();
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = window.XLSX.read(e.target.result, { type: "binary" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
        if (!rows.length) throw new Error("Файл порожній");

        const headers = rows[0].map(h => String(h||"").trim().toLowerCase());
        const body = rows.slice(1);
        const pick = (...aliases) => headers.findIndex(h => aliases.some(a => h.includes(a)));

        const iBrand = pick("бренд","brand","виробник");
        const iId    = pick("артикул","код","sku","id");
        if (iBrand < 0 || iId < 0) throw new Error("Потрібні колонки: Бренд, Артикул");

        const iName = pick("правил","назва","correct","name");
        const iCats = pick("категор","category","categories");
        const iPack = pick("фасув","pack","packaging");
        const iTol  = pick("допуск","toler","approvals","approval");
        const iSyn  = pick("синонім","synonym");

        const recs = body.map(r => {
          const brand = String(r[iBrand]||"").trim();
          const id = normId(r[iId]);
          if (!brand || !id) return null;
          const correctName = iName>=0 ? String(r[iName]||"").trim() : "";
          const categories = iCats>=0 ? String(r[iCats]||"").split(/[,;]+/).map(s=>s.trim()).filter(Boolean) : [];
          const pack = iPack>=0 ? String(r[iPack]||"").trim() : "";
          const tolerances = iTol>=0 ? String(r[iTol]||"").trim() : "";
          const synonyms = iSyn>=0 ? String(r[iSyn]||"").split(/[,;]+/).map(s=>s.trim()).filter(Boolean) : [];
          return { brand, id, correctName, categories, pack, tolerances, synonyms };
        }).filter(Boolean);

        resolve(recs);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error("Помилка читання файлу"));
    reader.readAsBinaryString(file);
  });

  const clearMasterCache = async () => {
    try {
      const clearCache = httpsCallable(functions, "clearMasterDataCache");
      await clearCache();
    } catch (cacheErr) {
      console.warn("Failed to clear master data cache:", cacheErr);
    }
  };

  // Строгий синк: оновлює подані + видаляє відсутні
  const onFile = (ev) => {
    const f = ev.target.files?.[0];
    ev.target.value = "";
    if (!f) return;
    (async () => {
      try {
        const recs = await parseMasterXlsx(f);

        const seenDocIds = new Set(recs.map(r => `${r.brand}__${r.id}`));
        await batchedSet(`/artifacts/${appId}/public/data/productMasterData`, recs, (r) => `${r.brand}__${r.id}`);

        let deletedCount = 0;
        if (seenDocIds.size > 0) {
          const masterDataCol = collection(db, `/artifacts/${appId}/public/data/productMasterData`);
          const snap = await getDocs(masterDataCol);
          if (snap.size > 0) {
            const BATCH_LIMIT = 500;
            let batch = writeBatch(db);
            let ops = 0;
            for (const d of snap.docs) {
              if (!seenDocIds.has(d.id)) {
                batch.delete(d.ref);
                ops++;
                deletedCount++;
                if (ops >= BATCH_LIMIT) { await batch.commit(); batch = writeBatch(db); ops = 0; }
              }
            }
            if (ops > 0) await batch.commit();
          }
        }

        setCount(recs.length);
        await clearMasterCache();
        setStatus?.({ type: "success", message: deletedCount > 0 ? `Імпортовано: ${recs.length}, видалено: ${deletedCount}` : `Імпортовано: ${recs.length}` });
      } catch (e) {
        setStatus?.({ type: "error", message: e?.message || "Помилка обробки файлу" });
      }
    })();
  };

  // Часткове оновлення: оновлює тільки подані, нічого не видаляє
  const onFilePartial = (ev) => {
    const f = ev.target.files?.[0];
    ev.target.value = "";
    if (!f) return;
    (async () => {
      try {
        const recs = await parseMasterXlsx(f);
        await batchedSet(`/artifacts/${appId}/public/data/productMasterData`, recs, (r) => `${r.brand}__${r.id}`);
        await clearMasterCache();
        setStatus?.({ type: "success", message: `Часткове оновлення: оновлено ${recs.length} товарів` });
      } catch (e) {
        setStatus?.({ type: "error", message: e?.message || "Помилка обробки файлу" });
      }
    })();
  };

  return (
    <Section title="Майстер-дані товарів" right={
      <div className="flex gap-2">
        <button
          className={`${secondary} disabled:opacity-60`}
          disabled={exportingAll}
          onClick={exportAllMasterData}
        >
          {exportingAll ? "Експорт..." : "Експортувати майстер-дані"}
        </button>
        <button
          className={`${secondary} disabled:opacity-60`}
          disabled={exporting}
          onClick={exportProductsForReview}
        >
          {exporting ? "Експорт..." : "Експорт без master (Мій склад)"}
        </button>
      <label className={`${secondary} cursor-pointer`}>
        Обрати XLSX
        <input type="file" accept=".xlsx,.csv" className="hidden" onChange={onFile} />
      </label>
      <label className={`${primary} cursor-pointer`}>
        Часткове оновлення
        <input type="file" accept=".xlsx,.csv" className="hidden" onChange={onFilePartial} />
      </label>
      </div>
    }>
      <div className="space-y-4">
        {/* Формат файлу */}
        <div>
          <h4 className="text-sm font-semibold text-slate-700 mb-2">📋 Формат Excel файлу</h4>
          <p className="text-sm text-slate-600 mb-2">
            <b>Обов'язкові колонки:</b> <b>Бренд</b>, <b>Артикул</b>
          </p>
          <p className="text-sm text-slate-600 mb-2">
            <b>Опційні колонки:</b> <b>Правильна назва</b>, <b>Категорії</b> (через кому), <b>Фасування</b>, <b>Допуски</b>, <b>Синоніми</b> (через кому)
          </p>
          <p className="text-xs text-slate-500">
            Назви колонок розпізнаються автоматично (незалежно від регістру). Приклад: "Бренд", "Артикул", "Правильна назва", "Категорії", "Фасування", "Допуски", "Синоніми".
          </p>
        </div>

        {/* Строгий синхрон */}
        <div className="bg-orange-50 border border-orange-200 rounded-lg p-3">
          <h4 className="text-sm font-semibold text-orange-800 mb-2">⚠️ Строгий синхрон (Strict Sync)</h4>
          <p className="text-xs text-orange-700 mb-2">
            <b>Важливо:</b> Система працює у режимі <b>строгого синхрону</b>. Це означає:
          </p>
          <ul className="text-xs text-orange-700 list-disc list-inside space-y-1">
            <li>Товари з файлу <b>додаються або оновлюються</b> в базі майстер-даних</li>
            <li>Товари, яких <b>немає в файлі</b>, автоматично <b>видаляються</b> з бази</li>
            <li>Якщо файл порожній — всі майстер-дані будуть видалені</li>
          </ul>
          <p className="text-xs text-orange-600 mt-2">
            💡 <b>Порада:</b> Перед імпортом зроби резервну копію, якщо хочеш зберегти старі дані.
          </p>
        </div>

        {/* Як працює механізм */}
        <div>
          <h4 className="text-sm font-semibold text-slate-700 mb-2">🔧 Як працює механізм майстер-даних</h4>
          <div className="text-xs text-slate-600 space-y-2">
            <p>
              <b>1. Зберігання:</b> Майстер-дані зберігаються в колекції <code className="bg-slate-100 px-1 rounded">/public/data/productMasterData</code> з docId формату <code className="bg-slate-100 px-1 rounded">Бренд__Артикул</code> (напр. <code className="bg-slate-100 px-1 rounded">BOSCH__ABC123</code>).
            </p>
            <p>
              <b>2. Кешування:</b> Дані автоматично кешуються в пам'яті на 5 хвилин. При першому зверненні система завантажує всі майстер-дані з Firestore (один раз), потім використовує кеш. Це мінімізує витрати на reads.
            </p>
            <p>
              <b>3. Використання при імпорті прайсів:</b> Коли завантажується прайс постачальника, система шукає майстер-дані для кожного товару (по бренду + артикулу). Якщо знайдено:
            </p>
            <ul className="list-disc list-inside ml-4 space-y-1">
              <li>Використовується <b>правильна назва</b> замість назви з прайсу</li>
              <li>Підставляються <b>категорії</b>, <b>фасування</b>, <b>допуски</b></li>
              <li>Додаються <b>синоніми артикулів</b> (для пошуку)</li>
            </ul>
            <p className="ml-4">
              Якщо майстер-даних немає — товар зберігається з тимчасовою назвою з прайсу; детальну перевірку зручно робити в розділі <b>Товари › Майстер-дані</b> (моніторинг полів).
            </p>
            <p>
              <b>4. Синоніми артикулів:</b> Якщо в майстер-даних вказані синоніми (напр. <code className="bg-slate-100 px-1 rounded">ABC-123, ABC123, ABC_123</code>), вони зберігаються в документі товару. Пошук по артикулу знайде товар за будь-яким синонімом.
            </p>
            <p>
              <b>5. Нормалізація:</b> Артикули автоматично нормалізуються (прибираються пробіли, спецсимволи) для консистентності. Наприклад, <code className="bg-slate-100 px-1 rounded">ABC-123</code> і <code className="bg-slate-100 px-1 rounded">ABC 123</code> стануть <code className="bg-slate-100 px-1 rounded">ABC123</code>.
            </p>
          </div>
        </div>

        {/* Експорт товарів для перевірки */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
          <h4 className="text-sm font-semibold text-blue-800 mb-2">📤 Експорт позицій без master-картки</h4>
          <p className="text-xs text-blue-700 mb-2">
            Кнопка «Експорт без master (Мій склад)» викликає той самий механізм, що й моніторинг у <b>Товари › Майстер-дані</b>: постачальник <b>Мій склад</b>, перевірка на відсутність запису в <code className="bg-blue-100 px-1 rounded">productMasterData</code>. Результат — Excel для подальшого заповнення і імпорту майстер-даних.
          </p>
          <ul className="text-xs text-blue-700 list-disc list-inside space-y-1">
            <li>Знайти товари, які потребують додавання майстер-даних</li>
            <li>Заповнити правильні назви, категорії, допуски</li>
            <li>Додати синоніми артикулів</li>
            <li>Після заповнення — імпортувати файл назад</li>
          </ul>
        </div>

        {/* Витрати */}
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
          <h4 className="text-sm font-semibold text-slate-700 mb-2">💰 Витрати на операції</h4>
          <div className="text-xs text-slate-600 space-y-1">
            <p><b>Імпорт:</b> Reads = N (кількість документів у майстер-даних для cleanup) + M (записів у файлі для збереження). Writes = M (оновлення/додавання) + D (видалення).</p>
            <p><b>Використання:</b> Кеш завантажується один раз на 5 хвилин, потім використовується з пам'яті (0 reads).</p>
            <p><b>Експорт (без master):</b> виклики <code className="bg-slate-100 px-1 rounded">monitorProductMasterData</code> (по сторінках, до ~20 000 рядків).</p>
          </div>
        </div>
      </div>

      {count > 0 && (
        <div className="text-sm mt-4 p-2 bg-green-50 border border-green-200 rounded">
          ✅ Імпортовано записів: <b>{count}</b>
        </div>
      )}
    </Section>
  );
}

/** ---------- 4) Categories Management ---------- */
function CategoriesManagement({ setStatus }) {
  const [categories, setCategories] = useState([]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null); // {id, name, order}
  const [newCat, setNewCat] = useState({ name: "", order: 0 });

  useEffect(() => {
    loadCategories();
  }, []);

  const loadCategories = async () => {
    try {
      const snap = await getDocs(collection(db, `/artifacts/${appId}/public/meta/categories`));
      const cats = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.name || '').localeCompare(String(b.name || '')));
      setCategories(cats);
    } catch (e) {
      setStatus?.({ type: "error", message: e?.message || "Помилка завантаження" });
    }
  };

  const saveCategory = async (cat) => {
    if (!cat.name?.trim()) return;
    setBusy(true);
    try {
      const safeId = safeDocId(cat.name);
      await setDoc(doc(db, `/artifacts/${appId}/public/meta/categories`, safeId), {
        name: cat.name.trim(),
        order: Number(cat.order) || 0,
        updatedAt: serverTimestamp()
      }, { merge: true });
      await loadCategories();
      setEditing(null);
      setStatus?.({ type: "success", message: "Категорію збережено" });
    } catch (e) {
      setStatus?.({ type: "error", message: e?.message || "Помилка збереження" });
    } finally {
      setBusy(false);
    }
  };

  const deleteCategory = async (id) => {
    if (!confirm("Видалити категорію?")) return;
    setBusy(true);
    try {
      await deleteDoc(doc(db, `/artifacts/${appId}/public/meta/categories`, id));
      await loadCategories();
      setStatus?.({ type: "success", message: "Категорію видалено" });
    } catch (e) {
      setStatus?.({ type: "error", message: e?.message || "Помилка видалення" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Керування категоріями">
      <div className="mb-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <input
            className="p-2 border rounded"
            placeholder="Назва категорії"
            value={newCat.name}
            onChange={(e) => setNewCat({ ...newCat, name: e.target.value })}
          />
          <input
            type="number"
            className="p-2 border rounded"
            placeholder="Порядок (0, 1, 2...)"
            value={newCat.order}
            onChange={(e) => setNewCat({ ...newCat, order: Number(e.target.value) || 0 })}
          />
          <button
            className={`${primary} disabled:opacity-60`}
            disabled={busy || !newCat.name?.trim()}
            onClick={() => {
              saveCategory(newCat);
              setNewCat({ name: "", order: 0 });
            }}
          >
            Додати
          </button>
        </div>
      </div>

      <div className="space-y-2">
        {categories.map(cat => (
          <div key={cat.id} className="flex items-center gap-2 p-2 border rounded">
            {editing?.id === cat.id ? (
              <>
                <input
                  className="flex-1 p-2 border rounded"
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                />
                <input
                  type="number"
                  className="w-20 p-2 border rounded"
                  value={editing.order}
                  onChange={(e) => setEditing({ ...editing, order: Number(e.target.value) || 0 })}
                />
                <button className={primary} onClick={() => saveCategory(editing)} disabled={busy}>
                  Зберегти
                </button>
                <button className={secondary} onClick={() => setEditing(null)}>Скасувати</button>
              </>
            ) : (
              <>
                <span className="flex-1 font-medium">{cat.name || cat.id}</span>
                <span className="text-sm text-slate-500">Порядок: {cat.order || 0}</span>
                <button className={secondary} onClick={() => setEditing({ id: cat.id, name: cat.name || '', order: cat.order || 0 })}>
                  Редагувати
                </button>
                <button className={danger} onClick={() => deleteCategory(cat.id)} disabled={busy}>
                  Видалити
                </button>
              </>
            )}
          </div>
        ))}
        {categories.length === 0 && (
          <div className="text-sm text-slate-500">Категорії не додані. Додайте першу категорію.</div>
        )}
      </div>
      <p className="text-xs text-slate-500 mt-3">
        Категорії також автоматично оновлюються при імпорті майстер-даних.
      </p>
    </Section>
  );
}

/** ---------- 5) Brand Folders Management ---------- */
function BrandFoldersManagement({ setStatus }) {
  const [folders, setFolders] = useState([]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);
  const [newFolder, setNewFolder] = useState({ 
    name: "", 
    slug: "", 
    order: 0, 
    filterType: "ukrSkladGroup",
    filterValue: "",
    // Для нового інтерфейсу вибору
    selectedBrands: [],
    selectedCategories: [],
    selectedGroupIds: []
  });
  
  // Завантажуємо бренди та категорії для вибору
  const [allBrands, setAllBrands] = useState([]); // [{id, name}]
  const [allCategories, setAllCategories] = useState([]); // [{id, name}]

  useEffect(() => {
    loadFolders();
    loadBrandsAndCategories();
  }, []);

  const loadBrandsAndCategories = async () => {
    try {
      const [brandsSnap, categoriesSnap] = await Promise.all([
        getDocs(collection(db, `/artifacts/${appId}/public/meta/brands`)),
        getDocs(collection(db, `/artifacts/${appId}/public/meta/categories`))
      ]);
      
      const brands = brandsSnap.docs
        .map(d => ({ id: d.id, name: d.data().name || d.id }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      setAllBrands(brands);
      
      const categories = categoriesSnap.docs
        .map(d => ({ id: d.id, name: d.data().name || d.id }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      setAllCategories(categories);
    } catch (e) {
      console.error("Помилка завантаження брендів/категорій", e);
    }
  };

  const loadFolders = async () => {
    try {
      const snap = await getDocs(collection(db, `/artifacts/${appId}/public/meta/brandFolders`));
      const flds = snap.docs.map(d => {
        const data = d.data();
        // Міграція: якщо немає filterType, встановлюємо за замовчуванням 'ukrSkladGroup'
        if (!data.filterType) {
          data.filterType = 'ukrSkladGroup';
          // Якщо є ukrSkladGroupIds - залишаємо, якщо немає - порожній масив
          if (!data.ukrSkladGroupIds) {
            data.ukrSkladGroupIds = [];
          }
        }
        return { id: d.id, ...data };
      })
        .sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.name || '').localeCompare(String(b.name || '')));
      setFolders(flds);
    } catch (e) {
      setStatus?.({ type: "error", message: e?.message || "Помилка завантаження" });
    }
  };

  const parseFilterValue = (filterType, filterValue) => {
    if (!filterValue?.trim()) return [];
    return filterValue.split(',').map(v => v.trim()).filter(Boolean);
  };

  const formatFilterValue = (filterType, folder) => {
    if (filterType === 'ukrSkladGroup') {
      return (folder.ukrSkladGroupIds || []).join(', ');
    } else if (filterType === 'brand') {
      return (folder.brands || []).join(', ');
    } else if (filterType === 'category') {
      return (folder.categories || []).join(', ');
    }
    return '';
  };

  // Отримуємо вибрані значення як масив
  const getSelectedValues = (filterType, folder) => {
    if (filterType === 'ukrSkladGroup') {
      return folder.ukrSkladGroupIds || [];
    } else if (filterType === 'brand') {
      return folder.brands || [];
    } else if (filterType === 'category') {
      return folder.categories || [];
    }
    return [];
  };

  const saveFolder = async (folder) => {
    if (!folder.name?.trim()) return;
    setBusy(true);
    try {
      const id = folder.id || safeDocId(folder.slug || folder.name);
      const filterType = folder.filterType || 'ukrSkladGroup';
      
      // Визначаємо значення залежно від типу та джерела даних
      let filterValues = [];
      if (filterType === 'ukrSkladGroup') {
        // Може бути з нового інтерфейсу (selectedGroupIds) або зі старого (filterValue)
        filterValues = Array.isArray(folder.selectedGroupIds) && folder.selectedGroupIds.length > 0
          ? folder.selectedGroupIds
          : parseFilterValue(filterType, folder.filterValue || '');
      } else if (filterType === 'brand') {
        filterValues = Array.isArray(folder.selectedBrands) && folder.selectedBrands.length > 0
          ? folder.selectedBrands
          : parseFilterValue(filterType, folder.filterValue || '');
      } else if (filterType === 'category') {
        filterValues = Array.isArray(folder.selectedCategories) && folder.selectedCategories.length > 0
          ? folder.selectedCategories
          : parseFilterValue(filterType, folder.filterValue || '');
      }
      
      const data = {
        name: folder.name.trim(),
        slug: folder.slug?.trim() || safeDocId(folder.name),
        order: Number(folder.order) || 0,
        filterType: filterType,
        updatedAt: serverTimestamp()
      };

      // Додаємо параметри фільтрації залежно від типу
      if (filterType === 'ukrSkladGroup') {
        data.ukrSkladGroupIds = filterValues.filter(Boolean);
        delete data.brands;
        delete data.categories;
      } else if (filterType === 'brand') {
        data.brands = filterValues.filter(Boolean);
        delete data.ukrSkladGroupIds;
        delete data.categories;
      } else if (filterType === 'category') {
        data.categories = filterValues.filter(Boolean);
        delete data.ukrSkladGroupIds;
        delete data.brands;
      }

      await setDoc(doc(db, `/artifacts/${appId}/public/meta/brandFolders`, id), data, { merge: true });
      await loadFolders();
      setEditing(null);
      setNewFolder({ name: "", slug: "", order: 0, filterType: "ukrSkladGroup", filterValue: "", selectedBrands: [], selectedCategories: [], selectedGroupIds: [] });
      setStatus?.({ type: "success", message: "Бренд-папку збережено" });
    } catch (e) {
      setStatus?.({ type: "error", message: e?.message || "Помилка збереження" });
    } finally {
      setBusy(false);
    }
  };

  const deleteFolder = async (id) => {
    if (!confirm("Видалити бренд-папку?")) return;
    setBusy(true);
    try {
      await deleteDoc(doc(db, `/artifacts/${appId}/public/meta/brandFolders`, id));
      await loadFolders();
      setStatus?.({ type: "success", message: "Бренд-папку видалено" });
    } catch (e) {
      setStatus?.({ type: "error", message: e?.message || "Помилка видалення" });
    } finally {
      setBusy(false);
    }
  };

  const getFilterPlaceholder = (filterType) => {
    if (filterType === 'ukrSkladGroup') {
      return "Введіть ID через кому (напр. 123, 456, 789)";
    } else if (filterType === 'brand') {
      return "Введіть назви брендів через кому (напр. BOSCH, VAG)";
    } else if (filterType === 'category') {
      return "Введіть категорії через кому (напр. Масла, Фільтри)";
    }
    return "";
  };

  // Компонент для вибору брендів/категорій з чекбоксами
  const MultiSelectCheckboxes = ({ items, selected, onChange, placeholder }) => {
    const [search, setSearch] = useState("");
    const filtered = items.filter(item => 
      String(item.name || item.id).toLowerCase().includes(search.toLowerCase())
    ).sort((a, b) => {
      // Сортуємо по назві алфавітно
      const nameA = String(a.name || a.id || '');
      const nameB = String(b.name || b.id || '');
      return nameA.localeCompare(nameB, 'uk', { sensitivity: 'base' });
    });

    return (
      <div className="border rounded p-3 bg-gray-50 max-h-64 overflow-y-auto">
        <input
          type="text"
          className="w-full p-2 mb-2 border rounded text-sm"
          placeholder={placeholder || "Пошук..."}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="space-y-1">
          {filtered.length === 0 ? (
            <div className="text-sm text-gray-500 py-2">Нічого не знайдено</div>
          ) : (
            filtered.map(item => {
              const itemValue = item.name || item.id;
              const isSelected = selected.includes(itemValue);
              return (
                <label key={item.id} className="flex items-center gap-2 p-1 hover:bg-white rounded cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={(e) => {
                      if (e.target.checked) {
                        onChange([...selected, itemValue]);
                      } else {
                        onChange(selected.filter(v => v !== itemValue));
                      }
                    }}
                    className="rounded"
                  />
                  <span className="text-sm">{itemValue}</span>
                </label>
              );
            })
          )}
        </div>
        {selected.length > 0 && (
          <div className="mt-2 pt-2 border-t">
            <div className="text-xs text-gray-600 mb-1">Вибрано: {selected.length}</div>
            <div className="flex flex-wrap gap-1">
              {selected.slice().sort((a, b) => String(a).localeCompare(String(b), 'uk', { sensitivity: 'base' })).map(value => (
                <span
                  key={value}
                  className="inline-flex items-center gap-1 px-2 py-1 bg-indigo-100 text-indigo-700 rounded text-xs"
                >
                  {value}
                  <button
                    type="button"
                    onClick={() => onChange(selected.filter(v => v !== value))}
                    className="hover:text-indigo-900"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  // Компонент для введення UkrSklad Group ID (теги)
  const UkrSkladGroupInput = ({ values, onChange }) => {
    const [inputValue, setInputValue] = useState("");

    const handleAdd = () => {
      const trimmed = inputValue.trim();
      if (trimmed && !values.includes(trimmed)) {
        onChange([...values, trimmed]);
        setInputValue("");
      }
    };

    const handleKeyPress = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleAdd();
      }
    };

    return (
      <div className="space-y-2">
        <div className="flex gap-2">
          <input
            type="text"
            className="flex-1 p-2 border rounded"
            placeholder="Введіть ID та натисніть Enter або кнопку 'Додати'"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyPress={handleKeyPress}
          />
          <button
            type="button"
            onClick={handleAdd}
            className="px-3 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700"
          >
            Додати
          </button>
        </div>
        {values.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {values.map((id, idx) => (
              <span
                key={idx}
                className="inline-flex items-center gap-1 px-2 py-1 bg-indigo-100 text-indigo-700 rounded text-sm"
              >
                {id}
                <button
                  type="button"
                  onClick={() => onChange(values.filter((_, i) => i !== idx))}
                  className="hover:text-indigo-900"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <Section title="Керування бренд-папками">
      <p className="text-sm text-slate-600 mb-4">
        Бренд-папки використовуються у каталозі для групування товарів. Оберіть тип фільтрації та вкажіть параметри.
      </p>
      <div className="mb-6 p-4 border rounded-lg bg-gray-50">
        <h4 className="font-medium mb-3">Додати нову бренд-папку</h4>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
          <input
            className="p-2 border rounded"
            placeholder="Назва (відображається)"
            value={newFolder.name}
            onChange={(e) => setNewFolder({ ...newFolder, name: e.target.value })}
          />
          <input
            className="p-2 border rounded"
            placeholder="Slug (необов'язково)"
            value={newFolder.slug}
            onChange={(e) => setNewFolder({ ...newFolder, slug: e.target.value })}
          />
          <input
            type="number"
            className="p-2 border rounded"
            placeholder="Порядок"
            value={newFolder.order}
            onChange={(e) => setNewFolder({ ...newFolder, order: Number(e.target.value) || 0 })}
          />
        </div>
        <div className="mb-3">
          <select
            className="p-2 border rounded w-full md:w-auto"
            value={newFolder.filterType}
            onChange={(e) => {
              const newType = e.target.value;
              setNewFolder({ 
                ...newFolder, 
                filterType: newType,
                // Очищаємо значення при зміні типу
                selectedGroupIds: [],
                selectedBrands: [],
                selectedCategories: [],
                filterValue: ""
              });
            }}
          >
            <option value="ukrSkladGroup">UkrSklad Group ID</option>
            <option value="brand">Назва бренду</option>
            <option value="category">Категорія товарів</option>
          </select>
        </div>
        <div className="mb-3">
          {newFolder.filterType === 'brand' && (
            <MultiSelectCheckboxes
              items={allBrands}
              selected={newFolder.selectedBrands || []}
              onChange={(brands) => setNewFolder({ ...newFolder, selectedBrands: brands })}
              placeholder="Пошук брендів..."
            />
          )}
          {newFolder.filterType === 'category' && (
            <MultiSelectCheckboxes
              items={allCategories}
              selected={newFolder.selectedCategories || []}
              onChange={(categories) => setNewFolder({ ...newFolder, selectedCategories: categories })}
              placeholder="Пошук категорій..."
            />
          )}
          {newFolder.filterType === 'ukrSkladGroup' && (
            <UkrSkladGroupInput
              values={newFolder.selectedGroupIds || []}
              onChange={(ids) => setNewFolder({ ...newFolder, selectedGroupIds: ids })}
            />
          )}
        </div>
        <button
          className={`${primary} disabled:opacity-60`}
          disabled={busy || !newFolder.name?.trim() || 
            (newFolder.filterType === 'brand' && (!newFolder.selectedBrands || newFolder.selectedBrands.length === 0)) ||
            (newFolder.filterType === 'category' && (!newFolder.selectedCategories || newFolder.selectedCategories.length === 0)) ||
            (newFolder.filterType === 'ukrSkladGroup' && (!newFolder.selectedGroupIds || newFolder.selectedGroupIds.length === 0))
          }
          onClick={() => {
            saveFolder(newFolder);
            setNewFolder({ name: "", slug: "", order: 0, filterType: "ukrSkladGroup", filterValue: "", selectedBrands: [], selectedCategories: [], selectedGroupIds: [] });
          }}
        >
          Додати
        </button>
      </div>

      <div className="space-y-2">
        {folders.map(folder => {
          const folderFilterType = folder.filterType || 'ukrSkladGroup';
          const folderFilterValue = formatFilterValue(folderFilterType, folder);
          
          return (
            <div key={folder.id} className="p-3 border rounded space-y-2">
              {editing?.id === folder.id ? (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                    <input
                      className="p-2 border rounded"
                      placeholder="Назва"
                      value={editing.name}
                      onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    />
                    <input
                      className="p-2 border rounded"
                      placeholder="Slug"
                      value={editing.slug || ''}
                      onChange={(e) => setEditing({ ...editing, slug: e.target.value })}
                    />
                    <input
                      type="number"
                      className="p-2 border rounded"
                      placeholder="Порядок"
                      value={editing.order || 0}
                      onChange={(e) => setEditing({ ...editing, order: Number(e.target.value) || 0 })}
                    />
                  </div>
                  <div className="mb-2">
                    <select
                      className="p-2 border rounded w-full md:w-auto"
                      value={editing.filterType || 'ukrSkladGroup'}
                      onChange={(e) => {
                        const newType = e.target.value;
                        setEditing({ 
                          ...editing, 
                          filterType: newType,
                          // Очищаємо значення при зміні типу
                          selectedGroupIds: [],
                          selectedBrands: [],
                          selectedCategories: [],
                          filterValue: ""
                        });
                      }}
                    >
                      <option value="ukrSkladGroup">UkrSklad Group ID</option>
                      <option value="brand">Назва бренду</option>
                      <option value="category">Категорія товарів</option>
                    </select>
                  </div>
                  <div>
                    {editing.filterType === 'brand' && (
                      <MultiSelectCheckboxes
                        items={allBrands}
                        selected={editing.selectedBrands || []}
                        onChange={(brands) => setEditing({ ...editing, selectedBrands: brands })}
                        placeholder="Пошук брендів..."
                      />
                    )}
                    {editing.filterType === 'category' && (
                      <MultiSelectCheckboxes
                        items={allCategories}
                        selected={editing.selectedCategories || []}
                        onChange={(categories) => setEditing({ ...editing, selectedCategories: categories })}
                        placeholder="Пошук категорій..."
                      />
                    )}
                    {editing.filterType === 'ukrSkladGroup' && (
                      <UkrSkladGroupInput
                        values={editing.selectedGroupIds || []}
                        onChange={(ids) => setEditing({ ...editing, selectedGroupIds: ids })}
                      />
                    )}
                  </div>
                  <div className="flex gap-2">
                    <button className={primary} onClick={() => saveFolder(editing)} disabled={busy}>
                      Зберегти
                    </button>
                    <button className={secondary} onClick={() => setEditing(null)}>Скасувати</button>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="font-medium">{folder.name || folder.id}</span>
                      {folder.slug && <span className="text-sm text-slate-500 ml-2">Slug: {folder.slug}</span>}
                      <span className="text-sm text-slate-500 ml-2">Порядок: {folder.order || 0}</span>
                    </div>
                    <div className="flex gap-2">
                      <button className={secondary} onClick={() => {
                        const filterType = folder.filterType || 'ukrSkladGroup';
                        const selectedValues = getSelectedValues(filterType, folder);
                        setEditing({ 
                          id: folder.id, 
                          name: folder.name || '', 
                          slug: folder.slug || '', 
                          order: folder.order || 0,
                          filterType: filterType,
                          filterValue: folderFilterValue,
                          // Ініціалізуємо вибрані значення для нового інтерфейсу
                          selectedGroupIds: filterType === 'ukrSkladGroup' ? selectedValues : [],
                          selectedBrands: filterType === 'brand' ? selectedValues : [],
                          selectedCategories: filterType === 'category' ? selectedValues : []
                        });
                      }}>
                        Редагувати
                      </button>
                      <button className={danger} onClick={() => deleteFolder(folder.id)} disabled={busy}>
                        Видалити
                      </button>
                    </div>
                  </div>
                  <div className="text-sm text-slate-600">
                    <span className="font-medium">Тип фільтрації:</span> {
                      folderFilterType === 'ukrSkladGroup' ? 'UkrSklad Group ID' :
                      folderFilterType === 'brand' ? 'Назва бренду' :
                      folderFilterType === 'category' ? 'Категорія товарів' : 'Не вказано'
                    }
                    {(() => {
                      const selectedValues = getSelectedValues(folderFilterType, folder);
                      if (selectedValues.length > 0) {
                        // Сортуємо вибрані значення перед відображенням
                        const sortedValues = [...selectedValues].sort((a, b) => 
                          String(a).localeCompare(String(b), 'uk', { sensitivity: 'base' })
                        );
                        return (
                          <div className="mt-1">
                            <span className="font-medium">Вибрано ({selectedValues.length}):</span>
                            <div className="flex flex-wrap gap-1 mt-1">
                              {sortedValues.slice(0, 10).map((value, idx) => (
                                <span key={idx} className="px-2 py-1 bg-indigo-100 text-indigo-700 rounded text-xs">
                                  {value}
                                </span>
                              ))}
                              {selectedValues.length > 10 && (
                                <span className="px-2 py-1 bg-gray-100 text-gray-600 rounded text-xs">
                                  +{selectedValues.length - 10} ще
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      }
                      return null;
                    })()}
                  </div>
                </>
              )}
            </div>
          );
        })}
        {folders.length === 0 && (
          <div className="text-sm text-slate-500">Бренд-папки не додані. Додайте першу папку.</div>
        )}
      </div>
    </Section>
  );
}

/** ---------- 6) Backup ---------- */
function BackupSection({ setStatus }) {
  const [busy, setBusy] = useState(false);
  const [what, setWhat] = useState({
    clients: true,
    suppliers: true,
    pricingRules: true,
    products: false,
    orders: false,
  });

  const download = (name, obj) => {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const fetchCollection = async (path) => {
    const snap = await getDocs(collection(db, path));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  };

  const run = async () => {
    setBusy(true);
    try {
      const out = {};
      if (what.clients) out.clients = await fetchCollection(`/artifacts/${appId}/public/data/clients`);
      if (what.suppliers) out.suppliers = await fetchCollection(`/artifacts/${appId}/public/data/suppliers`);
      if (what.pricingRules) out.pricingRules = await fetchCollection(`/artifacts/${appId}/public/data/pricingRules`);
      if (what.products) out.products = await fetchCollection(`/artifacts/${appId}/public/data/products`); // ⚠︎ може бути велике
      if (what.orders) out.orders = await fetchCollection(`/artifacts/${appId}/public/data/orders`);
      download(`backup_${appId}.json`, out);
      setStatus?.({ type:"success", message:"Файл backup.json збережено" });
    } catch (e) {
      setStatus?.({ type:"error", message: e?.message || "Помилка бекапу" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Резервне копіювання">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {Object.entries(what).map(([k, v]) => (
          <label key={k} className="flex items-center gap-2">
            <input type="checkbox" checked={v} onChange={(e)=>setWhat(prev=>({...prev, [k]: e.target.checked}))} />
            <span className="capitalize">{k}</span>
          </label>
        ))}
      </div>
      <button className={`${secondary} mt-3 disabled:opacity-60`} disabled={busy} onClick={run}>
        Завантажити backup.json
      </button>
      <p className="text-xs text-slate-500 mt-2">Увага: «products» може бути великим — викоритовуй за потреби.</p>
    </Section>
  );
}

/** ---------- 6) Dangerous actions ---------- */
function DangerousActions({ setStatus }) {
  const [confirm, setConfirm] = useState(false);
  const [confirmSettlements, setConfirmSettlements] = useState(false);
  
  const run = async () => {
    if (!confirm) return;
    if (!confirm && !window.confirm("Дійсно видалити всі товари та приватні собівартості?")) return;
    try {
      const call = httpsCallable(functions, "deleteAllProducts");
      const { data } = await call();
      setStatus?.({ type: "success", message: data?.message || "Видалення виконано" });
    } catch (e) {
      setStatus?.({ type:"error", message: e?.message || "Помилка видалення" });
    }
  };

  const runDeleteSettlements = async () => {
    if (!confirmSettlements) return;
    if (!window.confirm("Дійсно видалити всі ledger-операції та баланси взаєморозрахунків? Дані будуть видалені безповоротно!")) return;
    try {
      const call = httpsCallable(functions, "deleteAllSettlements");
      const { data } = await call();
      setStatus?.({ 
        type: "success", 
        message: `Видалено: ${data?.deletedLedgers || 0} операцій, ${data?.deletedBalances || 0} балансів з ${data?.processedClients || 0} клієнтів` 
      });
    } catch (e) {
      setStatus?.({ type:"error", message: e?.message || "Помилка видалення" });
    }
  };

  return (
    <>
    <Section title="Небезпечні дії">
        <div className="mb-6">
      <label className="flex items-center gap-2 mb-3">
        <input type="checkbox" checked={confirm} onChange={e=>setConfirm(e.target.checked)} />
        <span>Я розумію наслідки і хочу видалити всі товари (включно з приватними собівартостями)</span>
      </label>
      <button className={`${danger} disabled:opacity-60`} disabled={!confirm} onClick={run}>
        Видалити всі товари
      </button>
        </div>

        <div className="border-t pt-6">
          <label className="flex items-center gap-2 mb-3">
            <input type="checkbox" checked={confirmSettlements} onChange={e=>setConfirmSettlements(e.target.checked)} />
            <span>Я розумію наслідки і хочу видалити всі ledger-операції та баланси взаєморозрахунків</span>
          </label>
          <p className="text-xs text-slate-500 mb-3">
            Видаляє всі операції з ledger-UAH, ledger-EUR та баланси з колекції balances для всіх клієнтів. 
            Дані будуть автоматично відновлені під час наступної синхронізації (13:00 або 18:00 у будні).
          </p>
          <button className={`${danger} disabled:opacity-60`} disabled={!confirmSettlements} onClick={runDeleteSettlements}>
            Видалити всі взаєморозрахунки
          </button>
        </div>
    </Section>
    </>
  );
}

/** ---------- DataPage (router) ---------- */
export default function DataPage() {
  const [tab, setTab] = useState("clients");
  const [status, setStatus] = useState(null);

  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(null), 3000);
    return () => clearTimeout(t);
  }, [status]);

  const items = [
    { key: "clients",    label: "Імпорт клієнтів",  node: <ImportClients setStatus={setStatus} /> },
    { key: "brands",     label: "Бренди",           node: <BrandTools setStatus={setStatus} /> },
    { key: "categories", label: "Категорії",        node: <CategoriesManagement setStatus={setStatus} /> },
    { key: "brandFolders", label: "Бренд-папки",    node: <BrandFoldersManagement setStatus={setStatus} /> },
    { key: "masterData", label: "Майстер-дані",     node: <ImportProductMasterData setStatus={setStatus} /> },
    { key: "backup",     label: "Резервне копіювання", node: <BackupSection setStatus={setStatus} /> },
    { key: "danger",     label: "Небезпечні дії",   node: <DangerousActions setStatus={setStatus} /> },
  ];

  const current = items.find(i => i.key === tab) || items[0];

  return (
    <div>
      <Tabs value={tab} onChange={setTab} items={items} />

      {status && (
        <div
          className={`mb-4 p-2 rounded ${
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

      {current.node}
    </div>
  );
}
