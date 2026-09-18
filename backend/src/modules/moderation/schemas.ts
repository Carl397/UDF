import { z } from 'zod';

/**
 * Moderation ladder actions. Account actions (warn/suspend/ban/reinstate)
 * target a `users` row; device actions target the mobile `x-device-id`.
 */
export const MODERATION_ACTIONS = [
  'warn',
  'suspend',
  'ban',
  'reinstate',
  'device_ban',
  'device_unban',
] as const;

export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

const DEVICE_ACTIONS: readonly ModerationAction[] = ['device_ban', 'device_unban'];

/** Body for POST /api/moderation/actions. */
export const applyActionSchema = z
  .object({
    userId: z.string().uuid().optional(),
    deviceId: z.string().min(1).max(128).optional(),
    action: z.enum(MODERATION_ACTIONS),
    reason: z.string().min(1).max(1000),
    /** Suspension length in days (required for `suspend`). */
    durationDays: z.number().int().min(1).max(3650).optional(),
  })
  .superRefine((v, ctx) => {
    if (DEVICE_ACTIONS.includes(v.action)) {
      if (!v.deviceId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['deviceId'],
          message: 'deviceId is required for a device action',
        });
      }
      return;
    }
    if (!v.userId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['userId'],
        message: 'userId is required for an account action',
      });
    }
    if (v.action === 'suspend' && v.durationDays == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['durationDays'],
        message: 'durationDays is required to suspend an account',
      });
    }
  });

export type ApplyActionInput = z.infer<typeof applyActionSchema>;

/** Query filters for the moderation queue. */
export const listUsersQuerySchema = z.object({
  search: z.string().max(320).optional(),
  status: z.enum(['active', 'warned', 'suspended', 'banned']).optional(),
  role: z.string().max(32).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
