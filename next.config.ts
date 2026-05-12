import type { NextConfig } from "next";

const splitCsv = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const normalizeAllowedDevOrigin = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    return parsed.host;
  } catch {
    return trimmed.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  }
};

const unique = (values: string[]) => Array.from(new Set(values.filter(Boolean)));

const buildAllowedDevOrigins = () => {
  const configuredOrigins = splitCsv(process.env.CLAW3D_ALLOWED_DEV_ORIGINS).map(
    normalizeAllowedDevOrigin
  );
  const webServerDomain = (
    process.env.WEB_SERVER_DOMAIN ||
    process.env.WEB_SERVER_DOAMIN ||
    ""
  )
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "");

  return unique([
    ...configuredOrigins,
    ...(webServerDomain ? [`claw3d.${webServerDomain}`, `openclaw.${webServerDomain}`] : []),
  ]);
};

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
      "img-src 'self' data: blob: http: https:",
      "font-src 'self' data: https:",
      "style-src 'self' 'unsafe-inline' https:",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
      "connect-src 'self' ws: wss: http: https:",
      "media-src 'self' blob: data: http: https:",
      "worker-src 'self' blob:",
      "object-src 'none'",
    ].join("; "),
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "X-Frame-Options",
    value: "SAMEORIGIN",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(self), geolocation=(), browsing-topics=()",
  },
  {
    key: "Cross-Origin-Resource-Policy",
    value: "same-origin",
  },
];

if (process.env.NODE_ENV === "production") {
  securityHeaders.push({
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  });
}

const nextConfig: NextConfig = {
  allowedDevOrigins: buildAllowedDevOrigins(),
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
