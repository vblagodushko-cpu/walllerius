import React, { useState, useCallback, useMemo, useEffect } from "react";
import {
  collection,
  getDocs,
  query,
  orderBy,
} from "firebase/firestore";
import { db } from "../../firebase-config";

const appId = import.meta.env.VITE_PROJECT_ID || "embryo-project";
const PRODUCTS_PATH = `/artifacts/${appId}/public/data/products`;
const STORAGE_KEY = "purchasesPage_state";

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
        };
      }
    } catch (e) {
      console.warn("Помилка відновлення стану з localStorage:", e);
    }
    return {
      products: [],
      expandedProducts: new Set(),
    };
  };

  const initialState = loadStateFromStorage();
  const [products, setProducts] = useState(initialState.products);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState("brand");
  const [sortOrder, setSortOrder] = useState("asc");
  const [expandedProducts, setExpandedProducts] = useState(initialState.expandedProducts);

  // Збереження стану в localStorage
  const saveStateToStorage = useCallback((state) => {
    try {
      const stateToSave = {
        products: state.products,
        expandedProducts: Array.from(state.expandedProducts),
        lastLoadTimestamp: Date.now(),
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
    });
  }, [products, expandedProducts, saveStateToStorage]);

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
        if (!data.offers || !Array.isArray(data.offers)) return;
        
        const warehouseOffer = data.offers.find(o => o.supplier === "Мій склад");
        if (!warehouseOffer) return;
        
        const stock = warehouseOffer.stock || 0;
        const minStock = data.minStock; // Читаємо з кореня продукту
        
        if (minStock !== null && minStock !== undefined && stock < minStock) {
          const retailPrice = warehouseOffer.publicPrices?.["роздріб"] || 0;
          const incomingPrice = retailPrice * 0.66667;
          
          // Формуємо список пропозицій постачальників (крім "Мій склад")
          const supplierOffers = data.offers
            .filter(o => o.supplier !== "Мій склад")
            .map(offer => {
              const offerRetail = offer.publicPrices?.["роздріб"] || 0;
              const offerIncoming = offerRetail * 0.66667;
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
    } catch (e) {
      console.error("Помилка завантаження товарів для закупівлі:", e);
      setStatus?.({ type: "error", message: `Помилка: ${e.message}` });
    } finally {
      setLoading(false);
    }
  }, [setStatus]);

  // Фільтрація та сортування
  const filteredAndSorted = useMemo(() => {
    let filtered = products;
    
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(p => 
        p.brand.toLowerCase().includes(query) ||
        p.id.toLowerCase().includes(query) ||
        (p.name || "").toLowerCase().includes(query)
      );
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

  return (
    <div className="bg-white rounded-2xl shadow p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">ЗАКУПКИ</h2>
        <div className="flex items-center gap-3">
          <div className="text-xs text-amber-600 bg-amber-50 px-3 py-1.5 rounded border border-amber-200">
            ⚠️ Читає всі товари з бази (може бути багато reads)
          </div>
          <button
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
            onClick={loadPurchases}
            disabled={loading}
          >
            {loading ? "Завантаження..." : "Завантажити"}
          </button>
        </div>
      </div>

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
                </tr>
              </thead>
              <tbody>
                {filteredAndSorted.map((product) => {
                  const isExpanded = expandedProducts.has(product.docId);
                  const topOffers = product.supplierOffers?.slice(0, 3) || [];
                  const hasMore = (product.supplierOffers?.length || 0) > 3;
                  const allOffers = product.supplierOffers || [];
                  
                  return (
                    <React.Fragment key={product.docId}>
                      <tr className="border-t">
                        <td className="px-3 py-2 whitespace-nowrap">{product.brand}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{product.id}</td>
                        <td className="px-3 py-2">{product.name || "—"}</td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className={product.stock < product.minStock ? "text-red-600 font-medium" : ""}>
                            {product.stock}
                            {product.minStock != null && ` min(${product.minStock})`}
                          </span>
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
                        <td className="px-3 py-2">
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
    </div>
  );
}
