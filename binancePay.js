const crypto = require('crypto');
const axios = require('axios');

function generateDepositNote(prefix = 'TOOLS-') {
  const normalizedPrefix = String(prefix || 'TOOLS-').trim() || 'TOOLS-';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let suffix = '';
  for (let i = 0; i < 6; i += 1) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${normalizedPrefix}${suffix}`;
}

// دوال مساعدة تم تبسيطها للحفاظ على توافق التصدير (module.exports)
function normalizeOrderId(value) { return String(value || '').trim(); }
function normalizeNote(value) { return String(value || '').trim(); }
function looksLikeOrderId(value) { return /^\d{11,}$/.test(String(value || '').trim()); }
function normalizeAmount(value) { return Number(value); }

function getTransactionOrderId(transaction) { return String(transaction?.orderId || ''); }
function getTransactionNote(transaction) { return String(transaction?.note || ''); }
function getTransactionAmount(transaction) { return parseFloat(transaction?.amount || 0); }
function getTransactionTime(transaction) { return Number(transaction?.transactionTime || 0); }

// ==========================================
// دالة الاتصال بـ Binance API (تطابق البايثون)
// ==========================================
async function getBinanceTransactions(apiKey, apiSecret) {
  const url = "https://api.binance.com/sapi/v1/pay/transactions";
  const timestamp = Date.now();
  
  const queryString = `timestamp=${timestamp}`;
  const signature = crypto.createHmac('sha256', String(apiSecret)).update(queryString).digest('hex');

  try {
    const response = await axios.get(`${url}?${queryString}&signature=${signature}`, {
      headers: { 'X-MBX-APIKEY': String(apiKey) }
    });
    return response.data;
  } catch (error) {
    console.error("Binance API Error:", error?.response?.data || error?.message);
    return null;
  }
}

// ==========================================
// دالة التحقق الرئيسية (نفس منطق البايثون بالضبط)
// ==========================================
async function verifyBinanceTransfer({
  apiKey,
  apiSecret,
  payId = '',
  expectedAmount,
  expectedNote = '',
  orderIdToCheck = '',
  sessionCreatedAt = null
}) {
  
  const data = await getBinanceTransactions(apiKey, apiSecret);

  if (data && data.data) {
    const transactions = data.data;

    for (const tx of transactions) {
      const actualAmount = parseFloat(tx.amount || 0);
      const txNote = String(tx.note || '');
      const txOrderId = String(tx.orderId || '');

      // المطابقة بالكود أو برقم العملية
      if ((orderIdToCheck && orderIdToCheck === txOrderId) || (expectedNote && expectedNote === txNote)) {
        if (actualAmount >= expectedAmount) {
          return {
            success: true,
            amount: actualAmount,
            method: orderIdToCheck === txOrderId ? 'order_id' : 'note',
            orderId: txOrderId,
            note: txNote
          };
        }
      }
    }

    // لم يتم العثور على المطابقة أو المبلغ غير كافٍ
    return { success: false, reason: 'not_found' };
  } else {
    // مشكلة في الاتصال بخوادم باينانس
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
