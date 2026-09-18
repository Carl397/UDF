import { z } from 'zod';

export const bulletinKind = z.enum(['news', 'vacancy', 'completed_work', 'vote', 'announcement']);
export type BulletinKind = z.infer<typeof bulletinKind>;

export const createBulletinSchema = z.object({
  kind: bulletinKind.default('news'),
  title: z.string().min(1).max(300),
  body: z.string().max(50000).optional(),
  wardCode: z.string().max(32).optional(),
  serviceRequestId: z.string().uuid().optional(),
  publicParticipationId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
});

export const updateBulletinSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  body: z.string().max(50000).optional(),
  status: z.enum(['draft', 'published', 'taken_down']).optional(),
});

export const listBulletinsQuery = z.object({
  wardCode: z.string().max(32).optional(),
  kind: bulletinKind.optional(),
  status: z.enum(['draft', 'published', 'taken_down']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
