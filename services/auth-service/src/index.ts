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
    const { email, password, organizationName, inviteToken } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    let organization: { id: string; name: string };
    let user: { id: string; email: string; organization_id: string; role: string };

    if (inviteToken) {
      // Signup via invite link: join existing organization
      const inv = await pool.query(
        'SELECT organization_id, role, expires_at FROM organization_invite_links WHERE token = $1',
        [inviteToken]
      );
      if (inv.rows.length === 0) {
        return res.status(404).json({ error: 'Invite not found' });
      }
      const { organization_id: orgId, role: inviteRole, expires_at: expiresAt } = inv.rows[0];
      if (new Date(expiresAt) <= new Date()) {
        return res.status(410).json({ error: 'Invite expired' });
      }
      const orgRow = await pool.query('SELECT id, name FROM organizations WHERE id = $1', [orgId]);
      if (orgRow.rows.length === 0) {
        return res.status(404).json({ error: 'Organization not found' });
      }
      organization = orgRow.rows[0];
      const passwordHash = await bcrypt.hash(password, 10);
      const userResult = await pool.query(
        'INSERT INTO users (email, password_hash, organization_id, role) VALUES ($1, $2, $3, $4) RETURNING *',
        [email, passwordHash, organization.id, inviteRole]
      );
      user = userResult.rows[0];
      await pool.query(
        'INSERT INTO organization_members (user_id, organization_id, role) VALUES ($1, $2, $3)',
        [user.id, organization.id, inviteRole]
      );
    } else {
      // Create new organization and user; slug из префикса email, уникальность обязательна
      const rawSlug = (email.split('@')[0] || 'org').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'workspace';
      let slug = rawSlug;
      for (let attempt = 0; attempt < 10; attempt++) {
        const existing = await pool.query('SELECT id FROM organizations WHERE slug = $1', [slug]);
        if (existing.rows.length === 0) break;
        slug = `${rawSlug}-${Math.random().toString(36).slice(2, 6)}`;
      }
      const orgResult = await pool.query(
        'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING *',
        [organizationName || 'My Organization', slug]
      );
      organization = orgResult.rows[0];

      const passwordHash = await bcrypt.hash(password, 10);
      const userResult = await pool.query(
        'INSERT INTO users (email, password_hash, organization_id, role) VALUES ($1, $2, $3, $4) RETURNING *',
        [email, passwordHash, organization.id, UserRole.OWNER]
      );
      user = userResult.rows[0];

      // Create default pipeline
      const pipelineResult = await pool.query(
        'INSERT INTO pipelines (organization_id, name, description, is_default) VALUES ($1, $2, $3, $4) RETURNING *',
        [organization.id, 'Default Pipeline', 'Default sales pipeline', true]
      );
      const pipeline = pipelineResult.rows[0];

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

      const teamResult = await pool.query(
        'INSERT INTO teams (organization_id, name, created_by) VALUES ($1, $2, $3) RETURNING *',
        [organization.id, organization.name, user.id]
      );
      const team = teamResult.rows[0];

      await pool.query(
        'INSERT INTO team_members (team_id, user_id, role, invited_by) VALUES ($1, $2, $3, $4)',
        [team.id, user.id, 'admin', user.id]
      );

      await pool.query(
        'INSERT INTO organization_members (user_id, organization_id, role) VALUES ($1, $2, $3)',
        [user.id, organization.id, user.role]
      );
    }

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

    const user = result.rows[0];
    // Return current workspace from JWT (switch-workspace), not primary org from DB — so /api/team etc. see the right org
    const organizationId = decoded.organizationId ?? user.organization_id;
    const role = decoded.role ?? user.role;
    console.log(`✅ Token verified for user: ${user.email}, organizationId: ${organizationId}`);
    res.json({
      id: user.id,
      email: user.email,
      organization_id: organizationId,
      organizationId,
      role,
    });
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

function getClientIp(req: express.Request): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0]?.trim() || null;
  return (req as any).ip || req.socket?.remoteAddress || null;
}

/** Проверка гранулярного права (role_permissions). При отсутствии таблицы — fallback: owner всё, admin всё кроме transfer. */
async function canPermission(pool: Pool, role: string, resource: string, action: string): Promise<boolean> {
  const roleLower = (role || '').toLowerCase();
  try {
    const r = await pool.query(
      `SELECT 1 FROM role_permissions WHERE role = $1 AND resource = $2 AND (action = $3 OR action = '*') LIMIT 1`,
      [roleLower, resource, action]
    );
    if (r.rows.length > 0) return true;
    // owner всегда всё (на случай если в таблице нет wildcard)
    if (roleLower === 'owner') return true;
    return false;
  } catch {
    // Fallback при отсутствии таблицы: owner и admin — полный доступ к audit/workspace read+update
    if (roleLower === 'owner') return true;
    if (roleLower === 'admin') return action !== 'transfer_ownership';
    return false;
  }
}

async function auditLog(
  pool: typeof import('pg').Pool.prototype,
  organizationId: string,
  userId: string,
  action: string,
  resourceType?: string,
  resourceId?: string,
  oldValue?: object,
  newValue?: object,
  ip?: string | null
) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (organization_id, user_id, action, resource_type, resource_id, old_value, new_value, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        organizationId,
        userId,
        action,
        resourceType ?? null,
        resourceId ?? null,
        oldValue ? JSON.stringify(oldValue) : null,
        newValue ? JSON.stringify(newValue) : null,
        ip ?? null,
      ]
    );
  } catch (e) {
    console.error('Audit log insert failed:', e);
  }
}

// --- Current organization (настройки воркспейса) ---
// GET /api/auth/organization — текущая организация по JWT
app.get('/api/auth/organization', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string; organizationId: string };
    const rows = await pool.query(
      'SELECT id, name, slug FROM organizations WHERE id = $1',
      [decoded.organizationId]
    );
    if (rows.rows.length === 0) return res.status(404).json({ error: 'Organization not found' });
    res.json(rows.rows[0]);
  } catch (e: any) {
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    console.error('Error fetching organization:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/auth/organization — обновить название и slug (только owner или admin организации)
app.patch('/api/auth/organization', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string; organizationId: string; role?: string };
    let role = decoded.role;
    if (!role) {
      const memberRow = await pool.query(
        'SELECT role FROM organization_members WHERE user_id = $1 AND organization_id = $2',
        [decoded.userId, decoded.organizationId]
      );
      role = memberRow.rows[0]?.role ?? '';
    }
    const canUpdate = await canPermission(pool, role, 'workspace', 'update');
    if (!canUpdate) {
      return res.status(403).json({ error: 'Only owner or admin can update workspace settings' });
    }
    const { name, slug } = req.body;
    const updates: string[] = [];
    const values: any[] = [];
    let i = 1;
    if (name !== undefined && typeof name === 'string' && name.trim()) {
      updates.push(`name = $${i++}`);
      values.push(name.trim());
    }
    if (slug !== undefined && typeof slug === 'string' && slug.trim()) {
      const slugNormalized = slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
      const existing = await pool.query(
        'SELECT id FROM organizations WHERE slug = $1 AND id != $2',
        [slugNormalized, decoded.organizationId]
      );
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'This URL slug is already taken' });
      }
      updates.push(`slug = $${i++}`);
      values.push(slugNormalized);
    }
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }
    const oldRow = await pool.query('SELECT id, name, slug FROM organizations WHERE id = $1', [decoded.organizationId]);
    const oldValue = oldRow.rows[0] ? { name: oldRow.rows[0].name, slug: oldRow.rows[0].slug } : undefined;
    values.push(decoded.organizationId);
    await pool.query(
      `UPDATE organizations SET ${updates.join(', ')} WHERE id = $${i}`,
      values
    );
    const rows = await pool.query('SELECT id, name, slug FROM organizations WHERE id = $1', [decoded.organizationId]);
    const newValue = rows.rows[0] ? { name: rows.rows[0].name, slug: rows.rows[0].slug } : undefined;
    await auditLog(pool, decoded.organizationId, decoded.userId, 'organization.updated', 'organization', decoded.organizationId, oldValue, newValue, getClientIp(req));
    res.json(rows.rows[0]);
  } catch (e: any) {
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    console.error('Error updating organization:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/organization/transfer-ownership — передача владения воркспейсом (только текущий owner)
app.post('/api/auth/organization/transfer-ownership', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string; organizationId: string; role?: string };
    const orgId = decoded.organizationId;
    const currentUserId = decoded.userId;
    let role = decoded.role;
    if (!role) {
      const m = await pool.query(
        'SELECT role FROM organization_members WHERE user_id = $1 AND organization_id = $2',
        [currentUserId, orgId]
      );
      role = m.rows[0]?.role ?? '';
    }
    if ((role || '').toLowerCase() !== 'owner') {
      return res.status(403).json({ error: 'Only the current owner can transfer ownership' });
    }
    const { newOwnerUserId } = req.body;
    if (!newOwnerUserId || typeof newOwnerUserId !== 'string') {
      return res.status(400).json({ error: 'newOwnerUserId is required' });
    }
    const target = await pool.query(
      'SELECT 1 FROM organization_members WHERE user_id = $1 AND organization_id = $2',
      [newOwnerUserId.trim(), orgId]
    );
    if (target.rows.length === 0) {
      return res.status(404).json({ error: 'User is not a member of this organization' });
    }
    if (newOwnerUserId.trim() === currentUserId) {
      return res.status(400).json({ error: 'Cannot transfer to yourself' });
    }
    await pool.query(
      'UPDATE organization_members SET role = $1 WHERE user_id = $2 AND organization_id = $3',
      ['admin', currentUserId, orgId]
    );
    await pool.query(
      'UPDATE organization_members SET role = $1 WHERE user_id = $2 AND organization_id = $3',
      ['owner', newOwnerUserId.trim(), orgId]
    );
    // Синхронизировать users.role для primary org (если у пользователя organization_id = эта организация)
    await pool.query(
      'UPDATE users SET role = $1 WHERE id = $2 AND organization_id = $3',
      ['admin', currentUserId, orgId]
    );
    await pool.query(
      'UPDATE users SET role = $1 WHERE id = $2 AND organization_id = $3',
      ['owner', newOwnerUserId.trim(), orgId]
    );
    await auditLog(pool, orgId, currentUserId, 'organization.ownership_transferred', 'organization', orgId, undefined, { newOwnerUserId: newOwnerUserId.trim() }, getClientIp(req));
    res.json({ success: true });
  } catch (e: any) {
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    console.error('Error transferring ownership:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/audit-logs — лог действий по организации (по гранулярному праву audit.read или owner/admin)
app.get('/api/auth/audit-logs', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string; organizationId: string; role?: string };
    let role = decoded.role;
    if (!role) {
      const memberRow = await pool.query(
        'SELECT role FROM organization_members WHERE user_id = $1 AND organization_id = $2',
        [decoded.userId, decoded.organizationId]
      );
      role = memberRow.rows[0]?.role ?? '';
    }
    const allowed = await canPermission(pool, role, 'audit', 'read');
    if (!allowed) {
      return res.status(403).json({ error: 'Only owner or admin can view audit logs' });
    }
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 100, 500);
    const rows = await pool.query(
      `SELECT id, user_id, action, resource_type, resource_id, old_value, new_value, ip, created_at
       FROM audit_logs
       WHERE organization_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [decoded.organizationId, limit]
    );
    res.json(rows.rows);
  } catch (e: any) {
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    console.error('Error fetching audit logs:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Workspaces (переключатель) ---
// GET /api/auth/workspaces — список организаций пользователя (из organization_members)
app.get('/api/auth/workspaces', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
    const rows = await pool.query(
      `SELECT om.organization_id AS id, o.name
       FROM organization_members om
       JOIN organizations o ON o.id = om.organization_id
       WHERE om.user_id = $1
       ORDER BY o.name`,
      [decoded.userId]
    );
    res.json(rows.rows);
  } catch (e: any) {
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    console.error('Error fetching workspaces:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/switch-workspace — смена активной организации, новый JWT
app.post('/api/auth/switch-workspace', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
    const userId = decoded.userId;
    const { organizationId } = req.body;
    if (!organizationId) return res.status(400).json({ error: 'organizationId required' });
    const member = await pool.query(
      `SELECT om.role FROM organization_members om WHERE om.user_id = $1 AND om.organization_id = $2`,
      [userId, organizationId]
    );
    if (member.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this organization' });
    }
    const userRow = await pool.query(
      'SELECT id, email FROM users WHERE id = $1',
      [userId]
    );
    if (userRow.rows.length === 0) return res.status(401).json({ error: 'User not found' });
    const user = userRow.rows[0];
    const role = member.rows[0].role;
    const accessToken = jwt.sign(
      { userId: user.id, organizationId, role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );
    res.json({
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        organizationId,
        role,
      },
    });
  } catch (e: any) {
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    console.error('Error switching workspace:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Invite links (workspace v1) ---
// GET /api/invite/:token — публично, данные приглашения
app.get('/api/invite/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const inv = await pool.query(
      `SELECT i.organization_id AS "organizationId", i.role, i.expires_at AS "expiresAt", o.name AS "organizationName"
       FROM organization_invite_links i
       JOIN organizations o ON o.id = i.organization_id
       WHERE i.token = $1`,
      [token]
    );
    if (inv.rows.length === 0) {
      return res.status(404).json({ error: 'Invite not found' });
    }
    const row = inv.rows[0];
    if (new Date(row.expiresAt) <= new Date()) {
      return res.status(410).json({ error: 'Invite expired' });
    }
    res.json({
      organizationId: row.organizationId,
      organizationName: row.organizationName,
      role: row.role,
      expiresAt: row.expiresAt,
    });
  } catch (e: any) {
    console.error('Error fetching invite:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/invite/:token/accept — требуется Bearer, добавляет пользователя в organization_members
app.post('/api/invite/:token/accept', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string; organizationId: string };
    const userResult = await pool.query('SELECT id FROM users WHERE id = $1', [decoded.userId]);
    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }
    const userId = decoded.userId;
    const { token: inviteToken } = req.params;
    const inv = await pool.query(
      'SELECT organization_id, role, expires_at FROM organization_invite_links WHERE token = $1',
      [inviteToken]
    );
    if (inv.rows.length === 0) {
      return res.status(404).json({ error: 'Invite not found' });
    }
    const { organization_id: organizationId, role, expires_at: expiresAt } = inv.rows[0];
    if (new Date(expiresAt) <= new Date()) {
      return res.status(410).json({ error: 'Invite expired' });
    }
    const existing = await pool.query(
      'SELECT 1 FROM organization_members WHERE user_id = $1 AND organization_id = $2',
      [userId, organizationId]
    );
    if (existing.rows.length > 0) {
      return res.status(200).json({ success: true, message: 'Already a member' });
    }
    await pool.query(
      'INSERT INTO organization_members (user_id, organization_id, role) VALUES ($1, $2, $3)',
      [userId, organizationId, role]
    );
    res.json({ success: true });
  } catch (e: any) {
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    console.error('Error accepting invite:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Auth service running on port ${PORT}`);
});

