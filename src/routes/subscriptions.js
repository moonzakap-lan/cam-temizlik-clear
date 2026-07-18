const express = require('express');
const { pool } = require('../db');
const router = express.Router();

/**
 * POST /subscriptions
 * İşletme abonelik başlatır. Iyzico "Abonelik" (recurring) ürünüyle
 * ilk tahsilat yapılır (bu servis tahsilatı ayrı bir subscriptionService
 * modülünde ele alınır — burada sadece kayıt akışı gösterilmiştir).
 */
router.post('/', async (req, res) => {
  const { businessId, planId, iyzicoSubscriptionReferenceCode } = req.body;

  try {
    const plan = await pool.query('SELECT * FROM plans WHERE id = $1 AND is_active = true', [planId]);
    if (plan.rows.length === 0) {
      return res.status(404).json({ error: 'Plan bulunamadı' });
    }

    const periodStart = new Date();
    const periodEnd = new Date();
    periodEnd.setMonth(periodEnd.getMonth() + 1); // MONTHLY varsayımı; plan.billing_period'a göre hesaplanmalı

    const { rows } = await pool.query(
      `INSERT INTO subscriptions
        (business_id, plan_id, status, iyzico_subscription_reference_code, current_period_start, current_period_end)
       VALUES ($1, $2, 'active', $3, $4, $5)
       RETURNING *`,
      [businessId, planId, iyzicoSubscriptionReferenceCode, periodStart, periodEnd]
    );

    // NOT: Bu noktadan sonra bir cron/queue job'ı, plan.cleanings_per_cycle
    // sayısına göre otomatik `jobs` kayıtları oluşturur ve
    // jobsController.createAndAssignJob() tetiklenir.

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Abonelik oluşturulamadı' });
  }
});

module.exports = router;
