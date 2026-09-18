import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler } from '../../http/asyncHandler.js';
import * as svc from './service.js';

/**
 * Public petitions surface, mounted at /api/public/petitions:
 *   GET  /            open petitions with signature counts
 *   POST /:id/sign    a member signs using their public party code
 */
export const petitionsRouter = Router();

/** Signing is public-but-member-keyed, so give it its own modest budget. */
const signLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'too_many_requests', message: 'Too many signature attempts — try later' } },
});

const signSchema = z.object({
  publicCode: z.string().min(4, 'A party code is required'),
});

petitionsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ items: await svc.listOpenPetitions() });
  }),
);

petitionsRouter.post(
  '/:id/sign',
  signLimiter,
  asyncHandler(async (req, res) => {
    const parsed = signSchema.parse(req.body);
    const result = await svc.signPetition(req.params.id!, parsed.publicCode);
    res.json(result);
  }),
);
