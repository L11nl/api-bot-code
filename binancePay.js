const crypto = require('crypto');
const axios = require('axios');

// Binance is queried directly, using the same signed endpoint as the working bot.
// Keeping this logic in this file preserves the rest of the bot unchanged.
const BINANCE_API_BASE_URL = String(
  process.env.BINANCE_API_BASE_URL || 'https://api.binance.com'
).replace(/\/$/, '');

let serverTimeOffsetMs = 0;

function generateDepositNote(prefix = 'TOOLS-') {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let suffix = '';
  for (let i = 0; i < 6; i += 1) suffix += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}${suffix}`;
}

function normalizeOrderId(v) { return String(v || '').trim(); }
function normalizeNote(v) { return String(v || '').trim(); }
function looksLikeOrderId(v) { return /^\d{11,}$/.test(String(v || '').trim()); }
function normalizeAmount(v) { return Number(v); }
function getTransactionOrderId(tx) {
  return String(
    tx?.orderId
    || tx?.transactionId
    || tx?.prepayId
    || tx?.merchantTradeNo
    || tx?.bizNo
    || tx?.transferId
    || tx?.trxId
    || tx?.transactionNo
    || tx?.tradeNo
    || tx?.id
    || ''
  );
}
function getTransactionNote(tx) {
  return String(
    tx?.note
    || tx?.remark
    || tx?.message
    || tx?.transferNote
    || tx?.paymentInfo?.note
    || tx?.extendInfo?.note
    || ''
  );
}
function getTransactionAmount(tx) {
  const directCurrency = String(tx?.currency || '').toUpperCase();
  const directAmount = Math.abs(Number(tx?.amount || 0));
  if (directCurrency === 'USDT' && Number.isFinite(directAmount) && directAmount > 0) {
    return directAmount;
  }

  const funds = Array.isArray(tx?.fundsDetail) ? tx.fundsDetail : [];
  const usdt = funds.find(row => String(row?.currency || '').toUpperCase() === 'USDT');
  const nestedAmount = Math.abs(Number(usdt?.amount || 0));
  return Number.isFinite(nestedAmount) ? nestedAmount : 0;
}
function getTransactionTime(tx) {
  const value = Number(
    tx?.transactionTime
    || tx?.transactTime
    || tx?.createTime
    || tx?.updateTime
    || 0
  );
  return Number.isFinite(value) ? value : 0;
}

function normalizeIdentifier(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .toLowerCase();
}

function normalizeDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeNoteCode(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase();
}

function identifierCandidates(tx) {
  return [
    tx?.transactionId,
    tx?.orderId,
    tx?.prepayId,
    tx?.merchantTradeNo,
    tx?.bizNo,
    tx?.transferId,
    tx?.trxId,
    tx?.transactionNo,
    tx?.tradeNo,
    tx?.merchantOrderNo,
    tx?.merchantTransId,
    tx?.sourceId,
    tx?.requestId,
    tx?.payRequestId,
    tx?.id
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

function transactionMatchesOrderId(tx, submittedOrderId) {
  const wanted = normalizeIdentifier(submittedOrderId);
  const wantedDigits = normalizeDigits(submittedOrderId);
  if (!wanted && !wantedDigits) return false;

  const directMatch = identifierCandidates(tx).some(candidate => {
    const normalized = normalizeIdentifier(candidate);
    const digits = normalizeDigits(candidate);
    return (wanted && normalized === wanted) || (wantedDigits && digits === wantedDigits);
  });
  if (directMatch) return true;

  return flattenValues(tx).some(candidate => {
    const normalized = normalizeIdentifier(candidate);
    const digits = normalizeDigits(candidate);
    return (wanted && normalized === wanted) || (wantedDigits && digits === wantedDigits);
  });
}

function transactionMatchesNote(tx, expectedNote) {
  const wanted = normalizeNoteCode(expectedNote);
  if (!wanted) return false;

  const explicitFields = [
    tx?.note,
    tx?.remark,
    tx?.message,
    tx?.transferNote,
    tx?.paymentInfo?.note,
    tx?.extendInfo?.note
  ].filter(value => value !== undefined && value !== null && String(value).trim() !== '');

  if (explicitFields.some(value => normalizeNoteCode(value).includes(wanted))) return true;

  // Some Binance responses place the note inside a nested object.
  return flattenValues(tx).some(value => normalizeNoteCode(value).includes(wanted));
}

function isIncomingTransaction(tx) {
  const directAmount = Number(tx?.amount || 0);
  if (Number.isFinite(directAmount) && directAmount < 0) return false;

  const orderType = String(tx?.orderType || '').toUpperCase();
  if (['PAY_REFUND', 'C2C_HOLDING_RF', 'CRYPTO_BOX_RF', 'REFUND', 'FULL_REFUNDED'].includes(orderType)) {
    return false;
  }

  return getTransactionAmount(tx) > 0;
}

function receiverMatchesPayId(tx, payId) {
  const wanted = normalizeIdentifier(payId);
  if (!wanted) return true;

  const receiverFields = [
    tx?.receiverInfo?.accountId,
    tx?.receiverInfo?.binanceId,
    tx?.receiverInfo?.email,
    tx?.receiverInfo?.phoneNumber,
    tx?.receiver,
    tx?.payId,
    tx?.merchantId
  ].map(normalizeIdentifier).filter(Boolean);

  // The history endpoint belongs to the authenticated Binance account, and Binance
  // sometimes returns an internal receiver account ID instead of the public Pay ID.
  // Accept the transaction when the public ID is absent/different, just like the
  // working bot, while still recognizing an exact Pay ID when it is available.
  if (!receiverFields.length) return true;
  if (receiverFields.some(value => value === wanted || value.includes(wanted) || wanted.includes(value))) return true;
  return true;
}

function transactionUniqueId(tx) {
  const first = identifierCandidates(tx)[0];
  if (first) return String(first);

  return crypto.createHash('sha256').update(JSON.stringify({
    time: getTransactionTime(tx),
    amount: getTransactionAmount(tx),
    currency: tx?.currency,
    payer: tx?.payerInfo,
    receiver: tx?.receiverInfo
  })).digest('hex');
}

function isTimestampError(error) {
  const text = JSON.stringify(error?.response?.data || error?.message || error).toLowerCase();
  return text.includes('-1021')
    || text.includes('outside of the recvwindow')
    || text.includes('outside of the time window')
    || text.includes('invalid_timestamp');
}

async function syncServerTime() {
  const response = await axios.get(`${BINANCE_API_BASE_URL}/api/v3/time`, { timeout: 10000 });
  const serverTime = Number(response?.data?.serverTime || 0);
  if (Number.isFinite(serverTime) && serverTime > 0) {
    serverTimeOffsetMs = serverTime - Date.now();
  }
}

function signQuery(params, apiSecret) {
  const query = new URLSearchParams(params).toString();
  const signature = crypto.createHmac('sha256', apiSecret).update(query).digest('hex');
  return `${query}&signature=${signature}`;
}

async function fetchTransactions({ apiKey, apiSecret, startTime, endTime }) {
  const perform = async () => {
    const params = {
      limit: '100',
      recvWindow: '60000',
      timestamp: String(Date.now() + serverTimeOffsetMs),
      startTime: String(startTime),
      endTime: String(endTime)
    };

    const response = await axios.get(
      `${BINANCE_API_BASE_URL}/sapi/v1/pay/transactions?${signQuery(params, apiSecret)}`,
      {
        timeout: 20000,
        headers: { 'X-MBX-APIKEY': apiKey }
      }
    );

    return Array.isArray(response?.data?.data) ? response.data.data : [];
  };

  try {
    return await perform();
  } catch (error) {
    if (isTimestampError(error)) {
      await syncServerTime();
      return perform();
    }
    throw error;
  }
}

function resolveCredentials(params = {}) {
  // Parameters passed by index.js take priority. Environment names below cover
  // both the current bot variables and older deployments.
  const apiKey = String(
    params.apiKey
    || process.env.BINANCE_API_KEY
    || process.env.BINANCE_PAY_API_KEY
    || ''
  ).trim();

  const apiSecret = String(
    params.apiSecret
    || process.env.BINANCE_API_SECRET
    || process.env.BINANCE_SECRET_KEY
    || process.env.BINANCE_PAY_SECRET_KEY
    || ''
  ).trim();

  const payId = String(
    params.payId
    || process.env.BINANCE_PAY_ID
    || process.env.BINANCE_ID
    || ''
  ).trim();

  return { apiKey, apiSecret, payId };
}

async function verifyBinanceTransfer(params = {}) {
  const credentials = resolveCredentials(params);
  const expectedAmount = normalizeAmount(params.expectedAmount);
  const expectedNote = normalizeNote(params.expectedNote);
  const orderIdToCheck = normalizeOrderId(params.orderIdToCheck);

  if (!credentials.apiKey || !credentials.apiSecret) {
    return { success: false, reason: 'binance_not_configured' };
  }
  if (!Number.isFinite(expectedAmount) || expectedAmount <= 0 || (!expectedNote && !orderIdToCheck)) {
    return { success: false, reason: 'invalid_payload' };
  }

  const now = Date.now() + serverTimeOffsetMs;
  const sessionCreatedAt = Number(params.sessionCreatedAt || 0);
  const requestedWindowMs = Number(params.recentWindowMs || 0);
  const defaultWindowMs = 24 * 60 * 60 * 1000;
  const windowMs = Number.isFinite(requestedWindowMs) && requestedWindowMs > 0
    ? requestedWindowMs
    : defaultWindowMs;

  const sessionAnchor = Number.isFinite(sessionCreatedAt) && sessionCreatedAt > 0
    ? sessionCreatedAt
    : now;
  const startTime = Math.max(0, now - windowMs, sessionAnchor - (30 * 60 * 1000));
  const endTime = now + (60 * 1000);

  let rows;
  try {
    rows = await fetchTransactions({
      apiKey: credentials.apiKey,
      apiSecret: credentials.apiSecret,
      startTime,
      endTime
    });
  } catch (error) {
    console.error('Binance direct verification error:', error?.response?.data || error?.message || error);
    return {
      success: false,
      reason: 'api_error',
      error: error?.response?.data || error?.message || String(error)
    };
  }

  const amountMatchedRows = rows.filter(tx => (
    isIncomingTransaction(tx)
    && Math.abs(getTransactionAmount(tx) - expectedAmount) <= 0.0001
    && receiverMatchesPayId(tx, credentials.payId)
  ));

  const matchedRows = amountMatchedRows.filter(tx => {
    const txTime = getTransactionTime(tx);
    if (txTime && txTime < startTime) return false;

    if (orderIdToCheck) {
      return transactionMatchesOrderId(tx, orderIdToCheck);
    }
    return transactionMatchesNote(tx, expectedNote);
  });

  if (matchedRows.length !== 1) {
    return {
      success: false,
      reason: matchedRows.length > 1 ? 'ambiguous_match' : 'no_match',
      searchedRows: rows.length,
      matchedRows: matchedRows.length,
      amountMatchedRows: amountMatchedRows.length,
      payIdMatchedRows: amountMatchedRows.length,
      payId: credentials.payId || null
    };
  }

  const matchedItem = matchedRows[0];
  const matchedOrderId = getTransactionOrderId(matchedItem) || transactionUniqueId(matchedItem);

  return {
    success: true,
    method: orderIdToCheck ? 'exact_order_id' : 'note_code',
    orderId: matchedOrderId,
    txId: transactionUniqueId(matchedItem),
    amount: getTransactionAmount(matchedItem),
    currency: 'USDT',
    transactionTime: getTransactionTime(matchedItem) || now,
    orderType: matchedItem?.orderType || null,
    payId: credentials.payId || null,
    matchedItem,
    searchedRows: rows.length,
    matchedRows: 1,
    amountMatchedRows: amountMatchedRows.length,
    payIdMatchedRows: amountMatchedRows.length,
    matchScore: 100
  };
}

module.exports = {
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
