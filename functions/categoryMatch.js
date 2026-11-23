/**
 * Зіставлення категорій від моделі з довідником.
 * Назви на кшталт «Моторні оливи» в довіднику можуть містити нерозривний пробіл,
 * а модель повертає звичайний — без нормалізації така категорія відкидалась.
 */

function categoryMatchKey(value) {
  return String(value || "")
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function coerceCategoryNames(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (item && typeof item === "object") {
        return coerceCategoryNames(item.name || item.category || "");
      }
      return coerceCategoryNames(item);
    });
  }
  if (typeof value === "string") {
    return value
      .split(/[,;|\n]/)
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return [];
}

function matchAllowedCategories(raw, allowedCategories, maxItems = 3) {
  const byKey = new Map();
  for (const name of allowedCategories || []) {
    const key = categoryMatchKey(name);
    if (key && !byKey.has(key)) byKey.set(key, name);
  }

  const picked = [];
  const rejected = [];
  const seen = new Set();
  for (const name of coerceCategoryNames(raw)) {
    const canonical = byKey.get(categoryMatchKey(name));
    if (!canonical) {
      if (rejected.length < 8) rejected.push(String(name).slice(0, 120));
      continue;
    }
    const key = categoryMatchKey(canonical);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(canonical);
    if (picked.length >= maxItems) break;
  }
  return { picked, rejected };
}

module.exports = {
  categoryMatchKey,
  coerceCategoryNames,
  matchAllowedCategories,
};
