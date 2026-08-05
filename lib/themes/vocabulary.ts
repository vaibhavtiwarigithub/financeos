// Controlled theme vocabulary — the stable identity behind Theme Scout's
// free-text output.
//
// WHY THIS IS A HAND-CURATED TABLE AND NOT AN LLM CALL:
// Theme Scout mints a theme name from an LLM prompt on every run, with no
// vocabulary and no memory of prior runs. Measured 2026-08-04 over 182 rows and
// 13 runs: 42 distinct strings, 32 of them appearing in exactly ONE run. Naive
// normalisation (lowercase, strip spaces/hyphens) collapses 42 -> 40, so the
// drift is semantic, not formatting. "Cybersecurity" arrived as six separate
// strings across five weeks — 48 rows that should read as one persistent theme.
//
// Adding a second LLM to reconcile the first one's output would make the
// vocabulary non-deterministic and unauditable, and would reintroduce exactly the
// failure being fixed. An unmatched theme stays unmatched; the unmatched rate is
// the signal that the vocabulary needs an owner-reviewed extension.
//
// MEASUREMENT ONLY. No slug here reaches a score, eligibility, size, entry, exit,
// promotion, or broker decision. Theme momentum is constant within a theme, so as
// a scoring dimension its per-date cross-sectional variance is zero by
// construction — the same defect that got NSE FII/DII rejected in
// features/india-scorer-discrimination/R3_DIMENSION_FEASIBILITY.md.

export interface ThemeDefinition {
  slug: string;
  label: string;
  /** Lowercased alias strings. Matched exactly after normalisation. */
  aliases: readonly string[];
}

/** Lowercase, collapse whitespace, drop punctuation. Formatting only. */
export function normalizeThemeString(raw: string): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// Seeded from the 42 strings actually observed 2026-06-30 → 2026-08-03. Every
// alias below is a real production value, not an invented one.
export const THEME_VOCABULARY: readonly ThemeDefinition[] = [
  {
    slug: "cybersecurity",
    label: "Cybersecurity",
    aliases: ["cybersecurity", "cyber security", "cybersecurity solutions", "cyber security boom",
      "cybersecurity demand", "cybersecurity threats", "cloud security"],
  },
  {
    slug: "cloud-computing",
    label: "Cloud computing",
    aliases: ["cloud computing", "cloud computing expansion", "data center growth"],
  },
  {
    slug: "renewable-energy",
    label: "Renewable energy",
    aliases: ["renewable energy", "renewable energy boom", "renewable energy transition",
      "clean energy", "sustainable energy push"],
  },
  {
    slug: "electric-vehicles",
    label: "Electric vehicles",
    aliases: ["electric vehicles", "electric vehicle boom", "electric vehicle growth",
      "ev charging growth"],
  },
  {
    slug: "digital-payments",
    label: "Digital payments",
    aliases: ["digital payments", "digital payments growth"],
  },
  {
    slug: "ecommerce",
    label: "E-commerce",
    aliases: ["ecommerce growth", "e commerce growth"],
  },
  {
    slug: "artificial-intelligence",
    label: "Artificial intelligence",
    aliases: ["artificial intelligence", "ai tech growth"],
  },
  {
    slug: "autonomous-vehicles",
    label: "Autonomous vehicles",
    aliases: ["autonomous tech", "robotaxi technology"],
  },
  {
    slug: "healthcare-innovation",
    label: "Healthcare innovation",
    aliases: ["healthcare innovation", "healthcare innovations"],
  },
  {
    slug: "financials",
    label: "Financials",
    aliases: ["financial services", "financials undervalued", "insurance technology"],
  },
];

const ALIAS_INDEX: ReadonlyMap<string, string> = new Map(
  THEME_VOCABULARY.flatMap((t) => t.aliases.map((a) => [normalizeThemeString(a), t.slug] as const)),
);

export const THEME_LABELS: ReadonlyMap<string, string> = new Map(
  THEME_VOCABULARY.map((t) => [t.slug, t.label]),
);

/**
 * Resolve a raw theme string to a stable slug, or null when the vocabulary does
 * not cover it.
 *
 * Returning null is a deliberate outcome, not a failure: an unrecognised theme
 * keeps its raw string and is reported as unmatched. Guessing a slug would
 * recreate the drift this module exists to remove — a one-off observation such as
 * "Debt Reduction" or "Grid Safety" is not evidence of a durable theme and must
 * not be minted into one.
 */
export function resolveThemeSlug(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return ALIAS_INDEX.get(normalizeThemeString(raw)) ?? null;
}
