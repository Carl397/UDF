'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useShell } from '../AppShell';
import { Icon } from '../ui';
import { BackRow } from './MoreTab';
import type { Manifesto, Position } from '../../types';

const LEVEL_ORDER = ['national', 'region', 'district', 'ward', 'branch'];
const LEVEL_LABEL: Record<string, string> = {
  national: 'National',
  region: 'Regional',
  district: 'District',
  ward: 'Ward',
  branch: 'Branch',
};

/** Mission, vision, values, policy pillars, member guide and party offices. */
export default function ManifestoView() {
  const { open } = useShell();
  const [doc, setDoc] = useState<Manifesto | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);

  useEffect(() => {
    api.manifesto().then(setDoc).catch(() => setDoc(null));
    api.listPositions().then((r) => setPositions(r.items)).catch(() => setPositions([]));
  }, []);

  if (!doc) {
    return (
      <>
        <BackRow label="More" onClick={() => open('more', '')} />
        <div className="skeleton" style={{ height: 120, marginTop: 12 }} />
        <div className="skeleton" style={{ height: 120, marginTop: 12 }} />
      </>
    );
  }

  const grouped = LEVEL_ORDER.map((level) => ({
    level,
    items: positions.filter((p) => p.level === level),
  })).filter((g) => g.items.length > 0);

  return (
    <>
      <BackRow label="More" onClick={() => open('more', '')} />

      <div className="card hero-card compact" style={{ marginTop: 10 }}>
        <span className="eyebrow">{doc.party.fullName}</span>
        <h2>{doc.party.tagline}</h2>
        <p>{doc.party.slogan}</p>
      </div>

      <div className="section-label">Mission</div>
      <div className="card quote-card">
        <Icon name="flag" size={18} />
        <p>{doc.mission}</p>
      </div>

      <div className="section-label">Vision</div>
      <div className="card quote-card gold">
        <Icon name="star" size={18} />
        <p>{doc.vision}</p>
      </div>

      <div className="section-label">Our values</div>
      <div className="rows">
        {doc.values.map((v) => (
          <div className="row" key={v.name}>
            <span className="row-ico"><Icon name="checkCircle" /></span>
            <span className="row-main">
              <span className="row-title">{v.name}</span>
              <span className="row-sub">{v.text}</span>
            </span>
          </div>
        ))}
      </div>

      <div className="section-label">What we stand for</div>
      {doc.pillars.map((p) => (
        <div className="card pillar-card" key={p.title}>
          <div className="card-title">{p.title}</div>
          <ul className="bullet-list">
            {p.points.map((pt) => (
              <li key={pt}>{pt}</li>
            ))}
          </ul>
        </div>
      ))}

      <div className="section-label">Member guide</div>
      <div className="card">
        <p className="sheet-text" style={{ marginTop: 0 }}>{doc.guide.intro}</p>
        <div className="struct-list">
          {doc.guide.structures.map((s) => (
            <div className="struct" key={s.level}>
              <span className="struct-level">{s.level}</span>
              <span className="struct-main">
                <span className="struct-body">{s.body}</span>
                <span className="struct-role">{s.role}</span>
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-title">Duties of every member</div>
        <ul className="bullet-list">
          {doc.guide.memberDuties.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-title">How mandates work</div>
        <ul className="bullet-list">
          {doc.guide.mandateRules.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
        <button className="btn btn-ghost btn-block btn-sm" style={{ marginTop: 12 }} onClick={() => open('engage', 'appointments')}>
          <Icon name="shield" size={16} /> View appointments & mandates
        </button>
      </div>

      <div className="section-label">Party offices — roles for every kind of member</div>
      {grouped.map((g) => (
        <div key={g.level} style={{ marginBottom: 12 }}>
          <div className="mini-label">{LEVEL_LABEL[g.level] ?? g.level}</div>
          <div className="rows">
            {g.items.map((p) => (
              <div className="row" key={p.code}>
                <span className="row-ico"><Icon name="idcard" /></span>
                <span className="row-main">
                  <span className="row-title">{p.name}</span>
                  <span className="row-sub">
                    {p.description}
                    {p.termMonths ? ` · ${p.termMonths}-month term` : ''}
                  </span>
                </span>
                <span className="badge tier">{p.tier}</span>
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="section-label">Press & contact</div>
      <div className="card">
        <div className="kv"><span className="k">Press desk</span><span className="v">{doc.party.contacts.press}</span></div>
        <div className="kv"><span className="k">General</span><span className="v">{doc.party.contacts.email}</span></div>
        <div className="kv"><span className="k">Address</span><span className="v">{doc.party.contacts.address}</span></div>
        <div className="kv"><span className="k">Hours</span><span className="v">{doc.party.officeHours}</span></div>
      </div>

      <div style={{ height: 12 }} />
    </>
  );
}
