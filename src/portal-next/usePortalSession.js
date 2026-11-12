// Сесія нового порталу: ті самі читання, що в portal.jsx.
// Товари не вантажаться пачкою на старті — лише група, бренд або пошук артикула.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import {
  collection, doc, getDoc, getDocs, limit, orderBy, query, startAfter, where,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { auth, db, functions } from '../firebase-config.js';
import { logger } from '../utils/logger.js';
import { findBrandMeta, fetchProductsByBrandNames, PRODUCT_PAGE_SIZE } from '../utils/brandQuery.js';
import {
  availableStock,
  buildStockWarningLines,
  confirmStockOverOrder,
  getCartLineStock,
  warehouseStockFromProductDoc,
  WAREHOUSE_SUPPLIER,
} from '../utils/cartStockWarning.js';
import { calculateProductPrice } from '../utils/productPricing.js';

const appId = import.meta.env.VITE_PROJECT_ID;
const ORDERS_PAGE = 15;
export const FEATURED_GROUP_ID = '__featured__';

function filterFeaturedWithWarehouseStock(products) {
  return (products || [])
    .map((product) => {
      const warehouseOffer = (product.offers || []).find((o) => o.supplier === WAREHOUSE_SUPPLIER);
      if (!warehouseOffer || availableStock(product, warehouseOffer) <= 0) return null;
      return { ...product, bestOffer: warehouseOffer };
    })
    .filter(Boolean);
}

function readCart() {
  try { return JSON.parse(localStorage.getItem('shoppingCart') || '[]'); } catch { return []; }
}

export function usePortalSession() {
  const [user, setUser] = useState(null);
  const [clientData, setClientData] = useState(null);
  const [suppliers, setSuppliers] = useState([]);
  const [orders, setOrders] = useState([]);
  const [lastOrderDoc, setLastOrderDoc] = useState(null);
  const [hasMoreOrders, setHasMoreOrders] = useState(false);
  const [isLoadingMoreOrders, setIsLoadingMoreOrders] = useState(false);
  const [balances, setBalances] = useState({ UAH: 0, EUR: 0 });
  const [selectedCurrency, setSelectedCurrencyState] = useState(() => localStorage.getItem('selectedCurrency') || 'EUR');
  const [uahRate, setUahRate] = useState(null);
  const [hasBalances, setHasBalances] = useState(false);
  const [clientPricingRules, setClientPricingRules] = useState(null);
  const [booting, setBooting] = useState(true);

  const [featuredProductsData, setFeaturedProductsData] = useState([]);
  const [showFeatured, setShowFeatured] = useState(false);

  const [products, setProducts] = useState([]);
  const [isFetchingProducts, setIsFetchingProducts] = useState(false);
  const [lastDocSnap, setLastDocSnap] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const [smartPanelMode, setSmartPanelMode] = useState('groups');
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [selectedBrand, setSelectedBrand] = useState(null);
  const [expandedGroup, setExpandedGroup] = useState(null);
  const [brandSearch, setBrandSearch] = useState('');

  const [productGroups, setProductGroups] = useState([]);
  const [allBrands, setAllBrands] = useState([]);
  const [categories, setCategories] = useState([]);

  const [showOnlyInStock, setShowOnlyInStockState] = useState(() => localStorage.getItem('showOnlyInStock') === 'true');
  const [showOnlyPartners, setShowOnlyPartnersState] = useState(() => localStorage.getItem('showOnlyPartners') === 'true');
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [isArticleSearchActive, setIsArticleSearchActive] = useState(false);
  const [articleSearch, setArticleSearch] = useState('');
  const [isSearchingArticle, setIsSearchingArticle] = useState(false);

  const [cart, setCart] = useState(readCart);
  const [placingOrder, setPlacingOrder] = useState(false);
  const [changingPwd, setChangingPwd] = useState(false);

  const brandCacheRef = useRef(new Map());
  const categoryGroupCacheRef = useRef(new Map());
  const productsRef = useRef([]);
  const lastDocRef = useRef(null);
  const groupsRef = useRef([]);
  const brandsRef = useRef([]);

  useEffect(() => { productsRef.current = products; }, [products]);
  useEffect(() => { lastDocRef.current = lastDocSnap; }, [lastDocSnap]);
  useEffect(() => { groupsRef.current = productGroups; }, [productGroups]);
  useEffect(() => { brandsRef.current = allBrands; }, [allBrands]);
  useEffect(() => { localStorage.setItem('shoppingCart', JSON.stringify(cart)); }, [cart]);

  const setSelectedCurrency = useCallback((value) => {
    setSelectedCurrencyState(value);
    localStorage.setItem('selectedCurrency', value);
  }, []);

  const setShowOnlyInStock = useCallback((value) => {
    setShowOnlyInStockState(value);
    localStorage.setItem('showOnlyInStock', String(value));
  }, []);

  const setShowOnlyPartners = useCallback((value) => {
    setShowOnlyPartnersState(value);
    localStorage.setItem('showOnlyPartners', String(value));
  }, []);

  const client = useMemo(
    () => clientData || { name: user?.displayName || user?.phoneNumber || 'Клієнт', priceType: 'роздріб' },
    [clientData, user]
  );

  const sidebarProductGroups = useMemo(() => {
    const base = productGroups.filter((g) => g.id !== FEATURED_GROUP_ID);
    if (showFeatured && featuredProductsData.length > 0) {
      return [
        ...base,
        { id: FEATURED_GROUP_ID, name: 'Нові пропозиції', groupType: 'featured', order: 99999 },
      ];
    }
    return base;
  }, [productGroups, showFeatured, featuredProductsData.length]);

  const loadProductsByBrand = useCallback(async (brandName, loadMore = false) => {
    if (!brandName) {
      setProducts([]);
      setLastDocSnap(null);
      setHasMore(false);
      setIsFetchingProducts(false);
      setIsArticleSearchActive(false);
      return;
    }
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
    if (loadMore) setIsLoadingMore(true);
    else setIsFetchingProducts(true);
    try {
      const brandMeta = findBrandMeta(brandsRef.current, brandName);
      const { items, lastDoc: newLastDoc, hasMore: newHasMore } = await fetchProductsByBrandNames(
        db,
        appId,
        brandMeta ? [brandMeta.name, ...(brandMeta.variants || [])] : [brandName],
        { pageSize: PRODUCT_PAGE_SIZE, lastDocSnap: loadMore ? lastDocRef.current : null, loadMore }
      );
      const updated = loadMore ? [...productsRef.current, ...items] : items;
      setProducts(updated);
      setLastDocSnap(newLastDoc);
      setHasMore(newHasMore);
      brandCacheRef.current.set(brandName, { products: updated, lastDoc: newLastDoc, hasMore: newHasMore });
    } catch (e) {
      logger.error('Помилка завантаження товарів', e);
      if (!loadMore) setProducts([]);
    } finally {
      setIsFetchingProducts(false);
      setIsLoadingMore(false);
    }
  }, []);

  const loadProductsByGroup = useCallback(async (groupId, loadMore = false) => {
    if (!groupId) {
      setProducts([]);
      setLastDocSnap(null);
      setHasMore(false);
      setIsFetchingProducts(false);
      setIsArticleSearchActive(false);
      return;
    }
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
    if (loadMore) setIsLoadingMore(true);
    else setIsFetchingProducts(true);
    try {
      const group = groupsRef.current.find((g) => g.id === groupId);
      if (!group) {
        setProducts([]);
        setIsFetchingProducts(false);
        return;
      }
      const clauses = [];
      const cats = group.categories || [];
      const isCategory = group.groupType === 'category' || group.filterType === 'category';
      if (isCategory && cats.length > 0) {
        clauses.push(where('categories', cats.length === 1 ? 'array-contains' : 'array-contains-any', cats.length === 1 ? cats[0] : cats));
      } else {
        setProducts([]);
        setIsFetchingProducts(false);
        return;
      }
      clauses.push(orderBy('brand'), orderBy('name'), limit(PRODUCT_PAGE_SIZE));
      if (loadMore && lastDocRef.current) clauses.push(startAfter(lastDocRef.current));
      const snap = await getDocs(query(collection(db, `/artifacts/${appId}/public/data/products`), ...clauses));
      const items = snap.docs.map((d) => ({ docId: d.id, ...d.data() }));
      const newLastDoc = snap.docs.at(-1) || null;
      const newHasMore = snap.size === PRODUCT_PAGE_SIZE;
      const updated = loadMore ? [...productsRef.current, ...items] : items;
      setProducts(updated);
      setLastDocSnap(newLastDoc);
      setHasMore(newHasMore);
      categoryGroupCacheRef.current.set(groupId, { products: updated, lastDoc: newLastDoc, hasMore: newHasMore });
    } catch (e) {
      logger.error('Помилка завантаження товарів по групі', e);
      if (!loadMore) setProducts([]);
    } finally {
      setIsFetchingProducts(false);
      setIsLoadingMore(false);
    }
  }, []);

  const loadMoreProducts = useCallback(async () => {
    if (isLoadingMore || !hasMore) return;
    if (selectedBrand) await loadProductsByBrand(selectedBrand, true);
    else if (selectedGroup && selectedGroup !== FEATURED_GROUP_ID) await loadProductsByGroup(selectedGroup, true);
  }, [hasMore, isLoadingMore, loadProductsByBrand, loadProductsByGroup, selectedBrand, selectedGroup]);

  const reloadOrders = useCallback(async (uid) => {
    const who = uid || user?.uid;
    if (!who) return [];
    const ordersQuery = query(
      collection(db, `/artifacts/${appId}/public/data/orders`),
      where('clientId', '==', who),
      orderBy('createdAt', 'desc'),
      limit(ORDERS_PAGE)
    );
    const ordersSnap = await getDocs(ordersQuery);
    const ordersData = ordersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    setOrders(ordersData);
    setLastOrderDoc(ordersSnap.docs[ordersSnap.docs.length - 1] || null);
    setHasMoreOrders(ordersSnap.docs.length === ORDERS_PAGE);
    return ordersData;
  }, [user]);

  const loadMoreOrders = useCallback(async () => {
    if (isLoadingMoreOrders || !hasMoreOrders || !lastOrderDoc || !user) return;
    setIsLoadingMoreOrders(true);
    try {
      const ordersQuery = query(
        collection(db, `/artifacts/${appId}/public/data/orders`),
        where('clientId', '==', user.uid),
        orderBy('createdAt', 'desc'),
        startAfter(lastOrderDoc),
        limit(ORDERS_PAGE)
      );
      const ordersSnap = await getDocs(ordersQuery);
      const next = ordersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setOrders((prev) => [...prev, ...next]);
      setLastOrderDoc(ordersSnap.docs[ordersSnap.docs.length - 1] || null);
      setHasMoreOrders(ordersSnap.docs.length === ORDERS_PAGE);
    } catch (e) {
      logger.error('Помилка завантаження замовлень:', e);
    } finally {
      setIsLoadingMoreOrders(false);
    }
  }, [hasMoreOrders, isLoadingMoreOrders, lastOrderDoc, user]);

  useEffect(() => {
    if (!appId) {
      console.error('VITE_PROJECT_ID environment variable is required');
      return undefined;
    }
    const unsub = onAuthStateChanged(auth, async (currentUser) => {
      if (!currentUser) {
        window.location.href = '/login.html';
        return;
      }
      setUser(currentUser);
      try {
        const clientDocRef = doc(db, `/artifacts/${appId}/public/data/clients`, currentUser.uid);
        const ordersQuery = query(
          collection(db, `/artifacts/${appId}/public/data/orders`),
          where('clientId', '==', currentUser.uid),
          orderBy('createdAt', 'desc'),
          limit(ORDERS_PAGE)
        );
        const [clientSnap, suppSnap, ordersSnap, balancesSnap, brandsSnap, categoriesSnap, brandsMetaSnap] = await Promise.all([
          getDoc(clientDocRef),
          getDocs(collection(db, `/artifacts/${appId}/public/data/suppliers`)),
          getDocs(ordersQuery),
          getDocs(collection(db, `/artifacts/${appId}/public/data/settlements/${currentUser.uid}/balances`)),
          getDocs(query(collection(db, `/artifacts/${appId}/public/meta/brandFolders`))),
          getDocs(query(collection(db, `/artifacts/${appId}/public/meta/categories`))),
          getDocs(query(collection(db, `/artifacts/${appId}/public/meta/brands`))),
        ]);
        setClientData(clientSnap.exists() ? clientSnap.data() : { name: currentUser.phoneNumber || 'Клієнт', priceType: 'роздріб' });
        setSuppliers(suppSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setOrders(ordersSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLastOrderDoc(ordersSnap.docs[ordersSnap.docs.length - 1] || null);
        setHasMoreOrders(ordersSnap.docs.length === ORDERS_PAGE);

        try {
          const rateResult = await httpsCallable(functions, 'getCurrencyRate')();
          if (rateResult.data?.rate) setUahRate(rateResult.data.rate);
        } catch (e) {
          logger.warn('Не вдалося завантажити курс валют', e);
        }
        try {
          const { data } = await httpsCallable(functions, 'getClientPricingRules')({ clientId: currentUser.uid });
          setClientPricingRules(data);
        } catch (e) {
          logger.warn('Не вдалося завантажити правила ціноутворення', e);
          setClientPricingRules({ globalAdjustment: 0, rules: [] });
        }

        const map = {};
        balancesSnap.forEach((ds) => {
          const data = ds.data();
          if (data?.currency) map[data.currency] = Number(data.balance || 0);
        });
        setBalances({
          UAH: -Number(map.UAH || 0),
          EUR: -Number(map.EUR || 0),
        });
        setHasBalances(!balancesSnap.empty);
        setProducts([]);
        setProductGroups(
          brandsSnap.docs
            .map((d) => ({ id: d.id, ...d.data() }))
            .sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.name || '').localeCompare(String(b.name || ''), 'uk'))
        );
        setCategories(
          categoriesSnap.docs
            .map((d) => ({ id: d.id, ...d.data() }))
            .sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.name || '').localeCompare(String(b.name || ''), 'uk'))
        );
        setAllBrands(
          brandsMetaSnap.docs
            .map((d) => {
              const data = d.data() || {};
              return { id: d.id, name: data.name, variants: data.variants || [] };
            })
            .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'uk'))
        );
      } catch (e) {
        logger.error(e);
      } finally {
        setBooting(false);
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!user) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const featuredSnap = await getDoc(doc(db, `/artifacts/${appId}/public/data/featuredProducts/main`));
        if (!featuredSnap.exists()) {
          if (!cancelled) {
            setFeaturedProductsData([]);
            setShowFeatured(false);
          }
          return;
        }
        let items = featuredSnap.data().items || [];
        items = [...items].sort((a, b) => {
          const aTime = a.addedAt?.seconds || a.addedAt?._seconds || 0;
          const bTime = b.addedAt?.seconds || b.addedAt?._seconds || 0;
          return bTime - aTime;
        });
        const loaded = await Promise.all(items.map(async (item, index) => {
          try {
            let docId = item.docId || null;
            let data = null;
            if (docId) {
              const snap = await getDoc(doc(db, `/artifacts/${appId}/public/data/products/${docId}`));
              if (snap.exists()) data = snap.data();
            }
            if (!data) {
              const productSnap = await getDocs(query(
                collection(db, `/artifacts/${appId}/public/data/products`),
                where('brand', '==', item.brand),
                where('id', '==', item.id),
                limit(1)
              ));
              if (productSnap.empty) return null;
              docId = productSnap.docs[0].id;
              data = productSnap.docs[0].data();
            }
            const detailsSnap = await getDoc(doc(db, `/artifacts/${appId}/public/data/products/${docId}/details/main`));
            const details = detailsSnap.exists() ? detailsSnap.data() || {} : {};
            return {
              docId,
              ...data,
              imageThumbUrl: String(details.imageThumbUrl || ''),
              imageUrl: String(details.imageUrl || ''),
              featuredIndex: index,
              featuredAddedAt: item.addedAt,
            };
          } catch (e) {
            logger.warn('Failed to load featured product', item.brand, item.id, e);
            return null;
          }
        }));
        if (cancelled) return;
        const visible = filterFeaturedWithWarehouseStock(
          loaded.filter(Boolean).sort((a, b) => (a.featuredIndex || 0) - (b.featuredIndex || 0))
        );
        setFeaturedProductsData(visible);
        setShowFeatured(visible.length > 0);
      } catch (e) {
        logger.error('Failed to load featured products', e);
        if (!cancelled) {
          setFeaturedProductsData([]);
          setShowFeatured(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  useEffect(() => {
    if (selectedBrand || selectedGroup || selectedCategory) setIsArticleSearchActive(false);
  }, [selectedBrand, selectedGroup, selectedCategory]);

  useEffect(() => { setIsArticleSearchActive(false); }, [showOnlyInStock, showOnlyPartners]);

  useEffect(() => {
    if (!articleSearch.trim() && isArticleSearchActive) setIsArticleSearchActive(false);
  }, [articleSearch, isArticleSearchActive]);

  const resetCatalogSelection = useCallback(() => {
    setSelectedBrand(null);
    setSelectedGroup(null);
    setExpandedGroup(null);
    setSelectedCategory(null);
    setProducts([]);
    setLastDocSnap(null);
    setHasMore(false);
    setIsArticleSearchActive(false);
  }, []);

  const openGroup = useCallback((group) => {
    const groupType = group.groupType || (group.filterType === 'category' ? 'category' : 'preset');
    if (groupType === 'featured') {
      setSelectedGroup(FEATURED_GROUP_ID);
      setSelectedBrand(null);
      setSelectedCategory(null);
      setProducts([]);
      setLastDocSnap(null);
      setHasMore(false);
      return 'close';
    }
    if (groupType === 'preset' && group.brands && group.brands.length > 0) {
      if (group.brands.length === 1) {
        setSelectedBrand(group.brands[0]);
        setSelectedGroup(null);
        setLastDocSnap(null);
        setHasMore(false);
        loadProductsByBrand(group.brands[0], false);
        return 'close';
      }
      setExpandedGroup((cur) => {
        if (cur === group.id) {
          if (selectedGroup === group.id) setSelectedGroup(null);
          return null;
        }
        return group.id;
      });
      return 'stay';
    }
    setSelectedGroup(group.id);
    setSelectedBrand(null);
    setLastDocSnap(null);
    setHasMore(false);
    loadProductsByGroup(group.id, false);
    return 'close';
  }, [loadProductsByBrand, loadProductsByGroup, selectedGroup]);

  const openBrand = useCallback((brandName) => {
    setSelectedBrand(brandName);
    setSelectedGroup(null);
    setLastDocSnap(null);
    setHasMore(false);
    loadProductsByBrand(brandName, false);
  }, [loadProductsByBrand]);

  const searchArticle = useCallback(async () => {
    const article = articleSearch.trim();
    if (!article) return { ok: false };
    setIsSearchingArticle(true);
    try {
      const { data } = await httpsCallable(functions, 'searchProductsByArticle')({ article });
      if (data?.ok) {
        setSelectedBrand(null);
        setSelectedGroup(null);
        setSelectedCategory(null);
        setProducts(data.products || []);
        setLastDocSnap(null);
        setHasMore(false);
        setIsArticleSearchActive(true);
        return { ok: true };
      }
      setProducts([]);
      setIsArticleSearchActive(false);
      return { ok: false };
    } catch (e) {
      logger.error('Помилка пошуку:', e);
      setProducts([]);
      setIsArticleSearchActive(false);
      return { ok: false, error: e?.message || 'Пошук не вдався' };
    } finally {
      setIsSearchingArticle(false);
    }
  }, [articleSearch]);

  const clearArticleSearch = useCallback(() => {
    setArticleSearch('');
    setIsArticleSearchActive(false);
    if (selectedBrand) loadProductsByBrand(selectedBrand, false);
    else if (selectedGroup && selectedGroup !== FEATURED_GROUP_ID) loadProductsByGroup(selectedGroup, false);
    else {
      setProducts([]);
      setLastDocSnap(null);
      setHasMore(false);
    }
  }, [loadProductsByBrand, loadProductsByGroup, selectedBrand, selectedGroup]);

  const addToCart = useCallback((product, price, quantity) => {
    const supplier = product.selectedSupplier || WAREHOUSE_SUPPLIER;
    let basePriceEUR = price;
    if (selectedCurrency === 'UAH' && uahRate && uahRate > 0) {
      basePriceEUR = Math.round((price / uahRate) * 100) / 100;
    }
    let isNew = false;
    setCart((cur) => {
      const ex = cur.find((i) => i.docId === product.docId && i.supplier === supplier);
      isNew = !ex;
      const lineStock = Number(product.selectedOffer?.stock ?? product.stock ?? 0);
      if (ex) {
        return cur.map((i) => (
          i.docId === product.docId && i.supplier === supplier
            ? { ...i, quantity: i.quantity + quantity, stock: lineStock }
            : i
        ));
      }
      return [...cur, { ...product, supplier, stock: lineStock, price: basePriceEUR, quantity }];
    });
    return { isNew, name: product.name || 'Товар' };
  }, [selectedCurrency, uahRate]);

  const setLineQty = useCallback((docId, supplier, qty) => {
    const next = Math.max(1, Number(qty) || 1);
    setCart((cur) => cur.map((i) => (i.docId === docId && i.supplier === supplier ? { ...i, quantity: next } : i)));
  }, []);

  const removeLine = useCallback((docId, supplier) => {
    setCart((cur) => cur.filter((i) => !(i.docId === docId && i.supplier === supplier)));
  }, []);

  const repeatOrder = useCallback(async (order) => {
    const items = Array.isArray(order?.items) ? order.items : [];
    const lines = await Promise.all(items.map(async (item) => {
      const supplier = String(item.supplier || '').trim();
      const docId = item.docId;
      if (!docId || !supplier) return { skipped: true };
      let price = Number(item.price) || 0;
      let stock = null;
      let product = {
        docId,
        id: item.id,
        brand: item.brand,
        name: item.name,
      };
      let pricedFromCatalog = false;
      try {
        const snap = await getDoc(doc(db, `/artifacts/${appId}/public/data/products/${docId}`));
        if (snap.exists()) {
          const data = snap.data();
          const offer = (data.offers || []).find((o) => o.supplier === supplier);
          product = { docId: snap.id, ...data };
          if (offer) {
            const fresh = calculateProductPrice({
              product: { brand: data.brand, id: data.id },
              offer,
              client,
              clientPricingRules,
              selectedCurrency: 'EUR',
              uahRate: null,
            });
            if (fresh > 0) {
              price = fresh;
              pricedFromCatalog = true;
            }
            stock = availableStock(data, offer);
          }
        }
      } catch (e) {
        logger.warn('repeatOrder price refresh', docId, e);
      }
      return {
        skipped: false,
        pricedFromCatalog,
        line: {
          ...product,
          supplier,
          stock,
          price,
          quantity: Math.max(1, Number(item.quantity) || 1),
        },
      };
    }));
    const ready = lines.filter((l) => l && !l.skipped);
    setCart((cur) => {
      let next = [...cur];
      for (const row of ready) {
        const line = row.line;
        const ex = next.find((i) => i.docId === line.docId && i.supplier === line.supplier);
        if (ex) {
          next = next.map((i) => (
            i.docId === line.docId && i.supplier === line.supplier
              ? { ...line, quantity: i.quantity + line.quantity }
              : i
          ));
        } else {
          next = [...next, line];
        }
      }
      return next;
    });
    return {
      added: ready.length,
      skipped: lines.length - ready.length,
      stalePrice: ready.filter((l) => !l.pricedFromCatalog).length,
    };
  }, [client, clientPricingRules]);

  const placeOrder = useCallback(async (note) => {
    if (!user) return { ok: false, error: 'Потрібен вхід.' };
    const cartItems = cart;
    if (!cartItems.length) return { ok: false, error: 'Кошик порожній.' };

    const warehouseDocIds = [...new Set(cartItems.filter((it) => it.supplier === WAREHOUSE_SUPPLIER && it.docId).map((it) => it.docId))];
    if (warehouseDocIds.length > 0) {
      try {
        const stockByDocId = {};
        await Promise.all(warehouseDocIds.map(async (docId) => {
          const snap = await getDoc(doc(db, `/artifacts/${appId}/public/data/products/${docId}`));
          stockByDocId[docId] = snap.exists()
            ? warehouseStockFromProductDoc(snap.data())
            : (getCartLineStock(cartItems.find((c) => c.docId === docId)) ?? 0);
        }));
        const warnLines = buildStockWarningLines(cartItems, stockByDocId);
        if (warnLines.length && !confirmStockOverOrder(warnLines)) return { ok: false, cancelled: true };
      } catch (e) {
        logger.error('Перевірка залишку перед замовленням:', e);
        const fallbackLines = buildStockWarningLines(cartItems, null);
        if (fallbackLines.length && !confirmStockOverOrder(fallbackLines)) return { ok: false, cancelled: true };
      }
    }

    const displayTotal = cartItems.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0);
    setPlacingOrder(true);
    try {
      const payload = {
        items: cartItems,
        total: Math.round(displayTotal * 100) / 100,
        clientRequestId: (typeof crypto !== 'undefined' && crypto.randomUUID)
          ? crypto.randomUUID()
          : `${Date.now()}${Math.random().toString(16).slice(2)}`,
        clientName: client.name ?? null,
        clientPhone: client.phone ?? null,
        clientEmail: user?.email ?? null,
        priceCategory: client.priceType || 'ціна 1',
        note: String(note || '').trim(),
      };
      const { data } = await httpsCallable(functions, 'placeOrderV2')(payload);
      setCart([]);
      let list = [];
      try { list = await reloadOrders(user.uid); } catch (e) { logger.warn('reload orders', e); }
      return {
        ok: true,
        orderId: data?.orderId || null,
        orderNumber: data?.orderNumber || null,
        reused: !!data?.reused,
        visible: list.some((o) => o.id === data?.orderId),
      };
    } catch (e) {
      logger.error('Помилка оформлення замовлення:', e);
      return { ok: false, error: e?.message || 'Не вдалося відправити замовлення.' };
    } finally {
      setPlacingOrder(false);
    }
  }, [cart, client, reloadOrders, user]);

  const changePassword = useCallback(async (currentPassword, newPassword, confirmPassword) => {
    setChangingPwd(true);
    try {
      await httpsCallable(functions, 'clientChangePassword')({ currentPassword, newPassword, confirmPassword });
    } finally {
      setChangingPwd(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await signOut(auth);
    localStorage.removeItem('shoppingCart');
    window.location.href = '/login.html';
  }, []);

  return {
    appId,
    booting,
    user,
    client,
    suppliers,
    clientPricingRules,
    balances,
    hasBalances,
    uahRate,
    selectedCurrency,
    setSelectedCurrency,
    orders,
    hasMoreOrders,
    isLoadingMoreOrders,
    loadMoreOrders,
    featuredProductsData,
    showFeatured,
    products,
    isFetchingProducts,
    hasMore,
    isLoadingMore,
    loadMoreProducts,
    sidebarProductGroups,
    allBrands,
    categories,
    smartPanelMode,
    setSmartPanelMode,
    selectedGroup,
    selectedBrand,
    expandedGroup,
    brandSearch,
    setBrandSearch,
    openGroup,
    openBrand,
    resetCatalogSelection,
    showOnlyInStock,
    setShowOnlyInStock,
    showOnlyPartners,
    setShowOnlyPartners,
    selectedCategory,
    setSelectedCategory,
    articleSearch,
    setArticleSearch,
    searchArticle,
    clearArticleSearch,
    isSearchingArticle,
    isArticleSearchActive,
    cart,
    addToCart,
    setLineQty,
    removeLine,
    repeatOrder,
    placeOrder,
    placingOrder,
    changePassword,
    changingPwd,
    logout,
  };
}
