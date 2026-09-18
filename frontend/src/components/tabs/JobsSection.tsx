'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useShell } from '../AppShell';
import { useAuth } from '../../lib/auth';
import { EmptyState, Icon, useToast } from '../ui';
import OpportunitySheet from './OpportunitySheet';
import type { JobDemand, JobInterest, JobOpportunity, WorkType } from '../../types';

/**
 * Engage ▸ Jobs (PRD-jobs).
 *
 * Two views, gated by caps, staff first (national_admin holds both):
 *  • staff   → AGGREGATE ward work-demand (never personal data) + post/publish.
 *  • member  → register/withdraw their OWN work interest + see live opportunities.
 *
 * HARD RULE (NG1): nothing here uploads a CV or document. The register holds a
 * name, email, work types and a short experience note only; members apply
 * DIRECTLY to the company when an opportunity is relayed.
 */
export default function JobsSection() {
  const { caps } = useShell();
  const { wardCode } = useAuth();
  const [workTypes, setWorkTypes] = useState<WorkType[]>([]);
  const [registerEnabled, setRegisterEnabled] = useState(true);

  useEffect(() => {
    api.jobWorkTypes().then((r) => setWorkTypes(r.items)).catch(() => setWorkTypes([]));
    // §9.7 kill-switch: when jobs.register is off, hide the member register card.
    api.jobFlags().then((f) => setRegisterEnabled(f.register)).catch(() => setRegisterEnabled(true));
  }, []);

  // Staff view takes precedence, and the order matters. `jobs:interest_write`
  // is held by national_admin as well as by members — an administrator is a
  // person too, and the server lets them register their own interest — so the
  // two branches are not role-exclusive. Checking `jobInterest` first (as this
  // did while the caps came from a hand-written role table that set it false
  // for admin) would drop a national admin into the member self-service
  // register and hide the aggregate ward demand view, which is strictly more
  // than they lose. Ordering on capability rather than role keeps the caps
  // table free of special cases.
  if (caps.jobDemand) return <StaffJobs workTypes={workTypes} wardCode={wardCode} canPost={caps.jobOpportunity} />;
  if (caps.jobInterest) return <MemberJobs workTypes={workTypes} registerEnabled={registerEnabled} />;
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <EmptyState icon="lock" title="Jobs are not available for your role" />
    </div>
  );
}

// ── Member view (FR-K) ───────────────────────────────────────────────────

function MemberJobs({ workTypes, registerEnabled }: { workTypes: WorkType[]; registerEnabled: boolean }) {
  const { email } = useAuth();
  const toast = useToast();
  const [interest, setInterest] = useState<JobInterest | null | undefined>(undefined);
  const [opps, setOpps] = useState<JobOpportunity[] | null>(null);
  const [form, setForm] = useState({ firstName: '', surname: '', email: email ?? '', workTypes: [] as string[], experience: '' });
  const [busy, setBusy] = useState(false);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);

  const load = useCallback(() => {
    api.getJobInterest().then((r) => {
      setInterest(r.interest);
      if (r.interest) {
        setForm({
          firstName: r.interest.firstName,
          surname: r.interest.surname,
          email: r.interest.email,
          workTypes: r.interest.workTypes,
          experience: r.interest.experience ?? '',
        });
      }
    }).catch(() => setInterest(null));
    api.listJobOpportunities().then((r) => setOpps(r.items)).catch(() => setOpps([]));
  }, []);

  useEffect(() => { load(); }, [load]);

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const toggleType = (code: string) =>
    setForm((f) => ({
      ...f,
      workTypes: f.workTypes.includes(code) ? f.workTypes.filter((c) => c !== code) : [...f.workTypes, code],
    }));

  async function save() {
    if (!form.firstName.trim() || !form.surname.trim()) return toast('Please enter your name and surname', 'err');
    if (!form.email.trim()) return toast('An email address is required to notify you', 'err');
    if (form.workTypes.length === 0) return toast('Select at least one type of work', 'err');
    setBusy(true);
    try {
      const r = await api.upsertJobInterest({
        firstName: form.firstName.trim(),
        surname: form.surname.trim(),
        email: form.email.trim(),
        workTypes: form.workTypes,
        experience: form.experience.trim() || undefined,
      });
      setInterest(r.interest);
      toast(interest ? 'Your work interest was updated' : 'You are on the ward work register', 'ok');
    } catch (e: any) {
      toast(e?.message ?? 'Could not save', 'err');
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    setBusy(true);
    try {
      await api.withdrawJobInterest();
      setInterest(null);
      setForm((f) => ({ ...f, firstName: '', surname: '', workTypes: [], experience: '' }));
      setConfirmWithdraw(false);
      toast('Removed from the work register', 'ok');
    } catch (e: any) {
      toast(e?.message ?? 'Could not withdraw', 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {!registerEnabled && interest === null ? (
        <div className="card" style={{ marginTop: 12 }}>
          <EmptyState
            icon="lock"
            title="The work register is currently closed"
            hint="New registrations are paused right now. Opportunities already open in your ward are still listed below."
          />
        </div>
      ) : (
        <>
      <div className="section-label" style={{ marginTop: 12 }}>Looking for work</div>

      <div className="card">
        <div className="card-title">
          <Icon name="briefcase" size={16} /> Ward work register
        </div>
        <p className="hint-text" style={{ marginTop: 4 }}>
          Add your name, email and the types of work you can do. <strong>No CV or documents are
          uploaded.</strong> When a matching opportunity is posted in your ward, we alert you here and
          by email so you can apply <strong>directly to the company</strong>.
        </p>

        {interest === undefined ? (
          <div className="skeleton" style={{ height: 120, marginTop: 8 }} />
        ) : (
          <div className="form-grid" style={{ marginTop: 10 }}>
            <div className="field-row">
              <div className="field">
                <label htmlFor="ji-first">First name</label>
                <input id="ji-first" className="input" value={form.firstName} maxLength={80}
                  placeholder="Nomvula" onChange={(e) => set({ firstName: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="ji-last">Surname</label>
                <input id="ji-last" className="input" value={form.surname} maxLength={80}
                  placeholder="Mokoena" onChange={(e) => set({ surname: e.target.value })} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="ji-email">Email (to notify you)</label>
              <input id="ji-email" className="input" type="email" value={form.email} maxLength={200}
                placeholder="you@example.com" onChange={(e) => set({ email: e.target.value })} />
            </div>
            <div className="field">
              <label>Types of work you can do</label>
              <div className="chip-row" style={{ marginTop: 6 }}>
                {workTypes.map((w) => (
                  <button key={w.code} type="button"
                    className={`chip ${form.workTypes.includes(w.code) ? 'on' : ''}`}
                    onClick={() => toggleType(w.code)}>{w.label}</button>
                ))}
              </div>
            </div>
            <div className="field">
              <label htmlFor="ji-exp">
                Experience / skills <span className="hint-text" style={{ fontSize: 11 }}>{form.experience.length}/240</span>
              </label>
              <textarea id="ji-exp" className="input" rows={3} value={form.experience} maxLength={240}
                placeholder="A short summary — no documents needed." onChange={(e) => set({ experience: e.target.value })} />
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
              <button className="btn btn-primary" style={{ flex: 2 }} onClick={save} disabled={busy}>
                <Icon name="check" size={16} /> {busy ? 'Saving…' : interest ? 'Update my interest' : 'Join the register'}
              </button>
              {interest && (
                confirmWithdraw ? (
                  <button className="btn btn-danger" onClick={withdraw} disabled={busy}>Confirm remove</button>
                ) : (
                  <button className="btn btn-ghost" onClick={() => setConfirmWithdraw(true)} disabled={busy}>
                    <Icon name="trash" size={16} /> Withdraw
                  </button>
                )
              )}
            </div>
            {interest && (
              <p className="hint-text" style={{ marginTop: 8 }}>
                <Icon name="checkCircle" size={13} /> Registered · updated{' '}
                {new Date(interest.updatedAt).toLocaleDateString()}. Withdrawing removes your details
                immediately.
              </p>
            )}
          </div>
        )}
      </div>
        </>
      )}

      <div className="section-label" style={{ marginTop: 16 }}>Opportunities in your ward</div>
      {opps === null ? (
        <div className="skeleton" style={{ height: 76 }} />
      ) : opps.length === 0 ? (
        <div className="card">
          <EmptyState icon="briefcase" title="No open opportunities yet"
            hint="When a company posts work in your ward, it appears here and you'll be alerted." />
        </div>
      ) : (
        <div className="list" style={{ marginTop: 4 }}>
          {opps.map((o) => <OpportunityCard key={o.id} o={o} workTypes={workTypes} />)}
        </div>
      )}
    </>
  );
}

/** A member-facing opportunity card with "apply directly" contact actions. */
function OpportunityCard({ o, workTypes }: { o: JobOpportunity; workTypes: WorkType[] }) {
  const label = (code: string) => workTypes.find((w) => w.code === code)?.label ?? code;
  return (
    <div className="card">
      <div className="row" style={{ cursor: 'default', padding: 0 }}>
        <span className="row-ico"><Icon name="briefcase" /></span>
        <span className="row-main">
          <span className="row-title">{o.title}</span>
          <span className="row-sub">{o.company}</span>
          <span className="row-sub tiny">
            {o.refNo}{o.closesAt ? ` · closes ${o.closesAt}` : ''}
          </span>
        </span>
      </div>
      <div className="chip-row" style={{ marginTop: 8 }}>
        {o.workTypes.map((c) => <span key={c} className="badge">{label(c)}</span>)}
      </div>
      {o.description && <p className="hint-text" style={{ marginTop: 8 }}>{o.description}</p>}
      <div className="chip-row" style={{ marginTop: 10 }}>
        {o.contactEmail && (
          <a className="btn btn-primary btn-sm" href={`mailto:${o.contactEmail}`}>
            <Icon name="send" size={15} /> Email to apply
          </a>
        )}
        {o.contactPhone && (
          <a className="btn btn-ghost btn-sm" href={`tel:${o.contactPhone}`}>
            <Icon name="users" size={15} /> Call
          </a>
        )}
        {o.contactUrl && (
          <a className="btn btn-ghost btn-sm" href={o.contactUrl} target="_blank" rel="noreferrer">
            <Icon name="link" size={15} /> Apply online
          </a>
        )}
      </div>
    </div>
  );
}

// ── Staff view (FR-L demand + FR-M opportunities) ────────────────────────

function StaffJobs({ workTypes, wardCode, canPost }: { workTypes: WorkType[]; wardCode: string | null; canPost: boolean }) {
  const toast = useToast();
  const [demand, setDemand] = useState<JobDemand | null>(null);
  const [opps, setOpps] = useState<JobOpportunity[] | null>(null);
  const [status, setStatus] = useState<'all' | 'draft' | 'published' | 'closed'>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<JobOpportunity | null | undefined>(undefined);

  const loadDemand = useCallback(() => {
    api.listJobDemand(wardCode || undefined).then(setDemand).catch(() => setDemand(null));
  }, [wardCode]);

  const loadOpps = useCallback(() => {
    api.listJobOpportunities({ ward: wardCode || undefined, status: status === 'all' ? undefined : status })
      .then((r) => setOpps(r.items)).catch(() => setOpps([]));
  }, [wardCode, status]);

  useEffect(() => { loadDemand(); }, [loadDemand]);
  useEffect(() => { loadOpps(); }, [loadOpps]);

  async function publish(o: JobOpportunity) {
    setBusyId(o.id);
    try {
      const r = await api.publishJobOpportunity(o.id);
      const m = r.opportunity.stats?.matched ?? 0;
      toast(
        r.duplicateWarning
          ? `Published (possible duplicate) — relayed to ${m} member${m === 1 ? '' : 's'}`
          : `Published — relayed to ${m} member${m === 1 ? '' : 's'}`,
        'ok',
      );
      loadOpps();
    } catch (e: any) {
      toast(e?.message ?? 'Could not publish', 'err');
    } finally {
      setBusyId(null);
    }
  }

  async function close(o: JobOpportunity) {
    setBusyId(o.id);
    try {
      await api.closeJobOpportunity(o.id);
      toast('Opportunity closed', 'ok');
      loadOpps();
    } catch (e: any) {
      toast(e?.message ?? 'Could not close', 'err');
    } finally {
      setBusyId(null);
    }
  }

  const scopeLabel = demand ? (demand.scope === 'all' ? 'All wards' : demand.scope.join(', ')) : wardCode ?? '—';
  const maxType = Math.max(1, ...(demand?.byWorkType.map((b) => b.count) ?? [1]));
  const maxTrend = Math.max(1, ...(demand?.trend.map((t) => t.count) ?? [1]));

  return (
    <>
      <div className="section-label" style={{ marginTop: 12 }}>Work demand · {scopeLabel}</div>
      {demand === null ? (
        <div className="skeleton" style={{ height: 140 }} />
      ) : (
        <div className="card">
          <div className="stat-grid">
            <div className="stat accent"><div className="num">{demand.total}</div><div className="lbl">People looking</div></div>
            <div className="stat"><div className="num">{demand.availableNow}</div><div className="lbl">Available now</div></div>
            <div className="stat"><div className="num">{demand.byWorkType.length}</div><div className="lbl">Work types</div></div>
          </div>

          <p className="hint-text" style={{ marginTop: 10 }}>
            <Icon name="lock" size={13} /> Aggregate only — no names, emails or personal details are
            ever shown to staff. Share these counts with project companies entering the ward.
          </p>

          {demand.byWorkType.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div className="card-title" style={{ fontSize: 13 }}>By type of work</div>
              {demand.byWorkType.map((b) => (
                <div key={b.code} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                  <span style={{ width: 130, fontSize: 12.5, color: 'var(--text-2)' }}>{b.label}</span>
                  <span style={{ flex: 1, height: 8, background: 'var(--surface-3, #eee)', borderRadius: 6, overflow: 'hidden' }}>
                    <span style={{ display: 'block', height: '100%', width: `${(b.count / maxType) * 100}%`, background: 'var(--accent, #2f7d32)' }} />
                  </span>
                  <span style={{ width: 24, textAlign: 'right', fontSize: 12.5, fontWeight: 600 }}>{b.count}</span>
                </div>
              ))}
            </div>
          )}

          {demand.trend.length > 1 && (
            <div style={{ marginTop: 14 }}>
              <div className="card-title" style={{ fontSize: 13 }}>30-day trend</div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 48, marginTop: 6 }}>
                {demand.trend.map((t) => (
                  <span key={t.day} title={`${t.day}: ${t.count}`}
                    style={{ flex: 1, height: `${(t.count / maxTrend) * 100}%`, minHeight: 3, background: 'var(--accent, #2f7d32)', borderRadius: 3, opacity: 0.8 }} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="section-label" style={{ marginTop: 16 }}>Opportunities</div>
      <div className="chip-row">
        {(['all', 'draft', 'published', 'closed'] as const).map((s) => (
          <button key={s} className={`chip ${status === s ? 'on' : ''}`} onClick={() => setStatus(s)}>
            {s === 'all' ? 'All' : s[0]!.toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {opps === null ? (
        <div className="skeleton" style={{ height: 76, marginTop: 8 }} />
      ) : opps.length === 0 ? (
        <div className="card" style={{ marginTop: 8 }}>
          <EmptyState icon="briefcase" title="No opportunities"
            hint={canPost ? 'Post a work opportunity to relay to matched members.' : 'None recorded in your scope.'} />
        </div>
      ) : (
        <div className="rows" style={{ marginTop: 8 }}>
          {opps.map((o) => {
            const label = (c: string) => workTypes.find((w) => w.code === c)?.label ?? c;
            return (
              <div key={o.id} className="row" style={{ cursor: 'default' }}>
                <span className="row-ico"><Icon name="briefcase" /></span>
                <span className="row-main">
                  <span className="row-title">{o.title}</span>
                  <span className="row-sub">{o.company} · {o.refNo}</span>
                  <span className="row-sub tiny">
                    {o.workTypes.map(label).join(', ')}
                    {o.wardCode ? ` · ${o.wardCode}` : ''}
                  </span>
                  {o.stats && o.status === 'published' && (
                    <span className="row-sub tiny">
                      Relayed: {o.stats.matched} matched · {o.stats.notifiedInapp} in-app · {o.stats.emailed} emailed
                    </span>
                  )}
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                  <span className={`badge ${o.status === 'published' ? 'ok' : o.status === 'closed' ? '' : o.status === 'expired' ? 'danger' : 'warn'}`}>
                    {o.status}
                  </span>
                  {canPost && (
                    <span style={{ display: 'flex', gap: 6 }}>
                      {o.status === 'draft' && (
                        <button className="btn btn-primary btn-sm" onClick={() => publish(o)} disabled={busyId === o.id}>
                          <Icon name="send" size={14} /> {busyId === o.id ? '…' : 'Publish'}
                        </button>
                      )}
                      {o.status === 'published' && (
                        <button className="btn btn-ghost btn-sm" onClick={() => close(o)} disabled={busyId === o.id}>
                          Close
                        </button>
                      )}
                      {(o.status === 'draft' || o.status === 'published') && (
                        <button className="btn btn-ghost btn-sm" onClick={() => setSheet(o)} aria-label="Edit">
                          <Icon name="edit" size={14} />
                        </button>
                      )}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {canPost && (
        <button className="fab" onClick={() => setSheet(null)} aria-label="Post a work opportunity">
          <Icon name="plus" size={22} />
        </button>
      )}

      {sheet !== undefined && (
        <OpportunitySheet
          opportunity={sheet}
          wardCode={wardCode}
          workTypes={workTypes}
          onClose={() => setSheet(undefined)}
          onSaved={() => { loadOpps(); loadDemand(); }}
        />
      )}
    </>
  );
}
