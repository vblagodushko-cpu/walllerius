// src/admin/hooks/useClientSearch.js
import { useState, useEffect, useCallback, useRef } from "react";
import { collection, query, orderBy, getDocs } from "firebase/firestore";
import { db } from "../../firebase-config";

const appId = import.meta.env.VITE_PROJECT_ID || "embryo-project";
const CLIENTS_PATH = `/artifacts/${appId}/public/data/clients`;

/**
 * Уніфікований хук для пошуку клієнтів
 * @param {Object} options - Опції конфігурації
 * @param {number} options.debounceMs - Затримка перед застосуванням пошуку (мс)
 * @param {number|null} options.maxResults - Максимальна кількість результатів (null = без обмеження)
 * @param {boolean} options.autoLoad - Автоматично завантажувати кеш при ініціалізації
 * @returns {Object} - { searchQuery, setSearchQuery, appliedQuery, filteredClients, loading, allClientsCache, loadAllClients, invalidateCache }
 */
export function useClientSearch(options = {}) {
  const {
    debounceMs = 400,
    maxResults = null, // null = без обмеження, число = обмежити
    autoLoad = true, // Автоматично завантажувати кеш
  } = options;

  const [allClientsCache, setAllClientsCache] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [filteredClients, setFilteredClients] = useState([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef(null);

  // Завантажити всіх клієнтів (один раз)
  const loadAllClients = useCallback(async (force = false) => {
    if (allClientsCache && !force) return allClientsCache;
    
    setLoading(true);
    try {
      const snap = await getDocs(query(collection(db, CLIENTS_PATH), orderBy("id")));
      const clients = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setAllClientsCache(clients);
      return clients;
    } finally {
      setLoading(false);
    }
  }, [allClientsCache]);

  // Фільтрація клієнтів
  const filterClients = useCallback((clients, query) => {
    if (!query || !query.trim()) {
      return maxResults ? clients.slice(0, maxResults) : clients;
    }

    const s = query.trim();
    const searchLower = s.toLowerCase();
    const searchDigits = s.replace(/\D/g, ""); // для телефону

    let filtered = clients.filter(c => 
      c.id.toLowerCase().includes(searchLower) ||
      (c.name || "").toLowerCase().includes(searchLower) ||
      (searchDigits.length > 0 && (c.phone || "").includes(searchDigits))
    );

    if (maxResults) {
      filtered = filtered.slice(0, maxResults);
    }

    return filtered;
  }, [maxResults]);

  // Debounced пошук
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    if (!searchQuery.trim()) {
      setAppliedQuery("");
      // Для autocomplete (maxResults встановлено) не показуємо всіх клієнтів при порожньому запиті
      if (maxResults && maxResults > 0) {
        // Autocomplete режим: не показуємо результати, якщо поле порожнє
        setFilteredClients([]);
      } else {
        // Режим повного списку (ClientsPage): показуємо всіх
        if (allClientsCache) {
          setFilteredClients(filterClients(allClientsCache, ""));
        }
      }
      return;
    }

    // Якщо debounceMs = 0, застосовуємо одразу (для ClientsPage з Enter)
    if (debounceMs === 0) {
      // Не застосовуємо автоматично, чекаємо на Enter
      return;
    }

    debounceRef.current = setTimeout(() => {
      setAppliedQuery(searchQuery);
      if (allClientsCache) {
        setFilteredClients(filterClients(allClientsCache, searchQuery));
      }
    }, debounceMs);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [searchQuery, allClientsCache, filterClients, debounceMs]);

  // Оновлення результатів при зміні кешу
  useEffect(() => {
    if (allClientsCache) {
      setFilteredClients(filterClients(allClientsCache, appliedQuery));
    }
  }, [allClientsCache, appliedQuery, filterClients]);

  // Автоматичне завантаження
  useEffect(() => {
    if (autoLoad) {
      loadAllClients();
    }
  }, [autoLoad, loadAllClients]);

  // Функція для ручного застосування пошуку (для Enter в ClientsPage)
  const applySearch = useCallback(() => {
    setAppliedQuery(searchQuery);
    if (allClientsCache) {
      setFilteredClients(filterClients(allClientsCache, searchQuery));
    }
  }, [searchQuery, allClientsCache, filterClients]);

  // Інвалідація кешу
  const invalidateCache = useCallback(() => {
    setAllClientsCache(null);
    loadAllClients(true);
  }, [loadAllClients]);

  return {
    searchQuery,
    setSearchQuery,
    appliedQuery,
    filteredClients,
    loading,
    allClientsCache,
    loadAllClients,
    invalidateCache,
    applySearch, // Для ручного застосування (Enter)
  };
}


