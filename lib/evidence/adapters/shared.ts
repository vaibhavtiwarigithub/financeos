// Canonical Evidence Router — shared adapter guards.
//
// Extracted so every adapter validates payload shape identically. Pure; no I/O.

// Reject prototype-pollution keys before we ever treat an object as a payload.
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function hasForbiddenKeys(obj: object): boolean {
  return Object.keys(obj).some((k) => FORBIDDEN_KEYS.has(k));
}

export function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}
