import { z } from 'zod';

export const createPatrolSchema = z.object({
  wardCode: z.string().max(32).optional(),
  mode: z.enum(['walk', 'drive']).default('walk'),
  purpose: z.string().max(500).optional(),
  plannedDate: z.coerce.date().optional(),
});

export const addTrackPointSchema = z.object({
  seq: z.number().int().min(0),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(100).optional(),
  speed: z.number().min(0).optional(),
  recordedAt: z.coerce.date(),
  streetAddress: z.string().max(500).optional(),
});

export const addPatrolStopSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  streetAddress: z.string().max(500).optional(),
  serviceRequestId: z.string().uuid().optional(),
  title: z.string().max(500).optional(),
  note: z.string().max(2000).optional(),
  photoId: z.string().uuid().optional(),
  callStatus: z.enum(['call_logged', 'in_progress', 'waiting_on_feedback', 'completed']).default('call_logged'),
  arrivedAt: z.coerce.date(),
  requestId: z.string().uuid().optional(),
  contactMethod: z.enum(['phone','email','sms','whatsapp','in_person','service_portal','other']).optional(),
  followUpAt: z.string().datetime({ offset: true }).nullable().optional(),
}).refine((v) => v.callStatus !== 'completed' || !!v.note?.trim(), {
  message: 'Completion outcome is required', path: ['note'],
});

export const updatePatrolStopSchema = z.object({
  title: z.string().max(500).optional(),
  note: z.string().max(2000).optional(),
  callStatus: z.enum(['call_logged', 'in_progress', 'waiting_on_feedback', 'completed']).optional(),
  contactMethod: z.enum(['phone','email','sms','whatsapp','in_person','service_portal','other']).optional(),
  followUpAt: z.string().datetime({ offset: true }).nullable().optional(),
});

/** CRM edit of the patrol record itself (ward, mode, purpose, summary, status). */
export const updatePatrolSchema = z.object({
  wardCode: z.string().max(32).optional(),
  mode: z.enum(['walk', 'drive']).optional(),
  purpose: z.string().max(500).nullable().optional(),
  summary: z.string().max(5000).nullable().optional(),
  status: z.enum(['planned', 'active', 'completed', 'cancelled']).optional(),
  distanceM: z.number().min(0).nullable().optional(),
});

/** A captured attachment on the patrol overview report (photo / video / voice note). */
export const patrolMediaSchema = z.object({
  dataUrl: z.string().min(16).max(8 * 1024 * 1024),
  captureMode: z.enum(['photo', 'video', 'voice_note', 'audio']).default('photo'),
});

export const endPatrolSchema = z.object({
  requestId: z.string().uuid().optional(),
  distanceM: z.number().min(0).optional(),
  summary: z.string().max(5000).optional(),
  media: z.array(patrolMediaSchema).max(10).optional(),
});

export const listPatrolsQuery = z.object({
  wardCode: z.string().max(32).optional(),
  status: z.enum(['planned', 'active', 'completed', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
