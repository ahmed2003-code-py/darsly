import { MailService } from './mail.service';
import { resetPasswordEmail } from './templates';

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
    ...resetPasswordEmail({ name: 'أحمد', resetUrl: 'https://app/reset?token=x', expiresInMinutes: 30 }),
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

    expect(result).toEqual({ delivered: true, id: 'msg_1' });
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
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => 'domain not verified' });
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
    expect(service.webUrl('/reset-password?token=a')).toBe('https://darsly.app/reset-password?token=a');
    expect(service.webUrl()).toBe('https://darsly.app');
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
});
