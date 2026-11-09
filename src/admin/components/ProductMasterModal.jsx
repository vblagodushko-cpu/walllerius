import React, { useCallback, useEffect, useMemo, useState } from "react";
import { collection, doc, getDoc, getDocs, setDoc, serverTimestamp, deleteField } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../../firebase-config";
import {
  uploadProductImages,
  deleteProductImagesAtPaths,
} from "../../utils/productImageStorage";
import {
  validateProductImageFile,
  coerceProductImageFile,
  getImageFileFromClipboard,
} from "../../utils/productImage";
import {
  TOLERANCE_FILTER_PROFILES,
  TOLERANCE_SYSTEMS,
  buildToleranceTag,
  formatToleranceTags,
  normalizeToleranceTagsInput,
} from "../../utils/tolerances.js";
import {
  VISCOSITY_SYSTEMS,
  buildViscosityTag,
  formatViscosityTags,
  normalizeViscosityTagsInput,
  VISCOSITY_FILTER_PROFILES,
} from "../../utils/viscosities.js";

const appId = import.meta.env.VITE_PROJECT_ID;
const MAX_PRODUCT_DETAIL_BODY = 80000;
const MASTER_FIELD_OPTIONS = [
  { key: "correctName", label: "Правильна назва" },
  { key: "categories", label: "Категорії" },
  { key: "pack", label: "Фасування" },
  { key: "tolerances", label: "Допуски" },
  { key: "viscosities", label: "В'язкість" },
  { key: "synonyms", label: "Синоніми" },
];
const AI_SUGGEST_FIELD_LABELS = {
  correctName: "Правильна назва",
  categories: "Категорії",
  pack: "Фасування",
  tolerances: "Допуски",
  viscosities: "В'язкість",
  synonyms: "Синоніми",
  detailBody: "Детальний опис",
};

function splitTextList(value) {
  return String(value || "")
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinTextList(value) {
  return Array.isArray(value) ? value.join("\n") : "";
}

function getMissingMasterFields(data) {
  return MASTER_FIELD_OPTIONS.map((f) => f.key).filter((field) => {
    if (field === "correctName") return !String(data.correctName || data.name || "").trim();
    if (field === "categories") return !Array.isArray(data.categories) || data.categories.length === 0;
    if (field === "pack") return !String(data.pack || "").trim();
    if (field === "tolerances") return !String(data.tolerances || "").trim();
    if (field === "viscosities") return !String(data.viscosities || "").trim();
    if (field === "synonyms") return !Array.isArray(data.synonyms) || data.synonyms.length === 0;
    return false;
  });
}

function buildAiFieldSelection(targetFields = []) {
  return Object.fromEntries(targetFields.map((field) => [field, true]));
}

/**
 * Та сама модалка master-даних, що в розділі «Товари».
 * product: { docId, brand, id, name, categories?, pack?, ... }
 */
export default function ProductMasterModal({ product, onClose, onSaved, onStatus }) {
  const notify = (type, text) => onStatus?.({ type, text, message: text });

  const [masterForm, setMasterForm] = useState({
    correctName: "",
    categories: [],
    pack: "",
    tolerances: "",
    toleranceTagsText: "",
    viscosities: "",
    viscosityTagsText: "",
    synonymsText: "",
  });
  const [loadingMasterData, setLoadingMasterData] = useState(true);
  const [savingMasterData, setSavingMasterData] = useState(false);
  const [deletingMasterData, setDeletingMasterData] = useState(false);
  const [aiSuggesting, setAiSuggesting] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState(null);
  const [aiSelectedFields, setAiSelectedFields] = useState({});
  const [detailBody, setDetailBody] = useState("");
  const [detailImageUrl, setDetailImageUrl] = useState("");
  const [detailImageStoragePath, setDetailImageStoragePath] = useState("");
  const [detailImageThumbStoragePath, setDetailImageThumbStoragePath] = useState("");
  const [pendingImagePreview, setPendingImagePreview] = useState("");
  const [pendingImageFile, setPendingImageFile] = useState(null);
  const [removeDetailImage, setRemoveDetailImage] = useState(false);
  const [toleranceSearch, setToleranceSearch] = useState("");
  const [viscositySearch, setViscositySearch] = useState("");
  const [masterModalTab, setMasterModalTab] = useState("main");
  const [categoriesList, setCategoriesList] = useState([]);

  const busy = savingMasterData || deletingMasterData;

  const clearDetailImageDraft = useCallback(() => {
    setPendingImageFile(null);
    setRemoveDetailImage(false);
    setPendingImagePreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return "";
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDocs(collection(db, `/artifacts/${appId}/public/meta/categories`));
        if (cancelled) return;
        setCategoriesList(
          snap.docs
            .map((d) => ({ id: d.id, ...d.data(), name: d.data().name || d.id }))
            .sort(
              (a, b) =>
                (a.order || 0) - (b.order || 0) ||
                String(a.name || "").localeCompare(String(b.name || ""), "uk")
            )
        );
      } catch (e) {
        console.error("Помилка завантаження категорій", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!product?.docId) return;
    let cancelled = false;
    setLoadingMasterData(true);
    setAiSuggestion(null);
    setAiSelectedFields({});
    setMasterModalTab("main");
    clearDetailImageDraft();
    setMasterForm({
      correctName: product.name || "",
      categories: Array.isArray(product.categories) ? product.categories : [],
      pack: product.pack || "",
      tolerances: product.tolerances || "",
      toleranceTagsText: formatToleranceTags(product.toleranceTags),
      viscosities: product.viscosities || "",
      viscosityTagsText: formatViscosityTags(product.viscosityTags),
      synonymsText: joinTextList(product.synonyms),
    });

    (async () => {
      const detailRef = doc(db, `/artifacts/${appId}/public/data/products/${product.docId}/details/main`);
      try {
        const call = httpsCallable(functions, "peekProductMasterData");
        const [peekResponse, detailSnap] = await Promise.all([
          call({ brand: product.brand, id: product.id }),
          getDoc(detailRef).catch(() => null),
        ]);
        if (cancelled) return;
        const { data } = peekResponse;
        if (data?.exists && data?.data) {
          const md = data.data;
          setMasterForm({
            correctName: md.correctName || product.name || "",
            categories: Array.isArray(md.categories) ? md.categories : [],
            pack: md.pack || "",
            tolerances: md.tolerances || "",
            toleranceTagsText: formatToleranceTags(md.toleranceTags || product.toleranceTags),
            viscosities: md.viscosities || "",
            viscosityTagsText: formatViscosityTags(md.viscosityTags || product.viscosityTags),
            synonymsText: joinTextList(md.synonyms),
          });
        }
        if (detailSnap?.exists()) {
          const d = detailSnap.data() || {};
          const raw = String(d.body ?? "");
          setDetailBody(raw.length > MAX_PRODUCT_DETAIL_BODY ? raw.slice(0, MAX_PRODUCT_DETAIL_BODY) : raw);
          setDetailImageUrl(String(d.imageUrl ?? ""));
          setDetailImageStoragePath(String(d.imageStoragePath ?? ""));
          setDetailImageThumbStoragePath(String(d.imageThumbStoragePath ?? ""));
        } else {
          setDetailBody("");
          setDetailImageUrl("");
          setDetailImageStoragePath("");
          setDetailImageThumbStoragePath("");
        }
      } catch (e) {
        console.error("Помилка завантаження master-даних", e);
        if (!cancelled) notify("error", e?.message || "Не вдалося завантажити master-дані");
      } finally {
        if (!cancelled) setLoadingMasterData(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.docId, product?.brand, product?.id, clearDetailImageDraft]);

  const masterCategoryOptions = useMemo(() => {
    const map = new Map();
    categoriesList.forEach((cat) => {
      const name = cat.name || cat.id;
      if (name) map.set(name, { id: cat.id || name, name });
    });
    masterForm.categories.forEach((name) => {
      if (name && !map.has(name)) map.set(name, { id: name, name });
    });
    return Array.from(map.values()).sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || ""), "uk")
    );
  }, [categoriesList, masterForm.categories]);

  const handleSuggestAi = useCallback(async () => {
    if (!product) return;
    setAiSuggesting(true);
    setAiSuggestion(null);
    setAiSelectedFields({});
    try {
      const missingFields = getMissingMasterFields({
        ...product,
        correctName: masterForm.correctName,
        categories: masterForm.categories,
        pack: masterForm.pack,
        tolerances: masterForm.tolerances,
        viscosities: masterForm.viscosities,
        synonyms: splitTextList(masterForm.synonymsText),
      });
      const call = httpsCallable(functions, "suggestProductEnrichment");
      const { data } = await call({
        productDocId: product.docId,
        brand: product.brand,
        id: product.id,
        missingFields,
        includeDetailBody: !detailBody.trim(),
      });
      const targetFields = Array.isArray(data?.targetFields) ? data.targetFields : [];
      setAiSuggestion(data || null);
      setAiSelectedFields(buildAiFieldSelection(targetFields));
      if (!targetFields.length) notify("success", data?.notes || "Усі обрані поля вже заповнені.");
    } catch (e) {
      console.error("Помилка AI-пропозиції", e);
      notify("error", e?.message || "Не вдалося отримати AI-пропозицію");
    } finally {
      setAiSuggesting(false);
    }
  }, [product, masterForm, detailBody]);

  const applyAiSuggestion = useCallback(
    (fieldsToApply) => {
      if (!aiSuggestion?.suggestion) return;
      const suggestion = aiSuggestion.suggestion;
      if (fieldsToApply.correctName && suggestion.correctName) {
        setMasterForm((prev) => ({
          ...prev,
          correctName: prev.correctName.trim() ? prev.correctName : suggestion.correctName,
        }));
      }
      if (fieldsToApply.categories && Array.isArray(suggestion.categories) && suggestion.categories.length) {
        setMasterForm((prev) => ({
          ...prev,
          categories: prev.categories.length ? prev.categories : suggestion.categories,
        }));
      }
      if (fieldsToApply.pack && suggestion.pack) {
        setMasterForm((prev) => ({ ...prev, pack: prev.pack.trim() ? prev.pack : suggestion.pack }));
      }
      if (fieldsToApply.tolerances && suggestion.tolerances) {
        setMasterForm((prev) => ({
          ...prev,
          tolerances: prev.tolerances.trim() ? prev.tolerances : suggestion.tolerances,
          toleranceTagsText: prev.toleranceTagsText.trim()
            ? prev.toleranceTagsText
            : formatToleranceTags(suggestion.toleranceTags),
        }));
      }
      if (fieldsToApply.viscosities && suggestion.viscosities) {
        setMasterForm((prev) => ({
          ...prev,
          viscosities: prev.viscosities.trim() ? prev.viscosities : suggestion.viscosities,
          viscosityTagsText: prev.viscosityTagsText.trim()
            ? prev.viscosityTagsText
            : formatViscosityTags(suggestion.viscosityTags),
        }));
      }
      if (fieldsToApply.synonyms && Array.isArray(suggestion.synonyms) && suggestion.synonyms.length) {
        setMasterForm((prev) => ({
          ...prev,
          synonymsText: splitTextList(prev.synonymsText).length ? prev.synonymsText : joinTextList(suggestion.synonyms),
        }));
      }
      if (fieldsToApply.detailBody && suggestion.detailBody && !detailBody.trim()) {
        setDetailBody(suggestion.detailBody);
      }
      if (
        (fieldsToApply.tolerances && suggestion.tolerances) ||
        (fieldsToApply.viscosities && suggestion.viscosities)
      ) {
        setMasterModalTab("specs");
      }
      notify("success", "AI-пропозицію застосовано до форми. Перевірте та натисніть «Зберегти».");
      setAiSuggestion(null);
      setAiSelectedFields({});
    },
    [aiSuggestion, detailBody]
  );

  const applyDetailImageFile = useCallback((file) => {
    if (!file) return;
    const coerced = coerceProductImageFile(file);
    const err = validateProductImageFile(coerced);
    if (err) {
      notify("error", err);
      return;
    }
    setPendingImageFile(coerced);
    setRemoveDetailImage(false);
    setPendingImagePreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(coerced);
    });
  }, []);

  const selectedToleranceTags = useMemo(
    () => normalizeToleranceTagsInput(masterForm.toleranceTagsText),
    [masterForm.toleranceTagsText]
  );
  const selectedToleranceTagSet = useMemo(() => new Set(selectedToleranceTags), [selectedToleranceTags]);
  const selectedViscosityTags = useMemo(
    () => normalizeViscosityTagsInput(masterForm.viscosityTagsText),
    [masterForm.viscosityTagsText]
  );
  const selectedViscosityTagSet = useMemo(() => new Set(selectedViscosityTags), [selectedViscosityTags]);
  const specsTagsCount = selectedToleranceTags.length + selectedViscosityTags.length;

  const visibleToleranceSystems = useMemo(() => {
    const preferred = [];
    masterForm.categories.forEach((category) => {
      const profile = TOLERANCE_FILTER_PROFILES[category];
      if (Array.isArray(profile)) preferred.push(...profile);
    });
    const q = toleranceSearch.trim().toUpperCase();
    return [...new Set([...preferred, ...Object.keys(TOLERANCE_SYSTEMS)])]
      .filter((system) => TOLERANCE_SYSTEMS[system])
      .map((system) => {
        const cfg = TOLERANCE_SYSTEMS[system];
        const options = cfg.options
          .map((code) => ({ code, tag: buildToleranceTag(system, code) }))
          .filter(
            ({ code, tag }) =>
              !q ||
              system.includes(q) ||
              String(cfg.label || "").toUpperCase().includes(q) ||
              code.toUpperCase().includes(q) ||
              tag.includes(q)
          );
        return { system, ...cfg, options };
      })
      .filter((cfg) => cfg.options.length > 0);
  }, [toleranceSearch, masterForm.categories]);

  const visibleViscositySystems = useMemo(() => {
    const preferred = [];
    masterForm.categories.forEach((category) => {
      const profile = VISCOSITY_FILTER_PROFILES[category];
      if (Array.isArray(profile)) preferred.push(...profile);
    });
    const q = viscositySearch.trim().toUpperCase();
    return [...new Set([...preferred, ...Object.keys(VISCOSITY_SYSTEMS)])]
      .filter((system) => VISCOSITY_SYSTEMS[system])
      .map((system) => {
        const cfg = VISCOSITY_SYSTEMS[system];
        const options = cfg.options
          .map((code) => ({ code, tag: buildViscosityTag(system, code) }))
          .filter(
            ({ code, tag }) =>
              !q ||
              system.includes(q) ||
              String(cfg.label || "").toUpperCase().includes(q) ||
              code.toUpperCase().includes(q) ||
              tag.includes(q)
          );
        return { system, ...cfg, options };
      })
      .filter((cfg) => cfg.options.length > 0);
  }, [viscositySearch, masterForm.categories]);

  const toggleToleranceTag = (tag) => {
    setMasterForm((prev) => {
      const next = new Set(normalizeToleranceTagsInput(prev.toleranceTagsText));
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return { ...prev, toleranceTagsText: formatToleranceTags(Array.from(next)) };
    });
  };
  const toggleViscosityTag = (tag) => {
    setMasterForm((prev) => {
      const next = new Set(normalizeViscosityTagsInput(prev.viscosityTagsText));
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return { ...prev, viscosityTagsText: formatViscosityTags(Array.from(next)) };
    });
  };

  const handleSave = async () => {
    if (!product) return;
    setSavingMasterData(true);
    try {
      const call = httpsCallable(functions, "updateProductMasterData");
      const { data } = await call({
        productDocId: product.docId,
        brand: product.brand,
        id: product.id,
        correctName: masterForm.correctName,
        categories: masterForm.categories,
        pack: masterForm.pack,
        tolerances: masterForm.tolerances,
        toleranceTags: normalizeToleranceTagsInput(masterForm.toleranceTagsText),
        viscosities: masterForm.viscosities,
        viscosityTags: normalizeViscosityTagsInput(masterForm.viscosityTagsText),
        synonyms: splitTextList(masterForm.synonymsText),
      });
      const productPatch = data?.productPatch || {
        name: masterForm.correctName,
        categories: masterForm.categories,
        pack: masterForm.pack,
        tolerances: masterForm.tolerances,
        toleranceTags: normalizeToleranceTagsInput(masterForm.toleranceTagsText),
        viscosities: masterForm.viscosities,
        viscosityTags: normalizeViscosityTagsInput(masterForm.viscosityTagsText),
        synonyms: splitTextList(masterForm.synonymsText),
      };

      const detailRef = doc(db, `/artifacts/${appId}/public/data/products/${product.docId}/details/main`);
      const bodyTrim =
        detailBody.length > MAX_PRODUCT_DETAIL_BODY ? detailBody.slice(0, MAX_PRODUCT_DETAIL_BODY) : detailBody;
      let imagePayload = {};
      try {
        if (removeDetailImage && (detailImageStoragePath || detailImageThumbStoragePath)) {
          await deleteProductImagesAtPaths(detailImageStoragePath, detailImageThumbStoragePath);
          imagePayload = {
            imageUrl: deleteField(),
            imageThumbUrl: deleteField(),
            imageStoragePath: deleteField(),
            imageThumbStoragePath: deleteField(),
          };
        } else if (pendingImageFile) {
          const uploaded = await uploadProductImages(appId, product.docId, pendingImageFile);
          if (detailImageStoragePath || detailImageThumbStoragePath) {
            await deleteProductImagesAtPaths(detailImageStoragePath, detailImageThumbStoragePath);
          }
          imagePayload = uploaded;
        }
      } catch (imageErr) {
        console.error("Помилка завантаження фото", imageErr);
        notify("error", imageErr?.message || "Master-дані збережено, але фото не вдалося завантажити.");
        onSaved?.(product.docId, productPatch);
        onClose?.();
        return;
      }
      try {
        await setDoc(detailRef, { body: bodyTrim, ...imagePayload, updatedAt: serverTimestamp() }, { merge: true });
      } catch (detailErr) {
        console.error("Помилка збереження опису", detailErr);
        notify("error", detailErr?.message || "Master-дані збережено, але опис не вдалося записати.");
        onSaved?.(product.docId, productPatch);
        onClose?.();
        return;
      }
      notify("success", "Master-дані та опис товару збережено");
      onSaved?.(product.docId, productPatch);
      onClose?.();
    } catch (e) {
      console.error("Помилка збереження master-даних", e);
      notify("error", e?.message || "Не вдалося зберегти master-дані");
    } finally {
      setSavingMasterData(false);
    }
  };

  const handleDelete = async () => {
    if (!product) return;
    if (
      !window.confirm(
        `Видалити master-дані для ${product.brand} ${product.id}?\nСам товар у каталозі не буде змінено.`
      )
    ) {
      return;
    }
    setDeletingMasterData(true);
    try {
      const call = httpsCallable(functions, "deleteProductMasterData");
      await call({ productDocId: product.docId, brand: product.brand, id: product.id });
      notify("success", "Master-дані товару видалено. Сам товар не змінювався.");
      onClose?.();
    } catch (e) {
      console.error("Помилка видалення master-даних", e);
      notify("error", e?.message || "Не вдалося видалити master-дані");
    } finally {
      setDeletingMasterData(false);
    }
  };

  if (!product) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={busy ? undefined : onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-[min(720px,96vw)] max-h-[90vh] overflow-auto">
        <div className="px-5 py-3 border-b flex items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold">Редагування товару</h3>
            <p className="text-xs text-slate-500">Brand та id не змінюються, щоб не ламати ідентифікацію товару.</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              className="px-3 py-1.5 rounded-lg bg-violet-50 hover:bg-violet-100 text-violet-800 text-sm border border-violet-200 disabled:opacity-60"
              onClick={handleSuggestAi}
              disabled={loadingMasterData || busy || aiSuggesting}
            >
              {aiSuggesting ? "AI думає…" : "✨ Запропонувати AI"}
            </button>
            <button
              className="px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-sm disabled:opacity-60"
              onClick={onClose}
              disabled={busy}
            >
              Закрити
            </button>
          </div>
        </div>

        <div className="p-5 space-y-4 text-sm">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-600 mb-1">Бренд</label>
              <input className="w-full px-3 py-2 border rounded-lg bg-slate-50 text-slate-600" value={product.brand} readOnly />
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1">Артикул / id</label>
              <input className="w-full px-3 py-2 border rounded-lg bg-slate-50 text-slate-600" value={product.id} readOnly />
            </div>
          </div>

          {aiSuggestion?.targetFields?.length > 0 && (
            <div className="rounded-xl border border-violet-200 bg-violet-50/70 p-4 space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h4 className="text-sm font-semibold text-violet-900">AI-пропозиція</h4>
                  <p className="text-xs text-violet-700 mt-0.5">
                    Перевірте дані перед збереженням. Модель: {aiSuggestion.model || "Gemini"}
                    {aiSuggestion.tokensUsed ? ` · ~${aiSuggestion.tokensUsed} tok` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  className="text-xs text-violet-700 hover:text-violet-900 underline"
                  onClick={() => {
                    setAiSuggestion(null);
                    setAiSelectedFields({});
                  }}
                >
                  Відхилити
                </button>
              </div>
              {aiSuggestion.notes ? (
                <p className="text-xs text-violet-800 bg-white/70 rounded-lg px-3 py-2 border border-violet-100">{aiSuggestion.notes}</p>
              ) : null}
              <div className="space-y-2">
                {aiSuggestion.targetFields.map((field) => {
                  const proposed = aiSuggestion.suggestion?.[field];
                  const current =
                    field === "detailBody"
                      ? detailBody
                      : field === "categories"
                        ? masterForm.categories.join(", ")
                        : field === "synonyms"
                          ? masterForm.synonymsText
                          : masterForm[field] ?? "";
                  const proposedText = Array.isArray(proposed) ? proposed.join(", ") : String(proposed ?? "");
                  if (!proposedText.trim()) return null;
                  const confidence = aiSuggestion.confidence?.[field];
                  return (
                    <label key={field} className="flex gap-3 rounded-lg border border-violet-100 bg-white px-3 py-2 text-xs">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={Boolean(aiSelectedFields[field])}
                        onChange={() => setAiSelectedFields((prev) => ({ ...prev, [field]: !prev[field] }))}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-slate-800">
                          {AI_SUGGEST_FIELD_LABELS[field] || field}
                          {confidence != null && (
                            <span className="ml-2 text-slate-500">({Math.round(confidence * 100)}%)</span>
                          )}
                        </div>
                        <div className="text-slate-500 mt-1">Зараз: {String(current || "—").slice(0, 120) || "—"}</div>
                        <div className="text-violet-900 mt-1 whitespace-pre-wrap break-words">Пропозиція: {proposedText}</div>
                      </div>
                    </label>
                  );
                })}
              </div>
              <div className="flex flex-wrap justify-end gap-2 pt-1">
                <button
                  type="button"
                  className="px-3 py-1.5 rounded-lg bg-white hover:bg-violet-100 text-violet-800 text-sm border border-violet-200"
                  onClick={() => {
                    const selected = Object.fromEntries(Object.entries(aiSelectedFields).filter(([, c]) => c));
                    if (!Object.keys(selected).length) {
                      notify("error", "Оберіть хоча б одне поле для застосування.");
                      return;
                    }
                    applyAiSuggestion(selected);
                  }}
                >
                  Застосувати вибране
                </button>
                <button
                  type="button"
                  className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm"
                  onClick={() => applyAiSuggestion(aiSelectedFields)}
                >
                  Застосувати все
                </button>
              </div>
            </div>
          )}

          {!loadingMasterData && (
            <div className="flex gap-1 border-b border-slate-200">
              <button
                type="button"
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
                  masterModalTab === "main" ? "border-emerald-600 text-emerald-700" : "border-transparent text-slate-500"
                }`}
                onClick={() => setMasterModalTab("main")}
              >
                Основне
              </button>
              <button
                type="button"
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
                  masterModalTab === "specs" ? "border-emerald-600 text-emerald-700" : "border-transparent text-slate-500"
                }`}
                onClick={() => setMasterModalTab("specs")}
              >
                Характеристики
                {specsTagsCount > 0 && (
                  <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs font-normal text-slate-600">
                    {specsTagsCount}
                  </span>
                )}
              </button>
            </div>
          )}

          {loadingMasterData ? (
            <div className="py-8 text-center text-slate-500">Завантаження master-даних...</div>
          ) : masterModalTab === "main" ? (
            <>
              <div>
                <label className="block text-xs text-slate-600 mb-1">Правильна назва</label>
                <textarea
                  className="w-full px-3 py-2 border rounded-lg min-h-[76px]"
                  value={masterForm.correctName}
                  onChange={(e) => setMasterForm((prev) => ({ ...prev, correctName: e.target.value }))}
                />
              </div>
              <div>
                <label className="block text-xs text-slate-600 mb-2">Категорії</label>
                <div className="max-h-48 overflow-auto border rounded-lg p-2 grid grid-cols-1 sm:grid-cols-2 gap-1">
                  {masterCategoryOptions.map((category) => {
                    const name = category.name || category.id;
                    const checked = masterForm.categories.includes(name);
                    return (
                      <label key={category.id} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-50">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) =>
                            setMasterForm((prev) => ({
                              ...prev,
                              categories: e.target.checked
                                ? [...prev.categories, name]
                                : prev.categories.filter((item) => item !== name),
                            }))
                          }
                        />
                        <span>{name}</span>
                      </label>
                    );
                  })}
                  {masterCategoryOptions.length === 0 && (
                    <div className="text-slate-500 px-2 py-1">Категорії ще не налаштовані в довіднику.</div>
                  )}
                </div>
              </div>
              <div>
                <label className="block text-xs text-slate-600 mb-1">Фасування / pack</label>
                <input
                  className="w-full px-3 py-2 border rounded-lg"
                  value={masterForm.pack}
                  onChange={(e) => setMasterForm((prev) => ({ ...prev, pack: e.target.value }))}
                />
              </div>
              <div>
                <label className="block text-xs text-slate-600 mb-1">Синоніми артикулу</label>
                <textarea
                  className="w-full px-3 py-2 border rounded-lg min-h-[120px] font-mono text-xs"
                  value={masterForm.synonymsText}
                  onChange={(e) => setMasterForm((prev) => ({ ...prev, synonymsText: e.target.value }))}
                />
              </div>
              <div className="border-t border-slate-200 pt-4">
                <label className="block text-xs text-slate-600 mb-1">Фото для порталу</label>
                <div
                  role="button"
                  tabIndex={0}
                  onPaste={(e) => {
                    const file = getImageFileFromClipboard(e.clipboardData);
                    if (!file) return;
                    e.preventDefault();
                    applyDetailImageFile(file);
                  }}
                  className="mb-3 rounded-lg border-2 border-dashed border-slate-200 bg-slate-50/80 p-3"
                >
                  <p className="text-xs text-slate-500 text-center">Зона вставки: клік → Ctrl+V</p>
                </div>
                {(pendingImagePreview || detailImageUrl) && !removeDetailImage ? (
                  <div className="mb-3 flex flex-col sm:flex-row gap-3 items-start">
                    <img src={pendingImagePreview || detailImageUrl} alt="" className="max-h-40 max-w-full rounded-lg border object-contain bg-slate-50" />
                    <button
                      type="button"
                      className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-sm"
                      onClick={() => {
                        clearDetailImageDraft();
                        setRemoveDetailImage(true);
                        setDetailImageUrl("");
                      }}
                      disabled={savingMasterData}
                    >
                      Прибрати фото
                    </button>
                  </div>
                ) : (
                  <p className="text-xs text-slate-400 mb-2">Фото ще не додано.</p>
                )}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={(e) => {
                    applyDetailImageFile(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                  disabled={busy}
                  className="block w-full text-sm text-slate-600 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-indigo-50 file:text-indigo-700"
                />
              </div>
              <div className="border-t border-slate-200 pt-4">
                <label className="block text-xs text-slate-600 mb-1">Детальний опис для порталу</label>
                <textarea
                  className="w-full px-3 py-2 border rounded-lg min-h-[140px] font-mono text-xs"
                  value={detailBody}
                  onChange={(e) => setDetailBody(e.target.value)}
                  maxLength={MAX_PRODUCT_DETAIL_BODY}
                />
              </div>
              <div className="border-t pt-4">
                <h4 className="text-sm font-semibold text-rose-700">Видалити master-дані</h4>
                <p className="text-xs text-slate-500 mt-1">
                  Видаляється тільки запис у productMasterData. Сам товар у каталозі не змінюється.
                </p>
                <button
                  className="mt-3 px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-sm disabled:opacity-60"
                  onClick={handleDelete}
                  disabled={busy}
                >
                  {deletingMasterData ? "Видалення..." : "Видалити master-дані"}
                </button>
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="block text-xs text-slate-600 mb-1">Допуски / tolerances</label>
                <textarea
                  className="w-full px-3 py-2 border rounded-lg min-h-[76px] text-sm"
                  value={masterForm.tolerances}
                  onChange={(e) => setMasterForm((prev) => ({ ...prev, tolerances: e.target.value }))}
                />
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <input
                  className="w-full sm:w-64 px-3 py-2 border rounded-lg bg-white text-sm mb-3"
                  value={toleranceSearch}
                  onChange={(e) => setToleranceSearch(e.target.value)}
                  placeholder="Пошук: C3, 229.52, VW..."
                />
                <div className="max-h-72 overflow-auto space-y-3 pr-1">
                  {visibleToleranceSystems.map((cfg) => (
                    <div key={cfg.system} className="rounded-lg border bg-white p-2">
                      <div className="mb-2 text-xs font-semibold text-slate-700">{cfg.label || cfg.system}</div>
                      <div className="flex flex-wrap gap-1.5">
                        {cfg.options.map(({ code, tag }) => {
                          const checked = selectedToleranceTagSet.has(tag);
                          return (
                            <label
                              key={tag}
                              className={`flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs cursor-pointer ${
                                checked ? "border-indigo-200 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-slate-50"
                              }`}
                            >
                              <input type="checkbox" className="h-3 w-3" checked={checked} onChange={() => toggleToleranceTag(tag)} />
                              <span>{code}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
                <textarea
                  className="mt-3 w-full px-3 py-2 border rounded-lg min-h-[70px] font-mono text-xs bg-white"
                  value={masterForm.toleranceTagsText}
                  onChange={(e) => setMasterForm((prev) => ({ ...prev, toleranceTagsText: e.target.value }))}
                  onBlur={() =>
                    setMasterForm((prev) => ({
                      ...prev,
                      toleranceTagsText: formatToleranceTags(normalizeToleranceTagsInput(prev.toleranceTagsText)),
                    }))
                  }
                />
              </div>
              <div className="border-t border-slate-200 pt-4">
                <label className="block text-xs text-slate-600 mb-1">В'язкість / viscosities</label>
                <textarea
                  className="w-full px-3 py-2 border rounded-lg min-h-[76px] text-sm"
                  value={masterForm.viscosities}
                  onChange={(e) => setMasterForm((prev) => ({ ...prev, viscosities: e.target.value }))}
                />
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <input
                  className="w-full sm:w-64 px-3 py-2 border rounded-lg bg-white text-sm mb-3"
                  value={viscositySearch}
                  onChange={(e) => setViscositySearch(e.target.value)}
                  placeholder="Пошук: 5W-30, 46, SAE..."
                />
                <div className="max-h-72 overflow-auto space-y-3 pr-1">
                  {visibleViscositySystems.map((cfg) => (
                    <div key={cfg.system} className="rounded-lg border bg-white p-2">
                      <div className="mb-2 text-xs font-semibold text-slate-700">{cfg.label || cfg.system}</div>
                      <div className="flex flex-wrap gap-1.5">
                        {cfg.options.map(({ code, tag }) => {
                          const checked = selectedViscosityTagSet.has(tag);
                          return (
                            <label
                              key={tag}
                              className={`flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs cursor-pointer ${
                                checked ? "border-teal-200 bg-teal-50 text-teal-700" : "border-slate-200 bg-slate-50"
                              }`}
                            >
                              <input type="checkbox" className="h-3 w-3" checked={checked} onChange={() => toggleViscosityTag(tag)} />
                              <span>{code}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
                <textarea
                  className="mt-3 w-full px-3 py-2 border rounded-lg min-h-[70px] font-mono text-xs bg-white"
                  value={masterForm.viscosityTagsText}
                  onChange={(e) => setMasterForm((prev) => ({ ...prev, viscosityTagsText: e.target.value }))}
                  onBlur={() =>
                    setMasterForm((prev) => ({
                      ...prev,
                      viscosityTagsText: formatViscosityTags(normalizeViscosityTagsInput(prev.viscosityTagsText)),
                    }))
                  }
                />
              </div>
            </>
          )}

          <div className="pt-2 flex justify-end gap-2">
            <button className="px-4 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-sm disabled:opacity-60" onClick={onClose} disabled={busy}>
              Скасувати
            </button>
            <button
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm disabled:opacity-60"
              onClick={handleSave}
              disabled={loadingMasterData || busy}
            >
              {savingMasterData ? "Збереження..." : "Зберегти"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
