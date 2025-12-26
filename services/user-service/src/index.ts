import express from 'express';
import { Pool } from 'pg';
import Stripe from 'stripe';
import { RabbitMQClient } from '@getsale/utils';
import { EventType } from '@getsale/events';

const app = express();
const PORT = process.env.PORT || 3006;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || `postgresql://postgres:${process.env.POSTGRES_PASSWORD || 'postgres_dev'}@localhost:5432/postgres`,
});

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2024-06-20',
});

const rabbitmq = new RabbitMQClient(
  process.env.RABBITMQ_URL || 'amqp://getsale:getsale_dev@localhost:5672'
);

(async () => {
  try {
    await rabbitmq.connect();
  } catch (error) {
    console.error('Failed to connect to RabbitMQ, service will continue without event publishing:', error);
  }
})();

function getUser(req: express.Request) {
  const userId = req.headers['x-user-id'] as string;
  const organizationId = req.headers['x-organization-id'] as string;
  
  console.log(`[User Service] Headers - X-User-Id: ${userId}, X-Organization-Id: ${organizationId}`);
  console.log(`[User Service] All headers:`, JSON.stringify(req.headers, null, 2));
  
  if (!userId || !organizationId) {
    throw new Error('Missing user identification headers');
  }
  
  return {
    id: userId,
    organizationId: organizationId,
  };
}

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'user-service' });
});

// User Profile
app.get('/api/users/profile', async (req, res) => {
  try {
    const user = getUser(req);
    let result = await pool.query(
      'SELECT * FROM user_profiles WHERE user_id = $1',
      [user.id]
    );

    // If profile doesn't exist, create a default one
    if (result.rows.length === 0) {
      console.log(`Creating default profile for user ${user.id}`);
      const insertResult = await pool.query(
        `INSERT INTO user_profiles (user_id, organization_id, first_name, last_name, preferences)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [user.id, user.organizationId, null, null, JSON.stringify({})]
      );
      result = insertResult;
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/users/profile', async (req, res) => {
  try {
    const user = getUser(req);
    const { firstName, lastName, avatarUrl, timezone, preferences } = req.body;

    const result = await pool.query(
      `INSERT INTO user_profiles (user_id, organization_id, first_name, last_name, avatar_url, timezone, preferences)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id) 
       DO UPDATE SET 
         first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name,
         avatar_url = EXCLUDED.avatar_url,
         timezone = EXCLUDED.timezone,
         preferences = EXCLUDED.preferences,
         updated_at = NOW()
       RETURNING *`,
      [user.id, user.organizationId, firstName, lastName, avatarUrl, timezone, JSON.stringify(preferences || {})]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Subscription
app.get('/api/users/subscription', async (req, res) => {
  try {
    const user = getUser(req);
    const result = await pool.query(
      'SELECT * FROM subscriptions WHERE user_id = $1 AND organization_id = $2 ORDER BY created_at DESC LIMIT 1',
      [user.id, user.organizationId]
    );

    if (result.rows.length === 0) {
      return res.json({ plan: 'free', status: 'active' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching subscription:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/users/subscription/upgrade', async (req, res) => {
  try {
    const user = getUser(req);
    const { plan, paymentMethodId } = req.body;

    // Create or get Stripe customer
    let customerId: string;
    const subResult = await pool.query(
      'SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1 AND organization_id = $2 ORDER BY created_at DESC LIMIT 1',
      [user.id, user.organizationId]
    );

    if (subResult.rows.length > 0 && subResult.rows[0].stripe_customer_id) {
      customerId = subResult.rows[0].stripe_customer_id;
    } else {
      const customer = await stripe.customers.create({
        email: user.id, // TODO: Get email from auth service
        metadata: { userId: user.id, organizationId: user.organizationId },
      });
      customerId = customer.id;
    }

    // Create subscription
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: process.env[`STRIPE_PRICE_${plan.toUpperCase()}`] || '' }],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      expand: ['latest_invoice.payment_intent'],
    });

    // Save subscription
    await pool.query(
      `INSERT INTO subscriptions (user_id, organization_id, stripe_customer_id, stripe_subscription_id, plan, status, current_period_start, current_period_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        user.id,
        user.organizationId,
        customerId,
        subscription.id,
        plan,
        subscription.status,
        new Date(subscription.current_period_start * 1000),
        new Date(subscription.current_period_end * 1000),
      ]
    );

    res.json({
      subscriptionId: subscription.id,
      clientSecret: (subscription.latest_invoice as any)?.payment_intent?.client_secret,
    });
  } catch (error) {
    console.error('Error upgrading subscription:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Teams
app.get('/api/users/team/members', async (req, res) => {
  try {
    const user = getUser(req);
    const result = await pool.query(
      `SELECT tm.*, up.first_name, up.last_name, up.avatar_url
       FROM team_members tm
       JOIN teams t ON tm.team_id = t.id
       LEFT JOIN user_profiles up ON tm.user_id = up.user_id
       WHERE t.organization_id = $1`,
      [user.organizationId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching team members:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/users/team/invite', async (req, res) => {
  try {
    const user = getUser(req);
    const { email, role, teamId } = req.body;

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await pool.query(
      `INSERT INTO team_invitations (team_id, email, role, invited_by, token, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [teamId, email, role || 'member', user.id, token, expiresAt]
    );

    // TODO: Send invitation email

    res.json({ token, expiresAt });
  } catch (error) {
    console.error('Error inviting team member:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`User service running on port ${PORT}`);
});

