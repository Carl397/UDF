'use client';

import { useEffect, useState } from 'react';
import { api, dataReadError } from '../../../lib/api';
import type { Verification } from '../../../types';
import {
  CrmPageHeader, CrmStatGrid, CrmTable, CrmSmallButton, CrmPagination, downloadCsv, fmtDateTime,
} from '../../../components/crm/ui';

const LIMIT = 100;
const VERDICTS = {
  fixed: { label: 'Fixed', color: '#166534' },
  not_fixed: { label: 'Not fixed', color: '#991b1b' },
  partial: { label: 'Partially fixed', color: '#92400e' },
};

export default function CrmVerifications() {
  const [page, setPage] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const key = `${page}:${attempt}`;
  const [state, setState] = useState<{ key: string; data: { items: Verification[]; total: number } | null; error: string | null; fetchedAt: string | null }>({
    key: '', data: null, error: null, fetchedAt: null,
  });
  useEffect(() => {
    let active = true;
    api.listVerifications({ limit: String(LIMIT), offset: String(page * LIMIT) }).then((data) => {
      if (active) setState({ key, data, error: null, fetchedAt: new Date().toISOString() });
    }).catch((error: unknown) => {
      if (active) setState({ key, data: null, error: dataReadError(error), fetchedAt: null });
    });
    return () => { active = false; };
  }, [key, page]);
  const data = state.key === key ? state.data : null;
  const error = state.key === key ? state.error : null;
  const loading = !data && !error;

  return <div>
    <CrmPageHeader title="Verifications" subtitle="Member-submitted workmanship checks on service cases. Separate from councillor ratings."
      actions={<CrmSmallButton disabled={!data} onClick={() => data && downloadCsv('verifications-current-page',
        ['Case', 'Member', 'Verdict', 'Note', 'Created'],
        data.items.map((i) => [i.serviceRequestId, i.memberId, i.verdict, i.note ?? '', i.createdAt]))}>Export current page</CrmSmallButton>} />
    <CrmSmallButton disabled={loading} onClick={() => setAttempt((n) => n + 1)}>{error ? 'Retry' : 'Refresh'}</CrmSmallButton>
    {loading ? <p role="status">Loading verifications…</p> : error ? <p role="alert">{error}</p> : data && <>
      <p style={{ fontSize: 12 }}>Last successful fetch: <time dateTime={state.fetchedAt!}>{state.fetchedAt}</time></p>
      <CrmStatGrid stats={[
        { label: 'Total matching verifications', value: data.total },
        { label: 'Current page · fixed', value: data.items.filter((i) => i.verdict === 'fixed').length },
        { label: 'Current page · not fixed', value: data.items.filter((i) => i.verdict === 'not_fixed').length },
        { label: 'Current page · partially fixed', value: data.items.filter((i) => i.verdict === 'partial').length },
      ]} />
      <CrmTable columns={['Case ID', 'Member ID', 'Verdict', 'Note', 'Submitted']}
        rows={data.items.map((i) => [
          <code key="case">{i.serviceRequestId.slice(0, 8)}</code>, <code key="member">{i.memberId.slice(0, 8)}</code>,
          <span key="verdict" style={{ color: VERDICTS[i.verdict].color, background: `${VERDICTS[i.verdict].color}18`, padding: '3px 8px', borderRadius: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>{VERDICTS[i.verdict].label}</span>,
          i.note ?? '—', fmtDateTime(i.createdAt),
        ])} empty={data.total === 0 ? 'No verifications recorded in your authorized scope.' : 'No verifications on this page. Return to a previous page or refresh.'} />
      <CrmPagination page={page} totalPages={Math.ceil(data.total / LIMIT)} total={data.total} onPage={setPage} />
      {page > 0 && data.items.length === 0 && <CrmSmallButton onClick={() => setPage(0)}>Return to first page</CrmSmallButton>}
    </>}
  </div>;
}
