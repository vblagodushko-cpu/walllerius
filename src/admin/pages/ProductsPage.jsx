import React, { useCallback, useEffect, useMemo, useState, useRef } from "react";
import {
  collection,
  getDocs,
  query,
  orderBy,
  where,
  limit,
  doc,
  getDoc,
  addDoc,
  serverTimestamp,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../../firebase-config";
import Tabs from "../components/Tabs.jsx";
import { useClientSearch } from "../hooks/useClientSearch.js";

const appId = import.meta.env.VITE_PROJECT_ID;
if (!appId) {
  console.error("VITE_PROJECT_ID environment variable is required");
}
/** Тип ціни «вхідна» — оцінка як у PurchasesPage: роздріб × коефіцієнт */
const PRICE_TYPE_INCOMING = "вхідна";
const INCOMING_FROM_RETAIL_COEF = 0.66667;
const MASTER_MONITOR_PAGE_SIZE = 100;
const MASTER_FIELD_OPTIONS = [
  { key: "masterExists", label: "Master-картка існує" },
  { key: "correctName", label: "Правильна назва" },
  { key: "categories", label: "Категорії" },
  { key: "pack", label: "Фасування" },
  { key: "tolerances", label: "Допуски" },
  { key: "synonyms", label: "Синоніми" },
];
const MASTER_FIELD_LABELS = Object.fromEntries(
  MASTER_FIELD_OPTIONS.map((field) => [field.key, field.label])
);

function splitTextList(value) {
  return String(value || "")
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinTextList(value) {
  return Array.isArray(value) ? value.join("\n") : "";
}

function estimateIncomingFromRetail(publicPrices) {
  if (!publicPrices || typeof publicPrices !== "object") return null;
  const retail = Number(publicPrices["роздріб"]) || 0;
  if (retail <= 0) return null;
  return Math.round(retail * INCOMING_FROM_RETAIL_COEF * 100) / 100;
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("uk-UA", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getMissingMasterFields(data, selectedFields) {
  return selectedFields.filter((field) => {
    if (field === "masterExists") return data.masterExists === false;
    if (field === "correctName") return !String(data.correctName || data.name || "").trim();
    if (field === "categories") return !Array.isArray(data.categories) || data.categories.length === 0;
    if (field === "pack") return !String(data.pack || "").trim();
    if (field === "tolerances") return !String(data.tolerances || "").trim();
    if (field === "synonyms") return !Array.isArray(data.synonyms) || data.synonyms.length === 0;
    return false;
  });
}

/**
 * Admin › ProductsPage
 * - Завантаження по вибору бренду/category-папки або кнопці "Пошук"
 * - Фільтри: бренд (серверний, через кеш брендів), артикул (серверний), постачальник (клієнтська дорізка)
 * - Адмінка завантажує весь вибраний бренд/category-зріз, повторні відкриття беруться з кешу
 * - Відображення: один рядок на offer з об'єднаними комірками для бренду, артикулу та назви (rowspan)
 * - Сортування offers: спочатку "Мій склад", потім партнери по зростанню ціни
 * - Перемикач цінової політики (вхідна за замовчуванням, роздріб, ціна 1–3, ціна опт)
 */
export default function ProductsPage() {
  // Фільтри
  const [selectedBrand, setSelectedBrand] = useState(""); // ID бренду з кешу
  const [brandSearch, setBrandSearch] = useState(""); // Пошук по назві бренду
  const [articleSearch, setArticleSearch] = useState("");
  const [selectedSupplier, setSelectedSupplier] = useState("all"); // Клієнтська фільтрація
  const [priceType, setPriceType] = useState(PRICE_TYPE_INCOMING); // Цінова політика (за замовчуванням — оцінка вхідної)
  
  // Клієнт та пошук
  const [selectedClient, setSelectedClient] = useState(null); // Вибраний клієнт
  const [clientPricingRules, setClientPricingRules] = useState(null); // Правила ціноутворення
  
  // Використовуємо спільний хук для пошуку клієнтів
  const {
    searchQuery: clientSearch,
    setSearchQuery: setClientSearch,
    filteredClients: clientSearchResults,
    loading: searchingClients,
  } = useClientSearch({
    debounceMs: 400, // Debounce для autocomplete
    maxResults: 10, // Обмеження для autocomplete
    autoLoad: true,
  });
  
  // Списки для фільтрів
  const [brandsList, setBrandsList] = useState([]); // [{id, name}] з brandsCache
  const [suppliersList, setSuppliersList] = useState([]);
  
  // Смарт-панель (як на порталі)
  const [smartPanelMode, setSmartPanelMode] = useState('groups'); // 'groups' | 'brands'
  const [selectedGroup, setSelectedGroup] = useState(null); // groupId
  const [expandedGroup, setExpandedGroup] = useState(null); // groupId або null
  const [productGroups, setProductGroups] = useState([]); // Групи з brandFolders
  
  // Результати пошуку
  const [products, setProducts] = useState([]); // Товари з Firestore
  const [displayRows, setDisplayRows] = useState([]); // Рядки для відображення (з offers[])
  const [loading, setLoading] = useState(false);
  
  // Featured products
  const [activeTab, setActiveTab] = useState("catalog"); // "catalog" | "featured"
  const [featuredProducts, setFeaturedProducts] = useState([]); // [{brand, id, addedAt}]
  const [featuredProductsData, setFeaturedProductsData] = useState([]); // Повні дані товарів
  const [loadingFeatured, setLoadingFeatured] = useState(false);
  const [statusMessage, setStatusMessage] = useState(null); // {type: 'success'|'error', text: string}

  // Модалка замовлення
  const [orderModalProduct, setOrderModalProduct] = useState(null);
  const [orderModalOffer, setOrderModalOffer] = useState(null); // Конкретна пропозиція
  const [orderForm, setOrderForm] = useState({
    supplierId: "",
    quantity: "",
    price: "",
    currency: "EUR",
  });
  const [suppliers, setSuppliers] = useState([]);
  const [categoriesList, setCategoriesList] = useState([]);

  // Модалка швидкого редагування master-даних
  const [masterModalProduct, setMasterModalProduct] = useState(null);
  const [masterForm, setMasterForm] = useState({
    correctName: "",
    categories: [],
    pack: "",
    tolerances: "",
    synonymsText: "",
  });
  const [loadingMasterData, setLoadingMasterData] = useState(false);
  const [savingMasterData, setSavingMasterData] = useState(false);
  const [deletingMasterData, setDeletingMasterData] = useState(false);

  // Моніторинг заповненості master-даних
  const [masterMonitorSupplier, setMasterMonitorSupplier] = useState("Мій склад");
  const [masterMonitorFields, setMasterMonitorFields] = useState(["categories"]);
  const [masterMonitorRows, setMasterMonitorRows] = useState([]);
  const [masterMonitorCursor, setMasterMonitorCursor] = useState(null);
  const [masterMonitorHasMore, setMasterMonitorHasMore] = useState(false);
  const [masterMonitorScanned, setMasterMonitorScanned] = useState(0);
  const [masterMonitorLoading, setMasterMonitorLoading] = useState(false);

  // Кеш товарів по брендах/category-групах, щоб повторні кліки не робили зайві reads
  const brandCacheRef = useRef(new Map());
  const categoryGroupCacheRef = useRef(new Map());
  
  // Завантаження featured products
  const loadFeaturedProducts = useCallback(async () => {
    setLoadingFeatured(true);
    try {
      const featuredRef = doc(db, `/artifacts/${appId}/public/data/featuredProducts/main`);
      const featuredSnap = await getDoc(featuredRef);
      
      if (featuredSnap.exists()) {
        const data = featuredSnap.data();
        const items = data.items || [];
        setFeaturedProducts(items);
        
        if (items.length === 0) {
          setFeaturedProductsData([]);
          setLoadingFeatured(false);
          return;
        }
        
        // Завантажуємо повні дані товарів
        const productPromises = items.map(async (item) => {
          try {
            // Шукаємо товар по brand та id
            const productsQuery = query(
              collection(db, `/artifacts/${appId}/public/data/products`),
              where("brand", "==", item.brand),
              where("id", "==", item.id),
              limit(1)
            );
            const productSnap = await getDocs(productsQuery);
            if (!productSnap.empty) {
              const productDoc = productSnap.docs[0];
              return { docId: productDoc.id, ...productDoc.data() };
            }
            return null;
          } catch (e) {
            console.warn("Failed to load featured product", item.brand, item.id, e);
            return null;
          }
        });
        
        const products = (await Promise.all(productPromises)).filter(p => p !== null);
        setFeaturedProductsData(products);
      } else {
        setFeaturedProducts([]);
        setFeaturedProductsData([]);
      }
    } catch (e) {
      console.error('[Admin ProductsPage] Failed to load featured products', e);
      setFeaturedProducts([]);
      setFeaturedProductsData([]);
    } finally {
      setLoadingFeatured(false);
    }
  }, [appId]);
  
  // Завантаження featured products при монтуванні
  useEffect(() => {
    loadFeaturedProducts();
  }, [loadFeaturedProducts]);
  
  // Функції для додавання/видалення featured products
  const handleAddFeatured = useCallback(async (brand, id) => {
    try {
      const call = httpsCallable(functions, "addFeaturedProduct");
      await call({ brand, id });
      await loadFeaturedProducts(); // Оновлюємо список
      setStatusMessage({ type: 'success', text: `Товар ${brand} ${id} додано до рекомендованих` });
      setTimeout(() => setStatusMessage(null), 3000);
    } catch (e) {
      console.error("Failed to add featured product", e);
      setStatusMessage({ type: 'error', text: e?.message || "Не вдалося додати товар до рекомендованих" });
      setTimeout(() => setStatusMessage(null), 3000);
    }
  }, [loadFeaturedProducts]);
  
  const handleRemoveFeatured = useCallback(async (brand, id) => {
    try {
      const call = httpsCallable(functions, "removeFeaturedProduct");
      await call({ brand, id });
      await loadFeaturedProducts(); // Оновлюємо список
      setStatusMessage({ type: 'success', text: `Товар ${brand} ${id} видалено з рекомендованих` });
      setTimeout(() => setStatusMessage(null), 3000);
    } catch (e) {
      console.error("Failed to remove featured product", e);
      setStatusMessage({ type: 'error', text: e?.message || "Не вдалося видалити товар з рекомендованих" });
      setTimeout(() => setStatusMessage(null), 3000);
    }
  }, [loadFeaturedProducts]);
  
  // Перевірка, чи товар є в featured
  const isFeatured = useCallback((brand, id) => {
    return featuredProducts.some(item => item.brand === brand && item.id === id);
  }, [featuredProducts]);

  // Завантаження списку брендів з кешу (як на порталі)
  useEffect(() => {
    const loadBrands = async () => {
      try {
        const snap = await getDocs(
          collection(db, `/artifacts/${appId}/public/meta/brands`)
        );
        const brands = snap.docs
          .map(d => ({ id: d.id, name: d.data().name }))
          .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
        setBrandsList(brands);
      } catch (e) {
        console.error("Помилка завантаження брендів", e);
      }
    };
    
    loadBrands();
  }, []);

  // Завантаження груп (brandFolders)
  useEffect(() => {
    const loadGroups = async () => {
      try {
        const snap = await getDocs(
          query(collection(db, `/artifacts/${appId}/public/meta/brandFolders`))
        );
        const groups = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        groups.sort((a, b) => {
          return (a.order || 0) - (b.order || 0)
            || String(a.name || a.id).localeCompare(String(b.name || b.id), "uk");
        });
        setProductGroups(groups);
      } catch (e) {
        console.error("Помилка завантаження груп", e);
      }
    };
    
    loadGroups();
  }, []);

  // Завантаження списку постачальників (з offers[] товарів)
  useEffect(() => {
    const loadSuppliers = async () => {
      try {
        // Читаємо кілька товарів, щоб зібрати унікальних постачальників
        const snap = await getDocs(
          query(
            collection(db, `/artifacts/${appId}/public/data/products`),
            limit(100)
          )
        );
        
        const suppliersSet = new Set();
        snap.docs.forEach(doc => {
          const data = doc.data();
          if (data.offers && Array.isArray(data.offers)) {
            data.offers.forEach(offer => {
              if (offer.supplier) {
                suppliersSet.add(offer.supplier);
              }
            });
          }
        });
        
        const suppliers = Array.from(suppliersSet).sort((a, b) => 
          String(a).localeCompare(String(b), "uk")
        );
        setSuppliersList(suppliers);
      } catch (e) {
        console.error("Помилка завантаження постачальників", e);
      }
    };
    
    loadSuppliers();
  }, []);

  // Завантаження повного списку постачальників для модалки замовлення
  useEffect(() => {
    const loadSuppliersForOrder = async () => {
      try {
        const snap = await getDocs(
          collection(db, `/artifacts/${appId}/public/data/suppliers`)
        );
        const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        setSuppliers(list);
      } catch (e) {
        console.error("Помилка завантаження постачальників для замовлення:", e);
      }
    };
    loadSuppliersForOrder();
  }, []);

  // Категорії для швидкого редагування master-даних
  useEffect(() => {
    const loadCategories = async () => {
      try {
        const snap = await getDocs(
          collection(db, `/artifacts/${appId}/public/meta/categories`)
        );
        const categories = snap.docs
          .map((d) => ({ id: d.id, ...d.data(), name: d.data().name || d.id }))
          .sort((a, b) =>
            (a.order || 0) - (b.order || 0)
            || String(a.name || "").localeCompare(String(b.name || ""), "uk")
          );
        setCategoriesList(categories);
      } catch (e) {
        console.error("Помилка завантаження категорій", e);
      }
    };
    loadCategories();
  }, []);

  // Функція нормалізації артикулу (як в shared.js)
  const normalizeArticle = (v) => {
    const s = String(v ?? "").trim().toUpperCase();
    return s.replace(/\s+/g, "").replace(/[^\w.-]/g, "");
  };

  const applyProductPatch = useCallback((productDocId, patch) => {
    const apply = (product) =>
      product.docId === productDocId
        ? {
            ...product,
            ...patch,
            name: patch.name || product.name,
          }
        : product;

    setProducts((prev) => prev.map(apply));
    setFeaturedProductsData((prev) => prev.map(apply));
    brandCacheRef.current.forEach((cached, key) => {
      brandCacheRef.current.set(key, {
        ...cached,
        products: (cached.products || []).map(apply),
      });
    });
    categoryGroupCacheRef.current.forEach((cached, key) => {
      categoryGroupCacheRef.current.set(key, {
        ...cached,
        products: (cached.products || []).map(apply),
      });
    });
  }, []);

  const openMasterModal = useCallback(async (product) => {
    setMasterModalProduct(product);
    setLoadingMasterData(true);
    setMasterForm({
      correctName: product.name || "",
      categories: Array.isArray(product.categories) ? product.categories : [],
      pack: product.pack || "",
      tolerances: product.tolerances || "",
      synonymsText: joinTextList(product.synonyms),
    });

    try {
      const call = httpsCallable(functions, "peekProductMasterData");
      const { data } = await call({ brand: product.brand, id: product.id });
      if (data?.exists && data?.data) {
        const md = data.data;
        setMasterForm({
          correctName: md.correctName || product.name || "",
          categories: Array.isArray(md.categories) ? md.categories : [],
          pack: md.pack || "",
          tolerances: md.tolerances || "",
          synonymsText: joinTextList(md.synonyms),
        });
      }
    } catch (e) {
      console.error("Помилка завантаження master-даних", e);
      setStatusMessage({
        type: "error",
        text: e?.message || "Не вдалося завантажити master-дані",
      });
    } finally {
      setLoadingMasterData(false);
    }
  }, []);

  const closeMasterModal = useCallback(() => {
    setMasterModalProduct(null);
    setLoadingMasterData(false);
    setSavingMasterData(false);
    setDeletingMasterData(false);
  }, []);

  const handleSaveMasterData = useCallback(async () => {
    if (!masterModalProduct) return;

    setSavingMasterData(true);
    try {
      const call = httpsCallable(functions, "updateProductMasterData");
      const { data } = await call({
        productDocId: masterModalProduct.docId,
        brand: masterModalProduct.brand,
        id: masterModalProduct.id,
        correctName: masterForm.correctName,
        categories: masterForm.categories,
        pack: masterForm.pack,
        tolerances: masterForm.tolerances,
        synonyms: splitTextList(masterForm.synonymsText),
      });

      const productPatch = data?.productPatch || {
        name: masterForm.correctName,
        categories: masterForm.categories,
        pack: masterForm.pack,
        tolerances: masterForm.tolerances,
        synonyms: splitTextList(masterForm.synonymsText),
      };
      applyProductPatch(masterModalProduct.docId, productPatch);
      setMasterMonitorRows((prev) =>
        prev.flatMap((row) => {
          if (row.productDocId !== masterModalProduct.docId) return [row];
          const nextRow = {
            ...row,
            ...productPatch,
            name: productPatch.name || row.name,
            correctName: productPatch.name || masterForm.correctName,
            masterExists: true,
            masterUpdatedAt: Date.now(),
            masterDataUpdatedAt: Date.now(),
          };
          const missingFields = getMissingMasterFields(nextRow, masterMonitorFields);
          return missingFields.length ? [{ ...nextRow, missingFields }] : [];
        })
      );
      setStatusMessage({ type: "success", text: "Master-дані товару оновлено" });
      closeMasterModal();
    } catch (e) {
      console.error("Помилка збереження master-даних", e);
      setStatusMessage({
        type: "error",
        text: e?.message || "Не вдалося зберегти master-дані",
      });
    } finally {
      setSavingMasterData(false);
    }
  }, [masterModalProduct, masterForm, masterMonitorFields, applyProductPatch, closeMasterModal]);

  const handleDeleteMasterData = useCallback(async () => {
    if (!masterModalProduct) return;
    if (!window.confirm(
      `Видалити master-дані для ${masterModalProduct.brand} ${masterModalProduct.id}?\nСам товар у каталозі не буде змінено.`
    )) {
      return;
    }

    setDeletingMasterData(true);
    try {
      const call = httpsCallable(functions, "deleteProductMasterData");
      await call({
        productDocId: masterModalProduct.docId,
        brand: masterModalProduct.brand,
        id: masterModalProduct.id,
      });

      setStatusMessage({
        type: "success",
        text: "Master-дані товару видалено. Сам товар не змінювався.",
      });
      closeMasterModal();
    } catch (e) {
      console.error("Помилка видалення master-даних", e);
      setStatusMessage({
        type: "error",
        text: e?.message || "Не вдалося видалити master-дані",
      });
    } finally {
      setDeletingMasterData(false);
    }
  }, [masterModalProduct, closeMasterModal]);

  const toggleMasterMonitorField = useCallback((field) => {
    setMasterMonitorFields((prev) => {
      if (prev.includes(field)) {
        const next = prev.filter((item) => item !== field);
        return next.length ? next : prev;
      }
      return [...prev, field];
    });
  }, []);

  const runMasterMonitor = useCallback(async ({ append = false } = {}) => {
    if (!masterMonitorFields.length) {
      setStatusMessage({ type: "error", text: "Оберіть хоча б одне поле для перевірки." });
      return;
    }

    setMasterMonitorLoading(true);
    try {
      const call = httpsCallable(functions, "monitorProductMasterData");
      const { data } = await call({
        supplier: masterMonitorSupplier,
        fields: masterMonitorFields,
        pageSize: MASTER_MONITOR_PAGE_SIZE,
        cursor: append ? masterMonitorCursor : null,
      });

      const rows = Array.isArray(data?.rows) ? data.rows : [];
      setMasterMonitorRows((prev) => {
        if (!append) return rows;
        const map = new Map(prev.map((row) => [row.productDocId, row]));
        rows.forEach((row) => map.set(row.productDocId, row));
        return Array.from(map.values());
      });
      setMasterMonitorCursor(data?.nextCursor || null);
      setMasterMonitorHasMore(Boolean(data?.hasMore));
      setMasterMonitorScanned((prev) => (append ? prev : 0) + Number(data?.scannedCount || 0));
      setStatusMessage({
        type: "success",
        text: `Моніторинг завершено: знайдено ${rows.length}, проскановано ${data?.scannedCount || 0}.`,
      });
    } catch (e) {
      console.error("Помилка моніторингу master-даних", e);
      setStatusMessage({
        type: "error",
        text: e?.message || "Не вдалося промоніторити master-дані",
      });
    } finally {
      setMasterMonitorLoading(false);
    }
  }, [masterMonitorSupplier, masterMonitorFields, masterMonitorCursor]);

  const openMasterModalFromMonitor = useCallback((row) => {
    openMasterModal({
      docId: row.productDocId,
      brand: row.brand,
      id: row.id,
      name: row.name,
      categories: Array.isArray(row.categories) ? row.categories : [],
      pack: row.pack || "",
      tolerances: row.tolerances || "",
      synonyms: Array.isArray(row.synonyms) ? row.synonyms : [],
    });
  }, [openMasterModal]);

  // Фільтрований список брендів для бічної панелі
  const filteredBrands = useMemo(() => {
    if (!brandSearch.trim()) return brandsList;
    const searchLower = brandSearch.trim().toLowerCase();
    return brandsList.filter(b => 
      String(b.name || "").toLowerCase().includes(searchLower)
    );
  }, [brandsList, brandSearch]);

  // Завантаження правил ціноутворення для вибраного клієнта
  useEffect(() => {
    const loadPricingRules = async () => {
      if (!selectedClient || !selectedClient.id) {
        setClientPricingRules(null);
        return;
      }
      
      try {
        const getRules = httpsCallable(functions, "getClientPricingRules");
        const { data } = await getRules({ clientId: selectedClient.id });
        setClientPricingRules(data);
      } catch (e) {
        console.error("Помилка завантаження правил ціноутворення", e);
        setClientPricingRules(null);
      }
    };
    
    loadPricingRules();
  }, [selectedClient]);

  // Функція для знаходження правила (як у ProductCatalog)
  const findRule = useCallback((rules, type, brand, id, supplier) => {
    if (!rules || !rules.rules || !Array.isArray(rules.rules)) return null;
    
    for (const rule of rules.rules) {
      if (rule.type === "product" && type === "product" && rule.brand === brand && rule.id === id) {
        return rule;
      }
      if (rule.type === "brand" && type === "brand" && rule.brand === brand) {
        return rule;
      }
      if (rule.type === "supplier" && type === "supplier" && rule.supplier === supplier) {
        return rule;
      }
    }
    return null;
  }, []);

  // Обчислення ціни з урахуванням правил (як у ProductCatalog)
  const calculatePriceWithRules = useCallback((product, offer) => {
    if (!offer || !offer.publicPrices) return 0;
    
    // 1. Визначаємо градацію та adjustment (пріоритет)
    let priceGroup = selectedClient?.priceType || priceType || "роздріб";
    let adjustment = 0;
    
    if (clientPricingRules && clientPricingRules.rules) {
      // Перевірка персональних правил (пріоритет)
      const productRule = findRule(clientPricingRules, "product", product.brand, product.id, null);
      if (productRule) {
        priceGroup = productRule.priceGroup;
        if (productRule.adjustment !== undefined) {
          adjustment = Number(productRule.adjustment || 0);
        } else {
          const discount = Number(productRule.discount || 0);
          const markup = Number(productRule.markup || 0);
          adjustment = markup - discount;
        }
      } else {
        const brandRule = findRule(clientPricingRules, "brand", product.brand, null, null);
        if (brandRule) {
          priceGroup = brandRule.priceGroup;
          if (brandRule.adjustment !== undefined) {
            adjustment = Number(brandRule.adjustment || 0);
          } else {
            const discount = Number(brandRule.discount || 0);
            const markup = Number(brandRule.markup || 0);
            adjustment = markup - discount;
          }
        } else {
          const supplierRule = findRule(clientPricingRules, "supplier", null, null, offer.supplier);
          if (supplierRule) {
            priceGroup = supplierRule.priceGroup;
            if (supplierRule.adjustment !== undefined) {
              adjustment = Number(supplierRule.adjustment || 0);
            } else {
              const discount = Number(supplierRule.discount || 0);
              const markup = Number(supplierRule.markup || 0);
              adjustment = markup - discount;
            }
          }
        }
      }
    }
    
    // 2. Базова ціна: оцінка вхідної (як у Закупках) або градація з publicPrices
    let basePrice;
    if (priceType === PRICE_TYPE_INCOMING) {
      basePrice = estimateIncomingFromRetail(offer.publicPrices);
      if (!basePrice || basePrice <= 0) return 0;
    } else {
      basePrice = offer.publicPrices[priceGroup];
      if (!basePrice || basePrice <= 0) {
        basePrice = offer.publicPrices.роздріб;
        if (!basePrice || basePrice <= 0) return 0;
      }
    }
    
    // 3. Застосовуємо персональний adjustment
    let price = basePrice;
    price = price * (1 + adjustment/100);
    
    // 4. Застосовуємо загальний adjustment (останнім)
    if (clientPricingRules) {
      let globalAdjustment = 0;
      if (clientPricingRules.globalAdjustment !== undefined) {
        globalAdjustment = Number(clientPricingRules.globalAdjustment || 0);
      } else {
        const globalDiscount = Number(clientPricingRules.globalDiscount || 0);
        const globalMarkup = Number(clientPricingRules.globalMarkup || 0);
        globalAdjustment = globalMarkup - globalDiscount;
      }
      price = price * (1 + globalAdjustment/100);
    }
    
    // 5. Округлення в більшу сторону до сотих
    let finalPrice = Math.ceil(price * 100) / 100;
    
    return finalPrice;
  }, [selectedClient, priceType, clientPricingRules, findRule]);

  // Функція для отримання ціни з publicPrices за обраною політикою
  const getPrice = useCallback((publicPrices, supplier) => {
    if (!publicPrices || typeof publicPrices !== "object") return null;
    if (priceType === PRICE_TYPE_INCOMING) {
      return estimateIncomingFromRetail(publicPrices);
    }
    return publicPrices[priceType] ?? null;
  }, [priceType]);

  // Функції для модалки замовлення
  const openOrderModal = useCallback((product, offer) => {
    setOrderModalProduct(product);
    setOrderModalOffer(offer);
    
    const incomingEst = estimateIncomingFromRetail(offer?.publicPrices);
    const price =
      offer?.price != null && offer.price > 0
        ? Number(offer.price).toFixed(2)
        : incomingEst != null && incomingEst > 0
          ? incomingEst.toFixed(2)
          : "";
      
    setOrderForm({
      supplierId: offer?.supplier || "",
      quantity: "1",
      price,
      currency: "EUR",
    });
  }, []);

  const closeOrderModal = useCallback(() => {
    setOrderModalProduct(null);
    setOrderModalOffer(null);
  }, []);

  const handleCreateOrder = useCallback(async () => {
    if (!orderModalProduct || !orderModalOffer) return;
    
    const supplier = suppliers.find(s => 
      s.id === orderForm.supplierId || s.name === orderForm.supplierId
    );
    const quantity = Number(orderForm.quantity);
    const price = Number(orderForm.price);
    const isQuickOrder = !orderForm.supplierId;
    const resolvedSupplierId = supplier?.id || orderForm.supplierId || "quick";
    const resolvedSupplierName = supplier?.name || orderForm.supplierId || "quick";
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setStatusMessage({ type: "error", text: "Кількість має бути > 0" });
      return;
    }
    if (!Number.isFinite(price) || price < 0) {
      setStatusMessage({ type: "error", text: "Некоректна ціна" });
      return;
    }

    try {
      await addDoc(
        collection(db, `/artifacts/${appId}/public/data/purchaseOrders`),
        {
          productDocId: orderModalProduct.docId,
          productBrand: orderModalProduct.brand,
          productId: orderModalProduct.id,
          productName: orderModalProduct.name,
          supplierId: resolvedSupplierId,
          supplierName: resolvedSupplierName,
          isQuickOrder,
          quantity,
          price,
          currency: orderForm.currency,
          status: "open",
          createdAt: serverTimestamp(),
        }
      );

      setStatusMessage({
        type: "success",
        text: `Замовлення створено: ${resolvedSupplierName}, ${quantity} шт.`,
      });
      closeOrderModal();
    } catch (e) {
      console.error("Помилка створення замовлення:", e);
      setStatusMessage({
        type: "error",
        text: e?.message || "Помилка створення замовлення",
      });
    }
  }, [orderModalProduct, orderModalOffer, orderForm, suppliers, closeOrderModal]);

  const loadProductsByGroup = useCallback(async (groupId) => {
    if (!groupId) {
      setProducts([]);
      return;
    }

    const cached = categoryGroupCacheRef.current.get(groupId);
    if (cached) {
      setProducts(cached.products);
      return;
    }

    const group = productGroups.find(g => g.id === groupId);
    if (!group) {
      setProducts([]);
      return;
    }

    const groupType = group.groupType || (group.filterType === "category" ? "category" : "preset");
    const categories = Array.isArray(group.categories)
      ? group.categories.map((cat) => String(cat || "").trim()).filter(Boolean)
      : [];

    if (groupType !== "category" || categories.length === 0) {
      setProducts([]);
      return;
    }

    if (categories.length > 30) {
      setProducts([]);
      setStatusMessage({
        type: "error",
        text: "У category-папці більше 30 категорій. Firestore не дозволяє один array-contains-any запит на такий список.",
      });
      return;
    }

    setLoading(true);
    try {
      const baseRef = collection(db, `/artifacts/${appId}/public/data/products`);
      const clauses = [
        categories.length === 1
          ? where("categories", "array-contains", categories[0])
          : where("categories", "array-contains-any", categories),
        orderBy("brand"),
        orderBy("name"),
      ];

      const q = query(baseRef, ...clauses);
      const snap = await getDocs(q);
      const docs = snap.docs.map((d) => ({ docId: d.id, ...d.data() }));

      categoryGroupCacheRef.current.set(groupId, { products: docs });
      setProducts(docs);
    } catch (e) {
      console.error("Помилка завантаження товарів category-групи", e);
      setProducts([]);
      setStatusMessage({
        type: "error",
        text: e?.message || "Не вдалося завантажити товари category-папки",
      });
    } finally {
      setLoading(false);
    }
  }, [productGroups]);

  // Функція пошуку товарів
  const handleSearch = useCallback(async () => {
    setLoading(true);
    try {
      // Якщо є артикул - використовуємо Cloud Function (як на порталі, з підтримкою синонімів)
      if (articleSearch.trim()) {
        const call = httpsCallable(functions, 'searchProductsByArticle');
        const { data } = await call({ article: articleSearch.trim() });
        
        if (data.ok) {
          setProducts(data.products || []);
        } else {
          console.error("Помилка пошуку по артикулу:", data.error);
          setProducts([]);
        }
        setLoading(false);
        return;
      }
      
      if (selectedGroup) {
        await loadProductsByGroup(selectedGroup);
        return;
      }

      // Якщо немає артикулу - шукаємо по бренду
      if (!selectedBrand) {
        setProducts([]);
        setLoading(false);
        return;
      }
      
      // Перевіряємо кеш перед запитом
      const cached = brandCacheRef.current.get(selectedBrand);
      if (cached) {
        setProducts(cached.products);
      setLoading(false);
        return;
      }
      
      const baseRef = collection(db, `/artifacts/${appId}/public/data/products`);
      const clauses = [];
      
      // Фільтр по бренду (серверний)
          const brandObj = brandsList.find(b => b.id === selectedBrand);
          if (brandObj && brandObj.name) {
            clauses.push(where("brand", "==", brandObj.name));
      }
      
      clauses.push(orderBy("brand"));
      clauses.push(orderBy("name"));

      const q = query(baseRef, ...clauses);
      const snap = await getDocs(q);
      const docs = snap.docs.map((d) => ({ docId: d.id, ...d.data() }));
      
      // Зберігаємо в кеш
      brandCacheRef.current.set(selectedBrand, { products: docs });
      
      setProducts(docs);
    } catch (e) {
      console.error("Помилка пошуку товарів", e);
      setProducts([]);
    } finally {
      setLoading(false);
    }
  }, [selectedBrand, selectedGroup, articleSearch, brandsList, loadProductsByGroup]);

  // Автоматичний пошук при виборі бренда (якщо артикул порожній)
  useEffect(() => {
    // Якщо вибрано бренд і артикул порожній - виконуємо пошук автоматично
    if (selectedBrand && !articleSearch.trim()) {
      handleSearch();
    }
  }, [selectedBrand, articleSearch, handleSearch]);

  // Обробка offers[] та клієнтська фільтрація по постачальнику
  useEffect(() => {
    if (!products.length) {
      setDisplayRows([]);
      return;
    }
    
    const rows = [];
    
    for (const product of products) {
      if (!product.offers || !Array.isArray(product.offers)) {
        // Якщо немає offers - пропускаємо товар
        continue;
      }
      
      // Фільтрація по постачальнику (клієнтська)
      let filteredOffers = product.offers;
      if (selectedSupplier !== "all") {
        filteredOffers = product.offers.filter(
          offer => offer.supplier === selectedSupplier
        );
      }
      
      // Сортування offers: спочатку "Мій склад", потім інші по зростанню ціни
      filteredOffers.sort((a, b) => {
        // Спочатку "Мій склад"
        if (a.supplier === "Мій склад" && b.supplier !== "Мій склад") return -1;
        if (a.supplier !== "Мій склад" && b.supplier === "Мій склад") return 1;
        
        // Якщо обидва "Мій склад" або обидва не "Мій склад" - сортуємо по ціні
        let priceA, priceB;
        if (selectedClient && clientPricingRules) {
          priceA = calculatePriceWithRules(product, a) ?? Infinity;
          priceB = calculatePriceWithRules(product, b) ?? Infinity;
        } else {
          priceA = getPrice(a.publicPrices, a.supplier) ?? Infinity;
          priceB = getPrice(b.publicPrices, b.supplier) ?? Infinity;
        }
        return priceA - priceB;
      });
      
      // Створюємо один рядок на кожен offer
      for (const offer of filteredOffers) {
        rows.push({
          docId: product.docId,
          brand: product.brand || "",
          id: product.id || "",
          name: product.name || "",
          categories: Array.isArray(product.categories) ? product.categories : [],
          pack: product.pack || "",
          tolerances: product.tolerances || "",
          synonyms: Array.isArray(product.synonyms) ? product.synonyms : [],
          supplier: offer.supplier || "",
          stock: offer.stock ?? 0,
          price: offer.price ?? null, // Вхідна (закупівельна) ціна
          publicPrices: offer.publicPrices || {},
          // Додаткові поля з offer (якщо є)
          ukrSkladId: offer.ukrSkladId,
          ukrSkladGroupId: offer.ukrSkladGroupId,
          minStock: product.minStock, // Читаємо з кореня продукту
        });
      }
    }
    
    setDisplayRows(rows);
  }, [products, selectedSupplier, getPrice, selectedClient, clientPricingRules, calculatePriceWithRules]);

  // Очищення фільтрів
  const handleClear = () => {
    setSelectedBrand("");
    setSelectedGroup(null);
    setExpandedGroup(null);
    setBrandSearch("");
    setArticleSearch("");
    setSelectedSupplier("all");
    setProducts([]);
    setDisplayRows([]);
    setSelectedClient(null);
    setClientPricingRules(null);
    setClientSearch("");
  };

  // Групування рядків по товарах для rowspan
  const groupedRows = useMemo(() => {
    const groups = [];
    let currentGroup = null;
    
    for (const row of displayRows) {
      const key = `${row.docId}`;
      
      if (!currentGroup || currentGroup.key !== key) {
        // Новий товар
        if (currentGroup) {
          groups.push(currentGroup);
        }
        currentGroup = {
          key,
          product: {
            docId: row.docId,
            brand: row.brand,
            id: row.id,
            name: row.name,
            categories: row.categories,
            pack: row.pack,
            tolerances: row.tolerances,
            synonyms: row.synonyms,
          },
          offers: [row],
        };
      } else {
        // Той самий товар - додаємо offer
        currentGroup.offers.push(row);
      }
    }
    
    if (currentGroup) {
      groups.push(currentGroup);
    }
    
    return groups;
  }, [displayRows]);

  const tabsItems = [
    { key: "catalog", label: "Каталог" },
    { key: "featured", label: "Рекомендовані" },
    { key: "masterData", label: "Мастер-дані" },
  ];

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

  const masterMonitorSupplierOptions = useMemo(() => {
    const map = new Map([["Мій склад", "Мій склад"]]);
    suppliers.forEach((supplier) => {
      const name = supplier.name || supplier.id;
      if (name) map.set(name, name);
    });
    suppliersList.forEach((name) => {
      if (name) map.set(name, name);
    });
    return Array.from(map.values()).sort((a, b) => {
      if (a === "Мій склад") return -1;
      if (b === "Мій склад") return 1;
      return String(a).localeCompare(String(b), "uk");
    });
  }, [suppliers, suppliersList]);
  
  return (
    <div className="bg-white rounded-2xl shadow p-3 sm:p-4">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 mb-4">
        <h2 className="text-xl font-semibold">Товари</h2>
        <Tabs items={tabsItems} value={activeTab} onChange={setActiveTab} />
      </div>
      
      {/* Статус повідомлення */}
      {statusMessage && (
        <div className={`mb-4 p-3 rounded-lg ${
          statusMessage.type === 'success' 
            ? 'bg-green-100 text-green-800 border border-green-200' 
            : 'bg-red-100 text-red-800 border border-red-200'
        }`}>
          {statusMessage.text}
        </div>
      )}
      
      {activeTab === "featured" ? (
        <div>
          <div className="mb-4">
            <p className="text-sm text-gray-600">
              Тут відображаються рекомендовані товари, які показуються на порталі клієнта.
            </p>
          </div>
          
          {loadingFeatured ? (
            <div className="text-center py-8 text-gray-500">Завантаження...</div>
          ) : featuredProductsData.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              Немає рекомендованих товарів. Додайте товари з каталогу, використовуючи кнопку 📌.
            </div>
          ) : (
            <div className="overflow-auto border rounded-xl">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-3 py-2 text-left">Бренд</th>
                    <th className="px-3 py-2 text-left">Артикул</th>
                    <th className="px-3 py-2 text-left">Назва</th>
                    <th className="px-3 py-2 text-left">Додано</th>
                    <th className="px-3 py-2 text-left">Дії</th>
                  </tr>
                </thead>
                <tbody>
                  {featuredProductsData.map((product) => (
                    <tr key={`${product.brand}-${product.id}`} className="border-t">
                      <td className="px-3 py-2 whitespace-nowrap">{product.brand}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{product.id}</td>
                      <td className="px-3 py-2">{product.name}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-gray-500 text-xs">
                        {featuredProducts.find(item => item.brand === product.brand && item.id === product.id)?.addedAt?.toDate?.()?.toLocaleDateString('uk-UA') || '—'}
                      </td>
                      <td className="px-3 py-2">
                        <button
                          onClick={() => handleRemoveFeatured(product.brand, product.id)}
                          className="px-3 py-1 bg-red-100 text-red-700 rounded hover:bg-red-200 text-sm"
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
      ) : activeTab === "masterData" ? (
        <div className="space-y-4">
          <div className="rounded-xl border bg-slate-50 p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
              <div className="min-w-[220px]">
                <label className="mb-1 block text-xs font-medium text-slate-600">
                  Постачальник
                </label>
                <select
                  className="w-full rounded border px-3 py-2"
                  value={masterMonitorSupplier}
                  onChange={(e) => {
                    setMasterMonitorSupplier(e.target.value);
                    setMasterMonitorRows([]);
                    setMasterMonitorCursor(null);
                    setMasterMonitorHasMore(false);
                    setMasterMonitorScanned(0);
                  }}
                >
                  {masterMonitorSupplierOptions.map((supplierName) => (
                    <option key={supplierName} value={supplierName}>
                      {supplierName}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex-1">
                <div className="mb-1 text-xs font-medium text-slate-600">
                  Перевірити поля
                </div>
                <div className="flex flex-wrap gap-2">
                  {MASTER_FIELD_OPTIONS.map((field) => (
                    <label
                      key={field.key}
                      className="inline-flex items-center gap-2 rounded-full border bg-white px-3 py-1.5 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={masterMonitorFields.includes(field.key)}
                        onChange={() => {
                          toggleMasterMonitorField(field.key);
                          setMasterMonitorRows([]);
                          setMasterMonitorCursor(null);
                          setMasterMonitorHasMore(false);
                          setMasterMonitorScanned(0);
                        }}
                      />
                      <span>{field.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <button
                className="rounded-xl bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-700 disabled:opacity-60"
                onClick={() => runMasterMonitor({ append: false })}
                disabled={masterMonitorLoading || masterMonitorFields.length === 0}
              >
                {masterMonitorLoading ? "Моніторинг..." : "Промоніторити"}
              </button>
            </div>
            <p className="mt-3 text-xs text-slate-500">
              Сторінка результату: {MASTER_MONITOR_PAGE_SIZE}. Система сканує товари вибраного постачальника
              і показує тільки ті, де бракує вибраних master-полів.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-sm text-slate-600">
            <span>
              Знайдено: <b>{masterMonitorRows.length}</b>
            </span>
            <span>
              Проскановано: <b>{masterMonitorScanned}</b>
            </span>
            <span>
              Постачальник: <b>{masterMonitorSupplier}</b>
            </span>
          </div>

          <div className="overflow-auto rounded-xl border">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left">Бренд</th>
                  <th className="px-3 py-2 text-left">Артикул</th>
                  <th className="px-3 py-2 text-left">Назва</th>
                  <th className="px-3 py-2 text-left">Залишок</th>
                  <th className="px-3 py-2 text-left">Бракує</th>
                  <th className="px-3 py-2 text-left">Остання зміна master</th>
                  <th className="px-3 py-2 text-left">Оновлення offer</th>
                  <th className="px-3 py-2 text-left">Дії</th>
                </tr>
              </thead>
              <tbody>
                {masterMonitorRows.map((row) => (
                  <tr key={row.productDocId} className="border-t">
                    <td className="px-3 py-2 whitespace-nowrap">{row.brand || "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{row.id || "—"}</td>
                    <td className="px-3 py-2 min-w-[220px]">{row.name || "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{row.stock ?? 0}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {(row.missingFields || []).map((field) => (
                          <span
                            key={field}
                            className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 border border-amber-200"
                          >
                            {MASTER_FIELD_LABELS[field] || field}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-xs text-slate-600">
                      {formatDateTime(row.masterUpdatedAt || row.masterDataUpdatedAt)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-xs text-slate-600">
                      {formatDateTime(row.offerUpdatedAt)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <button
                        className="rounded bg-emerald-50 px-3 py-1 text-sm text-emerald-700 border border-emerald-200 hover:bg-emerald-100"
                        onClick={() => openMasterModalFromMonitor(row)}
                      >
                        Редагувати
                      </button>
                    </td>
                  </tr>
                ))}
                {!masterMonitorRows.length && !masterMonitorLoading && (
                  <tr>
                    <td colSpan={8} className="px-3 py-8 text-center text-gray-500">
                      Натисніть “Промоніторити”, щоб знайти товари з незаповненими master-даними.
                    </td>
                  </tr>
                )}
                {masterMonitorLoading && (
                  <tr>
                    <td colSpan={8} className="px-3 py-8 text-center text-gray-500">
                      Моніторинг master-даних...
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between">
            <div className="text-xs text-slate-500">
              Якщо master-документ створений через старий XLSX-імпорт, дата останньої зміни може бути порожньою.
            </div>
            {masterMonitorHasMore && (
              <button
                className="rounded-xl bg-slate-100 px-4 py-2 text-sm hover:bg-slate-200 disabled:opacity-60"
                onClick={() => runMasterMonitor({ append: true })}
                disabled={masterMonitorLoading}
              >
                {masterMonitorLoading ? "Завантаження..." : "Завантажити ще"}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-12 gap-4">
        {/* Бічна панель з пошуком по бренду */}
        <aside className="col-span-12 md:col-span-3">
          <div className="bg-white border rounded-lg shadow-sm p-4">
            {/* Тумблер режимів */}
            <div className="flex gap-1 mb-2">
              <button
                className={`flex-1 px-2 py-1.5 rounded text-sm font-medium ${
                  smartPanelMode === 'groups' 
                    ? 'bg-indigo-600 text-white' 
                    : 'bg-gray-100 hover:bg-gray-200'
                }`}
                onClick={() => setSmartPanelMode('groups')}
              >
                Групи
              </button>
              <button
                className={`flex-1 px-2 py-1.5 rounded text-sm font-medium ${
                  smartPanelMode === 'brands' 
                    ? 'bg-indigo-600 text-white' 
                    : 'bg-gray-100 hover:bg-gray-200'
                }`}
                onClick={() => setSmartPanelMode('brands')}
              >
                Бренди
              </button>
            </div>

            {/* Кнопка очищення */}
            {(selectedBrand || selectedGroup) && (
              <div className="mb-2">
                <button
                  className="w-full text-xs text-indigo-600 hover:underline text-center"
                  onClick={() => {
                    setSelectedBrand("");
                    setSelectedGroup(null);
                    setExpandedGroup(null);
                    setBrandSearch("");
                    setArticleSearch("");
                    setProducts([]);
                    setDisplayRows([]);
                  }}
                >
                  Очистити вибір
                </button>
              </div>
            )}

            {smartPanelMode === 'groups' ? (
              <div className="space-y-1">
                {productGroups.map(group => {
                  const isExpanded = expandedGroup === group.id;
                  const isSelected = selectedGroup === group.id;
                  const groupType = group.groupType || (group.filterType === 'category' ? 'category' : 'preset');
                  
                  return (
                    <div key={group.id} className="border border-gray-200 rounded">
                      <button
                        className={`w-full text-left px-2 py-1.5 flex items-center justify-between text-sm font-medium ${
                          isSelected 
                            ? 'bg-indigo-50 text-indigo-700' 
                            : 'hover:bg-gray-50'
                        }`}
                        onClick={() => {
                          if (groupType === 'preset' && group.brands && group.brands.length > 0) {
                            // Для preset-груп з одним брендом - вибираємо бренд
                            if (group.brands.length === 1) {
                              const brand = brandsList.find(b => b.name === group.brands[0]);
                              if (brand) {
                                setSelectedBrand(brand.id);
                                setSelectedGroup(null);
                                setExpandedGroup(null);
                                setArticleSearch("");
                              }
                            } else {
                              // Для preset-груп з кількома брендами - розгортаємо/згортаємо
                              if (isExpanded) {
                                setExpandedGroup(null);
                                if (selectedGroup === group.id) {
                                  setSelectedGroup(null);
                                }
                              } else {
                                setExpandedGroup(group.id);
                                setSelectedGroup(null);
                                setSelectedBrand("");
                                setArticleSearch("");
                                setProducts([]);
                                setDisplayRows([]);
                              }
                            }
                          } else if (groupType === 'category') {
                            setSelectedGroup(group.id);
                            setSelectedBrand("");
                            setExpandedGroup(null);
                            setArticleSearch("");
                            loadProductsByGroup(group.id);
                          }
                        }}
                      >
                        <span>{group.name || group.id}</span>
                        {groupType === 'preset' && group.brands && group.brands.length > 1 && (
                          <span className="text-[10px] text-gray-400">▼</span>
                        )}
                      </button>
                      {isExpanded && groupType === 'preset' && group.brands && group.brands.length > 1 && (
                        <div className="border-t border-gray-200">
                          {[...group.brands].sort((a, b) => String(a).localeCompare(String(b), "uk")).map((brandName, idx) => {
                            const brand = brandsList.find(b => b.name === brandName);
                            if (!brand) return null;
                            const isBrandSelected = selectedBrand === brand.id;
                            return (
                              <button
                                key={idx}
                                className={`w-full text-left px-3 py-1.5 text-sm ${
                                  isBrandSelected 
                                    ? 'bg-indigo-50 text-indigo-700 font-medium' 
                                    : 'hover:bg-gray-50'
                                }`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const nextBrandId = isBrandSelected ? "" : brand.id;
                                  setSelectedBrand(nextBrandId);
                                  setSelectedGroup(null);
                                  setExpandedGroup(null);
                                  setArticleSearch("");
                                  if (!nextBrandId) {
                                    setProducts([]);
                                    setDisplayRows([]);
                                  }
                                }}
                              >
                                {brandName}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
                {productGroups.length === 0 && (
                  <div className="text-sm text-gray-500 px-2 py-1">Групи не налаштовані</div>
                )}
              </div>
            ) : (
              <div className="space-y-1.5">
                {/* Пошукове поле для брендів */}
                <div className="relative">
                  <input
                    type="text"
                    placeholder="Пошук брендів..."
                    value={brandSearch}
                    onChange={(e) => setBrandSearch(e.target.value)}
                    className="w-full px-2 py-1.5 border border-gray-200 rounded text-sm"
                  />
                  {brandSearch && (
                    <button
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                      onClick={() => setBrandSearch("")}
                    >
                      ×
                    </button>
                  )}
                </div>
                <div className="max-h-[50vh] overflow-auto space-y-0.5">
                  {filteredBrands.length > 0 ? (
                    filteredBrands.map(b => {
                      const isSelected = selectedBrand === b.id;
                      return (
                        <button
                          key={b.id}
                          className={`w-full text-left px-2 py-1.5 rounded text-sm ${
                            isSelected 
                              ? 'bg-indigo-50 text-indigo-700 font-medium' 
                              : 'hover:bg-gray-50'
                          }`}
                          onClick={() => {
                            const nextBrandId = isSelected ? "" : b.id;
                            setSelectedBrand(nextBrandId);
                            setSelectedGroup(null);
                            setExpandedGroup(null);
                            setArticleSearch("");
                            if (!nextBrandId) {
                              setProducts([]);
                              setDisplayRows([]);
                            }
                          }}
                        >
                          {b.name || b.id}
                        </button>
                      );
                    })
                  ) : (
                    <div className="text-sm text-gray-500 py-2">
                      {brandSearch ? "Бренди не знайдено" : "Немає брендів"}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </aside>

        {/* Основний контент */}
        <section className="col-span-12 md:col-span-9">
          {/* Фільтри та пошук */}
          <div className="flex flex-wrap gap-2 items-center mb-4">
            {/* Пошук клієнта */}
            <div className="relative flex-1 min-w-[200px]">
              <input
                className="border rounded px-3 py-2 w-full"
                placeholder="Пошук клієнта: телефон або код"
                value={clientSearch}
                onChange={(e) => setClientSearch(e.target.value)}
                onBlur={() => {
                  // Затримка перед закриттям, щоб клік по результату встиг спрацювати
                  // Результати очистяться автоматично через хук, коли searchQuery стане порожнім
                  setTimeout(() => {}, 200);
                }}
              />
              {/* Випадаючий список результатів */}
              {/* Показуємо тільки якщо є текст у полі пошуку */}
              {clientSearch.trim() && clientSearchResults.length > 0 && (
                <div className="absolute z-10 w-full mt-1 bg-white border rounded-lg shadow-lg max-h-60 overflow-auto">
                  {clientSearchResults.map((client) => (
                    <button
                      key={client.id}
                      type="button"
                      className="w-full text-left px-3 py-2 hover:bg-gray-100 border-b last:border-b-0"
                      onClick={() => {
                        setSelectedClient(client);
                        setClientSearch("");
                        // Результати очистяться автоматично через хук
                      }}
                    >
                      <div className="font-medium">{client.name || client.id}</div>
                      <div className="text-xs text-gray-500">
                        {client.id} {client.phone ? `• ${client.phone}` : ""}
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {searchingClients && (
                <div className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 text-sm">
                  Завантаження...
                </div>
              )}
            </div>

            {/* Бейдж вибраного клієнта */}
            {selectedClient && (
              <div className="flex items-center gap-2 px-3 py-2 bg-indigo-50 rounded-lg border border-indigo-200">
                <span className="text-sm font-medium text-indigo-700">
                  {selectedClient.name || selectedClient.id}
                </span>
                <button
                  type="button"
                  className="text-indigo-600 hover:text-indigo-800 text-lg font-bold"
                  onClick={() => {
                    setSelectedClient(null);
                    setClientPricingRules(null);
                  }}
                  title="Очистити вибір клієнта"
                >
                  ×
                </button>
              </div>
            )}

            {/* Пошук по артикулу */}
            <input
              className="border rounded px-3 py-2 flex-1 min-w-[200px]"
              placeholder="Пошук по артикулу"
              value={articleSearch}
              onChange={(e) => setArticleSearch(e.target.value)}
              onKeyPress={(e) => {
                if (e.key === "Enter") handleSearch();
              }}
            />

            {/* Фільтр по постачальнику (клієнтська дорізка) */}
            <select
              className="border rounded px-3 py-2"
              value={selectedSupplier}
              onChange={(e) => setSelectedSupplier(e.target.value)}
            >
              <option value="all">Всі постачальники</option>
              {suppliersList.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>

            {/* Перемикач цінової політики */}
            <select
              className="border rounded px-3 py-2"
              value={priceType}
              onChange={(e) => setPriceType(e.target.value)}
            >
              <option value={PRICE_TYPE_INCOMING}>Вхідна (оцінка)</option>
              <option value="роздріб">Роздріб</option>
              <option value="ціна 1">Ціна 1</option>
              <option value="ціна 2">Ціна 2</option>
              <option value="ціна 3">Ціна 3</option>
              <option value="ціна опт">Ціна опт</option>
            </select>

            {/* Кнопки */}
            <button
              className="px-4 py-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60"
              onClick={handleSearch}
              disabled={loading}
            >
              {loading ? "Завантаження…" : "Пошук"}
            </button>

            <button
              className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 disabled:opacity-60"
              onClick={handleClear}
              disabled={loading}
            >
              Очистити
            </button>

            <div className="ml-auto text-sm text-gray-500">
              Показано: <b>{displayRows.length}</b> рядків
            </div>
          </div>

          {/* Таблиця результатів */}
          <div className="overflow-auto border rounded-xl">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-2 text-left">Бренд</th>
              <th className="px-3 py-2 text-left">Артикул</th>
              <th className="px-3 py-2 text-left">Назва</th>
              <th className="px-3 py-2 text-left">Постачальник</th>
              <th className="px-3 py-2 text-left">Наявність</th>
              <th className="px-3 py-2 text-left">Ціна</th>
              <th className="px-3 py-2 text-left">Дії</th>
            </tr>
          </thead>
          <tbody>
            {groupedRows.map((group, groupIndex) => {
              const rowspan = group.offers.length;
              return group.offers.map((row, offerIndex) => (
                <tr key={`${row.docId}-${row.supplier}-${offerIndex}`} className="border-t">
                  {offerIndex === 0 && (
                    <>
                      <td rowSpan={rowspan} className="px-3 py-2 whitespace-nowrap align-top">
                        {group.product.brand}
                      </td>
                      <td rowSpan={rowspan} className="px-3 py-2 whitespace-nowrap align-top">
                        {group.product.id}
                      </td>
                      <td rowSpan={rowspan} className="px-3 py-2 align-top">
                        {group.product.name}
                      </td>
                    </>
                  )}
                  <td className="px-3 py-2 whitespace-nowrap">{row.supplier}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{row.stock}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {(() => {
                      let price;
                      if (selectedClient && clientPricingRules) {
                        const product = {
                          brand: row.brand,
                          id: row.id,
                          name: row.name
                        };
                        const offer = {
                          supplier: row.supplier,
                          publicPrices: row.publicPrices
                        };
                        price = calculatePriceWithRules(product, offer);
                      } else {
                        price = getPrice(row.publicPrices, row.supplier);
                      }
                      
                      return price !== null && price !== undefined
                        ? typeof price === "number"
                          ? price.toFixed(2)
                          : String(price)
                        : "—";
                    })()}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      {offerIndex === 0 && (
                        <button
                          onClick={() => {
                            if (isFeatured(group.product.brand, group.product.id)) {
                              handleRemoveFeatured(group.product.brand, group.product.id);
                            } else {
                              handleAddFeatured(group.product.brand, group.product.id);
                            }
                          }}
                          className={`px-2 py-1 rounded text-sm transition-colors ${
                            isFeatured(group.product.brand, group.product.id)
                              ? "bg-yellow-100 text-yellow-700 hover:bg-yellow-200"
                              : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                          }`}
                          title={isFeatured(group.product.brand, group.product.id) ? "Видалити з рекомендованих" : "Додати до рекомендованих"}
                        >
                          {isFeatured(group.product.brand, group.product.id) ? "📌" : "📌"}
                        </button>
                      )}
                      
                      {offerIndex === 0 && (
                        <button
                          onClick={() => openMasterModal(group.product)}
                          className="px-2 py-1 rounded text-sm bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 transition-colors"
                          title="Редагувати master-дані товару"
                        >
                          ✏️
                        </button>
                      )}

                      <button
                        onClick={() => openOrderModal(group.product, row)}
                        className="px-2 py-1 rounded text-sm bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 transition-colors"
                        title="Створити замовлення на закупку"
                      >
                        🛒
                      </button>
                    </div>
                  </td>
                </tr>
              ));
            })}
            {!displayRows.length && !loading && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-gray-500">
                  {products.length === 0
                    ? "Натисніть 'Пошук' для завантаження товарів"
                    : "Немає даних за обраними фільтрами"}
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-gray-500">
                  Завантаження…
                </td>
              </tr>
            )}
          </tbody>
        </table>
          </div>
        </section>
      </div>
      )}

      {/* Модалка редагування master-даних */}
      {masterModalProduct && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={savingMasterData || deletingMasterData ? undefined : closeMasterModal}
          />
          <div className="relative bg-white rounded-2xl shadow-xl w-[min(720px,96vw)] max-h-[90vh] overflow-auto">
            <div className="px-5 py-3 border-b flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold">Редагування master-даних</h3>
                <p className="text-xs text-slate-500">
                  Brand та id не змінюються, щоб не ламати ідентифікацію товару.
                </p>
              </div>
              <button
                className="px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-sm disabled:opacity-60"
                onClick={closeMasterModal}
                disabled={savingMasterData || deletingMasterData}
              >
                Закрити
              </button>
            </div>

            <div className="p-5 space-y-4 text-sm">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-600 mb-1">Бренд</label>
                  <input
                    className="w-full px-3 py-2 border rounded-lg bg-slate-50 text-slate-600"
                    value={masterModalProduct.brand}
                    readOnly
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-600 mb-1">Артикул / id</label>
                  <input
                    className="w-full px-3 py-2 border rounded-lg bg-slate-50 text-slate-600"
                    value={masterModalProduct.id}
                    readOnly
                  />
                </div>
              </div>

              {loadingMasterData ? (
                <div className="py-8 text-center text-slate-500">
                  Завантаження master-даних...
                </div>
              ) : (
                <>
                  <div>
                    <label className="block text-xs text-slate-600 mb-1">
                      Правильна назва
                    </label>
                    <textarea
                      className="w-full px-3 py-2 border rounded-lg min-h-[76px]"
                      value={masterForm.correctName}
                      onChange={(e) =>
                        setMasterForm((prev) => ({
                          ...prev,
                          correctName: e.target.value,
                        }))
                      }
                      placeholder="Назва, яка буде показана в каталозі"
                    />
                  </div>

                  <div>
                    <label className="block text-xs text-slate-600 mb-2">
                      Категорії
                    </label>
                    <div className="max-h-48 overflow-auto border rounded-lg p-2 grid grid-cols-1 sm:grid-cols-2 gap-1">
                      {masterCategoryOptions.map((category) => {
                        const name = category.name || category.id;
                        const checked = masterForm.categories.includes(name);
                        return (
                          <label
                            key={category.id}
                            className="flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-50"
                          >
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
                        <div className="text-slate-500 px-2 py-1">
                          Категорії ще не налаштовані в довіднику.
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-slate-600 mb-1">Фасування / pack</label>
                      <input
                        className="w-full px-3 py-2 border rounded-lg"
                        value={masterForm.pack}
                        onChange={(e) =>
                          setMasterForm((prev) => ({
                            ...prev,
                            pack: e.target.value,
                          }))
                        }
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-600 mb-1">Допуски / tolerances</label>
                      <input
                        className="w-full px-3 py-2 border rounded-lg"
                        value={masterForm.tolerances}
                        onChange={(e) =>
                          setMasterForm((prev) => ({
                            ...prev,
                            tolerances: e.target.value,
                          }))
                        }
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs text-slate-600 mb-1">
                      Синоніми артикулу
                    </label>
                    <textarea
                      className="w-full px-3 py-2 border rounded-lg min-h-[120px] font-mono text-xs"
                      value={masterForm.synonymsText}
                      onChange={(e) =>
                        setMasterForm((prev) => ({
                          ...prev,
                          synonymsText: e.target.value,
                        }))
                      }
                      placeholder="Кожен синонім з нового рядка або через кому"
                    />
                    <p className="mt-1 text-xs text-slate-500">
                      При збереженні синоніми нормалізуються так само, як артикул у пошуку.
                    </p>
                  </div>

                  <div className="border-t pt-4">
                    <h4 className="text-sm font-semibold text-rose-700">
                      Видалити master-дані
                    </h4>
                    <p className="text-xs text-slate-500 mt-1">
                      Видаляється тільки запис у productMasterData. Сам товар у каталозі,
                      його brand/id/name/offers та поточні поля products не змінюються.
                    </p>
                    <button
                      className="mt-3 px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-sm disabled:opacity-60"
                      onClick={handleDeleteMasterData}
                      disabled={savingMasterData || deletingMasterData}
                    >
                      {deletingMasterData ? "Видалення..." : "Видалити master-дані"}
                    </button>
                  </div>
                </>
              )}

              <div className="pt-2 flex justify-end gap-2">
                <button
                  className="px-4 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-sm disabled:opacity-60"
                  onClick={closeMasterModal}
                  disabled={savingMasterData || deletingMasterData}
                >
                  Скасувати
                </button>
                <button
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm disabled:opacity-60"
                  onClick={handleSaveMasterData}
                  disabled={loadingMasterData || savingMasterData || deletingMasterData}
                >
                  {savingMasterData ? "Збереження..." : "Зберегти"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Модалка створення замовлення */}
      {orderModalProduct && orderModalOffer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={closeOrderModal}
          />
          <div className="relative bg-white rounded-2xl shadow-xl w-[min(480px,96vw)] max-h-[90vh] overflow-auto">
            <div className="px-5 py-3 border-b flex items-center justify-between">
              <h3 className="text-lg font-semibold">
                Нове замовлення на закупку
              </h3>
              <button
                className="px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-sm"
                onClick={closeOrderModal}
              >
                Закрити
              </button>
            </div>
            <div className="p-5 space-y-4 text-sm">
              <div>
                <div className="font-medium">
                  {orderModalProduct.brand} • {orderModalProduct.id}
                </div>
                <div className="text-slate-500">
                  {orderModalProduct.name}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <span className="text-slate-500">Постачальник:</span>
                  <div className="font-medium">{orderModalOffer.supplier}</div>
                </div>
                <div>
                  <span className="text-slate-500">Наявність:</span>
                  <div className="font-medium">{orderModalOffer.stock} шт.</div>
                </div>
                <div>
                  <span className="text-slate-500">Вхідна (оцінка з роздрібу):</span>
                  <div className="font-medium text-blue-600">
                    {(() => {
                      const est = estimateIncomingFromRetail(orderModalOffer.publicPrices);
                      if (est != null && est > 0) return est.toFixed(2);
                      if (orderModalOffer.price != null && orderModalOffer.price > 0) {
                        return Number(orderModalOffer.price).toFixed(2);
                      }
                      return "—";
                    })()}
                  </div>
                </div>
              </div>

              <div className="border-t pt-4 space-y-3">
                <div>
                  <label className="block text-xs text-slate-600 mb-1">
                    Постачальник
                  </label>
                  <select
                    className="w-full px-3 py-2 border rounded-lg"
                    value={orderForm.supplierId}
                    onChange={(e) =>
                      setOrderForm((prev) => ({
                        ...prev,
                        supplierId: e.target.value,
                      }))
                    }
                  >
                    <option value="">Оберіть постачальника</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name || s.id}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-slate-600 mb-1">
                      Кількість
                    </label>
                    <input
                      type="number"
                      className="w-full px-3 py-2 border rounded-lg"
                      value={orderForm.quantity}
                      onChange={(e) =>
                        setOrderForm((prev) => ({
                          ...prev,
                          quantity: e.target.value,
                        }))
                      }
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-600 mb-1">
                      Валюта
                    </label>
                    <select
                      className="w-full px-3 py-2 border rounded-lg"
                      value={orderForm.currency}
                      onChange={(e) =>
                        setOrderForm((prev) => ({
                          ...prev,
                          currency: e.target.value,
                        }))
                      }
                    >
                      <option value="EUR">EUR</option>
                      <option value="USD">USD</option>
                      <option value="UAH">UAH</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-slate-600 mb-1">
                    Ціна за одиницю
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    className="w-full px-3 py-2 border rounded-lg"
                    value={orderForm.price}
                    onChange={(e) =>
                      setOrderForm((prev) => ({
                        ...prev,
                        price: e.target.value,
                      }))
                    }
                  />
                </div>
              </div>

              <div className="pt-2 flex justify-end gap-2">
                <button
                  className="px-4 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-sm"
                  onClick={closeOrderModal}
                >
                  Скасувати
                </button>
                <button
                  className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm"
                  onClick={handleCreateOrder}
                >
                  Зберегти
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
