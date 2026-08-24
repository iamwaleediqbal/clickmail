import type { NextConfig } from "next";

const config: NextConfig = {
  // Type and lint errors fail the build. A green deploy that skipped both is
  // not a signal, and this repo exists to be read as evidence.
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: false },
};

export default config;
