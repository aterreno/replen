import type { NextConfig } from "next";

const config: NextConfig = {
  // Vercel packages the app itself; standalone output is for self-hosted containers.
  output: process.env.VERCEL ? undefined : "standalone",
  poweredByHeader: false,
  devIndicators: false,
  transpilePackages: ["@replen/contracts"],
};

export default config;
