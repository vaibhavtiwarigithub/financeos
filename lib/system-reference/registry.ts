export type SystemReferenceDocument = {
  id: string;
  title: string;
  category: "Orientation" | "Architecture chapters" | "Decisions" | "Feature designs";
  description: string;
  path: string;
};

// This is intentionally an allowlist, not a repository browser. Add a document
// only after deciding it is safe and useful to expose to the authenticated owner.
export const SYSTEM_REFERENCE_DOCUMENTS: readonly SystemReferenceDocument[] = [
  { id: "architecture", title: "Architecture portal", category: "Orientation", description: "How the documentation system fits together, canonical sources, and change rules.", path: "ARCHITECTURE.md" },
  { id: "overview", title: "System overview", category: "Orientation", description: "A concise explanation of Kairos, its safety posture, and where detailed truth lives.", path: "SYSTEM_OVERVIEW.md" },
  { id: "index", title: "Architecture chapter index", category: "Orientation", description: "The read order and ownership map for the definitive architecture chapters.", path: "docs/arch/00-index.md" },
  { id: "what-is-kairos", title: "What is Kairos?", category: "Architecture chapters", description: "Product scope, principles, and the high-level lifecycle.", path: "docs/arch/01-what-is-kairos.md" },
  { id: "tech-stack", title: "Tech stack and integrations", category: "Architecture chapters", description: "Runtime components and external integration boundaries.", path: "docs/arch/02-tech-stack.md" },
  { id: "agents", title: "Agents", category: "Architecture chapters", description: "Agent responsibilities, inputs, outputs, and safety boundaries.", path: "docs/arch/03-agents.md" },
  { id: "database", title: "Database schema", category: "Architecture chapters", description: "Tables, contracts, and persistence ownership.", path: "docs/arch/04-database-schema.md" },
  { id: "scheduling", title: "Crons and scheduling", category: "Architecture chapters", description: "Scheduled work and operational timing.", path: "docs/arch/05-crons-and-scheduling.md" },
  { id: "risk", title: "Risk and safety", category: "Architecture chapters", description: "Money-path gates, market isolation, autonomy, and fail-closed behavior.", path: "docs/arch/08-risk-and-safety.md" },
  { id: "learning", title: "Learning loop", category: "Architecture chapters", description: "Validation, champion/challenger lifecycle, and promotion controls.", path: "docs/arch/09-learning-loop.md" },
  { id: "decisions", title: "Project decisions", category: "Decisions", description: "Approved architecture and product decisions with rationale and reversal cost.", path: "PROJECT_DECISIONS.md" },
  { id: "shadow-registry", title: "Shadow registry", category: "Feature designs", description: "Current evidence-program registry, activation gates, and the Upgrade Path surface.", path: "features/shadow-registry/FEATURE_ARCHITECTURE.md" },
  { id: "historical-replay", title: "Local historical replay", category: "Feature designs", description: "Network-free, immutable historical evidence intake and diagnostic replay boundaries.", path: "features/local-historical-replay/FEATURE_ARCHITECTURE.md" },
];

export function findSystemReferenceDocument(id: string) {
  return SYSTEM_REFERENCE_DOCUMENTS.find((document) => document.id === id) ?? null;
}
