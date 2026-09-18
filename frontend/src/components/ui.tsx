'use client';

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from 'react';
import type { Member } from '../types';

/* ── Icons (stroke-based, 24×24, currentColor) ───────────────── */
const PATHS: Record<string, ReactNode> = {
  home: <path d="M3 10.5 12 3l9 7.5M5 9.5V21h5v-6h4v6h5V9.5" />,
  map: (
    <>
      <path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z" />
      <path d="M9 4v14M15 6v14" />
    </>
  ),
  flame: (
    <path d="M12 3s5 4.5 5 9a5 5 0 0 1-10 0c0-1.8.8-3.4 1.8-4.8.4 1 1.2 1.8 1.2 1.8S10 6 12 3Z" />
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20c.6-3.4 2.8-5 5.5-5s4.9 1.6 5.5 5" />
      <path d="M16 5.5a3.2 3.2 0 0 1 0 6M17.5 15.4c2 .6 3.2 2.1 3.6 4.6" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.8v2.4M12 18.8v2.4M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M2.8 12h2.4M18.8 12h2.4M4.9 19.1l1.7-1.7M17.4 6.6l1.7-1.7" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.4-4.4" />
    </>
  ),
  x: <path d="M6 6l12 12M18 6 6 18" />,
  chev: <path d="m9 5 7 7-7 7" />,
  shield: (
    <>
      <path d="M12 3 5 6v6c0 4.4 3 7.6 7 9 4-1.4 7-4.6 7-9V6l-7-3Z" />
      <path d="m9.2 12 2 2 3.6-3.8" />
    </>
  ),
  logout: (
    <>
      <path d="M14 4h-8v16h8" />
      <path d="M10 12h11M18 8.5 21.5 12 18 15.5" />
    </>
  ),
  bell: (
    <>
      <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6" />
      <path d="M10 19a2.2 2.2 0 0 0 4 0" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M4 4l16 16" />
      <path d="M9.9 5.2A9.8 9.8 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-3 3.9M6.2 6.9A16.6 16.6 0 0 0 2.5 12S6 19 12 19a9.6 9.6 0 0 0 4-.9" />
    </>
  ),
  edit: (
    <>
      <path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z" />
      <path d="m13.5 6.5 3 3" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.3-5.6" />
      <path d="M20 3v5h-5" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11Z" />
      <circle cx="12" cy="10" r="2.6" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v11M8 10.5 12 14.5l4-4" />
      <path d="M4 17v4h16v-4" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    </>
  ),
  chart: (
    <>
      <path d="M4 20V4" />
      <path d="M4 20h16" />
      <path d="M8 16v-5M12 16V8M16 16v-3" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 9.8h17M8 3.2v3.4M16 3.2v3.4" />
    </>
  ),
  dots: (
    <>
      <circle cx="5.5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="18.5" cy="12" r="1.5" />
    </>
  ),
  megaphone: (
    <>
      <path d="M4 10.5v3h2.6L13 18V6l-6.4 4.5H4Z" />
      <path d="M16.4 9.4a4 4 0 0 1 0 5.2" />
      <path d="M7.6 16.6v3.2" />
    </>
  ),
  doc: (
    <>
      <path d="M6 3.5h8L18.5 8v12.5H6z" />
      <path d="M14 3.5V8h4.5" />
      <path d="M9 12.5h6M9 16h4.5" />
    </>
  ),
  qr: (
    <>
      <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z" />
      <path d="M14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5z" />
    </>
  ),
  link: (
    <>
      <path d="m9.8 14.2 4.4-4.4" />
      <path d="M11.2 6.8 13 5a3.7 3.7 0 0 1 5.2 5.2l-1.8 1.8" />
      <path d="M12.8 17.2 11 19a3.7 3.7 0 0 1-5.2-5.2l1.8-1.8" />
    </>
  ),
  flag: (
    <>
      <path d="M6 21V3.8" />
      <path d="M6 5h11.5l-2.2 3.6 2.2 3.6H6" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4.4 21 19.6H3L12 4.4Z" />
      <path d="M12 10.2v4M12 17h.01" />
    </>
  ),
  star: (
    <path d="m12 4 2.4 5 5.6.8-4 3.9 1 5.5-5-2.7-5 2.7 1-5.5-4-3.9 5.6-.8L12 4Z" />
  ),
  send: (
    <>
      <path d="M21 3 10.5 13.5" />
      <path d="M21 3 14.4 21l-3.9-7.5L3 9.6 21 3Z" />
    </>
  ),
  idcard: (
    <>
      <rect x="2.8" y="5.4" width="18.4" height="13.2" rx="2.6" />
      <circle cx="8.6" cy="11" r="2" />
      <path d="M5.6 16.1c.6-1.6 1.7-2.4 3-2.4s2.4.8 3 2.4" />
      <path d="M14 10.2h4.2M14 13.8h4.2" />
    </>
  ),
  checkCircle: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="m8.2 12.3 2.6 2.6 5-5.2" />
    </>
  ),
  clipboard: (
    <>
      <rect x="5" y="4.6" width="14" height="15.8" rx="2.4" />
      <path d="M9 4.6V3.4h6v1.2" />
      <path d="M8.6 11h6.8M8.6 14.6h4.6" />
    </>
  ),
  briefcase: (
    <>
      <rect x="3.4" y="7.4" width="17.2" height="12.2" rx="2" />
      <path d="M8.6 7.4V5.9a1.5 1.5 0 0 1 1.5-1.5h3.8a1.5 1.5 0 0 1 1.5 1.5v1.5" />
      <path d="M3.4 12.4h17.2M10.4 12.4v1.6h3.2v-1.6" />
    </>
  ),
  camera: (
    <>
      <path d="M3.5 8.6h3.1l1.5-2.4h7.8l1.5 2.4h3.1V19h-17z" />
      <circle cx="12" cy="13.4" r="3.5" />
    </>
  ),
  image: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.4" />
      <circle cx="8.8" cy="9.6" r="1.7" />
      <path d="m4.6 17.2 4.3-4.2 3 2.8 3.2-3.3 4.4 4.7" />
    </>
  ),
  heart: (
    <path d="M12 20.2s-7.4-4.5-7.4-9.7A4.1 4.1 0 0 1 12 7.6a4.1 4.1 0 0 1 7.4 2.9c0 5.2-7.4 9.7-7.4 9.7Z" />
  ),
  layers: (
    <>
      <path d="m12 3.6 8.4 4.4-8.4 4.4L3.6 8 12 3.6Z" />
      <path d="m4.4 12.4 7.6 4 7.6-4" />
      <path d="m4.4 16.6 7.6 4 7.6-4" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7.5h10M18 7.5h2M4 16.5h2M10 16.5h10" />
      <circle cx="16" cy="7.5" r="2.1" />
      <circle cx="8" cy="16.5" r="2.1" />
    </>
  ),
  filter: (
    <>
      <path d="M3.6 5h16.8l-6.6 7.8V20l-3.6-2v-5.2L3.6 5Z" />
    </>
  ),
};

export function Icon({ name, size = 20 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name] ?? PATHS.info}
    </svg>
  );
}

/* ── Segmented control ─────────────────────────────────────── */
/**
 * A row of mutually-exclusive choices.
 *
 * `icon` is optional and purely presentational — but it is what lets the map's
 * three-way mode control survive a narrow phone: below 380 px the CSS drops
 * `.seg-label` and the icons alone still say which mode is which. The button
 * therefore carries an explicit `aria-label`, so the accessible name is the
 * same string at every width instead of whatever the breakpoint left visible.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; icon?: string }[];
}) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          aria-label={o.label}
          title={o.label}
          className={value === o.value ? 'on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.icon && <Icon name={o.icon} size={15} />}
          <span className="seg-label">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/* ── Toggle switch ─────────────────────────────────────────── */
export function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`switch ${on ? 'on' : ''}`}
      onClick={() => onChange(!on)}
    />
  );
}

/* ── Bottom sheet ──────────────────────────────────────────── */
export function Sheet({
  title,
  onClose,
  children,
  footer,
  subtitle,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-handle" />
        <div className="sheet-head">
          <div>
            <h3>{title}</h3>
            {subtitle && <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{subtitle}</div>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </>
  );
}

/* ── Toast ─────────────────────────────────────────────────── */
type ToastState = { msg: string; kind: 'ok' | 'err' | '' } | null;
const ToastCtx = createContext<(msg: string, kind?: 'ok' | 'err' | '') => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState>(null);

  const show = useCallback((msg: string, kind: 'ok' | 'err' | '' = '') => {
    setToast({ msg, kind });
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast && <div className={`toast ${toast.kind}`}>{toast.msg}</div>}
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}

/* ── Small helpers ─────────────────────────────────────────── */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

/**
 * The best available human-readable label for a member row.
 *
 * Only national_admin and regional_organizer hold `member:pii_decrypt`, so for
 * the other four roles the sealed `pii` block arrives as `null` — and
 * `membershipNo` is unset for anyone who has not been issued a card yet. The
 * fallback those two left was a fragment of the row's UUID, so a ward
 * councillor's own directory read `8ad9e465`, `ad3eb022`, `64783c1a`: six
 * members, none of them identifiable, in the one screen whose whole purpose is
 * identifying them. `publicCode` (`UDF-WCV-77E`) is in every payload and is
 * documented as never secret, so it is the honest step before the UUID.
 */
export function memberLabel(m: Member): string {
  return m.pii?.fullName ?? m.membershipNo ?? m.publicCode ?? `Member ${m.id.slice(0, 6)}`;
}

/**
 * The same rule for the embedded `member` summary that appointments and
 * mandates carry. It has no `pii` block and no `id` of its own — but it does
 * have `publicCode`, which four call sites were stepping straight over on
 * their way to a fragment of the *appointment's* `memberId`.
 */
export function memberRefLabel(
  ref: { membershipNo: string | null; publicCode: string | null },
  fallbackId?: string,
): string {
  return (
    ref.membershipNo
    ?? ref.publicCode
    ?? (fallbackId ? `Member ${fallbackId.slice(0, 6)}` : 'Member')
  );
}

export function EmptyState({ icon = 'info', title, hint }: { icon?: string; title: string; hint?: string }) {
  return (
    <div className="empty">
      <span className="big">
        <Icon name={icon} size={34} />
      </span>
      <strong>{title}</strong>
      {hint && <span>{hint}</span>}
    </div>
  );
}
