import type { FastifyInstance } from 'fastify';

// The UI loads nothing from elsewhere (fonts and icons are bundled) and has no inline scripts, so
// the browser can refuse anything else: even if repo- or chart-controlled text (CVE titles,
// changelogs) ended up as markup or a javascript: link, it couldn't run. data: covers assets Vite
// inlines. frame-ancestors keeps the app out of other sites' iframes (clickjacking).
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (_request, reply) => {
    reply.header('content-security-policy', CONTENT_SECURITY_POLICY);
    // Links out (GitHub releases, advisories) don't tell those sites this instance's scan URLs
    reply.header('referrer-policy', 'no-referrer');
  });
}
