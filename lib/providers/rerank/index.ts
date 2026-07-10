// Rerank provider factory.
// Swap by setting RERANK_PROVIDER=jina|cohere in env (default: jina).
// Add a custom provider: registerRerankProvider("myco", () => new MyProvider()).
export * from "./types";

import { JinaRerankProvider }   from "./jina";
import { CohereRerankProvider } from "./cohere";
import type { RerankProvider }  from "./types";

const _registry: Record<string, () => RerankProvider> = {
  jina:   () => new JinaRerankProvider(),
  cohere: () => new CohereRerankProvider(),
};

let _singleton: RerankProvider | null = null;

export function getRerankProvider(): RerankProvider {
  if (_singleton) return _singleton;
  const name = (process.env.RERANK_PROVIDER ?? "jina").toLowerCase().trim();
  const factory = _registry[name];
  if (!factory) {
    throw new Error(
      `Unknown RERANK_PROVIDER: "${name}". Valid: ${Object.keys(_registry).join(", ")}`
    );
  }
  _singleton = factory();
  return _singleton;
}

export function registerRerankProvider(name: string, factory: () => RerankProvider): void {
  _registry[name.toLowerCase()] = factory;
  _singleton = null;
}
