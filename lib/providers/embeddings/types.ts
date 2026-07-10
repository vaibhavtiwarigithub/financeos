export type EmbedInputType = "document" | "query";

export interface EmbeddingProvider {
  readonly name: string;
  readonly dim: number;
  isAvailable(): boolean;
  /** Returns vectors aligned to input texts, or null on failure (graceful degradation). */
  embed(texts: string[], inputType: EmbedInputType): Promise<number[][] | null>;
}
