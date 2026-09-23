import { MailService } from './mail.service';
import { resetPasswordEmail, teacherAppliedAdminEmail } from './templates';

describe('MailService', () => {
  const envBackup = { ...process.env };
  let service: MailService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    service = new MailService();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    // Silence the intentional warn/error logging in these paths.
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = { ...envBackup };
    jest.restoreAllMocks();
  });

  const message = () => ({
    to: 'student@example.com',
    ...resetPasswordEmail({
      name: 'أحمد',
      resetUrl: 'https://app/reset?token=x',
      expiresInMinutes: 30,
    }),
  });

  it('does not call the provider when no API key is configured', async () => {
    delete process.env.RESEND_API_KEY;
    const result = await service.send(message());
    expect(result).toEqual({ delivered: false, reason: 'no-provider' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the message to Resend with the configured sender', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.MAIL_FROM = 'Darsly <noreply@darsly.app>';
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'msg_1' }) });

    const result = await service.send(message());

    expect(result).toEqual({ delivered: true, id: 'msg_1', transport: 'resend' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers.Authorization).toBe('Bearer re_test_key');
    const body = JSON.parse(init.body);
    expect(body.from).toBe('Darsly <noreply@darsly.app>');
    expect(body.to).toEqual(['student@example.com']);
    expect(body.html).toContain('https://app/reset?token=x');
    expect(body.text).toBeTruthy();
  });

  it('reports a provider rejection instead of throwing into the caller', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'domain not verified',
    });
    await expect(service.send(message())).resolves.toEqual({
      delivered: false,
      reason: 'provider-error',
    });
  });

  it('swallows a network failure — a mail outage must not fail the flow', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(service.send(message())).resolves.toEqual({
      delivered: false,
      reason: 'provider-error',
    });
  });

  it('builds web links without doubling slashes', () => {
    process.env.WEB_URL = 'https://darsly.app/';
    expect(service.webUrl('/reset-password?token=a')).toBe(
      'https://darsly.app/reset-password?token=a',
    );
    expect(service.webUrl()).toBe('https://darsly.app');
  });

  describe('capture transport (MAIL_TRANSPORT=capture) — deterministic outbox for tests, never in production', () => {
    const fs = require('fs') as typeof import('fs');
    const os = require('os') as typeof import('os');
    const path = require('path') as typeof import('path');
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darsly-mail-spec-'));
      process.env.MAIL_TRANSPORT = 'capture';
      process.env.MAIL_CAPTURE_DIR = dir;
      process.env.RESEND_API_KEY = 're_test_key';
      delete process.env.NODE_ENV;
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('writes the message to the outbox instead of calling the provider, and reports it as captured', async () => {
      const result = await service.send(message());
      expect(result).toMatchObject({ delivered: true, transport: 'capture' });
      expect(fetchMock).not.toHaveBeenCalled();
      const files = fs.readdirSync(dir);
      expect(files).toHaveLength(1);
      const saved = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
      expect(saved.to).toBe('student@example.com');
      expect(saved.text).toContain('https://app/reset?token=x'); // the link a test needs to read back
    });

    it('keeps the real recipient even when the temp redirect is also on', async () => {
      process.env.TEMP_CENTER_OWNER_EMAIL_REDIRECT_TO = 'tester@example.com';
      await service.send({ ...message(), to: 'owner@example.com', centerOwnerTestRedirect: true });
      const saved = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8'));
      expect(saved.realRecipient).toBe('owner@example.com');
      expect(saved.to).toBe('tester@example.com');
    });

    it('is REFUSED in production: NODE_ENV=production ignores MAIL_TRANSPORT and uses the real provider', async () => {
      process.env.NODE_ENV = 'production';
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'msg_prod' }) });
      const result = await service.send(message());
      expect(result).toMatchObject({ delivered: true, transport: 'resend' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fs.readdirSync(dir)).toHaveLength(0);
    });
  });

  describe('no-provider dev seam never logs a token in production', () => {
    it('outside production the body (with its link) is logged for local use', async () => {
      delete process.env.RESEND_API_KEY;
      delete process.env.MAIL_TRANSPORT;
      delete process.env.NODE_ENV;
      const warn = service['logger'].warn as jest.Mock;
      await service.send(message());
      expect(warn.mock.calls[0][0]).toContain('https://app/reset?token=x');
    });
    it('in production only the envelope is logged — the link/token never reaches the log', async () => {
      delete process.env.RESEND_API_KEY;
      delete process.env.MAIL_TRANSPORT;
      process.env.NODE_ENV = 'production';
      const warn = service['logger'].warn as jest.Mock;
      await service.send(message());
      expect(warn.mock.calls[0][0]).toContain('[MAIL:NOT-SENT]');
      expect(warn.mock.calls[0][0]).not.toContain('token=x');
    });
  });

  describe('TEMPORARY TEST ROUTING (centerOwnerTestRedirect)', () => {
    beforeEach(() => {
      process.env.RESEND_API_KEY = 're_test_key';
      process.env.TEMP_CENTER_OWNER_EMAIL_REDIRECT_TO = 'ahmedelsayed05113@gmail.com';
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'msg_1' }) });
    });

    it('delivers to the test address instead of the real recipient when the flag and env var are both set', async () => {
      const result = await service.send({ ...message(), centerOwnerTestRedirect: true });
      expect(result).toEqual({ delivered: true, id: 'msg_1', transport: 'resend' });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.to).toEqual(['ahmedelsayed05113@gmail.com']);
    });

    it('still carries the real recipient and message content — only delivery is redirected', async () => {
      await service.send({
        ...message(),
        to: 'real-center-owner@example.com',
        centerOwnerTestRedirect: true,
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // The real recipient appears in the subject and body, never silently dropped.
      expect(body.subject).toContain('real-center-owner@example.com');
      expect(body.html).toContain('real-center-owner@example.com');
      expect(body.text).toContain('real-center-owner@example.com');
      // The original message content is still present, not replaced.
      expect(body.html).toContain('https://app/reset?token=x');
    });

    it('is a no-op without the flag — an ordinary email is delivered to its real recipient, unaffected', async () => {
      await service.send(message()); // no centerOwnerTestRedirect
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.to).toEqual(['student@example.com']);
      expect(body.subject).not.toContain('TEST ROUTED');
    });

    it('is a no-op with the flag but no env var configured — falls back to the real recipient', async () => {
      delete process.env.TEMP_CENTER_OWNER_EMAIL_REDIRECT_TO;
      await service.send({ ...message(), centerOwnerTestRedirect: true });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.to).toEqual(['student@example.com']);
    });

    it("never mutates the caller's input object — the real `to` stays intact after send()", async () => {
      const input = { ...message(), centerOwnerTestRedirect: true };
      await service.send(input);
      expect(input.to).toBe('student@example.com');
    });
  });
});

describe('email templates', () => {
  it('escapes user-supplied names so a name cannot inject markup', () => {
    const { html } = resetPasswordEmail({
      name: '<img src=x onerror=alert(1)>',
      resetUrl: 'https://app/reset?token=x',
      expiresInMinutes: 30,
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('renders right-to-left Arabic documents', () => {
    const { html, subject } = resetPasswordEmail({
      name: 'سارة',
      resetUrl: 'https://app/reset?token=x',
      expiresInMinutes: 30,
    });
    expect(html).toContain('dir="rtl"');
    expect(subject).toBe('إعادة تعيين كلمة المرور');
  });

  it('tells the admin who applied, how to reach them, and where to approve', () => {
    const { html, text, subject } = teacherAppliedAdminEmail({
      name: 'عمرو فاروق',
      email: 'amr@example.com',
      phone: '+201001234567',
      subjects: ['رياضيات', 'فيزياء'],
      reviewUrl: 'https://app/admin/teachers',
    });
    expect(subject).toContain('عمرو فاروق');
    for (const piece of [
      'amr@example.com',
      '+201001234567',
      'رياضيات، فيزياء',
      'https://app/admin/teachers',
    ]) {
      expect(html).toContain(piece);
      expect(text).toContain(piece);
    }
  });
});
