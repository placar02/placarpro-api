const { pool, ready } = require('../db');

async function main() {
  const email = String(process.argv[2] || '').trim().toLowerCase();
  if (!email || !email.includes('@')) throw new Error('Uso: npm run admin:promote -- usuario@email.com');
  await ready;
  const result = await pool.query(
    "UPDATE users SET role = 'admin', status = 'active', updated_at = CURRENT_TIMESTAMP WHERE LOWER(email) = $1 RETURNING id, nome, email",
    [email]
  );
  if (!result.rowCount) throw new Error('Usuario nao encontrado. Cadastre a conta antes de promove-la.');
  console.log(`Administrador promovido: ${result.rows[0].email}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => pool.end());
