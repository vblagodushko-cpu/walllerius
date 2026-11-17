import { collection, getDocs, limit, query, where } from "firebase/firestore";
import { db } from "../firebase-config";

function brandKey(value) {
  return String(value ?? "").replace(/[\s\u00A0]+/g, " ").trim().toLowerCase();
}

export function normalizeArticle(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^\w.-]/g, "");
}

/** Майстер-картка за брендом і артикулом. Клієнт має право читати productMasterData. */
export async function lookupProductMaster(appId, brand, id) {
  const article = normalizeArticle(id);
  if (!appId || !article) return null;
  const snap = await getDocs(
    query(
      collection(db, `/artifacts/${appId}/public/data/productMasterData`),
      where("id", "==", article),
      limit(20)
    )
  );
  const key = brandKey(brand);
  const hit = snap.docs.find((docSnap) => brandKey(docSnap.data()?.brand) === key);
  return hit ? hit.data() || null : null;
}
