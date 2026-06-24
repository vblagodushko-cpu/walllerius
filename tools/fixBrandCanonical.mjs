/**
 * Уніфікація написання бренду в products + brandSynonyms.
 * Usage: node tools/fixBrandCanonical.mjs "VICTOR REINZ" [--dry-run]
 */
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const APP_ID = process.env.APP_ID || "embryo-project";
const CHUNK = 450;

const canonical = process.argv[2];
const dryRun = process.argv.includes("--dry-run");

if (!canonical) {
  console.error('Usage: node tools/fixBrandCanonical.mjs "VICTOR REINZ" [--dry-run]');
  process.exit(1);
}

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

const productsCol = db.collection(`/artifacts/${APP_ID}/public/data/products`);
const synonymsCol = db.collection(`/artifacts/${APP_ID}/public/data/brandSynonyms`);
const brandsCol = db.collection(`/artifacts/${APP_ID}/public/meta/brands`);

function normKey(v) {
  return String(v || "")
    .replace(/[\s\u00A0]+/g, " ")
    .trim()
    .toLowerCase();
}

function safeDocId(v) {
  return normKey(v).replace(/\//g, "-").replace(/[.#$[\]]/g, "-").replace(/-+/g, "-").slice(0, 150);
}

async function scanBrandVariants() {
  const targetKey = normKey(canonical);
  const variants = new Set();
  let lastDoc = null;

  while (true) {
    let q = productsCol.select("brand", "id").orderBy("brand").limit(1000);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;

    for (const d of snap.docs) {
      const b = String(d.get("brand") || "").replace(/\s{2,}/g, " ").trim();
      if (!b) continue;
      if (normKey(b) === targetKey) variants.add(b);
    }

    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < 1000) break;
  }

  return Array.from(variants).sort();
}

async function rewriteProducts(variants) {
  let updated = 0;
  for (const oldBrand of variants) {
    if (oldBrand === canonical) continue;
    let lastDoc = null;
    while (true) {
      let q = productsCol.where("brand", "==", oldBrand).limit(500);
      if (lastDoc) q = q.startAfter(lastDoc);
      const snap = await q.get();
      if (snap.empty) break;

      if (!dryRun) {
        const batch = db.batch();
        snap.docs.forEach((d) => batch.update(d.ref, { brand: canonical }));
        await batch.commit();
      }
      updated += snap.size;
      lastDoc = snap.docs[snap.docs.length - 1];
      if (snap.size < 500) break;
    }
  }
  return updated;
}

async function upsertSynonyms(variants) {
  const all = new Set([canonical, ...variants]);
  let written = 0;
  if (dryRun) return all.size;

  let batch = db.batch();
  let ops = 0;
  for (const v of all) {
    const id = safeDocId(v);
    batch.set(synonymsCol.doc(id), { old: v, canonical }, { merge: true });
    ops++;
    written++;
    if (ops >= CHUNK) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();
  return written;
}

async function rebuildBrandsCache() {
  const variantsMap = new Map();
  let lastDoc = null;

  while (true) {
    let q = productsCol.select("brand").orderBy("brand").limit(1000);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;

    snap.docs.forEach((d) => {
      const b = String(d.get("brand") || "").replace(/\s{2,}/g, " ").trim();
      if (!b) return;
      const key = normKey(b);
      if (!variantsMap.has(key)) variantsMap.set(key, new Set());
      variantsMap.get(key).add(b);
    });

    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < 1000) break;
  }

  if (!dryRun) {
    while (true) {
      const snap = await brandsCol.limit(CHUNK).get();
      if (snap.empty) break;
      const batch = db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }

  let written = 0;
  if (!dryRun) {
    let batch = db.batch();
    let ops = 0;
    for (const [lc, setVar] of variantsMap.entries()) {
      const arr = Array.from(setVar.values()).sort();
      const docRef = brandsCol.doc(lc.replace(/\//g, "-").replace(/[.#$[\]]/g, "-").replace(/-+/g, "-").slice(0, 150));
      batch.set(
        docRef,
        { name: arr[0], canonical: arr[0], variants: arr, updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
      ops++;
      written++;
      if (ops >= CHUNK) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }
    if (ops > 0) await batch.commit();
  } else {
    written = variantsMap.size;
  }

  return { written, victor: variantsMap.get(normKey(canonical)) };
}

async function findArticleDuplicates() {
  const byArticle = new Map();
  let lastDoc = null;
  const targetKey = normKey(canonical);

  while (true) {
    let q = productsCol.select("brand", "id").orderBy("brand").limit(1000);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;

    for (const d of snap.docs) {
      const b = String(d.get("brand") || "");
      if (normKey(b) !== targetKey) continue;
      const article = String(d.get("id") || "").trim();
      if (!article) continue;
      if (!byArticle.has(article)) byArticle.set(article, []);
      byArticle.get(article).push({ docId: d.id, brand: b });
    }

    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < 1000) break;
  }

  return [...byArticle.entries()].filter(([, docs]) => docs.length > 1);
}

async function main() {
  console.log(`Canonical: "${canonical}"`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "APPLY"}\n`);

  const variants = await scanBrandVariants();
  console.log("Brand variants in products:", variants);

  const synonyms = await upsertSynonyms(variants);
  console.log(`Synonyms ${dryRun ? "would write" : "written"}: ${synonyms}`);

  const updated = await rewriteProducts(variants);
  console.log(`Products ${dryRun ? "would update" : "updated"}: ${updated}`);

  const cache = await rebuildBrandsCache();
  console.log(`Brands cache ${dryRun ? "would write" : "written"}: ${cache.written} entries`);
  if (cache.victor) console.log("Victor group after fix:", [...cache.victor]);

  const dupArticles = await findArticleDuplicates();
  if (dupArticles.length) {
    console.log("\n⚠ Duplicate articles (same id, multiple docIds) — manual merge may be needed:");
    dupArticles.slice(0, 20).forEach(([article, docs]) => {
      console.log(`  ${article}:`, docs.map((x) => `${x.docId} (${x.brand})`).join(", "));
    });
    if (dupArticles.length > 20) console.log(`  ... and ${dupArticles.length - 20} more`);
  } else {
    console.log("\n✓ No duplicate articles for this brand key");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
