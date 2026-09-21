import { createConnection, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { query } from '../db/pool.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { blindIndex } from './blindIndex.js';

/**
 * Outbound mail (PRD-growth FR-Q4/FR-Q6) — dependency-free.
 *
 * The production host runs postfix on loopback (DKIM signed by the on-box
 * opendkim milter), so the app needs no mail library and no credentials: it
 * hands an RFC-5322 message to 127.0.0.1:25 and postfix relays + signs it. A
 * minimal SMTP client (EHLO → optional STARTTLS → optional AUTH → MAIL/RCPT/
 * DATA) covers a remote 587 relay too.
 *
 * Every send writes an `email_outbox` row FIRST (status 'queued'), then flips
 * it to 'sent'/'failed' — so delivery state survives a crash and a failed send
 * is retriable. The recipient is stored only as a blind index; the address is
 * transient (POPIA). When MAIL_FROM is unset (dev) the message is captured to
 * the outbox and logged instead of sent, so nothing crashes without SMTP — the
 * exact discipline `job_relay_outbox` already uses.
 */

export interface EmailAttachment {
  /** Referenced from the HTML body as `cid:<cid>`; omit for downloadable files. */
  cid?: string;
  filename: string;
  contentType: string;
  buffer: Buffer;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: EmailAttachment[];
  /** Outbox label, e.g. 'starter_pack' | 'otp_resend'. */
  template: string;
  userId?: string | null;
}

export interface SendResult {
  outboxId: string;
  status: 'sent' | 'failed' | 'captured';
  error?: string;
}

const SMTP_TIMEOUT_MS = 15_000;
const CRLF = '\r\n';

// ── MIME assembly ──────────────────────────────────────────────────────────

function encodeHeader(value: string): string {
  // RFC-2047 encode only when non-ASCII is present; plain subjects pass through.
  // eslint-disable-next-line no-control-regex
  return /[^\x00-\x7F]/.test(value) ? `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=` : value;
}

function base64Wrapped(buf: Buffer): string {
  return buf.toString('base64').replace(/(.{76})/g, '$1' + CRLF);
}

/** Build the full RFC-5322 message (headers + body) for the email. */
export function buildMessage(msg: EmailMessage): string {
  const from = env.MAIL_FROM;
  const messageId = `<${randomUUID()}@${from.match(/@([^>]+)>?/)?.[1] ?? hostname()}>`;
  const date = new Date().toUTCString().replace('GMT', '+0000');
  const attachments = msg.attachments ?? [];

  const headers = [
    `From: ${from}`,
    `To: ${msg.to}`,
    `Subject: ${encodeHeader(msg.subject)}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
  ];

  const altBoundary = `alt_${randomUUID().replace(/-/g, '')}`;
  const alternative = [
    `--${altBoundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Wrapped(Buffer.from(msg.text, 'utf8')),
    `--${altBoundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Wrapped(Buffer.from(msg.html, 'utf8')),
    `--${altBoundary}--`,
  ].join(CRLF);

  const inline = attachments.filter((att) => att.cid);
  const files = attachments.filter((att) => !att.cid);
  const attachmentPart = (att: EmailAttachment): string => [
    `Content-Type: ${att.contentType}; name="${att.filename}"`,
    'Content-Transfer-Encoding: base64',
    ...(att.cid ? [`Content-ID: <${att.cid}>`] : []),
    `Content-Disposition: ${att.cid ? 'inline' : 'attachment'}; filename="${att.filename}"`,
    '',
    base64Wrapped(att.buffer),
  ].join(CRLF);

  let contentType = `multipart/alternative; boundary="${altBoundary}"`;
  let body = alternative;
  if (inline.length) {
    const relBoundary = `rel_${randomUUID().replace(/-/g, '')}`;
    body = [
      `--${relBoundary}`, `Content-Type: ${contentType}`, '', body,
      ...inline.flatMap((att) => [`--${relBoundary}`, attachmentPart(att)]),
      `--${relBoundary}--`,
    ].join(CRLF);
    contentType = `multipart/related; boundary="${relBoundary}"`;
  }
  if (files.length) {
    // Downloadable PDFs are siblings of the related body, not inline images.
    const mixedBoundary = `mixed_${randomUUID().replace(/-/g, '')}`;
    body = [
      `--${mixedBoundary}`, `Content-Type: ${contentType}`, '', body,
      ...files.flatMap((att) => [`--${mixedBoundary}`, attachmentPart(att)]),
      `--${mixedBoundary}--`,
    ].join(CRLF);
    contentType = `multipart/mixed; boundary="${mixedBoundary}"`;
  }
  headers.push(`Content-Type: ${contentType}`);
  return headers.join(CRLF) + CRLF + CRLF + body + CRLF;
}

/** Byte-stuff leading dots so a body line "." cannot end DATA early (RFC-5321). */
function dotStuff(message: string): string {
  return message.replace(/\r\n\./g, '\r\n..');
}

// ── Minimal SMTP client ────────────────────────────────────────────────────

interface SmtpReply {
  code: number;
  text: string;
}

/**
 * A line-oriented SMTP session. Replies (which may be multi-line: `NNN-…`
 * continuations then `NNN …`) are queued as they arrive, so a reply that lands
 * before its `expect()` is awaited is never lost.
 */
class SmtpSession {
  private buffer = '';
  private lines: string[] = [];
  private queue: SmtpReply[] = [];
  private waiters: ((r: SmtpReply) => void)[] = [];
  private socket: Socket | TLSSocket;
  private closed = false;

  constructor(socket: Socket | TLSSocket) {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('error', (err) => this.failAll(err));
    socket.on('close', () => {
      this.closed = true;
      this.failAll(new Error('SMTP connection closed unexpectedly'));
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const idx = this.buffer.indexOf(CRLF);
      if (idx === -1) break;
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this.lines.push(line);
      // A reply is complete at "NNN " (space) or a bare "NNN".
      if (/^\d{3}( |$)/.test(line)) {
        const reply = { code: parseInt(line.slice(0, 3), 10), text: this.lines.join(CRLF) };
        this.lines = [];
        const waiter = this.waiters.shift();
        if (waiter) waiter(reply);
        else this.queue.push(reply);
      }
    }
  }

  private failAll(err: Error): void {
    while (this.waiters.length) {
      const waiter = this.waiters.shift();
      // Waiters resolve, not reject; surface the error as a 0-code reply and let
      // the caller's code check reject. Simpler: throw via a synthetic reply.
      waiter?.({ code: 0, text: err.message });
    }
  }

  expect(timeoutMs = SMTP_TIMEOUT_MS): Promise<SmtpReply> {
    const queued = this.queue.shift();
    const base = queued ? Promise.resolve(queued) : new Promise<SmtpReply>((res) => this.waiters.push(res));
    return Promise.race([
      base,
      new Promise<SmtpReply>((_, rej) =>
        setTimeout(() => rej(new Error('SMTP timeout')), timeoutMs).unref?.(),
      ),
    ]);
  }

  async send(line: string): Promise<void> {
    await new Promise<void>((res, rej) => this.socket.write(line + CRLF, (e) => (e ? rej(e) : res())));
  }

  async command(line: string, expectCodes: number[]): Promise<SmtpReply> {
    await this.send(line);
    const reply = await this.expect();
    if (!expectCodes.includes(reply.code)) {
      throw new Error(`SMTP ${line.split(' ')[0]} failed: ${reply.code} ${reply.text}`);
    }
    return reply;
  }

  /** Upgrade the plaintext socket to TLS (STARTTLS) and keep the session alive. */
  upgradeToTls(servername: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const plain = this.socket as Socket;
      plain.removeAllListeners('data');
      const tls = tlsConnect({ socket: plain, servername, rejectUnauthorized: false }, () => {
        this.socket = tls;
        this.buffer = '';
        this.lines = [];
        tls.setEncoding('utf8');
        tls.on('data', (chunk: string) => this.onData(chunk));
        tls.on('error', (err) => this.failAll(err));
        resolve();
      });
      tls.on('error', reject);
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  end(): void {
    try {
      this.socket.end();
      this.socket.destroy();
    } catch {
      /* already gone */
    }
  }
}

async function openSession(): Promise<SmtpSession> {
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE } = env;
  const socket: Socket | TLSSocket = await new Promise((resolve, reject) => {
    const onReady = (s: Socket | TLSSocket) => resolve(s);
    if (SMTP_SECURE) {
      const s = tlsConnect({ host: SMTP_HOST, port: SMTP_PORT, rejectUnauthorized: false });
      s.once('secureConnect', () => onReady(s));
      s.once('error', reject);
    } else {
      const s = createConnection({ host: SMTP_HOST, port: SMTP_PORT });
      s.once('connect', () => onReady(s));
      s.once('error', reject);
    }
    setTimeout(() => reject(new Error('SMTP connect timeout')), SMTP_TIMEOUT_MS).unref?.();
  });
  return new SmtpSession(socket);
}

/** Deliver the assembled message over SMTP. Throws on any protocol failure. */
async function smtpDeliver(msg: EmailMessage, raw: string): Promise<void> {
  const session = await openSession();
  try {
    const greet = await session.expect();
    if (greet.code !== 220) throw new Error(`SMTP greeting failed: ${greet.code} ${greet.text}`);
    const local = hostname() || 'udf.local';

    const ehlo = await session.command(`EHLO ${local}`, [250]);
    const supportsStarttls = /STARTTLS/i.test(ehlo.text);
    if (env.SMTP_STARTTLS && supportsStarttls && !env.SMTP_SECURE) {
      await session.command('STARTTLS', [220]);
      await session.upgradeToTls(env.SMTP_HOST);
      await session.command(`EHLO ${local}`, [250]);
    }

    if (env.SMTP_USER && env.SMTP_PASS) {
      const token = Buffer.from(`\u0000${env.SMTP_USER}\u0000${env.SMTP_PASS}`, 'utf8').toString('base64');
      await session.command(`AUTH PLAIN ${token}`, [235]);
    }

    await session.command(`MAIL FROM:<${env.mailReturnPath}>`, [250]);
    await session.command(`RCPT TO:<${msg.to}>`, [250, 251]);
    await session.command('DATA', [354]);

    await session.send(dotStuff(raw).replace(/\r?\n$/, '') + CRLF + '.' + CRLF);
    const done = await session.expect();
    if (done.code !== 250) throw new Error(`SMTP DATA failed: ${done.code} ${done.text}`);

    await session.command('QUIT', [221]).catch(() => undefined);
  } finally {
    session.end();
  }
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Send an email, recording delivery state in `email_outbox`. Never throws: a
 * transport failure is captured as status 'failed' with the error, so a caller
 * (registration) is never blocked by mail — it can offer a resend (FR-P5).
 */
export async function sendEmail(msg: EmailMessage): Promise<SendResult> {
  const toBidx = blindIndex('email', msg.to);

  // Dev fallback: no sending identity configured ⇒ capture, do not send.
  if (!env.smtpConfigured) {
    const captured = await query<{ id: string }>(
      `INSERT INTO email_outbox (user_id, to_bidx, template, subject, status, attempts, sent_at)
       VALUES ($1,$2,$3,$4,'sent',0, now()) RETURNING id`,
      [msg.userId ?? null, toBidx, msg.template, msg.subject],
    );
    logger.info({ template: msg.template, to: msg.to }, '📧 mail captured (dev — SMTP/MAIL_FROM unset)');
    return { outboxId: captured.rows[0]!.id, status: 'captured' };
  }

  const outbox = await query<{ id: string }>(
    `INSERT INTO email_outbox (user_id, to_bidx, template, subject, status, attempts)
     VALUES ($1,$2,$3,$4,'queued',1) RETURNING id`,
    [msg.userId ?? null, toBidx, msg.template, msg.subject],
  );
  const outboxId = outbox.rows[0]!.id;

  try {
    const raw = buildMessage(msg);
    await smtpDeliver(msg, raw);
    await query(`UPDATE email_outbox SET status='sent', sent_at=now(), error=NULL WHERE id=$1`, [outboxId]);
    logger.info({ template: msg.template, outboxId }, '📧 mail sent');
    return { outboxId, status: 'sent' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await query(`UPDATE email_outbox SET status='failed', error=$2 WHERE id=$1`, [outboxId, message.slice(0, 500)]);
    logger.error({ template: msg.template, outboxId, err: message }, '📧 mail send failed');
    return { outboxId, status: 'failed', error: message };
  }
}
