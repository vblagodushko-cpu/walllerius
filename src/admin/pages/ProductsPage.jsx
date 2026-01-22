import React, { useCallback, useEffect, useMemo, useState, useRef } from "react";
import {
  collection,
  getDocs,
  query,
  orderBy,
  where,
  limit,
  startAt,
  endAt,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../../firebase-config";

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
  const [clientSearch, setClientSearch] = useState(""); // Пошук клієнта
  const [clientSearchResults, setClientSearchResults] = useState([]); // Результати пошуку
  const [clientPricingRules, setClientPricingRules] = useState(null); // Правила ціноутворення
  const [searchingClients, setSearchingClients] = useState(false); // Стан завантаження пошуку
  
  // Списки для фільтрів
  const [brandsList, setBrandsList] = useState([]); // [{id, name}] з brandsCache
  const [suppliersList, setSuppliersList] = useState([]);
  
  // Результати пошуку
  const [products, setProducts] = useState([]); // Товари з Firestore
  const [displayRows, setDisplayRows] = useState([]); // Рядки для відображення (з offers[])
  const [loading, setLoading] = useState(false);

  // Кеш товарів по брендах (ключ: brandId, значення: { products })
  const brandCacheRef = useRef(new Map());
  
  // Debounce timer для пошуку клієнтів
  const clientSearchDebounceRef = useRef(null);

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

  // Нормалізація для case-insensitive id (як у ClientsPage)
  const normId = (s) => String(s || "").trim().toUpperCase();
  // Нормалізація для телефону: лишаємо тільки цифри
  const normPhone = (s) => String(s || "").replace(/\D/g, "");

  // Визначаємо, за чим шукати: якщо у введенні є 3+ цифр і майже немає літер — шукаємо по phone
  const isPhoneQuery = (s) => {
    const digits = normPhone(s);
    const letters = String(s || "").replace(/[^A-Za-zА-Яа-яЇїІіЄєҐґ]/g, "");
    return digits.length >= 3 && letters.length === 0;
  };

  // Фільтрований список брендів для бічної панелі
  const filteredBrands = useMemo(() => {
    if (!brandSearch.trim()) return brandsList;
    const searchLower = brandSearch.trim().toLowerCase();
    return brandsList.filter(b => 
      String(b.name || "").toLowerCase().includes(searchLower)
    );
  }, [brandsList, brandSearch]);

  // Пошук клієнтів (як у ClientsPage)
  const searchClients = useCallback(async (searchQuery) => {
    if (!searchQuery || !searchQuery.trim()) {
      setClientSearchResults([]);
      return;
    }

    setSearchingClients(true);
    try {
      const s = searchQuery.trim();
      const parts = [];
      
      if (isPhoneQuery(s)) {
        const p = normPhone(s);
        parts.push(orderBy("phone"));
        parts.push(startAt(p));
        parts.push(endAt(p + "\uf8ff"));
      } else {
        const id = normId(s);
        parts.push(orderBy("id"));
        parts.push(startAt(id));
        parts.push(endAt(id + "\uf8ff"));
      }
      
      parts.push(limit(10)); // Обмежуємо до 10 результатів для autocomplete
      
      const q = query(
        collection(db, `/artifacts/${appId}/public/data/clients`),
        ...parts
      );
      
      const snap = await getDocs(q);
      const results = snap.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      
      setClientSearchResults(results);
    } catch (e) {
      console.error("Помилка пошуку клієнтів", e);
      setClientSearchResults([]);
    } finally {
      setSearchingClients(false);
    }
  }, [appId]);

  // Debounced пошук клієнтів
  useEffect(() => {
    if (clientSearchDebounceRef.current) {
      clearTimeout(clientSearchDebounceRef.current);
    }
    
    if (!clientSearch.trim()) {
      setClientSearchResults([]);
      return;
    }
    
    clientSearchDebounceRef.current = setTimeout(() => {
      searchClients(clientSearch);
    }, 400);
    
    return () => {
      if (clientSearchDebounceRef.current) {
        clearTimeout(clientSearchDebounceRef.current);
      }
    };
  }, [clientSearch, searchClients]);

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
          minStock: offer.minStock,
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

  return (
    <div className="bg-white rounded-2xl shadow p-4">
      <h2 className="text-xl font-semibold mb-4">Товари</h2>
      
      <div className="grid grid-cols-12 gap-4">
        {/* Бічна панель з пошуком по бренду */}
        <aside className="col-span-12 md:col-span-3">
          <div className="bg-white border rounded-lg shadow-sm p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="font-semibold text-gray-700">Бренди</div>
              {selectedBrand && (
                <button
                  className="text-xs text-indigo-600 hover:underline"
                  onClick={() => {
                    setSelectedBrand("");
                    setBrandSearch("");
                    setArticleSearch("");
                  }}
                >
                  Очистити
                </button>
              )}
            </div>
            
            {/* Пошукове поле для брендів */}
            <div className="relative mb-3">
              <input
                type="text"
                className="w-full border rounded px-3 py-2 pr-8 text-sm"
                placeholder="Знайти бренд"
                value={brandSearch}
                onChange={(e) => setBrandSearch(e.target.value)}
              />
              {brandSearch && (
                <button
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  onClick={() => {
                    setBrandSearch("");
                  }}
                >
                  ×
                </button>
              )}
            </div>
            
            {/* Список брендів */}
            <div className="max-h-[50vh] overflow-auto pr-1 space-y-1">
              {filteredBrands.length > 0 ? (
                filteredBrands.map((b) => {
                  const isSelected = selectedBrand === b.id;
                  return (
                    <button
                      key={b.id}
                      className={`w-full text-left px-2 py-1.5 rounded text-sm transition-colors ${
                        isSelected
                          ? "bg-indigo-50 text-indigo-700 font-medium"
                          : "hover:bg-gray-50 text-gray-700"
                      }`}
                      onClick={() => {
                        const newBrand = isSelected ? "" : b.id;
                        setSelectedBrand(newBrand);
                        // Очищаємо артикул при виборі бренда, щоб бренд мав пріоритет
                        if (newBrand) {
                          setArticleSearch("");
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
                onFocus={() => {
                  if (clientSearch.trim()) {
                    searchClients(clientSearch);
                  }
                }}
                onBlur={() => {
                  // Затримка перед закриттям, щоб клік по результату встиг спрацювати
                  setTimeout(() => setClientSearchResults([]), 200);
                }}
              />
              {/* Випадаючий список результатів */}
              {clientSearchResults.length > 0 && (
                <div className="absolute z-10 w-full mt-1 bg-white border rounded-lg shadow-lg max-h-60 overflow-auto">
                  {clientSearchResults.map((client) => (
                    <button
                      key={client.id}
                      type="button"
                      className="w-full text-left px-3 py-2 hover:bg-gray-100 border-b last:border-b-0"
                      onClick={() => {
                        setSelectedClient(client);
                        setClientSearch("");
                        setClientSearchResults([]);
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
                </tr>
              ));
            })}
            {!displayRows.length && !loading && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                  {products.length === 0
                    ? "Натисніть 'Пошук' для завантаження товарів"
                    : "Немає даних за обраними фільтрами"}
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                  Завантаження…
                </td>
              </tr>
            )}
          </tbody>
        </table>
          </div>
        </section>
      </div>
    </div>
  );
}
