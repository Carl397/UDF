'use client';

import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../../lib/api';
import { CrmModal, CrmButton } from './ui';
import { loadImage, mmToPx, renderCard, type CardAssets } from '../../lib/cardRender';
import type { CardDesign, PartyCard } from '../../types';

/**
 * CRM ▸ Members ▸ Print cards. Renders a multi-select of members onto print
 * sheets using the SAME card renderer as the single-card export, so a batch is
 * pixel-identical to the cards members see — just tiled.
 *
 * The design (and thus the card size) is the national admin's; the operator picks
 * the paper and how many cards per sheet here, without changing the template.
 * PII is NEVER revealed in a batch (the service forces `withPii=false`), and
 * out-of-scope/unknown ids come back in `skipped` rather than failing the run.
 */

const PAPER_MM: Record<CardDesign['print']['paper'], [number, number]> = {
  a4: [210, 297],
  letter: [215.9, 279.4],
  a3: [297, 420],
  a6: [105, 148],
};
const PAPER_LABEL: Record<CardDesign['print']['paper'], string> = {
  a4: 'A4', letter: 'US Letter', a3: 'A3', a6: 'A6',
};
const SHEET_DPI = 200;

/** The grid (cols × rows) that makes each card as large as possible on the paper. */
function bestGrid(
  n: number, pw: number, ph: number, cw: number, ch: number, gutter: number,
): { cols: number; rows: number; scale: number } {
  let best = { cols: 1, rows: Math.max(1, n), scale: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cellW = (pw - (cols + 1) * gutter) / cols;
    const cellH = (ph - (rows + 1) * gutter) / rows;
    if (cellW <= 0 || cellH <= 0) continue;
    const scale = Math.min(cellW / cw, cellH / ch);
    if (scale > best.scale) best = { cols, rows, scale };
  }
  if (best.scale <= 0) {
    best = { cols: 1, rows: Math.max(1, n), scale: Math.min((pw - 2 * gutter) / cw, (ph - 2 * gutter) / ch) };
  }
  return best;
}

export default function BatchCardPrint({
  memberIds,
  onClose,
}: {
  memberIds: string[];
  onClose: () => void;
}) {
  const [design, setDesign] = useState<CardDesign | null>(null);
  const [cards, setCards] = useState<PartyCard[]>([]);
  const [assets, setAssets] = useState<CardAssets[] | null>(null);
  const [skipped, setSkipped] = useState<{ memberId: string; reason: string }[]>([]);
  const [layout, setLayout] = useState<{ paper: CardDesign['print']['paper']; perSheet: number } | null>(null);
  const [sheets, setSheets] = useState<string[]>([]);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Fetch the batch, then pre-build every card's images (shared logo, per-card QR
  // and photo) once — they don't depend on the paper/per-sheet layout.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await api.batchCards(memberIds);
        if (!live) return;
        const d = res.design;
        setDesign(d);
        setCards(res.cards);
        setSkipped(res.skipped);
        setLayout({ paper: d.print.paper, perSheet: d.print.perSheet });

        let logoImg: HTMLImageElement | null = null;
        if (d.logo.show && d.logo.mediaId) {
          const blob = await api.cardMediaBlob(d.logo.mediaId);
          if (blob) logoImg = await loadImage(URL.createObjectURL(blob));
        }

        const built: CardAssets[] = [];
        const total = res.cards.length;
        setProgress({ done: 0, total });
        for (let i = 0; i < res.cards.length; i++) {
          const c = res.cards[i]!;
          const qrUrl = await QRCode.toDataURL(c.verifyUrl, {
            margin: 1, width: 520, errorCorrectionLevel: 'M', color: { dark: '#141414', light: '#ffffff' },
          });
          const qrImg = await loadImage(qrUrl);
          let photoImg: HTMLImageElement | null = null;
          if (d.photo.show && c.photo?.mediaId) {
            const blob = await api.cardMediaBlob(c.photo.mediaId);
            if (blob) photoImg = await loadImage(URL.createObjectURL(blob));
          }
          built.push({ logo: logoImg, photo: photoImg, qr: qrImg });
          if (live) setProgress({ done: i + 1, total });
        }
        if (!live) return;
        setAssets(built);
        setPhase(total > 0 ? 'ready' : 'error');
        if (total === 0) setErr('No cards could be rendered for the selected members.');
      } catch (e: any) {
        if (!live) return;
        setPhase('error');
        setErr(e?.message ?? 'Could not build the print run.');
      }
    })();
    return () => { live = false; };
  }, [memberIds]);

  // Composite the print sheets whenever the cards, images or layout change.
  useEffect(() => {
    if (!design || !assets || !layout || cards.length === 0) return;
    const [pw, ph] = PAPER_MM[layout.paper];
    const gutter = design.print.gutterMm;
    const grid = bestGrid(layout.perSheet, pw, ph, design.size.widthMm, design.size.heightMm, gutter);
    const sheetW = Math.round(mmToPx(pw, SHEET_DPI));
    const sheetH = Math.round(mmToPx(ph, SHEET_DPI));
    const gutterPx = mmToPx(gutter, SHEET_DPI);
    const cellWmm = (pw - (grid.cols + 1) * gutter) / grid.cols;
    const cellHmm = (ph - (grid.rows + 1) * gutter) / grid.rows;
    const cellWpx = mmToPx(cellWmm, SHEET_DPI);
    const cellHpx = mmToPx(cellHmm, SHEET_DPI);
    const cardWpx = Math.round(mmToPx(design.size.widthMm * grid.scale, SHEET_DPI));
    const cardHpx = Math.round(mmToPx(design.size.heightMm * grid.scale, SHEET_DPI));

    const out: string[] = [];
    for (let s = 0; s * layout.perSheet < cards.length; s++) {
      const chunk = cards.slice(s * layout.perSheet, (s + 1) * layout.perSheet);
      const sheet = document.createElement('canvas');
      sheet.width = sheetW;
      sheet.height = sheetH;
      const ctx = sheet.getContext('2d');
      if (!ctx) continue;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, sheetW, sheetH);

      chunk.forEach((card, i) => {
        const a = assets[s * layout.perSheet + i];
        if (!a) return;
        const off = document.createElement('canvas');
        renderCard(off, card, design, a, { widthPx: cardWpx, shadow: false, padRatio: 0 });
        const col = i % grid.cols;
        const row = Math.floor(i / grid.cols);
        const x = gutterPx + col * (cellWpx + gutterPx) + (cellWpx - off.width) / 2;
        const y = gutterPx + row * (cellHpx + gutterPx) + (cellHpx - off.height) / 2;
        ctx.drawImage(off, x, y);

        if (design.print.cutMarks) {
          const m = Math.min(gutterPx * 0.7, 12);
          ctx.strokeStyle = '#9ca3af';
          ctx.lineWidth = 1;
          const corners: [number, number, number, number][] = [
            [x, y, -1, -1], [x + off.width, y, 1, -1], [x, y + off.height, -1, 1], [x + off.width, y + off.height, 1, 1],
          ];
          for (const [cx, cy, dx, dy] of corners) {
            ctx.beginPath();
            ctx.moveTo(cx + dx * 2, cy + dy * 2);
            ctx.lineTo(cx + dx * (2 + m), cy + dy * 2);
            ctx.moveTo(cx + dx * 2, cy + dy * 2);
            ctx.lineTo(cx + dx * 2, cy + dy * (2 + m));
            ctx.stroke();
          }
        }
      });
      out.push(sheet.toDataURL('image/png'));
    }
    setSheets(out);
    setSheetIdx(0);
  }, [design, assets, layout, cards]);

  const perOptions = useMemo(() => [1, 2, 4, 6, 8, 9, 12, 16, 24, 32, 48, 64], []);

  function print() {
    if (!layout || sheets.length === 0) return;
    const [pw, ph] = PAPER_MM[layout.paper];
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow?.document;
    if (!doc) { document.body.removeChild(iframe); return; }
    doc.open();
    doc.write(
      `<html><head><title>UDF ID cards</title><style>` +
      `@page{size:${pw}mm ${ph}mm;margin:0;}` +
      `html,body{margin:0;padding:0;}` +
      `img{width:${pw}mm;height:${ph}mm;display:block;page-break-after:always;}` +
      `img:last-child{page-break-after:auto;}` +
      `</style></head><body>${sheets.map((u) => `<img src="${u}"/>`).join('')}</body></html>`,
    );
    doc.close();
    const win = iframe.contentWindow;
    const cleanup = () => window.setTimeout(() => { if (iframe.parentNode) iframe.parentNode.removeChild(iframe); }, 1500);
    if (win) { win.focus(); window.setTimeout(() => { win.print(); cleanup(); }, 400); }
    else cleanup();
  }

  function downloadAll() {
    sheets.forEach((u, i) => {
      const a = document.createElement('a');
      a.href = u;
      a.download = `udf-cards-sheet-${i + 1}.png`;
      window.setTimeout(() => a.click(), i * 350);
    });
  }

  return (
    <CrmModal title={`Print ID cards · ${cards.length} selected`} onClose={onClose} wide>
      {phase === 'loading' && (
        <p style={{ color: '#64748b', fontSize: 14 }}>
          {progress ? `Rendering cards… ${progress.done}/${progress.total}` : 'Building the print run…'}
        </p>
      )}
      {phase === 'error' && (
        <div style={{ padding: 12, borderRadius: 8, background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 13 }}>
          {err ?? 'Could not build the print run.'}
        </div>
      )}

      {phase === 'ready' && design && layout && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 260px', gap: 20, alignItems: 'start' }}>
          <div>
            {sheets[sheetIdx] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={sheets[sheetIdx]} alt={`Print sheet ${sheetIdx + 1}`} style={{ width: '100%', border: '1px solid #e7e5e4', borderRadius: 10, background: '#fff' }} />
            ) : (
              <p style={{ color: '#64748b' }}>Compositing sheets…</p>
            )}
            {sheets.length > 1 && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
                <CrmButton variant="secondary" onClick={() => setSheetIdx((i) => Math.max(0, i - 1))} disabled={sheetIdx === 0}>←</CrmButton>
                <span style={{ fontSize: 13, color: '#57534e' }}>Sheet {sheetIdx + 1} of {sheets.length}</span>
                <CrmButton variant="secondary" onClick={() => setSheetIdx((i) => Math.min(sheets.length - 1, i + 1))} disabled={sheetIdx >= sheets.length - 1}>→</CrmButton>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: '#78716c' }}>Paper</span>
              <select
                value={layout.paper}
                onChange={(e) => setLayout({ ...layout, paper: e.target.value as CardDesign['print']['paper'] })}
                style={{ padding: '8px 10px', fontSize: 13, border: '1px solid #e7e5e4', borderRadius: 8 }}
              >
                {(Object.keys(PAPER_MM) as CardDesign['print']['paper'][]).map((k) => (
                  <option key={k} value={k}>{PAPER_LABEL[k]}</option>
                ))}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: '#78716c' }}>Cards per sheet</span>
              <select
                value={layout.perSheet}
                onChange={(e) => setLayout({ ...layout, perSheet: Number(e.target.value) })}
                style={{ padding: '8px 10px', fontSize: 13, border: '1px solid #e7e5e4', borderRadius: 8 }}
              >
                {perOptions.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>

            <div style={{ fontSize: 12, color: '#78716c', lineHeight: 1.6 }}>
              Card size <strong>{design.size.widthMm} × {design.size.heightMm} mm</strong> is set in the ID Card
              Studio. {sheets.length} sheet{sheets.length === 1 ? '' : 's'} · {cards.length} card{cards.length === 1 ? '' : 's'}.
            </div>

            {skipped.length > 0 && (
              <div style={{ fontSize: 12, color: '#991b1b', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 10 }}>
                {skipped.length} skipped (outside your scope or not found).
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <CrmButton onClick={print} disabled={sheets.length === 0}>Print {sheets.length} sheet{sheets.length === 1 ? '' : 's'}</CrmButton>
              <CrmButton variant="secondary" onClick={downloadAll} disabled={sheets.length === 0}>Download PNGs</CrmButton>
              <CrmButton variant="secondary" onClick={onClose}>Close</CrmButton>
            </div>
          </div>
        </div>
      )}
    </CrmModal>
  );
}
