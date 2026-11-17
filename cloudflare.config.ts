import { bindings, defineConfig, defineWorker } from "cf/config";
import { createWorkersCacheConfig } from "@vinext/cloudflare/cache/config";

const workersCache = await createWorkersCacheConfig();

export default defineConfig({
  worker: defineWorker({
    ...workersCache,
    name: "kairos",
    entrypoint: "vinext/server/fetch-handler",
    compatibilityDate: "2026-11-17",
    assets: {
      htmlHandling: "none",
      notFoundHandling: "none",
      runWorkerFirst: ["/*", "!/_next/static/*", "!/*/_next/static/*"],
    },
    env: {
      ASSETS: bindings.assets(),
      ...workersCache.env,
    },
    exports: workersCache.exports,
  }),
});
