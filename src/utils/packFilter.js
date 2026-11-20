/** Комерційні діапазони фасовки для фільтра порталу. Межі включні. */

export const PACK_BUCKETS = [
  { id: "le-0.8", label: "≤0,8", title: "до 0,8 л", min: 0, max: 0.8, minExclusive: true },
  { id: "approx-1", label: "~1", title: "приблизно 1 л (0,8–1,2)", min: 0.8, max: 1.2 },
  { id: "approx-1.5", label: "~1,5", title: "приблизно 1,5 л (1,2–2)", min: 1.2, max: 2 },
  { id: "approx-4", label: "~4", title: "приблизно 4 л (3,8–4,2)", min: 3.8, max: 4.2 },
  { id: "approx-5", label: "~5", title: "приблизно 5 л (4,7–5,3)", min: 4.7, max: 5.3 },
  { id: "approx-6", label: "~6", title: "приблизно 6 л (5,5–6,5)", min: 5.5, max: 6.5 },
  { id: "approx-10", label: "~10", title: "приблизно 10 л (9–11)", min: 9, max: 11 },
  { id: "approx-20", label: "~20", title: "приблизно 20 л (17–23)", min: 17, max: 23 },
  { id: "range-50-65", label: "50–65", title: "приблизно 50–65 л", min: 50, max: 65 },
  { id: "approx-200", label: "~200", title: "приблизно 200 л (170–230)", min: 170, max: 230 },
];

function parsePositive(raw) {
  const n = parseFloat(String(raw).replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Літри з поля pack: «4», «0,2», «200 мл», «4л». Інакше null. */
export function parsePackLiters(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const compact = raw.replace(/\s+/g, "").toLowerCase();

  const mlCompact = compact.match(/^(\d+(?:[.,]\d+)?)(?:мл|ml)$/i);
  if (mlCompact) return parsePositive(mlCompact[1]) == null ? null : parsePositive(mlCompact[1]) / 1000;

  const literCompact = compact.match(/^(\d+(?:[.,]\d+)?)(?:л|l|літр|litre|liter)s?\.?$/i);
  if (literCompact) return parsePositive(literCompact[1]);

  const plain = compact.match(/^(\d+(?:[.,]\d+)?)$/);
  if (plain) return parsePositive(plain[1]);

  const embeddedMl = raw.match(/(\d+(?:[.,]\d+)?)\s*(?:мл|ml)\b/i);
  if (embeddedMl) {
    const n = parsePositive(embeddedMl[1]);
    return n == null ? null : n / 1000;
  }

  const embeddedLiter = raw.match(/(\d+(?:[.,]\d+)?)\s*(?:л|l|літр(?:а|ів)?)\b/i);
  if (embeddedLiter) return parsePositive(embeddedLiter[1]);

  return null;
}

export function packMatchesBucket(pack, bucketId) {
  if (!bucketId) return true;
  const bucket = PACK_BUCKETS.find((item) => item.id === bucketId);
  if (!bucket) return true;
  const liters = parsePackLiters(pack);
  if (liters == null) return false;
  const aboveMin = bucket.minExclusive ? liters > bucket.min : liters >= bucket.min;
  return aboveMin && liters <= bucket.max;
}
