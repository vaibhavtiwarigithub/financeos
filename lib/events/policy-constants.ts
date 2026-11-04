export const POLICY_DOMAINS = [
  "tax", "trade", "energy", "health", "defense", "antitrust", "industrial_subsidy", "other",
] as const;
export const POLICY_STAGES = ["proposed", "passed", "signed", "effective", "blocked", "reversed"] as const;
export const ELECTION_STAGES = ["projected", "called", "certified"] as const;
export const CHAMBERS = ["house", "senate", "presidency"] as const;
export const CONTROL_STATES = ["democratic", "republican", "split", "tie", "unknown"] as const;
export const EXPOSURE_STANCES = ["positive", "negative", "mixed", "unknown"] as const;
