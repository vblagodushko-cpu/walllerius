import React, { useState } from 'react';

const SEEN_KEY = 'portalNewsSeen';
const NEWS_ID = 'catalog-filter-tiles';
const FILTER_USED_KEY = 'portalFilterUsed';
const TILES_USED_KEY = 'portalTilesUsed';

function readFlag(key, expected) {
  try {
    return localStorage.getItem(key) === expected;
  } catch {
    return false;
  }
}

function writeFlag(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* приватний режим браузера */
  }
}

export function tilesNewsAlreadyUsed() {
  return readFlag(TILES_USED_KEY, '1') || readFlag('portalCatalogLayout', 'tiles');
}

export function markTilesNewsUsed() {
  writeFlag(TILES_USED_KEY, '1');
}

export default function PortalNewsNotice() {
  const [open, setOpen] = useState(() => !readFlag(SEEN_KEY, NEWS_ID));
  if (!open) return null;

  return (
    <div className="mb-3 flex items-start justify-between gap-3 rounded-2xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-950">
      <p>
        <b>Нове в каталозі.</b> У полі «Фільтр списку» можна шукати за назвою і вʼязкістю серед уже відкритих товарів. Кнопка <b>Плитка</b> показує ці самі товари картками з фото.
      </p>
      <button
        type="button"
        className="shrink-0 rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-indigo-700 shadow-sm hover:bg-indigo-100"
        onClick={() => {
          writeFlag(SEEN_KEY, NEWS_ID);
          setOpen(false);
        }}
      >
        Зрозуміло
      </button>
    </div>
  );
}

export function PortalListFilter({ value, onChange, className = '' }) {
  const [showNew, setShowNew] = useState(() => !readFlag(FILTER_USED_KEY, '1'));

  return (
    <div className={`relative ${className}`}>
      {showNew ? (
        <span className="pointer-events-none absolute -top-2 right-2 z-10 rounded-full bg-indigo-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none text-white">
          нове
        </span>
      ) : null}
      <input
        type="search"
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          onChange(next);
          if (next.trim() && showNew) {
            writeFlag(FILTER_USED_KEY, '1');
            setShowNew(false);
          }
        }}
        placeholder="Фільтр списку: назва, вʼязкість"
        className="w-full rounded-xl border border-stone-200 px-3 py-1.5 text-sm outline-none focus:border-indigo-400"
      />
    </div>
  );
}
