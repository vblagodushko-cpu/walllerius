import React, { useState } from 'react';

/** Безпечне відображення: без HTML/Markdown-рендеру (тільки текст + переноси рядків). */
export default function ProductDetailModal({ product, body, imageUrl, loading, error, onClose }) {
  const hasMeta = Boolean(
    String(product?.pack || "").trim() ||
    String(product?.tolerances || "").trim() ||
    (Array.isArray(product?.toleranceTags) && product.toleranceTags.length)
  );
  const [lightboxOpen, setLightboxOpen] = useState(false);
  if (!product) return null;
  return (
    <>
      <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex justify-center items-center p-4">
        <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col">
          <div className="p-4 border-b flex justify-between items-start gap-2">
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Деталі товару</h3>
              <p className="text-sm text-gray-600 mt-1 break-words">{product.name || 'Без назви'}</p>
              <p className="text-xs text-gray-500 mt-1">
                {product.brand} · {product.id}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="px-2 py-1 rounded bg-gray-100 hover:bg-gray-200 text-sm shrink-0"
            >
              Закрити
            </button>
          </div>
          <div className="p-4 overflow-y-auto flex-1 min-h-0">
            {loading && <p className="text-gray-500 text-sm">Завантаження...</p>}
            {error && <p className="text-red-600 text-sm">{error}</p>}
            {!loading && !error && (
              <>
                {hasMeta && (
                  <div className="mb-4 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-xs space-y-1.5">
                    {String(product?.pack || "").trim() ? (
                      <div className="flex gap-2">
                        <span className="shrink-0 text-slate-500 w-20">Фасування</span>
                        <span className="text-slate-800 font-medium">{product.pack}</span>
                      </div>
                    ) : null}
                    {String(product?.tolerances || "").trim() ? (
                      <div className="flex gap-2">
                        <span className="shrink-0 text-slate-500 w-20">Допуски</span>
                        <span className="text-slate-800">{product.tolerances}</span>
                      </div>
                    ) : null}
                    {Array.isArray(product?.toleranceTags) && product.toleranceTags.length ? (
                      <div className="flex gap-2 flex-wrap pt-0.5">
                        {product.toleranceTags.map((tag) => (
                          <span
                            key={tag}
                            className="rounded-full bg-indigo-50 border border-indigo-100 px-2 py-0.5 text-indigo-700 text-[11px] font-medium"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                )}
                {imageUrl ? (
                  <button
                    type="button"
                    onClick={() => setLightboxOpen(true)}
                    className="mb-4 block w-full rounded-lg border bg-gray-50 overflow-hidden focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    title="Збільшити фото"
                  >
                    <img
                      src={imageUrl}
                      alt=""
                      className="w-full max-h-56 object-contain mx-auto"
                      loading="lazy"
                    />
                  </button>
                ) : null}
                <pre className="whitespace-pre-wrap text-sm text-gray-800 font-sans leading-relaxed">
                  {body?.trim() ? body : 'Детальний опис ще не додано.'}
                </pre>
              </>
            )}
          </div>
        </div>
      </div>
      {lightboxOpen && imageUrl && (
        <div
          className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center p-4"
          onClick={() => setLightboxOpen(false)}
          role="presentation"
        >
          <button
            type="button"
            className="absolute top-4 right-4 text-white text-sm px-3 py-1 rounded bg-white/20"
            onClick={() => setLightboxOpen(false)}
          >
            Закрити
          </button>
          <img
            src={imageUrl}
            alt=""
            className="max-w-full max-h-[90vh] object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}
