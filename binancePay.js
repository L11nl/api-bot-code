const crypto = require('crypto');
const https = require('https');
const axios = require('axios');

// This file intentionally uses the same Binance account-history endpoint and
// signature method as the working bot. No Render middleware/proxy is used.
const BINANCE_API_BASE_URL = String(
  process.env.BINANCE_API_BASE_URL || 'https://api.binance.com'
).replace(/\/$/, '');

// Force a direct IPv4 HTTPS connection. `proxy: false` also prevents Axios
// from using HTTP_PROXY / HTTPS_PROXY variables left from an older deployment.
const httpsAgent = new https.Agent({
  keepAlive: true,
  family: 4,
  maxSockets: 10
});

const http = axios.create({
  timeout: 20000,
  httpsAgent,
  proxy: false,
  headers: {
    Accept: 'application/json'
  }
});

let serverTimeOffsetMs = 0;
let serverTimeWasSynced = false;

function generateDepositNote(prefix = 'TOOLS-') {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 6; i += 1) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${prefix}${suffix}`;
}

function normalizeOrderId(value) {
  return String(value || '').trim();
}

function normalizeNote(value) {
  return String(value || '').trim();
}

// Binance identifiers are not guaranteed to be digits only.
function looksLikeOrderId(value) {
  return /^[A-Za-z0-9_-]{6,128}$/.test(String(value || '').trim());
}

function normalizeAmount(value) {
  return Number(value);
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
    item?.merchantOrderNo,
    item?.merchantTransId,
    item?.sourceId,
    item?.requestId,
    item?.payRequestId,
    item?.id
  ].filter(value => value !== undefined && value !== null && String(value).trim() !== '');
}

function getTransactionOrderId(item) {
  const first = identifierCandidates(item)[0];
  return first === undefined ? '' : String(first);
}

function getTransactionNote(item) {
  const fields = [
    item?.note,
    item?.remark,
    item?.message,
    item?.transferNote,
    item?.paymentInfo?.note,
    item?.extendInfo?.note
  ];
  const first = fields.find(value => value !== undefined && value !== null && String(value).trim() !== '');
  return first === undefined ? '' : String(first);
}

function getTransactionAmount(item) {
  const currency = String(item?.currency || '').toUpperCase();
  const direct = Math.abs(Number(item?.amount || 0));
  if (currency === 'USDT' && Number.isFinite(direct) && direct > 0) {
    return direct;
  }

  const funds = Array.isArray(item?.fundsDetail) ? item.fundsDetail : [];
  const usdt = funds.find(row => String(row?.currency || '').toUpperCase() === 'USDT');
  const nested = Math.abs(Number(usdt?.amount || 0));
  return Number.isFinite(nested) ? nested : 0;
}

function getTransactionTime(item) {
  const value = Number(
    item?.transactionTime
    || item?.transactTime
    || item?.createTime
    || item?.updateTime
    || 0
  );
  return Number.isFinite(value) ? value : 0;
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
  if (!wanted && !wantedDigits) return false;

  const directMatch = identifierCandidates(item).some(candidate => {
    const normalized = normalizeIdentifier(candidate);
    const digits = normalizeDigits(candidate);
    return (wanted && normalized === wanted)
      || (wantedDigits && digits === wantedDigits);
  });

  if (directMatch) return true;

  return flattenValues(item).some(candidate => {
    const normalized = normalizeIdentifier(candidate);
    const digits = normalizeDigits(candidate);
    return (wanted && normalized === wanted)
      || (wantedDigits && digits === wantedDigits);
  });
}

function itemMatchesNote(item, expectedNote) {
  const wanted = normalizeNoteCode(expectedNote);
  if (!wanted) return false;

  const explicitFields = [
    item?.note,
    item?.remark,
    item?.message,
    item?.transferNote,
    item?.paymentInfo?.note,
    item?.extendInfo?.note
  ].filter(value => value !== undefined && value !== null && String(value).trim() !== '');

  if (explicitFields.some(value => normalizeNoteCode(value).includes(wanted))) {
    return true;
  }

  // Some Binance responses put the note inside a nested object.
  return flattenValues(item).some(value => normalizeNoteCode(value).includes(wanted));
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
  if ([
    'PAY_REFUND',
    'C2C_HOLDING_RF',
    'CRYPTO_BOX_RF',
    'REFUND',
    'FULL_REFUNDED'
  ].includes(orderType)) {
    return false;
  }

  return getTransactionAmount(item) > 0;
}

function resolveCredentials(params = {}) {
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

function signedQuery(params, apiSecret) {
  const query = new URLSearchParams(params).toString();
  const signature = crypto.createHmac('sha256', apiSecret).update(query).digest('hex');
  return `${query}&signature=${signature}`;
}

function isTimestampError(error) {
  const text = JSON.stringify(error?.response?.data || error?.message || error).toLowerCase();
  return text.includes('-1021')
    || text.includes('outside of the recvwindow')
    || text.includes('outside of the time window')
    || text.includes('invalid_timestamp');
}

function isRetryableNetworkError(error) {
  if (!error) return false;
  if (!error.response) return true;
  const status = Number(error.response.status || 0);
  return status === 408 || status === 418 || status === 429 || status >= 500;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function syncServerTime() {
  const response = await http.get(`${BINANCE_API_BASE_URL}/api/v3/time`, {
    timeout: 10000
  });

  const serverTime = Number(response.data?.serverTime || 0);
  if (!Number.isFinite(serverTime) || serverTime <= 0) {
    throw new Error('Invalid Binance server time response');
  }

  serverTimeOffsetMs = serverTime - Date.now();
  serverTimeWasSynced = true;
  return serverTime;
}

async function fetchTransactions(credentials, startTime, endTime) {
  // Sync before the first signed request. This avoids a failed first attempt on
  // Railway instances whose clock differs from Binance.
  if (!serverTimeWasSynced) {
    try {
      await syncServerTime();
    } catch (error) {
      // The signed request can still succeed, so do not fail only because the
      // public time endpoint was temporarily unavailable.
      console.error('[Binance] Initial time sync failed:', error?.message || error);
    }
  }

  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const params = {
      limit: '100',
      recvWindow: '60000',
      timestamp: String(Date.now() + serverTimeOffsetMs),
      startTime: String(startTime),
      endTime: String(endTime)
    };

    try {
      const response = await http.get(
        `${BINANCE_API_BASE_URL}/sapi/v1/pay/transactions?${signedQuery(params, credentials.apiSecret)}`,
        {
          headers: { 'X-MBX-APIKEY': credentials.apiKey }
        }
      );

      return Array.isArray(response.data?.data) ? response.data.data : [];
    } catch (error) {
      lastError = error;

      if (isTimestampError(error)) {
        try {
          await syncServerTime();
          continue;
        } catch (syncError) {
          lastError = syncError;
        }
      }

      if (attempt < 3 && isRetryableNetworkError(error)) {
        await sleep(attempt * 1200);
        continue;
      }

      break;
    }
  }

  throw lastError || new Error('Binance API request failed');
}

function safeErrorDetail(error) {
  const data = error?.response?.data;
  return {
    status: Number(error?.response?.status || 0) || null,
    code: data?.code ?? null,
    message: data?.msg || data?.message || error?.message || String(error)
  };
}

async function verifyBinanceTransfer(params = {}) {
  const credentials = resolveCredentials(params);
  const expectedAmount = normalizeAmount(params.expectedAmount);
  const expectedNote = normalizeNote(params.expectedNote);
  const submittedOrderId = normalizeOrderId(params.orderIdToCheck);

  if (!credentials.apiKey || !credentials.apiSecret) {
    return { success: false, reason: 'binance_not_configured' };
  }

  if (!Number.isFinite(expectedAmount) || expectedAmount <= 0 || (!expectedNote && !submittedOrderId)) {
    return { success: false, reason: 'invalid_payload' };
  }

  // Same verification window idea used by the working bot: do not inspect old
  // history unrelated to the current payment session.
  const sessionCreatedAt = Number(params.sessionCreatedAt || 0);
  const verificationWindowMs = submittedOrderId
    ? Math.max(60 * 60 * 1000, Number(params.recentWindowMs || 0))
    : 6 * 60 * 60 * 1000;

  // Use the Binance-adjusted clock when available.
  if (!serverTimeWasSynced) {
    try {
      await syncServerTime();
    } catch (_) {
      // fetchTransactions will retry and log the exact failure.
    }
  }

  const now = Date.now() + serverTimeOffsetMs;
  const oldestAllowed = now - verificationWindowMs;
  const sessionAnchor = Number.isFinite(sessionCreatedAt) && sessionCreatedAt > 0
    ? sessionCreatedAt - (30 * 60 * 1000)
    : oldestAllowed;
  const startTime = Math.max(0, oldestAllowed, sessionAnchor);
  const endTime = now + (60 * 1000);

  let rows;
  try {
    rows = await fetchTransactions(credentials, startTime, endTime);
  } catch (error) {
    const detail = safeErrorDetail(error);
    console.error('[Binance] Direct API verification failed:', detail);
    return {
      success: false,
      reason: 'api_error',
      error: detail
    };
  }

  const amountCandidates = rows.filter(item => {
    const amount = getTransactionAmount(item);
    const time = getTransactionTime(item);
    return isIncoming(item)
      && Math.abs(amount - expectedAmount) <= 0.0001
      && (!time || time >= startTime);
  });

  const matchedRows = amountCandidates.filter(item => {
    if (submittedOrderId) {
      if (!itemMatchesSubmittedId(item, submittedOrderId)) return false;

      // Match the working bot: when Binance exposes a note, reject a wrong note;
      // when the note is absent from the API payload, allow the exact order ID.
      const noteFieldsAvailable = Boolean(getTransactionNote(item));
      return !noteFieldsAvailable || !expectedNote || itemMatchesNote(item, expectedNote);
    }

    return itemMatchesNote(item, expectedNote);
  });

  if (!matchedRows.length) {
    return {
      success: false,
      reason: 'no_match',
      searchedRows: rows.length,
      matchedRows: 0,
      amountMatchedRows: amountCandidates.length,
      payIdMatchedRows: amountCandidates.length,
      payId: credentials.payId || null
    };
  }

  if (matchedRows.length > 1) {
    return {
      success: false,
      reason: 'ambiguous_match',
      searchedRows: rows.length,
      matchedRows: matchedRows.length,
      amountMatchedRows: amountCandidates.length,
      payIdMatchedRows: amountCandidates.length,
      payId: credentials.payId || null
    };
  }

  const matchedItem = matchedRows[0];
  const transactionId = uniqueTransactionId(matchedItem);
  const matchedOrderId = getTransactionOrderId(matchedItem) || transactionId;

  return {
    success: true,
    method: submittedOrderId ? 'exact_order_id' : 'note_code',
    orderId: matchedOrderId,
    rawOrderId: submittedOrderId || '',
    txId: transactionId,
    amount: getTransactionAmount(matchedItem),
    currency: 'USDT',
    transactionTime: getTransactionTime(matchedItem) || now,
    orderType: matchedItem?.orderType || null,
    payId: credentials.payId || null,
    matchedItem,
    searchedRows: rows.length,
    matchedRows: 1,
    amountMatchedRows: amountCandidates.length,
    payIdMatchedRows: amountCandidates.length,
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
