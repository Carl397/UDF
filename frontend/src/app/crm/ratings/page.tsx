'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, dataReadError } from '../../../lib/api';
import type { Rating } from '../../../types';
import {
  CrmPageHeader, CrmStatGrid, CrmTable, CrmSmallButton, CrmPagination, downloadCsv, fmtDateTime,
} from '../../../components/crm/ui';

const LIMIT = 100;

export default function CrmRatings() {
  const [page, setPage] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const key = `${page}:${attempt}`;
  const [state, setState] = useState<{ key: string; data: { items: Rating[]; total: number } | null; error: string | null; fetchedAt: string | null }>({
    key: '', data: null, error: null, fetchedAt: null,
  });
  useEffect(() => {
    let active = true;
    api.listRatings({ limit: String(LIMIT), offset: String(page * LIMIT) }).then((data) => {
      if (active) setState({ key, data, error: null, fetchedAt: new Date().toISOString() });
    }).catch((error: unknown) => {
      if (active) setState({ key, data: null, error: dataReadError(error), fetchedAt: null });
    });
    return () => { active = false; };
  }, [key, page]);
  const data = state.key === key ? state.data : null;
  const error = state.key === key ? state.error : null;
  const loading = !data && !error;
  const average = data?.items.length ? data.items.reduce((sum, item) => sum + item.rating, 0) / data.items.length : null;

  return <div>
    <CrmPageHeader title="Legacy ratings" subtitle="Individual feedback on councillor work, cases and projects. Not the private monthly scorecard."
      actions={<CrmSmallButton disabled={!data} onClick={() => data && downloadCsv('legacy-ratings-current-page',
        ['Target Type', 'Target', 'Rating', 'Reason', 'Created'],
        data.items.map((i) => [i.targetType, i.targetId, i.rating, i.reason ?? '', i.createdAt]))}>Export current page</CrmSmallButton>} />
    <p>Looking for monthly app feedback? <Link href="/crm/scorecards">Open private Scorecards</Link>.</p>
    <CrmSmallButton disabled={loading} onClick={() => setAttempt((n) => n + 1)}>{error ? 'Retry' : 'Refresh'}</CrmSmallButton>
    {loading ? <p role="status">Loading legacy ratings…</p> : error ? <p role="alert">{error}</p> : data && <>
      <p style={{ fontSize: 12 }}>Last successful fetch: <time dateTime={state.fetchedAt!}>{state.fetchedAt}</time></p>
      <CrmStatGrid stats={[
        { label: 'Total matching legacy ratings', value: data.total },
        { label: 'Current page average / 5', value: average === null ? 'Unrated' : average.toFixed(2) },
        { label: 'Current page low ratings (≤2)', value: data.items.filter((i) => i.rating <= 2).length },
      ]} />
      <CrmTable columns={['Rating / 5', 'Target', 'Target ID', 'Improvement reason', 'Submitted']}
        rows={data.items.map((i) => [
          <strong key="rating" style={{ color: i.rating <= 2 ? '#991b1b' : '#166534', fontVariantNumeric: 'tabular-nums' }}>{i.rating} / 5</strong>,
          i.targetType, <code key="target">{i.targetId.slice(0, 8)}</code>, i.reason ?? '—', fmtDateTime(i.createdAt),
        ])} empty={data.total === 0 ? 'No legacy ratings recorded in your authorized scope. Monthly scorecards are separate.' : 'No ratings on this page. Return to a previous page or refresh.'} />
      <CrmPagination page={page} totalPages={Math.ceil(data.total / LIMIT)} total={data.total} onPage={setPage} />
      {page > 0 && data.items.length === 0 && <CrmSmallButton onClick={() => setPage(0)}>Return to first page</CrmSmallButton>}
    </>}
  </div>;
}
