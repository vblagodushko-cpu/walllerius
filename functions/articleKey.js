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

function phraseTokens(query) {
  const prepared = String(query ?? "")
    .toLowerCase()
    .replace(/(\d+)\s*w\s*-?\s*(\d+)/g, "$1w$2");
  return nameTokens(prepared);
}

function fieldFragments(value) {
  const raw = String(value ?? "").toLowerCase();
  if (!raw.trim()) return [];
  const prepared = raw.replace(/(\d+)\s*w\s*-?\s*(\d+)/g, "$1w$2");
  const out = new Set(nameTokens(prepared));
  const compact = prepared.replace(/[^a-z0-9а-яіїєґ]+/gi, "");
  if (compact.length >= 2) out.add(compact);
  for (const spec of prepared.match(/\d{3}\.\d{2}/g) || []) out.add(spec.slice(0, 3));
  return [...out];
}

function cardFragments(card) {
  const values = [
    card?.brand,
    card?.correctName,
    card?.id,
    card?.viscosities,
    card?.tolerances,
    card?.pack,
  ];
  for (const list of [card?.synonyms, card?.viscosityTags, card?.toleranceTags, card?.categories]) {
    if (Array.isArray(list)) values.push(...list);
  }
  return values.flatMap((value) => fieldFragments(value));
}

function tokenHits(token, fragments) {
  return fragments.some((fragment) => fragment === token || (token.length >= 3 && fragment.startsWith(token)));
}

function matchMasterPhrase(cards, query, options = {}) {
  const limit = typeof options === "number" ? options : (options.limit ?? 30);
  const offset = typeof options === "number" ? 0 : Math.max(0, options.offset || 0);
  const tokens = phraseTokens(query);
  if (!tokens.length) return { hits: [], total: 0 };
  const hits = [];
  for (const card of cards || []) {
    const id = String(card?.id || "").trim();
    if (!id) continue;
    const fragments = cardFragments(card);
    if (!tokens.every((token) => tokenHits(token, fragments))) continue;
    hits.push({
      brand: String(card?.brand || "").trim(),
      id,
      correctName: String(card?.correctName || "").trim(),
    });
  }
  hits.sort((a, b) => a.brand.localeCompare(b.brand) || a.id.localeCompare(b.id));
  return { hits: hits.slice(offset, offset + limit), total: hits.length };
}

module.exports = { compactArticle, articleSearchKeys, suggestMasterCards, matchMasterPhrase };
