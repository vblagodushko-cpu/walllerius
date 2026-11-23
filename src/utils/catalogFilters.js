import { PACK_BUCKETS, packMatchesBucket } from "./packFilter.js";
import { TOLERANCE_FILTER_PROFILES, expandToleranceFilterTag } from "./tolerances.js";
import { VISCOSITY_FILTER_PROFILES } from "./viscosities.js";

export function splitTag(tag) {
  const raw = String(tag || "").trim().toUpperCase();
  const index = raw.indexOf(":");
  if (index <= 0) return { system: "", code: "" };
  return { system: raw.slice(0, index), code: raw.slice(index + 1) };
}

function hasTag(tags, wanted) {
  const needle = String(wanted || "").trim().toUpperCase();
  if (!needle) return true;
  return hasAnyTag(tags, [needle]);
}

function hasAnyTag(tags, wanted) {
  const needles = (Array.isArray(wanted) ? wanted : []).map((tag) => String(tag || "").trim().toUpperCase()).filter(Boolean);
  if (!needles.length) return true;
  const have = new Set((Array.isArray(tags) ? tags : []).map((tag) => String(tag || "").trim().toUpperCase()));
  return needles.some((tag) => have.has(tag));
}

/** Точний збіг фасовки і тегів. Порожній фільтр нічого не відсікає. */
export function productMatchesCatalogFilters(product, filters = {}) {
  if (!packMatchesBucket(product?.pack, filters.packBucket || "")) return false;
  if (filters.viscosityTag && !hasTag(product?.viscosityTags, filters.viscosityTag)) return false;
  if (filters.toleranceTag && !hasAnyTag(product?.toleranceTags, expandToleranceFilterTag(filters.toleranceTag))) return false;
  return true;
}

export function catalogFilterCount(filters = {}) {
  return [filters.packBucket, filters.viscosityTag, filters.toleranceTag].filter(Boolean).length;
}

export function packFilterChipLabel(bucketId) {
  return PACK_BUCKETS.find((item) => item.id === bucketId)?.label || "";
}

export function viscosityFilterChipLabel(tag) {
  const { system, code } = splitTag(tag);
  if (!code) return "";
  if (system === "SAE") return code;
  if (system === "ISO") return `ISO VG ${code}`;
  return `${system} ${code}`;
}

export function toleranceFilterChipLabel(tag) {
  const { system, code } = splitTag(tag);
  if (!system || !code) return "";
  return `${system} ${code}`;
}

/** null — категорію не обрано, показуємо всі системи. */
export function viscosityProfileIds(category) {
  return profileIds(VISCOSITY_FILTER_PROFILES, category);
}

export function toleranceProfileIds(category) {
  return profileIds(TOLERANCE_FILTER_PROFILES, category);
}

function profileIds(profiles, category) {
  const name = String(category || "").trim();
  if (!name || !Object.prototype.hasOwnProperty.call(profiles, name)) return null;
  return profiles[name];
}

export function systemsForFilter(systemsMap, preferredIds, { expanded = false, activeSystem = "" } = {}) {
  const known = Object.keys(systemsMap);
  const preferred = (Array.isArray(preferredIds) ? preferredIds : []).filter((id) => systemsMap[id]);
  const pinned = activeSystem && systemsMap[activeSystem] ? [activeSystem] : [];
  const head = [];
  preferred.forEach((id) => { if (!head.includes(id)) head.push(id); });
  pinned.forEach((id) => { if (!head.includes(id)) head.push(id); });

  if (!preferred.length || expanded) {
    const rest = known.filter((id) => !head.includes(id));
    return { systems: [...head, ...rest], hasMore: false };
  }

  return {
    systems: head,
    hasMore: known.some((id) => !head.includes(id)),
  };
}
