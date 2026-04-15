const crypto = require('crypto');
const axios = require('axios');

let timeOffset = 0; 

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
// دالة الاتصال بـ Binance API (مجهزة لتخطي الحظر)
// ==========================================
async function getBinanceTransactions(apiKey, apiSecret) {
  if (!apiKey || !apiSecret) return null;

  try {
    // استخدام api1 بدلاً من api لتجنب بعض الحظورات
    const timeRes = await axios.get('https://api1.binance.com/api/v3/time', { timeout: 5000 });
    if (timeRes.data && timeRes.data.serverTime) {
      timeOffset = timeRes.data.serverTime - Date.now();
    }
  } catch (e) {
    console.log("Time sync warning.");
  }

  // استخدام الرابط البديل الرسمي
  const url = "https://api1.binance.com/sapi/v1/pay/transactions";
  const timestamp = Date.now() + timeOffset;
  
  const queryString = `recvWindow=60000&timestamp=${timestamp}`;
  const signature = crypto.createHmac('sha256', String(apiSecret)).update(queryString).digest('hex');

  try {
    const response = await axios.get(`${url}?${queryString}&signature=${signature}`, {
      headers: { 
        'X-MBX-APIKEY': String(apiKey),
        // إضافة User-Agent لمتصفح كروم حقيقي لخداع جدار حماية باينانس
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 10000
    });
    return response.data;
  } catch (error) {
    console.error("Binance API Error Blocked:", error?.response?.data || error?.message);
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
    return { success: false, reason: 'not_found' };
  } else {
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
