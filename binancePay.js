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
  console.log("==================================================");
  console.log("🚀 تنبيه: البوت بدأ الآن محاولة الاتصال بالوسيط Render...");
  
  try {
    const response = await axios.post(PROXY_URL, params, {
      headers: { 'x-proxy-secret': PROXY_SECRET },
      timeout: 25000
    });
    console.log("✅ ممتاز! وصل رد من الوسيط:", JSON.stringify(response.data));
    console.log("==================================================");
    return response.data;
  } catch (error) {
    console.log("❌ حدث خطأ أثناء الاتصال بالوسيط!");
    console.error("السبب:", error.message);
    console.log("==================================================");
    return { success: false, reason: 'api_error' };
  }
}

module.exports = {
  generateDepositNote, normalizeOrderId, normalizeNote, looksLikeOrderId,
  normalizeAmount, verifyBinanceTransfer, getTransactionOrderId,
  getTransactionNote, getTransactionAmount, getTransactionTime
};
