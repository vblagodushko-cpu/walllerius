/**
 * Синонім артикула — інше написання того самого номера.
 * Лишаємо лише коди, які вже є у назві товару або в тексті джерела.
 */

function normalizeArticleCode(value) {
  return String(value ?? "")
    .trim()
    .slice(0, 200)
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^\w.-]/g, "");
}

function looksLikeSpecNotArticle(code) {
  return /^(?:\d{1,2}W-?\d{2}|SAE\d{1,2}W-?\d{2}|ISOVG\d{2,3}|DOT\d|\d+(?:ML|L))$/.test(code);
}

function collectAttestedArticles(texts) {
  const found = new Set();
  for (const text of texts || []) {
    const parts = String(text || "").split(/[^A-Za-z0-9.\-]+/);
    for (const part of parts) {
      const code = normalizeArticleCode(part);
      if (code.length >= 4) found.add(code);
    }
  }
  return found;
}

function coerceSynonymList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(/[,;\n]/);
  return [];
}

function filterKnownSynonyms(raw, canonicalArticle, texts, maxItems = 20) {
  const canonical = normalizeArticleCode(canonicalArticle);
  const attested = collectAttestedArticles(texts);
  const kept = [];
  const rejected = [];
  const seen = new Set();

  for (const item of coerceSynonymList(raw)) {
    const code = normalizeArticleCode(item);
    if (!code || code === canonical || code.length < 4 || looksLikeSpecNotArticle(code) || !attested.has(code)) {
      if (rejected.length < 12 && String(item || "").trim()) rejected.push(String(item).slice(0, 80));
      continue;
    }
    if (seen.has(code)) continue;
    seen.add(code);
    kept.push(code);
    if (kept.length >= maxItems) break;
  }

  return { kept, rejected };
}

module.exports = {
  normalizeArticleCode,
  looksLikeSpecNotArticle,
  collectAttestedArticles,
  filterKnownSynonyms,
};
