const VISCOSITY_SYSTEMS = {
  SAE: {
    label: "SAE",
    aliases: ["SAE"],
    options: [
      "0W-8", "0W-12", "0W-16", "0W-20", "0W-30", "0W-40",
      "5W-20", "5W-30", "5W-40", "5W-50",
      "10W-30", "10W-40", "10W-50", "10W-60",
      "15W-40", "15W-50",
      "20W-50", "25W-50",
      "20", "30", "40", "50", "60",
      "70W", "70W-80", "75W", "75W-80", "75W-85", "75W-90", "80W-90", "85W-90", "85W-140",
      "90", "140",
    ],
    codePattern: /^(?:\d{1,2}W(?:-\d{2,3})?|\d{2,3})$/i,
  },
  ISO: {
    label: "ISO VG",
    aliases: ["ISO", "ISO VG", "VG"],
    options: ["2", "3", "5", "7", "10", "15", "22", "32", "46", "68", "100", "150", "220", "320", "460", "680", "1000"],
    codePattern: /^\d{1,4}$/i,
  },
};

const VISCOSITY_FILTER_PROFILES = {
  "Оливи моторні": ["SAE"],
  "Оливи трансмісійні": ["SAE"],
  "Гальмівні та гідравлічні рідини": ["ISO", "SAE"],
  "Охолоджуючі рідини": [],
};

function canonicalCode(system, rawCode) {
  let code = String(rawCode || "")
    .trim()
    .toUpperCase()
    .replace(/[()]/g, "")
    .replace(/\s+/g, "")
    .replace(/^VG/, "");

  if (system === "SAE") {
    const multi = code.match(/^(\d{1,2})W(\d{2,3})$/);
    if (multi) return `${multi[1]}W-${multi[2]}`;
    return code;
  }

  if (system === "ISO") {
    return code.replace(/^VG-?/, "").replace(/^ISO-?/, "");
  }

  return code;
}

function normalizeViscosityTag(value) {
  const match = String(value || "").trim().match(/^([A-Z0-9-]{2,16})\s*[:：]\s*(.+)$/i);
  if (!match) return null;
  const system = match[1].trim().toUpperCase();
  if (!VISCOSITY_SYSTEMS[system]) return null;
  const code = canonicalCode(system, match[2]);
  if (!isValidCode(system, code)) return null;
  return `${system}:${code}`;
}

function isValidCode(system, code) {
  const cfg = VISCOSITY_SYSTEMS[system];
  if (!cfg) return false;
  return cfg.options.includes(code) || cfg.codePattern.test(code);
}

function addTag(tags, system, rawCode) {
  const code = canonicalCode(system, rawCode);
  if (isValidCode(system, code)) tags.add(`${system}:${code}`);
}

function parseViscosityTags(input) {
  const tags = new Set();
  const text = String(input || "").toUpperCase();
  if (!text.trim()) return [];

  const explicitTagRe = /([A-Z0-9-]{2,16})\s*[:：]\s*([A-Z0-9.+/-]+)/gi;
  let tagMatch;
  while ((tagMatch = explicitTagRe.exec(text))) {
    const system = tagMatch[1].toUpperCase();
    if (VISCOSITY_SYSTEMS[system]) addTag(tags, system, tagMatch[2]);
  }

  const saeMultiRe = /\b(\d{1,2})\s*W\s*-?\s*(\d{2,3})\b/g;
  let saeMatch;
  while ((saeMatch = saeMultiRe.exec(text))) {
    addTag(tags, "SAE", `${saeMatch[1]}W-${saeMatch[2]}`);
  }

  const saeMonoWRe = /\b(?:SAE\s*)?(\d{1,2})W\b(?![-\d])/g;
  let saeMonoMatch;
  while ((saeMonoMatch = saeMonoWRe.exec(text))) {
    addTag(tags, "SAE", `${saeMonoMatch[1]}W`);
  }

  const isoVgRe = /\b(?:ISO\s*)?(?:VG\s*-?\s*)(\d{1,4})\b/g;
  let isoMatch;
  while ((isoMatch = isoVgRe.exec(text))) {
    addTag(tags, "ISO", isoMatch[1]);
  }

  Object.entries(VISCOSITY_SYSTEMS).forEach(([system, cfg]) => {
    cfg.aliases.forEach((alias) => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
      const re = new RegExp(`\\b${escaped}\\b\\s*[:/-]?\\s*([A-Z0-9.+/-]{1,32})`, "gi");
      let match;
      while ((match = re.exec(text))) {
        addTag(tags, system, match[1]);
      }
    });
  });

  return Array.from(tags).slice(0, 20);
}

function normalizeViscosityTags(values) {
  const source = Array.isArray(values) ? values : String(values || "").split(/[\n,;]+/);
  const tags = new Set();
  source.forEach((value) => {
    const tag = normalizeViscosityTag(value);
    if (tag) tags.add(tag);
  });
  return Array.from(tags).slice(0, 20);
}

function viscosityGroupsFromTags(tags) {
  const groups = new Set();
  (Array.isArray(tags) ? tags : []).forEach((tag) => {
    const group = String(tag || "").split(":")[0];
    if (VISCOSITY_SYSTEMS[group]) groups.add(group);
  });
  return Array.from(groups);
}

module.exports = {
  VISCOSITY_SYSTEMS,
  VISCOSITY_FILTER_PROFILES,
  parseViscosityTags,
  normalizeViscosityTag,
  normalizeViscosityTags,
  viscosityGroupsFromTags,
};
