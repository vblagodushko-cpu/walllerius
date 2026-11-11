import React, { useMemo, useState } from 'react';
import ProductCatalog from '../components/ProductCatalog.jsx';
import FeaturedProductCards from '../components/FeaturedProductCards.jsx';
import OrderHistory from '../OrderHistory.jsx';
import SettlementsPage from '../SettlementsPage.jsx';
import useDebouncedValue from '../admin/hooks/useDebouncedValue.js';
import { FEATURED_GROUP_ID, usePortalSession } from './usePortalSession.js';
import CatalogSidebar from './CatalogSidebar.jsx';
import CartSheet from './CartSheet.jsx';
import ProfilePanel from './ProfilePanel.jsx';

const VIEWS = [
  { id: 'products', label: 'Товари' },
  { id: 'orders', label: 'Замовлення' },
  { id: 'settlements', label: 'Звірка' },
  { id: 'profile', label: 'Профіль' },
];

function productHaystack(product) {
  return [
    product?.name,
    product?.id,
    product?.brand,
    product?.pack,
    product?.viscosities,
    product?.tolerances,
    ...(Array.isArray(product?.viscosityTags) ? product.viscosityTags : []),
    ...(Array.isArray(product?.toleranceTags) ? product.toleranceTags : []),
  ].filter(Boolean).join(' ').toLowerCase();
}

function BalanceChip({ code, amount, known, onOpen }) {
  if (!known) {
    return <span className="rounded-full bg-stone-100 px-3 py-1 text-xs text-stone-500">Баланс ще не синхронізовано</span>;
  }
  const value = Number(amount || 0);
  const tone = value < 0 ? 'text-red-700 bg-red-50' : value > 0 ? 'text-emerald-800 bg-emerald-50' : 'text-stone-700 bg-stone-100';
  const word = value < 0 ? 'борг' : value > 0 ? 'переплата' : 'нуль';
  return (
    <button type="button" onClick={onOpen} className={`rounded-full px-3 py-1 text-left text-xs font-medium ${tone}`}>
      {code} {Math.abs(value).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · {word}
    </button>
  );
}

function Toggle({ checked, onChange, label }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-stone-700">
      <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="relative h-6 w-11 rounded-full bg-stone-300 after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:transition peer-checked:bg-indigo-700 peer-checked:after:translate-x-5" />
      {label}
    </label>
  );
}

export default function PortalNextApp() {
  const session = usePortalSession();
  const [view, setViewState] = useState(() => {
    const initial = new URLSearchParams(window.location.search).get('view');
    return VIEWS.some((item) => item.id === initial) ? initial : 'products';
  });
  const setView = (id) => {
    setViewState(id);
    const url = new URL(window.location.href);
    if (id === 'products') url.searchParams.delete('view');
    else url.searchParams.set('view', id);
    window.history.replaceState(null, '', url);
  };
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [notice, setNotice] = useState(null);
  const [focusOrderId, setFocusOrderId] = useState(null);
  const [ledgerCurrency, setLedgerCurrency] = useState(null);
  const [ledgerNonce, setLedgerNonce] = useState(0);
  const [listQuery, setListQuery] = useState('');
  const [repeating, setRepeating] = useState(false);
  const debouncedListQuery = useDebouncedValue(listQuery, 400);

  const showToast = (message) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 4000);
  };

  const openLedger = (currency) => {
    setLedgerCurrency(currency);
    setLedgerNonce((n) => n + 1);
    setView('settlements');
  };

  const visibleProducts = useMemo(() => {
    const q = debouncedListQuery.trim().toLowerCase();
    if (!q) return session.products;
    return session.products.filter((p) => productHaystack(p).includes(q));
  }, [session.products, debouncedListQuery]);

  const visibleFeatured = useMemo(() => {
    const q = debouncedListQuery.trim().toLowerCase();
    if (!q) return session.featuredProductsData;
    return session.featuredProductsData.filter((p) => productHaystack(p).includes(q));
  }, [session.featuredProductsData, debouncedListQuery]);

  const showFeaturedBlock = session.showFeatured && (
    session.selectedGroup === FEATURED_GROUP_ID
    || (!session.selectedBrand && !session.selectedGroup && !session.selectedCategory && !session.isArticleSearchActive)
  );

  const catalogTitle = session.isArticleSearchActive
    ? `Пошук «${session.articleSearch.trim()}»`
    : session.selectedBrand
      || (session.selectedGroup && session.selectedGroup !== FEATURED_GROUP_ID
        ? session.sidebarProductGroups.find((g) => g.id === session.selectedGroup)?.name
        : '');

  const onAddToCart = (product, price, quantity) => {
    const { isNew, name } = session.addToCart(product, price, quantity);
    showToast(isNew ? `«${name}» додано в кошик` : `Кількість «${name}» оновлено`);
  };

  const onPlaceOrder = async (note) => {
    const result = await session.placeOrder(note);
    if (result.cancelled) return result;
    if (!result.ok) return result;
    setCartOpen(false);
    setFocusOrderId(result.orderId);
    setView('orders');
    setNotice({
      tone: 'ok',
      text: result.orderNumber
        ? `Замовлення №${result.orderNumber} відправлено.`
        : 'Замовлення відправлено.',
    });
    return result;
  };

  const onRepeat = async (order) => {
    if (repeating) return;
    setRepeating(true);
    try {
      const stats = await session.repeatOrder(order);
      setCartOpen(true);
      const bits = [`У кошик додано ${stats.added}`];
      if (stats.skipped) bits.push(`пропущено ${stats.skipped}`);
      if (stats.stalePrice) bits.push(`без свіжої ціни ${stats.stalePrice}`);
      showToast(bits.join(', '));
    } finally {
      setRepeating(false);
    }
  };

  const runArticleSearch = async () => {
    setView('products');
    setCatalogOpen(false);
    const result = await session.searchArticle();
    if (result?.error) setNotice({ tone: 'err', text: result.error });
    else if (result && result.ok === false) setNotice({ tone: 'err', text: 'За цим артикулом нічого не знайдено.' });
    else setNotice(null);
  };

  if (session.booting) {
    return <div className="grid min-h-screen place-items-center bg-stone-100 text-stone-500">Відкриваємо портал…</div>;
  }

  const qtyCount = session.cart.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);

  return (
    <div className="min-h-screen bg-stone-100 pb-24 text-stone-900 md:pb-8">
      <header className="sticky top-0 z-30 border-b border-stone-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
          <a href="https://olimp-auto.biz" target="_blank" rel="noopener noreferrer" className="shrink-0">
            <img src="/logo.png" alt="Olimp Auto" className="h-10" />
          </a>
          <form
            className="flex min-w-[16rem] flex-1 items-center gap-2"
            onSubmit={(e) => { e.preventDefault(); runArticleSearch(); }}
          >
            <input
              type="search"
              value={session.articleSearch}
              onChange={(e) => session.setArticleSearch(e.target.value)}
              placeholder="Артикул, напр. KL 200"
              className="w-full rounded-xl border border-stone-200 px-3 py-2 text-sm outline-none focus:border-indigo-500"
            />
            <button type="submit" disabled={session.isSearchingArticle} className="rounded-xl bg-indigo-700 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-800 disabled:opacity-50">
              {session.isSearchingArticle ? '…' : 'Знайти'}
            </button>
            {session.articleSearch || session.isArticleSearchActive ? (
              <button type="button" className="rounded-xl px-2 py-2 text-sm text-stone-600 hover:bg-stone-100" onClick={() => { session.clearArticleSearch(); setNotice(null); }}>
                Скинути
              </button>
            ) : null}
          </form>
          <button type="button" className="relative rounded-xl bg-indigo-700 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-800" onClick={() => setCartOpen(true)}>
            Кошик{qtyCount ? ` · ${qtyCount}` : ''}
          </button>
          <div className="relative">
            <button type="button" className="rounded-xl bg-stone-100 px-3 py-2 text-sm hover:bg-stone-200" onClick={() => setMenuOpen((v) => !v)}>
              {session.client?.name || 'Профіль'}
            </button>
            {menuOpen ? (
              <div className="absolute right-0 z-40 mt-2 w-52 rounded-2xl border border-stone-200 bg-white p-2 text-sm shadow-lg">
                <button type="button" className="block w-full rounded-xl px-3 py-2 text-left hover:bg-stone-50" onClick={() => { setView('profile'); setMenuOpen(false); }}>Профіль і пароль</button>
                <a href="/portal.html" className="block rounded-xl px-3 py-2 hover:bg-stone-50">Класичний портал</a>
                <button type="button" className="block w-full rounded-xl px-3 py-2 text-left text-red-700 hover:bg-red-50" onClick={session.logout}>Вийти</button>
              </div>
            ) : null}
          </div>
        </div>
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 pb-3">
          <BalanceChip code="UAH" amount={session.balances.UAH} known={session.hasBalances} onOpen={() => openLedger('UAH')} />
          <BalanceChip code="EUR" amount={session.balances.EUR} known={session.hasBalances} onOpen={() => openLedger('EUR')} />
          {session.uahRate ? <span className="text-xs text-stone-500">Курс {Number(session.uahRate).toFixed(2)}</span> : null}
          <div className="ml-auto flex rounded-xl bg-stone-100 p-1 text-sm">
            {['EUR', 'UAH'].map((code) => (
              <button
                key={code}
                type="button"
                onClick={() => session.setSelectedCurrency(code)}
                className={`rounded-lg px-3 py-1 ${session.selectedCurrency === code ? 'bg-white font-medium text-indigo-700 shadow-sm' : 'text-stone-600'}`}
              >
                {code}
              </button>
            ))}
          </div>
          <nav className="hidden items-center gap-1 md:flex">
            {VIEWS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setView(item.id)}
                className={`rounded-xl px-3 py-1.5 text-sm ${view === item.id ? 'bg-indigo-700 text-white' : 'text-stone-600 hover:bg-stone-100'}`}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-4">
        {notice ? (
          <div className={`mb-4 flex items-start justify-between gap-3 rounded-2xl px-4 py-3 text-sm ${notice.tone === 'ok' ? 'bg-emerald-50 text-emerald-900' : 'bg-red-50 text-red-800'}`}>
            <span>{notice.text}</span>
            <button type="button" className="text-xs uppercase tracking-wide" onClick={() => setNotice(null)}>Закрити</button>
          </div>
        ) : null}

        {view === 'products' ? (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-3 rounded-2xl border border-stone-200 bg-white px-3 py-2">
              <button type="button" className="rounded-xl bg-stone-900 px-3 py-1.5 text-sm text-white md:hidden" onClick={() => setCatalogOpen(true)}>Каталог</button>
              <Toggle checked={session.showOnlyInStock} onChange={session.setShowOnlyInStock} label="Наявні" />
              <Toggle checked={session.showOnlyPartners} onChange={session.setShowOnlyPartners} label="Партнери" />
              {session.categories.length > 0 ? (
                <select
                  className="rounded-xl border border-stone-200 px-2 py-1.5 text-sm"
                  value={session.selectedCategory || ''}
                  onChange={(e) => session.setSelectedCategory(e.target.value || null)}
                >
                  <option value="">Усі категорії</option>
                  {session.categories.map((cat) => (
                    <option key={cat.id} value={cat.name || cat.id}>{cat.name || cat.id}</option>
                  ))}
                </select>
              ) : null}
              <input
                type="search"
                value={listQuery}
                onChange={(e) => setListQuery(e.target.value)}
                placeholder="Фільтр списку: назва, вʼязкість"
                className="w-full rounded-xl border border-stone-200 px-3 py-1.5 text-sm outline-none focus:border-indigo-400 sm:w-auto sm:min-w-[12rem] sm:flex-1"
              />
            </div>
            <div className="md:grid md:grid-cols-12 md:gap-4">
              <aside className={`fixed inset-y-0 left-0 z-40 flex w-[min(90vw,20rem)] bg-stone-100 p-3 shadow-xl transition-transform md:static md:z-auto md:col-span-3 md:block md:max-h-[calc(100vh-8rem)] md:w-auto md:translate-x-0 md:bg-transparent md:p-0 md:shadow-none ${catalogOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
                <CatalogSidebar
                  mode={session.smartPanelMode}
                  onMode={session.setSmartPanelMode}
                  groups={session.sidebarProductGroups}
                  expandedGroup={session.expandedGroup}
                  selectedGroup={session.selectedGroup}
                  selectedBrand={session.selectedBrand}
                  brands={session.allBrands}
                  brandSearch={session.brandSearch}
                  onBrandSearch={session.setBrandSearch}
                  onClose={() => setCatalogOpen(false)}
                  onOpenGroup={(group) => {
                    const action = session.openGroup(group);
                    if (action === 'close') setCatalogOpen(false);
                  }}
                  onOpenBrand={(name) => {
                    session.openBrand(name);
                    setCatalogOpen(false);
                  }}
                />
              </aside>
              {catalogOpen ? <button type="button" className="fixed inset-0 z-30 bg-stone-900/40 md:hidden" aria-label="Закрити каталог" onClick={() => setCatalogOpen(false)} /> : null}
              <section className="md:col-span-9">
                {catalogTitle || session.selectedBrand || session.selectedGroup || session.isArticleSearchActive ? (
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h1 className="text-lg font-semibold">{catalogTitle}</h1>
                  <button type="button" className="text-sm text-indigo-700" onClick={session.resetCatalogSelection}>До початку</button>
                </div>
                ) : null}
                {session.isFetchingProducts ? <p className="py-8 text-center text-sm text-stone-500">Завантаження товарів…</p> : null}
                {showFeaturedBlock ? (
                  <FeaturedProductCards
                    appId={session.appId}
                    items={visibleFeatured}
                    client={session.client}
                    clientPricingRules={session.clientPricingRules}
                    selectedCurrency={session.selectedCurrency}
                    uahRate={session.uahRate}
                    showOnlyInStock={session.showOnlyInStock}
                    showOnlyPartners={session.showOnlyPartners}
                    onAddToCart={onAddToCart}
                  />
                ) : null}
                {session.isArticleSearchActive || session.selectedBrand || (session.selectedGroup && session.selectedGroup !== FEATURED_GROUP_ID) || session.selectedCategory || visibleProducts.length > 0 ? (
                <ProductCatalog
                  appId={session.appId}
                  products={visibleProducts}
                  client={session.client}
                  suppliers={session.suppliers}
                  onAddToCart={onAddToCart}
                  showOnlyInStock={session.showOnlyInStock}
                  showOnlyPartners={session.showOnlyPartners}
                  selectedCategory={session.selectedCategory}
                  clientPricingRules={session.clientPricingRules}
                  selectedCurrency={session.selectedCurrency}
                  uahRate={session.uahRate}
                  isArticleSearchActive={session.isArticleSearchActive}
                  excludeDocIds={showFeaturedBlock ? visibleFeatured.map((p) => p.docId).filter(Boolean) : []}
                />
                ) : !session.isFetchingProducts && !showFeaturedBlock ? (
                  <p className="rounded-2xl border border-dashed border-stone-300 bg-white px-4 py-8 text-center text-sm text-stone-500">Оберіть групу або бренд у каталозі, або знайдіть товар за артикулом.</p>
                ) : null}
                {session.hasMore && !session.isFetchingProducts ? (
                  <div className="mt-4 text-center">
                    <button type="button" className="rounded-xl bg-indigo-700 px-5 py-2 text-sm text-white disabled:opacity-50" disabled={session.isLoadingMore} onClick={session.loadMoreProducts}>
                      {session.isLoadingMore ? 'Завантаження…' : 'Завантажити ще'}
                    </button>
                  </div>
                ) : null}
              </section>
            </div>
          </>
        ) : null}

        {view === 'orders' ? (
          <OrderHistory
            orders={session.orders}
            onFetchMore={session.loadMoreOrders}
            hasMore={session.hasMoreOrders}
            isFetchingMore={session.isLoadingMoreOrders}
            selectedCurrency={session.selectedCurrency}
            uahRate={session.uahRate}
            onRepeat={onRepeat}
            focusOrderId={focusOrderId}
          />
        ) : null}

        {view === 'settlements' ? (
          <SettlementsPage
            balances={session.balances}
            client={session.client}
            user={session.user}
            initialCurrency={ledgerCurrency || session.selectedCurrency}
            currencyNonce={ledgerNonce}
            showPresets
          />
        ) : null}

        {view === 'profile' ? (
          <ProfilePanel
            client={session.client}
            user={session.user}
            onChangePassword={session.changePassword}
            changing={session.changingPwd}
            onLogout={session.logout}
          />
        ) : null}
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-stone-200 bg-white md:hidden">
        {VIEWS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setView(item.id)}
            className={`px-2 py-3 text-xs font-medium ${view === item.id ? 'text-indigo-700' : 'text-stone-500'}`}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {toast ? (
        <div className="animate-slide-in-right fixed right-4 top-24 z-50 max-w-sm rounded-2xl border border-stone-200 bg-white p-3 text-sm shadow-lg">
          <p>{toast}</p>
          <button type="button" className="mt-1 text-indigo-700" onClick={() => { setCartOpen(true); setToast(null); }}>Відкрити кошик</button>
        </div>
      ) : null}

      <CartSheet
        open={cartOpen}
        onClose={() => setCartOpen(false)}
        items={session.cart}
        currency={session.selectedCurrency}
        uahRate={session.uahRate}
        onChangeQty={session.setLineQty}
        onRemove={session.removeLine}
        onPlaceOrder={onPlaceOrder}
        placing={session.placingOrder}
      />
    </div>
  );
}
