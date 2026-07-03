import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  webpack: (config) => {
    config.module.rules.push({
      test: /\.mjs$/,
      include: /node_modules/,
      type: "javascript/auto",
    });
    return config;
  },
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const withPWA = require("next-pwa")({
  dest: "public",
  disable: process.env.NODE_ENV === "development" || process.env.DISABLE_PWA === "true",
  register: true,
  skipWaiting: true,
  runtimeCaching: [
    // Next.js app chunks are content-hash addressed — always fetch fresh, never serve stale
    {
      urlPattern: /\/_next\/static\//i,
      handler: "NetworkFirst",
      options: { cacheName: "next-static", networkTimeoutSeconds: 10, expiration: { maxEntries: 200, maxAgeSeconds: 24 * 60 * 60 } },
    },
    {
      urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
      handler: "CacheFirst",
      options: { cacheName: "google-fonts", expiration: { maxEntries: 4, maxAgeSeconds: 365 * 24 * 60 * 60 } },
    },
    {
      urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
      handler: "CacheFirst",
      options: { cacheName: "gstatic-fonts", expiration: { maxEntries: 4, maxAgeSeconds: 365 * 24 * 60 * 60 } },
    },
  ],
});

export default withPWA(nextConfig);
