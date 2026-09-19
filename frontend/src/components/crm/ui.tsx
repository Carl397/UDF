'use client';

import type { ReactNode } from 'react';
import { MediaThumb } from '../WardTransparency';
import { SR_STATUSES, SR_STATUS_COLOR, STATUS_TONE_HEX } from '../../lib/caseStatus';

/**
 * Shared enterprise CRM UI primitives — tables, badges, modals, filters,
 * pagination and page headers. Keeps every /crm page visually consistent.
 */

export function CrmPageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="crm-page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="crm-page-actions">{actions}</div>}
      <style jsx>{`
        .crm-page-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 24px;
          gap: 16px;
        }
        .crm-page-header h1 {
          font-size: 24px;
          font-weight: 700;
          color: #1c1917;
          margin: 0 0 4px;
        }
        .crm-page-header p {
          font-size: 14px;
          color: #8a817b;
          margin: 0;
        }
        .crm-page-actions {
          display: flex;
          gap: 8px;
        }
      `}</style>
    </div>
  );
}

export function CrmCard({ title, children, footer }: { title?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="crm-card">
      {title && <h2>{title}</h2>}
      {children}
      {footer && <div className="crm-card-footer">{footer}</div>}
      <style jsx>{`
        .crm-card {
          background: #fff;
          border: 1px solid #ece5e1;
          border-radius: 8px;
          padding: 20px;
          margin-bottom: 20px;
        }
        .crm-card h2 {
          font-size: 15px;
          font-weight: 600;
          color: #1c1917;
          margin: 0 0 16px;
        }
        .crm-card-footer {
          margin-top: 16px;
          padding-top: 16px;
          border-top: 1px solid #f2ece8;
        }
      `}</style>
    </div>
  );
}

export function CrmStatGrid({ stats }: { stats: { label: string; value: string | number; tone?: 'default' | 'danger' | 'success' | 'warn' }[] }) {
  const toneColor = (tone?: string) =>
    tone === 'danger' ? '#C8102E' : tone === 'success' ? '#16a34a' : tone === 'warn' ? '#d97706' : '#1c1917';
  return (
    <div className="crm-stat-grid">
      {stats.map((s) => (
        <div key={s.label} className="crm-stat">
          <div className="crm-stat-value" style={{ color: toneColor(s.tone) }}>{s.value}</div>
          <div className="crm-stat-label">{s.label}</div>
        </div>
      ))}
      <style jsx>{`
        .crm-stat-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
          gap: 16px;
          margin-bottom: 24px;
        }
        .crm-stat {
          background: #fff;
          border: 1px solid #ece5e1;
          border-radius: 8px;
          padding: 16px 20px;
        }
        .crm-stat-value {
          font-size: 28px;
          font-weight: 700;
          margin-bottom: 4px;
        }
        .crm-stat-label {
          font-size: 12px;
          color: #8a817b;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
      `}</style>
    </div>
  );
}

export function CrmTable({ columns, rows, empty }: { columns: string[]; rows: ReactNode[][]; empty?: string }) {
  return (
    <div className="crm-table-wrap">
      <table className="crm-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} style={{ textAlign: 'center', color: '#8a817b', padding: 32 }}>
                {empty ?? 'No records found.'}
              </td>
            </tr>
          ) : (
            rows.map((cells, i) => (
              <tr key={i}>
                {cells.map((cell, j) => (
                  <td key={j}>{cell}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
      <style jsx>{`
        .crm-table-wrap {
          background: #fff;
          border: 1px solid #ece5e1;
          border-radius: 8px;
          overflow-x: auto;
        }
        .crm-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 14px;
        }
        .crm-table th {
          text-align: left;
          padding: 12px 16px;
          background: #faf7f5;
          border-bottom: 1px solid #ece5e1;
          font-weight: 600;
          color: #8a817b;
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          white-space: nowrap;
        }
        .crm-table td {
          padding: 12px 16px;
          border-bottom: 1px solid #f2ece8;
          vertical-align: top;
        }
        .crm-table tr:last-child td {
          border-bottom: none;
        }
      `}</style>
    </div>
  );
}

/**
 * Case-status colours are NOT hand-listed here — they are derived from the
 * shared vocabulary in lib/caseStatus.ts (SR_STATUS_COLOR → STATUS_TONE_HEX) so
 * a CRM badge can never paint a status a different colour than the mobile
 * Engage list, the Home strip or the RegionSheet chip for the very same status.
 */
const CASE_STATUS_HEX: Record<string, string> = Object.fromEntries(
  SR_STATUSES.map((s) => [s, STATUS_TONE_HEX[SR_STATUS_COLOR[s]]]),
);

/** Tone per NON-case entity status (members, posts, jobs, patrols, moderation…). */
const STATUS_TONES: Record<string, string> = {
  ...CASE_STATUS_HEX,
  active: '#166534',
  open: '#166534',
  pending: '#92400e',
  warned: '#d97706',
  suspended: '#991b1b',
  banned: '#991b1b',
  inactive: '#8a817b',
  lapsed: '#92400e',
  scheduled: '#0369a1',
  live: '#166534',
  done: '#4b5563',
  cancelled: '#991b1b',
  published: '#166534',
  draft: '#8a817b',
  taken_down: '#991b1b',
  proposed: '#92400e',
  accepted: '#166534',
  ended: '#4b5563',
  sla_breach: '#991b1b',
  stuck: '#92400e',
  overdue: '#92400e',
};

export function CrmBadge({ value }: { value: string }) {
  const color = STATUS_TONES[value] ?? '#8a817b';
  return (
    <span className="crm-badge" style={{ color, background: `${color}18` }}>
      {value.replace(/_/g, ' ')}
      <style jsx>{`
        .crm-badge {
          display: inline-block;
          padding: 3px 8px;
          border-radius: 12px;
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.3px;
          white-space: nowrap;
        }
      `}</style>
    </span>
  );
}

export function CrmFilters({ children }: { children: ReactNode }) {
  return (
    <div className="crm-filters-row">
      {children}
      <style jsx>{`
        .crm-filters-row {
          display: flex;
          gap: 12px;
          margin-bottom: 20px;
          flex-wrap: wrap;
        }
        .crm-filters-row :global(input),
        .crm-filters-row :global(select) {
          padding: 9px 12px;
          border: 1px solid #ece5e1;
          border-radius: 6px;
          font-size: 14px;
          background: #fff;
        }
        .crm-filters-row :global(input[type='text']) {
          min-width: 240px;
        }
      `}</style>
    </div>
  );
}

export function CrmPagination({ page, totalPages, total, onPage }: { page: number; totalPages: number; total: number; onPage: (p: number) => void }) {
  if (totalPages <= 1) return null;
  return (
    <div className="crm-pagination">
      <button onClick={() => onPage(Math.max(0, page - 1))} disabled={page === 0}>← Prev</button>
      <span>Page {page + 1} of {totalPages} · {total} records</span>
      <button onClick={() => onPage(Math.min(totalPages - 1, page + 1))} disabled={page >= totalPages - 1}>Next →</button>
      <style jsx>{`
        .crm-pagination {
          display: flex;
          justify-content: center;
          align-items: center;
          gap: 16px;
          margin-top: 20px;
        }
        .crm-pagination button {
          padding: 8px 16px;
          border: 1px solid #ece5e1;
          background: #fff;
          border-radius: 6px;
          font-size: 13px;
          cursor: pointer;
        }
        .crm-pagination button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .crm-pagination span {
          font-size: 13px;
          color: #8a817b;
        }
      `}</style>
    </div>
  );
}

export function CrmModal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="crm-modal-overlay" onClick={onClose}>
      <div className={`crm-modal ${wide ? 'wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="crm-modal-head">
          <h2>{title}</h2>
          <button onClick={onClose} className="crm-modal-close">×</button>
        </div>
        {children}
        <style jsx>{`
          .crm-modal-overlay {
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
            padding: 24px;
          }
          .crm-modal {
            background: #fff;
            border-radius: 12px;
            padding: 28px;
            width: 100%;
            max-width: 520px;
            max-height: 85vh;
            overflow-y: auto;
          }
          .crm-modal.wide {
            max-width: 860px;
          }
          .crm-modal-head {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
          }
          .crm-modal-head h2 {
            margin: 0;
            font-size: 19px;
            font-weight: 700;
          }
          .crm-modal-close {
            background: none;
            border: none;
            font-size: 24px;
            line-height: 1;
            cursor: pointer;
            color: #8a817b;
          }
        `}</style>
      </div>
    </div>
  );
}

export function CrmField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="crm-field">
      <label>{label}</label>
      {children}
      <style jsx>{`
        .crm-field {
          margin-bottom: 14px;
        }
        .crm-field label {
          display: block;
          font-size: 13px;
          font-weight: 600;
          margin-bottom: 6px;
          color: #8a817b;
        }
        .crm-field :global(input),
        .crm-field :global(select),
        .crm-field :global(textarea) {
          width: 100%;
          padding: 9px 12px;
          border: 1px solid #ece5e1;
          border-radius: 6px;
          font-size: 14px;
          box-sizing: border-box;
          font-family: inherit;
        }
      `}</style>
    </div>
  );
}

export function CrmButton({ children, onClick, variant = 'primary', disabled, type = 'button' }: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`crm-btn crm-btn-${variant}`}>
      {children}
      <style jsx>{`
        .crm-btn {
          padding: 9px 18px;
          border-radius: 6px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          border: 1px solid transparent;
          transition: background 0.15s;
        }
        .crm-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .crm-btn-primary {
          background: #c8102e;
          color: #fff;
        }
        .crm-btn-primary:hover:not(:disabled) {
          background: #a00d24;
        }
        .crm-btn-secondary {
          background: #fff;
          color: #1c1917;
          border-color: #ece5e1;
        }
        .crm-btn-secondary:hover:not(:disabled) {
          background: #f6f3f1;
        }
        .crm-btn-danger {
          background: #fff;
          color: #c8102e;
          border-color: #c8102e;
        }
        .crm-btn-danger:hover:not(:disabled) {
          background: #c8102e;
          color: #fff;
        }
      `}</style>
    </button>
  );
}

export function CrmSmallButton({ children, onClick, danger, disabled }: { children: ReactNode; onClick?: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`crm-sm-btn ${danger ? 'danger' : ''}`}>
      {children}
      <style jsx>{`
        .crm-sm-btn {
          padding: 4px 10px;
          border: 1px solid #ece5e1;
          background: #fff;
          border-radius: 4px;
          font-size: 12px;
          cursor: pointer;
          margin-right: 4px;
          white-space: nowrap;
        }
        .crm-sm-btn:hover {
          background: #f6f3f1;
        }
        .crm-sm-btn:disabled {
          color: #a8a29e;
          background: #f6f3f1;
          cursor: default;
        }
        .crm-sm-btn.danger {
          color: #c8102e;
          border-color: #fca5a5;
        }
        .crm-sm-btn.danger:hover {
          background: #fef2f2;
        }
      `}</style>
    </button>
  );
}

export function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  const csv = [headers, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function fmtDate(iso?: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}

export function fmtDateTime(iso?: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

/**
 * Authenticated attachment thumbnail for resident-report / patrol media. `<img>`
 * cannot send a bearer token, so the blob is fetched through the API client and
 * rendered via an object URL. Images show inline; other capture modes (video /
 * voice note) fall back to a labelled chip with a download link.
 */
export function CrmMediaThumb({
  mediaId,
  contentType,
  captureMode,
}: {
  mediaId: string;
  contentType: string;
  captureMode: string;
}) {
  const label = contentType.startsWith('image/')
    ? 'Photo'
    : contentType.startsWith('video/')
      ? 'Video'
      : captureMode.replace(/_/g, ' ');

  return <MediaThumb mediaId={mediaId} label={label} />;
}
