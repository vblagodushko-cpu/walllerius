import React, { useEffect, useState } from "react";
import { PACK_BUCKETS } from "../utils/packFilter.js";
import { TOLERANCE_SYSTEMS, buildToleranceTag, toleranceFilterChoices } from "../utils/tolerances.js";
import { VISCOSITY_SYSTEMS, COMMON_SAE_GRADES, buildViscosityTag } from "../utils/viscosities.js";
import {
  catalogFilterCount,
  packFilterChipLabel,
  splitTag,
  systemsForFilter,
  toleranceFilterChipLabel,
  toleranceProfileIds,
  viscosityFilterChipLabel,
  viscosityProfileIds,
} from "../utils/catalogFilters.js";

const SEEN_KEY = "portalCatalogFiltersSeen";
const FILTER_HINT = "Фасовка, в’язкість і допуск. Звужує вже відкритий список.";

function readSeen() {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeSeen() {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* приватний режим браузера */
  }
}

const EMPTY = { packBucket: "", viscosityTag: "", toleranceTag: "" };

function sameTag(left, right) {
  return String(left || "").toUpperCase() === String(right || "").toUpperCase();
}

function Choice({ active, title, onClick, children, system = false, emphasis = false }) {
  const shape = system
    ? "rounded-lg px-2 py-1 text-xs font-medium"
    : `rounded-full border px-2.5 py-1 text-sm ${emphasis ? "font-semibold" : ""}`;
  const tone = system
    ? active
      ? "bg-stone-900 text-white"
      : "bg-stone-100 text-stone-600 hover:bg-stone-200"
    : active
      ? "border-indigo-700 bg-indigo-700 text-white"
      : "border-stone-200 bg-white text-stone-700 hover:border-indigo-300";
  return (
    <button
      type="button"
      title={title || undefined}
      aria-pressed={active}
      onClick={onClick}
      className={`${shape} ${tone}`}
    >
      {children}
    </button>
  );
}

function FilterSection({ title, systems, systemLabels, caption, activeSystem, onSystem, hasMore, expanded, onToggleMore, codes, activeCode, onCode }) {
  if (!systems.length) return null;
  const items = codes.map((code) => (typeof code === "string" ? { id: code, label: code } : code));
  return (
    <section className="mt-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">{title}</h3>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {systems.map((id) => (
          <Choice key={id} system active={id === activeSystem} title={systemLabels[id]?.label || id} onClick={() => onSystem(id)}>
            {caption ? caption(id, systemLabels[id]) : (systemLabels[id]?.label || id)}
          </Choice>
        ))}
        {hasMore ? (
          <button type="button" className="rounded-lg px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50" onClick={onToggleMore}>
            {expanded ? "менше" : "ще"}
          </button>
        ) : null}
      </div>
      {activeSystem && items.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {items.map((item) => (
            <Choice key={item.id} title={item.title} emphasis={item.emphasis} active={sameTag(item.id, activeCode)} onClick={() => onCode(item.id)}>
              {item.label}
            </Choice>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function RemovableChip({ label, onRemove }) {
  return (
    <button
      type="button"
      onClick={onRemove}
      className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2.5 py-1 text-sm text-indigo-800 hover:bg-indigo-100"
    >
      {label}
      <span aria-hidden="true">×</span>
      <span className="sr-only">прибрати</span>
    </button>
  );
}

export default function CatalogFilters({ category, value, onChange }) {
  const filters = { ...EMPTY, ...value };
  const count = catalogFilterCount(filters);
  const [open, setOpen] = useState(false);
  const [showNew, setShowNew] = useState(() => !readSeen());
  const [viscositySystem, setViscositySystem] = useState("");
  const [toleranceSystem, setToleranceSystem] = useState("");
  const [expandViscosity, setExpandViscosity] = useState(false);
  const [expandTolerance, setExpandTolerance] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const openPanel = () => {
    if (showNew) {
      writeSeen();
      setShowNew(false);
    }
    setOpen(true);
  };

  const patch = (next) => onChange((current) => ({ ...EMPTY, ...current, ...next }));

  const viscosityActive = splitTag(filters.viscosityTag);
  const toleranceActive = splitTag(filters.toleranceTag);
  const viscosityView = systemsForFilter(VISCOSITY_SYSTEMS, viscosityProfileIds(category), {
    expanded: expandViscosity,
    activeSystem: viscosityActive.system,
  });
  const toleranceView = systemsForFilter(TOLERANCE_SYSTEMS, toleranceProfileIds(category), {
    expanded: expandTolerance,
    activeSystem: toleranceActive.system,
  });
  const viscosityPick = viscosityView.systems.includes(viscositySystem)
    ? viscositySystem
    : viscosityView.systems.includes(viscosityActive.system)
      ? viscosityActive.system
      : viscosityView.systems[0] || "";
  const tolerancePick = toleranceView.systems.includes(toleranceSystem)
    ? toleranceSystem
    : toleranceView.systems.includes(toleranceActive.system)
      ? toleranceActive.system
      : toleranceView.systems[0] || "";

  const chips = [
    filters.packBucket
      ? { key: "pack", label: packFilterChipLabel(filters.packBucket), clear: { packBucket: "" } }
      : null,
    filters.viscosityTag
      ? { key: "viscosity", label: viscosityFilterChipLabel(filters.viscosityTag), clear: { viscosityTag: "" } }
      : null,
    filters.toleranceTag
      ? { key: "tolerance", label: toleranceFilterChipLabel(filters.toleranceTag), clear: { toleranceTag: "" } }
      : null,
  ].filter(Boolean);

  return (
    <>
      <div className="relative">
        <div className="group relative">
        {showNew ? (
          <span className="pointer-events-none absolute -top-2 right-1 z-10 rounded-full bg-indigo-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none text-white">
            нове
          </span>
        ) : null}
        <button
          type="button"
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-describedby="catalog-filters-hint"
          onClick={() => (open ? setOpen(false) : openPanel())}
          className={`rounded-xl border px-3 py-1.5 text-sm ${
            count
              ? "border-indigo-400 bg-indigo-50 font-medium text-indigo-800 ring-2 ring-indigo-200"
              : showNew
                ? "border-indigo-400 bg-indigo-50 text-stone-800 ring-2 ring-indigo-200"
                : "border-stone-200 bg-white text-stone-700 hover:border-stone-300"
          }`}
        >
          {count ? `Фільтри · ${count}` : "Фільтри"}
        </button>
        {open ? null : (
          <span
            id="catalog-filters-hint"
            role="tooltip"
            className="pointer-events-none absolute right-0 top-full z-20 mt-1.5 hidden w-56 rounded-lg bg-stone-900 px-2.5 py-1.5 text-left text-xs font-normal leading-snug text-white shadow-lg group-hover:block"
          >
            {FILTER_HINT}
          </span>
        )}
        </div>
        {open ? (
          <>
            <button type="button" className="fixed inset-0 z-50 cursor-default bg-stone-900/40 md:bg-transparent" aria-label="Закрити фільтри" onClick={() => setOpen(false)} />
            <div
              role="dialog"
              aria-label="Фільтри каталогу"
              className="fixed inset-x-0 bottom-0 z-50 flex max-h-[85vh] flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl md:absolute md:inset-x-auto md:bottom-auto md:right-0 md:top-full md:mt-2 md:max-h-[70vh] md:w-[28rem] md:rounded-2xl md:border md:border-stone-200"
            >
              <div className="flex items-center justify-between gap-3 px-4 pt-4">
                <h2 className="text-base font-semibold text-stone-900">Фільтри</h2>
                <button
                  type="button"
                  className="text-sm text-stone-500 hover:text-stone-800 disabled:opacity-40"
                  disabled={!count}
                  onClick={() => onChange({ ...EMPTY })}
                >
                  Скинути
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-2">

              <section className="mt-4">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">Фасовка</h3>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {PACK_BUCKETS.map((bucket) => (
                    <Choice
                      key={bucket.id}
                      title={bucket.title}
                      active={filters.packBucket === bucket.id}
                      onClick={() => patch({ packBucket: filters.packBucket === bucket.id ? "" : bucket.id })}
                    >
                      {bucket.label}
                    </Choice>
                  ))}
                </div>
              </section>

              <FilterSection
                title="В’язкість"
                systems={viscosityView.systems}
                systemLabels={VISCOSITY_SYSTEMS}
                caption={(id, cfg) => cfg?.label || id}
                activeSystem={viscosityPick}
                onSystem={setViscositySystem}
                hasMore={viscosityView.hasMore}
                expanded={expandViscosity}
                onToggleMore={() => setExpandViscosity((value) => !value)}
                codes={(VISCOSITY_SYSTEMS[viscosityPick]?.options || []).map((code) => ({
                  id: code,
                  label: code,
                  emphasis: viscosityPick === "SAE" && COMMON_SAE_GRADES.includes(code),
                }))}
                activeCode={viscosityActive.system === viscosityPick ? viscosityActive.code : ""}
                onCode={(code) => {
                  const next = buildViscosityTag(viscosityPick, code);
                  patch({ viscosityTag: sameTag(filters.viscosityTag, next) ? "" : next });
                }}
              />

              <FilterSection
                title="Допуск"
                systems={toleranceView.systems}
                systemLabels={TOLERANCE_SYSTEMS}
                caption={(id) => id}
                activeSystem={tolerancePick}
                onSystem={setToleranceSystem}
                hasMore={toleranceView.hasMore}
                expanded={expandTolerance}
                onToggleMore={() => setExpandTolerance((value) => !value)}
                codes={toleranceFilterChoices(tolerancePick, category)}
                activeCode={toleranceActive.system === tolerancePick ? toleranceActive.code : ""}
                onCode={(code) => {
                  const next = buildToleranceTag(tolerancePick, code);
                  patch({ toleranceTag: sameTag(filters.toleranceTag, next) ? "" : next });
                }}
              />

              </div>
              <div className="flex justify-end border-t border-stone-100 px-4 py-3">
                <button type="button" className="rounded-xl bg-indigo-700 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-800" onClick={() => setOpen(false)}>
                  Показати
                </button>
              </div>
            </div>
          </>
        ) : null}
      </div>
      {chips.length ? (
        <div className="flex basis-full flex-wrap gap-2">
          {chips.map((chip) => (
            <RemovableChip key={chip.key} label={chip.label} onRemove={() => patch(chip.clear)} />
          ))}
        </div>
      ) : null}
    </>
  );
}
