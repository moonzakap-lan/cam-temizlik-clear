const express = require('express');
const { pool } = require('../db');
const iyzicoService = require('../services/iyzicoService');
const router = express.Router();

/**
 * POST /cleaners
 * Temizlikçiyi sisteme kaydeder VE aynı anda iyzico'ya Alt Üye İşyeri
 * (sub-merchant) olarak onboard eder. Gerçek üründe bu iki adım ayrı
 * bir KYC akışına bölünebilir; test/sandbox için tek endpoint yeterli.
 */
router.post('/', async (req, res) => {
  const { fullName, email, phone, tcIdentityNumber, iban, address } = req.body;

  try {
    const inserted = await pool.query(
      `INSERT INTO cleaners (full_name, email, phone, tc_identity_number, iban, is_available, onboarding_status)
       VALUES ($1,$2,$3,$4,$5, false, 'pending')
       RETURNING *`,
      [fullName, email, phone, tcIdentityNumber, iban]
    );
    const cleaner = inserted.rows[0];

    const submerchantKey = await iyzicoService.onboardCleanerAsSubmerchant({
      ...cleaner,
      address: address || 'Adres bilgisi girilmedi',
    });

    const updated = await pool.query(
      `UPDATE cleaners
       SET iyzico_submerchant_key = $1, onboarding_status = 'approved', is_available = true
       WHERE id = $2
       RETURNING *`,
      [submerchantKey, cleaner.id]
    );

    res.status(201).json(updated.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Temizlikçi oluşturulamadı', detail: err.message });
  }
});

/**
 * GET /cleaners
 * Test/kontrol amaçlı — kayıtlı temizlikçileri listeler.
 */
router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT id, full_name, is_available, onboarding_status FROM cleaners ORDER BY created_at DESC');
  res.json(rows);
});

module.exports = router;
