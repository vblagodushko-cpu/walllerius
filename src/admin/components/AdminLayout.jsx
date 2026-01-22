import React from "react";

export default function AdminLayout({ title, right, children }) {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-indigo-600 text-white grid place-items-center font-bold">
              R
            </div>
            <div>
              <div className="text-lg font-semibold leading-5">{title}</div>
              <div className="text-xs text-gray-500">appId: {import.meta.env.VITE_PROJECT_ID}</div>
            </div>
          </div>
          <div>{right}</div>
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-4 py-6">{children}</main>
    </div>
  );
}
