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
  captureMode: z.enum(['photo', 'video', 'voice_note', 'audio', 'document']).default('photo'),
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
 * Mainland South Africa bounding box (inclusive). Land borders run roughly
 * lat -22.1 (Limpopo north) to -34.99 (Cape Agulhas) and lng 16.45 (Orange
 * river mouth) to 32.95 (Kosi Bay east). Anything outside this rectangle is
 * not a place we can route a ward report to, so we reject it up front with a
 * clear message rather than the generic "no supported ward" the PostGIS lookup
 * would otherwise return.
 */
export const SA_BBOX = { latMin: -34.99, latMax: -22.1, lngMin: 16.45, lngMax: 32.95 } as const;

function inSouthAfrica(lat: number | undefined, lng: number | undefined): boolean {
  if (lat == null || lng == null) return true; // no coords: ward falls back to profile
  return lat >= SA_BBOX.latMin && lat <= SA_BBOX.latMax && lng >= SA_BBOX.lngMin && lng <= SA_BBOX.lngMax;
}

/**
 * Resident → ward councillor report (FR: "send information to my councillor").
 * Location is optional; when present the ward is resolved from the point,
 * otherwise it falls back to the member's own ward. Coordinates, when given,
 * must be inside South Africa — UDF resident reporting has no coverage abroad.
 */
export const createResidentReportSchema = z
  .object({
    requestId: z.string().uuid().optional(),
    category: z.string().trim().min(1).max(40),
    message: z.string().trim().min(1).max(4000),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    accuracyM: z.coerce.number().positive().optional(),
    /** Optional explicit ward; otherwise resolved from geo or the member profile. */
    wardCode: z.string().max(64).optional(),
    media: z.array(reportMediaSchema).max(6).default([]),
  })
  .refine((v) => (v.lat == null) === (v.lng == null), { message: 'Provide both latitude and longitude' })
  .refine((v) => inSouthAfrica(v.lat, v.lng), {
    message: 'Resident reports are only supported within South Africa',
    path: ['lat'],
  });
export type CreateResidentReport = z.infer<typeof createResidentReportSchema>;

/**
 * Staff update of a resident report: move it through the lifecycle and/or write
 * follow-up feedback back to the resident. At least one field must be present.
 */
export const updateResidentReportSchema = z
  .object({
    status: z.enum(['submitted', 'acknowledged', 'in_progress', 'resolved', 'closed']).optional(),
    feedback: z.string().trim().min(1).max(4000).nullable().optional(),
    action: z.enum(['acknowledge', 'contact', 'follow_up', 'resolve', 'confirm', 'request_follow_up', 'reopen', 'close']).optional(),
    contactMethod: z.enum(['phone', 'email', 'sms', 'whatsapp', 'in_person', 'service_portal', 'other']).optional(),
    contactTarget: z.string().trim().min(1).max(200).optional(),
    contactMethodDetail: z.string().trim().min(1).max(200).optional(),
    internalNote: z.string().trim().min(1).max(4000).optional(),
    externalReference: z.string().trim().min(1).max(100).optional(),
    referenceKind: z.enum(['service_provider', 'c3']).optional(),
    c3Requirement: z.enum(['needs_assessment', 'required', 'not_required']).optional(),
    c3Reason: z.string().trim().min(1).max(1000).nullable().optional(),
    followUpAt: z.string().datetime({ offset: true }).nullable().optional(),
    expectedVersion: z.number().int().min(0).optional(),
    requestId: z.string().uuid().optional(),
  }).strict()
  .refine((v) => v.status !== undefined || v.feedback !== undefined || v.action !== undefined || v.externalReference !== undefined || v.internalNote !== undefined || v.c3Requirement !== undefined || v.referenceKind !== undefined || v.c3Reason !== undefined, {
    message: 'Provide an action, status, reference, or feedback',
  });
export type UpdateResidentReport = z.infer<typeof updateResidentReportSchema>;

export const reportListQuerySchema = z.object({
  scope: z.enum(['mine', 'inbox']).default('mine'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().trim().max(200).optional(),
  category: z.string().max(40).optional(),
  status: z.enum(['submitted','acknowledged','in_progress','resolved','closed']).optional(),
  ward: z.string().max(64).optional(),
  councillor: z.union([z.string().uuid(), z.literal('unassigned')]).optional(),
  acknowledged: z.enum(['yes','no','unknown']).optional(),
  actionTaken: z.enum(['yes','no','councillor']).optional(),
  c3: z.enum(['needs_assessment','required','not_required','missing','recorded']).optional(),
  assignee: z.union([z.string().uuid(), z.literal('me'), z.literal('unassigned')]).optional(),
  overdue: z.enum(['yes','no']).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  sort: z.enum(['received','lastAction','nextDue']).default('received'),
  direction: z.enum(['asc','desc']).default('desc'),
}).refine((v) => !v.from || !v.to || Date.parse(v.from) <= Date.parse(v.to), { message: 'Invalid date range' });
export type ReportListQuery = z.infer<typeof reportListQuerySchema>;

const taskFields = {
  title: z.string().trim().min(1).max(200),
  instructions: z.string().trim().max(4000).nullable().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  dueAt: z.string().datetime({ offset: true }),
};
export const createReportTaskSchema = z.object({ ...taskFields, requestId: z.string().uuid() }).strict();
export const updateReportTaskSchema = z.object({
  title: taskFields.title.optional(), instructions: taskFields.instructions, assigneeId: taskFields.assigneeId,
  dueAt: taskFields.dueAt.optional(), status: z.enum(['todo','in_progress','done','cancelled']).optional(),
  outcome: z.string().trim().min(1).max(4000).optional(),
  expectedVersion: z.number().int().min(0), requestId: z.string().uuid(),
}).strict().refine((v) => Object.keys(v).some((key) => !['requestId','expectedVersion'].includes(key)), { message: 'Provide a task change' });
export type CreateReportTask = z.infer<typeof createReportTaskSchema>;
export type UpdateReportTask = z.infer<typeof updateReportTaskSchema>;
export const taskListQuerySchema = z.object({
  reportId: z.string().uuid().optional(),
  assignee: z.union([z.string().uuid(), z.literal('me'), z.literal('unassigned')]).optional(),
  status: z.enum(['todo','in_progress','done','cancelled']).optional(),
  overdue: z.enum(['yes','no']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(15), offset: z.coerce.number().int().min(0).default(0),
  sort: z.enum(['due','status']).default('due'), direction: z.enum(['asc','desc']).default('asc'),
});
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;
