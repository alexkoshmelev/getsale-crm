import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { RabbitMQClient } from '@getsale/utils';
import { EventType, UserCreatedEvent } from '@getsale/events';
import { UserRole } from '@getsale/types';

const app = express();
const PORT = process.env.PORT || 3001;

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'dev_refresh_secret';
const JWT_EXPIRES_IN = '15m';
const REFRESH_EXPIRES_IN = '7d';

// Database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || `postgresql://postgres:${process.env.POSTGRES_PASSWORD || 'postgres_dev'}@localhost:5432/postgres`,
});

// Test database connection on startup
pool.query('SELECT NOW()')
  .then(() => {
    console.log('✅ Database connection successful');
  })
  .catch((error) => {
    console.error('❌ Database connection failed:', error.message);
  });

// RabbitMQ
const rabbitmq = new RabbitMQClient(
  process.env.RABBITMQ_URL || 'amqp://getsale:getsale_dev@localhost:5672'
);

// Initialize
(async () => {
  try {
    await rabbitmq.connect();
  } catch (error) {
    console.error('Failed to connect to RabbitMQ, service will continue without event publishing:', error);
  }
})();

// CORS configuration
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Body parser with increased limits and timeout handling
app.use(express.json({ 
  limit: '10mb',
  strict: false 
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'auth-service' });
});

// Sign up
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, organizationName } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    // Create organization
    const orgResult = await pool.query(
      'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING *',
      [organizationName || 'My Organization', email.split('@')[0]]
    );
    const organization = orgResult.rows[0];

    // Create user
    const passwordHash = await bcrypt.hash(password, 10);
    const userResult = await pool.query(
      'INSERT INTO users (email, password_hash, organization_id, role) VALUES ($1, $2, $3, $4) RETURNING *',
      [email, passwordHash, organization.id, UserRole.OWNER]
    );
    const user = userResult.rows[0];

    // Create default pipeline
    const pipelineResult = await pool.query(
      'INSERT INTO pipelines (organization_id, name, description, is_default) VALUES ($1, $2, $3, $4) RETURNING *',
      [organization.id, 'Default Pipeline', 'Default sales pipeline', true]
    );
    const pipeline = pipelineResult.rows[0];

    // Create default stages
    const stages = [
      { name: 'Lead', order: 1, color: '#3B82F6' },
      { name: 'Qualified', order: 2, color: '#10B981' },
      { name: 'Proposal', order: 3, color: '#F59E0B' },
      { name: 'Negotiation', order: 4, color: '#EF4444' },
      { name: 'Closed Won', order: 5, color: '#8B5CF6' },
      { name: 'Closed Lost', order: 6, color: '#6B7280' },
    ];

    for (const stage of stages) {
      await pool.query(
        'INSERT INTO stages (pipeline_id, organization_id, name, order_index, color) VALUES ($1, $2, $3, $4, $5)',
        [pipeline.id, organization.id, stage.name, stage.order, stage.color]
      );
    }

    console.log(`✅ Created default pipeline with ${stages.length} stages for organization ${organization.id}`);

    // Create default team with organization name
    const teamResult = await pool.query(
      'INSERT INTO teams (organization_id, name, created_by) VALUES ($1, $2, $3) RETURNING *',
      [organization.id, organization.name, user.id]
    );
    const team = teamResult.rows[0];

    // Add user to the team as owner
    await pool.query(
      'INSERT INTO team_members (team_id, user_id, role, invited_by) VALUES ($1, $2, $3, $4)',
      [team.id, user.id, 'admin', user.id]
    );

    console.log(`✅ Created default team "${team.name}" and added user to team`);

    // Publish event
    const event: UserCreatedEvent = {
      id: randomUUID(),
      type: EventType.USER_CREATED,
      timestamp: new Date(),
      organizationId: organization.id,
      userId: user.id,
      data: {
        userId: user.id,
        email: user.email,
        organizationId: organization.id,
      },
    };
    await rabbitmq.publishEvent(event);

    // Generate tokens
    const accessToken = jwt.sign(
      { userId: user.id, organizationId: organization.id, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    const refreshToken = jwt.sign(
      { userId: user.id },
      JWT_REFRESH_SECRET,
      { expiresIn: REFRESH_EXPIRES_IN }
    );

    await pool.query(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.id, refreshToken, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)]
    );

    res.json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        organizationId: organization.id,
        role: user.role,
      },
    });
  } catch (error: any) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Email already exists' });
    }
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Sign in
app.post('/api/auth/signin', async (req, res) => {
  console.log(`📥 POST /api/auth/signin received`);
  
  // Handle request abort
  req.on('aborted', () => {
    console.log(`⚠️ Request aborted by client`);
    return;
  });
  
  req.on('error', (err) => {
    console.error(`❌ Request error:`, err);
    if (!res.headersSent) {
      res.status(400).json({ error: 'Request error' });
    }
    return;
  });
  
  // Add error handler for response
  res.on('finish', () => {
    console.log(`📤 Response finished with status: ${res.statusCode}`);
  });
  
  res.on('error', (err) => {
    console.error(`❌ Response error:`, err);
  });
  
  res.on('close', () => {
    if (!res.headersSent) {
      console.log(`⚠️ Response closed before headers sent`);
    }
  });
  
  console.log(`📥 Request body:`, JSON.stringify({ email: req.body?.email, hasPassword: !!req.body?.password }));
  console.log(`📥 Request headers:`, JSON.stringify(req.headers, null, 2));
  
  try {
    const { email, password, mfaCode } = req.body;

    console.log(`🔐 Login attempt for email: ${email}`);

    if (!email || !password) {
      console.log('❌ Missing email or password');
      return res.status(400).json({ error: 'Email and password required' });
    }

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    console.log(`📊 Found ${result.rows.length} user(s) with email ${email}`);
    
    if (result.rows.length === 0) {
      console.log(`❌ User not found: ${email}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    console.log(`✅ User found: ${user.email}, checking password...`);
    
    const valid = await bcrypt.compare(password, user.password_hash);
    console.log(`🔑 Password valid: ${valid}`);
    
    if (!valid) {
      console.log(`❌ Invalid password for user: ${email}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // MFA check if enabled
    if (user.mfa_enabled && mfaCode) {
      // TODO: Verify MFA code with speakeasy
    }

    const accessToken = jwt.sign(
      { userId: user.id, organizationId: user.organization_id, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    const refreshToken = jwt.sign(
      { userId: user.id },
      JWT_REFRESH_SECRET,
      { expiresIn: REFRESH_EXPIRES_IN }
    );

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    console.log(`💾 Saving refresh token for user ${user.id}, expires at ${expiresAt.toISOString()}`);
    
    try {
      const insertResult = await pool.query(
        'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3) RETURNING *',
        [user.id, refreshToken, expiresAt]
      );
      console.log(`✅ Refresh token saved successfully: id=${insertResult.rows[0].id}`);
    } catch (error: any) {
      console.error(`❌ Error saving refresh token:`, error.message || error);
      // If it's a unique constraint violation, try to update existing token
      if (error.code === '23505') {
        console.log(`⚠️  Refresh token already exists, updating...`);
        await pool.query(
          'UPDATE refresh_tokens SET expires_at = $1 WHERE token = $2',
          [expiresAt, refreshToken]
        );
        console.log(`✅ Refresh token updated`);
      } else {
        throw error;
      }
    }

    console.log(`✅ Login successful for user: ${user.email}`);

    const responseData = {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        organizationId: user.organization_id,
        role: user.role,
      },
    };
    
    console.log(`📤 Sending response with accessToken length: ${accessToken.length}`);
    res.json(responseData);
    console.log(`✅ Response sent successfully`);
  } catch (error: any) {
    console.error('❌ Signin error:', error.message || error);
    console.error('Stack:', error.stack);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Verify token
app.post('/api/auth/verify', async (req, res) => {
  try {
    const { token } = req.body;
    
    if (!token) {
      console.log('❌ No token provided for verification');
      return res.status(400).json({ error: 'Token required' });
    }

    console.log(`🔐 Verifying token...`);
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    console.log(`✅ Token decoded, userId: ${decoded.userId}`);

    const result = await pool.query('SELECT id, email, organization_id, role FROM users WHERE id = $1', [
      decoded.userId,
    ]);

    if (result.rows.length === 0) {
      console.log(`❌ User not found: ${decoded.userId}`);
      return res.status(401).json({ error: 'User not found' });
    }

    console.log(`✅ Token verified for user: ${result.rows[0].email}`);
    res.json(result.rows[0]);
  } catch (error: any) {
    console.error('❌ Token verification error:', error.message || error);
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token format' });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    res.status(401).json({ error: 'Invalid token' });
  }
});

// Rate limiting for refresh endpoint to prevent spam
const refreshAttempts = new Map<string, { count: number; resetAt: number }>();
const REFRESH_RATE_LIMIT = 5; // Max 5 attempts
const REFRESH_RATE_WINDOW = 60000; // Per minute

// Refresh token
app.post('/api/auth/refresh', async (req, res) => {
  const clientId = req.ip || 'unknown';
  const now = Date.now();
  
  // Check rate limit
  const attempt = refreshAttempts.get(clientId);
  if (attempt && attempt.resetAt > now) {
    if (attempt.count >= REFRESH_RATE_LIMIT) {
      return res.status(429).json({ error: 'Too many refresh attempts. Please try again later.' });
    }
    attempt.count++;
  } else {
    refreshAttempts.set(clientId, { count: 1, resetAt: now + REFRESH_RATE_WINDOW });
  }
  
  try {
    const { refreshToken } = req.body;
    
    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token required' });
    }

    // Verify token first (this will throw if expired or invalid)
    let decoded: any;
    try {
      decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET) as any;
    } catch (jwtError: any) {
      // Token is expired or invalid - return 401 without excessive logging
      // Only log first few attempts to avoid log spam
      const attempt = refreshAttempts.get(clientId);
      if (attempt && attempt.count <= 2) {
        console.log(`⚠️  Invalid/expired refresh token attempt from ${clientId}`);
      }
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    // Check if token exists in database
    const tokenCheck = await pool.query(
      'SELECT * FROM refresh_tokens WHERE token = $1',
      [refreshToken]
    );

    if (tokenCheck.rows.length === 0) {
      // Token not in database - return 401 without logging
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    // Check if token is expired
    const token = tokenCheck.rows[0];
    if (new Date(token.expires_at) <= new Date()) {
      // Token expired - return 401 without logging to avoid spam
      return res.status(401).json({ error: 'Refresh token expired' });
    }

    // Token is valid - proceed with refresh
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [decoded.userId]);
    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];
    const accessToken = jwt.sign(
      { userId: user.id, organizationId: user.organization_id, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    // Reset rate limit on successful refresh
    refreshAttempts.delete(clientId);
    
    // Only log successful refreshes
    console.log(`✅ Refresh token successful for user: ${user.email}`);
    res.json({ accessToken });
  } catch (error: any) {
    // Only log unexpected errors, not token validation errors
    if (error.name !== 'JsonWebTokenError' && error.name !== 'TokenExpiredError') {
      console.error('❌ Unexpected refresh token error:', error.message || error);
    }
    return res.status(401).json({ error: 'Invalid refresh token' });
  }
});

app.listen(PORT, () => {
  console.log(`Auth service running on port ${PORT}`);
});

