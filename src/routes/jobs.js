const express = require('express');
const { pool } = require('../db');
const matchingService = require('../services/matchingService');
const iyzicoService = require('../services/iyzicoService');
const aiVerificationService = require('../services/aiVerificationService');
const router = express.Router();

const PLATFORM_COMMISSION_RATE = 0.20; // %20 platform komisyonu — plan bazlı da olabilir

/**
 * POST /jobs
 * Yeni iş oluşturur, rastgele müsait bir temizlikçi bulup atar,
 * ardından işletmenin kayıtlı kartından tahsilatı iyzico Pazaryeri
 * split-payment ile yapar (tutar temizlikçi payı için escrow'da bekler).
 */
router.post('/', async (req, res) => {
  const { subscriptionId, businessId, serviceAddress, scheduledAt, price, card } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cleanerPayoutAmount = +(price * (1 - PLATFORM_COMMISSION_RATE)).toFixed(2);

    const jobInsert = await client.query(
      `INSERT INTO jobs
        (subscription_id, business_id, status, service_address, scheduled_at, price, cleaner_payout_amount, platform_commission)
       VALUES ($1, $2, 'pending_assignment', $3, $4, $5, $6, $7)
       RETURNING *`,
      [subscriptionId, businessId, serviceAddress, scheduledAt, price, cleanerPayoutAmount, +(price - cleanerPayoutAmount).toFixed(2)]
    );
    await client.query('COMMIT');

    const job = jobInsert.rows[0];

    // 1) Rastgele müsait bir temizlikçi bul ve ata
    const assignment = await matchingService.assignJobToRandomCleaner(job.id);
    if (!assignment) {
      return res.status(202).json({ job, message: 'Şu an müsait temizlikçi yok; kuyruğa alındı.' });
    }

    // 2) İşletmeden tahsilat — bölüştürmeli (temizlikçi payı escrow'da tutulur)
    const business = (await pool.query('SELECT * FROM businesses WHERE id = $1', [businessId])).rows[0];
    const charge = await iyzicoService.chargeJobWithSplit({
      job: assignment.job,
      business,
      cleaner: assignment.cleaner,
      card,
      conversationId: `job-${job.id}`,
    });

    const paymentInsert = await pool.query(
      `INSERT INTO payments (job_id, subscription_id, type, status, amount, iyzico_payment_id, iyzico_payment_transaction_id, iyzico_conversation_id, raw_response)
       VALUES ($1, $2, 'subscription_charge', 'success', $3, $4, $5, $6, $7)
       RETURNING *`,
      [job.id, subscriptionId, price, charge.iyzicoPaymentId, charge.iyzicoPaymentTransactionId, `job-${job.id}`, charge.rawResponse]
    );

    await pool.query('UPDATE jobs SET payment_id = $1 WHERE id = $2', [paymentInsert.rows[0].id, job.id]);

    res.status(201).json({ job: assignment.job, cleaner: assignment.cleaner, payment: paymentInsert.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'İş oluşturulamadı' });
  } finally {
    client.release();
  }
});

/**
 * POST /jobs/:id/photos
 * Temizlikçi before/after fotoğrafı yükler.
 */
router.post('/:id/photos', async (req, res) => {
  const { id } = req.params;
  const { photoType, storageUrl } = req.body; // storageUrl: S3/R2'ye önceden yüklenmiş dosyanın URL'i

  const { rows } = await pool.query(
    `INSERT INTO job_photos (job_id, photo_type, storage_url) VALUES ($1,$2,$3) RETURNING *`,
    [id, photoType, storageUrl]
  );

  if (photoType === 'after') {
    await pool.query(`UPDATE jobs SET status = 'submitted_for_review', completed_at = now() WHERE id = $1`, [id]);
  }

  res.status(201).json(rows[0]);
});

/**
 * POST /jobs/:id/review
 * "after" fotoğrafı yüklendikten sonra tetiklenir (webhook / worker'dan
 * çağrılabilir). AI kalite kontrolünü çalıştırır ve sonuca göre
 * iyzico escrow onayı ya da reddi yapar.
 */
router.post('/:id/review', async (req, res) => {
  const { id } = req.params;

  try {
    const job = (await pool.query('SELECT * FROM jobs WHERE id = $1', [id])).rows[0];
    if (!job) return res.status(404).json({ error: 'İş bulunamadı' });

    const photos = await pool.query(
      `SELECT * FROM job_photos WHERE job_id = $1 ORDER BY uploaded_at DESC`,
      [id]
    );
    const afterPhoto = photos.rows.find((p) => p.photo_type === 'after');
    const beforePhoto = photos.rows.find((p) => p.photo_type === 'before');
    if (!afterPhoto) return res.status(400).json({ error: 'Sonuç fotoğrafı bulunamadı' });

    // 1) AI kalite kontrolü
    const verification = await aiVerificationService.verifyCleaningPhoto({
      beforePhotoUrl: beforePhoto?.storage_url,
      afterPhotoUrl: afterPhoto.storage_url,
    });

    await pool.query(
      `INSERT INTO ai_verifications
        (job_id, before_photo_id, after_photo_id, ai_provider, cleanliness_score, decision_threshold, is_approved, raw_response)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, beforePhoto?.id, afterPhoto.id, 'claude-sonnet-4-6', verification.cleanlinessScore,
       aiVerificationService.DECISION_THRESHOLD, verification.isApproved, verification.rawResponse]
    );

    const payment = (await pool.query('SELECT * FROM payments WHERE id = $1', [job.payment_id])).rows[0];

    if (verification.isApproved) {
      // 2a) AI onayladı -> iyzico escrow onayı: temizlikçi payı serbest bırakılır
      await iyzicoService.approvePayoutToCleaner({
        paymentTransactionId: payment.iyzico_payment_transaction_id,
        conversationId: `approve-${id}`,
      });

      await pool.query(
        `UPDATE jobs SET status = 'paid', ai_reviewed_at = now(), approved_at = now(), paid_at = now() WHERE id = $1`,
        [id]
      );
      await pool.query(
        `INSERT INTO payments (job_id, type, status, amount, iyzico_payment_transaction_id)
         VALUES ($1, 'cleaner_payout', 'success', $2, $3)`,
        [id, job.cleaner_payout_amount, payment.iyzico_payment_transaction_id]
      );
      await pool.query(
        `UPDATE cleaners SET active_job_count = active_job_count - 1 WHERE id = $1`,
        [job.cleaner_id]
      );

      return res.json({ status: 'approved_and_paid', score: verification.cleanlinessScore });
    }

    // 2b) AI onaylamadı -> escrow reddi, manuel inceleme kuyruğuna düşer
    await iyzicoService.disapprovePayout({
      paymentTransactionId: payment.iyzico_payment_transaction_id,
      conversationId: `disapprove-${id}`,
    });

    await pool.query(
      `UPDATE jobs SET status = 'ai_rejected', ai_reviewed_at = now() WHERE id = $1`,
      [id]
    );

    res.json({ status: 'ai_rejected', score: verification.cleanlinessScore, reasoning: verification.reasoning });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'İnceleme başarısız' });
  }
});

module.exports = router;
