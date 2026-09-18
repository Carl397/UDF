'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '../../../lib/api';
import type { Member, PhotoTransform } from '../../../types';
import { memberLabel } from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { can, Perm } from '../../../lib/caps';
import { moduleOn, ModuleKey } from '../../../lib/modules';
import CardPhotoEditor from '../../../components/crm/CardPhotoEditor';
import BatchCardPrint from '../../../components/crm/BatchCardPrint';
import {
  CrmPageHeader, CrmTable, CrmBadge, CrmFilters, CrmPagination, CrmModal,
  CrmButton, CrmSmallButton, downloadCsv, fmtDate,
} from '../../../components/crm/ui';

/**
 * CRM Members — enterprise member directory: search, tier/status filters,
 * sealed-PII reveal (audited), consent view, CSV export.
 */

const TIERS = ['voter', 'volunteer', 'activist', 'donor', 'candidate', 'staff'];
const STATUSES = ['active', 'inactive', 'lapsed', 'suspended', 'pending'];
const LIMIT = 50;

/**
 * `useSearchParams` needs a Suspense boundary — see the same note on the Cases
 * screen. This app is also statically exported for the Capacitor bundle, where
 * omitting it fails the build rather than degrading.
 */
export default function CrmMembers() {
  return (
    <Suspense fallback={<p style={{ color: '#64748b' }}>Loading members…</p>}>
      <CrmMembersInner />
    </Suspense>
  );
}

function CrmMembersInner() {
  const searchParams = useSearchParams();
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  // ID Card Studio: multi-select batch print + per-member card photo. Both ride
  // on the `id_cards` module (UI-only, owns no permission) plus the member
  // permission the action needs; absent either, the controls stay hidden so the
  // UI never offers something the server would 403 (fail closed).
  const { permissions, modules } = useAuth();
  const idCardsOn = moduleOn(modules, ModuleKey.ID_CARDS);
  const mayBatch = idCardsOn && can(permissions, Perm.MEMBER_READ);
  const mayPhoto = idCardsOn && can(permissions, Perm.MEMBER_WRITE);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [batchOpen, setBatchOpen] = useState(false);
  const [photoCtx, setPhotoCtx] = useState<{ member: Member; mediaId: string | null; transform: PhotoTransform | null } | null>(null);
  // Seeded from the URL so the top-bar search can land here already filtered
  // (D9): a member row deep-links as `?search=<public code>`.
  const [filter, setFilter] = useState({
    ward: searchParams.get('ward') ?? '',
    tier: searchParams.get('tier') ?? '',
    status: searchParams.get('status') ?? '',
    search: searchParams.get('search') ?? '',
  });
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState<Member | null>(null);
  const [pii, setPii] = useState<any>(null);
  const [piiLoading, setPiiLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  const params = useMemo(() => {
    const p: Record<string, string> = {
      limit: LIMIT.toString(),
      offset: (page * LIMIT).toString(),
    };
    if (filter.ward) p.ward = filter.ward;
    if (filter.tier) p.tier = filter.tier;
    if (filter.status) p.status = filter.status;
    if (filter.search) p.search = filter.search;
    return p;
  }, [filter, page]);

  useEffect(() => {
    setLoading(true);
    api
      .crmMembers(params)
      .then((r: { items: Member[]; total: number }) => {
        setMembers(r.items);
        setTotal(r.total);
      })
      .catch(() => {
        setMembers([]);
        setTotal(0);
      })
      .finally(() => setLoading(false));
  }, [params]);

  /**
   * Keep following the URL after mount: `useState` seeds once, so arriving with
   * a different `?search=` while already on this screen would otherwise leave
   * the stale term in the box and the new one in the results.
   */
  const urlSearch = searchParams.get('search') ?? '';
  useEffect(() => {
    setFilter((f) => (f.search === urlSearch ? f : { ...f, search: urlSearch }));
    setPage(0);
  }, [urlSearch]);

  const openDetail = async (m: Member) => {
    setDetail(m);
    setPii(null);
  };

  // ---- ID Card Studio selection -------------------------------------------
  const toggleSel = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const pageIds = members.map((m) => m.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const toggleAllPage = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      pageIds.forEach((id) => (allPageSelected ? next.delete(id) : next.add(id)));
      return next;
    });

  /**
   * Open the card-photo editor for a member, pre-loading any photo already on
   * their card (read from the same public card endpoint the mobile app uses) so
   * the crop/zoom starts from what currently prints rather than a blank slot.
   */
  const openPhoto = async (m: Member) => {
    setPhotoCtx({ member: m, mediaId: null, transform: null });
    try {
      const card = await api.partyCard(m.id);
      setPhotoCtx({ member: m, mediaId: card.photo?.mediaId ?? null, transform: card.photo?.transform ?? null });
    } catch {
      // No card / not readable in scope — still allow a fresh upload.
    }
  };

  const revealPii = async () => {
    if (!detail) return;
    setPiiLoading(true);
    try {
      const withPii = await api.getMember(detail.id, true);
      setPii(withPii);
    } catch {
      alert('PII reveal denied — requires member:pii_decrypt permission (audited).');
    } finally {
      setPiiLoading(false);
    }
  };

  /**
   * Export the whole filtered set, not the visible page.
   *
   * It used to serialise `members` — the 50 rows on screen — under a button
   * labelled "Export CSV", so anyone with more than a page of members got a
   * silently truncated register with nothing to tell them (the D52 defect class:
   * a preview presented as the population). `total` is the server's own count of
   * the same filter, so it is the exact bound to fetch rather than a guess.
   */
  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const all = await api.crmMembers({
        ...params,
        limit: String(Math.max(total, 1)),
        offset: '0',
      });
      downloadCsv(
        'members',
        ['Membership No', 'Public Code', 'Tier', 'Status', 'Ward', 'Created'],
        all.items.map((m) => [m.membershipNo ?? '', m.publicCode ?? '', m.tier, m.status, m.ward ?? '', m.createdAt]),
      );
    } catch {
      alert('Export failed — the register could not be read.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <CrmPageHeader
        title="Members"
        subtitle="Party member register with sealed PII, consents and public verification codes."
        actions={
          <>
            {mayBatch && (
              <CrmButton variant="secondary" onClick={() => setBatchOpen(true)} disabled={selected.size === 0}>
                {selected.size > 0 ? `Print cards (${selected.size})` : 'Print cards'}
              </CrmButton>
            )}
            <CrmButton onClick={exportCsv} disabled={exporting}>
              {exporting
                ? `Exporting ${total}…`
                : total > 0
                  ? `Export CSV (${total})`
                  : 'Export CSV'}
            </CrmButton>
          </>
        }
      />

      <CrmFilters>
        <input
          type="text"
          placeholder="Search membership no / public code…"
          value={filter.search}
          onChange={(e) => { setFilter({ ...filter, search: e.target.value }); setPage(0); }}
        />
        <select value={filter.tier} onChange={(e) => { setFilter({ ...filter, tier: e.target.value }); setPage(0); }}>
          <option value="">All Tiers</option>
          {TIERS.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <select value={filter.status} onChange={(e) => { setFilter({ ...filter, status: e.target.value }); setPage(0); }}>
          <option value="">All Statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Ward code…"
          value={filter.ward}
          onChange={(e) => { setFilter({ ...filter, ward: e.target.value }); setPage(0); }}
        />
      </CrmFilters>

      {mayBatch && !loading && members.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, margin: '0 0 12px', fontSize: 13, color: '#57534e' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={allPageSelected} onChange={toggleAllPage} />
            Select all on page
          </label>
          <span>{selected.size} selected</span>
          {selected.size > 0 && (
            <CrmSmallButton onClick={() => setSelected(new Set())}>Clear</CrmSmallButton>
          )}
        </div>
      )}

      {loading ? (
        <p style={{ color: '#64748b' }}>Loading members…</p>
      ) : (
        <CrmTable
          columns={mayBatch
            ? ['✓', 'Membership No', 'Public Code', 'Tier', 'Status', 'Ward', 'Joined', '']
            : ['Membership No', 'Public Code', 'Tier', 'Status', 'Ward', 'Joined', '']}
          rows={members.map((m) => [
            ...(mayBatch
              ? [<input key="sel" type="checkbox" checked={selected.has(m.id)} onChange={() => toggleSel(m.id)} />]
              : []),
            <code key="m">{m.membershipNo ?? '—'}</code>,
            <code key="p">{m.publicCode ?? '—'}</code>,
            m.tier,
            <CrmBadge key="s" value={m.status} />,
            m.ward ?? '—',
            fmtDate(m.createdAt),
            <span key="a" style={{ display: 'inline-flex', gap: 4 }}>
              <CrmSmallButton onClick={() => openDetail(m)}>View</CrmSmallButton>
              {mayPhoto && <CrmSmallButton onClick={() => openPhoto(m)}>Photo</CrmSmallButton>}
            </span>,
          ])}
          empty="No members match the current filters."
        />
      )}

      <CrmPagination page={page} totalPages={Math.ceil(total / LIMIT)} total={total} onPage={setPage} />

      {/* D53: `membership_no` is null for every member in the fixtures, so the
          old title rendered "Member " with nothing after it. `memberLabel` is
          the same fallback chain the table rows use. */}
      {detail && (
        <CrmModal title={`Member ${memberLabel(detail)}`} onClose={() => setDetail(null)}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 14, marginBottom: 16 }}>
            <div><strong>Public code:</strong> <code>{detail.publicCode ?? '—'}</code></div>
            <div><strong>Tier:</strong> {detail.tier}</div>
            <div><strong>Status:</strong> <CrmBadge value={detail.status} /></div>
            <div><strong>Ward:</strong> {detail.ward ?? '—'}</div>
            <div><strong>Joined:</strong> {fmtDate(detail.createdAt)}</div>
          </div>

          <h4 style={{ margin: '0 0 8px', fontSize: 14 }}>Sealed PII (audited reveal)</h4>
          {pii ? (
            <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8, padding: 12, fontSize: 14 }}>
              <div><strong>Email:</strong> {pii.email ?? '—'}</div>
              <div><strong>Phone:</strong> {pii.phone ?? '—'}</div>
              <div><strong>Address:</strong> {pii.address ?? '—'}</div>
              <div style={{ marginTop: 8, fontSize: 12, color: '#991b1b' }}>
                This reveal is recorded in the tamper-evident audit log.
              </div>
            </div>
          ) : (
            <CrmButton onClick={revealPii} disabled={piiLoading} variant="secondary">
              {piiLoading ? 'Decrypting…' : 'Reveal PII'}
            </CrmButton>
          )}

          <h4 style={{ margin: '20px 0 8px', fontSize: 14 }}>Consents</h4>
          <div style={{ fontSize: 14, color: '#64748b' }}>
            {(detail as any).consents ? (
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {Object.entries((detail as any).consents).map(([k, v]) => (
                  <li key={k}>{k}: {String(v)}</li>
                ))}
              </ul>
            ) : (
              'No consent records on file.'
            )}
          </div>
        </CrmModal>
      )}

      {batchOpen && selected.size > 0 && (
        <BatchCardPrint memberIds={[...selected]} onClose={() => setBatchOpen(false)} />
      )}

      {photoCtx && (
        <CardPhotoEditor
          memberId={photoCtx.member.id}
          memberLabel={memberLabel(photoCtx.member)}
          initialMediaId={photoCtx.mediaId}
          initialTransform={photoCtx.transform}
          onClose={() => setPhotoCtx(null)}
          onSaved={() => setPhotoCtx(null)}
        />
      )}
    </div>
  );
}
