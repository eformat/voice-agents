import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Required for SharedArrayBuffer / AudioWorklet SAB ring buffer.
// Must be present on the main document and all subresources (/_next/*) to ensure
// `globalThis.crossOriginIsolated === true`.
export function middleware(_req: NextRequest) {
  const res = NextResponse.next();
  res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  res.headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  return res;
}

export const config = {
  matcher: ["/((?!api).*)"],
};
