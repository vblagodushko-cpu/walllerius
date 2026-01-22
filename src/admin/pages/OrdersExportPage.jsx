// src/admin/pages/OrdersExportPage.jsx
import React, { useState, useEffect } from "react";
import { collection, getDocs, query, where, orderBy, doc, getDoc } from "firebase/firestore";
import { db } from "../../firebase-config";

const appId = import.meta.env.VITE_PROJECT_ID || "embryo-project";

const primary = "px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white shadow font-medium";
const secondary = "px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200";

/**
 * Мапінг priceType з ROZA на N_PRICEID для UkrSklad
 */
function mapPriceTypeToPriceId(priceType) {
  const mapping = {
    "роздріб": "1",
    "ціна опт": "2",
    "ціна 1": "3",
    "ціна 2": "4",
    "ціна 3": "5",
  };
  return mapping[priceType] || "3"; // fallback до "ціна 1"
}

/**
 * Екранування XML
 */
function escapeXml(text) {
  if (text == null) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Генерація XML для одного замовлення
 */
function generateOrderXml(order, client, productsMap) {
  const orderId = order.id || order.clientRequestId || `order_${Date.now()}`;
  const clientId = order.clientId || "";
  // priceType з клієнта або з pricingSnapshot замовлення (fallback)
  const priceType = client?.priceType || order.pricingSnapshot?.priceType || "ціна 1";
  const priceId = mapPriceTypeToPriceId(priceType);
  
  // Timestamp в мілісекундах (як в прикладі)
  const now = Date.now();
  const total = order.total || 0;
  
  let xml = `  <T_ORDER_TITLE>
    <N_BG_COLOR>0</N_BG_COLOR>
    <N_CARRY>false</N_CARRY>
    <N_CASH_ID/>
    <N_CASH_SUM>0.0</N_CASH_SUM>
    <N_CHECK_NUMBER/>
    <N_CLIENTID>${escapeXml(clientId)}</N_CLIENTID>
    <N_COMMENT>${escapeXml(order.note || "")}</N_COMMENT>
    <N_CONTRACTID>${escapeXml(clientId)}</N_CONTRACTID>
    <N_CREATE_DATE>${now}</N_CREATE_DATE>
    <N_DATE>${now}</N_DATE>
    <N_DELAY>false</N_DELAY>
    <N_DISCOUNT_PERCENT>0.0</N_DISCOUNT_PERCENT>
    <N_DISCOUNT_SUM>0.0</N_DISCOUNT_SUM>
    <N_FORMID>1</N_FORMID>
    <N_GEOADDRESS/>
    <N_HAVE_DISCOUNT>false</N_HAVE_DISCOUNT>
    <N_ID>${escapeXml(orderId)}</N_ID>
    <N_LAT>0.0</N_LAT>
    <N_LNG>0.0</N_LNG>
    <N_MESSAGE_NUMBER>1</N_MESSAGE_NUMBER>
    <N_PARENTID>${escapeXml(clientId)}</N_PARENTID>
    <N_PERIOD>0</N_PERIOD>
    <N_PRICEID>${escapeXml(priceId)}</N_PRICEID>
    <N_REMOVE_MARKER>false</N_REMOVE_MARKER>
    <N_SAVE_DATE>${now}</N_SAVE_DATE>
    <N_SHIPMENT_DATE>0</N_SHIPMENT_DATE>
    <N_SHIPPED>false</N_SHIPPED>
    <N_SUM>${total.toFixed(2)}</N_SUM>
    <N_WAREHOUSE_ID>ALL</N_WAREHOUSE_ID>
  </T_ORDER_TITLE>`;

  // Додаємо позиції замовлення
  if (order.items && Array.isArray(order.items)) {
    order.items.forEach((item, index) => {
      const product = productsMap.get(item.docId);
      if (!product) {
        console.warn(`Product not found for docId: ${item.docId}`);
        return;
      }
      
      const ukrSkladId = product.ukrSkladId || "";
      if (!ukrSkladId) {
        console.warn(`ukrSkladId not found for product: ${item.docId}`);
        return;
      }
      
      const quantity = item.quantity || item.qty || 1;
      const price = item.price || 0;
      const lineTotal = (price * quantity).toFixed(2);
      const lineNumber = index + 1;
      const lineId = `${orderId}${lineNumber}`;
      
      xml += `
  <T_ORDER_TABLE>
    <N_COMMENT/>
    <N_DATE>${now}</N_DATE>
    <N_DISCOUNT_PERCENT>0.0</N_DISCOUNT_PERCENT>
    <N_FACTOR>1.0</N_FACTOR>
    <N_ID>${escapeXml(lineId)}</N_ID>
    <N_LINE_NUMBER>${lineNumber}</N_LINE_NUMBER>
    <N_MANUAL_PRICE>true</N_MANUAL_PRICE>
    <N_NOMENID>${escapeXml(ukrSkladId)}</N_NOMENID>
    <N_NUMBER>${quantity.toFixed(1)}</N_NUMBER>
    <N_PRICE>${price.toFixed(3)}</N_PRICE>
    <N_PRICE_ID/>
    <N_PRICE_NAME/>
    <N_PROFIT>-1000.0</N_PROFIT>
    <N_SUM>${lineTotal}</N_SUM>
    <N_TITLEID>${escapeXml(orderId)}</N_TITLEID>
    <N_UNIT_ID>ALL</N_UNIT_ID>
  </T_ORDER_TABLE>`;
    });
  }
  
  return xml;
}

/**
 * Генерація повного XML файлу .mbsu
 * Повертає { xml, processedCount, skippedOrders }
 */
function generateMbsuXml(orders, clientsMap, productsMap) {
  const skippedOrders = [];
  const processedOrders = [];
  
  // Спочатку підраховуємо, скільки замовлень буде оброблено
  orders.forEach((order) => {
    const client = clientsMap.get(order.clientId);
    if (!client) {
      skippedOrders.push({ orderId: order.id, clientId: order.clientId, reason: "client_not_found" });
      return;
    }

    const hasValidItems = (order.items || []).some(item => {
      const product = productsMap.get(item.docId);
      return product && product.ukrSkladId;
    });

    if (!hasValidItems) {
      skippedOrders.push({ orderId: order.id, clientId: order.clientId, reason: "no_valid_items" });
      return;
    }
    
    processedOrders.push(order);
  });

  // Генеруємо XML тільки для оброблених замовлень
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<mobile_sales version_code="189" message_number="1" version_name="4.0.5" root="false" fake_location="false" count="${processedOrders.length}" last_import="0" serial="" use_auto_time="true" emulator="false">
`;

  processedOrders.forEach((order) => {
    const client = clientsMap.get(order.clientId);
    xml += generateOrderXml(order, client, productsMap);
    xml += "\n";
  });

  xml += `</mobile_sales>`;
  return { xml, processedCount: processedOrders.length, skippedOrders };
}

export default function OrdersExportPage({ setStatus }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [ordersCount, setOrdersCount] = useState(0);

  // Завантаження кількості замовлень
  useEffect(() => {
    const loadCount = async () => {
      try {
        const ordersCol = collection(db, `/artifacts/${appId}/public/data/orders`);
        const q = query(
          ordersCol,
          where("status", "==", "Нове"),
          where("archived", "==", false)
        );
        const snap = await getDocs(q);
        setOrdersCount(snap.size);
      } catch (e) {
        console.error("Error loading orders count:", e);
      }
    };
    loadCount();
  }, []);

  const generateMbsuFile = async () => {
    if (!window.JSZip) {
      setStatus?.({ type: "error", message: "JSZip бібліотека не завантажена. Перезавантажте сторінку." });
      return;
    }

    setGenerating(true);
    setStatus?.(null);

    try {
      // 1) Завантаження замовлень зі статусом "Нове"
      const ordersCol = collection(db, `/artifacts/${appId}/public/data/orders`);
      const ordersQuery = query(
        ordersCol,
        where("status", "==", "Нове"),
        where("archived", "==", false),
        orderBy("createdAt", "asc")
      );
      const ordersSnap = await getDocs(ordersQuery);
      const ordersList = ordersSnap.docs.map(d => ({ id: d.id, ...d.data() }));

      if (ordersList.length === 0) {
        setStatus?.({ type: "info", message: "Немає замовлень зі статусом 'Нове' для експорту." });
        setGenerating(false);
        return;
      }

      setStatus?.({ type: "info", message: `Знайдено ${ordersList.length} замовлень. Завантаження даних...` });

      // 2) Завантаження клієнтів
      const clientsMap = new Map();
      const uniqueClientIds = [...new Set(ordersList.map(o => o.clientId).filter(Boolean))];
      
      for (const clientId of uniqueClientIds) {
        try {
          const clientDoc = await getDoc(doc(db, `/artifacts/${appId}/public/data/clients/${clientId}`));
          if (clientDoc.exists()) {
            clientsMap.set(clientId, { id: clientId, ...clientDoc.data() });
          }
        } catch (e) {
          console.warn(`Failed to load client ${clientId}:`, e);
        }
      }

      // 3) Завантаження продуктів
      const productsMap = new Map();
      const uniqueDocIds = [...new Set(ordersList.flatMap(o => (o.items || []).map(i => i.docId).filter(Boolean)))];

      setStatus?.({ type: "info", message: `Завантаження ${uniqueDocIds.length} продуктів...` });

      // Завантажуємо продукти батчами по 30 (обмеження Firestore)
      const BATCH_SIZE = 30;
      for (let i = 0; i < uniqueDocIds.length; i += BATCH_SIZE) {
        const batch = uniqueDocIds.slice(i, i + BATCH_SIZE);
        const productRefs = batch.map(docId => doc(db, `/artifacts/${appId}/public/data/products/${docId}`));
        
        // Використовуємо Promise.all для паралельного завантаження
        const productSnaps = await Promise.all(productRefs.map(ref => getDoc(ref).catch(e => {
          console.warn(`Failed to load product ${ref.id}:`, e);
          return null;
        })));

        productSnaps.forEach((snap, idx) => {
          if (snap && snap.exists()) {
            productsMap.set(batch[idx], { docId: batch[idx], ...snap.data() });
          }
        });
      }

      // 4) Перевірка наявності ukrSkladId
      const missingProducts = [];
      ordersList.forEach(order => {
        (order.items || []).forEach(item => {
          const product = productsMap.get(item.docId);
          if (!product) {
            missingProducts.push({ orderId: order.id, docId: item.docId, name: item.name });
          } else if (!product.ukrSkladId) {
            missingProducts.push({ orderId: order.id, docId: item.docId, name: product.name || item.name, reason: "no_ukrSkladId" });
          }
        });
      });

      if (missingProducts.length > 0) {
        console.warn("Missing products or ukrSkladId:", missingProducts);
        setStatus?.({ 
          type: "warning", 
          message: `Увага: ${missingProducts.length} товарів не мають ukrSkladId або не знайдені. Файл буде створено без них.` 
        });
      }

      // 5) Генерація XML
      setStatus?.({ type: "info", message: "Генерація XML..." });
      const { xml: xmlContent, processedCount, skippedOrders } = generateMbsuXml(ordersList, clientsMap, productsMap);

      // 6) Упаковка в ZIP
      setStatus?.({ type: "info", message: "Упаковка в ZIP..." });
      const zip = new window.JSZip();
      zip.file("orders.xml", xmlContent, { compression: "DEFLATE" });
      const zipBlob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });

      // 7) Завантаження як .mbsu
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
      const filename = `orders_export_${timestamp}.mbsu`;
      
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      const successMessage = `Файл ${filename} успішно створено та завантажено. Оброблено ${processedCount} з ${ordersList.length} замовлень.${skippedOrders.length > 0 ? ` Пропущено замовлень: ${skippedOrders.length}.` : ""}${missingProducts.length > 0 ? ` Пропущено товарів: ${missingProducts.length}.` : ""}`;
      
      setStatus?.({ 
        type: skippedOrders.length > 0 || missingProducts.length > 0 ? "warning" : "success", 
        message: successMessage
      });
      setOrders(ordersList);

    } catch (e) {
      console.error("Error generating .mbsu file:", e);
      setStatus?.({ type: "error", message: `Помилка: ${e.message || "Невідома помилка"}` });
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Вигрузка замовлень</h2>
      </div>

      <div className="mb-6 space-y-4">
        <div className="bg-slate-50 rounded-lg p-4">
          <p className="text-sm text-slate-700 mb-2">
            <strong>Функціонал:</strong> Експорт замовлень зі статусом "Нове" у форматі .mbsu для імпорту в UkrSklad.
          </p>
          <p className="text-sm text-slate-600">
            Файл генерується у форматі XML, упаковується в ZIP та перейменовується в .mbsu.
          </p>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex-1">
            <p className="text-sm text-slate-600 mb-1">
              Знайдено замовлень зі статусом "Нове":
            </p>
            <p className="text-2xl font-bold text-indigo-600">{ordersCount}</p>
          </div>
        </div>

        <button
          onClick={generateMbsuFile}
          disabled={generating || ordersCount === 0}
          className={`${primary} disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          {generating ? "Генерація..." : "Сформувати файл .mbsu"}
        </button>

        {orders.length > 0 && (
          <div className="mt-4 text-sm text-slate-600">
            <p>Останній експорт: {orders.length} замовлень</p>
          </div>
        )}
      </div>
    </div>
  );
}

