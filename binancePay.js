const crypto = require('crypto');
const axios = require('axios');

let serverTimeOffsetMs = 0;

function generateDepositNote(prefix = 'TOOLS-') {
  const normalizedPrefix = String(prefix || 'TOOLS-').trim() || 'TOOLS-';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let suffix = '';
  for (let i = 0; i < 6; i += 1) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${normalizedPrefix}${suffix}`;
}

function normalizeOrderId(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
}

function normalizeNote(value) {
  return String(value || '').trim().toUpperCase();
}

function looksLikeOrderId(value) {
  return /^\d{11,}$/.test(String(value || '').trim());
}

function normalizeAmount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return NaN;
  return Number(parsed.toFixed(8));
}

function getClientTimestamp() {
  return Date.now() + serverTimeOffsetMs;
}

async function syncServerTimeOffset() {
  try {
    const response = await axios.get('https://api.binance.com/api/v3/time', { timeout: 10000 });
    const serverTime = Number(response?.data?.serverTime || 0);
    if (Number.isFinite(serverTime) && serverTime > 0) {
      serverTimeOffsetMs = serverTime - Date.now();
      return true;
    }
  } catch (error) {
    // ignore; we will fall back to local time
  }
  return false;
}

function isTimestampError(errorValue) {
  const haystack = JSON.stringify(errorValue || '').toLowerCase();
  return haystack.includes('invalid_timestamp')
    || haystack.includes('outside the time window')
    || haystack.includes('-1021');
}

function buildSignedQuery({ apiSecret, params }) {
  const query = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    query.set(key, String(value));
  });
  const queryString = query.toString();
  const signature = crypto.createHmac('sha256', String(apiSecret || '')).update(queryString).digest('hex');
  return `${queryString}&signature=${signature}`;
}

async function fetchTransactions({ apiKey, apiSecret, startTime = null, endTime = null, limit = 100 }) {
  if (!apiKey || !apiSecret) {
    return { ok: false, reason: 'missing_credentials', rows: [] };
  }

  const requestOnce = async () => {
    const params = {
      limit,
      recvWindow: 60000,
      timestamp: getClientTimestamp()
    };

    if (Number.isFinite(Number(startTime)) && Number(startTime) > 0) params.startTime = Number(startTime);
    if (Number.isFinite(Number(endTime)) && Number(endTime) > 0) params.endTime = Number(endTime);

    const signed = buildSignedQuery({ apiSecret, params });
    const url = `https://api.binance.com/sapi/v1/pay/transactions?${signed}`;

    try {
      const response = await axios.get(url, {
        timeout: 20000,
        headers: {
          'X-MBX-APIKEY': String(apiKey)
        }
      });

      const payload = response?.data || {};
      return {
        ok: true,
        rows: Array.isArray(payload.data) ? payload.data : [],
        raw: payload
      };
    } catch (error) {
      return {
        ok: false,
        reason: 'api_error',
        error: error?.response?.data || error?.message || 'API error',
        rows: []
      };
    }
  };

  let result = await requestOnce();
  if (!result.ok && isTimestampError(result.error)) {
    const synced = await syncServerTimeOffset();
    if (synced) {
      result = await requestOnce();
    }
  }

  return result;
}

function getTransactionTime(transaction) {
  const value = Number(
    transaction?.transactionTime
    || transaction?.transactTime
    || transaction?.createTime
    || transaction?.time
    || 0
  );
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function getTransactionAmount(transaction) {
  const directAmount = Number(transaction?.amount || 0);
  const directCurrency = String(transaction?.currency || '').toUpperCase();

  if (directCurrency === 'USDT' && Number.isFinite(directAmount)) {
    return Math.abs(directAmount);
  }

  const fundsDetail = Array.isArray(transaction?.fundsDetail) ? transaction.fundsDetail : [];
  const usdtRow = fundsDetail.find((item) => String(item?.currency || '').toUpperCase() === 'USDT');
  const detailedAmount = Number(usdtRow?.amount || 0);
  if (Number.isFinite(detailedAmount) && detailedAmount > 0) {
    return Math.abs(detailedAmount);
  }

  return Number.isFinite(directAmount) ? Math.abs(directAmount) : 0;
}

function getTransactionOrderId(transaction) {
  const candidates = [
    transaction?.orderId,
    transaction?.transactionId,
    transaction?.prepayId,
    transaction?.merchantTradeNo,
    transaction?.transactionNo,
    transaction?.tradeNo,
    transaction?.trxId,
    transaction?.id
  ];

  for (const candidate of candidates) {
    const normalized = normalizeOrderId(candidate);
    if (normalized) return normalized;
  }

  return '';
}

function getTransactionNote(transaction) {
  const candidates = [
    transaction?.note,
    transaction?.remark,
    transaction?.memo,
    transaction?.extendInfo?.note,
    transaction?.extend?.note
  ];

  for (const candidate of candidates) {
    const normalized = normalizeNote(candidate);
    if (normalized) return normalized;
  }

  return '';
}

function getReceiverCandidates(transaction) {
  return [
    transaction?.receiverInfo?.accountId,
    transaction?.receiverInfo?.binanceId,
    transaction?.receiverInfo?.email,
    transaction?.receiver,
    transaction?.payId,
    transaction?.merchantId
  ].map(normalizeOrderId).filter(Boolean);
}

function isLikelyIncomingPayment(transaction, expectedPayId = '') {
  const amount = getTransactionAmount(transaction);
  if (!Number.isFinite(amount) || amount <= 0) return false;

  const directAmount = Number(transaction?.amount || 0);
  if (Number.isFinite(directAmount) && directAmount < 0) return false;

  const normalizedPayId = normalizeOrderId(expectedPayId);
  if (!normalizedPayId) return true;

  const receivers = getReceiverCandidates(transaction);
  if (!receivers.length) return true;

  return receivers.some((receiver) => receiver === normalizedPayId || receiver.includes(normalizedPayId) || normalizedPayId.includes(receiver));
}

function buildHistoryWindows(sessionCreatedAt) {
  const now = getClientTimestamp();
  const createdAt = Number(sessionCreatedAt || 0);
  const anchor = Number.isFinite(createdAt) && createdAt > 0 ? Math.min(createdAt, now) : now;

  const windows = [
    { startTime: null, endTime: null },
    { startTime: Math.max(now - (30 * 60 * 1000), anchor - (5 * 60 * 1000)), endTime: now },
    { startTime: Math.max(now - (2 * 60 * 60 * 1000), anchor - (30 * 60 * 1000)), endTime: now },
    { startTime: Math.max(now - (24 * 60 * 60 * 1000), anchor - (2 * 60 * 60 * 1000)), endTime: now }
  ];

  const seen = new Set();
  return windows.filter((window) => {
    const key = `${window.startTime || 'latest'}:${window.endTime || 'latest'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getTransactionUniqueKey(transaction) {
  const orderId = getTransactionOrderId(transaction);
  if (orderId) return orderId;
  return [
    getTransactionTime(transaction),
    getTransactionAmount(transaction),
    normalizeNote(getTransactionNote(transaction))
  ].join(':');
}

async function fetchCandidateTransactions({ apiKey, apiSecret, sessionCreatedAt = null }) {
  const rows = [];
  const seen = new Set();
  let anySuccess = false;
  let lastError = null;

  for (const window of buildHistoryWindows(sessionCreatedAt)) {
    const result = await fetchTransactions({
      apiKey,
      apiSecret,
      startTime: window.startTime,
      endTime: window.endTime,
      limit: 100
    });

    if (!result.ok) {
      lastError = result.error || result.reason || lastError;
      continue;
    }

    anySuccess = true;
    for (const transaction of result.rows || []) {
      const key = getTransactionUniqueKey(transaction);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(transaction);
    }
  }

  rows.sort((a, b) => getTransactionTime(b) - getTransactionTime(a));

  return {
    ok: anySuccess,
    error: anySuccess ? null : (lastError || 'API error'),
    rows
  };
}

async function verifyBinanceTransfer({
  apiKey,
  apiSecret,
  payId = '',
  expectedAmount,
  expectedNote = '',
  orderIdToCheck = '',
  sessionCreatedAt = null
}) {
  const amount = normalizeAmount(expectedAmount);
  const note = normalizeNote(expectedNote);
  const orderId = normalizeOrderId(orderIdToCheck);

  if (!apiKey || !apiSecret) {
    return { success: false, reason: 'missing_credentials' };
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return { success: false, reason: 'invalid_amount' };
  }

  if (!note && !orderId) {
    return { success: false, reason: 'missing_match_key' };
  }

  const fetched = await fetchCandidateTransactions({ apiKey, apiSecret, sessionCreatedAt });
  if (!fetched.ok) {
    return { success: false, reason: 'api_error', error: fetched.error || null, rows: [] };
  }

  const rows = fetched.rows || [];
  for (const transaction of rows) {
    if (!isLikelyIncomingPayment(transaction, payId)) continue;

    const actualAmount = getTransactionAmount(transaction);
    const txNote = getTransactionNote(transaction);
    const txOrderId = getTransactionOrderId(transaction);

    const matchesOrder = orderId && txOrderId && normalizeOrderId(txOrderId) === orderId;
    const matchesNote = note && txNote && normalizeNote(txNote) === note;

    if ((matchesOrder || matchesNote) && actualAmount >= amount) {
      return {
        success: true,
        method: matchesOrder ? 'order_id' : 'note',
        amount: actualAmount,
        currency: 'USDT',
        orderId: txOrderId || orderId,
        note: txNote || note,
        transactionTime: getTransactionTime(transaction),
        matchedTransaction: transaction,
        searchedRows: rows.length
      };
    }
  }

  return {
    success: false,
    reason: 'not_found',
    rows
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
