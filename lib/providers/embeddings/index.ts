// Embedding provider factory.
// Swap provider by setting EMBEDDING_PROVIDER=jina|openai in env (default: jina).
// Add a custom provider: registerEmbeddingProvider("myco", () => new MyProvider()).
export * from "./types";

import { JinaEmbeddingProvider }   from "./jina";
import { OpenAIEmbeddingProvider } from "./openai";
import type { EmbeddingProvider }  from "./types";

const _registry: Record<string, () => EmbeddingProvider> = {
  jina:   () => new JinaEmbeddingProvider(),
  openai: () => new OpenAIEmbeddingProvider(),
};

let _singleton: EmbeddingProvider | null = null;

export function getEmbeddingProvider(): EmbeddingProvider {
  if (_singleton) return _singleton;
  const name = (process.env.EMBEDDING_PROVIDER ?? "jina").toLowerCase().trim();
  const factory = _registry[name];
  if (!factory) {
    throw new Error(
      `Unknown EMBEDDING_PROVIDER: "${name}". Valid: ${Object.keys(_registry).join(", ")}`
    );
  }
  _singleton = factory();
  return _singleton;
}

/** Register a new provider (also clears the cached singleton). */
export function registerEmbeddingProvider(name: string, factory: () => EmbeddingProvider): void {
  _registry[name.toLowerCase()] = factory;
  _singleton = null;
}
