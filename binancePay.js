const axios = require('axios');

const PROXY_URL = "https://ok-bainac.onrender.com/verify-binance"; 
const PROXY_SECRET = "123456789_my_secret_password";

function generateDepositNote(prefix = 'TOOLS-') {
  const normalizedPrefix = String(prefix || 'TOOLS-').trim() || 'TOOLS-';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let suffix = '';
  for (let i = 0; i < 6; i += 1) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${normalizedPrefix}${suffix}`;
}

function normalizeOrderId(value) { return String(value || '').trim(); }
function normalizeNote(value) { return String(value || '').trim(); }
function looksLikeOrderId(value) { return /^\d{11,}$/.test(String(value || '').trim()); }
function normalizeAmount(value) { return Number(value); }
function getTransactionOrderId(transaction) { return String(transaction?.orderId || ''); }
function getTransactionNote(transaction) { return String(transaction?.note || ''); }
function getTransactionAmount(transaction) { return parseFloat(transaction?.amount || 0); }
function getTransactionTime(transaction) { return Number(transaction?.transactionTime || 0); }

async function verifyBinanceTransfer(params) {
  try {
    const response = await axios.post(PROXY_URL, params, {
      headers: { 
        'x-proxy-secret': PROXY_SECRET,
        'Content-Type': 'application/json'
      },
      timeout: 25000
    });
    return response.data;
  } catch (error) {
    console.error("Proxy Connection Error:", error.message);
    return { success: false, reason: 'api_error' };
  }
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
