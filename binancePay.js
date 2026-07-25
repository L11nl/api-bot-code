'use strict';

const crypto = require('crypto');
const axios = require('axios');

let serverTimeOffsetMs = 0;

function cleanValue(value) {
  const text = String(value ?? '').trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1).trim();
    }
  }
  return text;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function getBaseUrls() {
  const configured = cleanValue(process.env.BINANCE_API_BASE_URL || '').replace(/\/$/, '');
  return unique([
    configured,
    'https://api.binance.com',
    'https://api-gcp.binance.com',
    'https://api1.binance.com',
    'https://api2.binance.com'
  ]);
}

function getCredentials(params = {}) {
  return {
    apiKey: cleanValue(
      params.apiKey
      || process.env.BINANCE_API_KEY
      || process.env.BINANCE_PAY_API_KEY
      || ''
    ),
    apiSecret: cleanValue(
      params.apiSecret
      || process.env.BINANCE_API_SECRET
      || process.env.BINANCE_SECRET_KEY
      || process.env.BINANCE_PAY_SECRET_KEY
      || ''
    ),
    payId: cleanValue(
      params.payId
      || process.env.BINANCE_PAY_ID
      || process.env.BINANCE_ID
      || ''
    )
  };
}

function generateDepositNote(prefix = 'TOOLS-') {
  const safePrefix = String(prefix || 'TOOLS-');
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 6; i += 1) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${safePrefix}${suffix}`;
}

function normalizeOrderId(value) {
  return String(value || '').trim();
}

function normalizeNote(value) {
  return String(value || '').trim();
}

function looksLikeOrderId(value) {
  return /^[A-Za-z0-9_-]{6,128}$/.test(normalizeOrderId(value));
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
  const noteFields = [
    item?.note,
    item?.remark,
    item?.message,
    item?.transferNote,
    item?.paymentInfo?.note,
    item?.extendInfo?.note
  ];
  const first = noteFields.find(value => value !== undefined && value !== null && String(value).trim() !== '');
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

function signedQuery(params, apiSecret) {
  const query = new URLSearchParams(params).toString();
  const signature = crypto.createHmac('sha256', apiSecret).update(query).digest('hex');
  return `${query}&signature=${signature}`;
}

function safeErrorDetail(error, baseUrl = null) {
  const data = error?.response?.data;
  return {
    baseUrl,
    status: Number(error?.response?.status || 0) || null,
    code: data?.code ?? null,
    networkCode: error?.code || error?.cause?.code || null,
    message: data?.msg || data?.message || error?.message || String(error)
  };
}

function isTimestampError(error) {
  const text = JSON.stringify(error?.response?.data || error?.message || error).toLowerCase();
  return text.includes('-1021')
    || text.includes('outside of the recvwindow')
    || text.includes('outside of the time window')
    || text.includes('invalid_timestamp');
}

function shouldTryAnotherHost(error) {
  if (!error?.response) return true;
  const status = Number(error.response.status || 0);
  return status === 403
    || status === 408
    || status === 418
    || status === 429
    || status === 451
    || status >= 500;
}

async function syncServerTime(baseUrl) {
  const response = await axios.get(`${baseUrl}/api/v3/time`, { timeout: 10000 });
  const serverTime = Number(response.data?.serverTime || 0);
  if (serverTime > 0) {
    serverTimeOffsetMs = serverTime - Date.now();
  }
}

async function fetchTransactionsFromHost(baseUrl, credentials, startTime, endTime) {
  const perform = async () => {
    const params = {
      limit: '100',
      recvWindow: '60000',
      timestamp: String(Date.now() + serverTimeOffsetMs),
      startTime: String(startTime),
      endTime: String(endTime)
    };

    const response = await axios.get(
      `${baseUrl}/sapi/v1/pay/transactions?${signedQuery(params, credentials.apiSecret)}`,
      {
        timeout: 20000,
        headers: { 'X-MBX-APIKEY': credentials.apiKey }
      }
    );

    return Array.isArray(response.data?.data) ? response.data.data : [];
  };

  try {
    return await perform();
  } catch (error) {
    if (isTimestampError(error)) {
      await syncServerTime(baseUrl);
      return perform();
    }
    throw error;
  }
}

async function fetchTransactions(credentials, startTime, endTime) {
  const errors = [];
  const baseUrls = getBaseUrls();

  for (let index = 0; index < baseUrls.length; index += 1) {
    const baseUrl = baseUrls[index];
    try {
      const rows = await fetchTransactionsFromHost(baseUrl, credentials, startTime, endTime);
      return { rows, baseUrl };
    } catch (error) {
      const detail = safeErrorDetail(error, baseUrl);
      errors.push(detail);
      console.error('[Binance] API request failed:', detail);

      const hasAnotherHost = index < baseUrls.length - 1;
      if (!hasAnotherHost || !shouldTryAnotherHost(error)) {
        const wrapped = new Error(detail.message || 'Binance API error');
        wrapped.binanceDetail = detail;
        wrapped.binanceAttempts = errors;
        wrapped.response = error?.response;
        wrapped.code = error?.code;
        throw wrapped;
      }
    }
  }

  const last = errors[errors.length - 1] || { message: 'Binance API error' };
  const wrapped = new Error(last.message || 'Binance API error');
  wrapped.binanceDetail = last;
  wrapped.binanceAttempts = errors;
  throw wrapped;
}

async function verifyBinanceTransfer(params = {}) {
  const credentials = getCredentials(params);
  const expectedAmount = normalizeAmount(params.expectedAmount);
  const expectedNote = normalizeNote(params.expectedNote);
  const submittedOrderId = normalizeOrderId(params.orderIdToCheck);

  if (!credentials.apiKey || !credentials.apiSecret) {
    return { success: false, reason: 'binance_not_configured' };
  }

  if (!Number.isFinite(expectedAmount) || expectedAmount <= 0 || (!expectedNote && !submittedOrderId)) {
    return { success: false, reason: 'invalid_payload' };
  }

  const sessionCreatedAt = Number(params.sessionCreatedAt || 0);
  const requestedWindowMs = Number(params.recentWindowMs || 0);
  const verificationWindowMs = submittedOrderId
    ? Math.max(60 * 60 * 1000, requestedWindowMs)
    : 6 * 60 * 60 * 1000;

  const now = Date.now() + serverTimeOffsetMs;
  const oldestAllowed = now - verificationWindowMs;
  const sessionAnchor = Number.isFinite(sessionCreatedAt) && sessionCreatedAt > 0
    ? sessionCreatedAt - (30 * 60 * 1000)
    : oldestAllowed;
  const startTime = Math.max(0, oldestAllowed, sessionAnchor);
  const endTime = now + (60 * 1000);

  let result;
  try {
    result = await fetchTransactions(credentials, startTime, endTime);
  } catch (error) {
    const detail = error?.binanceDetail || safeErrorDetail(error);
    return {
      success: false,
      reason: 'api_error',
      error: detail,
      attempts: error?.binanceAttempts || [detail]
    };
  }

  const rows = result.rows;
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

      const noteIsAvailable = Boolean(getTransactionNote(item));
      return !noteIsAvailable || !expectedNote || itemMatchesNote(item, expectedNote);
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
      payId: credentials.payId || null,
      apiBaseUrl: result.baseUrl
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
      payId: credentials.payId || null,
      apiBaseUrl: result.baseUrl
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
    matchScore: 100,
    apiBaseUrl: result.baseUrl
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
