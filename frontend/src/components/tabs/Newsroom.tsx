'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useShell } from '../AppShell';
import { EmptyState, Icon, Sheet, useToast } from '../ui';
import { BackRow } from './MoreTab';
import { REGIONS } from './FilterBar';
import type { Post, PostKind } from '../../types';

const KINDS: { value: PostKind; label: string }[] = [
  { value: 'news', label: 'News' },
  { value: 'press_release', label: 'Press' },
  { value: 'highlight', label: 'Highlights' },
  { value: 'statement', label: 'Statements' },
  { value: 'community_note', label: 'Community notes' },
  { value: 'service_delivery', label: 'Service delivery' },
];

const KIND_ICON: Record<string, string> = {
  news: 'doc',
  press_release: 'megaphone',
  highlight: 'star',
  statement: 'flag',
  community_note: 'alert',
  service_delivery: 'chart',
};

const SERVICE_AREAS = ['water', 'power', 'roads', 'health', 'education', 'sanitation', 'housing', 'other'];

/** Newsroom: everything the party publishes, plus community reports. */
export default function Newsroom() {
  const { open, caps, refreshUnread } = useShell();
  const [kind, setKind] = useState<PostKind | ''>('');
  const [includeModeration, setIncludeModeration] = useState(false);
  const [q, setQ] = useState('');
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [active, setActive] = useState<Post | null | undefined>(undefined);
  const [composeKind, setComposeKind] = useState<PostKind>('news');

  const load = useCallback(() => {
    api
      .listPosts({
        kind: kind || undefined,
        q: q || undefined,
        status: includeModeration && caps.moderate ? 'all' : 'published',
        limit: 60,
      })
      .then((r) => setPosts(r.items))
      .catch(() => setPosts([]));
  }, [kind, q, includeModeration, caps.moderate]);

  useEffect(load, [load]);

  return (
    <>
      <BackRow label="More" onClick={() => open('more', '')} />

      <div className="search-wrap" style={{ marginTop: 10 }}>
        <Icon name="search" size={16} />
        <input
          className="search-input"
          value={q}
          placeholder="Search headlines and reports"
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search communications"
        />
        {q && (
          <button className="icon-btn" onClick={() => setQ('')} aria-label="Clear search">
            <Icon name="x" size={15} />
          </button>
        )}
      </div>

      <div className="chip-row" style={{ marginTop: 10 }}>
        <button className={`chip ${kind === '' ? 'on' : ''}`} onClick={() => setKind('')}>
          All
        </button>
        {KINDS.map((k) => (
          <button key={k.value} className={`chip ${kind === k.value ? 'on' : ''}`} onClick={() => setKind(k.value)}>
            {k.label}
          </button>
        ))}
        {caps.moderate && (
          <button
            className={`chip ${includeModeration ? 'on' : ''}`}
            onClick={() => setIncludeModeration((v) => !v)}
          >
            {includeModeration ? 'Incl. taken down' : 'Published only'}
          </button>
        )}
      </div>

      {posts === null ? (
        <div className="skeleton" style={{ height: 96, marginTop: 12 }} />
      ) : posts.length === 0 ? (
        <div className="card" style={{ marginTop: 12 }}>
          <EmptyState icon="megaphone" title="Nothing published here yet" hint="Issue a press release or log a community note." />
        </div>
      ) : (
        <div className="list" style={{ marginTop: 12 }}>
          {posts.map((p) => (
            <button key={p.id} className="post-card" onClick={() => setActive(p)}>
              <span className="post-ico">
                <Icon name={KIND_ICON[p.kind] ?? 'doc'} size={16} />
              </span>
              <span className="post-main">
                <span className="post-kicker">
                  {KINDS.find((k) => k.value === p.kind)?.label ?? p.kind}
                  {p.regionCode ? ` · ${p.regionCode}` : ' · National'}
                  {p.ward ? ` · Ward ${p.ward}` : ''}
                  {p.severity === 'urgent' ? ' · urgent' : ''}
                </span>
                <span className="post-title">{p.title}</span>
                {p.excerpt && <span className="post-excerpt">{p.excerpt}</span>}
                <span className="post-foot">
                  {p.author ?? 'UDF Communications'} ·{' '}
                  {new Date(p.publishedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}
                </span>
              </span>
              {p.status !== 'published' && (
                <span className={`badge ${p.status === 'taken_down' ? 'danger' : 'warn'}`}>{p.status.replace('_', ' ')}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {caps.postWrite && (
        <button
          className="fab"
          onClick={() => {
            setComposeKind(kind === '' ? 'news' : kind);
            setActive(null);
          }}
          aria-label="New communication"
        >
          <Icon name="plus" size={22} />
        </button>
      )}

      {active !== undefined && (
        <PostSheet
          post={active}
          defaultKind={composeKind}
          onClose={() => setActive(undefined)}
          onChanged={() => {
            load();
            refreshUnread();
          }}
        />
      )}
    </>
  );
}

interface PostForm {
  kind: PostKind;
  title: string;
  excerpt: string;
  body: string;
  author: string;
  regionCode: string;
  ward: string;
  serviceArea: string;
  severity: string;
  status: 'draft' | 'published';
}

const emptyForm = (kind: PostKind): PostForm => ({
  kind,
  title: '',
  excerpt: '',
  body: '',
  author: 'UDF Communications',
  regionCode: '',
  ward: '',
  serviceArea: '',
  severity: '',
  status: 'published',
});

function PostSheet({
  post,
  defaultKind,
  onClose,
  onChanged,
}: {
  post: Post | null;
  defaultKind: PostKind;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { caps } = useShell();
  const toast = useToast();
  const [form, setForm] = useState<PostForm>(() =>
    post
      ? {
          kind: post.kind,
          title: post.title,
          excerpt: post.excerpt ?? '',
          body: post.body ?? '',
          author: post.author ?? '',
          regionCode: post.regionCode ?? '',
          ward: post.ward ?? '',
          serviceArea: post.serviceArea ?? '',
          severity: post.severity ?? '',
          status: post.status === 'draft' ? 'draft' : 'published',
        }
      : emptyForm(defaultKind),
  );
  const [editing, setEditing] = useState(!post);
  const [busy, setBusy] = useState(false);
  const [takingDown, setTakingDown] = useState(false);
  const [reason, setReason] = useState('');

  const set = (patch: Partial<PostForm>) => setForm((f) => ({ ...f, ...patch }));

  async function save() {
    if (!form.title.trim()) return toast('A headline is required', 'err');
    if (!form.body.trim() && form.kind !== 'highlight') return toast('Body text is required', 'err');
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        kind: form.kind,
        title: form.title.trim(),
        body: form.body.trim(),
        status: form.status,
        author: form.author.trim() || undefined,
        excerpt: form.excerpt.trim() || undefined,
        regionCode: form.regionCode || undefined,
        ward: form.ward.trim() || undefined,
        serviceArea: form.serviceArea || undefined,
        severity: form.severity || undefined,
      };
      if (post) await api.updatePost(post.id, payload);
      else await api.createPost(payload);
      toast(post ? 'Updated' : form.status === 'draft' ? 'Saved as draft' : 'Published — members notified', 'ok');
      onChanged();
      onClose();
    } catch (e: any) {
      toast(e?.message ?? 'Could not save', 'err');
    } finally {
      setBusy(false);
    }
  }

  async function takeDown() {
    if (!post) return;
    if (reason.trim().length < 3) return toast('Give a reason for the take-down', 'err');
    setBusy(true);
    try {
      await api.takeDownPost(post.id, reason.trim());
      toast('Taken down — reason recorded in the audit log', 'ok');
      onChanged();
      onClose();
    } catch (e: any) {
      toast(e?.message ?? 'Could not take down', 'err');
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    if (!post) return;
    setBusy(true);
    try {
      await api.restorePost(post.id);
      toast('Republished', 'ok');
      onChanged();
      onClose();
    } catch (e: any) {
      toast(e?.message ?? 'Could not restore', 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={editing ? (post ? 'Edit item' : 'New item') : post?.title ?? 'Item'}
      subtitle={
        editing
          ? 'News, press releases, highlights, statements and community notes'
          : `${KINDS.find((k) => k.value === post?.kind)?.label ?? post?.kind} · ${
              post ? new Date(post.publishedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : ''
            }`
      }
      onClose={onClose}
      footer={
        editing ? (
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" style={{ flex: 2 }} onClick={save} disabled={busy}>
              <Icon name="send" size={16} /> {busy ? 'Saving…' : form.status === 'draft' ? 'Save draft' : 'Publish'}
            </button>
          </div>
        ) : takingDown ? (
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setTakingDown(false)}>
              Cancel
            </button>
            <button className="btn btn-danger" style={{ flex: 2 }} onClick={takeDown} disabled={busy}>
              Take down
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 10 }}>
            {caps.postWrite && (
              <button className="btn btn-primary" style={{ flex: 2 }} onClick={() => setEditing(true)}>
                <Icon name="edit" size={16} /> Edit
              </button>
            )}
            {caps.moderate && post?.status === 'published' && (
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setTakingDown(true)}>
                <Icon name="alert" size={16} /> Take down
              </button>
            )}
            {caps.moderate && post?.status === 'taken_down' && (
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={restore} disabled={busy}>
                <Icon name="refresh" size={16} /> Restore
              </button>
            )}
            {!caps.postWrite && (
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>
                Close
              </button>
            )}
          </div>
        )
      }
    >
      {editing ? (
        <div className="form-grid">
          <div className="field">
            <label>Type</label>
            <div className="chip-row">
              {KINDS.map((k) => (
                <button
                  key={k.value}
                  type="button"
                  className={`chip ${form.kind === k.value ? 'on' : ''}`}
                  onClick={() => set({ kind: k.value })}
                >
                  {k.label}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label htmlFor="p-title">Headline</label>
            <input
              id="p-title"
              className="input"
              value={form.title}
              maxLength={200}
              placeholder="UDF calls for published water outage register"
              onChange={(e) => set({ title: e.target.value })}
            />
          </div>

          <div className="field">
            <label htmlFor="p-excerpt">Standfirst / summary</label>
            <input
              id="p-excerpt"
              className="input"
              value={form.excerpt}
              maxLength={400}
              placeholder="One or two lines shown in lists and alerts"
              onChange={(e) => set({ excerpt: e.target.value })}
            />
          </div>

          <div className="field">
            <label htmlFor="p-body">Body</label>
            <textarea
              id="p-body"
              className="input"
              rows={9}
              value={form.body}
              maxLength={20000}
              placeholder={
                form.kind === 'community_note'
                  ? 'What was reported, where, since when, reference numbers, evidence…'
                  : 'Full text of the release…'
              }
              onChange={(e) => set({ body: e.target.value })}
            />
          </div>

          {(form.kind === 'community_note' || form.kind === 'service_delivery') && (
            <div className="field-row">
              <div className="field">
                <label htmlFor="p-area">Service area</label>
                <select
                  id="p-area"
                  className="input"
                  value={form.serviceArea}
                  onChange={(e) => set({ serviceArea: e.target.value })}
                >
                  <option value="">—</option>
                  {SERVICE_AREAS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="p-sev">Severity</label>
                <select
                  id="p-sev"
                  className="input"
                  value={form.severity}
                  onChange={(e) => set({ severity: e.target.value })}
                >
                  <option value="">—</option>
                  <option value="info">info</option>
                  <option value="report">report</option>
                  <option value="urgent">urgent</option>
                </select>
              </div>
            </div>
          )}

          <div className="field-row">
            <div className="field">
              <label htmlFor="p-region">Region</label>
              <select
                id="p-region"
                className="input"
                value={form.regionCode}
                onChange={(e) => set({ regionCode: e.target.value })}
              >
                <option value="">National</option>
                {REGIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="p-ward">Ward</label>
              <input
                id="p-ward"
                className="input"
                value={form.ward}
                maxLength={64}
                placeholder="12"
                onChange={(e) => set({ ward: e.target.value })}
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="p-author">Publishing desk</label>
            <input
              id="p-author"
              className="input"
              value={form.author}
              maxLength={120}
              onChange={(e) => set({ author: e.target.value })}
            />
          </div>

          <div className="field">
            <label>Status</label>
            <div className="chip-row">
              {(['published', 'draft'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`chip ${form.status === s ? 'on' : ''}`}
                  onClick={() => set({ status: s })}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : takingDown ? (
        <div className="form-grid">
          <div className="banner warn">
            Taking a community note down hides it from the public feed but keeps the record and the
            reason — nothing is silently deleted.
          </div>
          <div className="field">
            <label htmlFor="p-reason">Reason for take-down</label>
            <textarea
              id="p-reason"
              className="input"
              rows={4}
              value={reason}
              maxLength={500}
              placeholder="Claim could not be verified — no reference number supplied"
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>
      ) : (
        post && (
          <>
            <div className="chip-row" style={{ marginBottom: 12 }}>
              <span className="badge tier">{KINDS.find((k) => k.value === post.kind)?.label ?? post.kind}</span>
              {post.regionCode && <span className="badge">{post.regionCode}</span>}
              {post.ward && <span className="badge">Ward {post.ward}</span>}
              {post.serviceArea && <span className="badge">{post.serviceArea}</span>}
              {post.severity && (
                <span className={`badge ${post.severity === 'urgent' ? 'danger' : ''}`}>{post.severity}</span>
              )}
              <span className={`badge ${post.status === 'published' ? 'ok' : post.status === 'taken_down' ? 'danger' : 'warn'}`}>
                {post.status.replace('_', ' ')}
              </span>
            </div>

            {post.status === 'taken_down' && post.takeDownReason && (
              <div className="banner err">
                Taken down {post.takenDownAt ? new Date(post.takenDownAt).toLocaleDateString() : ''}: {post.takeDownReason}
              </div>
            )}

            {post.excerpt && <p className="sheet-text strong">{post.excerpt}</p>}
            <p className="sheet-text">{post.body}</p>

            <div className="kv" style={{ marginTop: 14 }}>
              <span className="k">Desk</span>
              <span className="v">{post.author ?? '—'}</span>
            </div>
            <div className="kv">
              <span className="k">Published</span>
              <span className="v">{new Date(post.publishedAt).toLocaleString()}</span>
            </div>
          </>
        )
      )}
    </Sheet>
  );
}
