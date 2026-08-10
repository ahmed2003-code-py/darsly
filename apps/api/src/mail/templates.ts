/**
 * Arabic (RTL) transactional email templates.
 *
 * Email clients strip <style> blocks and ignore modern CSS, so everything here
 * is a table layout with inline styles — the same reason the reference CRM ships
 * static HTML templates rather than rendering the app's components. Each builder
 * returns the subject alongside the body so a caller can't mismatch them.
 */

const BRAND = {
  primary: '#4A32C9',
  ink: '#1B1B22',
  muted: '#5C5C6B',
  background: '#F7F7F4',
  surface: '#FFFFFF',
  line: '#E4E4E0',
} as const;

export interface EmailContent {
  subject: string;
  html: string;
  /** Plain-text fallback — improves deliverability and reads fine in text-only clients. */
  text: string;
}

/** Escapes user-controlled values (names, academy titles) before they hit HTML. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface LayoutInput {
  title: string;
  /** Body rows, already HTML-safe. */
  body: string;
  brandName: string;
  footerNote?: string;
}

function layout({ title, body, brandName, footerNote }: LayoutInput): string {
  return `<!doctype html>
<html lang="ar" dir="rtl">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>${esc(title)}</title>
  </head>
  <body style="margin:0;padding:0;background:${BRAND.background};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.background};padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${BRAND.surface};border:1px solid ${BRAND.line};border-radius:16px;overflow:hidden;font-family:'Segoe UI',Tahoma,Arial,sans-serif;">
            <tr>
              <td style="background:${BRAND.primary};padding:20px 28px;color:#FFFFFF;font-size:20px;font-weight:700;text-align:right;">
                ${esc(brandName)}
              </td>
            </tr>
            <tr>
              <td style="padding:28px;text-align:right;color:${BRAND.ink};font-size:16px;line-height:1.9;direction:rtl;">
                ${body}
              </td>
            </tr>
            <tr>
              <td style="padding:18px 28px;border-top:1px solid ${BRAND.line};color:${BRAND.muted};font-size:12px;line-height:1.8;text-align:right;">
                ${footerNote ? `${esc(footerNote)}<br />` : ''}
                هذه رسالة آلية من ${esc(brandName)} — من فضلك لا ترد عليها.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function button(url: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
    <tr>
      <td style="background:${BRAND.primary};border-radius:10px;">
        <a href="${esc(url)}" style="display:inline-block;padding:12px 28px;color:#FFFFFF;text-decoration:none;font-size:16px;font-weight:600;">${esc(label)}</a>
      </td>
    </tr>
  </table>`;
}

/** The 4–6 digit code block used by OTP / verification mails. */
function codeBlock(code: string): string {
  return `<div style="margin:24px 0;padding:16px;background:${BRAND.background};border:1px dashed ${BRAND.line};border-radius:12px;text-align:center;">
    <span style="font-size:32px;font-weight:700;letter-spacing:8px;color:${BRAND.primary};direction:ltr;display:inline-block;">${esc(code)}</span>
  </div>`;
}

const DEFAULT_BRAND = 'درسلي';

// ── Templates ────────────────────────────────────────────────────────────────

export function welcomeStudentEmail(input: { name: string; loginUrl: string; brandName?: string }): EmailContent {
  const brandName = input.brandName ?? DEFAULT_BRAND;
  return {
    subject: `أهلاً بك في ${brandName} 🎓`,
    text: `أهلاً ${input.name}، تم إنشاء حسابك بنجاح. ابدأ من هنا: ${input.loginUrl}`,
    html: layout({
      brandName,
      title: `أهلاً بك في ${brandName}`,
      body: `<p style="margin:0 0 12px;">أهلاً <strong>${esc(input.name)}</strong> 👋</p>
        <p style="margin:0;">تم إنشاء حسابك بنجاح. تقدر دلوقتي تتصفح الدورات وتشترك في اللي يناسبك.</p>
        ${button(input.loginUrl, 'ابدأ التعلم')}
        <p style="margin:0;color:${BRAND.muted};font-size:14px;">لو مش إنت اللي سجّلت، تجاهل الرسالة دي.</p>`,
    }),
  };
}

export function teacherPendingEmail(input: { name: string; brandName?: string }): EmailContent {
  const brandName = input.brandName ?? DEFAULT_BRAND;
  return {
    subject: 'استلمنا طلب انضمامك كمعلّم',
    text: `أهلاً ${input.name}، استلمنا طلبك وحسابك تحت المراجعة. هنبعتلك رسالة تانية بعد الاعتماد.`,
    html: layout({
      brandName,
      title: 'طلب الانضمام قيد المراجعة',
      body: `<p style="margin:0 0 12px;">أهلاً <strong>${esc(input.name)}</strong> 👋</p>
        <p style="margin:0;">استلمنا طلب انضمامك كمعلّم على ${esc(brandName)}. الحساب دلوقتي <strong>تحت المراجعة</strong> من الإدارة.</p>
        <p style="margin:12px 0 0;">هنبعتلك رسالة تانية أول ما يتم اعتماد الحساب، وساعتها هتقدر تدخل وتبدأ تنشر دوراتك.</p>`,
    }),
  };
}

export function teacherApprovedEmail(input: { name: string; loginUrl: string; brandName?: string }): EmailContent {
  const brandName = input.brandName ?? DEFAULT_BRAND;
  return {
    subject: 'تم اعتماد حسابك كمعلّم 🎉',
    text: `تهانينا ${input.name}! تم اعتماد حسابك. ادخل من هنا: ${input.loginUrl}`,
    html: layout({
      brandName,
      title: 'تم اعتماد حسابك',
      body: `<p style="margin:0 0 12px;">تهانينا <strong>${esc(input.name)}</strong> 🎉</p>
        <p style="margin:0;">تم اعتماد حسابك كمعلّم. تقدر دلوقتي تدخل على لوحة التحكم وتبدأ ترفع دوراتك وتستقبل طلاب.</p>
        ${button(input.loginUrl, 'ادخل إلى لوحة التحكم')}`,
    }),
  };
}

export function teacherStatusChangedEmail(input: {
  name: string;
  status: 'REJECTED' | 'SUSPENDED';
  brandName?: string;
}): EmailContent {
  const brandName = input.brandName ?? DEFAULT_BRAND;
  const copy =
    input.status === 'REJECTED'
      ? { subject: 'بخصوص طلب انضمامك كمعلّم', line: 'للأسف لم يتم اعتماد حسابك كمعلّم في الوقت الحالي.' }
      : { subject: 'تم إيقاف حسابك مؤقتاً', line: 'تم إيقاف حسابك مؤقتاً. لو تعتقد إن فيه خطأ، تواصل مع الدعم.' };
  return {
    subject: copy.subject,
    text: `${input.name}: ${copy.line}`,
    html: layout({
      brandName,
      title: copy.subject,
      body: `<p style="margin:0 0 12px;">أهلاً <strong>${esc(input.name)}</strong>،</p>
        <p style="margin:0;">${esc(copy.line)}</p>`,
    }),
  };
}

export function resetPasswordEmail(input: {
  name: string;
  resetUrl: string;
  expiresInMinutes: number;
  brandName?: string;
}): EmailContent {
  const brandName = input.brandName ?? DEFAULT_BRAND;
  return {
    subject: 'إعادة تعيين كلمة المرور',
    text: `لإعادة تعيين كلمة المرور افتح الرابط خلال ${input.expiresInMinutes} دقيقة: ${input.resetUrl}`,
    html: layout({
      brandName,
      title: 'إعادة تعيين كلمة المرور',
      footerNote: 'لو ما طلبتش إعادة التعيين، مش محتاج تعمل أي حاجة — كلمة المرور هتفضل زي ما هي.',
      body: `<p style="margin:0 0 12px;">أهلاً <strong>${esc(input.name)}</strong>،</p>
        <p style="margin:0;">وصلنا طلب لإعادة تعيين كلمة المرور بتاعة حسابك. اضغط الزرار ده علشان تختار كلمة مرور جديدة:</p>
        ${button(input.resetUrl, 'تعيين كلمة مرور جديدة')}
        <p style="margin:0;color:${BRAND.muted};font-size:14px;">الرابط صالح لمدة ${input.expiresInMinutes} دقيقة ويُستخدم مرة واحدة فقط.</p>
        <p style="margin:12px 0 0;color:${BRAND.muted};font-size:12px;word-break:break-all;direction:ltr;text-align:left;">${esc(input.resetUrl)}</p>`,
    }),
  };
}

export function otpEmail(input: {
  name: string;
  code: string;
  expiresInMinutes: number;
  purpose?: string;
  brandName?: string;
}): EmailContent {
  const brandName = input.brandName ?? DEFAULT_BRAND;
  const purpose = input.purpose ?? 'إتمام العملية';
  return {
    subject: `كود التحقق: ${input.code}`,
    text: `كود التحقق الخاص بك هو ${input.code} وصالح لمدة ${input.expiresInMinutes} دقيقة.`,
    html: layout({
      brandName,
      title: 'كود التحقق',
      footerNote: 'لا تشارك هذا الكود مع أي شخص — فريق الدعم لن يطلبه منك أبداً.',
      body: `<p style="margin:0 0 12px;">أهلاً <strong>${esc(input.name)}</strong>،</p>
        <p style="margin:0;">استخدم الكود ده من أجل ${esc(purpose)}:</p>
        ${codeBlock(input.code)}
        <p style="margin:0;color:${BRAND.muted};font-size:14px;">الكود صالح لمدة ${input.expiresInMinutes} دقيقة.</p>`,
    }),
  };
}
