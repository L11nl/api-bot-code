const crypto = require('crypto');
const axios = require('axios');

// This module is a compatibility port of the working Binance ID verifier
// from the first bot. It uses the same environment-variable names,
// endpoint, signature, time synchronization, and matching rules.

let serverTimeOffsetMs = 0;

function cleanEnv(value) {
  const text = String(value || '').trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1).trim();
  }
  return text;
}

function getConfig(params = {}) {
  const apiKey = cleanEnv(
    process.env.BINANCE_API_KEY ||
    process.env.BINANCE_PAY_API_KEY ||
    params.apiKey ||
    ''
  );

  const secretKey = cleanEnv(
    process.env.BINANCE_API_SECRET ||
    process.env.BINANCE_SECRET_KEY ||
    process.env.BINANCE_PAY_SECRET_KEY ||
    params.apiSecret ||
    ''
  );

  const payId = cleanEnv(
    process.env.BINANCE_PAY_ID ||
    process.env.BINANCE_ID ||
    params.payId ||
    ''
  );

  return {
    apiKey,
    secretKey,
    payId,
    baseUrl: cleanEnv(process.env.BINANCE_API_BASE_URL || 'https://api.binance.com').replace(/\/$/, ''),
    verificationWindowHours: Math.min(24, Math.max(1, Number(process.env.BINANCE_VERIFY_WINDOW_HOURS || 6)))
  };
}

function configured(params = {}) {
  const config = getConfig(params);
  return Boolean(config.apiKey && config.secretKey && config.payId);
}

function generateDepositNote() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 6; i += 1) suffix += chars[Math.floor(Math.random() * chars.length)];
  return `CD-${suffix}`;
}

function normalizeOrderId(value) {
  return String(value || '').trim();
}

function normalizeNote(value) {
  return String(value || '').trim();
}

function looksLikeOrderId(value) {
  return /^[A-Za-z0-9_-]{6,128}$/.test(String(value || '').trim());
}

function normalizeAmount(value) {
  return Number(value);
}

function normalizeIdentifier(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
}

function normalizeDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function getTransactionAmount(item) {
  const currency = String(item?.currency || '').toUpperCase();
  const direct = Math.abs(Number(item?.amount || 0));
  if (currency === 'USDT' && Number.isFinite(direct) && direct > 0) return direct;

  const funds = Array.isArray(item?.fundsDetail) ? item.fundsDetail : [];
  const usdt = funds.find(row => String(row?.currency || '').toUpperCase() === 'USDT');
  const nested = Math.abs(Number(usdt?.amount || 0));
  return Number.isFinite(nested) ? nested : 0;
}

function getTransactionTime(item) {
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

function getTransactionOrderId(item) {
  const first = identifierCandidates(item)[0];
  return first ? String(first) : '';
}

function getTransactionNote(item) {
  const fields = [
    item?.note,
    item?.remark,
    item?.message,
    item?.transferNote,
    item?.paymentInfo?.note,
    item?.extendInfo?.note
  ].filter(value => value !== undefined && value !== null && String(value).trim() !== '');
  return fields.length ? String(fields[0]) : '';
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
    time: getTransactionTime(item),
    amount: getTransactionAmount(item),
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
  return getTransactionAmount(item) > 0;
}

function signedQuery(params, secretKey) {
  const query = new URLSearchParams(params).toString();
  const signature = crypto.createHmac('sha256', secretKey).update(query).digest('hex');
  return `${query}&signature=${signature}`;
}

async function syncServerTime(config) {
  const response = await axios.get(`${config.baseUrl}/api/v3/time`, { timeout: 10000 });
  const serverTime = Number(response.data?.serverTime || 0);
  if (serverTime > 0) serverTimeOffsetMs = serverTime - Date.now();
}

function isTimestampError(error) {
  const text = JSON.stringify(error?.response?.data || error?.message || error).toLowerCase();
  return text.includes('-1021') || text.includes('outside of the recvwindow') || text.includes('outside of the time window');
}

function friendlyError(error) {
  const data = error?.response?.data;
  const message = data?.msg || data?.message || error?.message || String(error);
  if (String(message).includes('-2015') || /Invalid API-key, IP, or permissions/i.test(message)) {
    return 'BINANCE_API_PERMISSION';
  }
  return message;
}

function diagnosticCode(error) {
  return [
    error?.response?.data?.code,
    error?.code,
    error?.response?.status
  ].filter(value => value !== undefined && value !== null && String(value) !== '').join('/');
}

async function fetchTransactions(config, startTime, endTime) {
  const perform = async () => {
    const params = {
      limit: '100',
      recvWindow: '60000',
      timestamp: String(Date.now() + serverTimeOffsetMs),
      startTime: String(startTime),
      endTime: String(endTime)
    };

    const response = await axios.get(
      `${config.baseUrl}/sapi/v1/pay/transactions?${signedQuery(params, config.secretKey)}`,
      {
        timeout: 20000,
        headers: { 'X-MBX-APIKEY': config.apiKey }
      }
    );

    return Array.isArray(response.data?.data) ? response.data.data : [];
  };

  try {
    return await perform();
  } catch (error) {
    if (isTimestampError(error)) {
      await syncServerTime(config);
      return perform();
    }
    throw error;
  }
}

async function verifyBinanceTransfer(params = {}) {
  const config = getConfig(params);
  if (!configured(params)) {
    return { success: false, reason: 'binance_not_configured' };
  }

  const expectedAmount = Number(params.expectedAmount || 0);
  const verificationCode = String(params.expectedNote || '').trim();
  const submittedOrderId = String(params.orderIdToCheck || '').trim();

  if (!Number.isFinite(expectedAmount) || expectedAmount <= 0 || !verificationCode) {
    return { success: false, reason: 'invalid_payload' };
  }

  if (!looksLikeOrderId(submittedOrderId)) {
    return { success: false, reason: 'no_match' };
  }

  const createdMs = Number(params.sessionCreatedAt || Date.now());
  const oldestAllowed = Date.now() - config.verificationWindowHours * 60 * 60 * 1000;
  const startTime = Math.max(0, oldestAllowed, createdMs - 30 * 60 * 1000);
  const endTime = Date.now() + 60 * 1000;

  let rows;
  try {
    rows = await fetchTransactions(config, startTime, endTime);
  } catch (error) {
    const detail = friendlyError(error);
    const diagnostic = diagnosticCode(error);
    console.error('[Binance ID] API verification failed:', {
      baseUrl: config.baseUrl,
      status: error?.response?.status || null,
      code: error?.response?.data?.code || error?.code || null,
      message: detail
    });
    return {
      success: false,
      reason: 'api_error',
      detail,
      diagnostic: diagnostic || null
    };
  }

  const candidates = rows.filter(row => itemMatchesSubmittedId(row, submittedOrderId));
  if (!candidates.length) {
    return { success: false, reason: 'no_match', searchedRows: rows.length };
  }

  const matched = candidates.find(row => {
    const amount = getTransactionAmount(row);
    const time = getTransactionTime(row);
    const noteState = noteMatchState(row, verificationCode);
    return isIncoming(row)
      && Math.abs(amount - expectedAmount) <= 0.0001
      && (!time || time >= startTime)
      && noteState !== 'MISMATCH';
  });

  if (!matched) {
    return {
      success: false,
      reason: 'no_match',
      searchedRows: rows.length,
      matchedRows: candidates.length
    };
  }

  const transactionId = uniqueTransactionId(matched);
  return {
    success: true,
    method: 'exact_order_id',
    amount: getTransactionAmount(matched),
    txId: transactionId,
    orderId: transactionId,
    rawOrderId: submittedOrderId,
    currency: 'USDT',
    transactionTime: getTransactionTime(matched) || Date.now(),
    orderType: matched?.orderType || null,
    payId: config.payId,
    matchedItem: matched,
    searchedRows: rows.length,
    matchedRows: candidates.length,
    amountMatchedRows: 1,
    payIdMatchedRows: 1,
    matchScore: 100
  };
}

module.exports = {
  configured,
  generateDepositNote,
  normalizeOrderId,
  normalizeNote,
  looksLikeOrderId,
  normalizeAmount,
  verifyBinanceTransfer,
  getTransactionOrderId,
  getTransactionNote,
  getTransactionAmount,
  getTransactionTime
};
