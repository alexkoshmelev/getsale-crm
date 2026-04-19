import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';
import Stripe from 'stripe';
import type { Event } from 'stripe/cjs/resources/Events.js';
import type { Invoice } from 'stripe/cjs/resources/Invoices.js';
import type { Subscription } from 'stripe/cjs/resources/Subscriptions.js';
import { EventType } from '@getsale/events';
import type { DatabasePools } from '@getsale/service-framework';
import { RabbitMQClient } from '@getsale/queue';
import { Logger } from '@getsale/logger';
import {
  extractSubscriptionId,
  stripeSubscriptionIdFromInvoice,
  subscriptionBillingPeriod,
} from '../stripe-utils';

type StripeClient = InstanceType<typeof Stripe>;

interface Deps {
  db: DatabasePools;
  rabbitmq: RabbitMQClient;
  log: Logger;
  stripe: StripeClient;
}

interface HandlerDeps {
  db: DatabasePools;
  log: Logger;
  rabbitmq: RabbitMQClient;
  correlationId?: string;
}

export function registerStripeWebhookRoutes(app: FastifyInstance, { db, rabbitmq, log, stripe }: Deps): void {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  // Register a raw body content-type parser scoped to the webhook route.
  // Stripe signature verification requires the raw request body as a Buffer.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req: FastifyRequest, body: Buffer, done: (err: Error | null, body?: unknown) => void) => {
      done(null, body);
    },
  );

  app.post('/api/users/stripe-webhook', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!webhookSecret) {
      log.error({ message: 'STRIPE_WEBHOOK_SECRET not configured' });
      return reply.code(500).send({ error: 'Webhook not configured' });
    }

    const signature = request.headers['stripe-signature'] as string;
    if (!signature) {
      log.warn({ message: 'Missing stripe-signature header', correlation_id: request.correlationId });
      return reply.code(400).send({ error: 'Missing signature' });
    }

    const rawBody = request.body as Buffer;
    if (!rawBody || !Buffer.isBuffer(rawBody)) {
      log.error({ message: 'Raw body not available for webhook verification', correlation_id: request.correlationId });
      return reply.code(500).send({ error: 'Raw body unavailable' });
    }

    let event: Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (err) {
      log.error({ message: 'Webhook signature verification failed', error: String(err), correlation_id: request.correlationId });
      return reply.code(400).send({ error: 'Invalid signature' });
    }

    log.info({
      message: 'Stripe webhook received',
      event_type: event.type,
      event_id: event.id,
      correlation_id: request.correlationId,
    });

    const deps: HandlerDeps = { db, log, rabbitmq, correlationId: request.correlationId };

    try {
      switch (event.type) {
        case 'invoice.payment_succeeded':
          await handlePaymentSucceeded(event.data.object as Invoice, deps);
          break;
        case 'invoice.payment_failed':
          await handlePaymentFailed(event.data.object as Invoice, deps);
          break;
        case 'customer.subscription.updated':
          await handleSubscriptionUpdated(event.data.object as Subscription, deps);
          break;
        case 'customer.subscription.deleted':
          await handleSubscriptionDeleted(event.data.object as Subscription, deps);
          break;
        default:
          log.info({ message: 'Unhandled webhook event type', event_type: event.type });
      }
    } catch (err) {
      log.error({ message: 'Error handling webhook event', event_type: event.type, event_id: event.id, error: String(err) });
      return reply.code(500).send({ error: 'Handler failed' });
    }

    return { received: true };
  });
}

async function handlePaymentSucceeded(invoice: Invoice, { db, log, rabbitmq, correlationId }: HandlerDeps) {
  const stripeSubId = stripeSubscriptionIdFromInvoice(invoice);
  if (!stripeSubId) return;

  const periodEnd = invoice.lines?.data?.[0]?.period?.end
    ? new Date(invoice.lines.data[0].period.end * 1000)
    : null;

  const result = await db.write.query(
    `UPDATE subscriptions
     SET status = 'active',
         current_period_end = COALESCE($1, current_period_end),
         updated_at = NOW()
     WHERE stripe_subscription_id = $2
     RETURNING id, user_id, organization_id, plan`,
    [periodEnd, stripeSubId],
  );

  if (result.rows.length === 0) {
    log.warn({ message: 'No subscription found for payment succeeded', stripe_subscription_id: stripeSubId });
    return;
  }

  const sub = result.rows[0];
  log.info({ message: 'Payment succeeded — subscription activated', subscription_id: sub.id, user_id: sub.user_id, plan: sub.plan });

  await rabbitmq.publishEvent({
    id: randomUUID(),
    type: EventType.SUBSCRIPTION_UPDATED,
    timestamp: new Date(),
    organizationId: sub.organization_id,
    userId: sub.user_id,
    correlationId,
    data: { subscriptionId: sub.id, status: 'active', plan: sub.plan, stripeSubscriptionId: stripeSubId },
  });
}

async function handlePaymentFailed(invoice: Invoice, { db, log, rabbitmq, correlationId }: HandlerDeps) {
  const stripeSubId = stripeSubscriptionIdFromInvoice(invoice);
  if (!stripeSubId) return;

  const result = await db.write.query(
    `UPDATE subscriptions
     SET status = 'past_due', updated_at = NOW()
     WHERE stripe_subscription_id = $1
     RETURNING id, user_id, organization_id, plan`,
    [stripeSubId],
  );

  if (result.rows.length === 0) {
    log.warn({ message: 'No subscription found for payment failed', stripe_subscription_id: stripeSubId });
    return;
  }

  const sub = result.rows[0];
  log.info({ message: 'Payment failed — subscription past due', subscription_id: sub.id, user_id: sub.user_id });

  await rabbitmq.publishEvent({
    id: randomUUID(),
    type: EventType.SUBSCRIPTION_UPDATED,
    timestamp: new Date(),
    organizationId: sub.organization_id,
    userId: sub.user_id,
    correlationId,
    data: { subscriptionId: sub.id, status: 'past_due', plan: sub.plan, stripeSubscriptionId: stripeSubId },
  });
}

async function handleSubscriptionUpdated(subscription: Subscription, { db, log, rabbitmq, correlationId }: HandlerDeps) {
  const period = subscriptionBillingPeriod(subscription);
  const result = await db.write.query(
    `UPDATE subscriptions
     SET status = $1,
         current_period_start = COALESCE($2, current_period_start),
         current_period_end = COALESCE($3, current_period_end),
         updated_at = NOW()
     WHERE stripe_subscription_id = $4
     RETURNING id, user_id, organization_id, plan`,
    [subscription.status, period?.start ?? null, period?.end ?? null, subscription.id],
  );

  if (result.rows.length === 0) {
    log.warn({ message: 'No subscription found for update', stripe_subscription_id: subscription.id });
    return;
  }

  const sub = result.rows[0];
  log.info({ message: 'Subscription updated', subscription_id: sub.id, subscription_status: subscription.status });

  await rabbitmq.publishEvent({
    id: randomUUID(),
    type: EventType.SUBSCRIPTION_UPDATED,
    timestamp: new Date(),
    organizationId: sub.organization_id,
    userId: sub.user_id,
    correlationId,
    data: { subscriptionId: sub.id, status: subscription.status, plan: sub.plan, stripeSubscriptionId: subscription.id },
  });
}

async function handleSubscriptionDeleted(subscription: Subscription, { db, log, rabbitmq, correlationId }: HandlerDeps) {
  const result = await db.write.query(
    `UPDATE subscriptions
     SET status = 'cancelled', updated_at = NOW()
     WHERE stripe_subscription_id = $1
     RETURNING id, user_id, organization_id, plan`,
    [subscription.id],
  );

  if (result.rows.length === 0) {
    log.warn({ message: 'No subscription found for deletion', stripe_subscription_id: subscription.id });
    return;
  }

  const sub = result.rows[0];
  log.info({ message: 'Subscription cancelled', subscription_id: sub.id, user_id: sub.user_id });

  await rabbitmq.publishEvent({
    id: randomUUID(),
    type: EventType.SUBSCRIPTION_CANCELLED,
    timestamp: new Date(),
    organizationId: sub.organization_id,
    userId: sub.user_id,
    correlationId,
    data: { subscriptionId: sub.id, cancelledAt: new Date() },
  });
}
