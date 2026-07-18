const { pool } = require('../db');

/**
 * Müsait, onboarding'i tamamlanmış ve aşırı yüklü olmayan temizlikçiler
 * arasından rastgele birini seçer ve işi ona atar. Transaction içinde
 * FOR UPDATE SKIP LOCKED kullanılır — iki iş aynı anda aynı temizlikçiye
 * çarpmasın diye.
 */
async function assignJobToRandomCleaner(jobId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `
      SELECT id, iyzico_submerchant_key
      FROM cleaners
      WHERE is_available = true
        AND onboarding_status = 'approved'
        AND active_job_count < 3
      ORDER BY random()
      LIMIT 1
      FOR UPDATE SKIP LOCKED
      `
    );

    const cleaner = rows[0];
    if (!cleaner) {
      await client.query('ROLLBACK');
      return null; // şu an müsait temizlikçi yok -> bekleme kuyruğuna al / bildirim gönder
    }

    await client.query(
      `UPDATE cleaners SET active_job_count = active_job_count + 1 WHERE id = $1`,
      [cleaner.id]
    );

    const updated = await client.query(
      `UPDATE jobs
       SET cleaner_id = $1, status = 'assigned', assigned_at = now()
       WHERE id = $2
       RETURNING *`,
      [cleaner.id, jobId]
    );

    await client.query('COMMIT');
    return { job: updated.rows[0], cleaner };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { assignJobToRandomCleaner };
