import Stripe from 'stripe';
import { createService } from '@getsale/service-framework';
import { registerProfileRoutes } from './routes/profiles';
import { registerSubscriptionRoutes } from './routes/subscription';
import { registerStripeWebhookRoutes } from './routes/stripe-webhook';

async function main() {
  const ctx = await createService({
    name: 'user-service',
    port: parseInt(process.env.PORT || '4009', 10),
  });

  const { app, db, rabbitmq, log } = ctx;

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
    apiVersion: '2025-02-24.acacia',
  });

  registerProfileRoutes(app, { db, log });
  registerSubscriptionRoutes(app, { db, rabbitmq, log, stripe });
  registerStripeWebhookRoutes(app, { db, rabbitmq, log, stripe });

  await ctx.start();
}

main().catch((err) => {
  console.error('user-service failed to start', err);
  process.exit(1);
});
