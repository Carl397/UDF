/**
 * Party ID Card renderer — the single source of truth for the card's appearance.
 *
 * The same painter draws BOTH the on-screen preview and the downloadable PNG, so
 * what a national administrator designs is exactly what prints (no DOM/canvas
 * drift). Everything is driven by the `CardDesign` template (migration 022) plus
 * the pre-loaded image assets (logo, member photo, QR).
 *
 * The classic card is laid out on a 1080 × 680 reference grid; every measure is
 * in those units and scaled to the target pixel size. At the design DEFAULTS this
 * reproduces today's card, so shipping the studio changes nothing until an admin
 * edits the template.
 *
 * Scaling model:
 *  • x-coords / widths  scale with the card width  (`X`)
 *  • y-coords / heights scale with the card height (`Y`)
 *  • fonts, strokes, radii and small gaps scale uniformly by the smaller of the
 *    two (`S`), so text never overflows when the aspect ratio changes.
 */
import type { CardDesign, FieldKey, PartyCard, PhotoTransform } from '../types';

/** Pre-loaded card images. Each is null when absent/disabled/failed to load. */
export interface CardAssets {
  logo: HTMLImageElement | null;
  photo: HTMLImageElement | null;
  qr: HTMLImageElement | null;
}

const REF_W = 1080;
const REF_H = 680;
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MM_PER_IN = 25.4;

/** Browsers cap canvas side length and total area; clamp so an A3 × 1200 dpi ×
 *  1000% request cannot silently throw or allocate gigabytes. */
export const MAX_EXPORT_SIDE = 16000;
const MAX_EXPORT_AREA = 268_000_000; // ~268 MP (Chrome's canvas ceiling)

/**
 * The classic all-defaults design — a client-side fallback so a card response
 * from a backend that predates migration 022 still renders (and matches what the
 * server returns once current). Mirrors `cardstudio/schemas.ts` defaults exactly.
 */
export const DEFAULT_CARD_DESIGN: CardDesign = {
  size: { preset: 'id1', widthMm: 85.6, heightMm: 54, orientation: 'landscape', dpi: 300, scalePct: 100 },
  colors: {
    bgFrom: '#c8102e', bgTo: '#7c0a1b', flagPanel: '#141414', accent: '#f7c31d',
    text: '#ffffff', muted: '#ffffff9e', border: '#00000000',
  },
  border: { widthPx: 0, radiusPx: 18, style: 'none' },
  text: { orgName: 'UDF', partyWord: 'PARTY', tagline: 'ONE FLAG · ONE MOVEMENT', slogan: 'SERVICE BEFORE SELF', footer: '' },
  logo: { show: false, mediaId: null, widthPct: 18, position: 'flagTop' },
  photo: { show: false, shape: 'rounded', widthPct: 22, position: 'right' },
  qr: { show: true, position: 'bottomRight', sizePct: 23 },
  fields: [
    { key: 'membershipNo', label: 'Membership', show: true },
    { key: 'office', label: 'Office', show: true },
    { key: 'ward', label: 'Ward', show: true },
    { key: 'region', label: 'Region', show: true },
    { key: 'status', label: 'Status', show: true },
  ],
  print: { paper: 'a4', perSheet: 8, gutterMm: 4, cutMarks: true },
};

export function mmToPx(mm: number, dpi: number): number {
  return (mm / MM_PER_IN) * dpi;
}

/** The card's aspect ratio (width ÷ height) from its physical size. */
export function cardAspect(design: CardDesign): number {
  const h = design.size.heightMm || 1;
  return design.size.widthMm / h;
}

/**
 * The export pixel size at the design's dpi × scalePct, clamped to what a canvas
 * can allocate. `clamped` lets the UI tell the user the 1000% export was reduced.
 */
export function cardPixelSize(design: CardDesign): { w: number; h: number; clamped: boolean } {
  const scale = design.size.scalePct / 100;
  let w = Math.round(mmToPx(design.size.widthMm, design.size.dpi) * scale);
  let h = Math.round(mmToPx(design.size.heightMm, design.size.dpi) * scale);
  let clamped = false;
  const longest = Math.max(w, h);
  if (longest > MAX_EXPORT_SIDE) {
    const k = MAX_EXPORT_SIDE / longest;
    w = Math.round(w * k);
    h = Math.round(h * k);
    clamped = true;
  }
  if (w * h > MAX_EXPORT_AREA) {
    const k = Math.sqrt(MAX_EXPORT_AREA / (w * h));
    w = Math.round(w * k);
    h = Math.round(h * k);
    clamped = true;
  }
  return { w: Math.max(1, w), h: Math.max(1, h), clamped };
}

/** A field's display value for this member (the card body rows). */
export function fieldValue(card: PartyCard, key: FieldKey): string {
  switch (key) {
    case 'membershipNo':
      return card.membershipNo ?? '—';
    case 'office':
      return card.roles[0]?.title ?? card.roles[0]?.name ?? `Member · ${card.tier}`;
    case 'ward':
      return card.ward ? `Ward ${card.ward}` : '—';
    case 'region':
      return card.regionCode ?? '—';
    case 'status':
      return card.status;
    case 'tier':
      return card.tier;
    case 'joinedYear':
      return card.joinedAt ? String(new Date(card.joinedAt).getFullYear()) : '—';
    case 'publicCode':
      return card.publicCode;
    default:
      return '—';
  }
}

/** The visible card body rows, in the admin-chosen order, with their labels. */
export function resolveFields(
  card: PartyCard,
  design: CardDesign,
): { label: string; value: string }[] {
  return design.fields
    .filter((f) => f.show)
    .map((f) => ({ label: f.label, value: fieldValue(card, f.key) }));
}

/** The footer verify line: the admin's `footer` text, or a derived default. */
export function footerLine(card: PartyCard, design: CardDesign): string {
  const custom = design.text.footer.trim();
  if (custom) return custom;
  return `Verify: ${card.publicCode} · ${card.party.contacts.website}`;
}

/** Load an image element from a src (data-url or object-url); null on failure. */
export function loadImage(src: string | null | undefined): Promise<HTMLImageElement | null> {
  if (!src) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// ── Canvas primitives ────────────────────────────────────────────────────────

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * Shrink a font size until `text` fits `maxWidth` (never grows past `basePx`).
 * Returns the fitted size; sets nothing. Callers assign `ctx.font` themselves.
 */
function fitFontPx(
  ctx: CanvasRenderingContext2D,
  text: string,
  weight: number | string,
  basePx: number,
  maxWidth: number,
  letterSpacing = 0,
): number {
  let px = basePx;
  const min = Math.max(6, basePx * 0.34);
  while (px > min) {
    ctx.font = `${weight} ${px}px ${FONT}`;
    const w = ctx.measureText(text).width + letterSpacing * Math.max(0, text.length - 1);
    if (w <= maxWidth) break;
    px -= Math.max(0.5, px * 0.04);
  }
  return px;
}

/** Draw `img` into the box (dx,dy,dw,dh) cropped by the member's transform, masked to `shape`. */
function drawPhoto(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  t: PhotoTransform,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  shape: 'rect' | 'rounded' | 'circle',
): void {
  ctx.save();
  const r = shape === 'circle' ? Math.min(dw, dh) / 2 : shape === 'rounded' ? Math.min(dw, dh) * 0.14 : 0;
  if (shape === 'circle') {
    ctx.beginPath();
    ctx.ellipse(dx + dw / 2, dy + dh / 2, dw / 2, dh / 2, 0, 0, Math.PI * 2);
    ctx.clip();
  } else {
    roundRectPath(ctx, dx, dy, dw, dh, r);
    ctx.clip();
  }
  const iw = img.naturalWidth || img.width || 1;
  const ih = img.naturalHeight || img.height || 1;
  let cw = (t.w || 1) * iw;
  let ch = (t.h || 1) * ih;
  let cx = (t.x || 0) * iw;
  let cy = (t.y || 0) * ih;
  const z = t.zoom && t.zoom > 1 ? t.zoom : 1;
  if (z > 1) {
    const ncw = cw / z;
    const nch = ch / z;
    cx += (cw - ncw) / 2;
    cy += (ch - nch) / 2;
    cw = ncw;
    ch = nch;
  }
  // "cover" the box: scale the crop to fill dw×dh, centring the overflow.
  const scale = Math.max(dw / cw, dh / ch);
  const sw = dw / scale;
  const sh = dh / scale;
  const sx = cx + (cw - sw) / 2;
  const sy = cy + (ch - sh) / 2;
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
  ctx.restore();
}

/** Draw a logo contained in (dx,dy,maxW,maxH), preserving aspect, centred. */
function drawLogo(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  dx: number,
  dy: number,
  maxW: number,
  maxH: number,
): { w: number; h: number } {
  const iw = img.naturalWidth || img.width || 1;
  const ih = img.naturalHeight || img.height || 1;
  const k = Math.min(maxW / iw, maxH / ih);
  const w = iw * k;
  const h = ih * k;
  ctx.drawImage(img, dx + (maxW - w) / 2, dy + (maxH - h) / 2, w, h);
  return { w, h };
}

// ── The painter ──────────────────────────────────────────────────────────────

/**
 * Paint the card onto `ctx` at exactly W × H pixels. Pure drawing — the caller
 * sizes the canvas and supplies pre-loaded assets. Used for preview and export.
 */
export function paintCard(
  ctx: CanvasRenderingContext2D,
  card: PartyCard,
  design: CardDesign,
  assets: CardAssets,
  W: number,
  H: number,
  opts: { shadow?: boolean } = {},
): void {
  const sx = W / REF_W;
  const sy = H / REF_H;
  const sf = Math.min(sx, sy);
  const X = (v: number) => v * sx;
  const Y = (v: number) => v * sy;
  const S = (v: number) => v * sf;

  const c = design.colors;
  const t = design.text;
  const radius = Math.max(0, S(design.border.radiusPx));
  const bw = design.border.style === 'none' ? 0 : Math.max(0, S(design.border.widthPx));
  const inset = bw / 2;

  ctx.save();
  ctx.clearRect(0, 0, W, H);
  ctx.textBaseline = 'alphabetic';

  // Drop shadow (preview only — a printed card must not carry one) + base shape.
  ctx.save();
  if (opts.shadow) {
    ctx.shadowColor = 'rgba(0,0,0,0.30)';
    ctx.shadowBlur = S(30);
    ctx.shadowOffsetY = S(12);
  }
  ctx.fillStyle = c.bgFrom;
  roundRectPath(ctx, inset, inset, W - bw, H - bw, radius);
  ctx.fill();
  ctx.restore();

  // Everything below is clipped to the rounded card.
  ctx.save();
  roundRectPath(ctx, inset, inset, W - bw, H - bw, radius);
  ctx.clip();

  // Background gradient.
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, c.bgFrom);
  grad.addColorStop(1, c.bgTo);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Flag panel (left band).
  const flagW = Math.round(W * 0.3056);
  ctx.fillStyle = c.flagPanel;
  ctx.fillRect(0, 0, flagW, H);

  const logo = design.logo;
  const photo = design.photo;
  const qr = design.qr;
  const padX = X(52);

  // ── Flag contents ────────────────────────────────────────────────────────
  let orgBaseline = Y(200);

  if (logo.show && assets.logo && logo.position === 'flagTop') {
    const lw = W * (logo.widthPct / 100);
    const box = drawLogo(ctx, assets.logo, (flagW - lw) / 2, Y(40), lw, Y(150));
    orgBaseline = Math.max(orgBaseline, Y(40) + box.h + Y(70));
  }
  if (photo.show && assets.photo && photo.position === 'flagTop') {
    const pw = flagW * 0.6;
    const ph = Math.min(pw * 1.25, H * 0.34);
    drawPhoto(ctx, assets.photo, card.photo?.transform ?? { x: 0, y: 0, w: 1, h: 1, zoom: 1 },
      (flagW - pw) / 2, Y(40), pw, ph, photo.shape);
    orgBaseline = Math.max(orgBaseline, Y(40) + ph + Y(60));
  }

  // Org name (the wordmark must never be squeezed below legibility — shrink to fit).
  const orgPx = fitFontPx(ctx, t.orgName, 900, S(96), flagW - padX - X(20), S(1));
  ctx.fillStyle = c.text;
  ctx.font = `900 ${orgPx}px ${FONT}`;
  ctx.fillText(t.orgName, padX * 0.98, orgBaseline);

  // Party word.
  const partyPx = fitFontPx(ctx, t.partyWord, 800, S(30), flagW - padX - X(20), S(2.4));
  ctx.fillStyle = c.text;
  ctx.font = `800 ${partyPx}px ${FONT}`;
  if ('letterSpacing' in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = `${S(2.4)}px`;
  ctx.fillText(t.partyWord, padX, orgBaseline + Y(50));
  if ('letterSpacing' in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = '0px';

  // Tagline pinned to the flag's foot.
  if (logo.show && assets.logo && logo.position === 'flagBottom') {
    const lw = W * (logo.widthPct / 100);
    drawLogo(ctx, assets.logo, (flagW - lw) / 2, H - Y(190), lw, Y(130));
  }
  const tagY = H - Y(60);
  const tagPx = fitFontPx(ctx, t.tagline, 700, S(24), flagW - padX * 1.6);
  ctx.fillStyle = c.muted;
  ctx.font = `700 ${tagPx}px ${FONT}`;
  ctx.fillText(t.tagline, padX * 0.9, tagY);

  // ── Body geometry (right of the flag) ────────────────────────────────────
  let bodyLeft = flagW + X(50);
  let bodyRight = W - X(50);

  // QR box (computed first so body text can avoid it).
  let qrBox: { x: number; y: number; s: number } | null = null;
  if (qr.show && assets.qr) {
    const qs = Math.min(W * (qr.sizePct / 100), H * 0.62);
    const m = X(60);
    let qx = W - qs - m;
    let qy = H - qs - Y(60);
    if (qr.position === 'bottomLeft') {
      qx = m;
      qy = H - qs - Y(60);
    } else if (qr.position === 'right') {
      qx = W - qs - m;
      qy = (H - qs) / 2;
    } else if (qr.position === 'bottomCenter') {
      qx = (W - qs) / 2;
      qy = H - qs - Y(50);
    }
    qrBox = { x: qx, y: qy, s: qs };
  }

  // Member photo (left/right of the body).
  if (photo.show && assets.photo && photo.position !== 'flagTop') {
    const pw = W * (photo.widthPct / 100);
    const ph = Math.min(pw * 1.25, H * 0.52);
    const py = (H - ph) / 2 - Y(20);
    const gap = X(28);
    if (photo.position === 'left') {
      drawPhoto(ctx, assets.photo, card.photo?.transform ?? { x: 0, y: 0, w: 1, h: 1, zoom: 1 },
        bodyLeft, py, pw, ph, photo.shape);
      bodyLeft += pw + gap;
    } else {
      const px = bodyRight - pw;
      drawPhoto(ctx, assets.photo, card.photo?.transform ?? { x: 0, y: 0, w: 1, h: 1, zoom: 1 },
        px, py, pw, ph, photo.shape);
      bodyRight -= pw + gap;
    }
  }

  // Keep body text clear of a right/centre QR.
  let textRight = bodyRight;
  if (qrBox && qrBox.x > bodyLeft) textRight = Math.min(bodyRight, qrBox.x - X(28));

  // ── Body contents ────────────────────────────────────────────────────────
  let cursorY = Y(150);
  if (logo.show && assets.logo && logo.position === 'bodyTop') {
    const lw = W * (logo.widthPct / 100);
    const box = drawLogo(ctx, assets.logo, bodyLeft, cursorY - Y(90), lw, Y(90));
    cursorY = Math.max(cursorY, cursorY - Y(90) + box.h + Y(40));
  }
  if (logo.show && assets.logo && (logo.position === 'topRight' || logo.position === 'bottomLeft')) {
    const lw = W * (logo.widthPct / 100);
    const lx = logo.position === 'topRight' ? W - lw - X(40) : X(40);
    const ly = logo.position === 'topRight' ? Y(40) : H - lw - Y(40);
    drawLogo(ctx, assets.logo, lx, ly, lw, lw);
  }

  // Member name (header).
  const name = card.identity?.fullName ?? `${t.orgName} MEMBER`;
  const namePx = fitFontPx(ctx, name.toUpperCase(), 900, S(52), textRight - bodyLeft);
  ctx.fillStyle = c.text;
  ctx.font = `900 ${namePx}px ${FONT}`;
  ctx.fillText(name.toUpperCase(), bodyLeft, cursorY);

  // Accent rule.
  ctx.fillStyle = c.accent;
  roundRectPath(ctx, bodyLeft, cursorY + Y(18), X(150), S(6), S(3));
  ctx.fill();

  // Field rows.
  const fields = resolveFields(card, design);
  const fieldsTop = cursorY + Y(70);
  const footerTop = H - Y(150);
  const avail = Math.max(Y(52), footerTop - fieldsTop);
  const step = fields.length > 0 ? Math.min(Y(52), avail / fields.length) : Y(52);
  const labelX = bodyLeft;
  const valueX = bodyLeft + Math.min(X(220), (textRight - bodyLeft) * 0.42);
  fields.forEach((f, i) => {
    const y = fieldsTop + i * step + step * 0.62;
    const lPx = fitFontPx(ctx, f.label.toUpperCase(), 800, S(24), valueX - labelX - X(12), S(0.8));
    ctx.fillStyle = c.muted;
    ctx.font = `800 ${lPx}px ${FONT}`;
    if ('letterSpacing' in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = `${S(0.8)}px`;
    ctx.fillText(f.label.toUpperCase(), labelX, y);
    if ('letterSpacing' in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = '0px';

    const vPx = fitFontPx(ctx, f.value, 700, S(30), textRight - valueX);
    ctx.fillStyle = c.text;
    ctx.font = `700 ${vPx}px ${FONT}`;
    ctx.fillText(f.value, valueX, y);
  });

  // Footer: slogan + verify line + email.
  const sloganPx = fitFontPx(ctx, t.slogan, 800, S(24), textRight - bodyLeft, S(1));
  ctx.fillStyle = c.accent;
  ctx.font = `800 ${sloganPx}px ${FONT}`;
  ctx.fillText(t.slogan, bodyLeft, H - Y(110));

  ctx.fillStyle = c.muted;
  const verify = footerLine(card, design);
  const vPx = fitFontPx(ctx, verify, 600, S(23), textRight - bodyLeft);
  ctx.font = `600 ${vPx}px ${FONT}`;
  ctx.fillText(verify, bodyLeft, H - Y(72));

  const email = `Email ${card.party.contacts.email}`;
  const ePx = fitFontPx(ctx, email, 600, S(23), textRight - bodyLeft);
  ctx.font = `600 ${ePx}px ${FONT}`;
  ctx.fillText(email, bodyLeft, H - Y(38));

  // ── QR (drawn last, on a white rounded plate) ────────────────────────────
  if (qrBox && assets.qr) {
    const padl = S(18);
    const px = qrBox.x - padl;
    const py = qrBox.y - padl;
    const ps = qrBox.s + padl * 2;
    ctx.fillStyle = '#ffffff';
    roundRectPath(ctx, px, py, ps, ps, S(26));
    ctx.fill();
    ctx.drawImage(assets.qr, qrBox.x, qrBox.y, qrBox.s, qrBox.s);
    // Public code under the QR.
    const code = card.publicCode;
    const cPx = fitFontPx(ctx, code, 800, S(22), ps);
    ctx.fillStyle = c.text;
    ctx.font = `800 ${cPx}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(code, px + ps / 2, py + ps + Y(34));
    ctx.textAlign = 'left';
  }

  ctx.restore(); // un-clip

  // ── Border stroke (over the clipped content) ─────────────────────────────
  if (bw > 0 && design.border.style !== 'none') {
    ctx.save();
    ctx.strokeStyle = c.border;
    ctx.lineWidth = bw;
    if (design.border.style === 'dashed') ctx.setLineDash([S(14), S(10)]);
    roundRectPath(ctx, inset, inset, W - bw, H - bw, radius);
    ctx.stroke();
    if (design.border.style === 'double') {
      ctx.lineWidth = Math.max(1, bw * 0.4);
      roundRectPath(ctx, inset + bw, inset + bw, W - bw * 3, H - bw * 3, Math.max(0, radius - bw));
      ctx.stroke();
    }
    ctx.restore();
  }

  ctx.restore();
}

/**
 * Size `canvas` and paint the card. For a preview pass `{ widthPx }` to render at
 * a fixed backing width (height follows the card's aspect); omit it to render the
 * true export size (design dpi × scalePct, clamped). Returns the pixel size used.
 */
export function renderCard(
  canvas: HTMLCanvasElement,
  card: PartyCard,
  design: CardDesign,
  assets: CardAssets,
  opts: { widthPx?: number; shadow?: boolean; padRatio?: number } = {},
): { w: number; h: number; clamped: boolean } {
  const explicit = Boolean(opts.widthPx && opts.widthPx > 0);
  let w: number;
  let h: number;
  let clamped = false;
  if (explicit) {
    w = Math.round(opts.widthPx as number);
    h = Math.round(w / cardAspect(design));
  } else {
    const size = cardPixelSize(design);
    w = size.w;
    h = size.h;
    clamped = size.clamped;
  }
  // A preview floats on the sheet, so by default it gets a shadow + a transparent
  // margin; an export (or a batch-print tile) is the bare card. Callers override.
  const shadow = opts.shadow ?? explicit;
  const padRatio = opts.padRatio ?? (explicit ? 0.06 : 0);
  const pad = Math.round(Math.min(w, h) * padRatio);
  canvas.width = w + pad * 2;
  canvas.height = h + pad * 2;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.save();
    ctx.translate(pad, pad);
    paintCard(ctx, card, design, assets, w, h, { shadow });
    ctx.restore();
  }
  return { w: w + pad * 2, h: h + pad * 2, clamped };
}

/**
 * Paint JUST the member photo into `canvas`, exactly as the card slot would show
 * it (same crop/zoom/shape mask), for the crop/zoom editor's live preview.
 * `aspect` is the slot's width ÷ height (the card uses ≈ 1 : 1.25).
 */
export function paintPhotoPreview(
  canvas: HTMLCanvasElement,
  img: HTMLImageElement | null,
  transform: PhotoTransform,
  shape: 'rect' | 'rounded' | 'circle',
  widthPx = 320,
  aspect = 0.8,
): void {
  const W = Math.max(1, Math.round(widthPx));
  const H = Math.max(1, Math.round(W / aspect));
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#e7e5e4';
  ctx.fillRect(0, 0, W, H);
  if (img) drawPhoto(ctx, img, transform, 0, 0, W, H, shape);
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
}
