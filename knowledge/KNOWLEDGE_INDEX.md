# Kairos Knowledge Base â€” Master Index

> **For AI Agents:** This is your long-term memory. Read relevant sections before making any prediction or trade decision. Update confidence scores as predictions resolve. The goal: accumulate genuine market understanding, not just rules.

Last updated: 2026-07-01
Knowledge entries: 9 files | Predictions resolved: 0 | Avg confidence: â€”

---

## Index

### Doctrine (governs ALL agent reasoning â€” load before any trade decision)
| File | Topic | Confidence | Last Updated |
|---|---|---|---|
| [agent-knowledge-doctrine.md](agent-knowledge-doctrine.md) | Reasoning rules: no hallucinated prices, abstain policy, humility prior, kill-switches, decision output contract (Â§8) | LOCKED â€” policy, not opinion | 2026-06-28 |

### Foundational (read first, always)
| File | Topic | Confidence | Last Updated |
|---|---|---|---|
| [firm-blueprints/what-actually-works.md](firm-blueprints/what-actually-works.md) | Distilled lessons from Renaissance, Two Sigma, D.E. Shaw, Man AHL, LTCM | HIGH â€” sourced from verified research | 2026-06-01 |
| [market-mechanics/regime-detection.md](market-mechanics/regime-detection.md) | How to detect bull/bear/choppy regimes, D.E. Shaw 3-state model | HIGH | 2026-06-01 |
| [market-mechanics/risk-management.md](market-mechanics/risk-management.md) | Kelly criterion, volatility targeting, LTCM failure modes to avoid | HIGH | 2026-06-01 |

### Signal Library (agent reads before scoring)
| File | Topic | Confidence | Sample Size |
|---|---|---|---|
| [signal-library/signal-principles.md](signal-library/signal-principles.md) | How to evaluate, combine, and decay-track signals | HIGH | Sourced from WorldQuant/RenTech |
| [signal-library/proven-signals.md](signal-library/proven-signals.md) | 10 proven signals with edges, dimension mappings, anti-signals, correlation matrix | HIGH â€” sourced from academic literature | 0 live |

### Event Patterns (agent reads before reacting to news)
| File | Topic | Confidence | Sample Size |
|---|---|---|---|
| [event-patterns/macro-events.md](event-patterns/macro-events.md) | Fed decisions, CPI, NFP, ISM, treasury auctions â†’ typical market reactions + agent scoring adjustments | HIGH â€” sourced research | 0 live |
| [event-patterns/earnings-patterns.md](event-patterns/earnings-patterns.md) | Pre/during/post earnings behavior; SUE/PEAD; sector-specific; earnings quality red flags; agent instructions | HIGH â€” sourced research | 0 live |

### Prediction Log (auto-updated by LearnerAgent)
| File | Purpose |
|---|---|
| [prediction-log/TEMPLATE.md](prediction-log/TEMPLATE.md) | Template for every new prediction hypothesis |

---

## How This Knowledge Base Works

1. **Agents read before acting.** Before ResearchAgent scrapes, before AnalystAgent scores, they search this knowledge base for relevant context.

2. **Confidence scores are earned, not assumed.** Every entry starts at its sourced confidence. As predictions resolve, LearnerAgent updates the confidence score based on actual outcomes.

3. **Evidence accumulates.** Each resolved prediction that touches a knowledge entry increments its `evidence_count`. More evidence â†’ more reliable confidence score.

4. **Nothing is deleted.** Wrong predictions stay in the log. They are the most valuable data.

5. **Human can add knowledge.** Vaibhav can drop notes, articles, theses into any file. Agents pick them up on next cycle.

---

## Core Principles (Non-Negotiable â€” Never Violate)

These are the lessons from funds that succeeded AND failed. Hardcoded.

1. **Run 5â€“15 uncorrelated weak signals, never one strong one.** Renaissance wins at 50.75% with thousands of small bets. Concentration kills.

2. **Detect regime before selecting signals.** Never run trend-following in a choppy regime. Never run mean-reversion in a trending regime. Always classify regime first.

3. **Volatility-target all positions.** Position size = target_risk / realized_volatility(20d). Never fixed size.

4. **Fractional Kelly only.** Use 25% of theoretical Kelly maximum. Model's true edge is always uncertain.

5. **Track signal decay from deployment date.** Every signal has live performance separate from backtest. When live diverges, investigate.

6. **Reject new signals correlated > 0.8 with existing signals.** Redundant signals add zero diversification.

7. **The LTCM check:** Before any trade, ask "what correlated event causes all positions to move against me simultaneously? How long can the account survive?" If no answer â†’ no trade.

8. **LLMs generate hypotheses. Statistics validate them.** Never trade a pattern an LLM identified without backtesting it first.
