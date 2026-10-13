// Dependency-free constants shared by server-side evaluation and the client-side Learning panel. Keep this file free of imports:
// the panel bundle must never pull in node-only modules (the evaluator transitively imports node:crypto).
export const REDUNDANCY_CORRELATION = 0.6;
