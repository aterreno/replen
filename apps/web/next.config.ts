import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  devIndicators: false,
  transpilePackages: ["@replen/contracts"],
};

export default config;
