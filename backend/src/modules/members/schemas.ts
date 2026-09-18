import { z } from 'zod';

/**
 * Input validation (Zod) for the members module.
 * PII fields are accepted in plaintext over TLS (Layer 1), then sealed by the
 * service (Layer 3) before they ever reach the database.
 */

export const MemberTier = z.enum([
  'voter',
  'volunteer',
  'activist',
  'donor',
  'candidate',
  'staff',
]);

export const MemberStatus = z.enum([
  'active',
  'inactive',
  'lapsed',
  'suspended',
  'pending',
]);

export type MemberTier = z.infer<typeof MemberTier>;
export type MemberStatus = z.infer<typeof MemberStatus>;

/**
 * Multi-select tier filter for query strings. Accepts `tiers=donor,voter`
 * (comma list, what the web client sends) or repeated `tiers[]=donor`. Blank
 * input collapses to `undefined` so "everything on" == "no filter".
 */
export const TierListParam = z.preprocess((raw) => {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  const cleaned = list.map((v) => String(v).trim()).filter(Boolean);
  return cleaned.length ? cleaned : undefined;
}, z.array(MemberTier).optional());

export type TierListParam = z.infer<typeof TierListParam>;

export const piiSchema = z.object({
  fullName: z.string().min(1).max(200),
  email: z.string().email().max(320),
  phone: z.string().min(3).max(32).optional(),
  address: z.string().max(500).optional(),
});

export const consentSchema = z.object({
  emailOptin: z.boolean().default(false),
  smsOptin: z.boolean().default(false),
  phoneOptin: z.boolean().default(false),
  dataShare: z.boolean().default(false),
  gdprBasis: z.enum(['consent', 'contract', 'legitimate_interest']).optional(),
});

const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);

export const createMemberSchema = z.object({
  membershipNo: z.string().min(1).max(64).optional(),
  tier: MemberTier.default('voter'),
  status: MemberStatus.default('pending'),
  regionCode: z.string().min(1).max(32),
  districtCode: z.string().max(32).optional(),
  ward: z.string().max(64).optional(),
  lat,
  lng,
  heatWeight: z.number().min(0).max(1000).default(1),
  tags: z.array(z.string().max(64)).max(50).default([]),
  pii: piiSchema,
  consent: consentSchema.optional(),
});

export const updateMemberSchema = z.object({
  membershipNo: z.string().min(1).max(64).optional(),
  tier: MemberTier.optional(),
  status: MemberStatus.optional(),
  regionCode: z.string().min(1).max(32).optional(),
  districtCode: z.string().max(32).nullable().optional(),
  ward: z.string().max(64).nullable().optional(),
  lat: lat.optional(),
  lng: lng.optional(),
  heatWeight: z.number().min(0).max(1000).optional(),
  tags: z.array(z.string().max(64)).max(50).optional(),
  pii: piiSchema.partial().optional(),
  consent: consentSchema.partial().optional(),
});

export const listMembersQuerySchema = z.object({
  regionCode: z.string().max(32).optional(),
  districtCode: z.string().max(32).optional(),
  ward: z.string().max(64).optional(),
  tier: MemberTier.optional(),
  /** Multi-select tier filter (map legend). Takes precedence over `tier`. */
  tiers: TierListParam,
  status: MemberStatus.optional(),
  tag: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const idParamSchema = z.object({ id: z.string().uuid() });

export type CreateMemberInput = z.infer<typeof createMemberSchema>;
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;
export type ListMembersQuery = z.infer<typeof listMembersQuerySchema>;
export type Pii = z.infer<typeof piiSchema>;
export type Consent = z.infer<typeof consentSchema>;
