import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // NOTE: We run this as a Next server (e.g. `next dev` / `next start`) so we can send
  // COOP/COEP headers required for SharedArrayBuffer.
  images: { unoptimized: true },
};

export default nextConfig;
