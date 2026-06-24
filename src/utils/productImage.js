/** Підготовка фото товару: main (до maxMain px) + thumb (до maxThumb px), WebP. */

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Нормалізує файл з буфера (скріншот інколи без MIME-type). */
export function normalizeClipboardImageFile(file) {
  if (!file) return null;
  let type = (file.type || "").toLowerCase();
  if (!type || type === "application/octet-stream") {
    type = "image/png";
  }
  if (!ACCEPTED_TYPES.has(type)) return null;
  if (file.type === type && file.name) return file;
  const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
  return new File([file], file.name || `pasted-image.${ext}`, { type });
}

/** Витягнути перше зображення з clipboardData (paste). */
export function getImageFileFromClipboard(clipboardData) {
  if (!clipboardData) return null;

  const items = clipboardData.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const raw = item.getAsFile();
        const normalized = normalizeClipboardImageFile(raw);
        if (normalized) return normalized;
      }
    }
  }

  const files = clipboardData.files;
  if (files?.length === 1) {
    return normalizeClipboardImageFile(files[0]);
  }

  return null;
}

/** Для validate + prepare: повертає файл з коректним type. */
export function coerceProductImageFile(file) {
  if (!file) return file;
  return normalizeClipboardImageFile(file) || file;
}

export function validateProductImageFile(file) {
  if (!file) return "Файл не обрано.";
  const candidate = coerceProductImageFile(file);
  const type = (candidate.type || "").toLowerCase();
  if (!ACCEPTED_TYPES.has(type)) {
    return "Дозволені формати: JPEG, PNG, WebP.";
  }
  if (candidate.size > MAX_INPUT_BYTES) {
    return "Файл завеликий (макс. 8 МБ).";
  }
  return null;
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Не вдалося прочитати зображення."));
    };
    img.src = url;
  });
}

function canvasToWebpBlob(canvas, quality = 0.85) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Не вдалося стиснути зображення."))),
      "image/webp",
      quality
    );
  });
}

function drawScaled(img, maxSide) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, tw, th);
  return canvas;
}

/**
 * @param {File} file
 * @param {{ maxMain?: number, maxThumb?: number }} opts
 * @returns {Promise<{ mainBlob: Blob, thumbBlob: Blob }>}
 */
export async function prepareProductImageBlobs(file, opts = {}) {
  const maxMain = opts.maxMain ?? 1200;
  const maxThumb = opts.maxThumb ?? 240;
  const coerced = coerceProductImageFile(file);
  const err = validateProductImageFile(coerced);
  if (err) throw new Error(err);

  const img = await loadImageFromFile(coerced);
  const mainCanvas = drawScaled(img, maxMain);
  const thumbCanvas = drawScaled(img, maxThumb);
  const [mainBlob, thumbBlob] = await Promise.all([
    canvasToWebpBlob(mainCanvas, 0.86),
    canvasToWebpBlob(thumbCanvas, 0.8),
  ]);
  return { mainBlob, thumbBlob };
}
