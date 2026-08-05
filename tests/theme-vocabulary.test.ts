import { describe, expect, it } from "vitest";
import { resolveThemeSlug, normalizeThemeString, THEME_VOCABULARY } from "@/lib/themes/vocabulary";

// Theme Scout mints a theme name from an LLM prompt every run with no vocabulary
// and no memory. Measured over 182 rows / 13 runs: 42 distinct strings, 32
// appearing exactly once. Naive normalisation collapses 42 -> 40, so the drift is
// semantic. These are the real production strings.
describe("theme vocabulary", () => {
  it("collapses the six cybersecurity strings to one slug", () => {
    for (const raw of [
      "Cybersecurity", "Cyber Security", "Cybersecurity Solutions",
      "Cyber Security Boom", "Cybersecurity Demand", "Cybersecurity Threats",
    ]) {
      expect(resolveThemeSlug(raw)).toBe("cybersecurity");
    }
  });

  it("collapses the other observed families", () => {
    expect(resolveThemeSlug("Cloud Computing Expansion")).toBe("cloud-computing");
    expect(resolveThemeSlug("Clean Energy")).toBe("renewable-energy");
    expect(resolveThemeSlug("Sustainable Energy Push")).toBe("renewable-energy");
    expect(resolveThemeSlug("EV Charging Growth")).toBe("electric-vehicles");
    expect(resolveThemeSlug("E-commerce Growth")).toBe("ecommerce");
    expect(resolveThemeSlug("ECommerce Growth")).toBe("ecommerce");
    expect(resolveThemeSlug("Healthcare Innovations")).toBe("healthcare-innovation");
  });

  it("returns null for one-off observations rather than minting a theme", () => {
    // These are the 10 unmatched production strings. Several are not investable
    // themes at all. Guessing a slug for them would recreate the drift.
    for (const raw of [
      "Grid Safety", "Tech Sector Rebound", "Consumer Expansion", "Debt Reduction",
      "Defensive Consumer", "Stable Dividend Payers", "Energy Merger Boom",
      "Global Diversification", "Cash Flow Recovery", "Industrial Expansion",
    ]) {
      expect(resolveThemeSlug(raw)).toBeNull();
    }
  });

  it("handles empty and malformed input without throwing", () => {
    for (const raw of [null, undefined, "", "   ", "!!!"]) {
      expect(resolveThemeSlug(raw as any)).toBeNull();
    }
  });

  it("normalises formatting only", () => {
    expect(normalizeThemeString("  Cyber-Security  ")).toBe("cyber security");
    expect(normalizeThemeString("E-commerce Growth")).toBe("e commerce growth");
  });

  it("has no alias claimed by two slugs", () => {
    const seen = new Map<string, string>();
    for (const t of THEME_VOCABULARY) {
      for (const a of t.aliases) {
        const key = normalizeThemeString(a);
        expect(seen.has(key), `alias "${a}" claimed by ${seen.get(key)} and ${t.slug}`).toBe(false);
        seen.set(key, t.slug);
      }
    }
  });

  it("keeps every slug unique and kebab-case", () => {
    const slugs = THEME_VOCABULARY.map(t => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(s).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});
