import express from 'express';
import { Pool } from 'pg';
import { RedisClient } from '@getsale/utils';
import { RabbitMQClient } from '@getsale/utils';
import { EventType } from '@getsale/events';

const app = express();
const PORT = process.env.PORT || 3010;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || `postgresql://postgres:${process.env.POSTGRES_PASSWORD || 'postgres_dev'}@localhost:5432/postgres`,
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
})();

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

    // Use CTE to calculate time differences first, then aggregate (ЭТАП 2: entity_type, entity_id, created_at).
    let query = `
      WITH stage_transitions AS (
        SELECT 
          sh.*,
          fs.name as from_stage,
          ts.name as to_stage,
          LAG(sh.created_at) OVER (PARTITION BY sh.entity_type, sh.entity_id ORDER BY sh.created_at) as prev_created_at
        FROM stage_history sh
        LEFT JOIN stages fs ON sh.from_stage_id = fs.id
        LEFT JOIN stages ts ON sh.to_stage_id = ts.id
        WHERE sh.organization_id = $1
    `;
    const params: any[] = [user.organizationId];

    if (fromStage) {
      query += ` AND fs.name = $${params.length + 1}`;
      params.push(fromStage);
    }

    if (toStage) {
      query += ` AND ts.name = $${params.length + 1}`;
      params.push(toStage);
    }

    if (startDate) {
      query += ` AND sh.created_at >= $${params.length + 1}`;
      params.push(startDate);
    }

    if (endDate) {
      query += ` AND sh.created_at <= $${params.length + 1}`;
      params.push(endDate);
    }

    query += `
      )
      SELECT 
        from_stage,
        to_stage,
        COUNT(*) as transitions,
        AVG(EXTRACT(EPOCH FROM (created_at - prev_created_at))) / 3600 as avg_hours
      FROM stage_transitions
      WHERE prev_created_at IS NOT NULL
      GROUP BY from_stage, to_stage
    `;

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

