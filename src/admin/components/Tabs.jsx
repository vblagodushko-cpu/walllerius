import React from "react";


export default function Tabs({ items, value, onChange }) {
return (
<div className="inline-flex bg-gray-100 p-1 rounded-xl">
{items.map((it) => (
<button
key={it.key}
onClick={() => onChange(it.key)}
className={[
"px-4 py-2 text-sm rounded-lg",
value === it.key ? "bg-white shadow" : "text-gray-600 hover:text-gray-900",
].join(" ")}
>
{it.label}
</button>
))}
</div>
);
}