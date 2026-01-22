import React, { useEffect, useState } from "react";
import { collection, getDocs } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../../firebase-config";

const appId = import.meta.env.VITE_PROJECT_ID || "embryo-project";

const primary = "px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white shadow";
const secondary = "px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200";
const danger = "px-3 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white";

function Modal({ title, onClose, children, wide = false }) {
  return (
    <div className="fixed inset-0 bg-black/40 z-50 grid place-items-center p-4">
      <div className={`bg-white rounded-2xl shadow-xl w-full ${wide ? "max-w-5xl" : "max-w-3xl"} max-h-[90vh] overflow-y-auto`}>
        <div className="sticky top-0 bg-white border-b p-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button onClick={onClose} className="text-2xl text-slate-500" aria-label="close">×</button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}

export default function ClientPricingModal({ client, onClose }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [globalAdjustment, setGlobalAdjustment] = useState(0);
  const [rules, setRules] = useState([]);
  const [activeTab, setActiveTab] = useState("product");
  
  // Списки для вибору
  const [brands, setBrands] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  
  // Форма додавання правила
  const [formBrand, setFormBrand] = useState("");
  const [formId, setFormId] = useState("");
  const [formSupplier, setFormSupplier] = useState("");
  const [formPriceGroup, setFormPriceGroup] = useState("ціна 1");
  const [formAdjustment, setFormAdjustment] = useState(0);
  
  const priceGroups = ["роздріб", "ціна 1", "ціна 2", "ціна 3", "ціна опт"];
  
  useEffect(() => {
    loadData();
  }, [client]);
  
  const loadData = async () => {
    setLoading(true);
    try {
      // Завантажуємо правила клієнта
      const getRules = httpsCallable(functions, "getClientPricingRules");
      const { data } = await getRules({ clientId: client.id });
      
      // Міграція: якщо є старі поля, конвертуємо
      if (data.globalAdjustment !== undefined) {
        setGlobalAdjustment(data.globalAdjustment || 0);
      } else {
        const discount = Number(data.globalDiscount || 0);
        const markup = Number(data.globalMarkup || 0);
        setGlobalAdjustment(markup - discount);
      }
      
      // Конвертація правил
      const convertedRules = Array.isArray(data.rules) ? data.rules.map(rule => {
        if (rule.adjustment !== undefined) return rule;
        const discount = Number(rule.discount || 0);
        const markup = Number(rule.markup || 0);
        return { ...rule, adjustment: markup - discount };
      }) : [];
      setRules(convertedRules);
      
      // Завантажуємо бренди
      const brandsSnap = await getDocs(collection(db, `/artifacts/${appId}/public/meta/brands`));
      const brandsList = brandsSnap.docs.map(d => d.data().name || d.id).filter(Boolean).sort();
      setBrands(brandsList);
      
      // Завантажуємо постачальників
      const suppliersSnap = await getDocs(collection(db, `/artifacts/${appId}/public/data/suppliers`));
      const suppliersList = suppliersSnap.docs.map(d => d.data().name || d.id).filter(Boolean).sort();
      setSuppliers(suppliersList);
    } catch (e) {
      console.error("Помилка завантаження даних", e);
      alert(e?.message || "Не вдалося завантажити дані");
    } finally {
      setLoading(false);
    }
  };
  
  const handleAddRule = () => {
    if (activeTab === "product" && (!formBrand || !formId)) {
      alert("Вкажіть бренд та артикул");
      return;
    }
    if (activeTab === "brand" && !formBrand) {
      alert("Вкажіть бренд");
      return;
    }
    if (activeTab === "supplier" && !formSupplier) {
      alert("Вкажіть постачальника");
      return;
    }
    
    const newRule = {
      type: activeTab,
      priceGroup: formPriceGroup,
      adjustment: Number(formAdjustment) || 0
    };
    
    if (activeTab === "product") {
      newRule.brand = formBrand;
      newRule.id = formId.toUpperCase().trim();
    } else if (activeTab === "brand") {
      newRule.brand = formBrand;
    } else if (activeTab === "supplier") {
      newRule.supplier = formSupplier;
    }
    
    setRules([...rules, newRule]);
    
    // Очищаємо форму
    setFormBrand("");
    setFormId("");
    setFormSupplier("");
    setFormPriceGroup("ціна 1");
    setFormAdjustment(0);
  };
  
  const handleRemoveRule = (index) => {
    if (!confirm("Видалити це правило?")) return;
    setRules(rules.filter((_, i) => i !== index));
  };
  
  const handleSave = async () => {
    setSaving(true);
    try {
      const setRulesCall = httpsCallable(functions, "setClientPricingRules");
      await setRulesCall({
        clientId: client.id,
        globalAdjustment: Number(globalAdjustment) || 0,
        rules: rules
      });
      alert("Правила збережено");
      onClose();
    } catch (e) {
      console.error("Помилка збереження", e);
      alert(e?.message || "Не вдалося зберегти правила");
    } finally {
      setSaving(false);
    }
  };
  
  if (loading) {
    return (
      <Modal title={`Ціноутворення для ${client.name || client.id}`} onClose={onClose} wide>
        <div className="text-center py-8">Завантаження...</div>
      </Modal>
    );
  }
  
  return (
    <Modal title={`Ціноутворення для ${client.name || client.id}`} onClose={onClose} wide>
      <div className="space-y-6">
        {/* Загальні налаштування */}
        <div className="border-b pb-4">
          <h4 className="font-semibold mb-3">Загальні налаштування</h4>
          <div>
            <label className="block text-sm mb-1">Коефіцієнт ціни (%)</label>
            <input
              type="number"
              min="-100"
              max="100"
              step="0.1"
              className="w-full p-2 border rounded"
              value={globalAdjustment}
              onChange={(e) => setGlobalAdjustment(e.target.value)}
              placeholder="0"
            />
            <p className="text-xs text-slate-500 mt-1">
              Негативне значення = знижка (напр. -2%), позитивне = націнка (напр. 3%). Застосовується до всіх товарів
            </p>
          </div>
        </div>
        
        {/* Табуляції */}
        <div className="border-b">
          <div className="flex gap-2">
            <button
              className={`px-4 py-2 rounded-t-lg ${activeTab === "product" ? "bg-indigo-600 text-white" : "bg-slate-100"}`}
              onClick={() => setActiveTab("product")}
            >
              Товар
            </button>
            <button
              className={`px-4 py-2 rounded-t-lg ${activeTab === "brand" ? "bg-indigo-600 text-white" : "bg-slate-100"}`}
              onClick={() => setActiveTab("brand")}
            >
              Бренд
            </button>
            <button
              className={`px-4 py-2 rounded-t-lg ${activeTab === "supplier" ? "bg-indigo-600 text-white" : "bg-slate-100"}`}
              onClick={() => setActiveTab("supplier")}
            >
              Постачальник
            </button>
          </div>
        </div>
        
        {/* Форма додавання правила */}
        <div className="border rounded-lg p-4 bg-slate-50">
          <h4 className="font-semibold mb-3">Додати правило</h4>
          
          {activeTab === "product" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-sm mb-1">Бренд</label>
                <select
                  className="w-full p-2 border rounded"
                  value={formBrand}
                  onChange={(e) => setFormBrand(e.target.value)}
                >
                  <option value="">— оберіть бренд —</option>
                  {brands.map(b => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm mb-1">Артикул</label>
                <input
                  type="text"
                  className="w-full p-2 border rounded"
                  value={formId}
                  onChange={(e) => setFormId(e.target.value)}
                  placeholder="Введіть артикул"
                />
              </div>
            </div>
          )}
          
          {activeTab === "brand" && (
            <div className="mb-4">
              <label className="block text-sm mb-1">Бренд</label>
              <select
                className="w-full p-2 border rounded"
                value={formBrand}
                onChange={(e) => setFormBrand(e.target.value)}
              >
                <option value="">— оберіть бренд —</option>
                {brands.map(b => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </div>
          )}
          
          {activeTab === "supplier" && (
            <div className="mb-4">
              <label className="block text-sm mb-1">Постачальник</label>
              <select
                className="w-full p-2 border rounded"
                value={formSupplier}
                onChange={(e) => setFormSupplier(e.target.value)}
              >
                <option value="">— оберіть постачальника —</option>
                {suppliers.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          )}
          
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-sm mb-1">Градація ціни</label>
              <select
                className="w-full p-2 border rounded"
                value={formPriceGroup}
                onChange={(e) => setFormPriceGroup(e.target.value)}
              >
                {priceGroups.map(pg => (
                  <option key={pg} value={pg}>{pg}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm mb-1">Коефіцієнт ціни (%)</label>
              <input
                type="number"
                min="-100"
                max="100"
                step="0.1"
                className="w-full p-2 border rounded"
                value={formAdjustment}
                onChange={(e) => setFormAdjustment(e.target.value)}
                placeholder="0"
              />
              <p className="text-xs text-slate-500 mt-1">
                Негативне = знижка (напр. -2%), позитивне = націнка (напр. 3%)
              </p>
            </div>
          </div>
          
          <button
            type="button"
            className={primary}
            onClick={handleAddRule}
          >
            Додати правило
          </button>
        </div>
        
        {/* Список правил */}
        <div>
          <h4 className="font-semibold mb-3">Існуючі правила ({rules.length})</h4>
          {rules.length === 0 ? (
            <p className="text-slate-500 text-sm">Немає правил</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="p-2 text-left">Тип</th>
                    <th className="p-2 text-left">Значення</th>
                    <th className="p-2 text-left">Градація</th>
                    <th className="p-2 text-left">Коефіцієнт</th>
                    <th className="p-2 text-left">Дії</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((rule, idx) => (
                    <tr key={idx} className="border-t">
                      <td className="p-2">{rule.type}</td>
                      <td className="p-2">
                        {rule.type === "product" && `${rule.brand} ${rule.id}`}
                        {rule.type === "brand" && rule.brand}
                        {rule.type === "supplier" && rule.supplier}
                      </td>
                      <td className="p-2">{rule.priceGroup}</td>
                      <td className="p-2">
                        {(() => {
                          const adj = rule.adjustment !== undefined 
                            ? Number(rule.adjustment || 0)
                            : (Number(rule.markup || 0) - Number(rule.discount || 0));
                          return adj > 0 ? `+${adj}%` : `${adj}%`;
                        })()}
                      </td>
                      <td className="p-2">
                        <button
                          className="px-2 py-1 rounded bg-red-100 hover:bg-red-200 text-red-700 text-xs"
                          onClick={() => handleRemoveRule(idx)}
                        >
                          Видалити
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        
        {/* Кнопки */}
        <div className="flex justify-end gap-3 pt-4 border-t">
          <button className={secondary} onClick={onClose} disabled={saving}>
            Скасувати
          </button>
          <button className={primary} onClick={handleSave} disabled={saving}>
            {saving ? "Збереження..." : "Зберегти"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

