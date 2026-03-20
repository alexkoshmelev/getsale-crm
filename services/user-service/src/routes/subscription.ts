import { Router } from 'express';
import { Pool } from 'pg';
import Stripe from 'stripe';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes, requireUser, validate } from '@getsale/service-core';
import { UsSubscriptionUpgradeSchema, type UsSubscriptionUpgradeInput } from '../validation';

interface Deps {
  pool: Pool;
  log: Logger;
  stripe: Stripe;
}

export function subscriptionRouter({ pool, log, stripe }: Deps): Router {
  const router = Router();

  router.use(requireUser());

  router.get('/subscription', asyncHandler(async (req, res) => {
    const { id, organizationId } = req.user;

    const result = await pool.query(
      'SELECT * FROM subscriptions WHERE user_id = $1 AND organization_id = $2 ORDER BY created_at DESC LIMIT 1',
      [id, organizationId]
    );

    if (result.rows.length === 0) {
      return res.json({ plan: 'free', status: 'active' });
    }

    res.json(result.rows[0]);
  }));

  router.post('/subscription/upgrade', validate(UsSubscriptionUpgradeSchema), asyncHandler(async (req, res) => {
    const { id, organizationId } = req.user;
    const { plan } = req.body as UsSubscriptionUpgradeInput;

    let customerId: string;
    const subResult = await pool.query(
      'SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1 AND organization_id = $2 ORDER BY created_at DESC LIMIT 1',
      [id, organizationId]
    );

    if (subResult.rows.length > 0 && subResult.rows[0].stripe_customer_id) {
      customerId = subResult.rows[0].stripe_customer_id;
    } else {
      const userRow = await pool.query('SELECT email FROM users WHERE id = $1', [id]);
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
      expand: ['latest_invoice.payment_intent'],
    });

    await pool.query(
      `INSERT INTO subscriptions (user_id, organization_id, stripe_customer_id, stripe_subscription_id, plan, status, current_period_start, current_period_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        organizationId,
        customerId,
        subscription.id,
        plan,
        subscription.status,
        new Date(subscription.current_period_start * 1000),
        new Date(subscription.current_period_end * 1000),
      ]
    );

    const latestInvoice = subscription.latest_invoice as Stripe.Invoice | null;
    const paymentIntent = latestInvoice?.payment_intent as Stripe.PaymentIntent | undefined;
    const clientSecret = paymentIntent?.client_secret ?? undefined;

    log.info({
      message: 'Subscription upgraded',
      user_id: id,
      plan,
      subscription_id: subscription.id,
      correlation_id: req.correlationId,
    });

    res.json({
      subscriptionId: subscription.id,
      clientSecret,
    });
  }));

  return router;
}
