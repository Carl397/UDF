'use client';

import { useState } from 'react';
import { api } from '../../../lib/api';
import { CrmPageHeader, CrmCard, CrmField, CrmButton, downloadCsv } from '../../../components/crm/ui';

/**
 * CRM Reports — report builder with CSV export across cases, members,
 * participations and aggregated ward scorecards.
 */

type ReportType = 'service_requests' | 'members' | 'participations' | 'ward_scorecards';

const REPORT_LABELS: Record<ReportType, string> = {
  service_requests: 'Service Requests',
  members: 'Members',
  participations: 'Participations',
  ward_scorecards: 'Ward Scorecards',
};

export default function CrmReports() {
  const [reportType, setReportType] = useState<ReportType>('service_requests');
  const [generating, setGenerating] = useState(false);

  const generateReport = async () => {
    setGenerating(true);
    try {
      let headers: string[] = [];
      let rows: (string | number)[][] = [];
      let filename = '';

      switch (reportType) {
        case 'service_requests': {
          const res = await api.crmEngagements({ limit: '1000' });
          headers = ['Ref No', 'Title', 'Ward', 'Category', 'Severity', 'Status', 'Created'];
          rows = res.items.map((i: any) => [i.refNo ?? '', i.title ?? '', i.wardCode ?? '', i.category ?? '', i.severity ?? '', i.status ?? '', i.createdAt ?? '']);
          filename = 'service-requests';
          break;
        }
        case 'members': {
          const res = await api.crmMembers({ limit: '1000' });
          headers = ['Membership No', 'Public Code', 'Tier', 'Status', 'Ward', 'Created'];
          rows = res.items.map((i: any) => [i.membershipNo ?? '', i.publicCode ?? '', i.tier ?? '', i.status ?? '', i.ward ?? '', i.createdAt ?? '']);
          filename = 'members';
          break;
        }
        case 'participations': {
          const res = await api.listParticipations({ limit: '1000' });
          headers = ['Title', 'Type', 'Ward', 'Status', 'Start Date', 'End Date'];
          rows = res.items.map((i: any) => [i.title ?? '', i.type ?? '', i.wardCode ?? '', i.status ?? '', i.startDate ?? '', i.endDate ?? '']);
          filename = 'participations';
          break;
        }
        case 'ward_scorecards': {
          const res = await api.crmEngagements({ limit: '1000' });
          const wardMap = new Map<string, any[]>();
          for (const sr of res.items) {
            const ward = sr.wardCode ?? 'Unknown';
            if (!wardMap.has(ward)) wardMap.set(ward, []);
            wardMap.get(ward)!.push(sr);
          }
          headers = ['Ward', 'Total Requests', 'Open', 'Resolved'];
          rows = Array.from(wardMap.entries()).map(([ward, requests]) => [
            ward,
            requests.length,
            requests.filter((r) => !['closed', 'verified'].includes(r.status)).length,
            requests.filter((r) => ['resolved', 'verified'].includes(r.status)).length,
          ]);
          filename = 'ward-scorecards';
          break;
        }
      }

      downloadCsv(filename, headers, rows);
    } catch (error) {
      console.error('Failed to generate report:', error);
      alert('Failed to generate report. Please try again.');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div>
      <CrmPageHeader
        title="Reports"
        subtitle="Generate and export CSV reports across cases, members, participations and ward scorecards."
      />

      <CrmCard title="Report Builder">
        <CrmField label="Report Type">
          <select value={reportType} onChange={(e) => setReportType(e.target.value as ReportType)}>
            {(Object.keys(REPORT_LABELS) as ReportType[]).map((k) => (
              <option key={k} value={k}>{REPORT_LABELS[k]}</option>
            ))}
          </select>
        </CrmField>
        <CrmButton onClick={generateReport} disabled={generating}>
          {generating ? 'Generating…' : 'Generate & Export CSV'}
        </CrmButton>
      </CrmCard>

      <CrmCard title="Available Reports">
        <ul style={{ margin: 0, paddingLeft: 20, color: '#64748b', fontSize: 14, lineHeight: 1.6 }}>
          <li style={{ marginBottom: 12 }}>
            <strong style={{ color: '#141414' }}>Service Requests:</strong> All service delivery cases with status, category, severity and ward.
          </li>
          <li style={{ marginBottom: 12 }}>
            <strong style={{ color: '#141414' }}>Members:</strong> Member directory with tier, status, ward and public verification code.
          </li>
          <li style={{ marginBottom: 12 }}>
            <strong style={{ color: '#141414' }}>Participations:</strong> Public participation processes with type, dates and status.
          </li>
          <li>
            <strong style={{ color: '#141414' }}>Ward Scorecards:</strong> Aggregated case metrics by ward (total, open, resolved).
          </li>
        </ul>
      </CrmCard>
    </div>
  );
}
