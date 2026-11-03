import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The "@/" imports the app uses, so route tests can load the real route files.
// @x402/next imports "next/server" without an extension, which plain Node can't resolve;
// letting Vite handle that package fixes it.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  test: { server: { deps: { inline: ["@x402/next"] } } },
});
