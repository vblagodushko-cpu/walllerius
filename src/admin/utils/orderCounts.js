import {
  collection,
  doc,
  getCountFromServer,
  getDocs,
  limit,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "../../firebase-config";

const appId = import.meta.env.VITE_PROJECT_ID;

function ordersCol() {
  return collection(db, `/artifacts/${appId}/public/data/orders`);
}

function countsRef() {
  return doc(db, `/artifacts/${appId}/public/meta/counters/orderCounts`);
}

/** Старі замовлення без поля archived не потрапляють у where(archived==false). */
async function backfillMissingArchived(status) {
  const snap = await getDocs(
    query(ordersCol(), where("status", "==", status), orderBy("createdAt", "desc"), limit(100))
  );
  const fixes = [];
  for (const row of snap.docs) {
    if (row.data().archived === undefined) {
      fixes.push(updateDoc(row.ref, { archived: false }));
    }
  }
  if (fixes.length) await Promise.all(fixes);
  return fixes.length;
}

export async function recountOrderBadges() {
  if (!appId) return { new: 0, partial: 0 };

  await Promise.all([
    backfillMissingArchived("Нове"),
    backfillMissingArchived("Частково виконано"),
  ]);

  const [newSnap, partialSnap] = await Promise.all([
    getCountFromServer(
      query(ordersCol(), where("status", "==", "Нове"), where("archived", "==", false))
    ),
    getCountFromServer(
      query(
        ordersCol(),
        where("status", "==", "Частково виконано"),
        where("archived", "==", false)
      )
    ),
  ]);

  const next = {
    new: Number(newSnap.data().count) || 0,
    partial: Number(partialSnap.data().count) || 0,
    lastUpdated: new Date(),
  };

  await setDoc(countsRef(), next, { merge: true });
  return { new: next.new, partial: next.partial };
}
