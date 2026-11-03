import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The "@/" imports the app uses, so route tests can load the real route files.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
});
