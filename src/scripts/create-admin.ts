// Usage: npm run create-admin -- <email>
// The password is read from the ADMIN_PASSWORD env var, or prompted for.
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { hashPassword } from '../lib/auth.js';

const email = process.argv[2]?.trim().toLowerCase();
if (!email || !email.includes('@')) {
  console.error('Usage: npm run create-admin -- <email>');
  process.exit(1);
}

let password = process.env.ADMIN_PASSWORD;
if (!password) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question('Password (min. 12 characters): ');
  rl.close();
}
if (password.length < 12) {
  console.error('Password must be at least 12 characters.');
  process.exit(1);
}

const db = createPool(loadConfig().DATABASE_URL);
try {
  await db.query(
    `INSERT INTO admin_users (email, password_hash) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [email, await hashPassword(password)],
  );
  // A password change logs out existing sessions.
  await db.query('DELETE FROM admin_sessions WHERE user_id = (SELECT id FROM admin_users WHERE email = $1)', [email]);
  console.log(`Admin ${email} saved.`);
} finally {
  await db.end();
}
