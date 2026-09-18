/** @type {import('next').NextConfig} */

// When building the mobile shell (Capacitor), Next must emit a fully static
// site that can be bundled into the APK. Trigger with NEXT_EXPORT=1.
const isMobileExport = process.env.NEXT_EXPORT === '1';

const nextConfig = {
  reactStrictMode: true,
  ...(isMobileExport
    ? {
        output: 'export',
        // The native shell serves files from disk; there is no image server.
        images: { unoptimized: true },
        // Trailing slashes keep relative asset links working inside the WebView.
        trailingSlash: true,
      }
    : {
        // Proxy API calls to the backend in dev to avoid CORS + keep the token server-agnostic.
        async rewrites() {
          const backend = process.env.BACKEND_URL || 'http://localhost:4000';
          return [
            { source: '/api/:path*', destination: `${backend}/api/:path*` },
            { source: '/healthz', destination: `${backend}/healthz` },
            // Pretty public links the backend prints on QR cards and SMS invites.
            // They resolve to the query-param pages so the same URLs also work
            // in the static mobile export (which cannot have dynamic routes).
            { source: '/v/:code', destination: '/v?code=:code' },
            { source: '/confirm/:token', destination: '/confirm?token=:token' },
          ];
        },
      }),
};

export default nextConfig;
