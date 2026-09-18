import pino from 'pino';
import { env } from './env.js';

/**
 * Structured JSON logger.
 * Security note: never log plaintext PII, tokens, or keys. Sensitive fields
 * are redacted defensively here as a second safety net.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.accessToken',
      '*.refreshToken',
      '*.kek',
      '*.plaintext',
    ],
    censor: '[REDACTED]',
  },
});

export type Logger = typeof logger;
