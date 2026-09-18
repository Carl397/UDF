import Image from 'next/image';
import type { Metadata } from 'next';
import Logo from '../../components/Logo';
import './mobile.css';

export const metadata: Metadata = {
  title: 'UDF Party — Mobile App',
  description:
    'The official UDF party mobile app: member organizing, live map and heat-map analytics, secured with 3-layer encryption.',
};

const APK_URL = '/downloads/udf.apk';

export default function MobileLandingPage() {
  return (
    <div className="udf-landing">
      {/* ── Nav ── */}
      <header className="udf-nav">
        <div className="udf-container udf-nav-inner">
          <div className="udf-brand">
            <Logo size={34} wordmark={false} />
            <span>UDF PARTY</span>
          </div>
          <a className="udf-nav-cta" href={APK_URL}>
            Get the app
          </a>
        </div>
      </header>

      {/* ── Hero ── */}
      <section className="udf-hero">
        <div className="udf-container udf-hero-inner">
          <div>
            <span className="udf-eyebrow">Official UDF mobile app</span>
            <h1 className="udf-h1">
              One party.
              <br />
              One platform.
              <br />
              <span className="gold">In your pocket.</span>
            </h1>
            <p className="udf-sub">
              Organize members, watch your movement grow on a live map and heat
              map, and keep every record protected with enterprise-grade,
              3-layer encryption.
            </p>
            <div className="udf-cta-row">
              <a className="udf-btn udf-btn-gold" href={APK_URL}>
                ⬇ Download APK
              </a>
              <a className="udf-btn udf-btn-ghost" href="/login">
                Open web app →
              </a>
            </div>
            <div className="udf-hero-meta">
              <div>
                <b>3-layer</b> encryption
              </div>
              <div>
                <b>Live</b> map &amp; heat map
              </div>
              <div>
                <b>100%</b> member-first
              </div>
            </div>
          </div>

          {/* Phone mockup showing the splash screen */}
          <div className="udf-phone" aria-hidden="true">
            <div className="udf-phone-screen">
              <div className="udf-phone-notch" />
              <Image
                src="/brand/splash.png"
                alt="UDF app splash screen"
                fill
                sizes="300px"
                style={{ objectFit: 'cover' }}
                priority
              />
            </div>
          </div>
        </div>
      </section>

      {/* ── Brand poster band ── */}
      <section style={{ position: 'relative', height: 'min(46vw, 420px)' }}>
        <Image
          src="/brand/udf-illustration.png"
          alt="UDF brand banner"
          fill
          sizes="100vw"
          style={{ objectFit: 'cover', objectPosition: 'center 30%' }}
        />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'linear-gradient(180deg, rgba(20,20,20,0) 40%, rgba(20,20,20,0.72) 100%)',
          }}
        />
        <div
          className="udf-container"
          style={{
            position: 'absolute',
            bottom: 22,
            left: 0,
            right: 0,
            color: '#fff',
          }}
        >
          <strong style={{ fontSize: 'clamp(18px,3vw,26px)', fontWeight: 900 }}>
            Built for the people, by the people.
          </strong>
        </div>
      </section>

      {/* ── Features ── */}
      <section className="udf-section">
        <div className="udf-container">
          <span className="udf-kicker">What&apos;s inside</span>
          <h2 className="udf-h2">Everything an organizer needs</h2>
          <p className="udf-lead">
            A single, secure home for your movement — from the national office
            down to every neighborhood block.
          </p>
          <div className="udf-grid">
            <div className="udf-card">
              <div className="udf-card-icon">🗺️</div>
              <h3>Live Map</h3>
              <p>See members, volunteers and events across every region on an interactive map.</p>
            </div>
            <div className="udf-card">
              <div className="udf-card-icon">🔥</div>
              <h3>Heat Map</h3>
              <p>Spot momentum instantly — engagement and head-count density at a glance.</p>
            </div>
            <div className="udf-card">
              <div className="udf-card-icon">👥</div>
              <h3>Members</h3>
              <p>Voters, volunteers, donors, candidates and staff — one directory, many tiers.</p>
            </div>
            <div className="udf-card">
              <div className="udf-card-icon">🔐</div>
              <h3>Encrypted</h3>
              <p>Field-level encryption keeps personal data sealed — even from insiders.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Brand assets / screens ── */}
      <section className="udf-section udf-section-dark">
        <div className="udf-container">
          <span className="udf-kicker">Brand system</span>
          <h2 className="udf-h2">A brand you can trust</h2>
          <p className="udf-lead">
            Every screen carries the party&apos;s colors — corporate red and
            ink black — from the app icon to the splash to push
            notifications.
          </p>
          <div className="udf-screens">
            <figure className="udf-screen" style={{ margin: 0 }}>
              <div style={{ position: 'relative', aspectRatio: '1 / 1' }}>
                <Image src="/brand/app-icon.png" alt="UDF app icon" fill sizes="340px" />
              </div>
              <figcaption>App icon — clean and bold on every home screen.</figcaption>
            </figure>
            <figure className="udf-screen" style={{ margin: 0 }}>
              <div style={{ position: 'relative', aspectRatio: '9 / 16' }}>
                <Image src="/brand/splash.png" alt="UDF splash screen" fill sizes="340px" />
              </div>
              <figcaption>Splash screen — a clean first impression.</figcaption>
            </figure>
            <figure className="udf-screen" style={{ margin: 0 }}>
              <div style={{ position: 'relative', aspectRatio: '4 / 3' }}>
                <Image src="/brand/notification.png" alt="UDF notification image" fill sizes="340px" />
              </div>
              <figcaption>Notification image — bold in every alert.</figcaption>
            </figure>
          </div>
        </div>
      </section>

      {/* ── Security ── */}
      <section className="udf-section">
        <div className="udf-container">
          <span className="udf-kicker">Privacy &amp; security</span>
          <h2 className="udf-h2">Protected by 3-layer encryption</h2>
          <p className="udf-lead">
            Your members&apos; trust is the movement&apos;s foundation. We defend it at
            every layer.
          </p>
          <div className="udf-sec-list">
            <div className="udf-sec-item">
              <span className="udf-sec-num">1</span>
              <div>
                <h4>In transit</h4>
                <p>TLS everywhere, hardened headers and strict transport security.</p>
              </div>
            </div>
            <div className="udf-sec-item">
              <span className="udf-sec-num">2</span>
              <div>
                <h4>At rest</h4>
                <p>Encrypted databases and volumes, with TLS to the database itself.</p>
              </div>
            </div>
            <div className="udf-sec-item">
              <span className="udf-sec-num">3</span>
              <div>
                <h4>Field-level (E2EE)</h4>
                <p>Each record sealed with its own key, wrapped by a KMS master key — plus a tamper-evident audit trail.</p>
              </div>
            </div>
          </div>

          {/* Notification preview card */}
          <div className="udf-notif">
            <div className="udf-notif-head">
              <Image src="/brand/icon-32.png" alt="" width={28} height={28} style={{ borderRadius: 7 }} />
              <div>
                <div className="udf-notif-title">UDF Party</div>
                <div style={{ fontSize: 11, color: '#94a3b8' }}>now</div>
              </div>
            </div>
            <div style={{ position: 'relative', aspectRatio: '2 / 1' }}>
              <Image src="/brand/notification.png" alt="Push notification big picture" fill sizes="460px" style={{ objectFit: 'cover' }} />
            </div>
            <div className="udf-notif-body">
              Rally tomorrow, 5pm — Central Region. Tap to see the map.
            </div>
          </div>
        </div>
      </section>

      {/* ── Final CTA ── */}
      <section className="udf-section">
        <div className="udf-container">
          <div className="udf-cta-band">
            <h2>Join the movement today</h2>
            <p>
              Install the UDF app on Android, or open the full web platform from
              any browser.
            </p>
            <div className="udf-cta-row" style={{ justifyContent: 'center' }}>
              <a className="udf-btn udf-btn-gold" href={APK_URL}>
                 Download for Android
              </a>
              <a className="udf-btn udf-btn-ghost" href="/login">
                Sign in on web
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="udf-footer">
        <div className="udf-container udf-footer-inner">
          <span>© {new Date().getFullYear()} UDF Party. All rights reserved.</span>
          <span>
            <a href="/mobile">App</a> · <a href="/login">Sign in</a> ·{' '}
            <a href="/healthz">Status</a>
          </span>
        </div>
      </footer>
    </div>
  );
}
