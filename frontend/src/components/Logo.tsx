/**
 * UDF logo — protest-art illustration (flag + crowd).
 * Used throughout the platform as the primary brand mark.
 */
interface LogoProps {
  /** Edge length of the square mark in px. */
  size?: number;
  /** Render the "UDF" wordmark beside the mark. */
  wordmark?: boolean;
  /** Light variant puts the wordmark in white (for dark headers). */
  variant?: 'dark' | 'light';
  className?: string;
}

export default function Logo({ size = 32, wordmark = true, variant = 'dark', className }: LogoProps) {
  const wordColor = variant === 'light' ? '#FFFFFF' : '#141414';
  return (
    <span
      className={className}
      style={{ display: 'inline-flex', alignItems: 'center', gap: Math.round(size * 0.28) }}
      aria-label="UDF"
    >
      <span
        style={{
          width: size,
          height: size,
          flex: 'none',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#C8102E',
          borderRadius: '20%',
          padding: Math.max(1, Math.round(size * 0.08)),
          boxSizing: 'border-box',
        }}
      >
        {/* contain, not cover: the illustration is full-bleed, so filling the
            square crops the flag and the front row of faces. Fitting it inside
            a padded brand tile keeps the whole mark visible at any size. */}
        <img
          src="/brand/udf-illustration.png"
          alt="UDF"
          style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', borderRadius: '12%' }}
        />
      </span>
      {wordmark && (
        <span
          style={{
            color: wordColor,
            fontWeight: 900,
            letterSpacing: '0.5px',
            fontSize: Math.round(size * 0.62),
            lineHeight: 1,
          }}
        >
          UDF
        </span>
      )}
    </span>
  );
}
