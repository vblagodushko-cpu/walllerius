import React, { useMemo, useState, useCallback } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../firebase-config';
import { offerSourceLabel, WAREHOUSE_SUPPLIER } from '../utils/cartStockWarning.js';
import { calculateProductPrice } from '../utils/productPricing.js';
import AddToCartModal from './AddToCartModal.jsx';
import ProductDetailModal from './ProductDetailModal.jsx';

const MAX_DETAIL_BODY_CHARS = 80000;

const infoButtonClass =
  'flex-shrink-0 p-1 rounded text-gray-500 hover:text-indigo-600 hover:bg-indigo-50 transition-colors';

function InfoIcon() {
  return (
    <span className="text-xs font-semibold leading-none px-1" aria-hidden>
      i
    </span>
  );
}

function ProductImage({ imageThumbUrl, imageUrl, alt, articleId }) {
  const src = imageThumbUrl || imageUrl;
  if (src) {
    return (
      <img
        src={src}
        alt={alt || ''}
        loading="lazy"
        decoding="async"
        className="w-full h-full object-contain"
      />
    );
  }
  return (
    <div className="w-full h-full flex flex-col items-center justify-center text-gray-400 text-[10px] px-2 text-center">
      <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 mb-0.5 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
      {articleId ? <span className="truncate max-w-full">{articleId}</span> : null}
    </div>
  );
}

export default function FeaturedProductCards({
  appId,
  items = [],
  client,
  clientPricingRules,
  selectedCurrency = 'EUR',
  uahRate = null,
  showOnlyInStock = false,
  showOnlyPartners = false,
  onAddToCart,
}) {
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [detailModal, setDetailModal] = useState(null);
  const [detailBody, setDetailBody] = useState('');
  const [detailImageUrl, setDetailImageUrl] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  const openProductDetail = useCallback(
    async (product) => {
      if (!appId || !product?.docId) return;
      setDetailModal({
        docId: product.docId,
        brand: product.brand,
        id: product.id,
        name: product.name,
      });
      setDetailBody('');
      setDetailImageUrl('');
      setDetailError('');
      setDetailLoading(true);
      try {
        const ref = doc(
          db,
          `/artifacts/${appId}/public/data/products/${product.docId}/details/main`
        );
        const snap = await getDoc(ref);
        const d = snap.exists() ? snap.data() || {} : {};
        const raw = String(d.body ?? '');
        setDetailBody(raw.length > MAX_DETAIL_BODY_CHARS ? raw.slice(0, MAX_DETAIL_BODY_CHARS) : raw);
        setDetailImageUrl(String(d.imageUrl || d.imageThumbUrl || product.imageUrl || product.imageThumbUrl || ''));
      } catch (e) {
        console.error('Featured product detail load', e);
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

  const cards = useMemo(() => {
    const result = [];
    for (const product of items) {
      const warehouseOffer = (product.offers || []).find(
        (o) => o.supplier === WAREHOUSE_SUPPLIER
      );
      if (!warehouseOffer || Number(warehouseOffer.stock) <= 0) continue;

      const offer = product.bestOffer || warehouseOffer;
      const price = calculateProductPrice({
        product,
        offer,
        client,
        clientPricingRules,
        selectedCurrency,
        uahRate,
      });
      result.push({ product, offer, price });
    }
    return result;
  }, [items, client, clientPricingRules, selectedCurrency, uahRate]);

  if (cards.length === 0) return null;

  const currencySymbol = selectedCurrency === 'UAH' ? '₴' : '€';

  const openAddModal = (product, offer, price) => {
    setSelectedProduct({
      docId: product.docId,
      brand: product.brand,
      id: product.id,
      name: product.name,
      supplier: offer.supplier,
      selectedSupplier: offer.supplier,
      stock: offer.stock ?? 0,
      selectedOffer: offer,
      price,
    });
  };

  const cardShellClass =
    'flex flex-col bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden snap-start shrink-0 w-[78vw] max-w-[300px] sm:w-full sm:max-w-none sm:shrink cursor-pointer hover:border-indigo-200 hover:shadow-md transition-shadow';

  const renderCard = ({ product, offer, price }) => {
    const priceText = price > 0 ? `${price.toFixed(2)} ${currencySymbol}` : '—';
    const stock = Number(offer.stock) || 0;
    const stockText = stock > 20 ? '20+' : stock;
    const sourceLabel = offerSourceLabel(offer.supplier);
    const sourceClass =
      offer.supplier === 'Мій склад' ? 'text-green-600 bg-green-50' : 'text-indigo-600 bg-indigo-50';

    const onCardActivate = () => openProductDetail(product);

    return (
      <article
        key={product.docId}
        className={cardShellClass}
        role="button"
        tabIndex={0}
        onClick={onCardActivate}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onCardActivate();
          }
        }}
        title="Детальний опис"
      >
        <div className="h-[92px] sm:h-[100px] bg-gray-50 border-b border-gray-100 flex items-center justify-center pointer-events-none">
          <ProductImage
            imageThumbUrl={product.imageThumbUrl}
            imageUrl={product.imageUrl}
            alt={product.name}
            articleId={product.id}
          />
        </div>
        <div className="flex flex-col flex-1 p-2 gap-1">
          <div className="flex items-start justify-between gap-1">
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full shrink-0 ${sourceClass}`}>
              {sourceLabel}
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                openProductDetail(product);
              }}
              className={infoButtonClass}
              title="Детальний опис"
            >
              <InfoIcon />
            </button>
          </div>
          <h3 className="text-[13px] font-semibold text-gray-900 leading-snug break-words">
            {product.name || 'Без назви'}
          </h3>
          <p className="text-[11px] text-gray-500 truncate">{product.id}</p>
          <div className="mt-auto flex items-center justify-between gap-1.5 pt-0.5">
            <div className="min-w-0">
              <div className="text-sm font-bold text-gray-900">{priceText}</div>
              {stock > 0 ? (
                <div className="text-[11px] text-gray-500">В наявності: {stockText}</div>
              ) : (
                <div className="text-[11px] font-medium text-orange-500">немає</div>
              )}
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                openAddModal(product, offer, price);
              }}
              className="flex-shrink-0 p-1.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-600 transition-colors"
              title="Додати в кошик"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
            </button>
          </div>
        </div>
      </article>
    );
  };

  return (
    <section className="mb-5" aria-label="Нові пропозиції">
      <h2 className="text-base font-semibold text-gray-800 mb-2">Нові пропозиції</h2>

      <div className="flex gap-2.5 overflow-x-auto pb-2 -mx-1 px-1 snap-x snap-mandatory sm:hidden">
        {cards.map(renderCard)}
      </div>

      <div className="hidden sm:grid sm:grid-cols-2 lg:grid-cols-4 gap-3 w-full">
        {cards.map(renderCard)}
      </div>

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

      {selectedProduct && (
        <AddToCartModal
          product={selectedProduct}
          onAddToCart={(q) => {
            onAddToCart(selectedProduct, selectedProduct.price, q);
            setSelectedProduct(null);
          }}
          onClose={() => setSelectedProduct(null)}
        />
      )}
    </section>
  );
}
