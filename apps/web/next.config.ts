import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @waypoint/correlation ships its .ts source directly (no build step, by
  // design -- see its package.json) so Next has to compile it itself rather
  // than treating it as pre-built library code under node_modules.
  transpilePackages: ["@waypoint/correlation"],
};

export default nextConfig;
