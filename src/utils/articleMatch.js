export function compactArticle(value) {
  return String(value ?? "")
    .trim()
    .slice(0, 200)
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^\w.-]/g, "")
    .replace(/[.-]/g, "");
}

export function productHaystack(product) {
  return [
    product?.name,
    product?.id,
    product?.brand,
    product?.pack,
    product?.viscosities,
    product?.tolerances,
    ...(Array.isArray(product?.viscosityTags) ? product.viscosityTags : []),
    ...(Array.isArray(product?.toleranceTags) ? product.toleranceTags : []),
    ...(Array.isArray(product?.synonyms) ? product.synonyms : []),
  ].filter(Boolean).join(" ").toLowerCase();
}

export function productMatchesListQuery(product, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  if (productHaystack(product).includes(q)) return true;
  const needle = compactArticle(query);
  if (needle.length < 4) return false;
  const codes = [product?.id, ...(Array.isArray(product?.synonyms) ? product.synonyms : [])];
  return codes.some((code) => compactArticle(code) === needle);
}
