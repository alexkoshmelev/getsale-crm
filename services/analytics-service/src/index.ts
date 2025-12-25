import express from 'express';
import { Pool } from 'pg';
import { RedisClient } from '@getsale/utils';
import { RabbitMQClient } from '@getsale/utils';
import { EventType } from '@getsale/events';

const app = express();
const PORT = process.env.PORT || 3010;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://getsale:getsale_dev@localhost:5432/getsale_crm',
});

const redis = new RedisClient(process.env.REDIS_URL || 'redis://localhost:6379');
const rabbitmq = new RabbitMQClient(
  process.env.RABBITMQ_URL || 'amqp://getsale:getsale_dev@localhost:5672'
);

(async () => {
  try {
    await rabbitmq.connect();
    await subscribeToEvents();
  } catch (error) {
    console.error('Failed to connect to RabbitMQ, service will continue without event subscription:', error);
  }
  await initDatabase();
})();

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics_metrics (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      metric_type VARCHAR(100) NOT NULL,
      metric_name VARCHAR(255) NOT NULL,
      value NUMERIC NOT NULL,
      dimensions JSONB DEFAULT '{}',
      recorded_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS conversion_rates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      from_stage VARCHAR(100),
      to_stage VARCHAR(100),
      rate NUMERIC NOT NULL,
      period_start TIMESTAMP NOT NULL,
      period_end TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_analytics_metrics_org ON analytics_metrics(organization_id);
    CREATE INDEX IF NOT EXISTS idx_analytics_metrics_type ON analytics_metrics(metric_type);
    CREATE INDEX IF NOT EXISTS idx_analytics_metrics_date ON analytics_metrics(recorded_at);
    CREATE INDEX IF NOT EXISTS idx_conversion_rates_org ON conversion_rates(organization_id);
  `);
}

async function subscribeToEvents() {
  await rabbitmq.subscribeToEvents(
    [EventType.DEAL_STAGE_CHANGED, EventType.DEAL_CLOSED, EventType.MESSAGE_SENT],
    async (event) => {
      await recordMetric(event);
    },
    'events',
    'analytics-service'
  );
}

async function recordMetric(event: any) {
  try {
    const metricType = event.type;
    let metricName = '';
    let value = 1;

    switch (event.type) {
      case EventType.DEAL_STAGE_CHANGED:
        metricName = 'stage_transition';
        value = 1;
        break;
      case EventType.DEAL_CLOSED:
        metricName = 'deal_closed';
        value = event.data?.value || 1;
        break;
      case EventType.MESSAGE_SENT:
        metricName = 'message_sent';
        value = 1;
        break;
    }

    await pool.query(
      `INSERT INTO analytics_metrics (organization_id, metric_type, metric_name, value, dimensions)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        event.organizationId,
        metricType,
        metricName,
        value,
        JSON.stringify(event.data || {}),
      ]
    );

    // Cache for quick access
    const cacheKey = `analytics:${event.organizationId}:${metricName}:${new Date().toISOString().split('T')[0]}`;
    const cached = await redis.get<number>(cacheKey) || 0;
    await redis.set(cacheKey, cached + value, 86400); // 24 hours
  } catch (error) {
    console.error('Error recording metric:', error);
  }
}

function getUser(req: express.Request) {
  return {
    id: req.headers['x-user-id'] as string,
    organizationId: req.headers['x-organization-id'] as string,
  };
}

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'analytics-service' });
});

// Conversion rates
app.get('/api/analytics/conversion-rates', async (req, res) => {
  try {
    const user = getUser(req);
    const { fromStage, toStage, startDate, endDate } = req.query;

    let query = `
      SELECT 
        from_stage,
        to_stage,
        COUNT(*) as transitions,
        AVG(EXTRACT(EPOCH FROM (moved_at - LAG(moved_at) OVER (PARTITION BY client_id ORDER BY moved_at)))) / 3600 as avg_hours
      FROM stage_history
      WHERE organization_id = $1
    `;
    const params: any[] = [user.organizationId];

    if (fromStage) {
      query += ` AND from_stage = $${params.length + 1}`;
      params.push(fromStage);
    }

    if (toStage) {
      query += ` AND to_stage = $${params.length + 1}`;
      params.push(toStage);
    }

    if (startDate) {
      query += ` AND moved_at >= $${params.length + 1}`;
      params.push(startDate);
    }

    if (endDate) {
      query += ` AND moved_at <= $${params.length + 1}`;
      params.push(endDate);
    }

    query += ' GROUP BY from_stage, to_stage';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching conversion rates:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Pipeline value
app.get('/api/analytics/pipeline-value', async (req, res) => {
  try {
    const user = getUser(req);
    const result = await pool.query(
      `SELECT 
        s.name as stage_name,
        COUNT(d.id) as deal_count,
        SUM(d.value) as total_value,
        AVG(d.value) as avg_value
       FROM deals d
       JOIN stages s ON d.stage_id = s.id
       WHERE d.organization_id = $1
       GROUP BY s.id, s.name, s.order_index
       ORDER BY s.order_index`,
      [user.organizationId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching pipeline value:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Team performance
app.get('/api/analytics/team-performance', async (req, res) => {
  try {
    const user = getUser(req);
    const { startDate, endDate } = req.query;

    let query = `
      SELECT 
        u.id as user_id,
        COUNT(DISTINCT d.id) as deals_closed,
        SUM(d.value) as revenue,
        AVG(EXTRACT(EPOCH FROM (d.updated_at - d.created_at)) / 86400) as avg_days_to_close
      FROM deals d
      JOIN users u ON d.owner_id = u.id
      WHERE d.organization_id = $1 AND d.stage_id IN (
        SELECT id FROM stages WHERE name = 'closed' OR name = 'won'
      )
    `;
    const params: any[] = [user.organizationId];

    if (startDate) {
      query += ` AND d.updated_at >= $${params.length + 1}`;
      params.push(startDate);
    }

    if (endDate) {
      query += ` AND d.updated_at <= $${params.length + 1}`;
      params.push(endDate);
    }

    query += ' GROUP BY u.id';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching team performance:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Export data
app.get('/api/analytics/export', async (req, res) => {
  try {
    const user = getUser(req);
    const { format, startDate, endDate } = req.query;

    const result = await pool.query(
      `SELECT * FROM analytics_metrics 
       WHERE organization_id = $1 
       AND recorded_at >= $2 
       AND recorded_at <= $3
       ORDER BY recorded_at DESC`,
      [user.organizationId, startDate || '1970-01-01', endDate || new Date().toISOString()]
    );

    if (format === 'csv') {
      // Convert to CSV
      const csv = [
        'id,organization_id,metric_type,metric_name,value,dimensions,recorded_at',
        ...result.rows.map(row => 
          `${row.id},${row.organization_id},${row.metric_type},${row.metric_name},${row.value},"${JSON.stringify(row.dimensions)}",${row.recorded_at}`
        )
      ].join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=analytics-export.csv');
      res.send(csv);
    } else {
      res.json(result.rows);
    }
  } catch (error) {
    console.error('Error exporting analytics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Analytics service running on port ${PORT}`);
});

