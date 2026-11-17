import { ref, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { storage } from "../firebase-config";
import { prepareProductImageBlobs } from "./productImage";

export function productImageStoragePaths(appId, productDocId) {
  const base = `artifacts/${appId}/products/${productDocId}`;
  return {
    main: `${base}/main.webp`,
    thumb: `${base}/thumb.webp`,
  };
}

/**
 * Завантажити main + thumb у Storage, повернути URL та шляхи для Firestore.
 */
export async function uploadProductImages(appId, productDocId, file) {
  const { mainBlob, thumbBlob } = await prepareProductImageBlobs(file);
  const paths = productImageStoragePaths(appId, productDocId);
  const mainRef = ref(storage, paths.main);
  const thumbRef = ref(storage, paths.thumb);

  await Promise.all([
    uploadBytes(mainRef, mainBlob, { contentType: "image/webp", cacheControl: "public,max-age=86400" }),
    uploadBytes(thumbRef, thumbBlob, { contentType: "image/webp", cacheControl: "public,max-age=86400" }),
  ]);

  const [imageUrl, imageThumbUrl] = await Promise.all([
    getDownloadURL(mainRef),
    getDownloadURL(thumbRef),
  ]);

  return {
    imageUrl,
    imageThumbUrl,
    imageStoragePath: paths.main,
    imageThumbStoragePath: paths.thumb,
  };
}

/**
 * Нове фото завжди лежить у main.webp / thumb.webp цього товару.
 * Старі шляхи треба стирати лише якщо вони інші: інакше щойно завантажений файл видаляється одразу після запису.
 */
export async function replaceProductImages(appId, productDocId, file, oldMainPath, oldThumbPath) {
  const uploaded = await uploadProductImages(appId, productDocId, file);
  const keep = new Set([uploaded.imageStoragePath, uploaded.imageThumbStoragePath]);
  const staleMain = oldMainPath && !keep.has(oldMainPath) ? oldMainPath : "";
  const staleThumb = oldThumbPath && !keep.has(oldThumbPath) ? oldThumbPath : "";
  if (staleMain || staleThumb) {
    await deleteProductImagesAtPaths(staleMain, staleThumb);
  }
  return uploaded;
}

export async function deleteProductImagesAtPaths(pathMain, pathThumb) {
  const tasks = [];
  if (pathMain) {
    tasks.push(deleteObject(ref(storage, pathMain)).catch(() => {}));
  }
  if (pathThumb) {
    tasks.push(deleteObject(ref(storage, pathThumb)).catch(() => {}));
  }
  await Promise.all(tasks);
}
