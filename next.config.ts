import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
