import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow a build to target a scratch directory while `next dev` is watching
  // .next. Building into the watched directory has corrupted it twice.
  ...(process.env.NEXT_BUILD_DIST_DIR ? { distDir: process.env.NEXT_BUILD_DIST_DIR } : {}),
  // The owner-only System Reference route reads a fixed allowlist of repository
  // Markdown files at runtime. Include those files in the Vercel function bundle;
  // without this, local development succeeds while the deployed function returns 503.
  outputFileTracingIncludes: {
    "/api/system-reference/\\[document\\]": [
      "./ARCHITECTURE.md",
      "./SYSTEM_OVERVIEW.md",
      "./PROJECT_DECISIONS.md",
      "./docs/arch/**/*.md",
      "./features/shadow-registry/FEATURE_ARCHITECTURE.md",
      "./features/local-historical-replay/FEATURE_ARCHITECTURE.md",
    ],
  },
  webpack: (config) => {
    config.module.rules.push({
      test: /\.mjs$/,
      include: /node_modules/,
      type: "javascript/auto",
    });
    // `next build` crashed on Node 24 with:
    //   TypeError: Cannot read properties of undefined (reading 'length')
    //     at WasmHash._updateWithBuffer (compiled/webpack/bundle5.js)
    // webpack's default `xxhash64` hashes through a WebAssembly memory view that
    // can detach on newer Node runtimes, so the buffer is undefined by the time
    // the hash reads it. This is a toolchain incompatibility, not app code — it
    // reproduced on a clean checkout with no local changes.
    //
    // sha256 uses Node's own crypto instead of the wasm path. Chunk hashes differ
    // from xxhash64 (a one-time cache bust) and hashing is marginally slower; both
    // are irrelevant next to the build not running at all. Safe to revisit once
    // Next ships a webpack build whose WasmHash tolerates Node 24.
    config.output = { ...config.output, hashFunction: "sha256" };
    return config;
  },
  // Baseline security headers on every response. X-Frame-Options DENY stops
  // clickjacking of the authenticated dashboard (including order approval);
  // nosniff blocks MIME sniffing; HSTS forces HTTPS.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          { key: "Permissions-Policy", value: "geolocation=(), microphone=(), camera=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
