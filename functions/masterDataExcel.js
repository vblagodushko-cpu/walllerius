/**
 * Експорт / імпорт майстер-даних для Excel (Дані › Майстер-дані).
 * Парсинг toleranceTags / viscosityTags, синк products + details/main.body.
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const { getFirestore, FieldValue, FieldPath } = require("firebase-admin/firestore");

const db = getFirestore();
const REGION = process.env.FUNCTION_REGION || "europe-central2";
const APP_ID = process.env.APP_ID || "embryo-project";
const MAX_DETAIL_BODY = 80000;
const IMPORT_BATCH = 80;

const productsCol = () => db.collection(`/artifacts/${APP_ID}/public/data/products`);
const masterCol = () => db.collection(`/artifacts/${APP_ID}/public/data/productMasterData`);

function str(value, maxLen = 500) {
  const s = value == null ? "" : String(value);
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function cleanList(value, maxItems = 80, maxLen = 120) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value
    .map((item) => str(item, maxLen))
    .filter(Boolean)
    .filter((item) => {
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxItems);
}

function splitCsvList(value) {
  return String(value || "")
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function buildProductDocIdIndex() {
  const {
    normalizeArticle,
    normalizeBrandKey,
  } = require("./shared");
  const index = new Map();
  let lastDoc = null;
  const PAGE = 500;

  while (true) {
    let q = productsCol().orderBy(FieldPath.documentId()).limit(PAGE);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;

    snap.docs.forEach((docSnap) => {
      const p = docSnap.data() || {};
      const brand = str(p.brand, 120).replace(/\s{2,}/g, " ").trim();
      const article = normalizeArticle(p.id);
      if (!brand || !article) return;
      const key = `${normalizeBrandKey(brand)}__${article}`;
      if (!index.has(key)) index.set(key, docSnap.id);
    });

    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < PAGE) break;
  }

  return index;
}

async function fetchDetailBodies(docIds) {
  const bodies = new Map();
  const unique = [...new Set(docIds.filter(Boolean))];
  const CHUNK = 100;

  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const refs = chunk.map((id) =>
      productsCol().doc(id).collection("details").doc("main")
    );
    const snaps = await db.getAll(...refs);
    snaps.forEach((snap, idx) => {
      if (!snap.exists) return;
      const body = str(snap.data()?.body || "", MAX_DETAIL_BODY);
      if (body) bodies.set(chunk[idx], body);
    });
  }

  return bodies;
}

function buildMasterPayload(record, uid) {
  const {
    normalizeArticle,
    normalizePack,
  } = require("./shared");
  const {
    parseToleranceTags,
    normalizeToleranceTags,
    toleranceGroupsFromTags,
  } = require("./shared/tolerances");
  const {
    parseViscosityTags,
    normalizeViscosityTags,
    viscosityGroupsFromTags,
  } = require("./shared/viscosities");

  const brand = str(record.brand, 120).replace(/\s{2,}/g, " ").trim();
  const id = normalizeArticle(record.id);
  const safeCorrectName = str(record.correctName, 500);
  const safeCategories = cleanList(record.categories, 50, 120);
  const safePack = normalizePack(record.pack);
  const safeTolerances = str(record.tolerances, 500);
  const safeViscosities = str(record.viscosities, 500);
  const safeSynonyms = cleanList(record.synonyms, 100, 120).map(normalizeArticle).filter(Boolean);

  const explicitToleranceTags = normalizeToleranceTags(record.toleranceTags);
  const safeToleranceTags = explicitToleranceTags.length
    ? explicitToleranceTags
    : parseToleranceTags(safeTolerances);
  const explicitViscosityTags = normalizeViscosityTags(record.viscosityTags);
  const safeViscosityTags = explicitViscosityTags.length
    ? explicitViscosityTags
    : parseViscosityTags(safeViscosities);

  const detailBody = str(record.detailBody, MAX_DETAIL_BODY);

  return {
    brand,
    id,
    masterPayload: {
      brand,
      id,
      correctName: safeCorrectName,
      categories: safeCategories,
      pack: safePack,
      tolerances: safeTolerances,
      toleranceTags: safeToleranceTags,
      toleranceGroups: toleranceGroupsFromTags(safeToleranceTags),
      viscosities: safeViscosities,
      viscosityTags: safeViscosityTags,
      viscosityGroups: viscosityGroupsFromTags(safeViscosityTags),
      synonyms: safeSynonyms,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: uid,
    },
    productPayload: {
      categories: safeCategories,
      pack: safePack,
      tolerances: safeTolerances,
      toleranceTags: safeToleranceTags,
      toleranceGroups: toleranceGroupsFromTags(safeToleranceTags),
      viscosities: safeViscosities,
      viscosityTags: safeViscosityTags,
      viscosityGroups: viscosityGroupsFromTags(safeViscosityTags),
      synonyms: safeSynonyms,
      masterDataUpdatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      ...(safeCorrectName ? { name: safeCorrectName } : {}),
    },
    detailBody,
  };
}

async function resolveMasterDocId(brand, id) {
  const {
    resolveProductMasterFirestoreId,
    defaultProductMasterDocId,
  } = require("./shared");
  const resolved = await resolveProductMasterFirestoreId(brand, id);
  return resolved?.firestoreId ?? defaultProductMasterDocId(brand, id);
}

exports.exportProductMasterDataForExcel = onCall({ region: REGION, cors: true }, async (request) => {
  if (!request.auth?.token?.admin) {
    throw new HttpsError("permission-denied", "Потрібен адмін-доступ.");
  }

  const { normalizeArticle, normalizeBrandKey } = require("./shared");

  const masterSnap = await masterCol().get();
  if (masterSnap.empty) {
    return { success: true, rows: [], productIndexReads: 0 };
  }

  const productIndex = await buildProductDocIdIndex();
  const docIds = masterSnap.docs.map((docSnap) => {
    const r = docSnap.data() || {};
    const brand = str(r.brand, 120).replace(/\s{2,}/g, " ").trim();
    const article = normalizeArticle(r.id);
    const key = `${normalizeBrandKey(brand)}__${article}`;
    return productIndex.get(key) || null;
  });
  const detailBodies = await fetchDetailBodies(docIds);

  const formatTags = (tags) =>
    Array.isArray(tags) && tags.length ? tags.join(", ") : "";

  const rows = masterSnap.docs.map((docSnap, idx) => {
    const r = docSnap.data() || {};
    const productDocId = docIds[idx];
    return {
      brand: r.brand ?? "",
      id: r.id ?? "",
      correctName: r.correctName ?? "",
      categories: Array.isArray(r.categories) ? r.categories : [],
      pack: r.pack ?? "",
      tolerances: r.tolerances ?? "",
      toleranceTags: r.toleranceTags ?? [],
      viscosities: r.viscosities ?? "",
      viscosityTags: r.viscosityTags ?? [],
      synonyms: Array.isArray(r.synonyms) ? r.synonyms : [],
      detailBody: productDocId ? detailBodies.get(productDocId) || "" : "",
    };
  });

  logger.info("exportProductMasterDataForExcel", {
    uid: request.auth.uid,
    masterCount: rows.length,
    productIndexSize: productIndex.size,
  });

  return {
    success: true,
    rows: rows.map((r) => ({
      ...r,
      categories: r.categories.join(", "),
      synonyms: r.synonyms.join(", "),
      toleranceTags: formatTags(r.toleranceTags),
      viscosityTags: formatTags(r.viscosityTags),
    })),
  };
});

exports.bulkImportProductMasterData = onCall({ region: REGION, cors: true }, async (request) => {
  if (!request.auth?.token?.admin) {
    throw new HttpsError("permission-denied", "Потрібен адмін-доступ.");
  }

  const { records, mode } = request.data || {};
  const importMode = mode === "strict" ? "strict" : "partial";

  if (!Array.isArray(records) || !records.length) {
    throw new HttpsError("invalid-argument", "records обов'язковий непорожній масив.");
  }
  if (records.length > 5000) {
    throw new HttpsError("invalid-argument", "Максимум 5000 записів за один імпорт.");
  }

  const {
    normalizeArticle,
    normalizeBrandKey,
    clearMasterDataCache,
  } = require("./shared");

  const productIndex = await buildProductDocIdIndex();
  const seenMasterDocIds = new Set();
  let imported = 0;
  let syncedProducts = 0;
  let syncedDetails = 0;
  let skipped = 0;
  const errors = [];

  for (let i = 0; i < records.length; i += IMPORT_BATCH) {
    const chunk = records.slice(i, i + IMPORT_BATCH);
    let batch = db.batch();
    let ops = 0;

    const flushBatch = async () => {
      if (ops <= 0) return;
      await batch.commit();
      batch = db.batch();
      ops = 0;
    };

    for (const raw of chunk) {
      try {
        const built = buildMasterPayload(raw, request.auth.uid);
        if (!built.brand || !built.id) {
          skipped += 1;
          continue;
        }

        const masterDocId = await resolveMasterDocId(built.brand, built.id);
        seenMasterDocIds.add(masterDocId);
        batch.set(masterCol().doc(masterDocId), built.masterPayload, { merge: true });
        ops += 1;
        imported += 1;

        const productKey = `${normalizeBrandKey(built.brand)}__${built.id}`;
        const productDocId = productIndex.get(productKey);
        if (productDocId) {
          batch.set(productsCol().doc(productDocId), built.productPayload, { merge: true });
          ops += 1;
          syncedProducts += 1;

          if (built.detailBody.trim()) {
            batch.set(
              productsCol().doc(productDocId).collection("details").doc("main"),
              {
                body: built.detailBody,
                updatedAt: FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
            ops += 1;
            syncedDetails += 1;
          }
        }

        if (ops >= 450) await flushBatch();
      } catch (e) {
        skipped += 1;
        errors.push({ index: i, message: String(e.message || e) });
      }
    }

    await flushBatch();
  }

  let deleted = 0;
  if (importMode === "strict" && seenMasterDocIds.size > 0) {
    const masterSnap = await masterCol().get();
    let deleteBatch = db.batch();
    let deleteOps = 0;
    for (const docSnap of masterSnap.docs) {
      if (seenMasterDocIds.has(docSnap.id)) continue;
      deleteBatch.delete(docSnap.ref);
      deleteOps += 1;
      deleted += 1;
      if (deleteOps >= 450) {
        await deleteBatch.commit();
        deleteBatch = db.batch();
        deleteOps = 0;
      }
    }
    if (deleteOps > 0) await deleteBatch.commit();
  }

  clearMasterDataCache();

  logger.info("bulkImportProductMasterData", {
    uid: request.auth.uid,
    mode: importMode,
    imported,
    syncedProducts,
    syncedDetails,
    deleted,
    skipped,
    errors: errors.length,
  });

  return {
    success: true,
    mode: importMode,
    imported,
    syncedProducts,
    syncedDetails,
    deleted,
    skipped,
    errors: errors.slice(0, 20),
  };
});
