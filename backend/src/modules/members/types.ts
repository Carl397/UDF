import type { MemberTier, MemberStatus, Pii, Consent } from './schemas.js';

/** A member as stored (no plaintext PII — only sealed blobs + blind indexes). */
export interface MemberRow {
  id: string;
  membership_no: string | null;
  tier: MemberTier;
  status: MemberStatus;
  region_code: string | null;
  district_code: string | null;
  lat: number | null;
  lng: number | null;
  heat_weight: string; // NUMERIC arrives as string
  sealed_pii: {
    wrappedDek: string;
    keyId: string;
    fields: Record<string, string>;
  };
  email_bidx: Buffer | null;
  phone_bidx: Buffer | null;
  tags: string[];
  /** Human-friendly QR/verify code (`UDF-XXX-XXX`) — public by design. */
  public_code: string | null;
  ward: string | null;
  joined_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ConsentRow {
  member_id: string;
  email_optin: boolean;
  sms_optin: boolean;
  phone_optin: boolean;
  data_share: boolean;
  gdpr_basis: string | null;
}

/** Public member view returned by the API. PII included only when decrypted. */
export interface MemberView {
  id: string;
  membershipNo: string | null;
  tier: MemberTier;
  status: MemberStatus;
  regionCode: string | null;
  districtCode: string | null;
  lat: number | null;
  lng: number | null;
  heatWeight: number;
  tags: string[];
  publicCode: string | null;
  ward: string | null;
  joinedAt: string | null;
  consent?: Consent | null;
  createdAt: string;
  updatedAt: string;
  /** Present only for callers holding PII_DECRYPT (and always audited). */
  pii?: Partial<Pii> | null;
}

export type { Pii, Consent };

/**
 * Member scope filter.
 *
 * `null` ⇒ national scope: no row filter is applied (national_admin, analyst).
 *
 * Otherwise the fragments are AND-ed together, so a ward-scoped principal is
 * restricted to that ward *and* to its parent regions:
 *   • `ward`    → `members.ward = $n`       (ward_councillor, member)
 *   • `regions` → `members.region_code = ANY($n)` (regional_organizer)
 *
 * An object with neither field set matches nothing — a scoped principal that
 * has been given no territory must not silently fall back to seeing everything.
 *
 * This replaced a `string[] | null` region-only filter. Region-only scoping
 * let a `ward_councillor` read every member in their whole subcouncil, because
 * `principal.regionCodes` holds the subcouncil, not the ward — the adjacent
 * control ward CPT-W043 shares subcouncil CPT-SC17 with CPT-W079 and was
 * therefore fully visible to the W079 councillor.
 */
export interface MemberScopeFilter {
  ward?: string | null;
  regions?: string[] | null;
}
export type MemberScope = MemberScopeFilter | null;
