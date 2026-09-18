'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { tiersParam } from '../../lib/taxonomy';
import { useShell } from '../AppShell';
import { EmptyState, Icon, initials, memberLabel, useToast } from '../ui';
import FilterBar from './FilterBar';
import MemberSheet from './MemberSheet';
import type { Member } from '../../types';

export default function MembersTab() {
  const { filters, caps } = useShell();
  const toast = useToast();
  const [items, setItems] = useState<Member[] | null>(null);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Member | null>(null);
  const [creating, setCreating] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // A tier multi-select: the joined list is the effect key so toggling a chip
  // reloads without re-firing on every render of a new array identity.
  const tierKey = filters.tiers.join(',');

  useEffect(() => {
    // Everything switched off means nothing to show. Dropping the parameter
    // instead would silently return the whole directory.
    if (filters.tiers.length === 0) {
      setItems([]);
      setTotal(0);
      return;
    }
    let cancelled = false;
    setItems(null);
    api
      .listMembers({
        regionCode: filters.regionCode || undefined,
        tiers: tiersParam(filters.tiers),
        status: filters.status || undefined,
        limit: 500,
      })
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setTotal(res.total);
      })
      .catch((e) => {
        if (!cancelled) {
          setItems([]);
          toast(e?.message ?? 'Failed to load members', 'err');
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.regionCode, tierKey, filters.status, reloadKey]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = items ?? [];
    if (!q) return list;
    return list.filter((m) =>
      [m.pii?.fullName, m.pii?.email, m.membershipNo, m.publicCode, m.regionCode, m.districtCode, m.ward, m.tier, m.status, ...m.tags]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [items, query]);

  return (
    <>
      <div className="search-wrap">
        <Icon name="search" />
        <input
          className="input"
          placeholder="Search name, email, tag, ward, party code…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div style={{ height: 10 }} />
      <FilterBar />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '4px 4px 10px' }}>
        <span style={{ fontSize: 12, color: 'var(--text-3)', fontWeight: 700 }}>
          {items === null ? 'Loading…' : `${visible.length} of ${total} members`}
        </span>
        <button className="icon-btn" onClick={() => setReloadKey((k) => k + 1)} aria-label="Refresh">
          <Icon name="refresh" />
        </button>
      </div>

      {items === null ? (
        <>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton" style={{ height: 66, marginBottom: 9 }} />
          ))}
        </>
      ) : visible.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="users"
            title="No members match"
            hint={
              caps.memberWrite
                ? 'Adjust filters or add a new member with the + button.'
                : 'Adjust the filters or the search above.'
            }
          />
        </div>
      ) : (
        visible.map((m) => {
          const label = memberLabel(m);
          return (
            <button key={m.id} className="member-card" onClick={() => setSelected(m)}>
              <span className={`member-avatar t-${m.tier}`}>
                {initials(label)}
              </span>
              <span className="member-main">
                <span className="member-name">
                  {label}
                  <span className="badge tier">{m.tier}</span>
                </span>
                <span className="member-meta">
                  {m.regionCode ?? '—'}
                  {m.ward ? ` · Ward ${m.ward}` : m.districtCode ? ` · ${m.districtCode}` : ''} ·{' '}
                  {/* D53: the public code *is* the label whenever PII is sealed,
                      so repeating it here would be noise — show the heat weight
                      instead and keep the code for the roles that see a name. */}
                  {label === m.publicCode || !m.publicCode
                    ? `weight ${m.heatWeight}`
                    : m.publicCode}
                </span>
              </span>
              <span
                className={`dot ${
                  m.status === 'active' ? 'ok' : m.status === 'suspended' ? 'danger' : m.status === 'pending' ? 'warn' : 'mute'
                }`}
                title={m.status}
              />
              <Icon name="chev" size={16} />
            </button>
          );
        })
      )}

      {/*
        The "Add member" FAB is `member:write`, not `member:read`. A ward
        councillor reads the directory and cannot add to it, so this used to
        render for them and fail on submit — the D7/D8 defect: a control the
        server refuses, offered anyway.
      */}
      {caps.memberWrite && (
        <button className="fab" onClick={() => setCreating(true)} aria-label="Add member">
          <Icon name="plus" />
        </button>
      )}

      {(selected || creating) && (
        <MemberSheet
          member={selected}
          onClose={() => {
            setSelected(null);
            setCreating(false);
          }}
          onSaved={() => setReloadKey((k) => k + 1)}
        />
      )}
    </>
  );
}
