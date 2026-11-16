// Next.js resolves the server-only marker in its own bundler. Vitest aliases
// it to this no-op module so Node tests can import server modules safely.
export {};
