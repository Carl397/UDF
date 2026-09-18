import jwt, { type Algorithm, type SignOptions } from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import type { Principal, Role } from './permissions.js';

/**
 * Access tokens are short-lived JWTs. Dev/test sign with a shared HS256 secret;
 * production signs with RS256 (private key) and verifies with the public key —
 * see config/env.ts, which resolves `env.jwtAlg` and guarantees the matching key
 * material exists. Refresh tokens are opaque, random, and stored hashed in the
 * DB so they can be revoked server-side.
 */

const ALG = env.jwtAlg as Algorithm;

/** Key used to SIGN: the RS256 private key, or the HS256 shared secret. */
function signingKey(): string {
  return ALG === 'RS256' ? (env.JWT_PRIVATE_KEY as string) : (env.JWT_SECRET as string);
}

/** Key used to VERIFY: the RS256 public key, or the HS256 shared secret. */
function verificationKey(): string {
  return ALG === 'RS256' ? (env.JWT_PUBLIC_KEY as string) : (env.JWT_SECRET as string);
}

export interface AccessTokenClaims extends Principal {
  jti: string;
  /**
   * Token version at mint time. `authenticate` compares it to the user's live
   * `token_version`; a lower value means the token was revoked (ban/suspend/
   * password reset) and is rejected before its natural expiry.
   */
  tv?: number;
  iat?: number;
  exp?: number;
}

export function signAccessToken(p: Principal, tv?: number): string {
  const jti = randomUUID();
  const payload: AccessTokenClaims = { ...p, jti, ...(tv != null ? { tv } : {}) };
  const options: SignOptions = {
    algorithm: ALG,
    expiresIn: env.JWT_EXPIRES_IN as SignOptions['expiresIn'],
    issuer: 'party-platform',
    audience: 'party-platform-api',
  };
  return jwt.sign(payload as object, signingKey(), options);
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  const decoded = jwt.verify(token, verificationKey(), {
    algorithms: [ALG],
    issuer: 'party-platform',
    audience: 'party-platform-api',
  });
  if (typeof decoded === 'string') {
    throw new Error('Unexpected JWT payload type');
  }
  return decoded as unknown as AccessTokenClaims;
}

/** Generate a high-entropy opaque refresh token. */
export function generateRefreshToken(): string {
  return randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
}

export function refreshExpiry(): Date {
  const d = new Date();
  d.setDate(d.getDate() + env.REFRESH_TOKEN_TTL_DAYS);
  return d;
}

export type { Role };
