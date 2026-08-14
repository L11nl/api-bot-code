const crypto = require('crypto');
const axios = require('axios');
const config = require('../config');
const {
  sequelize,
  Op,
  User,
  BalanceTransaction,
  PurchaseOrder,
  BinanceTransfer,
  NetworkPaymentIntent,
  getSetting,
  getSecureSetting
} = require('../db');
const { fulfillOrder } = require('../services/orders');

let serverTimeOffsetMs = 0;

async function getRuntimeConfig() {
  const apiKey = await getSecureSetting('binance_api_key', config.binance.apiKey);
  const secretKey = await getSecureSetting('binance_api_secret', config.binance.secretKey);
  const payId = await getSetting('binance_pay_id', config.binance.payId);
  return { ...config.binance, apiKey, secretKey, payId };
}

async function configured() {
  const runtime = await getRuntimeConfig();
  return Boolean(runtime.apiKey && runtime.secretKey && runtime.payId);
}

function generateVerificationCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 6; i += 1) suffix += chars[Math.floor(Math.random() * chars.length)];
  return `CD-${suffix}`;
}

function normalizeIdentifier(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
}

function normalizeDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function amountUsdt(item) {
  const currency = String(item?.currency || '').toUpperCase();
  const direct = Math.abs(Number(item?.amount || 0));
  if (currency === 'USDT' && Number.isFinite(direct) && direct > 0) return direct;
  const funds = Array.isArray(item?.fundsDetail) ? item.fundsDetail : [];
  const usdt = funds.find(row => String(row?.currency || '').toUpperCase() === 'USDT');
  const nested = Math.abs(Number(usdt?.amount || 0));
  return Number.isFinite(nested) ? nested : 0;
}

function transactionTime(item) {
  const value = Number(item?.transactionTime || item?.transactTime || item?.createTime || item?.updateTime || 0);
  return Number.isFinite(value) ? value : 0;
}

function identifierCandidates(item) {
  return [
    item?.transactionId,
    item?.orderId,
    item?.prepayId,
    item?.merchantTradeNo,
    item?.bizNo,
    item?.transferId,
    item?.trxId,
    item?.transactionNo,
    item?.tradeNo,
    item?.id
  ].filter(value => value !== undefined && value !== null && String(value).trim() !== '');
}


function flattenValues(value, output = [], seen = new Set()) {
  if (value === null || value === undefined) return output;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    output.push(String(value));
    return output;
  }
  if (typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) flattenValues(item, output, seen);
  } else {
    for (const [key, item] of Object.entries(value)) {
      output.push(String(key));
      flattenValues(item, output, seen);
    }
  }
  return output;
}

function itemMatchesSubmittedId(item, submittedId) {
  const wanted = normalizeIdentifier(submittedId);
  const wantedDigits = normalizeDigits(submittedId);
  const directMatch = identifierCandidates(item).some(candidate => {
    const normalized = normalizeIdentifier(candidate);
    const digits = normalizeDigits(candidate);
    return (wanted && normalized === wanted) || (wantedDigits && digits === wantedDigits);
  });
  if (directMatch) return true;
  return flattenValues(item).some(candidate => {
    const normalized = normalizeIdentifier(candidate);
    const digits = normalizeDigits(candidate);
    return (wanted && normalized === wanted) || (wantedDigits && digits === wantedDigits);
  });
}

function noteMatchState(item, verificationCode) {
  const noteFields = [
    item?.note,
    item?.remark,
    item?.message,
    item?.transferNote,
    item?.paymentInfo?.note,
    item?.extendInfo?.note
  ].filter(value => value !== undefined && value !== null && String(value).trim() !== '');
  if (!noteFields.length) return 'UNAVAILABLE';
  const wanted = normalizeIdentifier(verificationCode);
  return noteFields.some(value => normalizeIdentifier(value).includes(wanted)) ? 'MATCH' : 'MISMATCH';
}

function uniqueTransactionId(item) {
  const first = identifierCandidates(item)[0];
  if (first) return String(first);
  return crypto.createHash('sha256').update(JSON.stringify({
    time: transactionTime(item),
    amount: amountUsdt(item),
    currency: item?.currency,
    payer: item?.payerInfo,
    receiver: item?.receiverInfo
  })).digest('hex');
}

function isIncoming(item) {
  const directAmount = Number(item?.amount || 0);
  if (Number.isFinite(directAmount) && directAmount < 0) return false;
  const orderType = String(item?.orderType || '').toUpperCase();
  if (['PAY_REFUND', 'C2C_HOLDING_RF', 'CRYPTO_BOX_RF', 'REFUND', 'FULL_REFUNDED'].includes(orderType)) return false;
  return amountUsdt(item) > 0;
}

function signedQuery(params, secretKey) {
  const query = new URLSearchParams(params).toString();
  const signature = crypto.createHmac('sha256', secretKey).update(query).digest('hex');
  return `${query}&signature=${signature}`;
}

async function syncServerTime(runtime) {
  const response = await axios.get(`${runtime.baseUrl}/api/v3/time`, { timeout: 10000 });
  const serverTime = Number(response.data?.serverTime || 0);
  if (serverTime > 0) serverTimeOffsetMs = serverTime - Date.now();
}

function isTimestampError(error) {
  const text = JSON.stringify(error?.response?.data || error?.message || error).toLowerCase();
  return text.includes('-1021') || text.includes('outside of the recvwindow') || text.includes('outside of the time window');
}

async function fetchTransactions(startTime, endTime, runtime = null) {
  const cfg = runtime || await getRuntimeConfig();
  const perform = async () => {
    const params = {
      limit: '100',
      recvWindow: '60000',
      timestamp: String(Date.now() + serverTimeOffsetMs),
      startTime: String(startTime),
      endTime: String(endTime)
    };
    const response = await axios.get(
      `${cfg.baseUrl}/sapi/v1/pay/transactions?${signedQuery(params, cfg.secretKey)}`,
      {
        timeout: 20000,
        headers: { 'X-MBX-APIKEY': cfg.apiKey }
      }
    );
    return Array.isArray(response.data?.data) ? response.data.data : [];
  };

  try {
    return await perform();
  } catch (error) {
    if (isTimestampError(error)) {
      await syncServerTime(cfg);
      return perform();
    }
    throw error;
  }
}

async function createForTopup(userId, amount) {
  if (!(await configured())) return { success: false, reason: 'NOT_CONFIGURED' };
  const normalized = Number(amount);
  if (!Number.isFinite(normalized) || normalized < config.binance.minAmount || normalized > config.binance.maxAmount) {
    return { success: false, reason: 'INVALID_AMOUNT' };
  }
  const ledger = await BalanceTransaction.create({
    userId,
    amount: normalized,
    type: 'deposit',
    txid: null,
    caption: 'Binance ID wallet topup',
    status: 'awaiting_binance_id',
    lastReminderAt: new Date()
  });
  const transfer = await BinanceTransfer.create({
    userId,
    balanceTransactionId: ledger.id,
    verificationCode: generateVerificationCode(),
    expectedAmount: normalized,
    currency: 'USDT',
    status: 'WAITING'
  });
  return { success: true, transfer, ledger };
}

async function createForOrder(orderId) {
  if (!(await configured())) return { success: false, reason: 'NOT_CONFIGURED' };
  const order = await PurchaseOrder.findByPk(orderId);
  if (!order) return { success: false, reason: 'ORDER_NOT_FOUND' };
  if (order.status !== 'pending_payment') return { success: false, reason: 'ORDER_ALREADY_PROCESSED' };
  const transfer = await BinanceTransfer.create({
    userId: order.userId,
    orderId: order.id,
    verificationCode: generateVerificationCode(),
    expectedAmount: Number(order.externalAmount || order.totalAmount),
    currency: 'USDT',
    status: 'WAITING'
  });
  await order.update({ paymentRef: transfer.verificationCode });
  return { success: true, transfer, order };
}

async function instructions(transfer, lang = 'ar') {
  const runtime = await getRuntimeConfig();
  const amount = Number(transfer.expectedAmount).toFixed(2);
  if (lang === 'en') {
    return [
      '✅ <b>Payment request created</b>',
      '',
      `💰 Send: <b>${amount} USDT</b>`,
      '🆔 To Binance ID:',
      `<code>${runtime.payId}</code>`,
      '',
      'After sending, send the Binance Order ID here:'
    ].join('\n');
  }
  return [
    '✅ <b>تم إنشاء طلب الدفع</b>',
    '',
    `💰 حوّل: <b>${amount} USDT</b>`,
    '🆔 إلى Binance ID:',
    `<code>${runtime.payId}</code>`,
    '',
    'بعد التحويل ارسل معرف الطلب هنا:'
  ].join('\n');
}

function isRestrictedLocationError(error) {
  const data = error?.response?.data;
  const message = data?.msg || data?.message || error?.message || String(error);
  return /restricted location/i.test(String(message))
    || /service unavailable.*restricted/i.test(String(message))
    || /eligibility/i.test(String(message)) && /location/i.test(String(message));
}

function friendlyError(error) {
  const data = error?.response?.data;
  const message = data?.msg || data?.message || error?.message || String(error);
  if (isRestrictedLocationError(error)) return 'REGION_RESTRICTED';
  if (String(message).includes('-2015') || /Invalid API-key, IP, or permissions/i.test(message)) {
    return 'BINANCE_API_PERMISSION';
  }
  return message;
}

function validSubmittedOrderId(value) {
  return /^[A-Za-z0-9_-]{6,128}$/.test(String(value || '').trim());
}

async function queueManualReview(transferId, submittedOrderId) {
  const transfer = await BinanceTransfer.findByPk(transferId);
  if (!transfer) return { success: false, reason: 'NOT_FOUND' };
  if (transfer.status === 'VERIFIED' || transfer.status === 'PAYMENT_CONFIRMED') {
    return { success: true, alreadyProcessed: true, transfer };
  }
  if (!['WAITING', 'MANUAL_REVIEW'].includes(transfer.status)) {
    return { success: false, reason: 'NOT_WAITING' };
  }

  const submitted = String(submittedOrderId || '').trim();
  if (!validSubmittedOrderId(submitted)) return { success: false, reason: 'INVALID_ORDER_ID' };

  const duplicate = await BinanceTransfer.findOne({
    where: {
      id: { [Op.ne]: transfer.id },
      status: { [Op.in]: ['VERIFIED', 'PAYMENT_CONFIRMED', 'MANUAL_REVIEW'] },
      [Op.or]: [
        { submittedOrderId: submitted },
        { transactionId: submitted }
      ]
    }
  });
  if (duplicate) return { success: false, reason: 'DUPLICATE_TRANSACTION' };

  await transfer.update({
    status: 'MANUAL_REVIEW',
    submittedOrderId: submitted,
    rawPayload: {
      manualReview: true,
      reason: 'REGION_RESTRICTED',
      queuedAt: new Date().toISOString()
    }
  });
  return { success: true, transfer };
}

async function approveManualReview(transferId, adminId) {
  const transfer = await BinanceTransfer.findByPk(transferId);
  if (!transfer) return { success: false, reason: 'NOT_FOUND' };
  if (transfer.status === 'VERIFIED') return { success: true, alreadyProcessed: true, transfer };
  if (transfer.status === 'PAYMENT_CONFIRMED' && transfer.orderId) {
    try {
      const fulfillment = await fulfillOrder(transfer.orderId, { paymentRef: `binance:${transfer.transactionId}` });
      await transfer.update({ status: 'VERIFIED' });
      return { success: true, topup: false, transfer, fulfillment, transactionId: transfer.transactionId };
    } catch (error) {
      return { success: false, reason: error.message, paymentConfirmed: true };
    }
  }
  if (transfer.status !== 'MANUAL_REVIEW') return { success: false, reason: 'NOT_WAITING' };

  const submitted = String(transfer.submittedOrderId || '').trim();
  if (!validSubmittedOrderId(submitted)) return { success: false, reason: 'INVALID_ORDER_ID' };

  const duplicate = await BinanceTransfer.findOne({
    where: {
      id: { [Op.ne]: transfer.id },
      status: { [Op.in]: ['VERIFIED', 'PAYMENT_CONFIRMED'] },
      [Op.or]: [
        { submittedOrderId: submitted },
        { transactionId: submitted }
      ]
    }
  });
  if (duplicate) return { success: false, reason: 'DUPLICATE_TRANSACTION' };

  if (transfer.orderId) {
    try {
      await transfer.update({
        status: 'PAYMENT_CONFIRMED',
        transactionId: submitted,
        verifiedAt: new Date(),
        rawPayload: {
          manualReview: true,
          approvedBy: String(adminId),
          approvedAt: new Date().toISOString(),
          submittedOrderId: submitted
        }
      });
    } catch (error) {
      if (error.name === 'SequelizeUniqueConstraintError') {
        return { success: false, reason: 'DUPLICATE_TRANSACTION' };
      }
      throw error;
    }

    try {
      const fulfillment = await fulfillOrder(transfer.orderId, { paymentRef: `binance:${submitted}` });
      await transfer.update({ status: 'VERIFIED' });
      return { success: true, topup: false, transfer, fulfillment, transactionId: submitted, manual: true };
    } catch (error) {
      return { success: false, reason: error.message, paymentConfirmed: true };
    }
  }

  const transaction = await sequelize.transaction();
  try {
    const lockedTransfer = await BinanceTransfer.findByPk(transfer.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (lockedTransfer.status === 'VERIFIED') {
      await transaction.commit();
      return { success: true, alreadyProcessed: true, transfer: lockedTransfer };
    }
    if (lockedTransfer.status !== 'MANUAL_REVIEW') throw new Error('NOT_WAITING');

    const duplicateLocked = await BinanceTransfer.findOne({
      where: {
        id: { [Op.ne]: lockedTransfer.id },
        status: { [Op.in]: ['VERIFIED', 'PAYMENT_CONFIRMED'] },
        [Op.or]: [
          { submittedOrderId: submitted },
          { transactionId: submitted }
        ]
      },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (duplicateLocked) throw new Error('DUPLICATE_TRANSACTION');

    const ledger = await BalanceTransaction.findByPk(lockedTransfer.balanceTransactionId, { transaction, lock: transaction.LOCK.UPDATE });
    const user = await User.findByPk(lockedTransfer.userId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!ledger || !user) throw new Error('TOPUP_RECORD_NOT_FOUND');

    user.balance = Number(user.balance || 0) + Number(lockedTransfer.expectedAmount);
    await user.save({ transaction });
    ledger.status = 'completed';
    ledger.txid = submitted;
    ledger.caption = `Binance ID manual verification by admin ${adminId} | ${submitted}`;
    await ledger.save({ transaction });
    lockedTransfer.status = 'VERIFIED';
    lockedTransfer.transactionId = submitted;
    lockedTransfer.verifiedAt = new Date();
    lockedTransfer.rawPayload = {
      manualReview: true,
      approvedBy: String(adminId),
      approvedAt: new Date().toISOString(),
      submittedOrderId: submitted
    };
    await lockedTransfer.save({ transaction });
    await transaction.commit();
    return {
      success: true,
      topup: true,
      transfer: lockedTransfer,
      userId: user.id,
      amount: Number(lockedTransfer.expectedAmount),
      newBalance: Number(user.balance),
      transactionId: submitted,
      manual: true
    };
  } catch (error) {
    await transaction.rollback();
    if (error.name === 'SequelizeUniqueConstraintError' || error.message === 'DUPLICATE_TRANSACTION') {
      return { success: false, reason: 'DUPLICATE_TRANSACTION' };
    }
    if (error.message === 'NOT_WAITING') return { success: false, reason: 'NOT_WAITING' };
    throw error;
  }
}

async function rejectManualReview(transferId, adminId) {
  const transfer = await BinanceTransfer.findByPk(transferId);
  if (!transfer) return { success: false, reason: 'NOT_FOUND' };
  if (transfer.status !== 'MANUAL_REVIEW') return { success: false, reason: 'NOT_WAITING' };
  const previousOrderId = transfer.submittedOrderId;
  await transfer.update({
    status: 'WAITING',
    submittedOrderId: null,
    rawPayload: {
      manualReview: true,
      rejectedBy: String(adminId),
      rejectedAt: new Date().toISOString(),
      rejectedOrderId: previousOrderId
    }
  });
  return { success: true, transfer, previousOrderId };
}

async function verify(transferId, submittedOrderId) {
  if (!(await configured())) return { success: false, reason: 'NOT_CONFIGURED' };
  const runtime = await getRuntimeConfig();
  const transfer = await BinanceTransfer.findByPk(transferId);
  if (!transfer) return { success: false, reason: 'NOT_FOUND' };
  if (transfer.status === 'VERIFIED') {
    return { success: true, alreadyProcessed: true, transfer };
  }

  // A Binance transaction may already be confirmed while fulfilment is waiting for stock.
  // Retry fulfilment without querying or charging the same transfer again.
  if (transfer.status === 'PAYMENT_CONFIRMED' && transfer.orderId) {
    try {
      const fulfillment = await fulfillOrder(transfer.orderId, { paymentRef: `binance:${transfer.transactionId}` });
      await transfer.update({ status: 'VERIFIED', verifiedAt: transfer.verifiedAt || new Date() });
      return { success: true, topup: false, transfer, fulfillment, transactionId: transfer.transactionId };
    } catch (error) {
      return { success: false, reason: error.message, paymentConfirmed: true };
    }
  }

  if (transfer.status !== 'WAITING') return { success: false, reason: 'NOT_WAITING' };
  const submitted = String(submittedOrderId || '').trim();
  if (!validSubmittedOrderId(submitted)) return { success: false, reason: 'INVALID_ORDER_ID' };

  const duplicate = await BinanceTransfer.findOne({
    where: {
      id: { [Op.ne]: transfer.id },
      status: { [Op.in]: ['VERIFIED', 'PAYMENT_CONFIRMED'] },
      [Op.or]: [
        { submittedOrderId: submitted },
        { transactionId: submitted }
      ]
    }
  });
  if (duplicate) return { success: false, reason: 'DUPLICATE_TRANSACTION' };

  const createdMs = new Date(transfer.createdAt).getTime();
  const oldestAllowed = Date.now() - runtime.verificationWindowHours * 60 * 60 * 1000;
  const startTime = Math.max(0, oldestAllowed, createdMs - 30 * 60 * 1000);
  const endTime = Date.now() + 60 * 1000;
  let rows;
  try {
    rows = await fetchTransactions(startTime, endTime, runtime);
  } catch (error) {
    const detail = friendlyError(error);
    if (detail === 'REGION_RESTRICTED') {
      return { success: false, reason: 'REGION_RESTRICTED', detail };
    }
    return { success: false, reason: 'API_ERROR', detail };
  }

  const candidates = rows.filter(row => itemMatchesSubmittedId(row, submitted));
  if (!candidates.length) return { success: false, reason: 'NO_MATCH' };

  const expected = Number(transfer.expectedAmount);
  const matched = candidates.find(row => {
    const amount = amountUsdt(row);
    const time = transactionTime(row);
    return isIncoming(row)
      && Math.abs(amount - expected) <= 0.0001
      && (!time || time >= startTime);
  });
  if (!matched) return { success: false, reason: 'AMOUNT_OR_RECEIVER_MISMATCH' };

  const transactionId = uniqueTransactionId(matched);
  const alreadyUsed = await BinanceTransfer.findOne({
    where: { id: { [Op.ne]: transfer.id }, status: { [Op.in]: ['VERIFIED', 'PAYMENT_CONFIRMED'] }, transactionId }
  });
  if (alreadyUsed) return { success: false, reason: 'DUPLICATE_TRANSACTION' };

  if (transfer.orderId) {
    // Reserve the matched Binance transaction before delivery. This prevents a paid
    // transaction from being reused if stock disappears at the same moment.
    try {
      await transfer.update({
        status: 'PAYMENT_CONFIRMED',
        submittedOrderId: submitted,
        transactionId,
        verifiedAt: new Date(),
        rawPayload: matched
      });
    } catch (error) {
      if (error.name === 'SequelizeUniqueConstraintError') return { success: false, reason: 'DUPLICATE_TRANSACTION' };
      throw error;
    }

    try {
      const fulfillment = await fulfillOrder(transfer.orderId, { paymentRef: `binance:${transactionId}` });
      await transfer.update({ status: 'VERIFIED' });
      return { success: true, topup: false, transfer, fulfillment, transactionId };
    } catch (error) {
      return { success: false, reason: error.message, paymentConfirmed: true };
    }
  }

  const transaction = await sequelize.transaction();
  try {
    const lockedTransfer = await BinanceTransfer.findByPk(transfer.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (lockedTransfer.status === 'VERIFIED') {
      await transaction.commit();
      return { success: true, alreadyProcessed: true, transfer: lockedTransfer };
    }
    const ledger = await BalanceTransaction.findByPk(lockedTransfer.balanceTransactionId, { transaction, lock: transaction.LOCK.UPDATE });
    const user = await User.findByPk(lockedTransfer.userId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!ledger || !user) throw new Error('TOPUP_RECORD_NOT_FOUND');
    const duplicateLocked = await BinanceTransfer.findOne({
      where: { id: { [Op.ne]: lockedTransfer.id }, status: { [Op.in]: ['VERIFIED', 'PAYMENT_CONFIRMED'] }, transactionId },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (duplicateLocked) throw new Error('DUPLICATE_TRANSACTION');

    user.balance = Number(user.balance || 0) + Number(lockedTransfer.expectedAmount);
    await user.save({ transaction });
    ledger.status = 'completed';
    ledger.txid = transactionId;
    ledger.caption = `Binance ID verified | ${submitted}`;
    await ledger.save({ transaction });
    lockedTransfer.status = 'VERIFIED';
    lockedTransfer.submittedOrderId = submitted;
    lockedTransfer.transactionId = transactionId;
    lockedTransfer.verifiedAt = new Date();
    lockedTransfer.rawPayload = matched;
    await lockedTransfer.save({ transaction });
    await transaction.commit();
    return {
      success: true,
      topup: true,
      transfer: lockedTransfer,
      userId: user.id,
      amount: Number(lockedTransfer.expectedAmount),
      newBalance: Number(user.balance),
      transactionId
    };
  } catch (error) {
    await transaction.rollback();
    if (error.name === 'SequelizeUniqueConstraintError' || error.message === 'DUPLICATE_TRANSACTION') {
      return { success: false, reason: 'DUPLICATE_TRANSACTION' };
    }
    throw error;
  }
}


async function verifyStandalone({ submittedOrderId, expectedAmount, createdAt }) {
  if (!(await configured())) return { success: false, reason: 'NOT_CONFIGURED' };
  const runtime = await getRuntimeConfig();
  const submitted = String(submittedOrderId || '').trim();
  if (!validSubmittedOrderId(submitted)) return { success: false, reason: 'INVALID_ORDER_ID' };
  const expected = Number(expectedAmount || 0);
  if (!Number.isFinite(expected) || expected <= 0) return { success: false, reason: 'INVALID_AMOUNT' };

  const duplicateTransfer = await BinanceTransfer.findOne({
    where: {
      status: { [Op.in]: ['VERIFIED', 'PAYMENT_CONFIRMED'] },
      [Op.or]: [{ submittedOrderId: submitted }, { transactionId: submitted }]
    }
  });
  const duplicateNetwork = await NetworkPaymentIntent.findOne({
    where: {
      status: 'verified',
      [Op.or]: [{ submittedOrderId: submitted }, { transactionId: submitted }]
    }
  });
  if (duplicateTransfer || duplicateNetwork) return { success: false, reason: 'DUPLICATE_TRANSACTION' };

  const createdMs = new Date(createdAt || Date.now()).getTime();
  const oldestAllowed = Date.now() - runtime.verificationWindowHours * 60 * 60 * 1000;
  const startTime = Math.max(0, oldestAllowed, createdMs - 30 * 60 * 1000);
  const endTime = Date.now() + 60 * 1000;
  let rows;
  try {
    rows = await fetchTransactions(startTime, endTime, runtime);
  } catch (error) {
    const detail = friendlyError(error);
    return { success: false, reason: detail === 'REGION_RESTRICTED' ? 'REGION_RESTRICTED' : 'API_ERROR', detail };
  }
  const candidates = rows.filter(row => itemMatchesSubmittedId(row, submitted));
  if (!candidates.length) return { success: false, reason: 'NO_MATCH' };
  const matched = candidates.find(row => {
    const amount = amountUsdt(row);
    const time = transactionTime(row);
    return isIncoming(row) && Math.abs(amount - expected) <= 0.0001 && (!time || time >= startTime);
  });
  if (!matched) return { success: false, reason: 'AMOUNT_OR_RECEIVER_MISMATCH' };
  const transactionId = uniqueTransactionId(matched);
  const alreadyUsedTransfer = await BinanceTransfer.findOne({ where: { transactionId, status: { [Op.in]: ['VERIFIED', 'PAYMENT_CONFIRMED'] } } });
  const alreadyUsedNetwork = await NetworkPaymentIntent.findOne({ where: { transactionId, status: 'verified' } });
  if (alreadyUsedTransfer || alreadyUsedNetwork) return { success: false, reason: 'DUPLICATE_TRANSACTION' };
  return { success: true, transactionId, rawPayload: matched };
}

module.exports = {
  configured,
  getRuntimeConfig,
  createForTopup,
  createForOrder,
  instructions,
  verify,
  verifyStandalone,
  queueManualReview,
  approveManualReview,
  rejectManualReview
};
