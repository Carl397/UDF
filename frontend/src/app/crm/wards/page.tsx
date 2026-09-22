'use client';

import { useEffect, useState } from 'react';
import { api, dataReadError } from '../../../lib/api';
import type { WardSummary } from '../../../types';
import { CrmPageHeader, CrmStatGrid, CrmTable, CrmSmallButton, CrmFilters, downloadCsv } from '../../../components/crm/ui';

export default function CrmWards() {
  const [ward, setWard] = useState('');
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([ward.trim(), attempt]);
  const [state, setState] = useState<{ key: string; data: WardSummary | null; error: string | null }>({ key: '', data: null, error: null });
  useEffect(() => {
    let active = true;
    api.crmWardSummary({ ward: ward.trim() || undefined }).then((data) => {
      if (active) setState({ key, data, error: null });
    }).catch((error: unknown) => {
      if (active) setState({ key, data: null, error: dataReadError(error) });
    });
    return () => { active = false; };
  }, [key, ward]);
  const data = state.key === key ? state.data : null;
  const error = state.key === key ? state.error : null;
  const loading = !data && !error;
  const casesAvailable = !!data?.rows.length && data.rows.every((r) => r.cases !== null);
  const caseTotal = casesAvailable ? data!.rows.reduce((sum, r) => sum + r.cases!.total, 0) : null;

  return <div>
    <CrmPageHeader title="Wards" subtitle="Complete authorized canonical ward directory. Operational totals remain within your primary-ward territory and permitted visibility."
      actions={<CrmSmallButton disabled={!data} onClick={() => data && downloadCsv('ward-summary',
        ['Ward code', 'Ward', 'Nondeleted members (all statuses/tiers)', 'Cases (all-time)', 'Open', 'Resolved', 'SLA breached', 'Resolution rate %', 'Candidate recorded', 'Public councillor'],
        data.rows.map((r) => [r.code, r.name, r.members, r.cases?.total ?? 'Unavailable', r.cases?.open ?? 'Unavailable',
          r.cases?.resolved ?? 'Unavailable', r.cases?.slaBreached ?? 'Unavailable',
          r.cases === null ? 'Unavailable' : r.cases.resolutionRatePct ?? 'No cases', r.candidateRecorded ? 'Yes' : 'No candidate recorded',
          r.councillor?.fullName ?? 'No public councillor listed']))}>Export ward summary</CrmSmallButton>} />
    <CrmFilters>
      <input aria-label="Ward code" maxLength={32} placeholder="Canonical ward code (e.g. CPT-W009)" value={ward} onChange={(e) => setWard(e.target.value)} />
      <CrmSmallButton disabled={loading} onClick={() => setAttempt((n) => n + 1)}>{error ? 'Retry' : 'Refresh'}</CrmSmallButton>
      {ward && <CrmSmallButton onClick={() => setWard('')}>Clear ward</CrmSmallButton>}
    </CrmFilters>
    {loading ? <p role="status">Loading ward summary…</p> : error ? <p role="alert">{error}</p> : data && <>
      <p style={{ fontSize: 12 }}>Last successful fetch · database as of <time dateTime={data.asOf}>{data.asOf}</time></p>
      <CrmStatGrid stats={[
        { label: 'Authorized wards', value: data.total },
        { label: 'Mapped nondeleted members · all statuses/tiers', value: data.rows.reduce((sum, r) => sum + r.members, 0) },
        { label: 'Mapped cases · all-time', value: caseTotal ?? 'Unavailable' },
        { label: 'Wards with no candidate recorded', value: data.rows.filter((r) => !r.candidateRecorded).length },
      ]} />
      <p style={{ fontSize: 13 }}>Members include every status and tier, excluding deleted records. Cases exclude duplicates and merged records;
        resolved includes resolved, verified and closed. A recorded candidate assignment is not an election outcome.
        Public secondary-ward assignments do not grant operational access.</p>
      {data.rows.some((r) => r.cases === null) && <p role="status">Case metrics unavailable: your account does not have access to case data. Member and directory totals remain available.</p>}
      <CrmTable columns={['Ward', 'Nondeleted members', 'Cases', 'Open', 'Resolved', 'SLA breached', 'Resolution rate', 'Candidate record', 'Public councillor']}
        rows={data.rows.map((r) => [
          <span key="ward"><strong>{r.name}</strong> <code>{r.code}</code></span>, r.members,
          r.cases?.total ?? 'Unavailable', r.cases?.open ?? 'Unavailable', r.cases?.resolved ?? 'Unavailable', r.cases?.slaBreached ?? 'Unavailable',
          r.cases === null ? 'Unavailable' : r.cases.resolutionRatePct === null ? 'No cases' : `${r.cases.resolutionRatePct}%`,
          r.candidateRecorded ? 'Candidate recorded' : 'No candidate recorded', r.councillor?.fullName ?? 'No public councillor listed',
        ])} empty="No canonical wards in your authorized scope match this filter." />
    </>}
  </div>;
}
