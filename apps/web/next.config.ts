import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@clip/shared"],
  serverExternalPackages: ["better-sqlite3"],
  poweredByHeader: false,
};

export default nextConfig;
