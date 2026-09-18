import { z } from 'zod';

/** Query for the public geolocation ward+councillor lookup (FR-B). */
export const wardLookupQuery = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  /** Reported GPS accuracy in metres; >5 triggers client retry/fallback. */
  accuracyM: z.coerce.number().positive().optional(),
});
export type WardLookupQuery = z.infer<typeof wardLookupQuery>;

/** Member rating submission on a councillor log / project / patrol (FR-D5). */
export const createTransparencyRatingSchema = z.object({
  targetType: z.enum(['service_request', 'project', 'patrol', 'councillor']),
  targetId: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  /** Mandatory free-text reason when rating <= 2. */
  reason: z.string().min(1).max(2000).optional(),
});
export type CreateTransparencyRating = z.infer<typeof createTransparencyRatingSchema>;

/** Councillor stage-media upload for a project (before / during / after). */
export const uploadMediaSchema = z.object({
  /** data: URL (base64) of the captured asset. */
  dataUrl: z.string().min(16).max(8 * 1024 * 1024),
  captureMode: z.enum(['photo', 'video', 'voice_note', 'audio']).default('photo'),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  accuracyM: z.coerce.number().positive().optional(),
  projectId: z.string().uuid().optional(),
  stage: z.enum(['before', 'during', 'after']).optional(),
});
export type UploadMedia = z.infer<typeof uploadMediaSchema>;

/** A single captured attachment on a resident report. */
export const reportMediaSchema = z.object({
  /** data: URL (base64) of the captured photo / video / voice note. */
  dataUrl: z.string().min(16).max(8 * 1024 * 1024),
  captureMode: z.enum(['photo', 'video', 'voice_note', 'audio']).default('photo'),
});

/**
 * Resident → ward councillor report (FR: "send information to my councillor").
 * Location is optional; when present the ward is resolved from the point,
 * otherwise it falls back to the member's own ward.
 */
export const createResidentReportSchema = z.object({
  requestId: z.string().uuid().optional(),
  category: z.string().trim().min(1).max(40),
  message: z.string().trim().min(1).max(4000),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  accuracyM: z.coerce.number().positive().optional(),
  /** Optional explicit ward; otherwise resolved from geo or the member profile. */
  wardCode: z.string().max(64).optional(),
  media: z.array(reportMediaSchema).max(6).default([]),
}).refine((v) => (v.lat == null) === (v.lng == null), { message: 'Provide both latitude and longitude' });
export type CreateResidentReport = z.infer<typeof createResidentReportSchema>;

/**
 * Staff update of a resident report: move it through the lifecycle and/or write
 * follow-up feedback back to the resident. At least one field must be present.
 */
export const updateResidentReportSchema = z
  .object({
    status: z.enum(['submitted', 'acknowledged', 'in_progress', 'resolved', 'closed']).optional(),
    feedback: z.string().trim().min(1).max(4000).nullable().optional(),
    action: z.enum(['acknowledge', 'contact', 'follow_up', 'resolve', 'confirm', 'request_follow_up', 'close']).optional(),
    contactMethod: z.enum(['phone', 'email', 'sms', 'whatsapp', 'in_person', 'service_portal', 'other']).optional(),
    contactTarget: z.string().trim().min(1).max(200).optional(),
    contactMethodDetail: z.string().trim().min(1).max(200).optional(),
    internalNote: z.string().trim().min(1).max(4000).optional(),
    externalReference: z.string().trim().min(1).max(100).optional(),
    followUpAt: z.string().datetime({ offset: true }).nullable().optional(),
    expectedVersion: z.number().int().min(0).optional(),
    requestId: z.string().uuid().optional(),
  }).strict()
  .refine((v) => v.status !== undefined || v.feedback !== undefined || v.action !== undefined || v.externalReference !== undefined || v.internalNote !== undefined, {
    message: 'Provide an action, status, reference, or feedback',
  });
export type UpdateResidentReport = z.infer<typeof updateResidentReportSchema>;
