import React, { useEffect, useState } from "react";

/**
 * Фото картки плитки. Рамка завжди на весь блок, тож маленьке або бите зображення
 * не лишається іконкою в куті. Якщо thumb не відкрився — пробуємо повний файл.
 */
export default function CatalogTilePhoto({ src, fallbackSrc = "", alt = "" }) {
  const [current, setCurrent] = useState(src || "");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setCurrent(src || "");
    setFailed(false);
  }, [src, fallbackSrc]);

  if (!current || failed) {
    return (
      <span className="absolute inset-0 flex items-center justify-center px-2 text-center text-xs text-gray-400">
        немає фото
      </span>
    );
  }

  return (
    <img
      src={current}
      alt={alt}
      loading="lazy"
      decoding="async"
      className="absolute inset-0 h-full w-full object-contain"
      onError={() => {
        if (fallbackSrc && current !== fallbackSrc) {
          setCurrent(fallbackSrc);
          return;
        }
        setFailed(true);
      }}
    />
  );
}
