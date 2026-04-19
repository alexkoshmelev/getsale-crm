import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import Stripe from 'stripe';
import { AppError, ErrorCodes, requireUser, validate, type DatabasePools } from '@getsale/service-framework';
import { RabbitMQClient } from '@getsale/queue';
import { Logger } from '@getsale/logger';
import { invoiceClientSecret, subscriptionBillingPeriod } from '../stripe-utils';

type StripeClient = InstanceType<typeof Stripe>;

interface Deps {
  db: DatabasePools;
  rabbitmq: RabbitMQClient;
  log: Logger;
  stripe: StripeClient;
}

const SubscriptionUpgradeSchema = z.object({
  plan: z.string().min(1, 'plan is required').max(64).trim(),
  paymentMethodId: z.string().max(256).optional(),
});

type SubscriptionUpgradeInput = z.infer<typeof SubscriptionUpgradeSchema>;

export function registerSubscriptionRoutes(app: FastifyInstance, { db, log, stripe }: Deps): void {
  app.get('/api/users/subscription', { preHandler: [requireUser] }, async (request) => {
    const { id, organizationId } = request.user!;

    const result = await db.read.query(
      'SELECT * FROM subscriptions WHERE user_id = $1 AND organization_id = $2 ORDER BY created_at DESC LIMIT 1',
      [id, organizationId],
    );

    if (result.rows.length === 0) {
      return { plan: 'free', status: 'active' };
    }

    return result.rows[0];
  });

  app.post('/api/users/subscription/upgrade', {
    preHandler: [requireUser, validate(SubscriptionUpgradeSchema)],
  }, async (request) => {
    const { id, organizationId } = request.user!;
    const { plan } = request.body as SubscriptionUpgradeInput;

    let customerId: string;
    const subResult = await db.read.query(
      'SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1 AND organization_id = $2 ORDER BY created_at DESC LIMIT 1',
      [id, organizationId],
    );

    if (subResult.rows.length > 0 && subResult.rows[0].stripe_customer_id) {
      customerId = subResult.rows[0].stripe_customer_id;
    } else {
      const userRow = await db.read.query('SELECT email FROM users WHERE id = $1', [id]);
      if (userRow.rows.length === 0) {
        throw new AppError(404, 'User not found', ErrorCodes.NOT_FOUND);
      }
      const customer = await stripe.customers.create({
        email: userRow.rows[0].email,
        metadata: { userId: id, organizationId },
      });
      customerId = customer.id;
    }

    const priceId = process.env[`STRIPE_PRICE_${plan.toUpperCase()}`] || '';
    if (!priceId) {
      throw new AppError(400, `Stripe price not configured for plan: ${plan}`, ErrorCodes.BAD_REQUEST);
    }

    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      expand: ['latest_invoice.confirmation_secret'],
    });

    const period = subscriptionBillingPeriod(subscription);
    if (!period) {
      throw new AppError(502, 'Stripe subscription missing billing period', ErrorCodes.INTERNAL_ERROR);
    }

    await db.write.query(
      `INSERT INTO subscriptions (user_id, organization_id, stripe_customer_id, stripe_subscription_id, plan, status, current_period_start, current_period_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        organizationId,
        customerId,
        subscription.id,
        plan,
        subscription.status,
        period.start,
        period.end,
      ],
    );

    const clientSecret = invoiceClientSecret(subscription.latest_invoice);

    log.info({
      message: 'Subscription upgraded',
      user_id: id,
      plan,
      subscription_id: subscription.id,
      correlation_id: request.correlationId,
    });

    return { subscriptionId: subscription.id, clientSecret };
  });
}
