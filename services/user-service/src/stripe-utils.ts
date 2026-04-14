import type { Invoice } from 'stripe/cjs/resources/Invoices.js';
import type { Subscription } from 'stripe/cjs/resources/Subscriptions.js';

export function extractSubscriptionId(ref: string | Subscription | null | undefined): string | undefined {
  if (!ref) return undefined;
  return typeof ref === 'string' ? ref : ref.id;
}

export function stripeSubscriptionIdFromInvoice(invoice: Invoice): string | undefined {
  const parent = invoice.parent;
  if (!parent || parent.type !== 'subscription_details' || !parent.subscription_details) return undefined;
  return extractSubscriptionId(parent.subscription_details.subscription);
}

export function subscriptionBillingPeriod(sub: Subscription): { start: Date; end: Date } | null {
  const item = sub.items?.data?.[0];
  if (item == null || item.current_period_start == null || item.current_period_end == null) return null;
  return {
    start: new Date(item.current_period_start * 1000),
    end: new Date(item.current_period_end * 1000),
  };
}

export function invoiceClientSecret(invoice: string | Invoice | null | undefined): string | undefined {
  if (!invoice || typeof invoice === 'string') return undefined;
  return invoice.confirmation_secret?.client_secret;
}
