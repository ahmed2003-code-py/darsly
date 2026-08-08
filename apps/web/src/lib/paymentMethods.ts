import i18n from '../i18n';

/**
 * One place that knows how to name a payment method.
 *
 * Three screens each carried their own hardcoded Arabic map, so an English UI
 * showed "فودافون كاش" in the middle of otherwise English text — and adding a
 * provider meant remembering all three.
 */
export const PAYMENT_METHODS = ['INSTAPAY', 'VODAFONE_CASH', 'BANK_TRANSFER', 'OTHER'] as const;

export type PaymentMethodKey = (typeof PAYMENT_METHODS)[number];

/**
 * Resolved through the i18n instance rather than the `useTranslation` hook, so it
 * works in the plain helpers and option lists that are not React components.
 * Falls back to the raw code for a method the UI does not know yet.
 */
export function paymentMethodLabel(method: string): string {
  const key = `method.${method}`;
  const label = i18n.t(key);
  return label === key ? method : label;
}
