require('dotenv').config();
const crypto = require('crypto');

function requireEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseAdminIds() {
  const raw = process.env.ADMIN_IDS || process.env.ADMIN_ID || '';
  const ids = raw
    .split(',')
    .map(value => Number(String(value).trim()))
    .filter(Number.isFinite);
  if (!ids.length) throw new Error('ADMIN_IDS or ADMIN_ID is required');
  return new Set(ids);
}

const token = requireEnv('BOT_TOKEN');
const databaseUrl = requireEnv('DATABASE_URL');
const configuredInventoryKey = String(process.env.INVENTORY_ENCRYPTION_KEY || '').trim();
let inventoryKey = configuredInventoryKey;
if (inventoryKey && !/^[0-9a-fA-F]{64}$/.test(inventoryKey)) {
  throw new Error('INVENTORY_ENCRYPTION_KEY must be exactly 64 hexadecimal characters');
}
if (!inventoryKey) {
  // Backward-compatible fallback for the old single-file bot, which did not
  // have an inventory encryption environment variable. Keep BOT_TOKEN stable
  // or, preferably, set INVENTORY_ENCRYPTION_KEY explicitly in Railway.
  inventoryKey = crypto.createHash('sha256').update(`cd-store-inventory-v1:${token}`).digest('hex');
  console.warn('INVENTORY_ENCRYPTION_KEY is missing; using a BOT_TOKEN-derived compatibility key.');
}

module.exports = {
  token,
  databaseUrl,
  admins: parseAdminIds(),
  port: Number(process.env.PORT || 3000),
  supportUsername: String(process.env.SUPPORT_USERNAME || '').replace(/^@/, ''),
  defaultLanguage: process.env.DEFAULT_LANGUAGE === 'en' ? 'en' : 'ar',
  captchaEnabled: process.env.CAPTCHA_ENABLED !== 'false',
  inventoryKey,
  superQiNumber: String(process.env.SUPERQI_NUMBER || '917392710336').trim(),
  iqdRate: Number(process.env.IQD_RATE || 1500),
  binance: {
    // Normal Binance account API keys with read permission only.
    // Legacy BINANCE_PAY_* names are accepted so the current Railway setup keeps working.
    apiKey: String(process.env.BINANCE_API_KEY || process.env.BINANCE_PAY_API_KEY || '').trim(),
    secretKey: String(
      process.env.BINANCE_API_SECRET ||
      process.env.BINANCE_SECRET_KEY ||
      process.env.BINANCE_PAY_SECRET_KEY ||
      ''
    ).trim(),
    payId: String(process.env.BINANCE_PAY_ID || process.env.BINANCE_ID || '').trim(),
    baseUrl: String(process.env.BINANCE_API_BASE_URL || 'https://api.binance.com').replace(/\/$/, ''),
    minAmount: 0.01,
    maxAmount: Math.max(1, Number(process.env.BINANCE_MAX_AMOUNT || 100000)),
    verificationWindowHours: Math.min(24, Math.max(1, Number(process.env.BINANCE_VERIFY_WINDOW_HOURS || 6)))
  }
};
