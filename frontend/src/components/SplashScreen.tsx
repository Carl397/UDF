'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';

/**
 * Branded boot splash. Shown full-screen while the app hydrates, then fades
 * out. The same artwork (public/brand/splash.png) is used as the native
 * Capacitor splash via the Android build script.
 */
export default function SplashScreen() {
  const [phase, setPhase] = useState<'show' | 'fade' | 'gone'>('show');

  useEffect(() => {
    const fade = window.setTimeout(() => setPhase('fade'), 900);
    const gone = window.setTimeout(() => setPhase('gone'), 1400);
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(gone);
    };
  }, []);

  if (phase === 'gone') return null;

  return (
    <div
      aria-hidden="true"
      data-app-splash
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: '#C8102E',
        opacity: phase === 'fade' ? 0 : 1,
        transition: 'opacity 480ms ease',
        pointerEvents: phase === 'fade' ? 'none' : 'auto',
      }}
    >
      <Image
        src="/brand/udf-illustration.png"
        alt=""
        fill
        sizes="100vw"
        priority
        style={{ objectFit: 'cover' }}
      />
      {/* Tagline over the artwork */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: '12%',
          textAlign: 'center',
          color: '#FFFFFF',
          fontWeight: 800,
          letterSpacing: 2,
          fontSize: 13,
          textShadow: '0 2px 10px rgba(0,0,0,0.4)',
        }}
      >
        SERVICE BEFORE SELF
      </div>
    </div>
  );
}
