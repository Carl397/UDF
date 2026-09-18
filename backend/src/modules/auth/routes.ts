import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler } from '../../http/asyncHandler.js';
import { authenticate, optionalAuthenticate } from '../../middleware/authenticate.js';
import { recordAudit } from '../../security/audit.js';
import { resendOnboardingOtp } from '../onboarding/service.js';
import * as service from './service.js';

/**
 * /api/auth — login, refresh, logout.
 * Login is aggressively rate-limited to blunt credential stuffing/brute force.
 */
export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'too_many_requests', message: 'Too many login attempts' } },
});

function ctx(req: any) {
  const deviceId = req.get('x-device-id');
  return {
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    deviceId: typeof deviceId === 'string' && deviceId.length > 0 ? deviceId.slice(0, 128) : null,
  };
}

authRouter.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const input = service.loginSchema.parse(req.body);
    const tokens = await service.login(input, ctx(req));
    res.json(tokens);
  }),
);

authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body ?? {};
    if (typeof refreshToken !== 'string') {
      res.status(400).json({ error: { code: 'bad_request', message: 'refreshToken required' } });
      return;
    }
    const tokens = await service.refresh(refreshToken, ctx(req));
    res.json(tokens);
  }),
);

/**
 * POST /auth/logout — revoke the refresh token so the server-side session dies
 * with the client's.
 *
 * `optionalAuthenticate`, deliberately not `authenticate`: logout MUST keep
 * succeeding when the access token is absent or expired (a user signing out
 * after 15 idle minutes would otherwise get a 401 and keep a live 7-day refresh
 * token), yet it must still be attributable when a session IS offered. Without
 * this middleware `req.principal` was always undefined and the `auth.logout`
 * audit entry below was unreachable dead code — a POPIA §8 accountability gap
 * in the one action that proves a session ended.
 */
authRouter.post(
  '/logout',
  optionalAuthenticate,
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body ?? {};
    if (typeof refreshToken === 'string') {
      await service.logout(refreshToken);
    }
    if (req.principal) {
      await recordAudit({
        action: 'auth.logout',
        actorId: req.principal.sub,
        actorRole: req.principal.role,
        ...ctx(req),
      });
    }
    res.status(204).end();
  }),
);

/**
 * POST /auth/terms/accept — record acceptance of the current Terms version.
 * Authenticated: the app shows the T&C gate after login and calls this.
 */
authRouter.post(
  '/terms/accept',
  authenticate,
  asyncHandler(async (req, res) => {
    const result = await service.acceptTerms(req.principal!.sub, ctx(req));
    res.json(result);
  }),
);

/**
 * POST /auth/change-password — set a new password (authenticated).
 * Clears the must-change-password gate, revokes every other session (token
 * version bump + refresh-token revocation) and returns a fresh token pair so the
 * caller stays signed in. A wrong current password is a 400, not a 401, so it
 * never trips the client's silent-refresh retry. Rate-limited to blunt guessing.
 */
const changePasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'too_many_requests', message: 'Too many password-change attempts' } },
});

authRouter.post(
  '/change-password',
  changePasswordLimiter,
  authenticate,
  asyncHandler(async (req, res) => {
    const input = service.changePasswordSchema.parse(req.body);
    const result = await service.changePassword(req.principal!.sub, input, ctx(req));
    res.json(result);
  }),
);

/**
 * POST /auth/otp/resend — re-issue the onboarding OTP + starter pack (FR-P5).
 * Public but tightly rate-limited so a member waiting on an email cannot spam the
 * mailer. Enumeration-safe: always 202 with the same body whether or not the
 * address maps to a provisionable account (the service is silent on the reason).
 * The OTP itself is only ever delivered to the sealed address, never returned.
 */
const resendOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'too_many_requests', message: 'Too many resend attempts — try again later' } },
});

const resendOtpSchema = z.object({ email: z.string().email() });

authRouter.post(
  '/otp/resend',
  resendOtpLimiter,
  asyncHandler(async (req, res) => {
    const { email } = resendOtpSchema.parse(req.body);
    await resendOnboardingOtp(email, ctx(req));
    res.status(202).json({
      accepted: true,
      message: 'If that email is awaiting sign-in setup, a fresh code is on its way.',
    });
  }),
);
