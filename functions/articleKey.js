/**
 * Ключ порівняння артикула: без пробілів, дефісів і крапок.
 * Збережений id товару не змінюється.
 */
function compactArticle(value) {
  return String(value ?? "")
    .trim()
    .slice(0, 200)
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^\w.-]/g, "")
    .replace(/[.-]/g, "");
}

function articleSearchKeys(value) {
  const normalized = String(value ?? "")
    .trim()
    .slice(0, 200)
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^\w.-]/g, "");
  const compact = normalized.replace(/[.-]/g, "");
  return [...new Set([normalized, compact].filter(Boolean))];
}

module.exports = { compactArticle, articleSearchKeys };
