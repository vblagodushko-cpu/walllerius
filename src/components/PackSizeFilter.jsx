import React from "react";
import { PACK_BUCKETS } from "../utils/packFilter.js";

export default function PackSizeFilter({ value, onChange }) {
  return (
    <select
      className="rounded-xl border border-stone-200 px-2 py-1.5 text-sm"
      value={value || ""}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Фасовка"
    >
      <option value="">Фасовка</option>
      {PACK_BUCKETS.map((bucket) => (
        <option key={bucket.id} value={bucket.id} title={bucket.title}>
          {bucket.label}
        </option>
      ))}
    </select>
  );
}
