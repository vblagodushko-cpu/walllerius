import React, { useState, useMemo } from 'react';
import Tooltip from './Tooltip.jsx';

const AddToCartModal = ({ product, onAddToCart, onClose }) => {
  const [quantity, setQuantity] = useState(1);
  const handleAdd = () => { onAddToCart(parseInt(quantity, 10) || 1); onClose(); };
  const handleDecrease = () => setQuantity(prev => Math.max(1, (parseInt(prev, 10) || 1) - 1));
  const handleIncrease = () => setQuantity(prev => (parseInt(prev, 10) || 1) + 1);
  const handleInputFocus = (e) => e.target.select();
  const handleInputChange = (e) => {
    const value = e.target.value;
    if (value === '' || value === '-') {
      setQuantity('');
      return;
    }
    const num = parseInt(value, 10);
    if (!isNaN(num) && num >= 1) {
      setQuantity(num);
    }
  };
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex justify-center items-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-sm">
        <div className="p-6">
          <h3 className="text-lg font-semibold mb-2">Додати в кошик</h3>
          <p className="text-sm text-gray-700 mb-4">{product.name}</p>
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">Кількість</label>
            <div className="flex items-center gap-2">
              <button 
                onClick={handleDecrease} 
                className="px-3 py-2 rounded bg-gray-100 hover:bg-gray-200 text-lg font-semibold transition-colors"
                type="button"
              >−</button>
              <input 
                type="number" 
                min="1" 
                value={quantity} 
                onChange={handleInputChange}
                onFocus={handleInputFocus}
                className="flex-1 p-2 border rounded-md text-center" 
                autoFocus 
              />
              <button 
                onClick={handleIncrease} 
                className="px-3 py-2 rounded bg-gray-100 hover:bg-gray-200 text-lg font-semibold transition-colors"
                type="button"
              >+</button>
            </div>
          </div>
          <div className="flex justify-end gap-4">
            <button onClick={onClose} className="btn bg-gray-300 hover:bg-gray-400 text-black">Скасувати</button>
            <button onClick={handleAdd} className="btn btn-primary">Додати</button>
          </div>
        </div>
      </div>
    </div>
  );
};

const ProductCatalog = ({ products, client, onAddToCart, suppliers, hideZeroStock = false, hidePartnerOffers = false, selectedCategory = null, clientPricingRules = null, selectedCurrency = 'EUR', uahRate = null }) => {
  const [selectedProduct, setSelectedProduct] = useState(null);

  // Функція для знаходження правила
  const findRule = (rules, type, brand, id, supplier) => {
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
  };

  // Обчислення ціни з урахуванням правил
  const calculatePriceWithRules = (product, offer) => {
    if (!offer || !offer.publicPrices) return 0;
    
    // 1. Визначаємо градацію та adjustment (пріоритет)
    let priceGroup = client.priceType || "роздріб"; // за замовчуванням
    let adjustment = 0;
    
    if (clientPricingRules && clientPricingRules.rules) {
      // Перевірка персональних правил (пріоритет)
      const productRule = findRule(clientPricingRules, "product", product.brand, product.id, null);
      if (productRule) {
        priceGroup = productRule.priceGroup;
        // Міграція: якщо є старі поля, конвертуємо
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
    
    // 3. Застосовуємо персональний adjustment (може бути негативним для знижки або позитивним для націнки)
    let price = basePrice;
    price = price * (1 + adjustment/100);
    
    // 4. Застосовуємо загальний adjustment (останнім)
    if (clientPricingRules) {
      let globalAdjustment = 0;
      if (clientPricingRules.globalAdjustment !== undefined) {
        globalAdjustment = Number(clientPricingRules.globalAdjustment || 0);
      } else {
        // Міграція: конвертація зі старих полів
        const globalDiscount = Number(clientPricingRules.globalDiscount || 0);
        const globalMarkup = Number(clientPricingRules.globalMarkup || 0);
        globalAdjustment = globalMarkup - globalDiscount;
      }
      price = price * (1 + globalAdjustment/100);
    }
    
    // 5. Округлення в більшу сторону до сотих
    let finalPrice = Math.ceil(price * 100) / 100;
    
    // Конвертація валюти виконується в calculatePrice, щоб уникнути подвійної конвертації
    
    return finalPrice;
  };

  const getPrice = (publicPrices, supplier) => {
    if (!publicPrices || typeof publicPrices !== "object") return null;
    // Використовуємо publicPrices для всіх постачальників (включаючи "Мій склад")
    return publicPrices[client.priceType] ?? null;
  };

  const calculatePrice = (product, offer = null) => {
    let price = 0;
    
    // Якщо є правила - використовуємо нову логіку
    if (clientPricingRules && offer) {
      price = calculatePriceWithRules(product, offer);
    } else if (offer) {
      // Стара логіка (fallback)
      price = offer.publicPrices?.[client.priceType] ?? 0;
    } else {
    // Якщо пропозиція не передана - шукаємо пропозицію від "Мій склад"
    if (!product.offers || !Array.isArray(product.offers)) return 0;
    const myWarehouseOffer = product.offers.find(o => o.supplier === 'Мій склад');
    if (!myWarehouseOffer) return 0;
    
      if (clientPricingRules) {
        price = calculatePriceWithRules(product, myWarehouseOffer);
      } else {
        price = myWarehouseOffer.publicPrices?.[client.priceType] ?? 0;
      }
    }
    
    // Конвертація валюти (якщо вибрано UAH)
    if (selectedCurrency === 'UAH' && uahRate && uahRate > 0 && price > 0) {
      price = price * uahRate;
      price = Math.round(price * 100) / 100;
    }
    
    return price;
  };

  const getSupplierComment = (supplierName) => {
    const supplier = suppliers.find(s => s.name === supplierName);
    return supplier?.comment || 'Умови доставки не вказані.';
  };

  // Обробка offers[] та створення рядків для відображення (як в адмін-панелі)
  const displayRows = useMemo(() => {
    const rows = [];
    
    for (const product of products) {
      // Фільтр по категорії (якщо вибрано)
      if (selectedCategory) {
        const productCategories = Array.isArray(product.categories) ? product.categories : [];
        if (!productCategories.includes(selectedCategory)) {
          continue;
        }
      }

      if (!product.offers || !Array.isArray(product.offers)) {
        continue;
      }
      
      // Фільтрація offers
      let filteredOffers = product.offers;
      
      // Фільтр: приховати партнерів
      if (hidePartnerOffers) {
        filteredOffers = filteredOffers.filter(o => o.supplier === 'Мій склад');
      }
      
      // Фільтр: приховати нульові залишки
      if (hideZeroStock) {
        filteredOffers = filteredOffers.filter(o => (o.stock || 0) > 0);
      }
      
      if (filteredOffers.length === 0) continue;
      
      // Сортування offers: спочатку "Мій склад", потім інші по зростанню ціни
      filteredOffers.sort((a, b) => {
        if (a.supplier === "Мій склад" && b.supplier !== "Мій склад") return -1;
        if (a.supplier !== "Мій склад" && b.supplier === "Мій склад") return 1;
        
        const productForRules = { brand: product.brand, id: product.id };
        const priceA = clientPricingRules 
          ? calculatePriceWithRules(productForRules, a)
          : (getPrice(a.publicPrices, a.supplier) ?? Infinity);
        const priceB = clientPricingRules
          ? calculatePriceWithRules(productForRules, b)
          : (getPrice(b.publicPrices, b.supplier) ?? Infinity);
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
        });
      }
    }
    
    return rows;
  }, [products, hideZeroStock, hidePartnerOffers, selectedCategory, client.priceType, clientPricingRules]);

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

  return (
    <>
      {selectedProduct && <AddToCartModal product={selectedProduct} onAddToCart={(q)=>{ onAddToCart(selectedProduct, calculatePrice(selectedProduct, selectedProduct.selectedOffer), q); setSelectedProduct(null); }} onClose={()=>setSelectedProduct(null)} />}
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
                  <div className="text-base font-semibold text-gray-900 leading-snug break-words">
                    {row.name || 'Без назви'}
                  </div>
                  <div className="text-xs text-gray-500/80 leading-snug truncate">
                    {row.id || ''}
                  </div>
                </div>

                {/* Колонка B ~13% */}
                <div className="basis-[13%] min-w-[68px] flex flex-col justify-center items-end text-right">
                  <div className="text-base font-semibold text-gray-900">{priceText}</div>
                  <div className="text-xs text-gray-500/80">{`Наявність: ${stockText}`}</div>
                  <div className={`text-[11px] font-medium ${availabilityClass}`}>{availabilityText}</div>
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
                          {group.product.name}
                        </td>
                      </>
                    )}
                    <td className="px-3 py-2 align-top whitespace-nowrap text-sm border border-gray-300">
                      {row.supplier === 'Мій склад' ? (
                        <span className="text-green-600 font-semibold">Склад</span>
                      ) : (
                        <span className="text-gray-600">Партнер</span>
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
                    <td className="px-3 py-2 text-center whitespace-nowrap font-semibold text-sm border border-gray-300">
                      {(() => {
                        const stock = row.stock || 0;
                        return stock > 20 ? '20+' : stock;
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
