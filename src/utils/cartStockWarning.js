/** Офер зі складу ROZA (перевірка залишку лише для нього). */
export const WAREHOUSE_SUPPLIER = 'Мій склад';

export function isWarehouseSupplier(supplier) {
  return String(supplier || '').trim() === WAREHOUSE_SUPPLIER;
}

/** Для прайсів/експорту: не розкривати ім’я партнера. */
export function offerSourceLabel(supplier) {
  return isWarehouseSupplier(supplier) ? 'Склад' : 'Партнер';
}

export function isWarehouseLine(item) {
  return isWarehouseSupplier(item?.supplier);
}

/**
 * Доступно клієнту: для «Мій склад» = stock − warehouseReserved (≥ 0).
 * @param {object|null} product — документ товару (для warehouseReserved)
 * @param {object|null} offer — офер (stock, supplier)
 */
export function availableStock(product, offer) {
  const stock = Number(offer?.stock);
  const base = Number.isFinite(stock) ? stock : 0;
  if (!isWarehouseSupplier(offer?.supplier)) return base;
  const reserved = Number(product?.warehouseReserved) || 0;
  return Math.max(0, base - reserved);
}

/** Фактичний залишок на рядку кошика (число; для перевірок не використовуємо «20+» з UI). */
export function getCartLineStock(item) {
  if (!item) return null;
  // У кошику stock уже має бути «вільно» (після availableStock при додаванні).
  const raw = item.stock ?? item.selectedOffer?.stock;
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Позиції, де замовлено більше, ніж available.
 * @param {Array} cartItems
 * @param {Record<string, number>|Map<string, number>} stockByDocId — свіжий stock з Firestore (опційно)
 */
export function buildStockWarningLines(cartItems, stockByDocId = null) {
  if (!Array.isArray(cartItems) || !cartItems.length) return [];

  const getFreshStock = (docId) => {
    if (!stockByDocId || !docId) return null;
    if (stockByDocId instanceof Map) {
      const v = stockByDocId.get(docId);
      return v === undefined ? null : Number(v);
    }
    const v = stockByDocId[docId];
    return v === undefined ? null : Number(v);
  };

  const lines = [];
  for (const item of cartItems) {
    if (!isWarehouseLine(item) || !item.docId) continue;

    const requested = Math.max(1, Number(item.quantity) || 1);
    const fromMap = getFreshStock(item.docId);
    const available =
      fromMap !== null && Number.isFinite(fromMap)
        ? fromMap
        : getCartLineStock(item);

    if (available === null || !Number.isFinite(available)) continue;
    if (requested <= available) continue;

    lines.push({
      docId: item.docId,
      name: item.name || 'Товар',
      brand: item.brand || '',
      id: item.id || '',
      requested,
      available,
    });
  }
  return lines;
}

/** Текст для window.confirm при оформленні / додаванні. */
export function formatStockWarningMessage(lines, { singleLine = false } = {}) {
  if (!lines?.length) return '';

  const header =
    'Замовлена кількість перевищує залишок на складі:\n\n';

  if (singleLine && lines.length === 1) {
    const l = lines[0];
    const label = [l.brand, l.id].filter(Boolean).join(' ') || l.name;
    return (
      `${header}${label}: замовляєте ${l.requested} шт., на складі ${l.available} шт.\n\n` +
      'Продовжити? Менеджер може підтвердити частково.'
    );
  }

  const maxShow = 3;
  const shown = lines.slice(0, maxShow);
  const body = shown
    .map((l) => {
      const label = [l.brand, l.id].filter(Boolean).join(' ') || l.name;
      return `• ${label}: ${l.requested} шт. (на складі ${l.available})`;
    })
    .join('\n');

  const rest = lines.length - shown.length;
  const tail = rest > 0 ? `\n…і ще ${rest} поз.` : '';

  return (
    `${header}${body}${tail}\n\n` +
    'Продовжити? Менеджер може підтвердити частково.'
  );
}

export function confirmStockOverOrder(lines, options) {
  if (!lines?.length) return true;
  const msg = formatStockWarningMessage(lines, options);
  return window.confirm(msg);
}

/** З документа products — доступний залишок офера «Мій склад» (мінус резерв). */
export function warehouseStockFromProductDoc(data) {
  if (!data?.offers || !Array.isArray(data.offers)) return 0;
  const offer = data.offers.find((o) => o.supplier === WAREHOUSE_SUPPLIER);
  if (!offer) return 0;
  return availableStock(data, offer);
}
