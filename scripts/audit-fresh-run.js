require('dotenv').config();
const { Pool } = require('pg');

const date = process.argv[2] || new Date().toISOString().slice(0, 10);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' || process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

pool.query(
  `SELECT status,
          payload->'selection'->>'analysisRunId' AS run_id,
          jsonb_array_length(COALESCE(payload->'generatedAnalyses', '[]'::jsonb)) AS generated_count,
          payload->'selection'->>'analysesPublished' AS published_count,
          error
     FROM daily_analysis_publications
    WHERE analysis_date = $1 AND match_mode = 'prelive'
    ORDER BY updated_at DESC
    LIMIT 1`,
  [date],
).then(({ rows }) => {
  console.log(JSON.stringify(rows[0] || null));
}).finally(() => pool.end());
