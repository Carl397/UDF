'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';

/**
 * One row in the type-ahead list. `value` is what lands in the form state;
 * `label` is what the applicant sees; `hint` is the small grey sub-line used
 * for the parent (e.g. a ward's subcouncil).
 */
export interface AutocompleteOption {
  value: string;
  label: string;
  hint?: string;
}

/**
 * Natural A-Z sort that also handles the numeric ward names Cape Town uses
 * ("2" before "10", not the lexicographic "10" before "2"). Falls back to a
 * locale compare for anything non-numeric, so a mixed list still reads
 * alphabetically to a human.
 */
function naturalCompare(a: string, b: string): number {
  const an = Number(a);
  const bn = Number(b);
  if (!Number.isNaN(an) && !Number.isNaN(bn)) return an - bn;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * A type-ahead combobox for the register form.
 *
 * Deliberately small and self-contained (no external deps, no portal): it must
 * render identically on the public `/register` page and inside the in-app
 * "More → Member registration form" screen, and it must work on a phone
 * keyboard where the arrow keys are absent — so the filtered list stays
 * tappable and the input never traps focus.
 *
 * The list is ALWAYS shown on focus (with the full A-Z set when the query is
 * empty), so an applicant who does not know the spelling of their ward can
 * still scroll and pick. Filtering narrows it as they type.
 */
export default function Autocomplete({
  id,
  value,
  onChange,
  options,
  placeholder,
  maxLength = 64,
  emptyMessage = 'No matches',
  ariaLabel,
  strict = false,
}: {
  id?: string;
  /** The current committed value (an option's `value`, or free text). */
  value: string;
  /**
   * Fires when the applicant picks an option OR edits the free text. The
   * second argument is the matched option when the picker was used, so a
   * parent form can cascade (e.g. auto-fill district from a chosen ward) —
   * `null` means "typed by hand, no cascade".
   */
  onChange: (value: string, option: AutocompleteOption | null) => void;
  options: AutocompleteOption[];
  placeholder?: string;
  maxLength?: number;
  emptyMessage?: string;
  ariaLabel?: string;
  /**
   * When true the field only accepts a pick from the list — typing filters
   * but never commits free text. On blur the display reverts to the last
   * committed label. Use for fields where arbitrary input makes no sense
   * (e.g. the suburb/address dropdown).
   */
  strict?: boolean;
}) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const listId = `${inputId}-listbox`;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  // A label the input can show when a known option is committed: the applicant
  // picks "Ward 12 · Subcouncil 2", the form stores `CPT-W012`, and the input
  // keeps showing the human label until they edit it.
  const selected = useMemo(
    () => options.find((o) => o.value === value) ?? null,
    [options, value],
  );

  // What the input box shows. While the picker is open we show the query so
  // typing filters naturally; otherwise we show the picked label (if any) or
  // the raw value.
  const display = open ? query : (selected?.label ?? value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = q
      ? options.filter(
          (o) =>
            o.label.toLowerCase().includes(q) ||
            o.value.toLowerCase().includes(q) ||
            (o.hint ?? '').toLowerCase().includes(q),
        )
      : options.slice();
    rows.sort((a, b) => naturalCompare(a.label, b.label));
    return rows;
  }, [options, query]);

  // Click-away closes the picker. `pointerdown` (not `click`) so the outside
  // tap on a phone does not race the input's own blur handler.
  useEffect(() => {
    if (!open) return;
    function onDocDown(e: PointerEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', onDocDown);
    return () => document.removeEventListener('pointerdown', onDocDown);
  }, [open]);

  // Keep the highlighted row visible when arrowing through a long list.
  useEffect(() => {
    if (!open || active < 0 || !listRef.current) return;
    const el = listRef.current.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  function commit(option: AutocompleteOption) {
    onChange(option.value, option);
    setQuery('');
    setActive(-1);
    setOpen(false);
  }

  function onInputFocus() {
    setQuery('');
    setActive(-1);
    setOpen(true);
  }

  function onInputChange(next: string) {
    setQuery(next);
    setActive(-1);
    setOpen(true);
    // In strict mode typing only filters the list — it never commits free text.
    // The form state stays at the last picked option until a new pick happens.
    if (!strict) {
      onChange(next, null);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      setOpen(true);
      e.preventDefault();
      return;
    }
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (filtered.length ? (i + 1) % filtered.length : -1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) =>
        filtered.length ? (i <= 0 ? filtered.length - 1 : i - 1) : -1,
      );
    } else if (e.key === 'Enter') {
      if (active >= 0 && filtered[active]) {
        e.preventDefault();
        commit(filtered[active]!);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      setActive(-1);
    }
  }

  return (
    <div className="combo" ref={wrapRef} style={{ position: 'relative' }}>
      <input
        id={inputId}
        className="input"
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={ariaLabel}
        autoComplete="off"
        value={display}
        maxLength={maxLength}
        placeholder={placeholder}
        onFocus={onInputFocus}
        onChange={(e) => onInputChange(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // Delay so a tap on the list registers before we close.
          setTimeout(() => {
            setOpen(false);
            // In strict mode, blur without a pick reverts the query so the
            // display shows the last committed label (or empty).
            if (strict) setQuery('');
          }, 120);
        }}
      />
      <span
        className="combo-caret"
        aria-hidden="true"
        style={{
          position: 'absolute',
          right: 12,
          top: '50%',
          transform: 'translateY(-50%)',
          pointerEvents: 'none',
          color: '#8a817b',
          fontSize: 12,
        }}
      >
        ▾
      </span>
      {open && (
        <ul
          id={listId}
          ref={listRef}
          role="listbox"
          className="combo-list"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 'calc(100% + 4px)',
            zIndex: 100,
            margin: 0,
            padding: 4,
            listStyle: 'none',
            maxHeight: 240,
            overflowY: 'auto',
            background: '#fff',
            border: '1px solid #ece5e1',
            borderRadius: 10,
            boxShadow: '0 8px 24px rgba(28,25,23,0.10)',
          }}
        >
          {filtered.length === 0 && (
            <li
              style={{
                padding: '10px 12px',
                color: '#8a817b',
                fontSize: 13,
              }}
            >
              {emptyMessage}
            </li>
          )}
          {filtered.map((o, i) => (
            <li
              key={o.value}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              // `onMouseDown` + preventDefault keeps focus on the input so the
              // blur-then-click race does not swallow the pick.
              onMouseDown={(e) => {
                e.preventDefault();
                commit(o);
              }}
              style={{
                padding: '8px 10px',
                borderRadius: 8,
                cursor: 'pointer',
                background: i === active ? '#faf5f1' : 'transparent',
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              }}
            >
              <span style={{ fontSize: 14, color: '#1c1917', fontWeight: 600 }}>
                {o.label}
              </span>
              {o.hint && (
                <span style={{ fontSize: 12, color: '#8a817b' }}>{o.hint}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
