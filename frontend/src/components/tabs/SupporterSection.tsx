'use client';

import ShareCard from '../supporter/ShareCard';

/**
 * In-app "Supporter card" screen (More → Supporter).
 *
 * A supporter adds a portrait and the card is composed entirely on-device —
 * the UDF never receives or stores the photo. From here they can share it to
 * WhatsApp status / Facebook via the OS share sheet, or save it to the device.
 */
export default function SupporterSection() {
  return (
    <>
      <div className="card hero-card compact" style={{ marginTop: 12 }}>
        <span className="eyebrow">Show your support</span>
        <h2>Tell your ward you back the UDF</h2>
        <p>
          Add your photo and share a supporter card to WhatsApp status, Facebook, or anywhere
          else — composed on your phone, never uploaded to us.
        </p>
      </div>

      <ShareCard compact />

      <div style={{ height: 12 }} />
    </>
  );
}
