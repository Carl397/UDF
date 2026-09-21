'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, cmsMediaUrl } from '../../../lib/api';
import type {
  ContentBlockSummary, ContentBlockFull, ContentBlockKind, ContentVersion,
  ContentPageSummary, PageSectionRef,
} from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { can, Perm } from '../../../lib/caps';
import {
  CrmPageHeader, CrmCard, CrmBadge, CrmButton, CrmSmallButton, fmtDateTime,
} from '../../../components/crm/ui';

/**
 * Platform → Website (SuperAdmin CMS, `content:manage`).
 *
 * Two surfaces in one editor:
 *  - Pages: per-site documents whose `sections` are an ordered list of blocks.
 *    Publishing snapshots the page (title + section order); rollback restores.
 *  - Blocks: the actual content. `fields` blocks render schema-driven controls
 *    (text / textarea / url / image / list), `slider` blocks render a repeater
 *    of image + title + text + per-slide duration, `section` blocks are simple
 *    heading/body sections. Draft/publish/rollback semantics are identical.
 * Nothing here ever exposes a draft publicly — the public APIs only serve
 * published payloads.
 */

// ── Field schema model (mirrors backend block `schema` jsonb) ──────────────

type FieldType = 'text' | 'textarea' | 'url' | 'image' | 'list';
interface FieldSchema {
  label: string;
  type?: FieldType;
  maxLength?: number;
  itemMaxLength?: number;
}
type SchemaMap = Record<string, FieldSchema>;
/** A block draft payload: strings for scalar fields, arrays for lists. */
type FieldValues = Record<string, string | string[]>;

interface Slide {
  imageMediaId: string;
  title: string;
  text: string;
  durationSeconds: number;
}

function asSchema(v: unknown): SchemaMap {
  return (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as SchemaMap;
}

function asFieldValues(v: unknown): FieldValues {
  const src = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const out: FieldValues = {};
  for (const [k, val] of Object.entries(src)) {
    if (Array.isArray(val)) out[k] = val.map((x) => (x == null ? '' : String(x)));
    else if (val != null && typeof val === 'object') out[k] = String((val as { mediaId?: unknown }).mediaId ?? '');
    else out[k] = val == null ? '' : String(val);
  }
  return out;
}

function asSlides(v: unknown): Slide[] {
  const src = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const rows = Array.isArray(src.slides) ? src.slides : [];
  return rows.map((r) => {
    const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    return {
      imageMediaId: typeof o.imageMediaId === 'string' ? o.imageMediaId : '',
      title: typeof o.title === 'string' ? o.title : '',
      text: typeof o.text === 'string' ? o.text : '',
      durationSeconds: typeof o.durationSeconds === 'number' && o.durationSeconds > 0
        ? Math.min(o.durationSeconds, 120) : 5,
    };
  });
}

const slugHint = 'Lowercase letters, digits, dot, underscore or hyphen; must start with a letter or digit.';
const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;

// ── Media helpers ───────────────────────────────────────────────────────────

function readFileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('Could not read the selected file'));
    fr.readAsDataURL(file);
  });
}

/** Thumbnail for a stored mediaId. The CMS route is public, so a plain <img> works. */
function MediaThumb({ mediaId }: { mediaId: string }) {
  if (!mediaId) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={cmsMediaUrl(mediaId)}
      alt=""
      style={{ width: 96, height: 64, objectFit: 'cover', borderRadius: 6, border: '1px solid #ece5e1', display: 'block' }}
    />
  );
}

/** image field control: file picker → upload → store mediaId, with preview. */
function ImageControl(props: { value: string; onChange: (mediaId: string) => void; onError: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      props.onError('Only image files can be uploaded.');
      return;
    }
    setBusy(true);
    props.onError('');
    try {
      const dataUrl = await readFileDataUrl(file);
      const r = await api.uploadCmsMedia(dataUrl);
      props.onChange(r.mediaId);
    } catch (err) {
      props.onError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      {props.value
        ? <MediaThumb mediaId={props.value} />
        : <span style={{ fontSize: 13, color: '#8a817b' }}>No image selected</span>}
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        style={{ display: 'none' }}
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      <CrmSmallButton onClick={() => fileRef.current?.click()} disabled={busy}>
        {busy ? 'Uploading…' : props.value ? 'Replace' : 'Upload image'}
      </CrmSmallButton>
      {props.value && (
        <CrmSmallButton onClick={() => props.onChange('')} disabled={busy}>Remove</CrmSmallButton>
      )}
    </div>
  );
}

/** list field control: a repeater of plain text rows. */
function ListControl(props: {
  label: string; items: string[]; itemMaxLength?: number;
  onChange: (items: string[]) => void;
}) {
  const set = (i: number, v: string) => props.onChange(props.items.map((x, j) => (j === i ? v : x)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= props.items.length) return;
    const next = [...props.items];
    [next[i], next[j]] = [next[j], next[i]];
    props.onChange(next);
  };
  return (
    <div>
      {props.items.map((item, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
          <input
            type="text"
            value={item}
            maxLength={props.itemMaxLength}
            onChange={(e) => set(i, e.target.value)}
            style={{ ...inputStyle, flex: 1 }}
          />
          <CrmSmallButton onClick={() => move(i, -1)} disabled={i === 0}>↑</CrmSmallButton>
          <CrmSmallButton onClick={() => move(i, 1)} disabled={i === props.items.length - 1}>↓</CrmSmallButton>
          <CrmSmallButton onClick={() => props.onChange(props.items.filter((_, j) => j !== i))}>✕</CrmSmallButton>
        </div>
      ))}
      <CrmSmallButton onClick={() => props.onChange([...props.items, ''])}>+ Add item</CrmSmallButton>
      {props.items.length === 0 && <span style={{ fontSize: 12, color: '#8a817b', marginLeft: 8 }}>No items yet.</span>}
    </div>
  );
}

// ── Slider block editor ─────────────────────────────────────────────────────

function SliderEditor(props: {
  slides: Slide[]; onChange: (slides: Slide[]) => void; onError: (msg: string) => void;
}) {
  const { slides, onChange } = props;
  const patch = (i: number, p: Partial<Slide>) => onChange(slides.map((s, j) => (j === i ? { ...s, ...p } : s)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= slides.length) return;
    const next = [...slides];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div>
      {slides.map((s, i) => (
        <div key={i} style={{ border: '1px solid #ece5e1', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <strong style={{ fontSize: 13 }}>Slide {i + 1}</strong>
            <span style={{ display: 'flex', gap: 4 }}>
              <CrmSmallButton onClick={() => move(i, -1)} disabled={i === 0}>↑</CrmSmallButton>
              <CrmSmallButton onClick={() => move(i, 1)} disabled={i === slides.length - 1}>↓</CrmSmallButton>
              <CrmSmallButton onClick={() => onChange(slides.filter((_, j) => j !== i))}>Remove</CrmSmallButton>
            </span>
          </div>
          <div style={{ marginBottom: 8 }}>
            <ImageControl
              value={s.imageMediaId}
              onChange={(mediaId) => patch(i, { imageMediaId: mediaId })}
              onError={props.onError}
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px', gap: 10, marginBottom: 8 }}>
            <input
              type="text" placeholder="Slide title" value={s.title} maxLength={160}
              onChange={(e) => patch(i, { title: e.target.value })} style={inputStyle}
            />
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#8a817b' }}>
              Seconds
              <input
                type="number" min={2} max={120} value={s.durationSeconds}
                onChange={(e) => {
                  const n = Math.round(Number(e.target.value));
                  patch(i, { durationSeconds: Number.isFinite(n) ? Math.min(Math.max(n, 2), 120) : 5 });
                }}
                style={{ ...inputStyle, width: 76 }}
              />
            </label>
          </div>
          <textarea
            placeholder="Slide text" value={s.text} rows={2} maxLength={600}
            onChange={(e) => patch(i, { text: e.target.value })} style={inputStyle}
          />
        </div>
      ))}
      {slides.length === 0 && <p style={{ color: '#8a817b', fontSize: 13 }}>No slides yet — add the first one below.</p>}
      <CrmButton
        onClick={() => onChange([...slides, { imageMediaId: '', title: '', text: '', durationSeconds: 5 }])}
        disabled={slides.length >= 12}
      >
        + Add slide
      </CrmButton>
      {slides.length >= 12 && <span style={{ fontSize: 12, color: '#8a817b', marginLeft: 8 }}>Max 12 slides.</span>}
    </div>
  );
}

// ── Block editor (all kinds) ────────────────────────────────────────────────

function BlocksTab() {
  const [blocks, setBlocks] = useState<ContentBlockSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ block: ContentBlockFull; versions: ContentVersion[] } | null>(null);
  const [fields, setFields] = useState<FieldValues>({});
  const [slides, setSlides] = useState<Slide[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const refreshList = useCallback(() => {
    api.listContentBlocks().then((r) => setBlocks(r.blocks)).catch(() => setBlocks([]));
  }, []);
  useEffect(() => { refreshList(); }, [refreshList]);

  const loadDraft = useCallback((block: ContentBlockFull) => {
    if (block.kind === 'slider') setSlides(asSlides(block.draft));
    else setFields(asFieldValues(block.draft));
  }, []);

  const open = useCallback(async (key: string) => {
    setSelected(key);
    setNotice(null);
    setError(null);
    setDirty(false);
    try {
      const r = await api.getContentBlock(key);
      setDetail(r);
      loadDraft(r.block);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load that block');
    }
  }, [loadDraft]);

  const reload = useCallback(async () => {
    if (!selected) return;
    const r = await api.getContentBlock(selected);
    setDetail(r);
    loadDraft(r.block);
    setDirty(false);
    refreshList();
  }, [selected, loadDraft, refreshList]);

  /** Build the payload to persist from the current kind-specific editor state. */
  const currentDraft = (): unknown => {
    if (detail?.block.kind === 'slider') return { slides };
    return fields;
  };

  /** Run an action, then re-read the block — unless the action removed it. */
  const guard = async (fn: () => Promise<unknown>, msg: string, keepReload = true) => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      await fn();
      setNotice(msg);
      if (keepReload) await reload();
      else refreshList();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  const markDirty = () => { setDirty(true); setNotice(null); };

  const saveDraft = () => guard(() => api.saveContentDraft(selected!, currentDraft()), 'Draft saved.');
  const publish = () => {
    const run = async () => {
      if (dirty) {
        // Publish copies the stored draft, so persist unsaved edits first.
        await api.saveContentDraft(selected!, currentDraft());
      }
      await api.publishContentBlock(selected!);
    };
    void guard(run, 'Draft saved and published.');
  };
  const rollback = (version: number) => {
    if (!window.confirm(`Roll back to version ${version}? This republishes that snapshot as a new version.`)) return;
    void guard(() => api.rollbackContentBlock(selected!, version), `Rolled back to v${version}.`);
  };
  const remove = () => {
    if (!selected) return;
    if (!window.confirm(`Delete block "${selected}"? Its drafts and versions are removed; pages must not reference it.`)) return;
    void guard(async () => {
      await api.deleteContentBlock(selected);
      setSelected(null);
      setDetail(null);
    }, 'Block deleted.', false);
  };

  const kind = detail?.block.kind ?? 'fields';
  const schema = asSchema(detail?.block.schema);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 20, alignItems: 'start' }}>
      <CrmCard
        title="Blocks"
        footer={<CrmSmallButton onClick={() => setShowCreate((v) => !v)} disabled={showCreate}>+ New block</CrmSmallButton>}
      >
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {blocks.map((b) => (
            <li key={b.key}>
              <button
                type="button"
                onClick={() => void open(b.key)}
                style={{
                  width: '100%', textAlign: 'left', padding: '10px 12px', marginBottom: 4, cursor: 'pointer',
                  border: selected === b.key ? '1px solid #c8102e' : '1px solid #ece5e1',
                  borderRadius: 6, background: selected === b.key ? '#fef2f4' : '#fff',
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 14 }}>{b.title}</div>
                <div style={{ fontSize: 12, color: '#8a817b' }}>
                  {b.site} · {b.kind} · v{b.version}
                </div>
                {b.hasUnpublishedChanges && (
                  <span style={{ fontSize: 11, color: '#d97706' }}>unpublished changes</span>
                )}
              </button>
            </li>
          ))}
          {blocks.length === 0 && <li style={{ color: '#8a817b', fontSize: 13 }}>No content blocks.</li>}
        </ul>
      </CrmCard>

      <div>
        {showCreate && (
          <NewBlockForm
            onDone={() => { setShowCreate(false); refreshList(); }}
            onCancel={() => setShowCreate(false)}
          />
        )}
        {!detail || !selected ? (
          !showCreate && (
            <CrmCard>
              <p style={{ color: '#8a817b', margin: 0 }}>Select a block to edit its content, or create a new one.</p>
            </CrmCard>
          )
        ) : (
          <>
            <CrmCard
              title={`${detail.block.title} · ${detail.block.kind} · v${detail.block.version}`}
              footer={
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <CrmButton onClick={saveDraft} disabled={busy || !dirty}>Save draft</CrmButton>
                  <CrmButton onClick={publish} disabled={busy}>Publish</CrmButton>
                  <CrmSmallButton onClick={remove} disabled={busy}>Delete block</CrmSmallButton>
                  {notice && <span style={{ fontSize: 13, color: '#166534' }}>{notice}</span>}
                  {error && <span style={{ fontSize: 13, color: '#c8102e' }}>{error}</span>}
                  <span style={{ marginLeft: 'auto', fontSize: 12, color: '#8a817b' }}>
                    {dirty ? 'unsaved edits' : `last updated ${fmtDateTime(detail.block.updatedAt)}`}
                  </span>
                </div>
              }
            >
              {kind === 'slider' ? (
                <SliderEditor
                  slides={slides}
                  onChange={(s) => { setSlides(s); markDirty(); }}
                  onError={(m) => { if (m) setError(m); }}
                />
              ) : (
                Object.entries(schema).map(([key, field]) => (
                  <div key={key} style={{ marginBottom: 14 }}>
                    <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6, color: '#8a817b' }}>
                      {field.label}
                      {field.type !== 'list' && field.maxLength
                        ? <span style={{ fontWeight: 400 }}> ({String(fields[key] ?? '').length}/{field.maxLength})</span>
                        : null}
                    </label>
                    {field.type === 'textarea' && (
                      <textarea
                        value={String(fields[key] ?? '')}
                        maxLength={field.maxLength}
                        rows={3}
                        onChange={(e) => { setFields((f) => ({ ...f, [key]: e.target.value })); markDirty(); }}
                        style={inputStyle}
                      />
                    )}
                    {field.type === 'list' && (
                      <ListControl
                        label={field.label}
                        items={Array.isArray(fields[key]) ? (fields[key] as string[]) : []}
                        itemMaxLength={field.itemMaxLength ?? field.maxLength}
                        onChange={(items) => { setFields((f) => ({ ...f, [key]: items })); markDirty(); }}
                      />
                    )}
                    {field.type === 'image' && (
                      <ImageControl
                        value={String(fields[key] ?? '')}
                        onChange={(mediaId) => { setFields((f) => ({ ...f, [key]: mediaId })); markDirty(); }}
                        onError={(m) => { if (m) setError(m); }}
                      />
                    )}
                    {(field.type === undefined || field.type === 'text' || field.type === 'url') && (
                      <input
                        type="text"
                        inputMode={field.type === 'url' ? 'url' : undefined}
                        value={String(fields[key] ?? '')}
                        maxLength={field.maxLength}
                        onChange={(e) => { setFields((f) => ({ ...f, [key]: e.target.value })); markDirty(); }}
                        style={inputStyle}
                      />
                    )}
                  </div>
                ))
              )}
              {kind === 'fields' && Object.keys(schema).length === 0 && (
                <p style={{ color: '#8a817b', fontSize: 13 }}>
                  This block has no fields yet. Add them to its schema via the API or recreate the block.
                </p>
              )}
            </CrmCard>

            <CrmCard title="Version history">
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: '#8a817b', fontSize: 12, textTransform: 'uppercase' }}>
                    <th style={{ padding: '6px 8px' }}>Version</th>
                    <th style={{ padding: '6px 8px' }}>Published</th>
                    <th style={{ padding: '6px 8px' }} />
                  </tr>
                </thead>
                <tbody>
                  {detail.versions.map((v) => (
                    <tr key={v.version} style={{ borderTop: '1px solid #f2ece8' }}>
                      <td style={{ padding: '6px 8px' }}>
                        <strong>v{v.version}</strong>
                        {v.version === detail.block.version && (
                          <span style={{ marginLeft: 8 }}><CrmBadge value="live" /></span>
                        )}
                      </td>
                      <td style={{ padding: '6px 8px', color: '#8a817b' }}>{fmtDateTime(v.createdAt)}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                        {v.version !== detail.block.version && (
                          <CrmSmallButton onClick={() => rollback(v.version)} disabled={busy}>
                            Roll back
                          </CrmSmallButton>
                        )}
                      </td>
                    </tr>
                  ))}
                  {detail.versions.length === 0 && (
                    <tr><td colSpan={3} style={{ padding: 12, color: '#8a817b' }}>No versions recorded.</td></tr>
                  )}
                </tbody>
              </table>
            </CrmCard>
          </>
        )}
      </div>
    </div>
  );
}

/** Create-block form: key/site/title/kind, plus simple text fields for `fields`. */
function NewBlockForm(props: { onDone: () => void; onCancel: () => void }) {
  const [key, setKey] = useState('');
  const [site, setSite] = useState<'marketing' | 'app' | 'shared'>('marketing');
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<ContentBlockKind>('fields');
  const [fieldNames, setFieldNames] = useState('heading\nbody');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setError(null);
    if (!SLUG_RE.test(key)) { setError(`Key is invalid. ${slugHint}`); return; }
    if (!title.trim()) { setError('Title is required.'); return; }
    const schema: SchemaMap = {};
    if (kind === 'fields' || kind === 'section') {
      for (const raw of fieldNames.split(/[\n,]/)) {
        const name = raw.trim();
        if (!name) continue;
        schema[name] = { label: name.charAt(0).toUpperCase() + name.slice(1), type: name.length > 80 ? 'textarea' : 'text', maxLength: 2000 };
      }
    }
    setBusy(true);
    try {
      await api.createContentBlock({ key, site, title: title.trim(), kind, schema });
      props.onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
      setBusy(false);
    }
  };

  return (
    <CrmCard title="New block">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
        <input style={inputStyle} placeholder="key (e.g. home.slider)" value={key} onChange={(e) => setKey(e.target.value)} />
        <input style={inputStyle} placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <select style={inputStyle} value={site} onChange={(e) => setSite(e.target.value as typeof site)}>
          <option value="marketing">marketing</option>
          <option value="app">app</option>
          <option value="shared">shared</option>
        </select>
        <select style={inputStyle} value={kind} onChange={(e) => setKind(e.target.value as ContentBlockKind)}>
          <option value="fields">fields (text / image / list)</option>
          <option value="slider">slider (images + durations)</option>
          <option value="section">section (heading + body)</option>
        </select>
      </div>
      {kind !== 'slider' && (
        <label style={{ display: 'block', fontSize: 13, marginBottom: 10 }}>
          <span style={{ fontWeight: 600, color: '#8a817b' }}>Field names (one per line, all text fields)</span>
          <textarea style={inputStyle} rows={3} value={fieldNames} onChange={(e) => setFieldNames(e.target.value)} />
        </label>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <CrmButton onClick={() => void create()} disabled={busy}>{busy ? 'Creating…' : 'Create block'}</CrmButton>
        <CrmSmallButton onClick={props.onCancel} disabled={busy}>Cancel</CrmSmallButton>
        {error && <span style={{ fontSize: 13, color: '#c8102e' }}>{error}</span>}
      </div>
    </CrmCard>
  );
}

// ── Pages tab ───────────────────────────────────────────────────────────────

function PagesTab() {
  const [pages, setPages] = useState<ContentPageSummary[]>([]);
  const [blocks, setBlocks] = useState<ContentBlockSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [sections, setSections] = useState<PageSectionRef[]>([]);
  const [publishedSections, setPublishedSections] = useState<PageSectionRef[] | null>(null);
  const [version, setVersion] = useState(0);
  const [versions, setVersions] = useState<ContentVersion[]>([]);
  const [dirty, setDirty] = useState(false);
  const [titleDirty, setTitleDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addKey, setAddKey] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const refreshList = useCallback(() => {
    api.listContentPages().then((r) => setPages(r.pages)).catch(() => setPages([]));
    api.listContentBlocks().then((r) => setBlocks(r.blocks)).catch(() => setBlocks([]));
  }, []);
  useEffect(() => { refreshList(); }, [refreshList]);

  const reload = useCallback(async (slug: string) => {
    const r = await api.getContentPage(slug);
    setTitle(r.page.title);
    setSections(r.page.sections ?? []);
    setPublishedSections(r.page.publishedSections);
    setVersion(r.page.version);
    setVersions(r.versions);
    setDirty(false);
    setTitleDirty(false);
  }, []);

  const open = useCallback(async (slug: string) => {
    setSelected(slug);
    setNotice(null);
    setError(null);
    try {
      await reload(slug);
      refreshList();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load page');
    }
  }, [reload, refreshList]);

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= sections.length) return;
    const next = [...sections];
    [next[i], next[j]] = [next[j], next[i]];
    setSections(next);
    setDirty(true);
    setNotice(null);
  };

  const guard = async (fn: () => Promise<unknown>, msg: string, keepReload = true) => {
    if (!selected) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      await fn();
      setNotice(msg);
      if (keepReload) await reload(selected);
      refreshList();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  const saveSections = () => guard(() => api.updatePageSections(selected!, sections), 'Layout saved.');
  const saveTitle = () => guard(() => api.renameContentPage(selected!, title).then(() => setTitleDirty(false)), 'Title saved.');
  const publish = () => {
    const run = async () => {
      if (dirty) await api.updatePageSections(selected!, sections);
      // Only push the title when it has local edits; renaming unconditionally
      // could clobber a change made in another session between loads.
      if (titleDirty) await api.renameContentPage(selected!, title);
      await api.publishContentPage(selected!);
    };
    void guard(run, 'Page published.');
  };
  const rollback = (v: number) => {
    if (!window.confirm(`Roll the page layout back to version ${v}?`)) return;
    void guard(() => api.rollbackContentPage(selected!, v), `Rolled back to v${v}.`);
  };
  const remove = () => {
    if (!selected) return;
    if (!window.confirm(`Delete page "${selected}"? The blocks it references are kept.`)) return;
    void guard(async () => {
      await api.deleteContentPage(selected);
      setSelected(null);
    }, 'Page deleted.', false);
  };

  const blockTitle = (key: string) => blocks.find((b) => b.key === key)?.title ?? key;
  const blockKind = (key: string) => blocks.find((b) => b.key === key)?.kind ?? 'fields';

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 20, alignItems: 'start' }}>
      <CrmCard
        title="Pages"
        footer={<CrmSmallButton onClick={() => setShowCreate((v) => !v)} disabled={showCreate}>+ New page</CrmSmallButton>}
      >
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {pages.map((p) => (
            <li key={p.slug}>
              <button
                type="button"
                onClick={() => void open(p.slug)}
                style={{
                  width: '100%', textAlign: 'left', padding: '10px 12px', marginBottom: 4, cursor: 'pointer',
                  border: selected === p.slug ? '1px solid #c8102e' : '1px solid #ece5e1',
                  borderRadius: 6, background: selected === p.slug ? '#fef2f4' : '#fff',
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 14 }}>{p.title}</div>
                <div style={{ fontSize: 12, color: '#8a817b' }}>
                  /{p.slug} · {p.site} · {p.sectionCount} sections · v{p.version}
                </div>
                {p.hasUnpublishedChanges && (
                  <span style={{ fontSize: 11, color: '#d97706' }}>unpublished changes</span>
                )}
              </button>
            </li>
          ))}
          {pages.length === 0 && <li style={{ color: '#8a817b', fontSize: 13 }}>No pages yet.</li>}
        </ul>
      </CrmCard>

      <div>
        {showCreate && (
          <NewPageForm
            onDone={(slug) => { setShowCreate(false); refreshList(); void open(slug); }}
            onCancel={() => setShowCreate(false)}
          />
        )}
        {!selected ? (
          !showCreate && (
            <CrmCard>
              <p style={{ color: '#8a817b', margin: 0 }}>Select a page to manage its sections, or create a new one.</p>
            </CrmCard>
          )
        ) : (
          <>
            <CrmCard
              title={`Page · /${selected} · v${version}`}
              footer={
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <CrmButton onClick={saveSections} disabled={busy || !dirty}>Save layout</CrmButton>
                  <CrmButton onClick={publish} disabled={busy}>Publish page</CrmButton>
                  <CrmSmallButton onClick={remove} disabled={busy}>Delete page</CrmSmallButton>
                  {notice && <span style={{ fontSize: 13, color: '#166534' }}>{notice}</span>}
                  {error && <span style={{ fontSize: 13, color: '#c8102e' }}>{error}</span>}
                </div>
              }
            >
              <div style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'center' }}>
                <input
                  style={{ ...inputStyle, flex: 1 }} value={title} maxLength={160}
                  onChange={(e) => { setTitle(e.target.value); setTitleDirty(true); setDirty(true); }}
                />
                <CrmSmallButton onClick={saveTitle} disabled={busy}>Save title</CrmSmallButton>
              </div>

              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: '#8a817b', fontSize: 12, textTransform: 'uppercase' }}>
                    <th style={{ padding: '6px 8px' }}>#</th>
                    <th style={{ padding: '6px 8px' }}>Section (block)</th>
                    <th style={{ padding: '6px 8px' }}>Live</th>
                    <th style={{ padding: '6px 8px' }} />
                  </tr>
                </thead>
                <tbody>
                  {sections.map((s, i) => {
                    const live = (publishedSections ?? []).some((p) => p.blockKey === s.blockKey);
                    return (
                      <tr key={`${s.blockKey}-${i}`} style={{ borderTop: '1px solid #f2ece8' }}>
                        <td style={{ padding: '6px 8px', color: '#8a817b' }}>{i + 1}</td>
                        <td style={{ padding: '6px 8px' }}>
                          <strong>{blockTitle(s.blockKey)}</strong>
                          <span style={{ marginLeft: 8, fontSize: 12, color: '#8a817b' }}>{s.blockKey} · {blockKind(s.blockKey)}</span>
                        </td>
                        <td style={{ padding: '6px 8px' }}>{live ? <CrmBadge value="published" /> : <CrmBadge value="draft" />}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <CrmSmallButton onClick={() => move(i, -1)} disabled={i === 0}>↑</CrmSmallButton>{' '}
                          <CrmSmallButton onClick={() => move(i, 1)} disabled={i === sections.length - 1}>↓</CrmSmallButton>{' '}
                          <CrmSmallButton
                            onClick={() => { setSections(sections.filter((_, j) => j !== i)); setDirty(true); }}
                          >
                            Remove
                          </CrmSmallButton>
                        </td>
                      </tr>
                    );
                  })}
                  {sections.length === 0 && (
                    <tr><td colSpan={4} style={{ padding: 12, color: '#8a817b' }}>No sections — add blocks below.</td></tr>
                  )}
                </tbody>
              </table>

              <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
                <select style={{ ...inputStyle, flex: 1 }} value={addKey} onChange={(e) => setAddKey(e.target.value)}>
                  <option value="">Choose a block to add…</option>
                  {blocks.map((b) => (
                    <option key={b.key} value={b.key}>{b.title} ({b.key} · {b.kind})</option>
                  ))}
                </select>
                <CrmSmallButton
                  disabled={!addKey || sections.some((s) => s.blockKey === addKey)}
                  onClick={() => {
                    setSections([...sections, { blockKey: addKey }]);
                    setAddKey('');
                    setDirty(true);
                  }}
                >
                  + Add section
                </CrmSmallButton>
              </div>
              <p className="hint-text" style={{ marginTop: 8 }}>
                Section content itself is edited in the Blocks tab. Publishing the page controls the
                order and presence of sections; each block publishes its own content.
              </p>
            </CrmCard>

            <CrmCard title="Version history">
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: '#8a817b', fontSize: 12, textTransform: 'uppercase' }}>
                    <th style={{ padding: '6px 8px' }}>Version</th>
                    <th style={{ padding: '6px 8px' }}>Published</th>
                    <th style={{ padding: '6px 8px' }} />
                  </tr>
                </thead>
                <tbody>
                  {versions.map((v) => (
                    <tr key={v.version} style={{ borderTop: '1px solid #f2ece8' }}>
                      <td style={{ padding: '6px 8px' }}>
                        <strong>v{v.version}</strong>
                        {v.version === version && <span style={{ marginLeft: 8 }}><CrmBadge value="live" /></span>}
                      </td>
                      <td style={{ padding: '6px 8px', color: '#8a817b' }}>{fmtDateTime(v.createdAt)}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                        {v.version !== version && (
                          <CrmSmallButton onClick={() => rollback(v.version)} disabled={busy}>Roll back</CrmSmallButton>
                        )}
                      </td>
                    </tr>
                  ))}
                  {versions.length === 0 && (
                    <tr><td colSpan={3} style={{ padding: 12, color: '#8a817b' }}>No versions recorded.</td></tr>
                  )}
                </tbody>
              </table>
            </CrmCard>
          </>
        )}
      </div>
    </div>
  );
}

function NewPageForm(props: { onDone: (slug: string) => void; onCancel: () => void }) {
  const [slug, setSlug] = useState('');
  const [site, setSite] = useState<'marketing' | 'app'>('marketing');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setError(null);
    if (!SLUG_RE.test(slug)) { setError(`Slug is invalid. ${slugHint}`); return; }
    if (!title.trim()) { setError('Title is required.'); return; }
    setBusy(true);
    try {
      await api.createContentPage({ slug, site, title: title.trim() });
      props.onDone(slug);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
      setBusy(false);
    }
  };

  return (
    <CrmCard title="New page">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
        <input style={inputStyle} placeholder="slug (e.g. join)" value={slug} onChange={(e) => setSlug(e.target.value)} />
        <input style={inputStyle} placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <select style={inputStyle} value={site} onChange={(e) => setSite(e.target.value as typeof site)}>
          <option value="marketing">marketing</option>
          <option value="app">app</option>
        </select>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <CrmButton onClick={() => void create()} disabled={busy}>{busy ? 'Creating…' : 'Create page'}</CrmButton>
        <CrmSmallButton onClick={props.onCancel} disabled={busy}>Cancel</CrmSmallButton>
        {error && <span style={{ fontSize: 13, color: '#c8102e' }}>{error}</span>}
      </div>
    </CrmCard>
  );
}

// ── Page shell ──────────────────────────────────────────────────────────────

export default function WebsiteContent() {
  const { permissions } = useAuth();
  const allowed = can(permissions, Perm.CONTENT_MANAGE);
  const [tab, setTab] = useState<'pages' | 'blocks'>('pages');

  if (!allowed) {
    return (
      <div>
        <CrmPageHeader title="Website Content" subtitle="Structured content blocks." />
        <CrmCard>
          <p style={{ color: '#8a817b', margin: 0 }}>You do not have access to website content.</p>
        </CrmCard>
      </div>
    );
  }

  return (
    <div>
      <CrmPageHeader
        title="Website Content"
        subtitle="Manage pages and their content blocks — publish, roll back, and drive the public site and app."
      />
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {(['pages', 'blocks'] as const).map((t) => (
          <span
            key={t}
            style={t === tab ? { outline: '2px solid #c8102e', borderRadius: 6 } : undefined}
          >
            <CrmSmallButton onClick={() => setTab(t)}>
              {t === 'pages' ? 'Pages' : 'Blocks'}
            </CrmSmallButton>
          </span>
        ))}
      </div>
      {tab === 'pages' ? <PagesTab /> : <BlocksTab />}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '9px 12px',
  border: '1px solid #ece5e1',
  borderRadius: 6,
  fontSize: 14,
  boxSizing: 'border-box',
  fontFamily: 'inherit',
};
