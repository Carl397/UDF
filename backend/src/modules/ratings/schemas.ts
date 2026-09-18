import { z } from 'zod';

export const createRatingSchema = z.object({
  targetType: z.enum(['service_request', 'project', 'participation', 'councillor']),
  targetId: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  reason: z.string().min(10).max(2000).optional(),
});

export const listRatingsQuery = z.object({
  targetType: z.enum(['service_request', 'project', 'participation', 'councillor']).optional(),
  targetId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
