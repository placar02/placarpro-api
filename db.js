const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

// Configuração para o PostgreSQL (ou H2 em modo PG)
// O usuário pode sobrescrever a URL usando DATABASE_URL no .env
const pool = new Pool({
  // connectionString: process.env.DATABASE_URL || 'postgresql://sa:sa@localhost:5432/placar02',
   //Caso não use connectionString:
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'placar02',
  password: process.env.DB_PASSWORD || 'sa',
  port: process.env.DB_PORT || 5432, // 5432 is default for Postgres, 5435 for H2 PG server
});

pool.on('error', (err) => {
  console.error('Erro no pool do banco de dados:', err);
});

// Inicialização das tabelas
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

    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS banca_inicial REAL DEFAULT 0`);
    await pool.query(`ALTER TABLE users ALTER COLUMN saldo_atual SET DEFAULT 0`);

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

    await pool.query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS event_id VARCHAR(100)`);
    await pool.query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS market TEXT`);
    await pool.query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS recommendation TEXT`);

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
    
    console.log('Tabelas inicializadas (PostgreSQL / H2).');
  } catch (err) {
    console.error('Erro ao inicializar o banco:', err);
  }
}

// Chamar a inicialização
initDb();

// Função utilitária para converter queries com '?' (SQLite) para '$1, $2...' (PostgreSQL)
const convertSql = (sql) => {
  let i = 1;
  return sql.replace(/\?/g, () => `$${i++}`);
};

// Funções utilitárias mantidas para compatibilidade com o server.js
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
