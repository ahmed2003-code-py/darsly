#!/usr/bin/env node
/**
 * Smoke-tests the Resend configuration end to end:
 *   node scripts/send-test-email.mjs you@example.com
 *
 * Reads RESEND_API_KEY / MAIL_FROM out of the root .env, sends the real
 * password-reset template, and prints the provider's verbatim answer — so a
 * rejected sender domain or an unverified recipient shows up here rather than
 * as a silent no-op inside a signup flow.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  const env = {};
  let raw = '';
  try {
    raw = readFileSync(join(root, '.env'), 'utf8');
  } catch {
    return env;
  }
  for (const line of raw.split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

const env = { ...loadEnv(), ...process.env };
const to = process.argv[2];

if (!to) {
  console.error('Usage: node scripts/send-test-email.mjs <recipient@example.com>');
  process.exit(1);
}
if (!env.RESEND_API_KEY) {
  console.error('RESEND_API_KEY is not set in .env — nothing to test.');
  process.exit(1);
}

const from = env.MAIL_FROM || 'Darsly <onboarding@resend.dev>';
console.log(`→ from: ${from}\n→ to:   ${to}`);

const response = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${env.RESEND_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    from,
    to: [to],
    subject: 'اختبار إرسال البريد من درسلي',
    text: 'لو وصلتك الرسالة دي، يبقى إعداد Resend شغال تمام.',
    html: `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;font-size:16px;line-height:1.9;text-align:right;">
      <p>لو وصلتك الرسالة دي، يبقى إعداد <strong>Resend</strong> شغال تمام ✅</p>
      <p style="color:#5C5C6B;font-size:14px;">رسالة اختبار من <code>scripts/send-test-email.mjs</code></p>
    </div>`,
  }),
});

const body = await response.text();
console.log(`\nHTTP ${response.status}\n${body}`);

if (!response.ok) {
  console.error(
    '\n✗ Resend rejected the send. Common causes:\n' +
      "  • MAIL_FROM's domain is not verified in Resend (only onboarding@resend.dev works before that)\n" +
      '  • With onboarding@resend.dev you may only send to the address that owns the Resend account\n' +
      '  • The API key was revoked or belongs to a different account',
  );
  process.exit(1);
}
console.log('\n✓ Accepted by Resend — check the inbox (and the spam folder).');
