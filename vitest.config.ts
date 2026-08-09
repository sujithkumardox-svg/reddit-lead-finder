import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * Minimal Vitest config. Only exists so the small set of unit tests added
 * alongside the Scanner -> Matching Engine connection can run - it does
 * not change how the app itself builds or runs (Next.js keeps using its
 * own bundler).
 *
 * `resolve.alias` mirrors the `@/*` path alias from `tsconfig.json` so
 * test files can import the same modules the app does.
 *
 * Vitest runs test files under its SSR pipeline, where `server-only`
 * (imported by server-side services/handlers) would otherwise be
 * externalized straight to Node's own module resolution and throw ("This
 * module cannot be imported from a Client Component module."). Keeping it
 * out of `ssr.noExternal` and setting `ssr.resolve.conditions` to include
 * `react-server` makes it resolve through Vite's own pipeline to its
 * no-op export instead - the same condition Next.js's own React Server
 * Components bundler sets.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  ssr: {
    noExternal: ["server-only"],
    resolve: {
      conditions: ["react-server"],
    },
  },
  test: {
    environment: "node",
  },
});
