// One explicitly invoked synthetic call; no app, credentials, real symbols or trading.
import { runClient } from './council-subscription-worker.mjs';
const [family, model] = process.argv.slice(2);
const prompt = 'Synthetic TEST-NO-REAL-ASSET transport test. Use only {"facts":{"as_of":"2026-10-10","growth":8}}. Return JSON matching the supplied schema: score 50, confidence 0.1, rationale "Synthetic transport test", bull_case "Synthetic growth", bear_case "No real asset", evidence_citations [{"claim":"Synthetic growth is 8","source":"facts.growth","as_of":"2026-10-10"}]. No tools, browsing or other actions.';
try {
  const result = await runClient(family, model, prompt);
  console.log(JSON.stringify(result));
} catch (e) { console.error(e.message); if (e.diagnostic) console.error(e.diagnostic); process.exitCode = 1; }
