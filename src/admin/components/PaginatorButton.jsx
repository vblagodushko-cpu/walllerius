import React from "react";


export default function PaginatorButton({ onClick, disabled, loading }) {
return (
<div className="flex justify-center mt-4">
<button
className="px-4 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 disabled:opacity-60"
onClick={onClick}
disabled={disabled || loading}
>
{loading ? "Завантаження…" : "Показати ще"}
</button>
</div>
);
}