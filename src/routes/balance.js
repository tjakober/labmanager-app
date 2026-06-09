'use strict';

const express         = require('express');
const balanceService  = require('../services/balanceService');
const { sessionAuth, requireRole } = require('../middleware/sessionAuth');

const router = express.Router();

/**
 * POST /api/balance/deposit
 * Body: { member_id, amount, credit_account, reference }
 */
router.post('/deposit', sessionAuth, requireRole('admin', 'labmanager'), async (req, res) => {
  const { member_id, amount, credit_account, reference } = req.body;

  try {
    const result = await balanceService.deposit(member_id, amount, credit_account, reference);
    return res.json(result);

  } catch (err) {
    console.error('[balance/deposit]', err.message);
    return res.status(500).json({ ok: false, error_code: 'SERVER_ERROR', error: err.message });
  }
});

/**
 * POST /api/balance/withdraw
 * Body: { member_id, amount, debit_account, reference }
 */
router.post('/withdraw', sessionAuth, requireRole('admin', 'labmanager'), async (req, res) => {
  const { member_id, amount, debit_account, reference } = req.body;

  try {
    const result = await balanceService.withdraw(member_id, amount, debit_account, reference);
    return res.json(result);

  } catch (err) {
    console.error('[balance/withdraw]', err.message);
    return res.status(500).json({ ok: false, error_code: 'SERVER_ERROR', error: err.message });
  }
});

/**
 * GET /api/balance/:member_id
 * Returns current balance directly from Webling (no local cache).
 */
router.get('/:member_id', sessionAuth, async (req, res) => {
  const { member_id } = req.params;

  try {
    const balance = await balanceService.getBalance(member_id);
    return res.json({ member_id, balance });

  } catch (err) {
    console.error('[balance/get]', err.message);
    return res.status(500).json({ error: err.message || 'Server-Fehler' });
  }
});

module.exports = router;
