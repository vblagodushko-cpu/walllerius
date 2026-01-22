// src/portal.jsx — PUBLIC catalog + restored Profile (with change password), balances header, Cart
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import {
  collection, getDocs, doc, getDoc, query, where, orderBy, limit, startAfter
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import './index.css';
import { auth, db, functions } from './firebase-config.js';
import ProductCatalog from './components/ProductCatalog.jsx';
import OrderHistory from './OrderHistory.jsx';
import SettlementsPage from './SettlementsPage.jsx';
import { logger } from './utils/logger.js';

const appId = import.meta.env.VITE_PROJECT_ID;
if (!appId) {
  console.error("VITE_PROJECT_ID environment variable is required");
}

/** UI helper */
function Pill({ children, tone='gray' }) {
  const tones = {
    gray: 'bg-gray-100 text-gray-800',
    green: 'bg-green-100 text-green-800',
    red: 'bg-red-100 text-red-800',
    indigo: 'bg-indigo-100 text-indigo-800',
  };
  return <span className={`px-3 py-1 rounded-xl text-sm ${tones[tone] || tones.gray}`}>{children}</span>;
}

/** Profile (with Change Password) */
function ProfileTab({ client, user, onChangePassword, changing }) {
  const safe = client || { name: user?.displayName || user?.phoneNumber || 'Клієнт', priceType: 'роздріб' };

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [show, setShow] = useState(false);
  const [msg, setMsg] = useState(null); // {type:'success'|'error', text}

  const submit = async (e) => {
    e.preventDefault();
    setMsg(null);
    if (newPassword.length < 6) { setMsg({type:'error', text:'Новий пароль має містити щонайменше 6 символів.'}); return; }
    if (newPassword !== confirmPassword) { setMsg({type:'error', text:'Паролі не співпадають.'}); return; }
    try {
      await onChangePassword(currentPassword, newPassword, confirmPassword);
      setMsg({type:'success', text:'Пароль змінено!'});
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
    } catch (e) {
      setMsg({type:'error', text: e?.message || 'Не вдалося змінити пароль.'});
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white p-6 rounded-lg shadow-md space-y-3">
        <h2 className="text-xl font-semibold">Профіль</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <div className="text-sm text-gray-500">Імʼя</div>
            <div className="font-medium">{safe.name}</div>
          </div>
          <div>
            <div className="text-sm text-gray-500">Телефон</div>
            <div className="font-medium">{safe.phone || user?.phoneNumber || '—'}</div>
          </div>
          <div>
            <div className="text-sm text-gray-500">Email</div>
            <div className="font-medium">{user?.email || '—'}</div>
          </div>
        </div>
        <p className="text-sm text-gray-500 mt-3">
          Пароль використовується для входу в портал (логін — ваш номер телефону у форматі 050XXXXXXX).
        </p>
      </div>

      <form onSubmit={submit} className="bg-white p-6 rounded-lg shadow-md">
        <h3 className="text-lg font-semibold mb-3">Змінити пароль</h3>
        {msg && (
          <div className={`mb-3 p-2 rounded ${msg.type==='success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
            {msg.text}
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm text-gray-600">Поточний пароль</span>
            <input
              type={show ? 'text' : 'password'}
              className="mt-1 w-full border rounded-lg p-2"
              value={currentPassword}
              onChange={(e)=>setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <div className="flex items-end">
            <label className="inline-flex items-center gap-2 text-sm cursor-pointer select-none">
              <input type="checkbox" checked={show} onChange={(e)=>setShow(e.target.checked)} />
              Показати паролі
            </label>
          </div>

          <label className="block">
            <span className="text-sm text-gray-600">Новий пароль</span>
            <input
              type={show ? 'text' : 'password'}
              className="mt-1 w-full border rounded-lg p-2"
              value={newPassword}
              onChange={(e)=>setNewPassword(e.target.value)}
              minLength={6}
              autoComplete="new-password"
              required
            />
          </label>
          <label className="block">
            <span className="text-sm text-gray-600">Підтвердити новий пароль</span>
            <input
              type={show ? 'text' : 'password'}
              className="mt-1 w-full border rounded-lg p-2"
              value={confirmPassword}
              onChange={(e)=>setConfirmPassword(e.target.value)}
              minLength={6}
              autoComplete="new-password"
              required
            />
          </label>
        </div>
        <div className="mt-4">
          <button
            className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-60"
            disabled={changing}
            type="submit"
          >
            {changing ? 'Зберігаємо…' : 'Змінити пароль'}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Toast notification component */
function Toast({ message, onClose, onViewCart }) {
  return (
    <div className="fixed top-4 right-4 z-50 animate-slide-in-right">
      <div className="bg-white rounded-lg shadow-lg border border-gray-200 p-4 min-w-[320px] max-w-md">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 mt-0.5">
            <svg className="w-6 h-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <div className="flex-1">
            <p className="text-sm font-medium text-gray-900">{message}</p>
            {onViewCart && (
              <button
                onClick={onViewCart}
                className="mt-2 text-sm text-indigo-600 hover:text-indigo-800 font-medium"
              >
                Переглянути кошик →
              </button>
            )}
          </div>
          <button
            onClick={onClose}
            className="flex-shrink-0 text-gray-400 hover:text-gray-600"
            aria-label="Закрити"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

/** Cart drawer */
function CartDrawer({ open, onClose, items, onChangeQty, onRemove, onPlaceOrder, placing, selectedCurrency = 'EUR', uahRate = null }) {
  const currencySymbol = selectedCurrency === 'EUR' ? '€' : '₴';
  
  // Конвертуємо ціни при відображенні
  const getDisplayPrice = (basePriceEUR) => {
    if (selectedCurrency === 'UAH' && uahRate && uahRate > 0) {
      return Math.round(basePriceEUR * uahRate * 100) / 100;
    }
    return basePriceEUR;
  };
  
  const total = useMemo(() => {
    return items.reduce((s, i) => {
      const displayPrice = getDisplayPrice(Number(i.price || 0));
      return s + displayPrice * Number(i.quantity || 0);
    }, 0);
  }, [items, selectedCurrency, uahRate]);
  
  return (
    <div className={`fixed inset-0 z-40 ${open ? '' : 'pointer-events-none'}`} aria-hidden={!open}>
      <div className={`absolute inset-0 bg-black/30 transition-opacity ${open ? 'opacity-100' : 'opacity-0'}`} onClick={onClose}/>
      <div className={`absolute right-0 top-0 h-full w-full sm:w-[420px] bg-white shadow-xl p-4 transition-transform ${open ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold">Кошик</h3>
          <button className="px-3 py-1 rounded-xl bg-gray-100 hover:bg-gray-200" onClick={onClose}>Закрити</button>
        </div>

        {items.length === 0 ? (
          <p className="text-gray-500">Кошик порожній.</p>
        ) : (
          <div className="space-y-3 overflow-y-auto h-[70vh] pr-1">
            {items.map((it, idx) => {
              const displayPrice = getDisplayPrice(Number(it.price || 0));
              return (
                <div key={it.docId + ':' + idx} className="border rounded-lg p-3">
                  <div className="flex justify-between gap-3">
                    <div>
                      <div className="font-medium">{it.brand} — {it.name}</div>
                      <div className="text-xs text-gray-500">арт. {it.id}</div>
                      <div className="text-sm mt-1">Ціна: <b>{displayPrice.toFixed(2)} {currencySymbol}</b></div>
                    </div>
                    <button className="text-red-600 text-sm" onClick={() => onRemove(it.docId)}>× Видалити</button>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <button className="px-2 py-1 rounded bg-gray-100" onClick={() => onChangeQty(it.docId, Math.max(1, (it.quantity||1)-1))}>−</button>
                    <input type="number" className="w-16 p-1 border rounded text-center" value={it.quantity||1} min={1}
                      onChange={(e)=> onChangeQty(it.docId, Math.max(1, Number(e.target.value)||1))}/>
                    <button className="px-2 py-1 rounded bg-gray-100" onClick={() => onChangeQty(it.docId, (it.quantity||1)+1)}>+</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-4 border-t pt-3">
          <div className="flex items-center justify-between text-lg">
            <span>Разом:</span>
            <b>{total.toFixed(2)} {currencySymbol}</b></div>
          <button
            className="mt-3 w-full px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-60"
            disabled={items.length === 0 || placing}
            onClick={() => onPlaceOrder(items, total)}
          >{placing ? 'Відправлення…' : 'Оформити замовлення'}</button>
        </div>
      </div>
    </div>
  );
}

function PortalApp() {
  const [user, setUser] = useState(null);
  const [clientData, setClientData] = useState(null);
  const [suppliers, setSuppliers] = useState([]);
  const [orders, setOrders] = useState([]);
  const [lastOrderDoc, setLastOrderDoc] = useState(null);
  const [hasMoreOrders, setHasMoreOrders] = useState(false);
  const [isLoadingMoreOrders, setIsLoadingMoreOrders] = useState(false);
  const [balances, setBalances] = useState({ UAH: 0, EUR: 0 });
  const [selectedCurrency, setSelectedCurrency] = useState(() => localStorage.getItem('selectedCurrency') || 'EUR');
  const [uahRate, setUahRate] = useState(null);
  const [hasBalances, setHasBalances] = useState(false);
  const [settlements, setSettlements] = useState(null);
  const [view, setView] = useState('products');
  const [clientPricingRules, setClientPricingRules] = useState(null);

  // Featured products
  const [featuredProducts, setFeaturedProducts] = useState([]);
  const [featuredProductsData, setFeaturedProductsData] = useState([]);
  const [showFeatured, setShowFeatured] = useState(false);

  // Товари
  const [products, setProducts] = useState([]);
  const [isFetchingProducts, setIsFetchingProducts] = useState(false);
  const [lastDocSnap, setLastDocSnap] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  // Смарт-панель
  const [smartPanelMode, setSmartPanelMode] = useState('groups'); // 'groups' | 'brands'
  const [selectedGroup, setSelectedGroup] = useState(null); // groupId
  const [selectedBrand, setSelectedBrand] = useState(null); // brandName
  const [expandedGroup, setExpandedGroup] = useState(null); // groupId або null
  const [brandSearch, setBrandSearch] = useState(""); // Пошук брендів у режимі "Всі бренди"

  // Групи та бренди
  const [productGroups, setProductGroups] = useState([]); // Групи з brandFolders
  const [allBrands, setAllBrands] = useState([]); // [{id, name}] з meta/brands
  const [categories, setCategories] = useState([]); // [{id, name, slug, order}]

  // Фільтри для відображення товарів (клієнтська дорізка)
  const [hideZeroStock, setHideZeroStock] = useState(false);
  const [hidePartnerOffers, setHidePartnerOffers] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState(null); // Категорія для фільтрації

  // Кеш товарів по брендах (ключ: brandName, значення: { products, lastDoc, hasMore })
  const brandCacheRef = useRef(new Map());
  // Кеш товарів по category-групах (ключ: groupId, значення: { products, lastDoc, hasMore })
  const categoryGroupCacheRef = useRef(new Map());

  // cart
  const [cart, setCart] = useState(() => {
    try { return JSON.parse(localStorage.getItem('shoppingCart') || '[]'); } catch { return []; }
  });
  useEffect(() => { localStorage.setItem('shoppingCart', JSON.stringify(cart)); }, [cart]);
  const [isCartVisible, setIsCartVisible] = useState(false);
  const [placingOrder, setPlacingOrder] = useState(false);
  const [changingPwd, setChangingPwd] = useState(false);
  const [toast, setToast] = useState(null);

  // Пошук по артикулу
  const [articleSearch, setArticleSearch] = useState('');
  const [isSearchingArticle, setIsSearchingArticle] = useState(false);


  const safeClient = useMemo(() => clientData || { name: user?.displayName || user?.phoneNumber || 'Клієнт', priceType: 'роздріб' }, [clientData, user]);

  // Уніфікована функція завантаження товарів по бренду (з кешуванням та пагінацією)
  const loadProductsByBrand = useCallback(async (brandName, loadMore = false) => {
    if (!brandName) {
      setProducts([]);
      setLastDocSnap(null);
      setHasMore(false);
      setIsFetchingProducts(false);
      return;
    }

    // Перевіряємо кеш (тільки для першого завантаження)
    if (!loadMore) {
      const cached = brandCacheRef.current.get(brandName);
      if (cached) {
        setProducts(cached.products);
        setLastDocSnap(cached.lastDoc);
        setHasMore(cached.hasMore);
        setIsFetchingProducts(false);
        return;
      }
    }

    if (loadMore) {
      setIsLoadingMore(true);
        } else {
      setIsFetchingProducts(true);
        }

    try {
      const baseCol = collection(db, `/artifacts/${appId}/public/data/products`);
      const PAGE_SIZE = 50;
      const clauses = [
        where('brand', '==', brandName),
        orderBy('brand'),
        orderBy('name'),
        limit(PAGE_SIZE)
      ];
    
      if (loadMore && lastDocSnap) {
        clauses.push(startAfter(lastDocSnap));
      }

    const q = query(baseCol, ...clauses);
    const snap = await getDocs(q);
    const items = snap.docs.map(d => ({ docId: d.id, ...d.data() }));
    
      const newLastDoc = snap.docs.at(-1) || null;
      const newHasMore = snap.size === PAGE_SIZE;

      if (loadMore) {
        // Додаємо до існуючих
        const updatedProducts = [...products, ...items];
        setProducts(updatedProducts);
        setLastDocSnap(newLastDoc);
        setHasMore(newHasMore);
    
        // Оновлюємо кеш - додаємо нові товари до існуючих
        const cached = brandCacheRef.current.get(brandName);
        if (cached) {
          brandCacheRef.current.set(brandName, {
            products: updatedProducts,
            lastDoc: newLastDoc,
            hasMore: newHasMore
          });
        }
      } else {
        // Перше завантаження
        setProducts(items);
        setLastDocSnap(newLastDoc);
        setHasMore(newHasMore);
        
        // Зберігаємо в кеш
        brandCacheRef.current.set(brandName, { 
          products: items, 
          lastDoc: newLastDoc, 
          hasMore: newHasMore 
        });
      }
    } catch (e) {
      logger.error("Помилка завантаження товарів", e);
      if (!loadMore) {
        setProducts([]);
      }
    } finally {
      setIsFetchingProducts(false);
      setIsLoadingMore(false);
    }
  }, [lastDocSnap]);

  // Завантаження товарів по category-групі (з кешуванням та пагінацією)
  const loadProductsByGroup = useCallback(async (groupId, loadMore = false) => {
    if (!groupId) {
      setProducts([]);
      setLastDocSnap(null);
      setHasMore(false);
      setIsFetchingProducts(false);
      return;
    }
    
    // Перевіряємо кеш (тільки для першого завантаження)
    if (!loadMore) {
      const cached = categoryGroupCacheRef.current.get(groupId);
      if (cached) {
        setProducts(cached.products);
        setLastDocSnap(cached.lastDoc);
        setHasMore(cached.hasMore);
        setIsFetchingProducts(false);
        return;
      }
    }

    if (loadMore) {
      setIsLoadingMore(true);
    } else {
      setIsFetchingProducts(true);
    }

    try {
      const group = productGroups.find(g => g.id === groupId);
      if (!group) {
        setProducts([]);
        setIsFetchingProducts(false);
        return;
      }

    const baseCol = collection(db, `/artifacts/${appId}/public/data/products`);
      const PAGE_SIZE = 50;
      const clauses = [];

      // Тільки для category-груп (preset-групи не використовують цю функцію)
      if (group.groupType === 'category' && group.categories && group.categories.length > 0) {
        if (group.categories.length === 1) {
          clauses.push(where('categories', 'array-contains', group.categories[0]));
        } else {
          clauses.push(where('categories', 'array-contains-any', group.categories));
      }
      } else if (group.filterType === 'category' && group.categories && group.categories.length > 0) {
        // Стара структура (міграція)
        if (group.categories.length === 1) {
          clauses.push(where('categories', 'array-contains', group.categories[0]));
    } else {
          clauses.push(where('categories', 'array-contains-any', group.categories));
        }
      } else {
        // Якщо не category-група - не завантажуємо
        setProducts([]);
        setIsFetchingProducts(false);
        return;
      }

      clauses.push(orderBy('brand'));
      clauses.push(orderBy('name'));
      clauses.push(limit(PAGE_SIZE));

      if (loadMore && lastDocSnap) {
        clauses.push(startAfter(lastDocSnap));
      }

      const q = query(baseCol, ...clauses);
      const snap = await getDocs(q);
      const items = snap.docs.map(d => ({ docId: d.id, ...d.data() }));

      const newLastDoc = snap.docs.at(-1) || null;
      const newHasMore = snap.size === PAGE_SIZE;

      if (loadMore) {
        // Додаємо до існуючих
        const updatedProducts = [...products, ...items];
        setProducts(updatedProducts);
        setLastDocSnap(newLastDoc);
        setHasMore(newHasMore);
        
        // Оновлюємо кеш - додаємо нові товари до існуючих
        const cached = categoryGroupCacheRef.current.get(groupId);
        if (cached) {
          categoryGroupCacheRef.current.set(groupId, {
            products: updatedProducts,
            lastDoc: newLastDoc,
            hasMore: newHasMore
          });
        }
      } else {
        // Перше завантаження
        setProducts(items);
        setLastDocSnap(newLastDoc);
        setHasMore(newHasMore);
        
        // Зберігаємо в кеш
        categoryGroupCacheRef.current.set(groupId, { 
          products: items, 
          lastDoc: newLastDoc, 
          hasMore: newHasMore 
        });
      }
    } catch (e) {
      logger.error("Помилка завантаження товарів по групі", e);
      if (!loadMore) {
        setProducts([]);
      }
    } finally {
      setIsFetchingProducts(false);
      setIsLoadingMore(false);
    }
  }, [productGroups, lastDocSnap]);
    
  // Функція "Завантажити ще"
  const handleLoadMore = useCallback(async () => {
    if (isLoadingMore || !hasMore) return;
    
    if (selectedBrand) {
      await loadProductsByBrand(selectedBrand, true);
    } else if (selectedGroup) {
      await loadProductsByGroup(selectedGroup, true);
    }
  }, [selectedBrand, selectedGroup, isLoadingMore, hasMore, loadProductsByBrand, loadProductsByGroup]);

  // Завантаження більше замовлень
  const handleLoadMoreOrders = useCallback(async () => {
    if (isLoadingMoreOrders || !hasMoreOrders || !lastOrderDoc || !user) return;
    
    setIsLoadingMoreOrders(true);
    try {
      const ordersQuery = query(
        collection(db, `/artifacts/${appId}/public/data/orders`),
        where('clientId', '==', user.uid),
        orderBy('createdAt', 'desc'),
        startAfter(lastOrderDoc),
        limit(15)
      );
      const ordersSnap = await getDocs(ordersQuery);
      const newOrders = ordersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      setOrders(prev => [...prev, ...newOrders]);
      setLastOrderDoc(ordersSnap.docs[ordersSnap.docs.length - 1] || null);
      setHasMoreOrders(ordersSnap.docs.length === 15);
    } catch (e) {
      logger.error('Помилка завантаження замовлень:', e);
    } finally {
      setIsLoadingMoreOrders(false);
    }
  }, [isLoadingMoreOrders, hasMoreOrders, lastOrderDoc, user]);

  // initial reads + метадані (бренди/категорії)
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (currentUser) => {
      if (!currentUser) { window.location.href = '/login.html'; return; }
      setUser(currentUser);

      try {
        const clientDocRef = doc(db, `/artifacts/${appId}/public/data/clients`, currentUser.uid);
        const suppliersPromise = getDocs(collection(db, `/artifacts/${appId}/public/data/suppliers`));
        const ordersQuery = query(collection(db, `/artifacts/${appId}/public/data/orders`), where('clientId','==', currentUser.uid), orderBy('createdAt','desc'), limit(15));
        const ordersPromise = getDocs(ordersQuery);
        const balancesPromise = getDocs(collection(db, `/artifacts/${appId}/public/data/settlements/${currentUser.uid}/balances`));
        // ПРИБРАНО: автоматичне завантаження товарів при ініціалізації
        // Товари завантажуються тільки при виборі папки, натисканні "Пошук" або пошуку по артикулу
        const brandsPromise = getDocs(query(collection(db, `/artifacts/${appId}/public/meta/brandFolders`)));
        const categoriesPromise = getDocs(query(collection(db, `/artifacts/${appId}/public/meta/categories`)));
        const brandsMetaPromise = getDocs(query(collection(db, `/artifacts/${appId}/public/meta/brands`)));

        const [clientSnap, suppSnap, ordersSnap, balancesSnap, brandsSnap, categoriesSnap, brandsMetaSnap] = await Promise.all([
          getDoc(clientDocRef), suppliersPromise, ordersPromise, balancesPromise, brandsPromise, categoriesPromise, brandsMetaPromise
        ]);

        setClientData(clientSnap.exists() ? clientSnap.data() : { name: currentUser.phoneNumber || 'Клієнт', priceType: 'роздріб' });
        setSuppliers(suppSnap.docs.map(d => ({ id: d.id, ...d.data() })));
        const ordersData = ordersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        setOrders(ordersData);
        setLastOrderDoc(ordersSnap.docs[ordersSnap.docs.length - 1] || null);
        setHasMoreOrders(ordersSnap.docs.length === 15);
        
        // Завантажуємо курс валют
        try {
          const getCurrencyRate = httpsCallable(functions, 'getCurrencyRate');
          const rateResult = await getCurrencyRate();
          if (rateResult.data?.rate) {
            setUahRate(rateResult.data.rate);
      }
        } catch (e) {
          logger.warn("Не вдалося завантажити курс валют", e);
        }

        // Завантажуємо правила ціноутворення клієнта (кешування)
        try {
          const getRules = httpsCallable(functions, "getClientPricingRules");
          const { data } = await getRules({ clientId: currentUser.uid });
          setClientPricingRules(data);
      } catch (e) {
          logger.warn("Не вдалося завантажити правила ціноутворення", e);
          setClientPricingRules({ globalAdjustment: 0, rules: [] });
        }

        const map = {};
        balancesSnap.forEach(ds => {
          const data = ds.data();
          if (data?.currency) {
            map[data.currency] = Number(data.balance || 0);
          }
        });
        setBalances({
          UAH: -Number(map.UAH || 0), // Інвертуємо баланс
          EUR: -Number(map.EUR || 0)   // Інвертуємо баланс
        });
        setHasBalances(!balancesSnap.empty);
    
        // Ініціалізуємо порожній список товарів (завантажуються тільки при виборі групи/бренду)
    setProducts([]);

        // Групи товарів (з brandFolders, тепер це групи)
        const groups = brandsSnap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .sort((a,b)=> (a.order||0)-(b.order||0) || String(a.name||'').localeCompare(String(b.name||'')) );
        setProductGroups(groups);
        
        // Категорії
        const cats = categoriesSnap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .sort((a,b)=> (a.order||0)-(b.order||0) || String(a.name||'').localeCompare(String(b.name||'')) );
        setCategories(cats);
    
        // Всі бренди для режиму "Всі бренди"
        const brandsFromMeta = brandsMetaSnap.docs
          .map(d => ({ id: d.id, name: d.data().name }))
          .sort((a,b) => String(a.name||'').localeCompare(String(b.name||'')));
        setAllBrands(brandsFromMeta);
      } catch (e) { logger.error(e); }
    });
    return () => unsub();
  }, []);

  // Завантаження featured products
  useEffect(() => {
    if (!user) return;
    
    const loadFeatured = async () => {
      try {
        const featuredRef = doc(db, `/artifacts/${appId}/public/data/featuredProducts/main`);
        const featuredSnap = await getDoc(featuredRef);
        
        if (featuredSnap.exists()) {
          const data = featuredSnap.data();
          let items = data.items || [];
          
          // Сортуємо від свіжододаних (найновіші спочатку)
          items.sort((a, b) => {
            const aTime = a.addedAt?.seconds || a.addedAt?._seconds || 0;
            const bTime = b.addedAt?.seconds || b.addedAt?._seconds || 0;
            return bTime - aTime; // Від новіших до старіших
          });
          
          setFeaturedProducts(items);
          // НЕ встановлюємо showFeatured тут, бо товари ще не завантажені
          
          // Завантажуємо повні дані товарів, зберігаючи порядок сортування
          const productPromises = items.map(async (item, index) => {
            try {
              // Шукаємо товар по brand та id (артикул)
              const productsQuery = query(
                collection(db, `/artifacts/${appId}/public/data/products`),
                where("brand", "==", item.brand),
                where("id", "==", item.id),
                limit(1)
              );
              const productSnap = await getDocs(productsQuery);
              if (!productSnap.empty) {
                const productDoc = productSnap.docs[0];
                return { 
                  docId: productDoc.id, 
                  ...productDoc.data(), 
                  isFeatured: true,
                  featuredIndex: index, // Зберігаємо індекс для сортування
                  featuredAddedAt: item.addedAt // Зберігаємо дату додавання
                };
              }
              return null;
            } catch (e) {
              logger.warn("Failed to load featured product", item.brand, item.id, e);
              return null;
            }
          });
          
          const products = (await Promise.all(productPromises))
            .filter(p => p !== null)
            .sort((a, b) => {
              // Сортуємо за featuredIndex (від свіжододаних)
              return (a.featuredIndex || 0) - (b.featuredIndex || 0);
            });
          
          // Встановлюємо showFeatured ТІЛЬКИ якщо є завантажені товари з offers
          setFeaturedProductsData(products);
          // Перевіряємо, чи є товари з offers (без offers вони не відображаються)
          const productsWithOffers = products.filter(p => p.offers && Array.isArray(p.offers) && p.offers.length > 0);
          const hasProducts = productsWithOffers.length > 0;
          setShowFeatured(hasProducts);
          logger.info(`Featured products loaded: ${products.length} out of ${items.length} items, ${productsWithOffers.length} with offers, showFeatured=${hasProducts}`);
        } else {
          setFeaturedProducts([]);
          setFeaturedProductsData([]);
          setShowFeatured(false);
        }
      } catch (e) {
        logger.error("Failed to load featured products", e);
        setFeaturedProducts([]);
        setFeaturedProductsData([]);
        setShowFeatured(false);
      }
    };
    
    loadFeatured();
  }, [user]);

  const handleAddToCart = (product, price, quantity) => {
    // Отримуємо supplier з product (якщо передано selectedSupplier)
    const supplier = product.selectedSupplier || 'Мій склад';
    
    // Конвертуємо ціну назад в EUR для зберігання (якщо зараз UAH)
    let basePriceEUR = price;
    if (selectedCurrency === 'UAH' && uahRate && uahRate > 0) {
      basePriceEUR = price / uahRate;
      basePriceEUR = Math.round(basePriceEUR * 100) / 100;
    }
    
    setCart(cur => {
      // Перевіряємо по docId + supplier (один товар може бути від різних постачальників)
      const ex = cur.find(i => i.docId === product.docId && i.supplier === supplier);
      const isNew = !ex;
      const newCart = ex 
        ? cur.map(i => (i.docId === product.docId && i.supplier === supplier) 
          ? { ...i, quantity: i.quantity + quantity } 
          : i)
                : [...cur, { ...product, supplier, price: basePriceEUR, quantity }];
      
      // Показуємо toast повідомлення
      const productName = product.name || 'Товар';
      const message = isNew 
        ? `Товар "${productName}" додано в кошик`
        : `Кількість товару "${productName}" оновлено`;
      
      setToast({
        message,
        onViewCart: () => {
    setIsCartVisible(true);
          setToast(null);
        }
      });
      
      // Автоматично закриваємо toast через 4 секунди
      setTimeout(() => setToast(null), 4000);
      
      return newCart;
    });
    // ВИДАЛЕНО: setIsCartVisible(true); - тепер кошик відкривається тільки вручну
  };

  const handlePlaceOrder = async (cartItems, orderTotal) => {
    if (!user) return;
    if (cartItems.length === 0) { alert('Ваш кошик порожній!'); return; }
    setPlacingOrder(true);
    try {
      const call = httpsCallable(functions, 'placeOrderV2');
      const payload = {
        items: cartItems,
        total: orderTotal,
        clientRequestId: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2),
        clientName: safeClient.name ?? null,
        clientPhone: safeClient.phone ?? null,
        clientEmail: user?.email ?? null,
        // Передаємо категорію ціни клієнта, щоб бекенд коректно застосував політику
        priceCategory: safeClient.priceType || 'ціна 1',
      };
      await call(payload);
      setCart([]); setIsCartVisible(false);
      const ordersQuery = query(collection(db, `/artifacts/${appId}/public/data/orders`), where('clientId','==', user.uid), orderBy('createdAt','desc'), limit(15));
      const ordersSnap = await getDocs(ordersQuery);
      const ordersData = ordersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      setOrders(ordersData);
      setLastOrderDoc(ordersSnap.docs[ordersSnap.docs.length - 1] || null);
      setHasMoreOrders(ordersSnap.docs.length === 15);
      alert('Ваше замовлення відправлено!');
    } catch (e) { logger.error('Помилка оформлення замовлення:', e); alert(`Помилка: ${e.message}`); }
    finally { setPlacingOrder(false); }
  };

  // change password
  const handleChangePassword = async (currentPassword, newPassword, confirmPassword) => {
    setChangingPwd(true);
    try {
      const call = httpsCallable(functions, 'clientChangePassword');
      // server сам візьме uid з request.auth.uid
      await call({ currentPassword, newPassword, confirmPassword });
      alert('Пароль змінено!');
    } catch (e) {
      logger.error(e);
      throw e;
    } finally {
      setChangingPwd(false);
    }
  };

  // settlements lazy load
  useEffect(() => {
    (async () => {
      if (view !== 'settlements' || settlements !== null || !user) return;
      // Використовуємо user.uid напряму, оскільки clientCode має співпадати з uid
      // (у settlements.js файли парсяться з імені, але зберігаються під clientCode = uid)
      const clientCode = String(user.uid);
      
      const uahQ = query(
        collection(db, `/artifacts/${appId}/public/data/settlements/${clientCode}/ledger-UAH`),
        orderBy('date', 'desc')
      );
      const eurQ = query(
        collection(db, `/artifacts/${appId}/public/data/settlements/${clientCode}/ledger-EUR`),
        orderBy('date', 'desc')
      );
      
      const [uahSnap, eurSnap] = await Promise.all([getDocs(uahQ), getDocs(eurQ)]);
      const uah = uahSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const eur = eurSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      
      setSettlements([...uah, ...eur]);
    })();
  }, [view, settlements, user]);

  const logout = async () => { await signOut(auth); localStorage.removeItem('shoppingCart'); window.location.href = '/login.html'; };

  // Функція пошуку по артикулу
  const handleArticleSearch = async () => {
    if (!articleSearch.trim()) return;
    
    setIsSearchingArticle(true);
    try {
      const call = httpsCallable(functions, 'searchProductsByArticle');
      const { data } = await call({ article: articleSearch.trim() });
      
      if (data.ok) {
        // Перемикаємося на "Товари"
        setView('products');
        // Замінюємо список товарів результатами пошуку
        setProducts(data.products);
        if (data.foundViaSynonym) {
          logger.debug(`Знайдено через синонім. Канонічний артикул: ${data.canonicalArticle}`);
        }
      } else {
        // При помилці - порожній список
        setView('products');
        setProducts([]);
      }
    } catch (e) {
      logger.error('Помилка пошуку:', e);
      setView('products');
      setProducts([]);
    } finally {
      setIsSearchingArticle(false);
    }
  };

  const uahTone = balances.UAH >= 0 ? 'green' : 'red';
  const eurTone = balances.EUR >= 0 ? 'green' : 'red';

  return (
    <div className="bg-gray-100 min-h-screen font-sans p-4 sm:p-8 print:bg-white">
      <header className="bg-white border-b mb-4 p-4 flex items-center justify-between rounded-lg flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <a href="https://olimp-auto.biz" target="_blank" rel="noopener noreferrer" className="flex items-center">
            <img src="/logo.png" alt="Olimp Auto" className="h-14" />
          </a>
          <a href="https://oil.olimp-auto.biz" target="_blank" rel="noopener noreferrer" className="flex items-center">
            <img src="/oil-logo.png" alt="OIL Portal" className="h-14" />
          </a>
        </div>
        
        {/* Пошук по артикулу - між заголовком та балансом */}
        <div className="flex items-center gap-2 flex-1 max-w-md">
          <input
            type="text"
            placeholder="Пошук по артикулу (напр. KL 200, 12345)"
            value={articleSearch}
            onChange={(e) => setArticleSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleArticleSearch();
            }}
            className="flex-1 px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm"
          />
          <button
            onClick={handleArticleSearch}
            disabled={isSearchingArticle}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 text-sm whitespace-nowrap"
          >
            {isSearchingArticle ? 'Пошук...' : 'Знайти'}
          </button>
        </div>
        
        {/* Курс євро */}
        {uahRate && (
          <div className="text-xs text-gray-600 whitespace-nowrap">
            Курс {uahRate.toFixed(2)}
          </div>
        )}
        
        <div className="flex items-center gap-2">
          {hasBalances ? (
            <>
          <Pill tone={uahTone}>Баланс UAH: <b>{Number(balances.UAH).toFixed(2)}</b></Pill>
          <Pill tone={eurTone}>Баланс EUR: <b>{Number(balances.EUR).toFixed(2)}</b></Pill>
            </>
          ) : (
            <Pill tone="gray"><span className="text-xs">БАЛАНС: Функціонал не увімкнено, зверніться до менеджера</span></Pill>
          )}
          <button className="px-3 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 text-sm" onClick={logout}>Вийти</button>
        </div>
      </header>

      <div className="max-w-7xl mx-auto">
        {/* Навігація та фільтри */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 sm:gap-2 mb-5">
          {/* Навігація - горизонтальний скрол на мобільних */}
          <div className="flex items-center gap-2 overflow-x-auto w-full sm:w-auto pb-2 sm:pb-0">
            <button className={`px-4 py-2 rounded-xl text-sm whitespace-nowrap ${view === 'products' ? 'bg-indigo-600 text-white' : 'bg-gray-100 hover:bg-gray-200'}`} onClick={() => setView('products')}>Товари</button>
            <button className={`px-4 py-2 rounded-xl text-sm whitespace-nowrap ${view === 'orders' ? 'bg-indigo-600 text-white' : 'bg-gray-100 hover:bg-gray-200'}`} onClick={() => setView('orders')}>Замовлення</button>
            <button className={`px-4 py-2 rounded-xl text-sm whitespace-nowrap ${view === 'settlements' ? 'bg-indigo-600 text-white' : 'bg-gray-100 hover:bg-gray-200'}`} onClick={() => setView('settlements')}>Взаєморозрахунки</button>
            <button className={`px-4 py-2 rounded-xl text-sm whitespace-nowrap ${view === 'profile' ? 'bg-indigo-600 text-white' : 'bg-gray-100 hover:bg-gray-200'}`} onClick={() => setView('profile')}>Профіль</button>
          </div>

          {/* Фільтри для відображення товарів - тільки для розділу "Товари" */}
          {view === 'products' && (
            <div className="flex flex-wrap items-center gap-2 sm:gap-3 flex-1 bg-indigo-50 border border-black rounded-lg px-3 py-2 shadow-sm">
              <span className="text-sm font-medium text-gray-700 whitespace-nowrap">ПРИХОВАТИ:</span>
              
              {/* Toggle для "Нульові" */}
              <label className="flex items-center gap-2 cursor-pointer">
                <div className="relative inline-flex items-center">
                  <input
                    type="checkbox"
                    checked={hideZeroStock}
                    onChange={(e) => setHideZeroStock(e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-indigo-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
          </div>
                <span className="text-sm text-gray-700 whitespace-nowrap">Нульові</span>
              </label>

              {/* Toggle для "Партнери" */}
              <label className="flex items-center gap-2 cursor-pointer">
                <div className="relative inline-flex items-center">
                  <input
                    type="checkbox"
                    checked={hidePartnerOffers}
                    onChange={(e) => setHidePartnerOffers(e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-indigo-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
                </div>
                <span className="text-sm text-gray-700 whitespace-nowrap">Партнери</span>
              </label>

              {/* Вибір категорій */}
              {categories.length > 0 && (
                <select
                  className="px-3 py-2 border rounded-lg text-sm"
                  value={selectedCategory || ''}
                  onChange={(e) => setSelectedCategory(e.target.value || null)}
                >
                  <option value="">Всі категорії</option>
                  {categories.map(cat => (
                    <option key={cat.id} value={cat.name || cat.id}>{cat.name || cat.id}</option>
                    ))}
                  </select>
              )}

              {/* Вибір валюти - сегментовані кнопки */}
              <div className="flex items-center gap-1 bg-gray-200 rounded-lg p-1">
                <button
                  onClick={() => {
                    setSelectedCurrency('EUR');
                    localStorage.setItem('selectedCurrency', 'EUR');
                  }}
                  className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                    selectedCurrency === 'EUR'
                      ? 'bg-white text-indigo-600 shadow-sm'
                      : 'text-gray-600 hover:text-gray-900'
                  }`}
                >
                  EUR
                </button>
                <button
                  onClick={() => {
                    setSelectedCurrency('UAH');
                    localStorage.setItem('selectedCurrency', 'UAH');
                  }}
                  className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                    selectedCurrency === 'UAH'
                      ? 'bg-white text-indigo-600 shadow-sm'
                      : 'text-gray-600 hover:text-gray-900'
                  }`}
                >
                  UAH
                </button>
                </div>

              {/* Кнопка Кошик - тільки на мобільних всередині панелі фільтрів */}
              <button
                className="sm:hidden px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm whitespace-nowrap"
                onClick={() => setIsCartVisible(true)}
              >
                Кошик {cart.length ? `(${cart.length})` : ''}
              </button>
          </div>
        )}

          {/* Кнопка Кошик - тільки на десктопі, окремо від фільтрів */}
          <div className="hidden sm:block ml-auto">
            <button className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white whitespace-nowrap" onClick={() => setIsCartVisible(true)}>
              Кошик {cart.length ? `(${cart.length})` : ''}
            </button>
          </div>
        </div>

        {view === 'products' && (
          <div className="grid grid-cols-12 gap-4">
            <aside className="col-span-12 md:col-span-3">
              <div className="bg-white rounded border border-gray-200 p-2">
                {/* Тумблер режимів */}
                <div className="flex gap-1 mb-2">
                    <button
                    className={`flex-1 px-2 py-1.5 rounded text-sm font-medium ${smartPanelMode === 'groups' ? 'bg-indigo-600 text-white' : 'bg-gray-100 hover:bg-gray-200'}`}
                    onClick={() => {
                      setSmartPanelMode('groups');
                      // Зберігаємо стан: якщо був вибраний бренд, залишаємо його вибраним
                    }}
                  >
                    Групи
                  </button>
                  <button
                    className={`flex-1 px-2 py-1.5 rounded text-sm font-medium ${smartPanelMode === 'brands' ? 'bg-indigo-600 text-white' : 'bg-gray-100 hover:bg-gray-200'}`}
                    onClick={() => {
                      setSmartPanelMode('brands');
                      // Зберігаємо стан: якщо була вибрана група, залишаємо її вибраною
                    }}
                  >
                    Бренди
                  </button>
                  </div>

                {smartPanelMode === 'groups' ? (
                  <div className="space-y-1">
                    {productGroups.map(group => {
                      const isExpanded = expandedGroup === group.id;
                      const isSelected = selectedGroup === group.id;
                      const groupType = group.groupType || (group.filterType === 'category' ? 'category' : 'preset');
                      
                      return (
                        <div key={group.id} className="border border-gray-200 rounded">
                          <button
                            className={`w-full text-left px-2 py-1.5 flex items-center justify-between text-sm font-medium ${isSelected ? 'bg-indigo-50 text-indigo-700' : 'hover:bg-gray-50'}`}
                            onClick={() => {
                              if (groupType === 'preset' && group.brands && group.brands.length > 0) {
                                // Для preset-груп з одним брендом - завантажуємо товари по бренду
                                if (group.brands.length === 1) {
                                  setSelectedBrand(group.brands[0]);
                                  setSelectedGroup(null);
                                  setLastDocSnap(null);
                                  setHasMore(false);
                                  loadProductsByBrand(group.brands[0], false);
                                } else {
                                  // Для preset-груп з кількома брендами - тільки розгортаємо/згортаємо список
                                  // Товари НЕ завантажуються до кліку на конкретний бренд
                                  if (isExpanded) {
                                    // Згортаємо поточну групу
                                    setExpandedGroup(null);
                                    if (selectedGroup === group.id) {
                                      setSelectedGroup(null);
                                    }
                                  } else {
                                    // Розгортаємо нову групу (автоматично закриває попередню)
                                    setExpandedGroup(group.id);
                                    setSelectedGroup(group.id);
                                  }
                                }
                              } else if (groupType === 'category') {
                                // Для category-груп - завантажуємо товари відразу
                                setSelectedGroup(group.id);
                                setSelectedBrand(null);
                                setLastDocSnap(null);
                                setHasMore(false);
                                loadProductsByGroup(group.id, false);
                              } else {
                                // Стара структура (міграція) - завантажуємо товари
                                setSelectedGroup(group.id);
                                setSelectedBrand(null);
                                setLastDocSnap(null);
                                setHasMore(false);
                                loadProductsByGroup(group.id, false);
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
                              {group.brands.map((brandName, idx) => (
                                <button
                                  key={idx}
                                  className={`w-full text-left px-3 py-1.5 text-sm ${selectedBrand === brandName ? 'bg-indigo-50 text-indigo-700 font-medium' : 'hover:bg-gray-50'}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedBrand(brandName);
                                    setSelectedGroup(null);
                                    setLastDocSnap(null);
                                    setHasMore(false);
                                    loadProductsByBrand(brandName, false);
                                  }}
                                >
                                  {brandName}
                                </button>
                              ))}
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
                    <input
                      type="text"
                      placeholder="Пошук брендів..."
                      value={brandSearch}
                      onChange={(e) => setBrandSearch(e.target.value)}
                      className="w-full px-2 py-1.5 border border-gray-200 rounded text-sm"
                    />
                    <div className="max-h-[60vh] overflow-auto space-y-0.5">
                      {allBrands
                        .filter(b => !brandSearch.trim() || String(b.name || '').toLowerCase().includes(brandSearch.trim().toLowerCase()))
                        .map(b => {
                          const isSelected = selectedBrand === b.name;
                      return (
                            <button
                              key={b.id}
                              className={`w-full text-left px-2 py-1.5 rounded text-sm ${isSelected ? 'bg-indigo-50 text-indigo-700 font-medium' : 'hover:bg-gray-50'}`}
                              onClick={() => {
                                setSelectedBrand(b.name);
                                setSelectedGroup(null);
                                setLastDocSnap(null);
                                setHasMore(false);
                                loadProductsByBrand(b.name, false);
                              }}
                            >
                              {b.name}
                            </button>
                      );
                    })}
                      {allBrands.length === 0 && (
                        <div className="text-sm text-gray-500 px-2 py-1">Бренди не налаштовані</div>
                      )}
                  </div>
                </div>
                )}
              </div>
            </aside>

            <section className="col-span-12 md:col-span-9">
              {isFetchingProducts && (
                <div className="text-center py-8 text-gray-500">Завантаження товарів...</div>
              )}
          <ProductCatalog
            clientPricingRules={clientPricingRules}
            products={products}
            client={safeClient}
            suppliers={suppliers}
            onAddToCart={handleAddToCart}
                hideZeroStock={hideZeroStock}
                hidePartnerOffers={hidePartnerOffers}
                selectedCategory={selectedCategory}
                selectedCurrency={selectedCurrency}
                uahRate={uahRate}
                featuredProducts={featuredProductsData}
                showFeatured={showFeatured && !selectedBrand && !selectedGroup && !selectedCategory}
          />
              {hasMore && !isFetchingProducts && (
                <div className="text-center mt-4">
                  <button
                    onClick={handleLoadMore}
                    disabled={isLoadingMore}
                    className="px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isLoadingMore ? 'Завантаження...' : 'Завантажити ще'}
                  </button>
                </div>
              )}
            </section>
          </div>
        )}


        {view === 'orders' && (
          <OrderHistory
            orders={orders}
            onFetchMore={handleLoadMoreOrders}
            hasMore={hasMoreOrders}
            isFetchingMore={isLoadingMoreOrders}
            selectedCurrency={selectedCurrency}
            uahRate={uahRate}
          />
        )}

        {view === 'settlements' && (
          <SettlementsPage items={settlements || []} balances={balances} client={safeClient} user={user} />
        )}

        {view === 'profile' && (
          <ProfileTab client={clientData} user={user} onChangePassword={handleChangePassword} changing={changingPwd} />
        )}
      </div>

      {/* Toast notification */}
      {toast && (
        <Toast
          message={toast.message}
          onClose={() => setToast(null)}
          onViewCart={toast.onViewCart}
        />
      )}

      <CartDrawer
        open={isCartVisible}
        onClose={() => setIsCartVisible(false)}
        items={cart}
        onChangeQty={(docId, qty) => setCart(cur => cur.map(i => i.docId === docId ? { ...i, quantity: qty } : i))}
        onRemove={(docId) => setCart(cur => cur.filter(i => i.docId !== docId))}
        onPlaceOrder={handlePlaceOrder}
        placing={placingOrder}
        selectedCurrency={selectedCurrency}
        uahRate={uahRate}
      />

    </div>
  );
}

(function mount() {
  let el = document.getElementById('root');
  if (!el) { el = document.createElement('div'); el.id = 'root'; document.body.appendChild(el); }
  const root = createRoot(el);
  root.render(<PortalApp />);
})();
