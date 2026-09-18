import { z } from 'zod';

export const createParticipationSchema = z.object({
  title: z.string().min(1).max(300),
  subject: z.string().max(500).optional(),
  body: z.string().max(50000).optional(),
  scope: z.enum(['ward', 'region', 'metro', 'national']).default('ward'),
  wardCode: z.string().max(32).optional(),
  regionCode: z.string().max(32).optional(),
  opensAt: z.coerce.date(),
  closesAt: z.coerce.date(),
});

export const createParticipationCommentSchema = z.object({
  comment: z.string().min(1).max(10000),
  rating: z.number().int().min(1).max(5).optional(),
  reasonIfLow: z.string().min(10).max(2000).optional(),
});

export const listParticipationsQuery = z.object({
  wardCode: z.string().max(32).optional(),
  status: z.enum(['open', 'closed', 'submitted', 'answered']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
