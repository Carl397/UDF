'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { EventAttendee } from '../../types';
import { CrmModal, CrmTable, CrmBadge, fmtDateTime } from './ui';

/**
 * EventAttendees — the backoffice guest list for one event.
 *
 * Shows WHO is going / interested (the point of the named RSVP), resolved
 * server-side to the organiser who owns the event's territory. The server
 * decrypts each member's name for this read and audits it, so the CRM just
 * renders what it is given.
 */
export function EventAttendees({
  eventId,
  eventTitle,
  onClose,
}: {
  eventId: string;
  eventTitle: string;
  onClose: () => void;
}) {
  const [items, setItems] = useState<EventAttendee[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api
      .listEventAttendees(eventId)
      .then((r) => setItems(r.items ?? []))
      .catch((e: any) => setError(e?.message ?? 'Could not load the guest list'));
    return () => controller.abort();
  }, [eventId]);

  const going = (items ?? []).filter((i) => i.response === 'going').length;
  const interested = (items ?? []).filter((i) => i.response === 'interested').length;

  return (
    <CrmModal title={`Attendees — ${eventTitle}`} onClose={onClose}>
      <p style={{ color: '#475569', fontSize: 13, margin: '0 0 10px' }}>
        {items === null ? 'Loading…' : `${going} going · ${interested} interested`}
      </p>
      {error && <p style={{ color: '#dc2626', fontSize: 13 }}>{error}</p>}
      {items && (
        <CrmTable
          columns={['Name', 'Membership no.', 'Ward', 'Response', 'RSVP’d']}
          rows={items.map((a, idx) => [
            a.name ?? '—',
            a.membershipNo ?? '—',
            a.ward ?? '—',
            <CrmBadge key={`r${idx}`} value={a.response} />,
            fmtDateTime(a.at),
          ])}
          empty="No one has responded yet."
        />
      )}
    </CrmModal>
  );
}
