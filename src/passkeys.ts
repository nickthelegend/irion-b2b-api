// Passkey (WebAuthn) registration + authentication via @simplewebauthn/server.
// Works with Mac Touch ID, Windows Hello, and any FIDO2 authenticator; the
// passkey syncs across the user's devices (iCloud / Google / Windows). The
// CHALLENGE is carried in a signed begin-token (session.ts), so this layer is
// stateless — no server-side challenge map to lose on restart.
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type { StoredPasskey } from './accounts.js';

const rpName = process.env.IRION_RP_NAME ?? 'Irion';
const rpID = process.env.IRION_RP_ID ?? 'localhost';
const expectedOrigin = (process.env.IRION_RP_ORIGIN ?? 'http://localhost:3004,http://localhost:3000')
  .split(',').map((s) => s.trim());

export interface NewPasskey { id: string; publicKey: string; counter: number; transports?: string[] }

/** Begin registration — returns options for the browser's navigator.credentials.create(). */
export async function regOptions(p: { userId: string; userName: string; displayName: string; exclude?: StoredPasskey[] }) {
  return generateRegistrationOptions({
    rpName, rpID,
    userName: p.userName,
    userDisplayName: p.displayName,
    userID: new TextEncoder().encode(p.userId) as any,
    attestationType: 'none',
    excludeCredentials: (p.exclude ?? []).map((c) => ({ id: c.id, transports: c.transports as any })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
}

/** Verify a registration response; returns the credential to persist, or null. */
export async function verifyReg(response: any, expectedChallenge: string): Promise<NewPasskey | null> {
  const v = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin, expectedRPID: rpID, requireUserVerification: false });
  if (!v.verified || !v.registrationInfo) return null;
  const c = v.registrationInfo.credential;
  return { id: c.id, publicKey: Buffer.from(c.publicKey).toString('base64'), counter: c.counter, transports: c.transports };
}

/** Begin authentication — options for the browser's navigator.credentials.get(). */
export async function authOptions(passkeys: StoredPasskey[]) {
  return generateAuthenticationOptions({
    rpID,
    allowCredentials: passkeys.map((c) => ({ id: c.id, transports: c.transports as any })),
    userVerification: 'preferred',
  });
}

/** Verify an authentication response against a stored passkey; returns the new counter, or null. */
export async function verifyAuth(response: any, expectedChallenge: string, pk: StoredPasskey): Promise<number | null> {
  const v = await verifyAuthenticationResponse({
    response, expectedChallenge, expectedOrigin, expectedRPID: rpID, requireUserVerification: false,
    credential: { id: pk.id, publicKey: new Uint8Array(Buffer.from(pk.publicKey, 'base64')), counter: pk.counter, transports: pk.transports as any },
  });
  return v.verified ? v.authenticationInfo.newCounter : null;
}

export { rpID, expectedOrigin };
