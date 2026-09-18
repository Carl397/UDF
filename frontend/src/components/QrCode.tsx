'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/**
 * Renders a QR code as a data-URL image.
 * Used on the party ID card, the public verify page and confirmation panels.
 */
export default function QrCode({
  value,
  size = 176,
  label,
  dark = '#141414',
}: {
  value: string;
  size?: number;
  label?: string;
  dark?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(value, {
      margin: 1,
      width: size * 2,
      errorCorrectionLevel: 'M',
      color: { dark, light: '#ffffff' },
    })
      .then((url) => !cancelled && setSrc(url))
      .catch(() => !cancelled && setSrc(null));
    return () => {
      cancelled = true;
    };
  }, [value, size, dark]);

  if (!value) return null;

  if (!src) {
    return <div className="skeleton qr-skeleton" style={{ width: size, height: size }} aria-hidden="true" />;
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className="qr-img"
      src={src}
      width={size}
      height={size}
      alt={label ?? 'QR code'}
      style={{ width: size, height: size }}
    />
  );
}
