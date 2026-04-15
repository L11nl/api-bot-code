const axios = require('axios');

const PROXY_URL = "https://ok-bainac.onrender.com/verify-binance"; 
const PROXY_SECRET = "123456789_my_secret_password";

function generateDepositNote(prefix = 'TOOLS-') {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let suffix = '';
  for (let i = 0; i < 6; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
  return `TOOLS-${suffix}`;
}

function normalizeOrderId(v) { return String(v || '').trim(); }
function normalizeNote(v) { return String(v || '').trim(); }
function looksLikeOrderId(v) { return /^\d{11,}$/.test(String(v || '').trim()); }
function normalizeAmount(v) { return Number(v); }
function getTransactionOrderId(tx) { return String(tx?.orderId || ''); }
function getTransactionNote(tx) { return String(tx?.note || ''); }
function getTransactionAmount(tx) { return parseFloat(tx?.amount || 0); }
function getTransactionTime(tx) { return Number(tx?.transactionTime || 0); }

async function verifyBinanceTransfer(params) {
  console.log("🚀 جاري إرسال الطلب والمفاتيح إلى الوسيط Render...");
  
  // 🔥 هذا هو الحل: سحب المفاتيح من ريلوي وإضافتها للطلب لكي لا تصل فارغة
  const payload = {
    ...params,
    apiKey: process.env.BINANCE_PAY_API_KEY || process.env.BINANCE_API_KEY,
    apiSecret: process.env.BINANCE_PAY_SECRET_KEY || process.env.BINANCE_SECRET_KEY
  };

  try {
    const response = await axios.post(PROXY_URL, payload, {
      headers: { 'x-proxy-secret': PROXY_SECRET },
      timeout: 25000
    });
    console.log("✅ رد الوسيط:", JSON.stringify(response.data));
    return response.data;
  } catch (error) {
    console.log("❌ خطأ في الاتصال:", error.message);
    return { success: false, reason: 'api_error' };
  }
}

module.exports = {
  generateDepositNote, normalizeOrderId, normalizeNote, looksLikeOrderId,
  normalizeAmount, verifyBinanceTransfer, getTransactionOrderId,
  getTransactionNote, getTransactionAmount, getTransactionTime
};
