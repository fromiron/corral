import { randomBytes, timingSafeEqual } from 'node:crypto';

// Minimal local security boundary (C-055, Spec §10.2). A page on another site can reach a
// loopback port, so nothing is trusted for being local: Host and Origin are checked, state
// changes need the Studio origin, and every API call needs a session that only the person
// holding the printed bootstrap link can open. No CORS: other origins get no readable answer.

export const SESSION_COOKIE = 'corral_session';

export const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    // HTML result previews are framed from this origin only (CR-009).
    "frame-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'x-frame-options': 'DENY',
};

/**
 * An HTML result preview (CR-009): a sandboxed document with an opaque origin, no scripts,
 * forms or network, inline styles and data: images only. Only Studio may frame it.
 */
export const PREVIEW_HEADERS: Record<string, string> = {
  'content-security-policy': [
    'sandbox',
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    'img-src data:',
    'font-src data:',
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'x-frame-options': 'SAMEORIGIN',
};

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function assertLoopback(host: string) {
  if (!LOOPBACK.has(host)) {
    throw new Error(`Corral listens on 127.0.0.1 only; refusing to bind ${host}`);
  }
}

export interface Boundary {
  hostAllowed(host: string | undefined): boolean;
  originAllowed(origin: string | undefined): boolean;
}

export function boundaryFor(port: () => number, extraOrigins: readonly string[] = []): Boundary {
  return {
    hostAllowed(host) {
      const p = port();
      return host === `127.0.0.1:${p}` || host === `localhost:${p}` || host === `[::1]:${p}`;
    },
    originAllowed(origin) {
      const p = port();
      return (
        origin === `http://127.0.0.1:${p}` ||
        origin === `http://localhost:${p}` ||
        (origin !== undefined && extraOrigins.includes(origin))
      );
    },
  };
}

/** One bootstrap token, redeemable once, for any number of sessions sharing its cookie. */
export class Sessions {
  private token: Buffer | null;
  private readonly sessions = new Map<string, string>();

  constructor(token: string) {
    this.token = Buffer.from(token, 'utf-8');
  }

  redeem(candidate: unknown): string | null {
    if (!this.token || typeof candidate !== 'string') return null;
    const given = Buffer.from(candidate, 'utf-8');
    if (given.length !== this.token.length || !timingSafeEqual(given, this.token)) return null;
    this.token = null;
    const session = randomBytes(32).toString('hex');
    this.sessions.set(session, randomBytes(32).toString('hex'));
    return session;
  }

  csrfToken(cookieHeader: string | undefined): string | null {
    return this.sessions.get(parseCookies(cookieHeader)[SESSION_COOKIE] ?? '') ?? null;
  }

  validCsrf(cookieHeader: string | undefined, candidate: unknown): boolean {
    const token = this.csrfToken(cookieHeader);
    if (!token || typeof candidate !== 'string') return false;
    const given = Buffer.from(candidate);
    const expected = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  valid(cookieHeader: string | undefined): boolean {
    const session = parseCookies(cookieHeader)[SESSION_COOKIE];
    return session !== undefined && this.sessions.has(session);
  }
}

export function newBootstrapToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sessionCookie(session: string): string {
  return `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return cookies;
}

/** One local workspace session: fixed windows avoid an attacker-controlled key map. */
export class RequestLimiter {
  private began = Number.NEGATIVE_INFINITY;
  private reads = 0;
  private writes = 0;
  private readonly now: () => number;
  constructor(now: () => number) {
    this.now = now;
  }
  allow(write: boolean): boolean {
    const now = this.now();
    if (now - this.began >= 60_000) {
      this.began = now;
      this.reads = 0;
      this.writes = 0;
    }
    return write ? ++this.writes <= 120 : ++this.reads <= 1200;
  }
}
