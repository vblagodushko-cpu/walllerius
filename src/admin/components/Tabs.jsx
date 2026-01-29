import React from "react";

export default function Tabs({ items, value, onChange }) {
  return (
    <div className="flex bg-gray-100 p-1 rounded-xl overflow-x-auto -mx-2 px-2 whitespace-nowrap gap-1">
      {items.map((it) => (
        <button
          key={it.key}
          onClick={() => onChange(it.key)}
          className={[
            "px-4 py-2 text-sm rounded-lg flex-shrink-0",
            value === it.key ? "bg-white shadow" : "text-gray-600 hover:text-gray-900",
          ].join(" ")}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}