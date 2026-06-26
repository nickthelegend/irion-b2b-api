// Compact HMAC-SHA256 signed tokens for sessions + step-up approvals.
// (Self-contained — no JWT lib.) Secret from IRION_SESSION_SECRET.
import { createHmac, timingSafeEqual, createHash } from 'node:crypto';

function secret(): Buffer {
  const env = process.env.IRION_SESSION_SECRET;
  return createHash('sha256').update(env ?? 'irion-dev-session-secret').digest();
}
const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const dec = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

export type Scope = 'session' | 'stepup' | 'register' | 'login';
export interface Claims { sub: string; scope: Scope; [k: string]: unknown }

/** Issue a signed token. ttl in seconds. */
export function issue(claims: Claims, ttlSec = 3600): string {
  const now = Math.floor(Date.now() / 1000);
  const body = enc({ ...claims, iat: now, exp: now + ttlSec });
  const sig = createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** Verify + decode a token, or null if invalid/expired. */
export function verify(token: string | undefined | null): Claims | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret()).update(body).digest('base64url');
  try {
    const a = Buffer.from(sig); const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const claims = dec(body) as Claims & { exp?: number };
    if (typeof claims.exp === 'number' && claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch { return null; }
}
