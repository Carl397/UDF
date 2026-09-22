'use client';

import { useEffect, useMemo, useState } from 'react';
import { api, dataReadError } from '../../lib/api';
import { Icon, useToast } from '../ui';
import type { ScorecardCurrent, ScorecardItemInput } from '../../types';

/**
 * Rate your councillor (PRD-growth FR-S2/S3/S4) — the member's monthly
 * performance scorecard for THEIR OWN ward councillor, reachable from the front
 * of the Home tab so it is available "at all times" (FR-S4).
 *
 * The member scores each fixed category 1–5. A score of 1 or 2 is a complaint,
 * so it must carry a reason of at least {@link MIN_REASON_WORDS} words explaining
 * what is wrong and how to improve (FR-S3); 3–5 need no reason. Submit is held
 * disabled until every category is scored and every ≤2 reason clears the word
 * floor — the same rule the service enforces, mirrored here so the member is not
 * bounced by a 400 after writing a whole card.
 *
 * PRIVACY (FR-S7, mirrors AC-O2): the member opts in with `shareName` to reveal
 * their membership reference to the councillor; otherwise the submission is
 * anonymous and only the reasons travel. Nothing here fetches or shows anyone's
 * sealed name, email or phone number.
 *
 * Once the ward acknowledges the card it is FROZEN (FR-S2): the editor is
 * replaced by a read-only summary plus the acknowledgement note.
 */

/** FR-S3: the compulsory reason length for a score of 1 or 2. */
const MIN_REASON_WORDS = 100;

/** Word count on the trimmed reason — the exact measure the service uses. */
function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).filter(Boolean).length : 0;
}

/** `YYYY-MM-01` → "September 2026" (the month the card covers). */
function periodLabel(period: string): string {
  const d = new Date(period);
  return Number.isNaN(d.getTime())
    ? period
    : d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

const STATUS_LABEL: Record<string, string> = {
  not_rated: 'Not yet rated this month',
  submitted: 'Submitted — awaiting review',
  viewed: 'Viewed by your ward — awaiting acknowledgement',
  acknowledged: 'Acknowledged',
};

export default function RateCouncillor() {
  const toast = useToast();
  const [current, setCurrent] = useState<ScorecardCurrent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null);

  // Category code → chosen score (1–5) and reason text, seeded from any card the
  // member already saved this month (submitted but not yet acknowledged).
  const [scores, setScores] = useState<Record<string, number>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [shareName, setShareName] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getCurrentScorecard()
      .then((c) => {
        if (cancelled) return;
        setCurrent(c);
        setLastFetchedAt(new Date().toISOString());
        setError(null);
        const nextScores: Record<string, number> = {};
        const nextReasons: Record<string, string> = {};
        for (const it of c.items) {
          nextScores[it.category] = it.score;
          nextReasons[it.category] = it.reason ?? '';
        }
        setScores(nextScores);
        setReasons(nextReasons);
        setShareName(c.shareName);
      })
      .catch((e: unknown) => !cancelled && setError(dataReadError(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const categories = current?.categories ?? [];

  // Which categories still need a score, and which ≤2 reasons are still short of
  // the 100-word floor. Both must be empty before submit unlocks (FR-S1/S3).
  const { missing, short } = useMemo(() => {
    const missing: string[] = [];
    const short: { code: string; label: string; words: number }[] = [];
    for (const cat of categories) {
      const score = scores[cat.code];
      if (!score) {
        missing.push(cat.label);
        continue;
      }
      if (score <= 2) {
        const words = wordCount(reasons[cat.code] ?? '');
        if (words < MIN_REASON_WORDS) short.push({ code: cat.code, label: cat.label, words });
      }
    }
    return { missing, short };
  }, [categories, scores, reasons]);

  const canSubmit = !!(current?.eligible && !current.frozen && !submitting && missing.length === 0 && short.length === 0);

  function setScore(code: string, score: number) {
    setScores((prev) => ({ ...prev, [code]: score }));
    // A score above 2 needs no reason; clear any stale text so it is not sent.
    if (score > 2) setReasons((prev) => ({ ...prev, [code]: '' }));
  }

  async function submit() {
    if (!current || !canSubmit) return;
    const items: ScorecardItemInput[] = categories.map((cat) => ({
      category: cat.code,
      score: scores[cat.code]!,
      reason: scores[cat.code]! <= 2 ? (reasons[cat.code] ?? '').trim() : null,
    }));
    setSubmitting(true);
    setError(null);
    let savedSuccessfully = false;
    try {
      const saved = await api.submitScorecard({ items, shareName });
      savedSuccessfully = true;
      // Re-read the current card so the status badge + frozen state are truthful.
      const fresh = await api.getCurrentScorecard();
      setCurrent(fresh);
      setLastFetchedAt(new Date().toISOString());
      setError(null);
      toast(frozenOrSent(fresh.status, saved.status), 'ok');
    } catch (e) {
      toast(dataReadError(e), 'err');
      if (savedSuccessfully) setError('Your scorecard was saved, but its current status could not be loaded. Retry loading the saved scorecard.');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="card">
        <div className="skeleton" style={{ height: 160 }} />
      </div>
    );
  }

  if (error || !current) {
    return (
      <div className="card">
        <div className="mini-label">Rate your councillor</div>
        <p className="hint-text" role="alert">{error ?? 'Your scorecard is not available yet.'}</p>
        {lastFetchedAt && <p className="tiny">Last successful fetch: <time dateTime={lastFetchedAt}>{new Date(lastFetchedAt).toLocaleString()}</time>. Not current.</p>}
        <button className="btn btn-primary" disabled={submitting} onClick={() => setAttempt((n) => n + 1)}>Retry loading saved scorecard</button>
      </div>
    );
  }

  if (!current.eligible) {
    return (
      <div className="card">
        <div className="mini-label">Rate your councillor</div>
        <p className="hint-text" style={{ margin: 0 }}>
          {current.message ?? 'There is no councillor to rate right now.'}
        </p>
        {lastFetchedAt && <p className="tiny">Last successful fetch: <time dateTime={lastFetchedAt}>{new Date(lastFetchedAt).toLocaleString()}</time></p>}
        <button className="btn btn-primary" onClick={() => setAttempt((n) => n + 1)}>Check again</button>
      </div>
    );
  }

  const councillorName = current.councillor?.fullName ?? 'your ward councillor';

  return (
    <>
      <div className="card hero-card">
        <span className="eyebrow">Rate your councillor · {periodLabel(current.period)}</span>
        <h2>{councillorName}</h2>
        <p>
          {current.ward ? `Ward ${current.ward} · ` : ''}
          {STATUS_LABEL[current.status] ?? current.status}
        </p>
        {lastFetchedAt && <p className="tiny">Last successful fetch: <time dateTime={lastFetchedAt}>{new Date(lastFetchedAt).toLocaleString()}</time></p>}
      </div>

      {current.frozen ? (
        /* FR-S2: acknowledged this month — read-only summary + the note back. */
        <div className="card">
          <div className="mini-label">This month is closed</div>
          {current.ackNote && (
            <p className="hint-text" style={{ marginTop: 0 }}>
              <strong>Ward acknowledgement:</strong> {current.ackNote}
            </p>
          )}
          <ReadOnlyItems current={current} />
          <p className="hint-text" style={{ marginBottom: 0 }}>
            Your next scorecard opens at the start of next month.
          </p>
        </div>
      ) : (
        <div className="card">
          <div className="mini-label">
            Score each category · 1–2 needs {MIN_REASON_WORDS}+ words on what is wrong and how to improve
          </div>

          {categories.map((cat) => {
            const score = scores[cat.code] ?? 0;
            const needsReason = score > 0 && score <= 2;
            const words = wordCount(reasons[cat.code] ?? '');
            const shortReason = needsReason && words < MIN_REASON_WORDS;
            return (
              <div key={cat.code} style={{ padding: '12px 0', borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{cat.label}</span>
                  <StarRow score={score} onPick={(s) => setScore(cat.code, s)} disabled={false} />
                </div>

                {needsReason && (
                  <div style={{ marginTop: 8 }}>
                    <textarea
                      value={reasons[cat.code] ?? ''}
                      onChange={(e) => setReasons((prev) => ({ ...prev, [cat.code]: e.target.value }))}
                      placeholder={`Explain what is wrong with ${cat.label.toLowerCase()} and how to improve it (at least ${MIN_REASON_WORDS} words).`}
                      rows={4}
                      aria-label={`Reason for your ${cat.label} score`}
                      style={{
                        width: '100%',
                        boxSizing: 'border-box',
                        padding: '10px 12px',
                        border: `1px solid ${shortReason ? '#C8102E' : '#d8cfca'}`,
                        borderRadius: 8,
                        fontSize: 14,
                        fontFamily: 'inherit',
                        resize: 'vertical',
                      }}
                    />
                    <div
                      className="tiny"
                      style={{ marginTop: 4, color: shortReason ? '#C8102E' : '#16a34a', fontWeight: 600 }}
                    >
                      {words}/{MIN_REASON_WORDS} words {shortReason ? '— keep going' : '✓'}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* FR-S7: opt in to reveal the membership reference to the councillor. */}
          <label
            style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 14, fontSize: 13, cursor: 'pointer' }}
          >
            <input
              type="checkbox"
              checked={shareName}
              onChange={(e) => setShareName(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span>
              Share my membership reference with my councillor so they can follow up with me.
              <span className="hint-text" style={{ display: 'block', marginTop: 2 }}>
                Left unchecked, your rating and reasons are anonymous — only the feedback travels.
              </span>
            </span>
          </label>

          {missing.length > 0 && (
            <p className="hint-text" style={{ marginTop: 12, marginBottom: 0 }}>
              Rate every category to submit{missing.length ? ` (still to score: ${missing.join(', ')})` : ''}.
            </p>
          )}

          <button className="btn btn-primary btn-block" style={{ marginTop: 14 }} disabled={!canSubmit} onClick={submit}>
            <Icon name="star" size={16} /> {submitting ? 'Submitting…' : 'Submit my scorecard'}
          </button>
        </div>
      )}
    </>
  );
}

/** A 1–5 star picker. Filled stars are gold; the row carries an aria-label. */
function StarRow({ score, onPick, disabled }: { score: number; onPick: (s: number) => void; disabled: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 2 }} role="radiogroup" aria-label={`Score ${score} out of 5`}>
      {[1, 2, 3, 4, 5].map((s) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={score === s}
          aria-label={`${s} of 5`}
          disabled={disabled}
          onClick={() => onPick(s)}
          style={{
            background: 'none',
            border: 'none',
            padding: 2,
            cursor: disabled ? 'default' : 'pointer',
            color: s <= score ? '#f0a500' : '#cdc4be',
            lineHeight: 0,
          }}
        >
          <Icon name="star" size={22} />
        </button>
      ))}
    </div>
  );
}

/** The frozen, read-only view of an acknowledged card's scores + reasons. */
function ReadOnlyItems({ current }: { current: ScorecardCurrent }) {
  if (current.items.length === 0) return null;
  const labelFor = (code: string) => current.categories.find((c) => c.code === code)?.label ?? code;
  return (
    <div style={{ margin: '8px 0 12px' }}>
      {current.items.map((it) => (
        <div key={it.category} style={{ padding: '8px 0', borderBottom: '1px solid rgba(0,0,0,0.05)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{labelFor(it.category)}</span>
            <StarRow score={it.score} onPick={() => {}} disabled />
          </div>
          {it.reason && (
            <p className="hint-text" style={{ margin: '6px 0 0' }}>
              {it.reason}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

/** Toast copy: an acknowledged card reads as closed, anything else as sent. */
function frozenOrSent(freshStatus: string, savedStatus: string): string {
  return freshStatus === 'acknowledged' || savedStatus === 'acknowledged'
    ? 'Scorecard recorded and acknowledged'
    : 'Scorecard submitted — your ward will review it';
}
