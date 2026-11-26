export const TOLERANCE_SYSTEMS = {
  ACEA: {
    label: "ACEA",
    options: ["A1/B1", "A3/B3", "A3/B4", "A5/B5", "A7/B7", "B4", "C1", "C2", "C3", "C4", "C5", "C6", "E4", "E6", "E7", "E9", "E11"],
  },
  API: {
    label: "API",
    options: ["SL", "SM", "SN", "SN-PLUS", "SP", "CF", "CF-4", "CG-4", "CH-4", "CI-4", "CJ-4", "CK-4", "FA-4", "GL-4", "GL-5", "MT-1"],
  },
  ILSAC: {
    label: "ILSAC",
    options: ["GF-4", "GF-5", "GF-6A", "GF-6B"],
  },
  JASO: {
    label: "JASO",
    options: ["MA", "MA2", "MB", "DH-1", "DH-2", "DL-1", "FD"],
  },
  MB: {
    label: "Mercedes-Benz",
    options: [
      "226.5", "229.1", "229.3", "229.5", "229.31", "229.51", "229.52", "229.61",
      "235.0", "235.7", "236.14", "236.15", "236.17",
      "325.0", "325.3", "325.5", "325.6",
    ],
  },
  VW: {
    label: "Volkswagen",
    options: [
      "500.00", "501.01", "502.00", "503.00", "503.01", "504.00", "505.00", "505.01",
      "506.00", "506.01", "507.00", "508.00", "509.00", "511", "511.00",
      "G11", "G12", "G12++", "G13", "TL-774", "774-G", "774-J", "774-L",
    ],
  },
  BMW: {
    label: "BMW",
    options: ["LL-01", "LL-01FE", "LL-04", "LL-12FE", "LL-14FE+", "LL-17FE+"],
  },
  RENAULT: {
    label: "Renault",
    options: ["RN0700", "RN0710", "RN0720", "RN17", "RN17FE"],
  },
  FORD: {
    label: "Ford",
    options: ["WSS-M2C913-C", "WSS-M2C913-D", "WSS-M2C948-B", "WSS-M2C950-A", "WSS-M2C934-B"],
  },
  GM: {
    label: "GM / Opel",
    options: ["DEXOS1", "DEXOS1-GEN2", "DEXOS2", "DEXOS-D"],
  },
  ZF: {
    label: "ZF",
    options: ["TE-ML-01", "TE-ML-02", "TE-ML-03", "TE-ML-04", "TE-ML-05", "TE-ML-11", "TE-ML-14", "TE-ML-16", "TE-ML-17", "TE-ML-21"],
  },
  MAN: {
    label: "MAN",
    options: ["341", "342", "3477", "3677", "M3275", "M3477", "M3677"],
  },
  DOT: {
    label: "DOT",
    options: ["3", "4", "4-LV", "5", "5.1"],
  },
  ISO: {
    label: "ISO",
    options: ["4925", "22241", "7308", "46", "32"],
  },
  SAE: {
    label: "SAE",
    options: ["J1703", "J1704", "J2360"],
  },
};

/** Кнопки фільтра порталу. У товарі лишаються окремі теги, кнопка збігається з будь-яким із codes. */
export const VW_FILTER_CHOICES = [
  { id: "501.01", label: "501.01", kind: "oil", codes: ["501.01"] },
  { id: "502.00/505.00", label: "502.00/505.00", kind: "oil", codes: ["502.00", "505.00"] },
  { id: "503/506", label: "503/506", kind: "oil", title: "503.00, 503.01, 506.00, 506.01", codes: ["503.00", "503.01", "506.00", "506.01"] },
  { id: "504.00/507.00", label: "504.00/507.00", kind: "oil", codes: ["504.00", "507.00"] },
  { id: "505.01", label: "505.01", kind: "oil", codes: ["505.01"] },
  { id: "508.00/509.00", label: "508.00/509.00", kind: "oil", codes: ["508.00", "509.00"] },
  { id: "511.00", label: "511.00", kind: "oil", codes: ["511.00", "511"] },
  { id: "G11/774-C", label: "G11/774-C", kind: "coolant", codes: ["G11", "774-C", "TL-774-C"] },
  { id: "G12/774-D", label: "G12/774-D", kind: "coolant", codes: ["G12", "774-D", "TL-774-D"] },
  { id: "G12+/774-F", label: "G12+/774-F", kind: "coolant", codes: ["G12+", "774-F", "TL-774-F"] },
  { id: "G12++/774-G", label: "G12++/774-G", kind: "coolant", codes: ["G12++", "774-G", "TL-774-G"] },
  { id: "G13/774-J", label: "G13/774-J", kind: "coolant", codes: ["G13", "774-J", "TL-774-J"] },
  { id: "G12evo/774-L", label: "G12evo/774-L", kind: "coolant", codes: ["G12EVO", "774-L", "TL-774-L"] },
];

const COOLANT_CATEGORIES = new Set(["Охолоджуючі рідини"]);
const OIL_CATEGORIES = new Set(["Оливи моторні", "Оливи трансмісійні", "Гальмівні та гідравлічні рідини"]);

export function toleranceFilterChoices(system, category) {
  const options = TOLERANCE_SYSTEMS[system]?.options || [];
  if (system !== "VW") {
    return options.map((code) => ({ id: code, label: code, codes: [code] }));
  }
  const name = String(category || "").trim();
  const kind = COOLANT_CATEGORIES.has(name) ? "coolant" : OIL_CATEGORIES.has(name) ? "oil" : "";
  const source = kind ? VW_FILTER_CHOICES.filter((choice) => choice.kind === kind) : VW_FILTER_CHOICES;
  return source.map((choice) => ({ id: choice.id, label: choice.label, codes: choice.codes, title: choice.title }));
}

export function expandToleranceFilterTag(tag) {
  const raw = String(tag || "").trim().toUpperCase();
  const index = raw.indexOf(":");
  if (index <= 0) return [];
  const system = raw.slice(0, index);
  const code = raw.slice(index + 1);
  const choice = system === "VW"
    ? VW_FILTER_CHOICES.find((item) => item.id.toUpperCase() === code)
    : null;
  const codes = choice ? choice.codes : [code];
  return codes.map((item) => `${system}:${String(item).toUpperCase()}`);
}

export const TOLERANCE_FILTER_PROFILES = {
  "Оливи моторні": ["ACEA", "API", "ILSAC", "JASO", "MB", "VW", "BMW", "RENAULT", "FORD", "GM"],
  "Оливи трансмісійні": ["API", "ZF", "MAN", "MB", "VW", "FORD", "GM"],
  "Гальмівні та гідравлічні рідини": ["DOT", "ISO", "SAE", "VW", "MB"],
  "Охолоджуючі рідини": ["VW", "MB", "BMW", "GM", "FORD"],
};

export function buildToleranceTag(system, code) {
  return `${String(system).toUpperCase()}:${String(code).toUpperCase()}`;
}

export function normalizeToleranceTagsInput(value) {
  const items = Array.isArray(value)
    ? value
    : String(value || "").split(/[\n,;]+/);
  const tags = new Set();
  items.forEach((item) => {
    const match = String(item || "").trim().toUpperCase().match(/^([A-Z0-9-]{2,16})\s*[:：]\s*(.+)$/);
    if (!match) return;
    const system = match[1];
    if (!TOLERANCE_SYSTEMS[system]) return;
    const code = match[2].trim().replace(/\s+/g, "-");
    if (!code) return;
    tags.add(`${system}:${code}`);
  });
  return Array.from(tags).slice(0, 50);
}

export function formatToleranceTags(tags) {
  return (Array.isArray(tags) ? tags : []).join(", ");
}

/** Системи з профілів усіх категорій товару, без повторів. Порожньо — категорії без профілю. */
export function toleranceSystemsForCategories(categories) {
  const preferred = [];
  (Array.isArray(categories) ? categories : []).forEach((category) => {
    const profile = TOLERANCE_FILTER_PROFILES[String(category || "").trim()];
    if (!profile) return;
    profile.forEach((id) => {
      if (!preferred.includes(id)) preferred.push(id);
    });
  });
  return preferred;
}

/** Категорія для кнопок VW: оливи і антифриз не змішуємо. */
export function toleranceChoiceCategory(categories) {
  const names = (Array.isArray(categories) ? categories : []).map((category) => String(category || "").trim());
  const coolant = names.some((name) => COOLANT_CATEGORIES.has(name));
  const oil = names.some((name) => OIL_CATEGORIES.has(name));
  if (coolant && !oil) return "Охолоджуючі рідини";
  if (oil && !coolant) return names.find((name) => OIL_CATEGORIES.has(name)) || "";
  return "";
}

export function toleranceGroupsFromTags(tags) {
  return Array.from(
    new Set(
      (Array.isArray(tags) ? tags : [])
        .map((tag) => String(tag || "").split(":")[0])
        .filter((system) => TOLERANCE_SYSTEMS[system])
    )
  );
}
