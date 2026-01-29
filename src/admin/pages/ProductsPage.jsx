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
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../../firebase-config";
import Tabs from "../components/Tabs.jsx";
import { useClientSearch } from "../hooks/useClientSearch.js";

const appId = import.meta.env.VITE_PROJECT_ID;
if (!appId) {
  console.error("VITE_PROJECT_ID environment variable is required");
}
const MAX_PRODUCTS = 300;

/**
 * Admin › ProductsPage
 * - Завантаження тільки по кнопці "Пошук" (без автоматичної загрузки)
 * - Фільтри: бренд (серверний, через кеш брендів), артикул (серверний), постачальник (клієнтська дорізка)
 * - Ліміт 300 товарів
 * - Відображення: один рядок на offer з об'єднаними комірками для бренду, артикулу та назви (rowspan)
 * - Сортування offers: спочатку "Мій склад", потім партнери по зростанню ціни
 * - Перемикач цінової політики (роздріб, ціна 1, ціна 2, ціна 3, ціна опт)
 */
export default function ProductsPage() {
  // Фільтри
  const [selectedBrand, setSelectedBrand] = useState(""); // ID бренду з кешу
  const [brandSearch, setBrandSearch] = useState(""); // Пошук по назві бренду
  const [articleSearch, setArticleSearch] = useState("");
  const [selectedSupplier, setSelectedSupplier] = useState("all"); // Клієнтська фільтрація
  const [priceType, setPriceType] = useState("роздріб"); // Цінова політика
  
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

  // Кеш товарів по брендах (ключ: brandId, значення: { products })
  const brandCacheRef = useRef(new Map());
  
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
        // Сортуємо групи: спочатку category, потім preset
        groups.sort((a, b) => {
          const aType = a.groupType || (a.filterType === 'category' ? 'category' : 'preset');
          const bType = b.groupType || (b.filterType === 'category' ? 'category' : 'preset');
          if (aType !== bType) {
            return aType === 'category' ? -1 : 1;
          }
          return String(a.name || a.id).localeCompare(String(b.name || b.id));
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

  // Функція нормалізації артикулу (як в shared.js)
  const normalizeArticle = (v) => {
    const s = String(v ?? "").trim().toUpperCase();
    return s.replace(/\s+/g, "").replace(/[^\w.-]/g, "");
  };

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
    
    // 2. Беремо ціну з градації
    let basePrice = offer.publicPrices[priceGroup];
    if (!basePrice || basePrice <= 0) {
      // Fallback на роздрібну, якщо градації немає
      basePrice = offer.publicPrices.роздріб;
      if (!basePrice || basePrice <= 0) return 0;
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
    // Використовуємо publicPrices для всіх постачальників (включаючи "Мій склад")
    return publicPrices[priceType] ?? null;
  }, [priceType]);

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
      
      // Якщо немає артикулу - шукаємо по бренду (як раніше)
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
      
      // Сортування
      clauses.push(orderBy("brand"));
      clauses.push(orderBy("name"));
      
      // Ліміт
      clauses.push(limit(MAX_PRODUCTS));
      
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
  }, [selectedBrand, articleSearch, brandsList]);

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
          supplier: offer.supplier || "",
          stock: offer.stock ?? 0,
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
    setBrandSearch("");
    setArticleSearch("");
    setSelectedSupplier("all");
    setProducts([]);
    setDisplayRows([]);
    setSelectedClient(null);
    setClientSearch("");
    setClientSearchResults([]);
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
  ];
  
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
                                setSelectedGroup(group.id);
                              }
                            }
                          } else if (groupType === 'category') {
                            // Для category-груп - очищаємо вибір (категорії не підтримуються в адмін панелі)
                            setSelectedGroup(null);
                            setSelectedBrand("");
                            setExpandedGroup(null);
                            setArticleSearch("");
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
                          {group.brands.map((brandName, idx) => {
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
                                  setSelectedBrand(isBrandSelected ? "" : brand.id);
                                  setSelectedGroup(null);
                                  setExpandedGroup(null);
                                  setArticleSearch("");
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
                            setSelectedBrand(isSelected ? "" : b.id);
                            setSelectedGroup(null);
                            setExpandedGroup(null);
                            setArticleSearch("");
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
                        // Використовуємо ціну "від лиця" клієнта
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
                        // Стандартна ціна
                        price = getPrice(row.publicPrices, row.supplier);
                      }
                      
                      return price !== null && price !== undefined
                        ? typeof price === "number"
                          ? price.toFixed(2)
                          : String(price)
                        : "—";
                    })()}
                  </td>
                  {offerIndex === 0 && (
                    <td rowSpan={rowspan} className="px-3 py-2 align-top">
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
                    </td>
                  )}
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
    </div>
  );
}
