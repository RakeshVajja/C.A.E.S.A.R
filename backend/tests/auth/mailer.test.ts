import nodemailer from 'nodemailer';
import { describe, expect, it, vi } from 'vitest';
import { composeRecoveryEmail } from '../../src/services/auth/passwordRecovery';
import { createNodemailerMailer, createSmtpMailer, describeMailError, smtpTransportOptions } from '../../src/services/email/mailer';

/* Generic SMTP configuration and email composition, without any network (Project_plan.md §15.4). */

describe('SMTP transport options', () => {
  it('are built from configuration only, with no provider preset, and require TLS', () => {
    const gmail = smtpTransportOptions({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: { user: 'someone@gmail.com', pass: 'app-password' },
      from: 'CSE Research Hub <someone@gmail.com>',
    });
    expect(gmail).toEqual({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: 'someone@gmail.com', pass: 'app-password' },
    });
    expect(gmail).not.toHaveProperty('service');

    // Switching provider is a configuration change only (e.g. an institute server on port 465).
    expect(smtpTransportOptions({ host: 'smtp.institute.example', port: 465, secure: true, auth: null, from: 'noreply@institute.example' })).toEqual({
      host: 'smtp.institute.example',
      port: 465,
      secure: true,
      requireTLS: false,
    });
  });

  it('creating the SMTP mailer does not connect or send anything', () => {
    const createTransport = vi.spyOn(nodemailer, 'createTransport');
    createSmtpMailer({ host: 'smtp.example.org', port: 587, secure: false, auth: null, from: 'a@example.org' });
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ host: 'smtp.example.org', port: 587 }));
    createTransport.mockRestore();
  });
});

describe('recovery email composition (no-network stream transport)', () => {
  it('produces a plain-text message from MAIL_FROM to the professor containing the code once', async () => {
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    const sendMail = vi.spyOn(transport, 'sendMail');
    const mailer = createNodemailerMailer(transport, 'CSE Research Hub <noreply@example.org>');

    await mailer.send({ to: 'prof@example.org', ...composeRecoveryEmail('042137') });
    const info = (await sendMail.mock.results[0].value) as { message: Buffer; envelope: { from: string; to: string[] } };
    const raw = info.message.toString('utf8');

    expect(info.envelope).toEqual({ from: 'noreply@example.org', to: ['prof@example.org'] });
    expect(raw).toMatch(/^From: CSE Research Hub <noreply@example.org>$/m);
    expect(raw).toMatch(/^To: prof@example.org$/m);
    expect(raw).toMatch(/^Subject: CSE Research Hub password recovery code$/m);
    expect(raw).toMatch(/^Content-Type: text\/plain/m);
    expect(raw.match(/042137/g)).toHaveLength(1);
    expect(raw).toContain('expires in 10 minutes');
  });
});

describe('describeMailError', () => {
  it('keeps only error codes, never the server text', () => {
    const error = Object.assign(new Error('535 auth failed for user secret@example.org with code 123456'), { code: 'EAUTH', responseCode: 535 });
    expect(describeMailError(error)).toBe('EAUTH, SMTP 535');
    expect(describeMailError(new Error('anything'))).toBe('unknown error');
    expect(describeMailError(null)).toBe('unknown error');
  });
});
