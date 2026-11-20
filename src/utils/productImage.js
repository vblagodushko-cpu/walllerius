/** Підготовка фото товару: main (до maxMain px) + thumb (до maxThumb px). */

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const ACCEPTED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/bmp",
]);

/** MIME, який реально вміє намалювати canvas. Порожній рядок — не зображення. */
export function canonicalImageMime(type) {
  const t = String(type || "").toLowerCase().split(";")[0].trim();
  if (t === "image/jpg" || t === "image/pjpeg" || t === "image/x-citrix-jpeg") return "image/jpeg";
  if (t === "image/x-png") return "image/png";
  if (t === "image/x-ms-bmp" || t === "image/bmp") return "image/bmp";
  if (ACCEPTED_TYPES.has(t)) return t;
  return "";
}

export function sniffImageMime(bytes) {
  if (!bytes || bytes.length < 3) return "";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return "";
}

function isHeic(file) {
  const type = String(file?.type || "").toLowerCase();
  const name = String(file?.name || "");
  return type === "image/heic" || type === "image/heif" || /\.hei[cf]$/i.test(name);
}

/** Нормалізує файл з буфера (скріншот інколи без MIME-type або з image/jpg). */
export function normalizeClipboardImageFile(file) {
  if (!file) return null;
  if (isHeic(file)) return null;
  let type = canonicalImageMime(file.type);
  if (!type && (!file.type || file.type === "application/octet-stream")) {
    type = "application/octet-stream";
  }
  if (!type) return null;
  if (file.type === type && file.name) return file;
  const ext =
    type === "image/png"
      ? "png"
      : type === "image/webp"
        ? "webp"
        : type === "image/gif"
          ? "gif"
          : type === "image/bmp"
            ? "bmp"
            : type === "image/jpeg"
              ? "jpg"
              : "img";
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
  if (isHeic(file)) return "Формат HEIC не підтримується. Збережіть фото як JPEG або PNG.";
  const candidate = coerceProductImageFile(file);
  const type = canonicalImageMime(candidate.type);
  const loose = !candidate.type || candidate.type === "application/octet-stream";
  if (!type && !loose) {
    return "Дозволені формати: JPEG, PNG, WebP, GIF, BMP.";
  }
  if (candidate.size > MAX_INPUT_BYTES) {
    return "Файл завеликий (макс. 8 МБ).";
  }
  return null;
}

/** id документа → один сегмент шляху Storage. Звичайні id не змінюються. */
export function storageSafeProductId(productDocId) {
  const id = String(productDocId ?? "");
  if (/^[A-Za-z0-9._-]{1,500}$/.test(id) && id !== "." && id !== "..") return id;
  let out = "";
  for (const ch of id) {
    if (/^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += `_u${ch.codePointAt(0).toString(16)}_`;
  }
  return (out || "product").slice(0, 500);
}

/** Новий query-параметр, щоб браузер не показував закешовану биту відповідь того самого URL. */
export function cacheBustDownloadUrl(url) {
  const raw = String(url || "");
  if (!raw) return raw;
  const v = Date.now().toString(36);
  return raw.includes("?") ? `${raw}&v=${v}` : `${raw}?v=${v}`;
}

/** Що показати на плитці: спершу thumb, якщо він не відкриється — повне фото. */
export function tilePhotoFromDetails(data) {
  const thumb = String(data?.imageThumbUrl || "");
  const full = String(data?.imageUrl || "");
  return {
    src: thumb || full,
    fallback: thumb && full && thumb !== full ? full : "",
  };
}

function loadImageElement(file) {
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

async function loadImageFromFile(file) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      if ((bitmap.width || 0) > 0 && (bitmap.height || 0) > 0) return bitmap;
      bitmap.close?.();
    } catch {
      /* далі пробуємо Image() */
    }
  }
  return loadImageElement(file);
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob || null), type, quality);
  });
}

async function encodeCanvas(canvas, preferredQuality) {
  const webpQualities = [preferredQuality, 0.72, 0.55];
  for (const quality of webpQualities) {
    const blob = await canvasToBlob(canvas, "image/webp", quality);
    if (blob && blob.size <= MAX_OUTPUT_BYTES) return { blob, contentType: "image/webp" };
  }
  const jpegQualities = [preferredQuality, 0.7, 0.5];
  for (const quality of jpegQualities) {
    const blob = await canvasToBlob(canvas, "image/jpeg", quality);
    if (blob && blob.size <= MAX_OUTPUT_BYTES) return { blob, contentType: "image/jpeg" };
  }
  throw new Error("Не вдалося стиснути зображення.");
}

function drawScaled(img, maxSide) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) throw new Error("Не вдалося прочитати розмір зображення.");
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, tw, th);
  ctx.drawImage(img, 0, 0, tw, th);
  return canvas;
}

/**
 * @param {File} file
 * @param {{ maxMain?: number, maxThumb?: number }} opts
 * @returns {Promise<{ mainBlob: Blob, thumbBlob: Blob, mainType: string, thumbType: string }>}
 */
export async function prepareProductImageBlobs(file, opts = {}) {
  const maxMain = opts.maxMain ?? 1200;
  const maxThumb = opts.maxThumb ?? 240;
  const coerced = coerceProductImageFile(file);
  const err = validateProductImageFile(coerced);
  if (err) throw new Error(err);

  let source = coerced;
  if (!canonicalImageMime(source.type)) {
    const head = new Uint8Array(await source.slice(0, 16).arrayBuffer());
    const sniffed = sniffImageMime(head);
    if (!sniffed) throw new Error("Дозволені формати: JPEG, PNG, WebP, GIF, BMP.");
    source = new File([source], source.name || "photo", { type: sniffed });
  }

  const img = await loadImageFromFile(source);
  try {
    const mainCanvas = drawScaled(img, maxMain);
    const thumbCanvas = drawScaled(img, maxThumb);
    const [main, thumb] = await Promise.all([
      encodeCanvas(mainCanvas, 0.86),
      encodeCanvas(thumbCanvas, 0.8),
    ]);
    return {
      mainBlob: main.blob,
      thumbBlob: thumb.blob,
      mainType: main.contentType,
      thumbType: thumb.contentType,
    };
  } finally {
    img.close?.();
  }
}
