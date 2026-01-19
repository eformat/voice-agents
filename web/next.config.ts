import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // NOTE: We run this as a Next server (e.g. `next dev` / `next start`) so we can send
  // COOP/COEP headers required for SharedArrayBuffer.
  basePath: "/app",
  images: { unoptimized: true },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          { key: "Origin-Agent-Cluster", value: "?1" },
        ],
      },
    ];
  },
};

export default nextConfig;
