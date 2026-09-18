import { z } from 'zod';

export const createVerificationSchema = z.object({
  serviceRequestId: z.string().uuid(),
  verdict: z.enum(['fixed', 'not_fixed', 'partial']),
  note: z.string().max(5000).optional(),
  photoId: z.string().uuid().optional(),
});

export const listVerificationsQuery = z.object({
  serviceRequestId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
