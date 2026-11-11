import React, { useMemo, useState } from 'react';
import { getCartLineStock, isWarehouseLine } from '../utils/cartStockWarning.js';

function displayPrice(basePriceEUR, currency, uahRate) {
  const price = Number(basePriceEUR || 0);
  if (currency === 'UAH' && uahRate > 0) return Math.round(price * uahRate * 100) / 100;
  return price;
}

export default function CartSheet({
  open,
  onClose,
  items,
  currency,
  uahRate,
  onChangeQty,
  onRemove,
  onPlaceOrder,
  placing,
}) {
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const symbol = currency === 'EUR' ? '€' : '₴';
  const total = useMemo(
    () => items.reduce((sum, item) => sum + displayPrice(item.price, currency, uahRate) * Number(item.quantity || 0), 0),
    [items, currency, uahRate]
  );

  const submit = async () => {
    setError('');
    const result = await onPlaceOrder(note);
    if (result?.ok) setNote('');
    else if (result?.error) setError(result.error);
  };

  return (
    <div className={`fixed inset-0 z-50 ${open ? '' : 'pointer-events-none'}`} aria-hidden={!open}>
      <button type="button" className={`absolute inset-0 bg-stone-900/40 transition-opacity ${open ? 'opacity-100' : 'opacity-0'}`} onClick={onClose} aria-label="Закрити кошик" />
      <aside className={`absolute right-0 top-0 flex h-full w-full max-w-md flex-col bg-white shadow-2xl transition-transform ${open ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="flex items-center justify-between border-b border-stone-200 px-4 py-3">
          <h2 className="text-lg font-semibold">Кошик</h2>
          <button type="button" className="rounded-lg bg-stone-100 px-3 py-1 text-sm hover:bg-stone-200" onClick={onClose}>Закрити</button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {items.length === 0 ? <p className="text-sm text-stone-500">Кошик порожній.</p> : items.map((item) => {
            const price = displayPrice(item.price, currency, uahRate);
            const qty = Math.max(1, Number(item.quantity) || 1);
            const stock = isWarehouseLine(item) ? getCartLineStock(item) : null;
            const over = stock !== null && qty > stock;
            const line = price * qty;
            return (
              <div key={`${item.docId}:${item.supplier}`} className="rounded-2xl border border-stone-200 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium text-stone-900">{item.brand} — {item.name}</div>
                    <div className="mt-0.5 text-xs text-stone-500">{item.id} · {item.supplier === 'Мій склад' ? 'Склад' : 'Партнер'}</div>
                    <div className="mt-1 text-sm">{price.toFixed(2)} {symbol} · рядок <b>{line.toFixed(2)} {symbol}</b></div>
                    {stock !== null ? <div className="text-xs text-stone-500">На складі: {stock}</div> : null}
                  </div>
                  <button type="button" className="shrink-0 text-sm text-red-600" onClick={() => onRemove(item.docId, item.supplier)}>Прибрати</button>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <button type="button" className="h-8 w-8 rounded-lg bg-stone-100" onClick={() => onChangeQty(item.docId, item.supplier, qty - 1)} aria-label="Менше">−</button>
                  <input
                    type="number"
                    min={1}
                    value={qty}
                    onChange={(e) => onChangeQty(item.docId, item.supplier, e.target.value)}
                    className="w-16 rounded-lg border border-stone-200 py-1 text-center"
                  />
                  <button type="button" className="h-8 w-8 rounded-lg bg-stone-100" onClick={() => onChangeQty(item.docId, item.supplier, qty + 1)} aria-label="Більше">+</button>
                </div>
                {over ? <p className="mt-2 text-xs font-medium text-orange-600">Замовлено більше, ніж на складі</p> : null}
              </div>
            );
          })}
        </div>
        <div className="border-t border-stone-200 px-4 py-3">
          <label className="block text-sm text-stone-600">
            Примітка для менеджера
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, 2000))}
              rows={2}
              placeholder="Доставка, контакт, побажання"
              className="mt-1 w-full rounded-xl border border-stone-200 px-3 py-2 text-sm outline-none focus:border-indigo-400"
            />
          </label>
          {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
          <div className="mt-3 flex items-center justify-between text-lg">
            <span>Разом</span>
            <b>{total.toFixed(2)} {symbol}</b>
          </div>
          <button
            type="button"
            className="mt-3 w-full rounded-xl bg-indigo-700 px-4 py-2.5 font-medium text-white hover:bg-indigo-800 disabled:opacity-50"
            disabled={!items.length || placing}
            onClick={submit}
          >
            {placing ? 'Відправлення…' : 'Оформити замовлення'}
          </button>
        </div>
      </aside>
    </div>
  );
}
