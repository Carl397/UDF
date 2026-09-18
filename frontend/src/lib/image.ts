/**
 * Client-side image helpers for uploads (card logo, member photo).
 *
 * Uploads go to the backend as base64 data-urls, so a big phone photo must be
 * downscaled/recompressed in the browser first — both to stay inside the request
 * budget and because a card slot only needs ~1000px at most. `shrinkImage` walks a
 * ladder of (maxEdge, quality) steps until the data-url fits the budget.
 */

/** Read a File/Blob as a base64 data-url. */
export function readAsDataUrl(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result ?? ''));
    fr.onerror = () => reject(new Error('Could not read that file'));
    fr.readAsDataURL(file);
  });
}

/** Load an <img> element from a src; rejects if it is not a readable image. */
export function loadImageEl(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That file is not a readable image'));
    img.src = src;
  });
}

export interface ShrinkOptions {
  /** Output mime. Use `image/png` to preserve a logo's transparency. */
  mime?: 'image/jpeg' | 'image/png' | 'image/webp';
  /** Base64-character budget (≈ bytes × 4/3). */
  budget?: number;
  /** Downscale ladder: [maxEdgePx, quality]. Quality is ignored for PNG. */
  steps?: [number, number][];
}

const PHOTO_STEPS: [number, number][] = [
  [1280, 0.9], [1024, 0.85], [896, 0.8], [768, 0.75], [640, 0.7],
];

/**
 * Downscale/recompress `file` to a data-url within the budget. Returns the
 * original untouched when it already fits and is a usable image type.
 */
export async function shrinkImage(file: File, opts: ShrinkOptions = {}): Promise<string> {
  const mime = opts.mime ?? 'image/jpeg';
  const budget = opts.budget ?? 1_500_000;
  const steps = opts.steps ?? PHOTO_STEPS;

  const original = await readAsDataUrl(file);
  const typeOk = new RegExp(`^data:${mime.replace('/', '\\/')};`, 'i').test(original)
    || /^data:image\/(jpeg|png|webp);/i.test(original);
  if (original.length <= budget && typeOk && mime === 'image/jpeg') {
    return original;
  }

  const img = await loadImageEl(original);
  let last = original;
  for (const [maxEdge, quality] of steps) {
    const scale = Math.min(1, maxEdge / Math.max(img.width, img.height, 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) break;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    last = canvas.toDataURL(mime, quality);
    if (last.length <= budget) return last;
  }
  // PNG (logos) has no quality dial: accept the smallest edge we produced.
  if (mime === 'image/png') return last;
  throw new Error('That image could not be compressed enough — please choose a smaller one.');
}
