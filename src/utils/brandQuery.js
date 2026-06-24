import {
  collection,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  getDocs,
} from "firebase/firestore";

/** Усі варіанти написання бренду для Firestore where-in (max 30). */
export function brandNamesForQuery(brandMeta) {
  const canonical = String(brandMeta?.name || brandMeta || "").trim();
  if (!canonical) return [];

  const variants = Array.isArray(brandMeta?.variants) ? brandMeta.variants : [];
  const names = new Set([canonical, ...variants.map((v) => String(v || "").trim()).filter(Boolean)]);
  return [...names].slice(0, 30);
}

export function findBrandMeta(allBrands, brandName) {
  const key = String(brandName || "").trim().toLowerCase();
  if (!key) return null;
  return (
    allBrands.find((b) => String(b.name || "").trim().toLowerCase() === key) ||
    allBrands.find((b) => String(b.id || "").trim().toLowerCase() === key) ||
    null
  );
}

/** Завантаження товарів з урахуванням усіх варіантів brand (регістр/написання). */
export async function fetchProductsByBrandNames(
  db,
  appId,
  brandNames,
  { pageSize = 150, lastDocSnap = null, loadMore = false } = {}
) {
  const names = [...new Set((brandNames || []).map((n) => String(n || "").trim()).filter(Boolean))].slice(0, 30);
  if (!names.length) return { items: [], lastDoc: null, hasMore: false };

  const baseCol = collection(db, `/artifacts/${appId}/public/data/products`);

  if (names.length === 1) {
    const clauses = [where("brand", "==", names[0]), orderBy("brand"), orderBy("name"), limit(pageSize)];
    if (loadMore && lastDocSnap) clauses.push(startAfter(lastDocSnap));
    const snap = await getDocs(query(baseCol, ...clauses));
    const items = snap.docs.map((d) => ({ docId: d.id, ...d.data() }));
    return {
      items,
      lastDoc: snap.docs.at(-1) || null,
      hasMore: snap.size === pageSize,
    };
  }

  const seen = new Map();
  for (const name of names) {
    const q = query(baseCol, where("brand", "==", name), orderBy("brand"), orderBy("name"), limit(pageSize));
    const snap = await getDocs(q);
    snap.docs.forEach((d) => {
      if (!seen.has(d.id)) seen.set(d.id, { docId: d.id, ...d.data() });
    });
  }
  const items = [...seen.values()].sort(
    (a, b) =>
      String(a.brand).localeCompare(String(b.brand), "uk") ||
      String(a.name).localeCompare(String(b.name), "uk")
  );
  return { items, lastDoc: null, hasMore: false };
}
