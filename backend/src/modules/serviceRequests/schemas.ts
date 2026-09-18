import { z } from 'zod';

export const srCategory = z.enum([
  'water', 'power', 'roads', 'sanitation', 'housing', 'safety', 'health', 'education', 'other',
]);

export const srSeverity = z.enum(['info', 'report', 'urgent']);

export const srStatus = z.enum([
  'reported', 'triaged', 'logged', 'submitted', 'in_progress',
  'resolved', 'verified', 'closed', 'escalated', 'duplicate', 'reopened',
]);

/** Independent follow-up sub-state (migration 017 `sr_follow_up`). */
export const srFollowUp = z.enum(['none', 'awaiting', 'done', 'engaged']);

/** A captured attachment on a new case (photo / video / voice note). */
export const caseMediaSchema = z.object({
  dataUrl: z.string().min(16).max(8 * 1024 * 1024),
  captureMode: z.enum(['photo', 'video', 'voice_note', 'audio']).default('photo'),
});

export const createServiceRequestSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  category: srCategory,
  severity: srSeverity.default('report'),
  wardCode: z.string().max(32).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  streetAddress: z.string().max(500).optional(),
  /** House / stand number read off the erf, alongside the geocoded address. */
  streetNumber: z.string().max(32).optional(),
  media: z.array(caseMediaSchema).max(10).optional(),
});

export const updateServiceRequestSchema = z.object({
  status: srStatus.optional(),
  municipalityRef: z.string().max(100).optional(),
  note: z.string().max(2000).optional(),
  followUpState: srFollowUp.optional(),
});

export const listServiceRequestsQuery = z.object({
  ward: z.string().optional(),
  category: srCategory.optional(),
  status: srStatus.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
