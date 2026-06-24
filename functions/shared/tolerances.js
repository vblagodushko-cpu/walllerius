const TOLERANCE_SYSTEMS = {
  ACEA: {
    label: "ACEA",
    aliases: ["ACEA"],
    options: ["A1/B1", "A3/B3", "A3/B4", "A5/B5", "A7/B7", "B4", "C1", "C2", "C3", "C4", "C5", "C6", "E4", "E6", "E7", "E9", "E11"],
    codePattern: /^(?:A\d\/B\d|A\d|B\d|C\d|E\d{1,2})$/i,
  },
  API: {
    label: "API",
    aliases: ["API"],
    options: ["SL", "SM", "SN", "SN-PLUS", "SP", "CF", "CF-4", "CG-4", "CH-4", "CI-4", "CJ-4", "CK-4", "FA-4", "GL-4", "GL-5", "MT-1"],
    codePattern: /^(?:S[A-Z]|SN-?PLUS|C[A-Z](?:-\d)?|GL-\d|MT-\d|FA-\d)$/i,
  },
  ILSAC: {
    label: "ILSAC",
    aliases: ["ILSAC"],
    options: ["GF-4", "GF-5", "GF-6A", "GF-6B"],
    codePattern: /^GF-\d[A-Z]?$/i,
  },
  JASO: {
    label: "JASO",
    aliases: ["JASO"],
    options: ["MA", "MA2", "MB", "DH-1", "DH-2", "DL-1", "FD"],
    codePattern: /^(?:MA2?|MB|D[HL]-\d|FD)$/i,
  },
  MB: {
    label: "Mercedes-Benz",
    aliases: ["MB", "MB APPROVAL", "MERCEDES", "MERCEDES-BENZ", "MERCEDES BENZ"],
    options: [
      "226.5", "229.1", "229.3", "229.5", "229.31", "229.51", "229.52", "229.61",
      "235.0", "235.7", "236.14", "236.15", "236.17",
      "325.0", "325.3", "325.5", "325.6",
    ],
    codePattern: /^(?:2(?:25|26|29|35|36)\.\d{1,2})$/i,
  },
  VW: {
    label: "Volkswagen",
    aliases: ["VW", "VOLKSWAGEN", "AUDI", "VAG"],
    options: [
      "500.00", "501.01", "502.00", "503.00", "503.01", "504.00", "505.00", "505.01",
      "506.00", "506.01", "507.00", "508.00", "509.00", "511", "511.00",
      "G11", "G12", "G12++", "G13", "TL-774", "774-G", "774-J", "774-L",
    ],
    codePattern: /^(?:50\d\.\d{2}|511(?:\.00)?|G\d{2}\+{0,2}|TL-?774(?:-[A-Z])?|774-[A-Z])$/i,
  },
  BMW: {
    label: "BMW",
    aliases: ["BMW", "BMW LONGLIFE", "LONGLIFE"],
    options: ["LL-01", "LL-01FE", "LL-04", "LL-12FE", "LL-14FE+", "LL-17FE+"],
    codePattern: /^(?:LL-?\d{2}(?:FE\+?)?)$/i,
  },
  RENAULT: {
    label: "Renault",
    aliases: ["RENAULT", "RN"],
    options: ["RN0700", "RN0710", "RN0720", "RN17", "RN17FE"],
    codePattern: /^(?:RN-?\d{2,4}(?:FE)?|RN17(?:FE)?)$/i,
  },
  FORD: {
    label: "Ford",
    aliases: ["FORD", "WSS"],
    options: ["WSS-M2C913-C", "WSS-M2C913-D", "WSS-M2C948-B", "WSS-M2C950-A", "WSS-M2C934-B"],
    codePattern: /^(?:WSS-)?M2C\d{3,4}-?[A-Z]?$/i,
  },
  GM: {
    label: "GM / Opel",
    aliases: ["GM", "OPEL", "DEXOS"],
    options: ["DEXOS1", "DEXOS1-GEN2", "DEXOS2", "DEXOS-D"],
    codePattern: /^DEXOS[A-Z0-9-]*$/i,
  },
  ZF: {
    label: "ZF",
    aliases: ["ZF", "ZF TE-ML", "TE-ML"],
    options: ["TE-ML-01", "TE-ML-02", "TE-ML-03", "TE-ML-04", "TE-ML-05", "TE-ML-11", "TE-ML-14", "TE-ML-16", "TE-ML-17", "TE-ML-21"],
    codePattern: /^(?:TE-?ML-?)?\d{2}[A-Z]?$/i,
  },
  MAN: {
    label: "MAN",
    aliases: ["MAN"],
    options: ["341", "342", "3477", "3677", "M3275", "M3477", "M3677"],
    codePattern: /^(?:M?\d{3,4})$/i,
  },
  DOT: {
    label: "DOT",
    aliases: ["DOT"],
    options: ["3", "4", "4-LV", "5", "5.1"],
    codePattern: /^(?:3|4|4-?LV|5|5\.1)$/i,
  },
  ISO: {
    label: "ISO",
    aliases: ["ISO"],
    options: ["4925", "22241", "7308", "46", "32"],
    codePattern: /^\d{2,5}(?:-\d)?$/i,
  },
  SAE: {
    label: "SAE",
    aliases: ["SAE"],
    options: ["J1703", "J1704", "J2360"],
    codePattern: /^J\d{4}$/i,
  },
};

const TOLERANCE_FILTER_PROFILES = {
  "Оливи моторні": ["ACEA", "API", "ILSAC", "JASO", "MB", "VW", "BMW", "RENAULT", "FORD", "GM"],
  "Оливи трансмісійні": ["API", "ZF", "MAN", "MB", "VW", "FORD", "GM"],
  "Гальмівні та гідравлічні рідини": ["DOT", "ISO", "SAE", "VW", "MB"],
  "Охолоджуючі рідини": ["VW", "MB", "BMW", "GM", "FORD", "ASTM", "BS"],
};

function canonicalCode(system, rawCode) {
  const code = String(rawCode || "")
    .trim()
    .toUpperCase()
    .replace(/[()]/g, "")
    .replace(/\s+/g, "-")
    .replace(/PLUS/g, "PLUS")
    .replace(/SN\+/g, "SN-PLUS")
    .replace(/^LL(\d)/, "LL-$1")
    .replace(/^RN-?(\d)/, "RN$1")
    .replace(/^WSS[-\s]?/, "WSS-")
    .replace(/^TE[-\s]?ML[-\s]?/, "TE-ML-");

  if (system === "API") return code.replace(/^SNPLUS$/, "SN-PLUS");
  if (system === "BMW") return code.replace(/^LL-(\d{2})-?FE/, "LL-$1FE");
  if (system === "VW") {
    return code
      .replace(/^(\d{3})(\d{2})$/, "$1.$2")
      .replace(/^TL-?774-?([A-Z])$/i, "774-$1")
      .replace(/^TL-?774$/i, "TL-774")
      .replace(/^G(\d{2})\+\+$/i, "G$1++");
  }
  if (system === "ZF" && /^\d{2}[A-Z]?$/.test(code)) return `TE-ML-${code}`;
  if (system === "FORD" && /^M2C/i.test(code)) return `WSS-${code}`;
  return code;
}

function normalizeToleranceTag(value) {
  const match = String(value || "").trim().match(/^([A-Z0-9-]{2,16})\s*[:：]\s*(.+)$/i);
  if (!match) return null;
  const system = match[1].trim().toUpperCase();
  if (!TOLERANCE_SYSTEMS[system]) return null;
  const code = canonicalCode(system, match[2]);
  if (!isValidCode(system, code)) return null;
  return `${system}:${code}`;
}

function expandCodeParts(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  return raw
    .split(/[,/]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function isValidCode(system, code) {
  const cfg = TOLERANCE_SYSTEMS[system];
  if (!cfg) return false;
  return cfg.options.includes(code) || cfg.codePattern.test(code);
}

function addTag(tags, system, rawCode) {
  expandCodeParts(rawCode).forEach((part) => {
    const code = canonicalCode(system, part);
    if (isValidCode(system, code)) tags.add(`${system}:${code}`);
  });
}

function parseToleranceTags(input) {
  const tags = new Set();
  const text = String(input || "").toUpperCase();
  if (!text.trim()) return [];

  const explicitTagRe = /([A-Z0-9-]{2,16})\s*[:：]\s*([A-Z0-9.+/-]+)/gi;
  let tagMatch;
  while ((tagMatch = explicitTagRe.exec(text))) {
    addTag(tags, tagMatch[1].toUpperCase(), tagMatch[2]);
  }

  Object.entries(TOLERANCE_SYSTEMS).forEach(([system, cfg]) => {
    cfg.aliases.forEach((alias) => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
      const re = new RegExp(`\\b${escaped}\\b\\s*[:/-]?\\s*([A-Z0-9.+/-]{1,32})`, "gi");
      let match;
      while ((match = re.exec(text))) {
        addTag(tags, system, match[1]);
      }
    });
  });

  return Array.from(tags).slice(0, 50);
}

function normalizeToleranceTags(values) {
  const source = Array.isArray(values) ? values : String(values || "").split(/[\n,;]+/);
  const tags = new Set();
  source.forEach((value) => {
    const tag = normalizeToleranceTag(value);
    if (tag) tags.add(tag);
  });
  return Array.from(tags).slice(0, 50);
}

function toleranceGroupsFromTags(tags) {
  const groups = new Set();
  (Array.isArray(tags) ? tags : []).forEach((tag) => {
    const group = String(tag || "").split(":")[0];
    if (TOLERANCE_SYSTEMS[group]) groups.add(group);
  });
  return Array.from(groups);
}

module.exports = {
  TOLERANCE_SYSTEMS,
  TOLERANCE_FILTER_PROFILES,
  parseToleranceTags,
  normalizeToleranceTag,
  normalizeToleranceTags,
  toleranceGroupsFromTags,
};
