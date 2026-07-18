const { pool } = require('../db');
const MAX_SEARCH_RADIUS_M = 25000; // 25 km, iş bölgesi dışına atama yapılmaz

/**
 * Verilen iş konumuna en yakın, müsait ve onboarding'i tamamlanmış
 * temizlikçiyi bulur. PostGIS'in <-> operatörü GIST index kullanarak
 * KNN (k-nearest-neighbor) taraması yapar; her seferinde tüm tabloyu
 * taramaz.
 */
async function findNearestAvailableCleaner(lng, lat) {
  const { rows } = await pool.query(
    `
    SELECT id, full_name, iyzico_submerchant_key,
           ROUND((location <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography)::numeric, 1) AS distance_m
    FROM cleaners
    WHERE is_available = true
      AND onboarding_status = 'approved'
      AND active_job_count < 3               -- aynı anda en fazla 3 iş
      AND ST_DWithin(
            location,
            ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
            $3
          )
    ORDER BY location <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
    LIMIT 1
    `,
    [lng, lat, MAX_SEARCH_RADIUS_M]
  );

  return rows[0] || null;
}

/**
 * Atama işlemini transaction içinde yapar: temizlikçiyi kilitler (FOR UPDATE),
 * iki müşteri aynı anda aynı temizlikçiye atanmasın diye race condition'ı önler.
 */
async function assignJobToNearestCleaner(jobId, lng, lat) {
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
        AND ST_DWithin(location, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography, $3)
      ORDER BY location <-> ST_SetSRID(ST_MakePoint($1,$2),4326)::geography
      LIMIT 1
      FOR UPDATE SKIP LOCKED
      `,
      [lng, lat, MAX_SEARCH_RADIUS_M]
    );

    const cleaner = rows[0];
    if (!cleaner) {
      await client.query('ROLLBACK');
      return null; // çağıran taraf: bölgede müsait temizlikçi yok -> bekleme kuyruğuna al / bildirim gönder
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

module.exports = { findNearestAvailableCleaner, assignJobToNearestCleaner };
