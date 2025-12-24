import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export (one-page app). This app talks to the Python process over WebSocket.
  output: "export",
  images: { unoptimized: true },
  // Required for SharedArrayBuffer (AudioWorklet shared ring buffer).
  // NOTE: These headers must also be preserved by your OpenShift route/ingress.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
    ];
  },
};

export default nextConfig;
