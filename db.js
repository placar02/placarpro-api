const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

const useDatabaseUrl = Boolean(process.env.DATABASE_URL);
const useSsl = process.env.DB_SSL === 'true' || process.env.NODE_ENV === 'production';

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: useSsl ? { rejectUnauthorized: false } : false
});

module.exports = pool;

async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        senha VARCHAR(255) NOT NULL,
        plano VARCHAR(50) DEFAULT 'basico',
        banca_inicial REAL DEFAULT 0,
        saldo_atual REAL DEFAULT 0,
        data_cadastro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS banca_inicial REAL DEFAULT 0');
    await pool.query('ALTER TABLE users ALTER COLUMN saldo_atual SET DEFAULT 0');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS bets (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        jogo VARCHAR(255) NOT NULL,
        odd REAL NOT NULL,
        valor_apostado REAL NOT NULL,
        resultado VARCHAR(50) NOT NULL,
        lucro_prejuizo REAL NOT NULL,
        data TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id)
      )
    `);

    await pool.query('ALTER TABLE bets ADD COLUMN IF NOT EXISTS event_id VARCHAR(100)');
    await pool.query('ALTER TABLE bets ADD COLUMN IF NOT EXISTS market TEXT');
    await pool.query('ALTER TABLE bets ADD COLUMN IF NOT EXISTS recommendation TEXT');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS bankroll_history (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        dia INTEGER NOT NULL,
        saldo REAL NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users (id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS payment_sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        checkout_id VARCHAR(255) UNIQUE,
        external_id VARCHAR(255) UNIQUE NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
        plan VARCHAR(50) NOT NULL DEFAULT 'premium',
        amount INTEGER,
        checkout_url TEXT,
        raw_payload TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_analysis_cache (
        id SERIAL PRIMARY KEY,
        cache_key VARCHAR(80) UNIQUE NOT NULL,
        payload TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('Tabelas inicializadas (PostgreSQL).');
  } catch (err) {
    console.error('Erro ao inicializar o banco:', err);
  }
}

initDb();

const convertSql = (sql) => {
  let i = 1;
  return sql.replace(/\?/g, () => `$${i++}`);
};

const run = async (sql, params = []) => {
  const pgSql = convertSql(sql);
  let finalSql = pgSql;

  if (sql.trim().toUpperCase().startsWith('INSERT') && !sql.toUpperCase().includes('RETURNING')) {
    finalSql += ' RETURNING id';
  }

  const res = await pool.query(finalSql, params);
  const id = res.rows.length > 0 ? res.rows[0].id : null;

  return { id, changes: res.rowCount };
};

const get = async (sql, params = []) => {
  const pgSql = convertSql(sql);
  const res = await pool.query(pgSql, params);
  return res.rows[0];
};

const all = async (sql, params = []) => {
  const pgSql = convertSql(sql);
  const res = await pool.query(pgSql, params);
  return res.rows;
};

module.exports = { pool, run, get, all };
