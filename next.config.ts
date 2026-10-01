import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

// Content Security Policy without nonces (see node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md).
// The browser only ever talks to this app: sign-in, data and price checks all go through our own API routes, and
// fonts are self-hosted by next/font. External links (Solscan, DexScreener, GMGN) are plain navigations.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  // A private team tool: keep it out of search engines (robots.txt says the same).
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

const config: NextConfig = {
  // Database drivers stay out of the bundle; PGlite (WebAssembly, local/test only) is never loaded in production.
  serverExternalPackages: ["postgres", "@electric-sql/pglite"],
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/(.*)", headers: securityHeaders },
      // API answers (temporary passwords, invite codes, wallet data) are never stored by browsers or proxies.
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store, max-age=0" }] },
    ];
  },
};

export default config;
