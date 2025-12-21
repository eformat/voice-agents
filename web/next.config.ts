import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export (one-page app). This app talks to the Python process over WebSocket.
  output: "export",
  images: { unoptimized: true },
};

export default nextConfig;
