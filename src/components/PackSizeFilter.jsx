import React, { useState } from "react";
import { PACK_BUCKETS } from "../utils/packFilter.js";

const USED_KEY = "portalPackFilterUsed";

function alreadyUsed() {
  try {
    return localStorage.getItem(USED_KEY) === "1";
  } catch {
    return false;
  }
}

export default function PackSizeFilter({ value, onChange }) {
  const [showNew, setShowNew] = useState(() => !alreadyUsed());

  const markUsed = () => {
    if (!showNew) return;
    try {
      localStorage.setItem(USED_KEY, "1");
    } catch {
      /* приватний режим браузера */
    }
    setShowNew(false);
  };

  return (
    <div className="relative">
      {showNew ? (
        <span className="pointer-events-none absolute -top-2 right-1 z-10 rounded-full bg-indigo-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none text-white">
          нове
        </span>
      ) : null}
      <select
        className={`rounded-xl border px-2 py-1.5 text-sm ${
          showNew ? "border-indigo-400 bg-indigo-50 ring-2 ring-indigo-200" : "border-stone-200"
        }`}
        value={value || ""}
        onChange={(e) => {
          onChange(e.target.value);
          if (e.target.value) markUsed();
        }}
        aria-label="Фасовка"
      >
        <option value="">Фасовка</option>
        {PACK_BUCKETS.map((bucket) => (
          <option key={bucket.id} value={bucket.id} title={bucket.title}>
            {bucket.label}
          </option>
        ))}
      </select>
    </div>
  );
}
