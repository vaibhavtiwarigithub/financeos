export const MIN_COUNCIL_PARTICIPANTS = 1;
export const MAX_COUNCIL_PARTICIPANTS = 5;
export const MAX_COUNCIL_SYMBOLS_PER_MARKET_DAY = 5;
export const COUNCIL_PROVIDER_CALL_TIMEOUT_MS = 12_000;
export const COUNCIL_PROVIDER_CALL_BUDGET_PER_INVOCATION_MS = 165_000;

export function effectiveCouncilDebateRounds(participantCount: number, configuredRounds: number): number {
  return participantCount >= 2 ? Math.max(0, Math.min(3, Math.floor(configuredRounds))) : 0;
}

export function councilCallsPerSymbol(participantCount: number, debateRounds: number): number {
  const count = Math.max(1, Math.floor(participantCount));
  return count * (1 + effectiveCouncilDebateRounds(count, debateRounds)) + 1;
}

export function councilProviderTimeoutMs(participantCount: number, debateRounds: number): number {
  const calls = councilCallsPerSymbol(participantCount, debateRounds);
  return Math.max(1_000, Math.min(COUNCIL_PROVIDER_CALL_TIMEOUT_MS, Math.floor(COUNCIL_PROVIDER_CALL_BUDGET_PER_INVOCATION_MS / calls)));
}

export function validCouncilParticipants(
  value: unknown,
  isSupported: (model: string) => boolean,
  providerForModel: (model: string) => string | null,
): value is string[] {
  if (!Array.isArray(value) || value.length < MIN_COUNCIL_PARTICIPANTS || value.length > MAX_COUNCIL_PARTICIPANTS) return false;
  if (!value.every((model): model is string => typeof model === "string" && isSupported(model))) return false;
  if (new Set(value).size !== value.length) return false;
  return value.length === 1 || new Set(value.map(providerForModel).filter(Boolean)).size >= 2;
}

export function validCouncilConsensus(configuredParticipantCount: number, validForecastCount: number, providerCount: number): boolean {
  if (configuredParticipantCount === 1) return validForecastCount === 1 && providerCount === 1;
  return validForecastCount >= 2 && providerCount >= 2;
}

export function isValidCouncilSymbolLimit(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_COUNCIL_SYMBOLS_PER_MARKET_DAY;
}

export function limitCouncilCandidates<T>(candidates: T[], remainingSymbols: number, participantCount: number, debateRounds: number): T[] {
  const worstCaseCalls = councilCallsPerSymbol(participantCount, debateRounds);
  const timeoutMs = councilProviderTimeoutMs(participantCount, debateRounds);
  const runtimeBound = Math.floor(COUNCIL_PROVIDER_CALL_BUDGET_PER_INVOCATION_MS / (worstCaseCalls * timeoutMs));
  return candidates.slice(0, Math.max(0, Math.min(1, remainingSymbols, runtimeBound)));
}
