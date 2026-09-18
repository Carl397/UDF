import { z } from 'zod';

export const projectStage = z.enum(['idea', 'concept', 'approved', 'funded', 'in_progress', 'delivered', 'blocked']);
export type ProjectStage = z.infer<typeof projectStage>;

export const createProjectSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(50000).optional(),
  scope: z.enum(['ward', 'region', 'metro']).default('ward'),
  wardCode: z.string().max(32).optional(),
  regionCode: z.string().max(32).optional(),
  stage: projectStage.default('idea'),
  budget: z.number().min(0).optional(),
  owner: z.string().max(200).optional(),
});

export const createMilestoneSchema = z.object({
  title: z.string().min(1).max(300),
  dueDate: z.coerce.date().optional(),
  status: z.enum(['pending', 'in_progress', 'done', 'blocked']).default('pending'),
  seq: z.number().int().min(0).default(0),
});

export const listProjectsQuery = z.object({
  wardCode: z.string().max(32).optional(),
  stage: projectStage.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
