import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { securityHeaders } from '../securityHeaders.js';

describe('securityHeaders', () => {
  it('sends a strict CSP and no referrer on every response, errors included', async () => {
    const app = Fastify();
    securityHeaders(app);
    app.get('/page', async () => 'ok');

    for (const url of ['/page', '/missing']) {
      const res = await app.inject(url);
      const csp = res.headers['content-security-policy'] as string;
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain('unsafe');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    }
  });
});
