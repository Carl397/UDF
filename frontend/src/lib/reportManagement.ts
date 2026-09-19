import { api } from './api';
import type { ReportFilters, ResidentReport } from '../types';

export const REPORT_PAGE_SIZE = 15;
export function c3Label(report: ResidentReport): string {
  if (report.c3Requirement === 'required') return report.hasC3 ? 'Required — number recorded' : 'Required — number missing';
  if (report.c3Requirement === 'not_required') return 'Not required';
  return 'Needs assessment';
}
export function acknowledgmentLabel(report: ResidentReport): string {
  if (report.acknowledgment === 'yes') return report.councillorAcknowledged ? 'Acknowledged by councillor' : 'Acknowledged by staff';
  return report.acknowledgment === 'unknown' ? 'Legacy acknowledgment unknown' : 'Not acknowledged';
}
export function safeReportCsvCell(value: unknown): string {
  const text = String(value ?? '');
  return /^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text) ? `'${text}` : text;
}
export async function reportExportRows(filters: ReportFilters) {
  const items: ResidentReport[] = [];
  const ids = new Set<string>();
  let total = 0;
  do {
    const page = await api.managedReports(filters, 200, items.length);
    if (!items.length) total = page.total;
    if (page.total !== total || (!page.items.length && items.length < total) || page.items.some((i) => ids.has(i.id))) {
      throw new Error('Reports changed during export. Please retry.');
    }
    page.items.forEach((i) => ids.add(i.id));
    items.push(...page.items);
  } while (items.length < total);
  return items.map((r) => [r.refNo, r.category, r.wardName ?? r.wardCode, r.councillorName,
    r.assignmentState, r.status, acknowledgmentLabel(r), r.acknowledgedByName, r.acknowledgedAt,
    r.lastActionAt ? 'Action recorded' : 'No action recorded', r.lastActionAt, r.councillorActionAt,
    c3Label(r), r.hasC3 ? 'C3 recorded' : 'No C3 recorded', r.openTasks, r.nextDueAt, r.message, r.createdAt].map(safeReportCsvCell));
}
export const REPORT_EXPORT_HEADERS = ['Reference','Category','Ward','Councillor','Assignment','Status','Acknowledgment',
  'Acknowledged by','Acknowledged at','Action evidence','Last action','Councillor action','C3 assessment','C3 number presence',
  'Open tasks','Next due','Message','Received'];

export function localDateTime(iso: string) {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
