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

function nameTokens(value) {
  return String(value ?? "")
    .toLowerCase()
    .split(/[^a-z0-9а-яіїєґ]+/i)
    .map((token) => token.replace(/[.-]/g, ""))
    .filter((token) => token.length >= 2);
}

function nameMatches(name, tokens) {
  const parts = nameTokens(name);
  const compactName = compactArticle(name).toLowerCase();
  return tokens.every((token) => parts.some((part) => part.includes(token)) || compactName.includes(token));
}

function suggestMasterCards(cards, query, limit = 8) {
  const q = String(query ?? "").trim();
  if (q.length < 2) return [];
  const compactQ = compactArticle(q);
  const tokens = nameTokens(q);
  const hits = [];

  for (const card of cards || []) {
    const id = String(card?.id || "").trim();
    if (!id) continue;
    const idCompact = compactArticle(id);
    const synonyms = Array.isArray(card?.synonyms) ? card.synonyms : [];
    let rank = null;
    let via = "";
    if (compactQ.length >= 2 && idCompact.startsWith(compactQ)) {
      rank = idCompact === compactQ ? 0 : 1;
      via = "article";
    } else if (compactQ.length >= 2 && synonyms.some((syn) => compactArticle(syn).startsWith(compactQ))) {
      rank = 2;
      via = "synonym";
    } else if (tokens.length && nameMatches(card?.correctName, tokens)) {
      rank = 3;
      via = "name";
    }
    if (rank == null) continue;
    hits.push({
      brand: String(card?.brand || "").trim(),
      id,
      correctName: String(card?.correctName || "").trim(),
      via,
      rank,
      size: idCompact.length,
    });
  }

  hits.sort((a, b) => a.rank - b.rank || a.size - b.size || a.id.localeCompare(b.id));
  return hits.slice(0, limit).map(({ brand, id, correctName, via }) => ({ brand, id, correctName, via }));
}

module.exports = { compactArticle, articleSearchKeys, suggestMasterCards };
