import React, { useState } from 'react';
import {
  WAREHOUSE_SUPPLIER,
  isWarehouseLine,
  getCartLineStock,
  buildStockWarningLines,
  confirmStockOverOrder,
} from '../utils/cartStockWarning.js';

export default function AddToCartModal({ product, onAddToCart, onClose }) {
  const [quantity, setQuantity] = useState(1);
  const supplier = product.selectedSupplier || product.supplier || WAREHOUSE_SUPPLIER;
  const warehouseLine = isWarehouseLine({ supplier });
  const availableStock = warehouseLine ? getCartLineStock(product) : null;
  const qtyNum = parseInt(quantity, 10) || 1;
  const overStock =
    warehouseLine &&
    availableStock !== null &&
    qtyNum > availableStock;

  const handleAdd = () => {
    const q = parseInt(quantity, 10) || 1;
    if (warehouseLine && availableStock !== null && q > availableStock) {
      const lines = buildStockWarningLines(
        [{ ...product, supplier, stock: availableStock, quantity: q }],
        null
      );
      if (!confirmStockOverOrder(lines, { singleLine: true })) return;
    }
    onAddToCart(q);
    onClose();
  };
  const handleDecrease = () => setQuantity((prev) => Math.max(1, (parseInt(prev, 10) || 1) - 1));
  const handleIncrease = () => setQuantity((prev) => (parseInt(prev, 10) || 1) + 1);
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
              >
                −
              </button>
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
              >
                +
              </button>
            </div>
            {warehouseLine && availableStock !== null ? (
              <p className="mt-2 text-xs text-gray-500">На складі: {availableStock}</p>
            ) : null}
            {overStock ? (
              <p className="mt-1 text-xs font-medium text-orange-500">
                Замовлено більше, ніж на складі
              </p>
            ) : null}
          </div>
          <div className="flex justify-end gap-4">
            <button onClick={onClose} className="btn bg-gray-300 hover:bg-gray-400 text-black">
              Скасувати
            </button>
            <button onClick={handleAdd} className="btn btn-primary">
              Додати
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
