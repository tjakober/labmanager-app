'use strict';

const db             = require('../db/pool');
const Q              = require('../db/queries');
const configService  = require('./configService');
const weblingService = require('./weblingService');

async function resolveWeblingId(memberId) {
  const user = await db.queryOne(Q.getMemberById, [memberId]);
  return user && user.webling_id ? Number(user.webling_id) : null;
}

async function deposit(memberId, amount, creditAccount, reference, requestedBy = 'labmanager') {
  const maxDeposit = await configService.get('balance.max_deposit');
  // Konto kommt aus artikel.konto_nr — keine separate Whitelist nötig

  const weblingId = await resolveWeblingId(memberId);
  if (!weblingId) return { ok: false, error_code: 'MEMBER_NOT_FOUND', new_balance: null, deposited: 0 };

  const member = await weblingService.getMember(weblingId).catch(() => null);
  if (!member) return { ok: false, error_code: 'MEMBER_NOT_FOUND', new_balance: null, deposited: 0 };

  const currentBalance = await weblingService.getBalance(weblingId);

  if (currentBalance + amount > maxDeposit) {
    return { ok: false, error_code: 'MAX_BALANCE_EXCEEDED', new_balance: currentBalance, deposited: 0 };
  }

  const newBalance = currentBalance + amount;

  try {
    await weblingService.bookDeposit(weblingId, amount, creditAccount, reference);
  } catch {
    return { ok: false, error_code: 'WEBLING_ERROR', new_balance: currentBalance, deposited: 0 };
  }

  await db.query(Q.insertBalanceTransaction,
    [memberId, 'deposit', amount, creditAccount, reference, newBalance, requestedBy]);

  return { ok: true, error_code: null, new_balance: newBalance, deposited: amount };
}

async function withdraw(memberId, amount, debitAccount, reference, requestedBy = 'labmanager') {
  const weblingId = await resolveWeblingId(memberId);
  if (!weblingId) return { ok: false, error_code: 'MEMBER_NOT_FOUND', new_balance: null, withdrawn: 0 };

  const member = await weblingService.getMember(weblingId).catch(() => null);
  if (!member) return { ok: false, error_code: 'MEMBER_NOT_FOUND', new_balance: null, withdrawn: 0 };

  const currentBalance = await weblingService.getBalance(weblingId);

  if (currentBalance < amount) {
    return { ok: false, error_code: 'INSUFFICIENT_BALANCE', new_balance: currentBalance, withdrawn: 0 };
  }

  const newBalance = currentBalance - amount;

  try {
    await weblingService.bookWithdraw(weblingId, amount, debitAccount, reference);
  } catch {
    return { ok: false, error_code: 'WEBLING_ERROR', new_balance: currentBalance, withdrawn: 0 };
  }

  await db.query(Q.insertBalanceTransaction,
    [memberId, 'withdraw', amount, debitAccount, reference, newBalance, requestedBy]);

  return { ok: true, error_code: null, new_balance: newBalance, withdrawn: amount };
}

async function getBalance(memberId) {
  const member = await db.queryOne(Q.getMemberById, [memberId]);
  if (!member || !member.webling_id) throw Object.assign(new Error('Kein Webling-Konto'), { statusCode: 404 });
  return weblingService.getBalance(Number(member.webling_id));
}

module.exports = { deposit, withdraw, getBalance };
