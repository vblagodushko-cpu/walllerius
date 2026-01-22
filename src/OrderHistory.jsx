import React, { useState, useMemo } from 'react';

const OrderHistory = ({ orders, onFetchMore, hasMore, isFetchingMore, selectedCurrency = 'EUR', uahRate = null }) => {
  const [expandedOrderId, setExpandedOrderId] = useState(null);
  const toggleOrder = (orderId) => setExpandedOrderId(expandedOrderId === orderId ? null : orderId);
  const statusColor = (s) => s === 'Нове' ? 'bg-blue-100 text-blue-800' : s === 'Частково виконано' ? 'bg-yellow-100 text-yellow-800' : s === 'Завершено' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800';
  
  const currencySymbol = selectedCurrency === 'EUR' ? '€' : '₴';
  
  // Функція конвертації ціни
  const convertPrice = (price) => {
    if (selectedCurrency === 'UAH' && uahRate && uahRate > 0) {
      return Number(price || 0) * uahRate;
    }
    return Number(price || 0);
  };
  
  // Функція для обчислення суми замовлення
  const calculateOrderTotal = (order) => {
    if (order.total !== undefined) {
      return convertPrice(order.total);
    }
    // Якщо total немає, обчислюємо з items
    return order.items?.reduce((sum, item) => {
      const itemPrice = convertPrice(item.price || 0);
      const itemQty = Number(item.quantityConfirmed || item.quantity || 0);
      return sum + itemPrice * itemQty;
    }, 0) || 0;
  };

  return (
    <div className="bg-white p-6 rounded-lg shadow-md">
      <h2 className="text-2xl font-bold mb-4">Історія замовлень</h2>
      {orders.length === 0 ? (
        <p className="text-gray-500">У вас ще немає жодного замовлення.</p>
      ) : (
        <div className="space-y-4">
          {orders.map(order => {
            const orderTotal = calculateOrderTotal(order);
            return (
              <div key={order.id} className="border border-gray-200 rounded-lg overflow-hidden shadow-sm hover:shadow-md transition-shadow">
                <div className="p-4 bg-gradient-to-r from-gray-50 to-white flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 cursor-pointer" onClick={() => toggleOrder(order.id)}>
                  <div className="flex-1">
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="font-bold text-lg text-gray-800">Замовлення №{order.orderNumber}</span>
                      {order.createdAt?.seconds && (
                        <span className="text-sm text-gray-500">
                          {new Date(order.createdAt.seconds * 1000).toLocaleDateString('uk-UA', {
                            year: 'numeric',
                            month: 'long',
                            day: 'numeric'
                          })}
                        </span>
                      )}
                    </div>
                </div>
                  <div className="flex items-center gap-4 flex-wrap">
                    <span className={`px-3 py-1 text-xs font-semibold rounded-full ${statusColor(order.status)}`}>
                      {order.status}
                    </span>
                    {order.hasCancellations && (
                      <span 
                        title="У замовленні є скасовані позиції" 
                        className="flex items-center justify-center bg-red-500 text-white rounded-full h-6 w-6 text-xs font-bold"
                      >
                        !
                      </span>
                    )}
                    <span className="font-bold text-xl text-indigo-600">
                      {orderTotal.toFixed(2)} {currencySymbol}
                    </span>
                    <svg 
                      xmlns="http://www.w3.org/2000/svg" 
                      className={`h-5 w-5 text-gray-500 transform transition-transform ${expandedOrderId === order.id ? 'rotate-180' : ''}`} 
                      viewBox="0 0 20 20" 
                      fill="currentColor"
                    >
                      <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                    </svg>
                </div>
              </div>
              {expandedOrderId === order.id && (
                  <div className="p-4 border-t border-gray-200 bg-gray-50">
                    <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                        <thead className="text-left text-xs text-gray-600 uppercase bg-gray-100">
                      <tr>
                            <th className="py-3 px-4 font-semibold">Товар</th>
                            <th className="py-3 px-4 text-center font-semibold">Замовлено</th>
                            <th className="py-3 px-4 text-center font-semibold">Підтверджено</th>
                            <th className="py-3 px-4 text-center font-semibold">Скасовано</th>
                            <th className="py-3 px-4 text-center font-semibold">Ціна</th>
                            <th className="py-3 px-4 text-center font-semibold">Сума</th>
                            <th className="py-3 px-4 font-semibold">Статус</th>
                      </tr>
                    </thead>
                        <tbody className="divide-y divide-gray-200">
                          {order.items.map((item, i) => {
                            const itemPrice = convertPrice(item.price || 0);
                            const itemQty = Number(item.quantityConfirmed || item.quantity || 0);
                            const itemTotal = itemPrice * itemQty;
                            
                            return (
                              <tr key={i} className="hover:bg-gray-50">
                                <td className="py-3 px-4">
                                  <p className="font-medium text-gray-900">{item.name}</p>
                                  <p className="text-xs text-gray-500 mt-1">{item.brand} / {item.id}</p>
                                </td>
                                <td className="py-3 px-4 text-center text-gray-700">{item.quantity}</td>
                                <td className="py-3 px-4 text-center font-semibold text-green-600">{item.quantityConfirmed}</td>
                                <td className="py-3 px-4 text-center">
                                  {(item.quantityCancelled || 0) > 0 ? (
                                    <span className="font-bold text-red-600">{item.quantityCancelled}</span>
                                  ) : (
                                    <span className="text-gray-400">—</span>
                                  )}
                                </td>
                                <td className="py-3 px-4 text-center text-gray-700">
                                  {itemPrice > 0 ? `${itemPrice.toFixed(2)} ${currencySymbol}` : '—'}
                                </td>
                                <td className="py-3 px-4 text-center font-semibold text-indigo-600">
                                  {itemTotal > 0 ? `${itemTotal.toFixed(2)} ${currencySymbol}` : '—'}
                                </td>
                                <td className="py-3 px-4">
                                  <span className={`px-2 py-1 text-xs rounded-full ${
                                    item.lineStatus === 'Виконано' ? 'bg-green-100 text-green-800' :
                                    item.lineStatus === 'Замовлено у постачальника' ? 'bg-blue-100 text-blue-800' :
                                    item.lineStatus === 'Очікує підтвердження' ? 'bg-yellow-100 text-yellow-800' :
                                    'bg-gray-100 text-gray-800'
                                  }`}>
                                    {item.lineStatus}
                                  </span>
                          </td>
                        </tr>
                            );
                          })}
                    </tbody>
                  </table>
                    </div>
                </div>
              )}
            </div>
            );
          })}
        </div>
      )}
      {hasMore && (
        <div className="text-center mt-6">
          <button
            onClick={onFetchMore}
            disabled={isFetchingMore}
            className="px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isFetchingMore ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Завантаження...
              </span>
            ) : (
              'Завантажити ще'
            )}
          </button>
        </div>
      )}
    </div>
  );
};

export default OrderHistory;
