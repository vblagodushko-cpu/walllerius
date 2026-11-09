/**
 * Злиття дублікатів products, що відрізняються лише регістром бренду в docId
 * (напр. Victor_Reinz-70-31414-20 -> VICTOR_REINZ-70-31414-20).
 *
 * Що робить для кожної пари (live <- stale):
 *  - переносить у live свіжі (<=14 днів) офери постачальників, яких там немає
 *    (офер «Мій склад» зі stale та застарілі офери не переносяться, але лишаються в бекапі);
 *  - переносить details/main (фото, опис), якщо в live його немає;
 *  - докидає порожні поля (categories/pack/tolerances/synonyms/...) зі stale;
 *  - перепідв'язує supplierProducts і featuredProducts на live docId;
 *  - видаляє stale (+ details/main).
 *
 * Запуск (за замовчуванням dry-run, нічого не пише; потрібен ADC):
 *   node tools/mergeDuplicateProducts.cjs
 *   node tools/mergeDuplicateProducts.cjs --apply
 * Перед --apply пише бекап у tools/merge_backup_<ts>.json.
 */
const fs = require("fs");
const path = require("path");
const admin = require("../functions/node_modules/firebase-admin");

const APP_ID = process.env.APP_ID || "embryo-project";
const APPLY = process.argv.includes("--apply");

admin.initializeApp({ projectId: APP_ID });
const db = admin.firestore();
const B = `/artifacts/${APP_ID}/public/data`;

// stale -> live (live = актуальний docId, який пише агент)
const PAIRS = [
  ["Victor_Reinz-70-31414-20", "VICTOR_REINZ-70-31414-20"],
  ["Victor_Reinz-70-31414-10", "VICTOR_REINZ-70-31414-10"],
];

const FILL_IF_EMPTY = [
  "categories", "pack", "tolerances", "toleranceTags", "toleranceGroups",
  "viscosities", "viscosityTags", "viscosityGroups", "synonyms",
];
const isEmpty = (v) =>
  v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

const tsMs = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : 0);
const OFFER_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

async function snapshotDoc(ref) {
  const s = await ref.get();
  return s.exists ? s.data() : null;
}

async function main() {
  const backup = { createdAt: new Date().toISOString(), pairs: [] };
  const plans = [];

  for (const [staleId, liveId] of PAIRS) {
    const staleRef = db.doc(`${B}/products/${staleId}`);
    const liveRef = db.doc(`${B}/products/${liveId}`);
    const [stale, live] = await Promise.all([snapshotDoc(staleRef), snapshotDoc(liveRef)]);
    if (!stale || !live) {
      console.log(`SKIP ${staleId} -> ${liveId}: ${!stale ? "stale відсутній" : "live відсутній"}`);
      continue;
    }

    const staleDetails = await snapshotDoc(staleRef.collection("details").doc("main"));
    const liveDetails = await snapshotDoc(liveRef.collection("details").doc("main"));
    const spStale = await db.collection(`${B}/supplierProducts`).where("productDocId", "==", staleId).get();
    const featuredSnap = await db.doc(`${B}/featuredProducts/main`).get();
    const featured = featuredSnap.exists ? featuredSnap.data() : null;

    backup.pairs.push({
      staleId, liveId, stale, live, staleDetails, liveDetails,
      supplierProducts: spStale.docs.map((d) => ({ id: d.id, data: d.data() })),
      featuredItems: featured ? (featured.items || []).filter((i) => i.docId === staleId) : [],
    });

    // --- офери ---
    const liveOffers = Array.isArray(live.offers) ? [...live.offers] : [];
    const added = [];
    const dropped = [];
    for (const o of stale.offers || []) {
      if (o.supplier === "Мій склад") continue; // живий — у live
      // Прайси постачальників оновлюються щодня: офер, не оновлений >14 днів, - привид, не переносимо
      if (Date.now() - tsMs(o.updatedAt) > OFFER_MAX_AGE_MS) {
        dropped.push(o.supplier);
        continue;
      }
      const idx = liveOffers.findIndex((x) => x.supplier === o.supplier);
      if (idx < 0) {
        liveOffers.push(o);
        added.push(o.supplier);
      } else if (tsMs(o.updatedAt) > tsMs(liveOffers[idx].updatedAt)) {
        liveOffers[idx] = o;
        added.push(`${o.supplier}(новіший)`);
      }
    }

    // --- поля ---
    const patch = {};
    for (const f of FILL_IF_EMPTY) {
      if (isEmpty(live[f]) && !isEmpty(stale[f])) patch[f] = stale[f];
    }
    if (added.length) patch.offers = liveOffers;

    const moveDetails = !!staleDetails && !liveDetails;
    plans.push({ staleId, liveId, staleRef, liveRef, patch, added, staleDetails, moveDetails, spStale, featured });

    console.log(`\n=== ${staleId} -> ${liveId}`);
    console.log("  офери додати в live:", added.join(", ") || "-");
    console.log("  офери-привиди (не переношу, лише в бекапі):", dropped.join(", ") || "-");
    console.log("  поля з stale:", Object.keys(patch).filter((k) => k !== "offers").join(", ") || "-");
    console.log("  details/main:", moveDetails ? "перенести" : staleDetails ? "live вже має - лишаю live, stale прибираю" : "немає");
    console.log("  supplierProducts перепідв'язати:", spStale.docs.map((d) => d.id).join("; ") || "-");
    console.log("  featured:", backup.pairs[backup.pairs.length - 1].featuredItems.length ? "так" : "ні");
  }

  if (!APPLY) {
    console.log("\nDRY-RUN: нічого не записано. Для запису: --apply");
    return;
  }

  const bk = path.join(__dirname, `merge_backup_${Date.now()}.json`);
  fs.writeFileSync(bk, JSON.stringify(backup, null, 2), "utf8");
  console.log("\nБекап:", bk);

  for (const p of plans) {
    const batch = db.batch();

    if (Object.keys(p.patch).length) {
      batch.set(p.liveRef, { ...p.patch, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    }
    if (p.moveDetails) {
      batch.set(p.liveRef.collection("details").doc("main"), p.staleDetails);
    }

    // supplierProducts: новий документ (supplier-live) + видалення старого
    for (const d of p.spStale.docs) {
      const data = d.data();
      const newId = `${data.supplier}-${p.liveId}`;
      // «Мій склад» уже існує для live - лише прибираємо старий.
      // Зв'язок створюємо лише якщо відповідний офер реально є в live (без «висячих» зв'язків).
      const liveHasOffer = (p.patch.offers || []).some((o) => o.supplier === data.supplier);
      if (data.supplier !== "Мій склад" && liveHasOffer) {
        batch.set(db.doc(`${B}/supplierProducts/${newId}`), {
          ...data,
          productDocId: p.liveId,
          productKey: p.liveId,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      batch.delete(d.ref);
    }

    // featuredProducts
    if (p.featured && (p.featured.items || []).some((i) => i.docId === p.staleId)) {
      const items = p.featured.items.map((i) => (i.docId === p.staleId ? { ...i, docId: p.liveId } : i));
      batch.set(db.doc(`${B}/featuredProducts/main`), { items }, { merge: true });
    }

    batch.delete(p.staleRef.collection("details").doc("main"));
    batch.delete(p.staleRef);
    await batch.commit();
    console.log(`OK ${p.staleId} -> ${p.liveId}`);
  }
  console.log("Готово.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
