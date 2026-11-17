import React, { useMemo } from 'react';
import useDebouncedValue from '../admin/hooks/useDebouncedValue.js';

export default function CatalogSidebar({
  mode,
  onMode,
  groups,
  expandedGroup,
  selectedGroup,
  selectedBrand,
  onOpenGroup,
  brands,
  brandSearch,
  onBrandSearch,
  onOpenBrand,
  onClose,
}) {
  const debouncedBrandSearch = useDebouncedValue(brandSearch, 400);
  const visibleBrands = useMemo(() => {
    const q = debouncedBrandSearch.trim().toLowerCase();
    if (!q) return brands;
    return brands.filter((b) => String(b.name || '').toLowerCase().includes(q));
  }, [brands, debouncedBrandSearch]);

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-2xl border border-stone-200 bg-white p-3">
      <div className="mb-3 flex items-center justify-between gap-2 md:hidden">
        <span className="text-sm font-semibold text-stone-900">Каталог</span>
        <button type="button" className="rounded-lg px-2 py-1 text-lg leading-none text-stone-500 hover:bg-stone-100" onClick={onClose} aria-label="Закрити каталог">×</button>
      </div>
      <div className="mb-3 grid grid-cols-2 gap-1 rounded-xl bg-stone-100 p-1">
        <button type="button" className={`rounded-lg px-2 py-1.5 text-sm font-medium ${mode === 'groups' ? 'bg-white text-indigo-700 shadow-sm' : 'text-stone-600'}`} onClick={() => onMode('groups')}>Групи</button>
        <button type="button" className={`rounded-lg px-2 py-1.5 text-sm font-medium ${mode === 'brands' ? 'bg-white text-indigo-700 shadow-sm' : 'text-stone-600'}`} onClick={() => onMode('brands')}>Бренди</button>
      </div>

      {mode === 'groups' ? (
        <div className="min-h-0 flex-1 space-y-1 overflow-auto">
          {groups.map((group) => {
            const groupType = group.groupType || (group.filterType === 'category' ? 'category' : 'preset');
            const isExpanded = expandedGroup === group.id;
            const isSelected = selectedGroup === group.id || (groupType === 'preset' && group.brands?.length === 1 && selectedBrand === group.brands[0]);
            return (
              <div key={group.id} className="overflow-hidden rounded-xl border border-stone-200">
                <button
                  type="button"
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium ${isSelected ? 'bg-indigo-50 text-indigo-800' : 'hover:bg-stone-50'}`}
                  onClick={() => onOpenGroup(group)}
                >
                  <span className="truncate">{group.name || group.id}</span>
                  {groupType === 'preset' && group.brands && group.brands.length > 1 ? (
                    <span className="text-[10px] text-stone-400">{isExpanded ? '▲' : '▼'}</span>
                  ) : null}
                </button>
                {isExpanded && groupType === 'preset' && group.brands && group.brands.length > 1 ? (
                  <div className="border-t border-stone-200">
                    {[...group.brands].sort((a, b) => String(a).localeCompare(String(b), 'uk')).map((brandName) => (
                      <button
                        key={brandName}
                        type="button"
                        className={`block w-full px-4 py-2 text-left text-sm ${selectedBrand === brandName ? 'bg-indigo-50 font-medium text-indigo-800' : 'hover:bg-stone-50'}`}
                        onClick={() => onOpenBrand(brandName)}
                      >
                        {brandName}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
          {groups.length === 0 ? <p className="px-2 py-3 text-sm text-stone-500">Групи не налаштовані</p> : null}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <input
            type="search"
            value={brandSearch}
            onChange={(e) => onBrandSearch(e.target.value)}
            placeholder="Пошук бренда"
            className="w-full rounded-xl border border-stone-200 px-3 py-2 text-sm outline-none focus:border-indigo-400"
          />
          <div className="min-h-0 flex-1 space-y-1 overflow-auto">
            {visibleBrands.map((b) => (
              <button
                key={b.id || b.name}
                type="button"
                className={`block w-full rounded-xl px-3 py-2 text-left text-sm ${selectedBrand === b.name ? 'bg-indigo-50 font-medium text-indigo-800' : 'hover:bg-stone-50'}`}
                onClick={() => onOpenBrand(b.name)}
              >
                {b.name}
              </button>
            ))}
            {visibleBrands.length === 0 ? <p className="px-2 py-3 text-sm text-stone-500">Нічого не знайдено</p> : null}
          </div>
        </div>
      )}
    </div>
  );
}
