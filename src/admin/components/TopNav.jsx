import React from "react";

export default function TopNav({ items, value, onChange, orderCounts, pendingRequestsCount = 0 }) {
  return (
    <nav className="flex items-center gap-2">
      {items.map((it) => {
        const isOrders = it.key === "orders";
        const isClients = it.key === "clients";
        const newCount = isOrders && orderCounts ? (orderCounts.new || 0) : 0;
        const partialCount = isOrders && orderCounts ? (orderCounts.partial || 0) : 0;
        const requestsCount = isClients ? (pendingRequestsCount || 0) : 0;
        
        return (
          <button
            key={it.key}
            onClick={() => onChange(it.key)}
            className={[
              "px-4 py-2 rounded-xl text-sm relative",
              value === it.key ? "bg-indigo-600 text-white" : "bg-gray-100 hover:bg-gray-200"
            ].join(" ")}
          >
            {it.label}
            {isOrders && (newCount > 0 || partialCount > 0) && (
              <span className="absolute -top-1 -right-1 flex items-center gap-1">
                {newCount > 0 && (
                  <span className="flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-red-500 text-white text-xs font-semibold">
                    {newCount > 99 ? "99+" : newCount}
                  </span>
                )}
                {partialCount > 0 && (
                  <span className="flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-yellow-500 text-white text-xs font-semibold">
                    {partialCount > 99 ? "99+" : partialCount}
                  </span>
                )}
              </span>
            )}
            {isClients && requestsCount > 0 && (
              <span className="absolute -top-1 -right-1 flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-yellow-500 text-white text-xs font-semibold">
                {requestsCount > 99 ? "99+" : requestsCount}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
