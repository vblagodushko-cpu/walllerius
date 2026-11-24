import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase-config.js';
import useDebouncedValue from '../admin/hooks/useDebouncedValue.js';

const EMPTY_HINT = 'У ваших товарах немає. Натисніть Знайти для пошуку по всьому каталогу.';
const SEEN_KEY = 'portalSearchBoxSeen';

function readSeen() {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeSeen() {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* приватний режим браузера */
  }
}

export default function MasterSearchBox({
  value,
  onChange,
  onSearch,
  onPick,
  searching,
  showReset,
  onReset,
  tone = 'next',
}) {
  const classic = tone === 'classic';
  const debounced = useDebouncedValue(value, 300);
  const [showNew, setShowNew] = useState(() => !readSeen());
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const boxRef = useRef(null);
  const panelRef = useRef(null);
  const requestId = useRef(0);
  const suppressRef = useRef('');
  const [place, setPlace] = useState(null);

  useEffect(() => {
    const q = debounced.trim();
    if (q.length < 2 || q === suppressRef.current) {
      setItems([]);
      setOpen(false);
      setActive(-1);
      return undefined;
    }
    const id = ++requestId.current;
    let cancelled = false;
    httpsCallable(functions, 'suggestMasterProducts')({ q })
      .then(({ data }) => {
        if (cancelled || id !== requestId.current) return;
        setItems(Array.isArray(data?.items) ? data.items : []);
        setOpen(true);
        setActive(-1);
      })
      .catch(() => {
        if (cancelled || id !== requestId.current) return;
        setItems([]);
        setOpen(true);
        setActive(-1);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  useEffect(() => {
    const onPointer = (event) => {
      const target = event.target;
      if (boxRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
      setActive(-1);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const el = boxRef.current;
    if (!el) return undefined;
    const update = () => {
      const rect = el.getBoundingClientRect();
      const top = rect.bottom + 4;
      setPlace({
        top,
        left: rect.left,
        width: rect.width,
        maxHeight: Math.max(120, window.innerHeight - top - 12),
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  const dismissNew = () => {
    if (!showNew) return;
    writeSeen();
    setShowNew(false);
  };

  const pick = (item) => {
    dismissNew();
    suppressRef.current = item.id;
    requestId.current += 1;
    setOpen(false);
    setActive(-1);
    onPick(item);
  };

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      setOpen(false);
      setActive(-1);
      return;
    }
    if (!open || !items.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => (index + 1) % items.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => (index <= 0 ? items.length - 1 : index - 1));
    } else if (event.key === 'Enter' && active >= 0 && items[active]) {
      event.preventDefault();
      pick(items[active]);
    }
  };

  return (
    <form
      className={`flex min-w-0 flex-1 items-center gap-2 ${showNew ? 'pt-2' : ''}`}
      onSubmit={(event) => {
        event.preventDefault();
        dismissNew();
        requestId.current += 1;
        setOpen(false);
        setActive(-1);
        onSearch();
      }}
    >
      <div ref={boxRef} className="relative min-w-0 flex-1">
        {showNew ? (
          <span className="pointer-events-none absolute -top-2 right-2 z-10 rounded-full bg-indigo-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none text-white">
            нове
          </span>
        ) : null}
        <input
          type="search"
          value={value}
          onChange={(event) => {
            suppressRef.current = '';
            onChange(event.target.value);
            if (event.target.value.trim()) dismissNew();
          }}
          onFocus={() => {
            if (items.length || (debounced.trim().length >= 2 && debounced.trim() !== suppressRef.current)) setOpen(true);
          }}
          onKeyDown={onKeyDown}
          placeholder="Артикул або назва"
          className={classic
            ? `h-10 w-full rounded-lg border px-3 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500 ${showNew ? 'border-indigo-400 bg-indigo-50 ring-2 ring-indigo-200' : 'border-gray-200'}`
            : `w-full rounded-xl border px-3 py-2 text-sm outline-none focus:border-indigo-500 ${showNew ? 'border-indigo-400 bg-indigo-50 ring-2 ring-indigo-200' : 'border-stone-200'}`}
          aria-autocomplete="list"
          aria-expanded={open}
        />
        {open && place ? createPortal(
          <div
            ref={panelRef}
            style={{ top: place.top, left: place.left, width: place.width, maxHeight: place.maxHeight }}
            className="fixed z-[70] overflow-hidden rounded-xl border border-stone-200 bg-white shadow-lg"
            onMouseDown={(event) => event.preventDefault()}
          >
            {items.length ? (
              <ul className="overflow-auto py-1" style={{ maxHeight: place.maxHeight }} role="listbox">
                {items.map((item, index) => (
                  <li key={`${item.brand}-${item.id}`}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={index === active}
                      className={`block w-full px-3 py-2 text-left text-sm ${index === active ? 'bg-indigo-50' : 'hover:bg-stone-50'}`}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => pick(item)}
                    >
                      <span className="font-medium text-stone-900">{item.brand ? `${item.brand} · ` : ''}{item.id}</span>
                      {item.correctName ? <span className="mt-0.5 block text-stone-600">{item.correctName}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-3 py-2 text-sm text-stone-500">{EMPTY_HINT}</p>
            )}
          </div>,
          document.body,
        ) : null}
      </div>
      <button type="submit" disabled={searching} className={classic
        ? 'h-10 shrink-0 rounded-lg bg-indigo-600 px-3 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50 sm:px-4'
        : 'rounded-xl bg-indigo-700 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-800 disabled:opacity-50'}>
        {searching ? '…' : 'Знайти'}
      </button>
      {showReset ? (
        <button
          type="button"
          className="rounded-xl px-2 py-2 text-sm text-stone-600 hover:bg-stone-100"
          onClick={() => {
            suppressRef.current = '';
            setOpen(false);
            onReset();
          }}
        >
          Скинути
        </button>
      ) : null}
    </form>
  );
}
