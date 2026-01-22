import React from "react";


export default function SearchInput({ value, onChange, placeholder = "Пошук…" }) {
return (
<input
className="w-full md:w-80 px-3 py-2 border rounded-xl focus:outline-none focus:ring"
value={value}
onChange={(e) => onChange(e.target.value)}
placeholder={placeholder}
/>
);
}