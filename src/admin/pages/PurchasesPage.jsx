import React, { useState, useCallback, useMemo, useEffect } from "react";
import {
  collection,
  deleteDoc,
  getDoc,
  getDocs,
  query,
  orderBy,
  where,
  addDoc,
  doc,
  setDoc,
  updateDoc,
  serverTimestamp,
} from "firebase/firestore";
import { auth, db } from "../../firebase-config";
import Tabs from "../components/Tabs.jsx";

const appId = import.meta.env.VITE_PROJECT_ID || "embryo-project";
const PRODUCTS_PATH = `/artifacts/${appId}/public/data/products`;
const REPRICE_EXCLUSIONS_PATH = `/artifacts/${appId}/public/meta/repriceSettings/brandExclusions`;
const REPRICE_MARKS_PATH = `/artifacts/${appId}/public/meta/repriceMarks`;
const STORAGE_KEY = "purchasesPage_state";
const INCOMING_FROM_RETAIL_COEF = 0.66667;
const REPRICE_EPSILON = 0.01;
const REPRICE_MARK_STALE_DAYS = 30;
const REPRICE_MARK_STALE_MS = REPRICE_MARK_STALE_DAYS * 24 * 60 * 60 * 1000;
const EMPTY_REPRICE_GROUPS = { cheaper: [], expensive: [], unavailable: [] };

const normalizeBrand = (brand) => String(brand || "").trim().toLowerCase();

const getIncomingFromRetail = (retailPrice) => {
  const price = Number(retailPrice || 0);
  return Number.isFinite(price) && price > 0 ? price * INCOMING_FROM_RETAIL_COEF : 0;
};

const getRepriceGroupCount = (groups, key) => groups[key]?.length || 0;

const formatDateTime = (value) => {
  const date = value?.toDate ? value.toDate() : value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("uk-UA", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const getMarkDate = (mark) => {
  const value = mark?.markedAtMs || mark?.markedAt;
  const date = value?.toDate ? value.toDate() : value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
};

const isRepriceMarkStale = (mark) => {
  const date = getMarkDate(mark);
  return date ? Date.now() - date.getTime() > REPRICE_MARK_STALE_MS : false;
};

/**
 * Розділ ЗАКУПКИ
 * Показує товари з "Мій склад", де stock < minStock
 */
export default function PurchasesPage({ setStatus }) {
  // Відновлення стану з localStorage при завантаженні
  const loadStateFromStorage = () => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const state = JSON.parse(saved);
        return {
          products: state.products || [],
          expandedProducts: new Set(state.expandedProducts || []),
          suppliers: state.suppliers || [],
          ordersByProduct: state.ordersByProduct || {},
          repriceProducts: state.repriceProducts || EMPTY_REPRICE_GROUPS,
          repriceTab: state.repriceTab || "cheaper",
          repriceSearch: state.repriceSearch || "",
          repriceSortBy: state.repriceSortBy || "difference",
          repriceSortOrder: state.repriceSortOrder || "desc",
          repriceLastLoadTimestamp: state.repriceLastLoadTimestamp || null,
          hideRepriced: state.hideRepriced ?? false,
        };
      }
    } catch (e) {
      console.warn("Помилка відновлення стану з localStorage:", e);
    }
    return {
      products: [],
      expandedProducts: new Set(),
      suppliers: [],
      ordersByProduct: {},
      repriceProducts: EMPTY_REPRICE_GROUPS,
      repriceTab: "cheaper",
      repriceSearch: "",
      repriceSortBy: "difference",
      repriceSortOrder: "desc",
      repriceLastLoadTimestamp: null,
      hideRepriced: false,
    };
  };

  const initialState = loadStateFromStorage();
  const [mainTab, setMainTab] = useState("purchases");
  const [products, setProducts] = useState(initialState.products);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState("brand");
  const [sortOrder, setSortOrder] = useState("asc");
  const [expandedProducts, setExpandedProducts] = useState(initialState.expandedProducts);
  const [suppliers, setSuppliers] = useState(initialState.suppliers);
  const [ordersByProduct, setOrdersByProduct] = useState(initialState.ordersByProduct);
  const [clearingMarks, setClearingMarks] = useState(false);
  const [repriceTab, setRepriceTab] = useState(initialState.repriceTab);
  const [repriceProducts, setRepriceProducts] = useState(initialState.repriceProducts);
  const [repriceLoading, setRepriceLoading] = useState(false);
  const [repriceSearch, setRepriceSearch] = useState(initialState.repriceSearch);
  const [repriceSortBy, setRepriceSortBy] = useState(initialState.repriceSortBy);
  const [repriceSortOrder, setRepriceSortOrder] = useState(initialState.repriceSortOrder);
  const [repriceLastLoadTimestamp, setRepriceLastLoadTimestamp] = useState(initialState.repriceLastLoadTimestamp);
  const [repriceMarks, setRepriceMarks] = useState({});
  const [repriceMarksLoaded, setRepriceMarksLoaded] = useState(false);
  const [markingRepriceDocId, setMarkingRepriceDocId] = useState(null);
  const [clearingRepriceMarks, setClearingRepriceMarks] = useState(false);
  const [hideRepriced, setHideRepriced] = useState(initialState.hideRepriced);
  const [excludedBrands, setExcludedBrands] = useState([]);
  const [excludedBrandInput, setExcludedBrandInput] = useState("");
  const [savingExcludedBrands, setSavingExcludedBrands] = useState(false);
  const [exclusionsLoaded, setExclusionsLoaded] = useState(false);

  // Стан модалки створення/редагування замовлення
  const [orderModalProduct, setOrderModalProduct] = useState(null);
  const [orderForm, setOrderForm] = useState({
    supplierId: "",
    quantity: "",
    price: "",
    currency: "EUR",
  });

  // Збереження стану в localStorage
  const saveStateToStorage = useCallback((state) => {
    try {
      const stateToSave = {
        products: state.products,
        expandedProducts: Array.from(state.expandedProducts),
        suppliers: state.suppliers,
        ordersByProduct: state.ordersByProduct,
        repriceProducts: state.repriceProducts,
        repriceTab: state.repriceTab,
        repriceSearch: state.repriceSearch,
        repriceSortBy: state.repriceSortBy,
        repriceSortOrder: state.repriceSortOrder,
        repriceLastLoadTimestamp: state.repriceLastLoadTimestamp,
        hideRepriced: state.hideRepriced,
        lastLoadTimestamp: state.lastLoadTimestamp ?? Date.now(),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stateToSave));
    } catch (e) {
      console.warn("Помилка збереження стану в localStorage:", e);
    }
  }, []);

  // Ефект для збереження стану при зміні
  useEffect(() => {
    saveStateToStorage({
      products,
      expandedProducts,
      suppliers,
      ordersByProduct,
      repriceProducts,
      repriceTab,
      repriceSearch,
      repriceSortBy,
      repriceSortOrder,
      repriceLastLoadTimestamp,
      hideRepriced,
    });
  }, [
    products,
    expandedProducts,
    suppliers,
    ordersByProduct,
    repriceProducts,
    repriceTab,
    repriceSearch,
    repriceSortBy,
    repriceSortOrder,
    repriceLastLoadTimestamp,
    hideRepriced,
    saveStateToStorage,
  ]);

  // Завантаження товарів для закупівлі
  const loadPurchases = useCallback(async () => {
    setLoading(true);
    setStatus?.(null);
    try {
      const productsCol = collection(db, PRODUCTS_PATH);
      // Читаємо всі товари без обмеження (може бути багато Firestore reads)
      const q = query(productsCol, orderBy("brand"));
      const snap = await getDocs(q);
      
      const allProducts = [];
      snap.forEach((doc) => {
        const data = doc.data();
        
        // Читаємо minStock тільки з кореня продукту
        const minStock = data.minStock;
        
        // Якщо немає minStock в корені або він не число, пропускаємо товар
        if (minStock == null || !Number.isFinite(minStock)) return;
        
        if (!data.offers || !Array.isArray(data.offers)) return;
        
        const warehouseOffer = data.offers.find(o => o.supplier === "Мій склад");
        if (!warehouseOffer) return;
        
        const stock = warehouseOffer.stock || 0;
        
        if (stock < minStock) {
          const retailPrice = warehouseOffer.publicPrices?.["роздріб"] || 0;
          const incomingPrice = getIncomingFromRetail(retailPrice);
          
          // Формуємо список пропозицій постачальників (крім "Мій склад")
          const supplierOffers = data.offers
            .filter(o => o.supplier !== "Мій склад")
            .map(offer => {
              const offerRetail = offer.publicPrices?.["роздріб"] || 0;
              const offerIncoming = getIncomingFromRetail(offerRetail);
              return {
                supplier: offer.supplier,
                stock: offer.stock || 0,
                retailPrice: offerRetail,
                incomingPrice: offerIncoming,
              };
            })
            .filter(o => o.retailPrice > 0)
            .sort((a, b) => a.retailPrice - b.retailPrice); // Сортуємо за роздрібною ціною
          
          allProducts.push({
            docId: doc.id,
            brand: data.brand,
            id: data.id,
            name: data.name,
            stock,
            minStock,
            incomingPrice,
            lastSupplier: data.lastSupplier || "—",
            supplierOffers, // Всі пропозиції постачальників (крім "Мій склад"), відсортовані
          });
        }
      });
      
      setProducts(allProducts);
      // Очищаємо все при новому завантаженні
      setExpandedProducts(new Set());
      setSearchQuery("");
      setSortBy("brand");
      setSortOrder("asc");
      setStatus?.({ 
        type: "success", 
        message: `Знайдено ${allProducts.length} товарів для закупівлі` 
      });

      // Завантажуємо постачальників та відкриті замовлення для знайдених товарів
      const productIdSet = new Set(allProducts.map(p => p.docId));

      const [suppliersSnap, ordersSnap] = await Promise.all([
        getDocs(collection(db, `/artifacts/${appId}/public/data/suppliers`)),
        getDocs(
          query(
            collection(db, `/artifacts/${appId}/public/data/purchaseOrders`),
            where("status", "==", "open")
          )
        ),
      ]);

      const suppliersList = suppliersSnap.docs.map(d => ({
        id: d.id,
        ...d.data(),
      }));

      const ordersMap = {};
      ordersSnap.forEach(d => {
        const data = d.data();
        const productDocId = data.productDocId;
        if (!productDocId || !productIdSet.has(productDocId)) return;
        const order = {
          id: d.id,
          ...data,
        };
        if (!ordersMap[productDocId]) ordersMap[productDocId] = [];
        ordersMap[productDocId].push(order);
      });

      setSuppliers(suppliersList);
      setOrdersByProduct(ordersMap);
    } catch (e) {
      console.error("Помилка завантаження товарів для закупівлі:", e);
      setStatus?.({ type: "error", message: `Помилка: ${e.message}` });
    } finally {
      setLoading(false);
    }
  }, [setStatus]);

  const loadExcludedBrands = useCallback(async () => {
    try {
      const snap = await getDoc(doc(db, REPRICE_EXCLUSIONS_PATH));
      const brands = snap.exists() && Array.isArray(snap.data()?.brands)
        ? snap.data().brands
        : [];
      const normalized = brands
        .map((brand) => String(brand || "").trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
      setExcludedBrands(normalized);
      setExclusionsLoaded(true);
      return normalized;
    } catch (e) {
      console.error("Помилка завантаження брендів-винятків:", e);
      setStatus?.({ type: "error", message: e?.message || "Не вдалося завантажити бренди-винятки" });
      return excludedBrands;
    }
  }, [excludedBrands, setStatus]);

  useEffect(() => {
    if (mainTab === "reprice" && !exclusionsLoaded) {
      loadExcludedBrands();
    }
  }, [mainTab, exclusionsLoaded, loadExcludedBrands]);

  const loadRepriceMarks = useCallback(async () => {
    try {
      const snap = await getDocs(collection(db, REPRICE_MARKS_PATH));
      const marks = {};
      snap.forEach((markDoc) => {
        marks[markDoc.id] = {
          id: markDoc.id,
          ...markDoc.data(),
        };
      });
      setRepriceMarks(marks);
      setRepriceMarksLoaded(true);
      return marks;
    } catch (e) {
      console.error("Помилка завантаження міток переоцінки:", e);
      setStatus?.({ type: "error", message: e?.message || "Не вдалося завантажити мітки переоцінки" });
      return repriceMarks;
    }
  }, [repriceMarks, setStatus]);

  useEffect(() => {
    if (mainTab === "reprice" && !repriceMarksLoaded) {
      loadRepriceMarks();
    }
  }, [mainTab, repriceMarksLoaded, loadRepriceMarks]);

  const saveExcludedBrands = useCallback(async (brands) => {
    setSavingExcludedBrands(true);
    try {
      const normalized = Array.from(
        new Map(
          brands
            .map((brand) => String(brand || "").trim())
            .filter(Boolean)
            .map((brand) => [normalizeBrand(brand), brand])
        ).values()
      ).sort((a, b) => a.localeCompare(b));

      await setDoc(
        doc(db, REPRICE_EXCLUSIONS_PATH),
        {
          brands: normalized,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      setExcludedBrands(normalized);
      setExclusionsLoaded(true);
      return normalized;
    } catch (e) {
      console.error("Помилка збереження брендів-винятків:", e);
      setStatus?.({ type: "error", message: e?.message || "Не вдалося зберегти бренди-винятки" });
      return null;
    } finally {
      setSavingExcludedBrands(false);
    }
  }, [setStatus]);

  const addExcludedBrand = async () => {
    const brand = excludedBrandInput.trim();
    if (!brand) return;
    const exists = excludedBrands.some((item) => normalizeBrand(item) === normalizeBrand(brand));
    if (exists) {
      setStatus?.({ type: "info", message: "Цей бренд вже є у винятках" });
      return;
    }
    const saved = await saveExcludedBrands([...excludedBrands, brand]);
    if (saved) {
      setExcludedBrandInput("");
      setStatus?.({ type: "success", message: `Бренд ${brand} додано у винятки переоцінки` });
    }
  };

  const removeExcludedBrand = async (brand) => {
    const saved = await saveExcludedBrands(
      excludedBrands.filter((item) => normalizeBrand(item) !== normalizeBrand(brand))
    );
    if (saved) {
      setStatus?.({ type: "success", message: `Бренд ${brand} видалено з винятків` });
    }
  };

  const markProductRepriced = async (product) => {
    if (!product?.docId) return;
    setMarkingRepriceDocId(product.docId);
    try {
      const markPayload = {
        productDocId: product.docId,
        productBrand: product.brand || "",
        productId: product.id || "",
        productName: product.name || "",
        status: "marked",
        markedAt: serverTimestamp(),
        markedAtMs: Date.now(),
        markedBy: auth.currentUser?.uid || null,
        markedByEmail: auth.currentUser?.email || null,
        warehouseIncomingPrice: product.warehouseIncomingPrice ?? null,
        bestSupplierIncomingPrice: product.bestSupplierOffer?.incomingPrice ?? null,
        difference: product.difference ?? null,
        differencePercent: product.differencePercent ?? null,
        supplierName: product.bestSupplierOffer?.supplier || null,
        supplierStock: product.bestSupplierOffer?.stock ?? null,
      };

      await setDoc(doc(db, `${REPRICE_MARKS_PATH}/${product.docId}`), markPayload, { merge: true });
      setRepriceMarks((prev) => ({
        ...prev,
        [product.docId]: {
          id: product.docId,
          ...markPayload,
        },
      }));
      setStatus?.({ type: "success", message: `Позначено переоціненим: ${product.brand || ""} ${product.id || ""}`.trim() });
    } catch (e) {
      console.error("Помилка встановлення мітки переоцінки:", e);
      setStatus?.({ type: "error", message: e?.message || "Не вдалося позначити товар переоціненим" });
    } finally {
      setMarkingRepriceDocId(null);
    }
  };

  const clearRepriceMarks = async () => {
    const markIds = Object.keys(repriceMarks);
    if (!markIds.length) {
      setStatus?.({ type: "info", message: "Немає міток переоцінки для очищення." });
      return;
    }
    if (!confirm(`Очистити всі мітки переоцінки? Буде видалено ${markIds.length} міток.`)) {
      return;
    }

    setClearingRepriceMarks(true);
    try {
      await Promise.all(
        markIds.map((markId) => deleteDoc(doc(db, `${REPRICE_MARKS_PATH}/${markId}`)))
      );
      setRepriceMarks({});
      setRepriceMarksLoaded(true);
      setStatus?.({ type: "success", message: `Очищено ${markIds.length} міток переоцінки.` });
    } catch (e) {
      console.error("Помилка очищення міток переоцінки:", e);
      setStatus?.({ type: "error", message: e?.message || "Не вдалося очистити мітки переоцінки" });
    } finally {
      setClearingRepriceMarks(false);
    }
  };

  const loadRepriceProducts = useCallback(async () => {
    setRepriceLoading(true);
    setStatus?.(null);
    try {
      const [brands] = await Promise.all([
        exclusionsLoaded ? Promise.resolve(excludedBrands) : loadExcludedBrands(),
        repriceMarksLoaded ? Promise.resolve(repriceMarks) : loadRepriceMarks(),
      ]);
      const excludedSet = new Set(brands.map(normalizeBrand));
      const q = query(collection(db, PRODUCTS_PATH), orderBy("brand"));
      const snap = await getDocs(q);
      const groups = { cheaper: [], expensive: [], unavailable: [] };
      let skippedByBrand = 0;

      snap.forEach((productDoc) => {
        const data = productDoc.data();
        const brand = data.brand || "";
        if (excludedSet.has(normalizeBrand(brand))) {
          skippedByBrand += 1;
          return;
        }
        if (!Array.isArray(data.offers)) return;

        const warehouseOffer = data.offers.find((offer) => offer.supplier === "Мій склад");
        if (!warehouseOffer) return;

        const warehouseStock = Number(warehouseOffer.stock || 0);
        if (!Number.isFinite(warehouseStock) || warehouseStock <= 0) return;

        const warehouseRetailPrice = Number(warehouseOffer.publicPrices?.["роздріб"] || 0);
        const warehouseIncomingPrice = getIncomingFromRetail(warehouseRetailPrice);
        if (warehouseIncomingPrice <= 0) return;

        const supplierOffers = data.offers
          .filter((offer) => offer.supplier && offer.supplier !== "Мій склад")
          .map((offer) => {
            const retailPrice = Number(offer.publicPrices?.["роздріб"] || 0);
            const incomingPrice = getIncomingFromRetail(retailPrice);
            return {
              supplier: offer.supplier,
              stock: Number(offer.stock || 0),
              retailPrice,
              incomingPrice,
            };
          })
          .filter((offer) => offer.stock > 0 && offer.retailPrice > 0 && offer.incomingPrice > 0)
          .sort((a, b) => a.incomingPrice - b.incomingPrice);

        const bestSupplierOffer = supplierOffers[0] || null;
        const difference = bestSupplierOffer
          ? bestSupplierOffer.incomingPrice - warehouseIncomingPrice
          : null;
        const differencePercent = difference != null
          ? (difference / warehouseIncomingPrice) * 100
          : null;

        const item = {
          docId: productDoc.id,
          brand,
          id: data.id,
          name: data.name,
          stock: warehouseStock,
          lastSupplier: data.lastSupplier || "—",
          warehouseRetailPrice,
          warehouseIncomingPrice,
          bestSupplierOffer,
          supplierOffers,
          difference,
          differencePercent,
        };

        if (!bestSupplierOffer) {
          groups.unavailable.push(item);
        } else if (difference > REPRICE_EPSILON) {
          groups.expensive.push(item);
        } else {
          groups.cheaper.push(item);
        }
      });

      Object.keys(groups).forEach((key) => {
        groups[key].sort((a, b) => {
          const aDiff = Math.abs(a.difference || 0);
          const bDiff = Math.abs(b.difference || 0);
          return bDiff - aDiff;
        });
      });

      setRepriceProducts(groups);
      setRepriceSearch("");
      setRepriceSortBy("difference");
      setRepriceSortOrder("desc");
      setRepriceLastLoadTimestamp(Date.now());
      setStatus?.({
        type: "success",
        message: `Переоцінка готова: дешевше або без змін ${groups.cheaper.length}, подорожчали ${groups.expensive.length}, немає в постачальників ${groups.unavailable.length}. Пропущено брендів-винятків: ${skippedByBrand}.`,
      });
    } catch (e) {
      console.error("Помилка моніторингу переоцінки:", e);
      setStatus?.({ type: "error", message: e?.message || "Не вдалося промоніторити переоцінку" });
    } finally {
      setRepriceLoading(false);
    }
  }, [excludedBrands, exclusionsLoaded, loadExcludedBrands, loadRepriceMarks, repriceMarks, repriceMarksLoaded, setStatus]);

  // Фільтрація та сортування
  const filteredAndSorted = useMemo(() => {
    let filtered = products;
    
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(p => {
        const orders = ordersByProduct[p.docId] || [];
        const ordersText = orders
          .map(o => `${o.supplierName || ""} ${o.quantity || ""} ${o.price || ""}`)
          .join(" ")
          .toLowerCase();
        return (
          p.brand.toLowerCase().includes(query) ||
          p.id.toLowerCase().includes(query) ||
          (p.name || "").toLowerCase().includes(query) ||
          ordersText.includes(query)
        );
      });
    }
    
    filtered = [...filtered].sort((a, b) => {
      let aVal, bVal;
      switch (sortBy) {
        case "brand":
          aVal = a.brand || "";
          bVal = b.brand || "";
          break;
        case "id":
          aVal = a.id || "";
          bVal = b.id || "";
          break;
        case "stock":
          aVal = a.stock;
          bVal = b.stock;
          break;
        case "minStock":
          aVal = a.minStock || 0;
          bVal = b.minStock || 0;
          break;
        case "price":
          aVal = a.incomingPrice;
          bVal = b.incomingPrice;
          break;
        default:
          return 0;
      }
      
      if (typeof aVal === "string") {
        return sortOrder === "asc" 
          ? aVal.localeCompare(bVal)
          : bVal.localeCompare(aVal);
      } else {
        return sortOrder === "asc" ? aVal - bVal : bVal - aVal;
      }
    });
    
    return filtered;
  }, [products, searchQuery, sortBy, sortOrder]);

  const filteredRepriceProducts = useMemo(() => {
    const source = repriceProducts[repriceTab] || [];
    const queryText = repriceSearch.trim().toLowerCase();
    let filtered = source;

    if (queryText) {
      filtered = source.filter((product) => {
        const offersText = (product.supplierOffers || [])
          .map((offer) => offer.supplier)
          .join(" ")
          .toLowerCase();
        return (
          String(product.brand || "").toLowerCase().includes(queryText) ||
          String(product.id || "").toLowerCase().includes(queryText) ||
          String(product.name || "").toLowerCase().includes(queryText) ||
          String(product.lastSupplier || "").toLowerCase().includes(queryText) ||
          offersText.includes(queryText)
        );
      });
    }

    if (hideRepriced) {
      filtered = filtered.filter((product) => !repriceMarks[product.docId]);
    }

    return [...filtered].sort((a, b) => {
      let aVal;
      let bVal;
      switch (repriceSortBy) {
        case "brand":
          aVal = a.brand || "";
          bVal = b.brand || "";
          break;
        case "id":
          aVal = a.id || "";
          bVal = b.id || "";
          break;
        case "stock":
          aVal = a.stock || 0;
          bVal = b.stock || 0;
          break;
        case "warehousePrice":
          aVal = a.warehouseIncomingPrice || 0;
          bVal = b.warehouseIncomingPrice || 0;
          break;
        case "bestPrice":
          aVal = a.bestSupplierOffer?.incomingPrice || 0;
          bVal = b.bestSupplierOffer?.incomingPrice || 0;
          break;
        case "difference":
          aVal = Math.abs(a.differencePercent || 0);
          bVal = Math.abs(b.differencePercent || 0);
          break;
        default:
          return 0;
      }

      if (typeof aVal === "string") {
        return repriceSortOrder === "asc"
          ? aVal.localeCompare(bVal)
          : bVal.localeCompare(aVal);
      }
      return repriceSortOrder === "asc" ? aVal - bVal : bVal - aVal;
    });
  }, [hideRepriced, repriceMarks, repriceProducts, repriceSearch, repriceSortBy, repriceSortOrder, repriceTab]);

  const handleSort = (column) => {
    if (sortBy === column) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortBy(column);
      setSortOrder("asc");
    }
  };

  const getSortIcon = (column) => {
    if (sortBy !== column) return "↕️";
    return sortOrder === "asc" ? "↑" : "↓";
  };

  const handleRepriceSort = (column) => {
    if (repriceSortBy === column) {
      setRepriceSortOrder(repriceSortOrder === "asc" ? "desc" : "asc");
    } else {
      setRepriceSortBy(column);
      setRepriceSortOrder(column === "brand" || column === "id" ? "asc" : "desc");
    }
  };

  const getRepriceSortIcon = (column) => {
    if (repriceSortBy !== column) return "↕️";
    return repriceSortOrder === "asc" ? "↑" : "↓";
  };

  const toggleExpand = (docId) => {
    setExpandedProducts(prev => {
      const next = new Set(prev);
      if (next.has(docId)) {
        next.delete(docId);
      } else {
        next.add(docId);
      }
      return next;
    });
  };

  // Форматування назви постачальника (обрізати довгі)
  const formatSupplierName = (name) => {
    if (!name) return "—";
    return name.length > 15 ? name.substring(0, 12) + "..." : name;
  };

  const copyArticle = async (article) => {
    if (!article) return;
    try {
      await navigator.clipboard.writeText(String(article));
      setStatus?.({ type: "success", message: "Артикул скопійовано" });
    } catch (e) {
      setStatus?.({ type: "error", message: "Не вдалося скопіювати" });
    }
  };

  // Допоміжні функції для замовлень
  const getOrdersForProduct = (productDocId) => {
    return ordersByProduct[productDocId] || [];
  };

  const getOrderedQty = (productDocId) => {
    const orders = getOrdersForProduct(productDocId);
    return orders.reduce((sum, o) => sum + Number(o.quantity || 0), 0);
  };

  const isCoveredByOrders = (product) => {
    if (product.minStock == null) return false;
    const orderedQty = getOrderedQty(product.docId);
    return product.stock + orderedQty >= product.minStock;
  };

  const openOrderModal = (product) => {
    setOrderModalProduct(product);
    const orderedQty = getOrderedQty(product.docId);
    const needed = (product.minStock ?? 0) - (product.stock ?? 0) - orderedQty;
    const quantity = String(Math.max(1, needed));
    const price =
      product.incomingPrice != null && product.incomingPrice > 0
        ? Number(product.incomingPrice).toFixed(2)
        : "";
    setOrderForm({
      supplierId: "",
      quantity,
      price,
      currency: "EUR",
    });
  };

  const closeOrderModal = () => {
    setOrderModalProduct(null);
  };

  const handleCreateOrder = async () => {
    if (!orderModalProduct) return;
    const supplier = suppliers.find(s => s.id === orderForm.supplierId);
    const quantity = Number(orderForm.quantity);
    const price = Number(orderForm.price);
    const isQuickOrder = !orderForm.supplierId;
    const resolvedSupplierId = supplier?.id || orderForm.supplierId || "quick";
    const resolvedSupplierName = supplier?.name || orderForm.supplierId || "quick";
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setStatus?.({ type: "error", message: "Кількість має бути > 0" });
      return;
    }
    if (!Number.isFinite(price) || price < 0) {
      setStatus?.({ type: "error", message: "Некоректна ціна" });
      return;
    }

    try {
      const ref = await addDoc(
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

      setOrdersByProduct(prev => {
        const next = { ...prev };
        const existing = next[orderModalProduct.docId] || [];
        next[orderModalProduct.docId] = [
          ...existing,
          {
            id: ref.id,
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
          },
        ];
        return next;
      });

      setStatus?.({
        type: "success",
        message: `Замовлення створено: ${resolvedSupplierName}, ${quantity} шт.`,
      });
      closeOrderModal();
    } catch (e) {
      console.error("Помилка створення замовлення для закупівлі:", e);
      setStatus?.({
        type: "error",
        message: e?.message || "Помилка створення замовлення",
      });
    }
  };

  const handleCancelOrder = async (order) => {
    if (!order?.id) return;
    if (!confirm("Скасувати це замовлення?")) return;
    try {
      await updateDoc(
        doc(db, `/artifacts/${appId}/public/data/purchaseOrders/${order.id}`),
        {
          status: "cancelled",
          cancelledAt: serverTimestamp(),
        }
      );

      setOrdersByProduct(prev => {
        const next = { ...prev };
        const list = next[order.productDocId] || [];
        next[order.productDocId] = list.filter(o => o.id !== order.id);
        return next;
      });

      setStatus?.({
        type: "success",
        message: "Замовлення скасовано",
      });
    } catch (e) {
      console.error("Помилка скасування замовлення для закупівлі:", e);
      setStatus?.({
        type: "error",
        message: e?.message || "Помилка скасування замовлення",
      });
    }
  };

  const handleClearPurchaseMarks = async () => {
    const orders = Object.values(ordersByProduct).flat().filter(o => o?.id);
    if (!orders.length) {
      setStatus?.({ type: "info", message: "Немає позначок для видалення." });
      return;
    }

    if (!confirm(`Видалити всі позначки закупленого товару? Буде скасовано ${orders.length} відкритих замовлень.`)) {
      return;
    }

    setClearingMarks(true);
    try {
      await Promise.all(
        orders.map((order) =>
          updateDoc(
            doc(db, `/artifacts/${appId}/public/data/purchaseOrders/${order.id}`),
            {
              status: "cancelled",
              cancelledAt: serverTimestamp(),
            }
          )
        )
      );

      setOrdersByProduct({});
      setStatus?.({
        type: "success",
        message: `Позначки видалено. Скасовано ${orders.length} замовлень.`,
      });
    } catch (e) {
      console.error("Помилка видалення позначок закупок:", e);
      setStatus?.({
        type: "error",
        message: e?.message || "Не вдалося видалити позначки",
      });
    } finally {
      setClearingMarks(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow p-3 sm:p-4">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-4">
        <h2 className="text-lg font-semibold">ЗАКУПКИ</h2>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="text-xs text-amber-600 bg-amber-50 px-3 py-1.5 rounded border border-amber-200">
            ⚠️ Читає всі товари з бази (може бути багато reads)
          </div>
          {mainTab === "purchases" && (
            <>
              <button
                className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                onClick={loadPurchases}
                disabled={loading}
              >
                {loading ? "Завантаження..." : "Завантажити"}
              </button>
              <button
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg disabled:opacity-50"
                onClick={handleClearPurchaseMarks}
                disabled={clearingMarks || !Object.values(ordersByProduct).some(list => (list || []).length > 0)}
                title="Скасувати всі відкриті замовлення з поточного списку закупок"
              >
                {clearingMarks ? "Видалення..." : "Видалити позначки"}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="mb-4">
        <Tabs
          items={[
            { key: "purchases", label: "Закупки" },
            { key: "reprice", label: "Переоцінка" },
          ]}
          value={mainTab}
          onChange={setMainTab}
        />
      </div>

      {mainTab === "purchases" && (
        <>
      {products.length > 0 && (
        <div className="mb-4">
          <input
            className="p-2 border rounded w-full max-w-md"
            placeholder="Пошук: бренд, артикул або назва"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      )}

      {loading && (
        <div className="text-center py-8 text-gray-500">Завантаження...</div>
      )}

      {!loading && products.length === 0 && (
        <div className="text-center py-8 text-gray-500">
          Натисніть "Завантажити" для аналізу товарів для закупівлі
        </div>
      )}

      {!loading && products.length > 0 && (
        <>
          <div className="mb-2 text-sm text-gray-600">
            Знайдено: {filteredAndSorted.length} товарів
            {filteredAndSorted.length !== products.length && ` (з ${products.length})`}
          </div>
          
          <div className="overflow-x-auto border rounded-xl">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th 
                    className="px-3 py-2 text-left cursor-pointer hover:bg-gray-100"
                    onClick={() => handleSort("brand")}
                  >
                    Бренд {getSortIcon("brand")}
                  </th>
                  <th 
                    className="px-3 py-2 text-left cursor-pointer hover:bg-gray-100"
                    onClick={() => handleSort("id")}
                  >
                    Артикул {getSortIcon("id")}
                  </th>
                  <th className="px-3 py-2 text-left">Назва</th>
                  <th 
                    className="px-3 py-2 text-left cursor-pointer hover:bg-gray-100"
                    onClick={() => handleSort("stock")}
                  >
                    Кількість {getSortIcon("stock")}
                  </th>
                  <th 
                    className="px-3 py-2 text-left cursor-pointer hover:bg-gray-100"
                    onClick={() => handleSort("price")}
                  >
                    Вхідна ціна {getSortIcon("price")}
                  </th>
                  <th className="px-3 py-2 text-left">Пропозиції</th>
                  <th className="px-3 py-2 text-left">Замовлення</th>
                </tr>
              </thead>
              <tbody>
                {filteredAndSorted.map((product) => {
                  const isExpanded = expandedProducts.has(product.docId);
                  const topOffers = product.supplierOffers?.slice(0, 3) || [];
                  const hasMore = (product.supplierOffers?.length || 0) > 3;
                  const allOffers = product.supplierOffers || [];
                  const orders = getOrdersForProduct(product.docId);
                  const orderedQty = getOrderedQty(product.docId);
                  const covered = isCoveredByOrders(product);
                  
                  return (
                    <React.Fragment key={product.docId}>
                      <tr className={`border-t ${orders.length ? "bg-yellow-50" : ""}`}>
                        <td className="px-3 py-2 whitespace-nowrap">{product.brand}</td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <div className="flex items-center gap-1">
                            <span>{product.id}</span>
                            <button
                              type="button"
                              className="p-0.5 rounded hover:bg-slate-200 text-slate-400 hover:text-slate-600 transition-colors"
                              title="Копіювати артикул"
                              onClick={() => copyArticle(product.id)}
                            >
                              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                              </svg>
                            </button>
                          </div>
                        </td>
                        <td className="px-3 py-2">{product.name || "—"}</td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <div className="flex flex-col">
                            <span className={product.stock < product.minStock ? "text-red-600 font-medium" : ""}>
                              {product.stock}
                              {product.minStock != null && ` min(${product.minStock})`}
                            </span>
                            {orderedQty > 0 && (
                              <span className="text-xs text-indigo-700">
                                Замовлено: {orderedQty}
                              </span>
                            )}
                            {covered && (
                              <span className="text-xs text-emerald-700">
                                Замовлено, очікується
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <div className="flex flex-col">
                            <span>
                              {product.incomingPrice > 0 
                                ? product.incomingPrice.toFixed(2) 
                                : "—"}
                            </span>
                            {product.lastSupplier && product.lastSupplier !== "—" && (
                              <span className="text-xs text-gray-500">
                                {formatSupplierName(product.lastSupplier)}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 align-top">
                          {topOffers.length > 0 ? (
                            <div className="space-y-1">
                              {topOffers.map((offer, idx) => (
                                <div key={idx} className="text-xs text-gray-700">
                                  <span className="font-medium">{formatSupplierName(offer.supplier)}</span>
                                  {": "}
                                  <span className="text-blue-600">{offer.incomingPrice.toFixed(2)}</span>
                                  {offer.stock > 0 && (
                                    <span className="text-gray-500"> ({offer.stock})</span>
                                  )}
                                </div>
                              ))}
                              {hasMore && (
                                <button
                                  className="text-xs text-indigo-600 hover:text-indigo-800 underline"
                                  onClick={() => toggleExpand(product.docId)}
                                >
                                  {isExpanded ? "Згорнути" : `+${allOffers.length - 3} більше`}
                                </button>
                              )}
                            </div>
                          ) : (
                            <span className="text-gray-400 text-xs">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 align-top">
                          <div className="space-y-1 text-xs">
                            {orders.length > 0 ? (
                              orders.map((o) => (
                                <div key={o.id} className="flex items-center gap-2 text-gray-700">
                                  <span className="font-medium">
                                    {formatSupplierName(o.supplierName || o.supplierId)}
                                  </span>
                                  <span>{o.quantity} шт.</span>
                                  <span className="text-blue-600">
                                    {Number(o.price || 0).toFixed(2)}
                                  </span>
                                  <button
                                    className="text-red-500 hover:text-red-700"
                                    title="Скасувати замовлення"
                                    onClick={() => handleCancelOrder(o)}
                                  >
                                    ✕
                                  </button>
                                </div>
                              ))
                            ) : (
                              <span className="text-gray-400">Немає</span>
                            )}
                            <button
                              className="mt-1 inline-flex items-center px-2 py-1 rounded bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 text-xs"
                              onClick={() => openOrderModal(product)}
                              disabled={!suppliers.length}
                            >
                              + Замовити
                            </button>
                          </div>
                        </td>
                      </tr>
                      {/* Розгорнутий рядок з усіма пропозиціями */}
                      {isExpanded && hasMore && (
                        <tr className="border-t bg-gray-50">
                          <td colSpan="6" className="px-3 py-2">
                            <div className="text-xs space-y-1">
                              <div className="font-medium mb-2 text-gray-700">Всі пропозиції постачальників:</div>
                              {allOffers.slice(3).map((offer, idx) => (
                                <div key={idx} className="flex items-center gap-2 text-gray-700">
                                  <span className="font-medium w-32">{offer.supplier}</span>
                                  <span className="text-blue-600 w-20">Вхідна: {offer.incomingPrice.toFixed(2)}</span>
                                  <span className="text-gray-500 w-16">Роздріб: {offer.retailPrice.toFixed(2)}</span>
                                  {offer.stock > 0 && (
                                    <span className="text-gray-600">Наявність: {offer.stock}</span>
                                  )}
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
        </>
      )}

      {mainTab === "reprice" && (
        <div className="space-y-4">
          <div className="border rounded-xl p-3 bg-slate-50">
            <div className="flex flex-col lg:flex-row lg:items-end gap-3 justify-between">
              <div className="space-y-2 flex-1">
                <div>
                  <h3 className="font-semibold text-slate-800">Бренди-винятки</h3>
                  <p className="text-sm text-slate-500">
                    Ці бренди не потрапляють у моніторинг переоцінки.
                  </p>
                </div>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    className="p-2 border rounded-lg w-full sm:max-w-sm bg-white"
                    placeholder="Назва бренду"
                    value={excludedBrandInput}
                    onChange={(e) => setExcludedBrandInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addExcludedBrand();
                      }
                    }}
                  />
                  <button
                    className="px-4 py-2 bg-slate-800 hover:bg-slate-900 text-white rounded-lg disabled:opacity-50"
                    onClick={addExcludedBrand}
                    disabled={savingExcludedBrands || !excludedBrandInput.trim()}
                  >
                    {savingExcludedBrands ? "Збереження..." : "Додати виняток"}
                  </button>
                </div>
                {excludedBrands.length > 0 ? (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {excludedBrands.map((brand) => (
                      <span
                        key={brand}
                        className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white border text-sm text-slate-700"
                      >
                        {brand}
                        <button
                          className="text-slate-400 hover:text-red-600"
                          onClick={() => removeExcludedBrand(brand)}
                          disabled={savingExcludedBrands}
                          title="Видалити виняток"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="text-sm text-slate-400">Список винятків порожній.</div>
                )}
              </div>
              <button
                className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                onClick={loadRepriceProducts}
                disabled={repriceLoading}
              >
                {repriceLoading ? "Моніторинг..." : "Промоніторити ціни"}
              </button>
            </div>
          </div>

          <Tabs
            items={[
              { key: "cheaper", label: `Дешевше (${getRepriceGroupCount(repriceProducts, "cheaper")})` },
              { key: "expensive", label: `Подорожчали (${getRepriceGroupCount(repriceProducts, "expensive")})` },
              { key: "unavailable", label: `Немає в постачальників (${getRepriceGroupCount(repriceProducts, "unavailable")})` },
            ]}
            value={repriceTab}
            onChange={setRepriceTab}
          />

          {Object.values(repriceProducts).some((list) => list.length > 0) && (
            <div className="flex flex-col sm:flex-row sm:items-center gap-3 flex-wrap">
              <input
                className="p-2 border rounded w-full max-w-md"
                placeholder="Пошук: бренд, артикул, назва або постачальник"
                value={repriceSearch}
                onChange={(e) => setRepriceSearch(e.target.value)}
              />
              <label className="inline-flex items-center gap-2 text-sm text-slate-600">
                <input
                  type="checkbox"
                  checked={hideRepriced}
                  onChange={(e) => setHideRepriced(e.target.checked)}
                />
                Сховати переоцінені
              </label>
              <button
                className="px-3 py-2 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm disabled:opacity-50"
                onClick={clearRepriceMarks}
                disabled={clearingRepriceMarks || Object.keys(repriceMarks).length === 0}
                title="Видалити всі мітки переоцінки"
              >
                {clearingRepriceMarks
                  ? "Очищення..."
                  : `Очистити мітки (${Object.keys(repriceMarks).length})`}
              </button>
            </div>
          )}

          {repriceLoading && (
            <div className="text-center py-8 text-gray-500">Моніторинг переоцінки...</div>
          )}

          {!repriceLoading && !Object.values(repriceProducts).some((list) => list.length > 0) && (
            <div className="text-center py-8 text-gray-500">
              Натисніть "Промоніторити ціни", щоб порівняти товари на "Мій склад" із пропозиціями постачальників.
            </div>
          )}

          {!repriceLoading && Object.values(repriceProducts).some((list) => list.length > 0) && (
            <>
              <div className="text-sm text-gray-600">
                Знайдено: {filteredRepriceProducts.length} товарів
                {filteredRepriceProducts.length !== (repriceProducts[repriceTab]?.length || 0) &&
                  ` (з ${repriceProducts[repriceTab]?.length || 0})`}
              </div>
              <div className="overflow-x-auto border rounded-xl">
                <table className="min-w-[980px] w-full table-fixed text-sm">
                  <colgroup>
                    <col className="w-[9%]" />
                    <col className="w-[12%]" />
                    <col className="w-[24%]" />
                    <col className="w-[7%]" />
                    <col className="w-[11%]" />
                    <col className="w-[13%]" />
                    <col className="w-[8%]" />
                    <col className="w-[9%]" />
                    <col className="w-[7%]" />
                  </colgroup>
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-2 text-left cursor-pointer hover:bg-gray-100" onClick={() => handleRepriceSort("brand")}>
                        Бренд {getRepriceSortIcon("brand")}
                      </th>
                      <th className="px-3 py-2 text-left cursor-pointer hover:bg-gray-100" onClick={() => handleRepriceSort("id")}>
                        Артикул {getRepriceSortIcon("id")}
                      </th>
                      <th className="px-3 py-2 text-left">Назва</th>
                      <th className="px-3 py-2 text-left cursor-pointer hover:bg-gray-100" onClick={() => handleRepriceSort("stock")}>
                        Залишок {getRepriceSortIcon("stock")}
                      </th>
                      <th className="px-3 py-2 text-left cursor-pointer hover:bg-gray-100" onClick={() => handleRepriceSort("warehousePrice")}>
                        <span className="block leading-tight">Вхідна</span>
                        <span className="text-[11px] font-normal text-slate-500">Мій склад {getRepriceSortIcon("warehousePrice")}</span>
                      </th>
                      <th className="px-3 py-2 text-left cursor-pointer hover:bg-gray-100" onClick={() => handleRepriceSort("bestPrice")}>
                        <span className="block leading-tight">Краща</span>
                        <span className="text-[11px] font-normal text-slate-500">пропозиція {getRepriceSortIcon("bestPrice")}</span>
                      </th>
                      <th className="px-3 py-2 text-left cursor-pointer hover:bg-gray-100" onClick={() => handleRepriceSort("difference")}>
                        Різниця {getRepriceSortIcon("difference")}
                      </th>
                      <th className="px-3 py-2 text-left">Статус</th>
                      <th className="px-3 py-2 text-left">Топ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRepriceProducts.map((product) => {
                      const isCheaper = product.difference != null && product.difference < 0;
                      const topOffers = product.supplierOffers?.slice(0, 3) || [];
                      const repriceMark = repriceMarks[product.docId];
                      const repriceMarkStale = isRepriceMarkStale(repriceMark);
                      return (
                        <tr
                          key={product.docId}
                          className={[
                            "border-t",
                            repriceMark
                              ? repriceMarkStale
                                ? "bg-amber-50"
                                : "bg-emerald-50"
                              : "",
                          ].join(" ")}
                        >
                          <td className="px-3 py-2 whitespace-nowrap truncate">{product.brand || "—"}</td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <div className="flex items-center gap-1">
                              <span className="truncate">{product.id || "—"}</span>
                              {product.id && (
                                <button
                                  type="button"
                                  className="p-0.5 rounded hover:bg-slate-200 text-slate-400 hover:text-slate-600 transition-colors"
                                  title="Копіювати артикул"
                                  onClick={() => copyArticle(product.id)}
                                >
                                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                  </svg>
                                </button>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <div className="line-clamp-2" title={product.name || ""}>
                              {product.name || "—"}
                            </div>
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">{product.stock}</td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <div className="flex flex-col">
                              <span className="font-medium">
                                {product.warehouseIncomingPrice > 0 ? product.warehouseIncomingPrice.toFixed(2) : "—"}
                              </span>
                              <span className="text-[11px] leading-tight text-slate-500">
                                {product.lastSupplier || "—"}
                              </span>
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            {product.bestSupplierOffer ? (
                              <div className="flex flex-col">
                                <span className="font-medium truncate">{formatSupplierName(product.bestSupplierOffer.supplier)}</span>
                                <span className="text-blue-600">{product.bestSupplierOffer.incomingPrice.toFixed(2)}</span>
                                <span className="text-xs text-slate-500">наявність: {product.bestSupplierOffer.stock}</span>
                              </div>
                            ) : (
                              <span className="text-xs text-slate-400">немає</span>
                            )}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            {product.difference != null ? (
                              <div className={isCheaper ? "text-emerald-700" : "text-red-700"}>
                                <div>{isCheaper ? "" : "+"}{product.difference.toFixed(2)}</div>
                                <div className="text-xs">
                                  {isCheaper ? "" : "+"}{product.differencePercent.toFixed(1)}%
                                </div>
                              </div>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-start gap-2">
                              {repriceMark ? (
                                <div className="flex min-w-0 flex-col">
                                  <span
                                    className={[
                                      "inline-flex w-fit px-2 py-0.5 rounded-full border text-xs font-medium",
                                      repriceMarkStale
                                        ? "bg-amber-50 text-amber-700 border-amber-200"
                                        : "bg-emerald-50 text-emerald-700 border-emerald-200",
                                    ].join(" ")}
                                  >
                                    {repriceMarkStale ? "Переоцінено давно" : "Переоцінено"}
                                  </span>
                                  <span className="text-xs text-slate-500 mt-1 truncate">
                                    {formatDateTime(repriceMark.markedAtMs || repriceMark.markedAt)}
                                  </span>
                                  {repriceMarkStale && (
                                    <span className="text-xs text-amber-600 mt-0.5">
                                      старше {REPRICE_MARK_STALE_DAYS} днів
                                    </span>
                                  )}
                                </div>
                              ) : (
                                <span className="text-slate-400 text-xs mt-1">ні</span>
                              )}
                              <button
                                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border border-emerald-200 bg-emerald-50 text-sm font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                                onClick={() => markProductRepriced(product)}
                                disabled={markingRepriceDocId === product.docId}
                                title={repriceMark ? "Оновити мітку переоцінки" : "Позначити переоціненим"}
                              >
                                {markingRepriceDocId === product.docId ? "…" : repriceMark ? "↻" : "✓"}
                              </button>
                            </div>
                          </td>
                          <td className="px-3 py-2 align-top">
                            {topOffers.length > 0 ? (
                              <div className="space-y-1">
                                {topOffers.map((offer, idx) => (
                                  <div key={`${offer.supplier}-${idx}`} className="truncate text-xs text-gray-700" title={`${formatSupplierName(offer.supplier)}: ${offer.incomingPrice.toFixed(2)} (${offer.stock})`}>
                                    <span className="font-medium">{formatSupplierName(offer.supplier)}</span>
                                    {": "}
                                    <span className="text-blue-600">{offer.incomingPrice.toFixed(2)}</span>
                                    <span className="text-gray-500"> ({offer.stock})</span>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <span className="text-gray-400 text-xs">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {filteredRepriceProducts.length === 0 && (
                      <tr>
                        <td className="px-3 py-8 text-center text-gray-500" colSpan={9}>
                          Немає товарів у цій вкладці
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* Модалка створення замовлення */}
      {orderModalProduct && (
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
                  {orderModalProduct.name || "—"}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  На складі: {orderModalProduct.stock}{" "}
                  {orderModalProduct.minStock != null &&
                    `(min ${orderModalProduct.minStock})`}
                </div>
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-slate-700">
                  Постачальник
                </label>
                <select
                  className="w-full border rounded-lg px-3 py-2"
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
                  <label className="block text-sm font-medium text-slate-700">
                    Кількість
                  </label>
                  <input
                    type="number"
                    min="1"
                    className="w-full border rounded-lg px-3 py-2"
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
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <label className="block text-sm font-medium text-slate-700">
                      Ціна ({orderForm.currency === "UAH" ? "ГРН" : "EUR"})
                    </label>
                    <select
                      className="text-xs border rounded px-2 py-1 text-slate-600"
                      value={orderForm.currency}
                      onChange={(e) =>
                        setOrderForm((prev) => ({
                          ...prev,
                          currency: e.target.value,
                        }))
                      }
                    >
                      <option value="EUR">EUR</option>
                      <option value="UAH">ГРН</option>
                    </select>
                  </div>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    className="w-full border rounded-lg px-3 py-2"
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
