export const VISCOSITY_SYSTEMS = {
  SAE: {
    label: "SAE",
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
  },
  ISO: {
    label: "ISO VG",
    options: ["2", "3", "5", "7", "10", "15", "22", "32", "46", "68", "100", "150", "220", "320", "460", "680", "1000"],
  },
};

export const VISCOSITY_FILTER_PROFILES = {
  "Оливи моторні": ["SAE"],
  "Оливи трансмісійні": ["SAE"],
  "Гальмівні та гідравлічні рідини": ["ISO", "SAE"],
  "Охолоджуючі рідини": [],
};

export function buildViscosityTag(system, code) {
  return `${String(system).toUpperCase()}:${String(code).toUpperCase()}`;
}

export function normalizeViscosityTagsInput(value) {
  const items = Array.isArray(value)
    ? value
    : String(value || "").split(/[\n,;]+/);
  const tags = new Set();
  items.forEach((item) => {
    const match = String(item || "").trim().toUpperCase().match(/^([A-Z0-9-]{2,16})\s*[:：]\s*(.+)$/);
    if (!match) return;
    const system = match[1];
    if (!VISCOSITY_SYSTEMS[system]) return;
    let code = match[2].trim().replace(/\s+/g, "");
    if (system === "SAE") {
      const multi = code.match(/^(\d{1,2})W(\d{2,3})$/);
      if (multi) code = `${multi[1]}W-${multi[2]}`;
    }
    if (system === "ISO") code = code.replace(/^VG-?/, "");
    if (!code) return;
    tags.add(`${system}:${code}`);
  });
  return Array.from(tags).slice(0, 20);
}

export function formatViscosityTags(tags) {
  return (Array.isArray(tags) ? tags : []).join(", ");
}

export function viscosityGroupsFromTags(tags) {
  return Array.from(
    new Set(
      (Array.isArray(tags) ? tags : [])
        .map((tag) => String(tag || "").split(":")[0])
        .filter((system) => VISCOSITY_SYSTEMS[system])
    )
  );
}
