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

function normalizeOrderId(value) { return String(value || '').trim(); }
function normalizeNote(value) { return String(value || '').trim(); }
function looksLikeOrderId(value) { return /^\d{11,}$/.test(String(value || '').trim()); }
function normalizeAmount(value) { return Number(value); }

function getTransactionOrderId(transaction) { return String(transaction?.orderId || ''); }
function getTransactionNote(transaction) { return String(transaction?.note || ''); }
function getTransactionAmount(transaction) { return parseFloat(transaction?.amount || 0); }
function getTransactionTime(transaction) { return Number(transaction?.transactionTime || 0); }

// ==========================================
// دالة الاتصال بـ Binance API (مع حل مشكلة التوقيت)
// ==========================================
async function getBinanceTransactions(apiKey, apiSecret) {
  if (!apiKey || !apiSecret) return null;

  const url = "https://api.binance.com/sapi/v1/pay/transactions";
  const timestamp = Date.now();
  
  // أضفنا recvWindow=60000 لتوسيع نافذة الوقت المسموح بها لتجنب أخطاء سيرفر Railway
  const queryString = `recvWindow=60000&timestamp=${timestamp}`;
  const signature = crypto.createHmac('sha256', String(apiSecret)).update(queryString).digest('hex');

  try {
    const response = await axios.get(`${url}?${queryString}&signature=${signature}`, {
      headers: { 'X-MBX-APIKEY': String(apiKey) },
      timeout: 15000 // إضافة مهلة محددة لتجنب تعليق الطلب
    });
    return response.data;
  } catch (error) {
    // سيتم طباعة سبب الخطأ الحقيقي في سجلات Railway (Logs) إذا حدث
    console.error("Binance API Error Details:", error?.response?.data || error?.message);
    return null;
  }
}

// ==========================================
// دالة التحقق الرئيسية 
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
    // إذا رجعت getBinanceTransactions بـ null (بسبب خطأ في API)
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
