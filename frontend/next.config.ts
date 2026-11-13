import type { NextConfig } from "next";

/**
 * Deployment (Phase 16): the browser talks to the backend through this frontend's own origin.
 * With BACKEND_ORIGIN set (e.g. https://<service>.onrender.com) and NEXT_PUBLIC_API_URL=/api,
 * every /api/* request is proxied to the backend, so the HttpOnly SameSite=Lax session cookie is a
 * first-party cookie of the frontend's domain and the Origin header the backend checks is the
 * frontend's own (CORS_ORIGIN). Without BACKEND_ORIGIN (local development) nothing is rewritten and
 * the client calls NEXT_PUBLIC_API_URL directly, as before.
 */
const backendOrigin = process.env.BACKEND_ORIGIN?.trim().replace(/\/+$/, "");

const nextConfig: NextConfig = {
  async rewrites() {
    if (!backendOrigin) return [];
    return [{ source: "/api/:path*", destination: `${backendOrigin}/api/:path*` }];
  },
};

export default nextConfig;
