import React, { useState, useMemo, useCallback } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../firebase-config';
import Tooltip from './Tooltip.jsx';
import {
  calculateProductPrice,
  getPriceFromPublicPrices,
  filterAndSortOffers,
} from '../utils/productPricing.js';
import AddToCartModal from './AddToCartModal.jsx';
import ProductDetailModal from './ProductDetailModal.jsx';

const MAX_DETAIL_BODY_CHARS = 80000;

const ProductCatalog = ({
  appId,
  products,
  client,
  onAddToCart,
  suppliers,
  showOnlyInStock = false,
  showOnlyPartners = false,
  selectedCategory = null,
  clientPricingRules = null,
  selectedCurrency = 'EUR',
  uahRate = null,
  excludeDocIds = [],
  isArticleSearchActive = false,
}) => {
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [detailModal, setDetailModal] = useState(null);
  const [detailBody, setDetailBody] = useState('');
  const [detailImageUrl, setDetailImageUrl] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  const openProductDetail = useCallback(
    async (productRow) => {
      if (!appId || !productRow?.docId) return;
      setDetailModal({
        docId: productRow.docId,
        brand: productRow.brand,
        id: productRow.id,
        name: productRow.name,
        pack: productRow.pack || "",
        tolerances: productRow.tolerances || "",
        toleranceTags: Array.isArray(productRow.toleranceTags) ? productRow.toleranceTags : [],
      });
      setDetailBody('');
      setDetailImageUrl('');
      setDetailError('');
      setDetailLoading(true);
      try {
        const ref = doc(
          db,
          `/artifacts/${appId}/public/data/products/${productRow.docId}/details/main`
        );
        const snap = await getDoc(ref);
        const d = snap.exists() ? snap.data() || {} : {};
        const raw = String(d.body ?? '');
        setDetailBody(raw.length > MAX_DETAIL_BODY_CHARS ? raw.slice(0, MAX_DETAIL_BODY_CHARS) : raw);
        setDetailImageUrl(String(d.imageUrl || d.imageThumbUrl || ''));
      } catch (e) {
        console.error('Product detail load', e);
        setDetailError(e?.message || 'Не вдалося завантажити опис');
      } finally {
        setDetailLoading(false);
      }
    },
    [appId]
  );

  const closeProductDetail = useCallback(() => {
    setDetailModal(null);
    setDetailBody('');
    setDetailImageUrl('');
    setDetailError('');
    setDetailLoading(false);
  }, []);
  
  // Функція для відкриття пошуку в Google
  const openGoogleSearch = (productName, productId) => {
    const searchQuery = encodeURIComponent(`${productName} ${productId}`);
    window.open(`https://www.google.com/search?q=${searchQuery}`, '_blank');
  };

  const excludeSet = useMemo(() => {
    if (excludeDocIds instanceof Set) return excludeDocIds;
    return new Set(Array.isArray(excludeDocIds) ? excludeDocIds.filter(Boolean) : []);
  }, [excludeDocIds]);

  const calculatePrice = (product, offer = null) =>
    calculateProductPrice({
      product,
      offer,
      client,
      clientPricingRules,
      selectedCurrency,
      uahRate,
    });

  const getPrice = (publicPrices) =>
    getPriceFromPublicPrices(publicPrices, client.priceType);

  const getSupplierComment = (supplierName) => {
    const supplier = suppliers.find(s => s.name === supplierName);
    return supplier?.comment || 'Умови доставки не вказані.';
  };

  // Обробка offers[] та створення рядків для відображення (як в адмін-панелі)
  const offerFilterOpts = useMemo(
    () => ({
      showOnlyPartners,
      showOnlyInStock,
      isArticleSearchActive,
      clientPricingRules,
      client,
    }),
    [showOnlyPartners, showOnlyInStock, isArticleSearchActive, clientPricingRules, client]
  );

  const displayRows = useMemo(() => {
    const rows = [];

    for (const product of products) {
      if (product.docId && excludeSet.has(product.docId)) continue;
      // Фільтр по категорії (якщо вибрано)
      if (selectedCategory) {
        const productCategories = Array.isArray(product.categories) ? product.categories : [];
        if (!productCategories.includes(selectedCategory)) {
          continue;
        }
      }

      const filteredOffers = filterAndSortOffers(product, offerFilterOpts);
      if (filteredOffers.length === 0) continue;

      for (const offer of filteredOffers) {
        rows.push({
          docId: product.docId,
          brand: product.brand || "",
          id: product.id || "",
          name: product.name || "",
          supplier: offer.supplier || "",
          stock: offer.stock ?? 0,
          publicPrices: offer.publicPrices || {},
        });
      }
    }
    
    return rows;
  }, [products, excludeSet, offerFilterOpts, selectedCategory]);

  // Групування рядків по товарах для rowspan
  const groupedRows = useMemo(() => {
    const groups = [];
    let currentGroup = null;
    
    for (const row of displayRows) {
      const key = `${row.docId}`;
      
      if (!currentGroup || currentGroup.key !== key) {
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
        currentGroup.offers.push(row);
      }
    }
    
    if (currentGroup) {
      groups.push(currentGroup);
    }
    
    return groups;
  }, [displayRows]);

  const infoButtonClass =
    'flex-shrink-0 p-1 rounded text-gray-500 hover:text-indigo-600 hover:bg-indigo-50 transition-colors';
  const InfoIcon = () => (
    <span className="text-xs font-semibold leading-none px-1" aria-hidden>
      i
    </span>
  );

  return (
    <>
      {selectedProduct && <AddToCartModal product={selectedProduct} onAddToCart={(q)=>{ onAddToCart(selectedProduct, calculatePrice(selectedProduct, selectedProduct.selectedOffer), q); setSelectedProduct(null); }} onClose={()=>setSelectedProduct(null)} />}
      {detailModal && (
        <ProductDetailModal
          product={detailModal}
          body={detailBody}
          imageUrl={detailImageUrl}
          loading={detailLoading}
          error={detailError}
          onClose={closeProductDetail}
        />
      )}
      <div className="bg-white p-6 rounded-lg shadow-md">
        {/* Мобільний вигляд: картки, акцент на назві та ціні */}
        <div className="flex flex-col gap-3 sm:hidden">
          {displayRows.map((row, idx) => {
            const productForPrice = { brand: row.brand, id: row.id };
            const offerForPrice = { supplier: row.supplier, publicPrices: row.publicPrices };
            const price = calculatePrice(productForPrice, offerForPrice);
            const currencySymbol = selectedCurrency === 'EUR' ? '€' : '₴';
            const priceText = price > 0 ? `${price.toFixed(2)} ${currencySymbol}` : "—";
            const stock = row.stock || 0;
            const stockText = stock > 20 ? '20+' : stock;
            const availabilityText = row.supplier === 'Мій склад' ? 'Склад' : 'Партнер';
            const availabilityClass = row.supplier === 'Мій склад'
              ? 'text-green-600'
              : 'text-indigo-600';

            return (
              <div
                key={`${row.docId}-${row.supplier}-${idx}`}
                className="flex items-stretch gap-3 p-3 bg-white border border-gray-200 rounded-xl shadow-sm"
              >
                {/* Колонка A ~75% */}
                <div className="basis-[75%] flex flex-col gap-1 min-w-0">
                  <div className="flex items-start gap-1">
                    <span className="flex-1 text-base font-semibold text-gray-900 leading-snug break-words">
                      {row.name || 'Без назви'}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        openGoogleSearch(row.name, row.id);
                      }}
                      className="flex-shrink-0 p-1 text-gray-400 hover:text-indigo-600 transition-colors"
                      title="Пошук в Google"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openProductDetail(row);
                      }}
                      className={infoButtonClass}
                      title="Детальний опис"
                    >
                      <InfoIcon />
                    </button>
                  </div>
                  <div className="text-xs text-gray-500/80 leading-snug truncate">
                    {row.id || ''}
                  </div>
                </div>

                {/* Колонка B ~13% */}
                <div className="basis-[13%] min-w-[68px] flex flex-col justify-center items-end text-right">
                  <div className="text-base font-semibold text-gray-900">{priceText}</div>
                  <div className="text-xs text-gray-500/80">{`Наявність: ${stockText}`}</div>
                  <div className={`text-[11px] font-medium ${availabilityClass} flex items-center gap-1`}>
                    {availabilityText}
                    {row.supplier !== 'Мій склад' && (
                      <div className="relative group">
                        <svg 
                          xmlns="http://www.w3.org/2000/svg" 
                          className="h-3.5 w-3.5 text-amber-500 cursor-help" 
                          fill="none" 
                          viewBox="0 0 24 24" 
                          stroke="currentColor"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                        </svg>
                        {/* Tooltip */}
                        <div className="absolute right-0 bottom-full mb-2 w-64 p-3 bg-gray-900 text-white text-xs rounded-lg shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-50 pointer-events-none">
                          <div className="whitespace-pre-wrap">{getSupplierComment(row.supplier)}</div>
                          {/* Стрілка */}
                          <div className="absolute top-full right-4 border-4 border-transparent border-t-gray-900"></div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Колонка C ~12% */}
                <div className="basis-[12%] min-w-[52px] flex items-center justify-center">
                  <button
                    onClick={() => setSelectedProduct({
                      docId: row.docId,
                      brand: row.brand,
                      id: row.id,
                      name: row.name,
                      selectedOffer: {
                        supplier: row.supplier,
                        stock: row.stock,
                        publicPrices: row.publicPrices
                      },
                      selectedSupplier: row.supplier
                    })}
                    className="w-full h-full min-h-[42px] rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-600 flex items-center justify-center transition-colors"
                    title="Додати в кошик"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
                    </svg>
                  </button>
                </div>
              </div>
            );
          })}
          {displayRows.length === 0 && (
            <div className="px-3 py-4 text-center text-gray-500 text-sm border border-dashed border-gray-300 rounded-lg">
              Немає товарів для відображення, виберіть потрібну групу товарів
            </div>
          )}
        </div>

        {/* Десктопний вигляд: таблиця без змін */}
        <div className="hidden sm:block">
          <table className="min-w-full divide-y divide-gray-200 border border-gray-300 text-sm" style={{ tableLayout: 'fixed', width: '100%' }}>
            <thead className="bg-gray-50 sticky top-0 z-20">
              <tr>
                <th className="bg-gray-50 px-3 py-2 text-left text-sm font-medium text-gray-500 uppercase whitespace-nowrap border border-gray-300" style={{ width: '13%', minWidth: '130px' }}>Виробник</th>
                <th className="bg-gray-50 px-3 py-2 text-left text-sm font-medium text-gray-500 uppercase whitespace-nowrap border border-gray-300" style={{ width: '13%', minWidth: '120px' }}>Артикул</th>
                <th className="bg-gray-50 px-3 py-2 text-left text-sm font-medium text-gray-500 uppercase border border-gray-300" style={{ width: '33%', minWidth: '250px' }}>Опис</th>
                <th className="bg-gray-50 px-3 py-2 text-left text-sm font-medium text-gray-500 uppercase whitespace-nowrap border border-gray-300" style={{ width: '11%', minWidth: '100px' }}>Наявність</th>
                <th className="bg-gray-50 px-3 py-2 text-left text-sm font-medium text-gray-500 uppercase whitespace-nowrap border border-gray-300" style={{ width: '11%', minWidth: '90px' }}>Ціна</th>
                <th className="bg-gray-50 px-3 py-2 text-center text-sm font-medium text-gray-500 uppercase whitespace-nowrap border border-gray-300" style={{ width: '7%', minWidth: '60px' }}>К-сть</th>
                <th className="bg-gray-50 px-3 py-2 text-left text-sm font-medium text-gray-500 uppercase border border-gray-300" style={{ width: '9%', minWidth: '60px' }}></th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {groupedRows.map((group) => {
                const rowspan = group.offers.length;
                return group.offers.map((row, offerIndex) => (
                  <tr key={`${row.docId}-${row.supplier}-${offerIndex}`}>
                    {offerIndex === 0 && (
                      <>
                        <td rowSpan={rowspan} className="px-3 py-2 align-top whitespace-nowrap text-sm border border-gray-300">
                          {group.product.brand}
                        </td>
                        <td rowSpan={rowspan} className="px-3 py-2 align-top whitespace-nowrap text-sm border border-gray-300">
                          {group.product.id}
                        </td>
                        <td rowSpan={rowspan} className="px-3 py-2 align-top text-sm break-words border border-gray-300">
                          <div className="flex items-start gap-2">
                            <span className="flex-1">{group.product.name}</span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                openGoogleSearch(group.product.name, group.product.id);
                              }}
                              className="flex-shrink-0 p-1 text-gray-400 hover:text-indigo-600 transition-colors"
                              title="Пошук в Google"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                              </svg>
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                openProductDetail(group.product);
                              }}
                              className={infoButtonClass}
                              title="Детальний опис"
                            >
                              <InfoIcon />
                            </button>
                          </div>
                        </td>
                      </>
                    )}
                    <td className="px-3 py-2 align-top whitespace-nowrap text-sm border border-gray-300">
                      {row.supplier === 'Мій склад' ? (
                        <span className="text-green-600 font-semibold">Склад</span>
                      ) : (
                        <div className="flex items-center gap-1">
                          <span className="text-gray-600">Партнер</span>
                          <div className="relative group">
                            <svg 
                              xmlns="http://www.w3.org/2000/svg" 
                              className="h-4 w-4 text-amber-500 cursor-help" 
                              fill="none" 
                              viewBox="0 0 24 24" 
                              stroke="currentColor"
                            >
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                            </svg>
                            {/* Tooltip */}
                            <div className="absolute left-0 bottom-full mb-2 w-64 p-3 bg-gray-900 text-white text-xs rounded-lg shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-50 pointer-events-none">
                              <div className="whitespace-pre-wrap">{getSupplierComment(row.supplier)}</div>
                              {/* Стрілка */}
                              <div className="absolute top-full left-4 border-4 border-transparent border-t-gray-900"></div>
                            </div>
                          </div>
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top whitespace-nowrap font-semibold text-sm border border-gray-300">
                      {(() => {
                        const product = { brand: row.brand, id: row.id };
                        const offer = { supplier: row.supplier, publicPrices: row.publicPrices };
                        // Використовуємо calculatePrice, яка вже робить конвертацію валюти
                        const price = calculatePrice(product, offer);
                        
                        const currencySymbol = selectedCurrency === 'EUR' ? '€' : '₴';
                        return price > 0 ? `${price.toFixed(2)} ${currencySymbol}` : "—";
                      })()}
                    </td>
                    <td className="px-3 py-2 text-center whitespace-nowrap text-sm border border-gray-300">
                      {(() => {
                        const stock = Number(row.stock) || 0;
                        if (stock <= 0) {
                          return (
                            <span className="text-[11px] font-medium text-orange-500">немає</span>
                          );
                        }
                        return (
                          <span className="font-semibold">{stock > 20 ? '20+' : stock}</span>
                        );
                      })()}
                    </td>
                    <td className="px-3 py-2 align-top text-center text-sm border border-gray-300">
                      <button 
                        onClick={() => setSelectedProduct({ 
                          docId: row.docId,
                          brand: row.brand,
                          id: row.id,
                          name: row.name,
                          selectedOffer: { 
                            supplier: row.supplier, 
                            stock: row.stock, 
                            publicPrices: row.publicPrices
                          }, 
                          selectedSupplier: row.supplier 
                        })} 
                        className="p-1.5 text-green-600 hover:text-green-800" 
                        title="Додати в кошик"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" /></svg>
                      </button>
                    </td>
                  </tr>
                ));
              })}
              {displayRows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-4 text-center text-gray-500 text-sm border border-gray-300">
                    Немає товарів для відображення, виберіть потрібну групу товарів для відображення
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {/* Пагінація прибрана для вкладки "Каталог" - всі товари завантажуються одразу (до 500) */}
          {/* Пагінація залишена для "Всі товари" через runAllProductsSearchWithFilters */}

        </div>
      </div>
    </>
  );
};

export default ProductCatalog;
