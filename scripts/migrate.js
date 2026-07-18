/**
 * schema.sql dosyasını DATABASE_URL'deki veritabanına uygular.
 * Kullanım:  npm run db:migrate
 * (Supabase'de ilk kurulumda SQL Editor kullanmayı tercih ediyorsan
 *  bu script yerine schema.sql'i doğrudan orada da çalıştırabilirsin.)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function migrate() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL tanımlı değil (.env dosyasını kontrol et)');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  });

const schemaPath = path.join(__dirname, '..', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  console.log('Şema uygulanıyor...');
  try {
    await pool.query(sql);
    console.log('Şema başarıyla uygulandı.');
  } catch (err) {
    console.error('Şema uygulanamadı:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
