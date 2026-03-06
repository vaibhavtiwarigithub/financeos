export type SubscriptionTier = "free" | "pro" | "elite";
export type UserRole = "user" | "admin" | "superadmin";

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  role: UserRole;
  subscription_tier: SubscriptionTier;
  subscription_status: string;
  stripe_customer_id: string | null;
  market_focus: "US" | "India" | "Both";
  knowledge_level: "Beginner" | "Intermediate" | "Advanced";
  theme: "dark" | "light" | "midnight";
  ai_model: string;
  xp: number;
  streak_days: number;
  analysis_count: number;
  dna_macro: number;
  dna_equities: number;
  dna_fixed_income: number;
  dna_derivatives: number;
  dna_risk_mgmt: number;
  dna_behavioral: number;
  dna_technical: number;
  dna_crypto: number;
  created_at: string;
}

export interface Holding {
  id: string;
  user_id: string;
  symbol: string;
  name: string;
  qty: number;
  avg_cost: number;
  current_price: number;
  sector: string;
  exchange: string;
  notes: string | null;
  created_at: string;
  // computed
  mktVal?: number;
  cost?: number;
  pnl?: number;
  pnlPct?: number;
}

export interface Prediction {
  id: string;
  user_id: string;
  asset: string;
  thesis: string;
  direction: "UP" | "DOWN" | "SIDEWAYS";
  target_price: number | null;
  timeframe: string;
  confidence: number;
  status: "open" | "correct" | "incorrect" | "partial" | "expired";
  score: number | null;
  actual_outcome: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface JournalEntry {
  id: string;
  user_id: string;
  asset: string;
  direction: "LONG" | "SHORT";
  entry_price: number | null;
  exit_price: number | null;
  pnl: number | null;
  setup: string | null;
  emotion: string;
  lesson: string | null;
  tags: string[] | null;
  created_at: string;
}

export interface TierLimits {
  aiQueriesPerDay: number;
  maxHoldings: number;
  markets: string[];
  features: string[];
}

export const TIER_LIMITS: Record<SubscriptionTier, TierLimits> = {
  free: {
    aiQueriesPerDay: 5,
    maxHoldings: 3,
    markets: ["US"],
    features: ["basic_portfolio", "basic_quiz", "basic_predictions"],
  },
  pro: {
    aiQueriesPerDay: 50,
    maxHoldings: Infinity,
    markets: ["US", "India"],
    features: ["full_portfolio", "morning_brief", "newsletter", "stress_test", "dna_profile", "position_sizer", "all_markets"],
  },
  elite: {
    aiQueriesPerDay: Infinity,
    maxHoldings: Infinity,
    markets: ["US", "India", "Crypto", "Macro", "Global"],
    features: ["everything", "custom_scenarios", "head_to_head", "portfolio_optimizer", "admin_access"],
  },
};

export const SUBSCRIPTION_PLANS = [
  {
    tier: "free" as SubscriptionTier,
    name: "Free",
    price: 0,
    description: "Get started with US markets",
    features: [
      "5 AI queries per day",
      "Track up to 3 holdings",
      "US markets only",
      "Basic quiz & learning",
      "10 predictions max",
      "Community support",
    ],
    cta: "Get Started",
  },
  {
    tier: "pro" as SubscriptionTier,
    name: "Pro",
    price: 29,
    description: "For serious investors",
    popular: true,
    features: [
      "50 AI queries per day",
      "Unlimited holdings",
      "US + India markets",
      "Daily Morning Brief",
      "Custom newsletter",
      "All stress test scenarios",
      "Full DNA profile",
      "R:R position sizer",
      "Unlimited predictions",
      "Email support",
    ],
    cta: "Start Pro",
  },
  {
    tier: "elite" as SubscriptionTier,
    name: "Elite",
    price: 99,
    description: "Institutional-grade intelligence",
    features: [
      "Unlimited AI queries",
      "All Pro features",
      "US + India + Crypto + Macro",
      "Custom AI stress scenarios",
      "Head-to-head analyst mode",
      "Portfolio optimizer",
      "Auto prediction scoring",
      "Priority support",
      "Early access to features",
    ],
    cta: "Go Elite",
  },
];
