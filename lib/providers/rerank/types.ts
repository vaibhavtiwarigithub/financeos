export interface RerankHit<T> {
  item: T;
  score: number;
}

export interface RerankProvider {
  readonly name: string;
  isAvailable(): boolean;
  rerank<T>(
    query: string,
    items: T[],
    toText: (item: T) => string,
    topK: number,
  ): Promise<RerankHit<T>[]>;
}
