import nodemailer, { Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import type { SmtpConfig } from '../../config/env';

/**
 * Outgoing email (Project_plan.md §15.2, §15.4): professor password-recovery codes and the emailed
 * sign-in details of new professor accounts (decision #102).
 * The transport is plain SMTP built from configuration, so switching provider (e.g. a Gmail app
 * password → the institute's SMTP server) only changes environment variables. Tests inject an
 * in-memory Mailer and never send real email.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Generic SMTP options; deliberately no provider presets such as `service: "gmail"`. */
export function smtpTransportOptions(config: SmtpConfig): SMTPTransport.Options {
  return {
    host: config.host,
    port: config.port,
    secure: config.secure,
    // Without implicit TLS, STARTTLS is mandatory: credentials and codes never travel in clear text.
    requireTLS: !config.secure,
    // Bounded waits: an unreachable server fails the delivery instead of holding a request open.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    ...(config.auth && { auth: { user: config.auth.user, pass: config.auth.pass } }),
  };
}

export function createSmtpMailer(config: SmtpConfig): Mailer {
  return createNodemailerMailer(nodemailer.createTransport(smtpTransportOptions(config)), config.from);
}

export function createNodemailerMailer(transport: Transporter, from: string): Mailer {
  return {
    async send(message) {
      await transport.sendMail({ from, to: message.to, subject: message.subject, text: message.text });
    },
  };
}

/** A non-secret description of a delivery failure (error codes only; server text may echo data). */
export function describeMailError(error: unknown): string {
  const { code, responseCode } = (error ?? {}) as { code?: unknown; responseCode?: unknown };
  const parts = [typeof code === 'string' ? code : null, typeof responseCode === 'number' ? `SMTP ${responseCode}` : null];
  return parts.filter(Boolean).join(', ') || 'unknown error';
}
