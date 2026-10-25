import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false, // keeps dev screenshots clean
  cacheComponents: true,
  // Item files are read at runtime; make sure they ship with the functions that read them.
  outputFileTracingIncludes: {
    "/api/read": ["./content/**"],
    "/api/preview/[id]": ["./content/**"],
  },
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
