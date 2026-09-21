import Image from 'next/image';
import type { Metadata } from 'next';
import Logo from '../../components/Logo';
import ApkDownloadButton from './ApkDownloadButton';
import { API_BASE } from '../../lib/api';
import './mobile.css';

export const metadata: Metadata = {
  title: 'UDF Party — Mobile App',
  description:
    'The official UDF party app: follow patrols and engagements, watch true progress in your ward, and rate your councillor — accountability at your fingertips.',
};

// Counted download: hits the analytics endpoint (logs device/OS/referrer) then
// 302-redirects to the real APK. A bare static link could never be counted —
// the app vhost's nginx access log is off (see deploy/RUNBOOK).
const APK_URL = `${API_BASE}/public/download/apk`;

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
          <ApkDownloadButton className="udf-nav-cta" href={APK_URL}>
            <Image src="/brand/icon-32.png" alt="" width={16} height={16} style={{ borderRadius: 4 }} />
            Get the app
          </ApkDownloadButton>
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
              Everything your ward needs in one secure app — watch the movement
              grow on a live map and heat map, follow patrols and engagements,
              and rate the councillors who serve you.
            </p>
            <div className="udf-cta-row">
              <ApkDownloadButton className="udf-btn udf-btn-gold" href={APK_URL}>
                <Image src="/brand/icon-32.png" alt="" width={22} height={22} style={{ borderRadius: 6 }} />
                Download UDF Party App
              </ApkDownloadButton>
            </div>
            <div className="udf-hero-meta">
              <div>
                <b>Live</b> map &amp; heat map
              </div>
              <div>
                <b>Patrols</b> &amp; engagements
              </div>
              <div>
                <b>Rate</b> your councillor
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

      {/* ── Brand poster band (whole illustration, fits without crop/zoom) ── */}
      <section className="udf-poster">
        <div className="udf-container udf-poster-in">
          <Image
            src="/brand/udf-illustration.png"
            alt="UDF brand illustration: a diverse crowd raising clenched fists beneath the UDF flag"
            width={1050}
            height={1050}
            className="udf-poster-img"
          />
          <strong className="udf-poster-cap">Built for the people, by the people.</strong>
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
              <p>See events across every region on an interactive map.</p>
            </div>
            <div className="udf-card">
              <div className="udf-card-icon">🔥</div>
              <h3>Heat Map</h3>
              <p>Spot momentum instantly — engagement and head-count density at a glance.</p>
            </div>
            <div className="udf-card">
              <div className="udf-card-icon">🚑</div>
              <h3>Patrols</h3>
              <p>See councillor and volunteer patrols across your ward, week by week — real activity, not promises.</p>
            </div>
            <div className="udf-card">
              <div className="udf-card-icon">🤝</div>
              <h3>Engagements</h3>
              <p>Rallies, clinic days and community meetings — every engagement logged and visible to members.</p>
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

      {/* ── Accountability (member benefits) ── */}
      <section className="udf-section">
        <div className="udf-container">
          <span className="udf-kicker">For members</span>
          <h2 className="udf-h2">Accountability at your fingertips</h2>
          <p className="udf-lead">
            Give the community the tools to judge true progress — not promises.
            Track the people you elected, follow what actually gets delivered,
            and hold them to account from your phone.
          </p>
          <div className="udf-tools">
            <div className="udf-tool">
              <span className="udf-tool-num">1</span>
              <h4>Patrols &amp; engagements</h4>
              <p>
                Short, honest highlights of every patrol and community
                engagement in your ward — what happened, where and when.
              </p>
            </div>
            <div className="udf-tool">
              <span className="udf-tool-num">2</span>
              <h4>Rate your councillor</h4>
              <p>
                Service delivered, or an issue ignored? Rate your councillor.
                Scores are public and feed real performance reviews.
              </p>
            </div>
            <div className="udf-tool">
              <span className="udf-tool-num">3</span>
              <h4>See true progress</h4>
              <p>
                Watch promises turn into delivery — housing, water, electricity
                and safety — with visible progress for your ward.
              </p>
            </div>
          </div>

          <div className="udf-banner">
            <p>
              Your voice keeps the movement honest. Every rating, every
              report — community interests above internal politics.
            </p>
          </div>

          {/* Alert preview: what accountability looks like on your phone */}
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
              Patrol logged — Ward 96, 6pm. 3 issues captured. Tap to see the
              map and rate the response.
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
              Install the official UDF app on Android and carry your ward with
              you — every patrol, engagement and councillor rating, right in
              your pocket.
            </p>
            <div className="udf-cta-row" style={{ justifyContent: 'center' }}>
              <ApkDownloadButton className="udf-btn udf-btn-gold" href={APK_URL}>
                <Image src="/brand/icon-32.png" alt="" width={22} height={22} style={{ borderRadius: 6 }} />
                Download for Android
              </ApkDownloadButton>
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="udf-footer">
        <div className="udf-container udf-footer-inner">
          <span>© {new Date().getFullYear()} UDF Party. All rights reserved.</span>
        </div>
      </footer>
    </div>
  );
}
