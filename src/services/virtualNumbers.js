const {
  sequelize,
  Op,
  User,
  BalanceTransaction,
  VirtualNumberOrder,
  getSetting,
  setSetting,
  getSecureSetting,
  setSecureSetting
} = require('../db');
const axios = require('axios');
const config = require('../config');
const smsbower = require('../providers/smsbower');
const smsman = require('../providers/smsman');
const grizzly = require('../providers/grizzly');

const DEFAULT_PROFIT = 0.15;
const ACTIVATION_TIMEOUT_MINUTES = Math.max(1, Number(config.virtualNumbers?.activationTimeoutMinutes || 10));
const purchaseLocks = new Set();

const PROVIDERS = {
  smsbower: {
    id: 'smsbower',
    adminName: 'SMSBower',
    adapter: smsbower,
    secureKey: 'virtual_numbers_smsbower_api_key',
    profitSetting: 'virtual_numbers_smsbower_profit',
    envKey: () => String(config.virtualNumbers?.apiKey || '').trim()
  },
  smsman: {
    id: 'smsman',
    adminName: 'SMS-MAN',
    adapter: smsman,
    secureKey: 'virtual_numbers_smsman_api_key',
    profitSetting: 'virtual_numbers_smsman_profit',
    envKey: () => String(config.virtualNumbers?.smsmanApiKey || '').trim()
  },
  grizzly: {
    id: 'grizzly',
    adminName: 'GrizzlySMS',
    adapter: grizzly,
    secureKey: 'virtual_numbers_grizzly_api_key',
    profitSetting: 'virtual_numbers_grizzly_profit',
    envKey: () => String(config.virtualNumbers?.grizzlyApiKey || '').trim()
  }
};

const providerKeyPresence = new Map(Object.values(PROVIDERS).map(provider => [provider.id, Boolean(provider.envKey())]));

function normalizeProviderApiKeyInput(value) {
  let input = String(value ?? '')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .trim();
  if (!input) return '';

  // Accept the common copy formats shown by provider dashboards: a full API
  // URL, "api_key=...", "API Key: ...", or a quoted/Bearer value. Only the
  // extracted token is ever verified or stored.
  if (/^https?:\/\//i.test(input)) {
    try {
      const parsed = new URL(input);
      const fromUrl = parsed.searchParams.get('api_key') || parsed.searchParams.get('apikey') || parsed.searchParams.get('token');
      if (fromUrl) input = fromUrl;
    } catch {}
  }

  const labelled = input.match(/(?:^|[?&\s])(?:api[\s_-]*key|apikey|token)\s*[:=]\s*["'`]?([^&\s"'`]+)/i);
  if (labelled?.[1]) input = labelled[1];
  input = input.replace(/^bearer\s+/i, '').trim();

  const pairs = [['"', '"'], ["'", "'"], ['`', '`'], ['[', ']'], ['(', ')']];
  for (const [left, right] of pairs) {
    if (input.startsWith(left) && input.endsWith(right) && input.length > 2) {
      input = input.slice(left.length, -right.length).trim();
      break;
    }
  }

  return input
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\s+/gu, '')
    .trim();
}

function validProviderApiKeyInput(value) {
  const key = normalizeProviderApiKeyInput(value);
  return key.length >= 8 && key.length <= 512 && !/[<>{}\\]/.test(key);
}

function detectProviderFromApiInput(value) {
  const raw = String(value || '').toLowerCase();
  if (/grizzly\s*-?\s*sms|grizzlysms\.com/.test(raw)) return 'grizzly';
  if (/sms\s*-?\s*man|sms-man\.com/.test(raw)) return 'smsman';
  if (/sms\s*-?\s*bower|smsbower\.(?:com|page)/.test(raw)) return 'smsbower';
  return '';
}

function providerRecord(providerId) {
  const row = PROVIDERS[String(providerId || '').toLowerCase()];
  if (!row) {
    const error = new Error('UNKNOWN_PROVIDER');
    error.code = 'UNKNOWN_PROVIDER';
    throw error;
  }
  return row;
}

function apiError(code, detail = '') {
  const error = new Error(code);
  error.code = code;
  error.detail = detail;
  return error;
}

function roundMoney(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round((Number(value || 0) + Number.EPSILON) * factor) / factor;
}

function salePrice(providerCost, profit) {
  const cost = Number(providerCost || 0);
  const margin = Number(profit || 0);
  if (!Number.isFinite(cost) || cost < 0 || !Number.isFinite(margin) || margin < 0) return 0;
  return roundMoney(cost + margin, 2);
}

// Compatibility helper for older callers that used the former single-provider
// module. New customer quotes use each provider's stored profit instead.
function retailPrice(providerCost) {
  return salePrice(providerCost, DEFAULT_PROFIT);
}

function clearAvailabilityCaches(providerId = null) {
  const providers = providerId ? [providerRecord(providerId)] : Object.values(PROVIDERS);
  for (const provider of providers) provider.adapter.clearCaches?.();
}

async function getProviderApiKey(providerId) {
  const provider = providerRecord(providerId);
  const storedRaw = String(await getSecureSetting(provider.secureKey, '') || '').trim();
  const stored = storedRaw === '__DISABLED__' ? storedRaw : normalizeProviderApiKeyInput(storedRaw);
  if (stored === '__DISABLED__') {
    providerKeyPresence.set(provider.id, false);
    return '';
  }
  const value = stored || normalizeProviderApiKeyInput(provider.envKey());
  providerKeyPresence.set(provider.id, Boolean(value));
  return value;
}

function enabled() {
  // Stored API keys are loaded asynchronously after the database is ready.
  // Keep the feature entry point available and let the async provider menu
  // decide whether at least one provider is actually configured.
  return Boolean(config.virtualNumbers?.enabled);
}

// Prime encrypted-key presence without blocking module loading.
Promise.all(Object.keys(PROVIDERS).map(id => getProviderApiKey(id).catch(() => ''))).catch(() => {});

async function hasProviderApi(providerId) {
  return Boolean(await getProviderApiKey(providerId));
}

async function hasAnyConfiguredProvider() {
  const results = await Promise.all(Object.keys(PROVIDERS).map(hasProviderApi));
  return results.some(Boolean);
}

async function getProviderProfit(providerId) {
  const provider = providerRecord(providerId);
  const raw = await getSetting(provider.profitSetting, String(DEFAULT_PROFIT));
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_PROFIT;
}

async function setProviderProfit(providerId, value) {
  const provider = providerRecord(providerId);
  const profit = Number(value);
  if (!Number.isFinite(profit) || profit < 0 || profit > 100) throw apiError('INVALID_PROFIT');
  await setSetting(provider.profitSetting, String(roundMoney(profit, 4)));
  return getProviderProfit(providerId);
}

async function testProviderApi(providerId, apiKey = null) {
  const provider = providerRecord(providerId);
  const key = normalizeProviderApiKeyInput(apiKey || await getProviderApiKey(providerId) || '');
  if (!validProviderApiKeyInput(key)) throw apiError('BAD_KEY');
  const balance = await provider.adapter.getBalance(key);
  return { providerId: provider.id, balance };
}

async function setProviderApiKey(providerId, apiKey) {
  const provider = providerRecord(providerId);
  const key = normalizeProviderApiKeyInput(apiKey);
  if (!key) {
    await setSecureSetting(provider.secureKey, '__DISABLED__');
    providerKeyPresence.set(provider.id, false);
    provider.adapter.clearCaches?.();
    return { configured: false, removed: true };
  }
  if (!validProviderApiKeyInput(key)) throw apiError('BAD_KEY');
  const test = await testProviderApi(providerId, key);
  await setSecureSetting(provider.secureKey, key);
  providerKeyPresence.set(provider.id, true);
  provider.adapter.clearCaches?.();
  return { configured: true, balance: test.balance };
}

async function removeProviderApiKey(providerId) {
  const provider = providerRecord(providerId);
  const active = await VirtualNumberOrder.count({ where: { providerId: provider.id, status: 'waiting_sms' } });
  if (active > 0) {
    const error = apiError('ACTIVE_ORDERS');
    error.active = active;
    throw error;
  }
  await setSecureSetting(provider.secureKey, '__DISABLED__');
  providerKeyPresence.set(provider.id, false);
  provider.adapter.clearCaches?.();
  return { configured: false };
}

async function providerStatus(providerId) {
  const provider = providerRecord(providerId);
  const apiKey = await getProviderApiKey(provider.id);
  const result = {
    id: provider.id,
    name: provider.adminName,
    configured: Boolean(apiKey),
    baseUrl: provider.adapter.BASE_URL,
    keyValid: false,
    servicesOk: false,
    serviceCount: null,
    balance: null,
    errorCode: '',
    errorDetail: ''
  };
  if (!apiKey) return result;
  try {
    result.balance = await provider.adapter.getBalance(apiKey);
    result.keyValid = true;
  } catch (error) {
    result.errorCode = String(error.code || 'PROVIDER_UNAVAILABLE');
    result.errorDetail = String(error.detail || error.message || '');
    return result;
  }
  try {
    const services = await provider.adapter.listServices(apiKey, true);
    result.serviceCount = services.length;
    result.servicesOk = services.length > 0;
  } catch (error) {
    result.servicesErrorCode = String(error.code || 'SERVICES_PROBE_FAILED');
  }
  return result;
}

async function providerStatuses() {
  return Promise.all(Object.keys(PROVIDERS).map(providerStatus));
}

async function providerWallet(providerId) {
  const provider = providerRecord(providerId);
  if (provider.id !== 'smsbower') throw apiError('WALLET_NOT_AVAILABLE');
  const apiKey = await getProviderApiKey(provider.id);
  if (!apiKey) throw apiError('VIRTUAL_NUMBERS_NOT_CONFIGURED');
  let response;
  try {
    response = await axios.get(config.virtualNumbers.smsBowerWalletUrl, {
      params: { api_key: apiKey, coin: 'usdt', network: 'tron' },
      timeout: config.virtualNumbers.timeoutMs
    });
  } catch (error) {
    throw apiError('PROVIDER_UNAVAILABLE', error?.message || 'wallet request failed');
  }
  const data = response?.data;
  const parsed = typeof data === 'string' ? (() => { try { return JSON.parse(data); } catch { return {}; } })() : (data || {});
  const address = String(parsed?.wallet_address || parsed?.address || '').trim();
  if (!address) throw apiError('BAD_PROVIDER_RESPONSE');
  return { providerId: provider.id, providerName: provider.adminName, address, coin: 'USDT', network: 'TRC20', balance: await provider.adapter.getBalance(apiKey).catch(() => null) };
}

async function providerStats(providerId) {
  const completed = await VirtualNumberOrder.count({ where: { providerId, status: 'completed' } });
  const purchased = await VirtualNumberOrder.count({
    where: {
      providerId,
      activationId: { [Op.ne]: null },
      status: { [Op.notIn]: ['failed', 'reserving'] }
    }
  });
  const active = await VirtualNumberOrder.count({ where: { providerId, status: 'waiting_sms' } });
  return { completed, purchased, active };
}

async function getConfiguredProviders() {
  const rows = [];
  for (const provider of Object.values(PROVIDERS)) {
    const apiKey = await getProviderApiKey(provider.id);
    if (!apiKey) continue;
    const [profit, stats] = await Promise.all([getProviderProfit(provider.id), providerStats(provider.id)]);
    rows.push({
      id: provider.id,
      adminName: provider.adminName,
      profit,
      ...stats
    });
  }
  rows.sort((a, b) => b.completed - a.completed || b.purchased - a.purchased || a.id.localeCompare(b.id));
  return rows.map((row, index) => ({
    ...row,
    rank: index + 1,
    publicLabelAr: index === 0 ? 'خدمة 1 🔥' : `خدمة ${index + 1}`,
    publicLabelEn: index === 0 ? 'Service 1 🔥' : `Service ${index + 1}`
  }));
}

async function getAllProviderAdminRows() {
  const configured = new Map((await getConfiguredProviders()).map(row => [row.id, row]));
  const rows = [];
  for (const provider of Object.values(PROVIDERS)) {
    const existing = configured.get(provider.id);
    const [profit, stats] = await Promise.all([getProviderProfit(provider.id), providerStats(provider.id)]);
    rows.push({
      id: provider.id,
      adminName: provider.adminName,
      configured: Boolean(await getProviderApiKey(provider.id)),
      profit,
      ...stats,
      rank: existing?.rank || null,
      publicLabelAr: existing?.publicLabelAr || null
    });
  }
  return rows;
}

async function getPublicProvider(providerId) {
  return (await getConfiguredProviders()).find(row => row.id === providerId) || null;
}

async function getBalance(providerId = 'smsbower') {
  const provider = providerRecord(providerId);
  const apiKey = await getProviderApiKey(provider.id);
  if (!apiKey) throw apiError('PROVIDER_NOT_CONFIGURED');
  return provider.adapter.getBalance(apiKey);
}

async function listServices(providerId = 'smsbower', force = false) {
  if (typeof providerId === 'boolean') {
    force = providerId;
    providerId = 'smsbower';
  }
  const provider = providerRecord(providerId);
  const apiKey = await getProviderApiKey(providerId);
  if (!apiKey) throw apiError('PROVIDER_NOT_CONFIGURED');
  return provider.adapter.listServices(apiKey, force);
}

async function listCountries(providerId = 'smsbower', force = false) {
  if (typeof providerId === 'boolean') {
    force = providerId;
    providerId = 'smsbower';
  }
  const provider = providerRecord(providerId);
  const apiKey = await getProviderApiKey(providerId);
  if (!apiKey) throw apiError('PROVIDER_NOT_CONFIGURED');
  return provider.adapter.listCountries(apiKey, force);
}

async function availableServicesSummary(providerId = 'smsbower', force = false) {
  if (typeof providerId === 'boolean') {
    force = providerId;
    providerId = 'smsbower';
  }
  const provider = providerRecord(providerId);
  const apiKey = await getProviderApiKey(providerId);
  if (!apiKey) throw apiError('PROVIDER_NOT_CONFIGURED');
  const profit = await getProviderProfit(providerId);
  const rows = await provider.adapter.availableServicesSummary(apiKey, force);
  return rows.map(row => ({ ...row, profit, retailPrice: salePrice(row.providerCost, profit) }));
}

async function availabilityForService(providerId, serviceCode, force = false) {
  if (serviceCode === undefined || typeof serviceCode === 'boolean') {
    force = Boolean(serviceCode);
    serviceCode = providerId;
    providerId = 'smsbower';
  }
  const provider = providerRecord(providerId);
  const apiKey = await getProviderApiKey(providerId);
  if (!apiKey) throw apiError('PROVIDER_NOT_CONFIGURED');
  const profit = await getProviderProfit(providerId);
  const rows = await provider.adapter.availabilityForService(apiKey, serviceCode, force);
  return rows.map(row => ({
    ...row,
    profit,
    retailPrice: salePrice(row.providerCost, profit)
  })).sort((a, b) => a.retailPrice - b.retailPrice || a.providerCost - b.providerCost || a.countryName.localeCompare(b.countryName, 'en'));
}

async function quote(providerId, serviceCode, countryId, force = false) {
  if (countryId === undefined || typeof countryId === 'boolean') {
    force = Boolean(countryId);
    countryId = serviceCode;
    serviceCode = providerId;
    providerId = 'smsbower';
  }
  const rows = await availabilityForService(providerId, serviceCode, force);
  return rows.find(row => String(row.countryId) === String(countryId)) || null;
}

function currentShopIdForAccounting() {
  if (String(config.network?.role || '').toLowerCase() === 'client') return String(config.network?.shopId || '').trim();
  return 'master';
}

async function markAccounting(order, fields) {
  Object.assign(order, fields);
  await order.save({ fields: Object.keys(fields) });
  return order;
}

async function syncProviderCostAccounting(order) {
  if (!order || order.providerCostAccounted) return { accounted: Boolean(order?.providerCostAccounted), skipped: true };
  // A provider cost exists only after a real activation was allocated. If the
  // provider rejected the purchase before returning activationId, there is no
  // inter-shop cost to charge.
  if (!String(order.activationId || '').trim()) {
    await markAccounting(order, { providerCostAccounted: true, accountingLastError: null });
    return { accounted: true, skipped: true };
  }
  const amountUsd = Number(order.providerCostUsd || 0);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    await markAccounting(order, { providerCostAccounted: true, accountingLastError: null });
    return { accounted: true, skipped: true };
  }

  // Master/standalone storefront pays the provider directly, so there is no
  // inter-shop debt to create. Client storefronts owe Master only the real
  // provider cost; the retail margin remains with the client storefront.
  let network;
  try { network = require('../network'); }
  catch { network = null; }
  if (!network?.enabledClient?.()) {
    await markAccounting(order, { providerCostAccounted: true, accountingLastError: null });
    return { accounted: true, skipped: true };
  }

  try {
    await network.recordVirtualNumberProviderCost({
      orderId: String(order.id),
      activationId: String(order.activationId || ''),
      amountUsd,
      salePriceUsd: Number(order.salePriceUsd || 0),
      customerId: String(order.userId || ''),
      serviceCode: String(order.serviceCode || ''),
      countryId: String(order.countryId || '')
    });
    await markAccounting(order, { providerCostAccounted: true, accountingLastError: null });
    return { accounted: true };
  } catch (error) {
    await markAccounting(order, { accountingLastError: String(error?.message || error).slice(0, 255) }).catch(() => {});
    throw error;
  }
}

async function syncProviderCostReversal(order) {
  if (!order || !order.refundApplied || order.providerCostReversed) {
    return { reversed: Boolean(order?.providerCostReversed), skipped: true };
  }

  // Never create a refund obligation before the original provider-cost debt
  // exists. If the original write failed, retry it first; both writes are
  // idempotent on Master, so repeated background attempts are safe.
  if (!order.providerCostAccounted) await syncProviderCostAccounting(order);
  if (!String(order.activationId || '').trim()) {
    await markAccounting(order, { providerCostReversed: true, accountingLastError: null });
    return { reversed: true, skipped: true };
  }

  const amountUsd = Number(order.providerCostUsd || 0);
  let network;
  try { network = require('../network'); }
  catch { network = null; }
  if (!network?.enabledClient?.() || !Number.isFinite(amountUsd) || amountUsd <= 0) {
    await markAccounting(order, { providerCostReversed: true, accountingLastError: null });
    return { reversed: true, skipped: true };
  }

  try {
    await network.reverseVirtualNumberProviderCost({
      orderId: String(order.id),
      activationId: String(order.activationId || ''),
      amountUsd,
      salePriceUsd: Number(order.salePriceUsd || 0),
      customerId: String(order.userId || ''),
      serviceCode: String(order.serviceCode || ''),
      countryId: String(order.countryId || '')
    });
    await markAccounting(order, { providerCostReversed: true, accountingLastError: null });
    return { reversed: true };
  } catch (error) {
    await markAccounting(order, { accountingLastError: String(error?.message || error).slice(0, 255) }).catch(() => {});
    throw error;
  }
}

async function syncAccountingBacklog(limit = 60) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 60));
  const rows = await VirtualNumberOrder.findAll({
    where: {
      [Op.or]: [
        { providerCostAccounted: false, activationId: { [Op.ne]: null } },
        { refundApplied: true, providerCostReversed: false }
      ]
    },
    order: [['createdAt', 'ASC']],
    limit: safeLimit
  });
  let accounted = 0;
  let reversed = 0;
  for (const order of rows) {
    try {
      if (!order.providerCostAccounted && order.activationId) {
        await syncProviderCostAccounting(order);
        accounted += 1;
      }
      if (order.refundApplied && !order.providerCostReversed) {
        await syncProviderCostReversal(order);
        reversed += 1;
      }
    } catch (error) {
      console.error('Virtual number accounting retry:', order.id, error.message);
    }
  }
  return { scanned: rows.length, accounted, reversed };
}


async function reserveCustomerWallet(userId, orderData) {
  const tx = await sequelize.transaction();
  try {
    const user = await User.findByPk(userId, { transaction: tx, lock: tx.LOCK.UPDATE });
    if (!user) throw apiError('USER_NOT_FOUND');
    const price = Number(orderData.salePrice || 0);
    const balance = Number(user.balance || 0);
    if (balance + 1e-9 < price) {
      const error = apiError('INSUFFICIENT_BALANCE');
      error.balance = balance;
      error.required = price;
      throw error;
    }
    const order = await VirtualNumberOrder.create({
      userId,
      providerId: orderData.providerId,
      serviceCode: orderData.serviceCode,
      serviceName: orderData.serviceName,
      countryId: String(orderData.countryId),
      countryName: orderData.countryName,
      providerCostUsd: orderData.providerCost,
      profitUsd: orderData.profit,
      salePriceUsd: price,
      status: 'reserving',
      expiresAt: new Date(Date.now() + ACTIVATION_TIMEOUT_MINUTES * 60_000)
    }, { transaction: tx });
    user.balance = balance - price;
    await user.save({ transaction: tx, fields: ['balance'] });
    await BalanceTransaction.create({
      userId,
      amount: -price,
      type: 'virtual_number_purchase',
      txid: `VN:${providerRecord(orderData.providerId).id}:${order.id}`,
      status: 'completed',
      paymentOrigin: 'wallet',
      caption: `${orderData.serviceName} / ${orderData.countryName}`
    }, { transaction: tx });
    await tx.commit();
    return order;
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

async function refundOrder(orderId, status = 'cancelled', providerStatus = '') {
  const tx = await sequelize.transaction();
  try {
    const order = await VirtualNumberOrder.findByPk(orderId, { transaction: tx, lock: tx.LOCK.UPDATE });
    if (!order) throw apiError('ORDER_NOT_FOUND');
    if (order.refundApplied) {
      await tx.commit();
      return { order, refunded: 0, alreadyRefunded: true };
    }
    const user = await User.findByPk(order.userId, { transaction: tx, lock: tx.LOCK.UPDATE });
    if (!user) throw apiError('USER_NOT_FOUND');
    const amount = Number(order.salePriceUsd || 0);
    user.balance = Number(user.balance || 0) + amount;
    await user.save({ transaction: tx, fields: ['balance'] });
    order.refundApplied = true;
    order.refundedAt = new Date();
    order.status = status;
    if (providerStatus) order.lastProviderStatus = String(providerStatus).slice(0, 255);
    await order.save({ transaction: tx });
    await BalanceTransaction.create({
      userId: order.userId,
      amount,
      type: 'virtual_number_refund',
      txid: `VN-REFUND:${order.providerId}:${order.id}`,
      status: 'completed',
      paymentOrigin: 'wallet',
      caption: `${order.serviceName} / ${order.countryName}`
    }, { transaction: tx });
    await tx.commit();
    await syncProviderCostReversal(order).catch(error => {
      console.error('Virtual number accounting reversal:', order.id, error.message);
    });
    return { order, refunded: amount, alreadyRefunded: false };
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

async function purchase({ providerId = 'smsbower', userId, serviceCode, serviceName, countryId, countryName, expectedRetailCents }) {
  const provider = providerRecord(providerId);
  const apiKey = await getProviderApiKey(providerId);
  if (!apiKey) throw apiError('PROVIDER_NOT_CONFIGURED');
  const lockKey = `${providerId}:${userId}`;
  if (purchaseLocks.has(lockKey)) throw apiError('PURCHASE_IN_PROGRESS');
  purchaseLocks.add(lockKey);
  let order = null;
  try {
    const freshQuote = await quote(providerId, serviceCode, countryId, true);
    if (!freshQuote || freshQuote.count < 1) throw apiError('NO_NUMBERS');
    const currentCents = Math.round(Number(freshQuote.retailPrice) * 100);
    if (Number(expectedRetailCents) !== currentCents) {
      const error = apiError('PRICE_CHANGED');
      error.quote = freshQuote;
      throw error;
    }
    order = await reserveCustomerWallet(userId, {
      providerId,
      serviceCode,
      serviceName,
      countryId,
      countryName: countryName || freshQuote.countryName,
      providerCost: freshQuote.providerCost,
      profit: freshQuote.profit,
      salePrice: freshQuote.retailPrice
    });

    let allocated;
    try {
      allocated = await provider.adapter.purchase(apiKey, {
        serviceCode,
        countryId,
        maxProviderCost: freshQuote.providerCost
      });
    } catch (error) {
      await refundOrder(order.id, 'failed', error.code || error.message).catch(() => {});
      throw error;
    }
    if (!allocated?.activationId || !allocated?.phoneNumber) {
      await refundOrder(order.id, 'failed', 'NO_NUMBERS').catch(() => {});
      throw apiError('NO_NUMBERS');
    }

    order.activationId = allocated.activationId;
    order.phoneNumber = allocated.phoneNumber;
    if (Number.isFinite(allocated.activationCost) && allocated.activationCost >= 0) order.providerCostUsd = allocated.activationCost;
    order.status = 'waiting_sms';
    order.rawProvider = allocated.raw || {};
    order.lastProviderStatus = 'STATUS_WAIT_CODE';
    order.expiresAt = new Date(Date.now() + ACTIVATION_TIMEOUT_MINUTES * 60_000);
    await order.save();
    await syncProviderCostAccounting(order).catch(error => {
      console.error('Virtual number provider-cost accounting:', order.id, error.message);
    });
    return order;
  } catch (error) {
    if (order && !order.activationId && !order.refundApplied) await refundOrder(order.id, 'failed', error.code || error.message).catch(() => {});
    throw error;
  } finally {
    purchaseLocks.delete(lockKey);
  }
}

async function markCompletedFromStatus(order, status) {
  const code = String(status || '').startsWith('STATUS_OK:') ? String(status).slice('STATUS_OK:'.length).trim() : '';
  if (!code) return null;
  const fresh = await VirtualNumberOrder.findByPk(order.id);
  if (!fresh || fresh.status !== 'waiting_sms') return null;
  fresh.smsCode = code;
  fresh.status = 'completed';
  fresh.completedAt = new Date();
  fresh.lastProviderStatus = String(status).slice(0, 255);
  await fresh.save();
  const provider = providerRecord(fresh.providerId);
  const apiKey = await getProviderApiKey(fresh.providerId);
  if (apiKey) provider.adapter.finish(apiKey, fresh.activationId).catch(() => {});
  return { type: 'sms', order: fresh, code };
}

async function cancelCustomerOrder(userId, orderId) {
  const order = await VirtualNumberOrder.findByPk(orderId);
  if (!order || String(order.userId) !== String(userId)) throw apiError('ORDER_NOT_FOUND');
  if (['cancelled', 'auto_cancelled', 'provider_cancelled', 'failed'].includes(order.status)) {
    return { order, alreadyDone: true, refunded: Number(order.refundApplied ? order.salePriceUsd : 0) };
  }
  if (order.status === 'completed') throw apiError('ORDER_ALREADY_COMPLETED');
  if (!order.activationId) return refundOrder(order.id, 'cancelled', 'LOCAL_CANCEL');

  const provider = providerRecord(order.providerId);
  const apiKey = await getProviderApiKey(order.providerId);
  if (!apiKey) throw apiError('PROVIDER_NOT_CONFIGURED');

  const currentStatus = await provider.adapter.getStatus(apiKey, order.activationId);
  order.lastProviderStatus = String(currentStatus || '').slice(0, 255);
  await order.save({ fields: ['lastProviderStatus'] });
  const completed = await markCompletedFromStatus(order, currentStatus);
  if (completed) throw apiError('ORDER_ALREADY_COMPLETED');
  if (currentStatus === 'STATUS_CANCEL') return refundOrder(order.id, 'provider_cancelled', currentStatus);

  const response = await provider.adapter.cancel(apiKey, order.activationId);
  if (/EARLY_CANCEL_DENIED/i.test(String(response))) throw apiError('EARLY_CANCEL_DENIED', response);
  if (!['ACCESS_CANCEL', 'STATUS_CANCEL'].includes(String(response))) throw apiError('CANCEL_NOT_CONFIRMED', String(response));
  const refunded = await refundOrder(order.id, 'cancelled', response);
  return { ...refunded, providerResponse: response };
}

async function pollPendingOrders(limit = 60) {
  const rows = await VirtualNumberOrder.findAll({
    where: { status: 'waiting_sms', activationId: { [Op.ne]: null } },
    order: [['createdAt', 'ASC']],
    limit: Math.max(1, Math.min(150, Number(limit) || 60))
  });
  const events = [];
  const concurrency = 8;
  for (let offset = 0; offset < rows.length; offset += concurrency) {
    const chunk = rows.slice(offset, offset + concurrency);
    const results = await Promise.all(chunk.map(async order => {
      try {
        const provider = providerRecord(order.providerId);
        const apiKey = await getProviderApiKey(order.providerId);
        if (!apiKey) return null;
        const status = await provider.adapter.getStatus(apiKey, order.activationId);
        order.lastProviderStatus = String(status || '').slice(0, 255);
        await order.save({ fields: ['lastProviderStatus'] });
        const completed = await markCompletedFromStatus(order, status);
        if (completed) return completed;
        if (status === 'STATUS_CANCEL') {
          const refund = await refundOrder(order.id, 'provider_cancelled', status);
          return { type: 'provider_cancelled', order: refund.order, refunded: refund.refunded };
        }
        if (order.expiresAt && new Date(order.expiresAt).getTime() <= Date.now()) {
          try {
            const response = await provider.adapter.cancel(apiKey, order.activationId);
            if (['ACCESS_CANCEL', 'STATUS_CANCEL'].includes(String(response))) {
              const refund = await refundOrder(order.id, 'auto_cancelled', response);
              return { type: 'expired_refund', order: refund.order, refunded: refund.refunded };
            }
            order.lastProviderStatus = String(response || status).slice(0, 255);
            await order.save({ fields: ['lastProviderStatus'] });
          } catch (error) {
            if (error.code !== 'PROVIDER_UNAVAILABLE') console.error('Virtual number expiry cancel:', order.id, error.code || error.message);
          }
        }
        return null;
      } catch (error) {
        if (error.code !== 'PROVIDER_UNAVAILABLE') console.error('Virtual number poll:', order.id, error.code || error.message, error.detail || '');
        return null;
      }
    }));
    for (const event of results) if (event) events.push(event);
  }
  return events;
}

async function listUserOrders(userId, limit = 10) {
  return VirtualNumberOrder.findAll({
    where: { userId },
    order: [['createdAt', 'DESC']],
    limit: Math.max(1, Math.min(30, Number(limit) || 10))
  });
}

module.exports = {
  DEFAULT_PROFIT,
  ACTIVATION_TIMEOUT_MINUTES,
  enabled,
  providerRecord,
  salePrice,
  retailPrice,
  clearAvailabilityCaches,
  getProviderApiKey,
  normalizeProviderApiKeyInput,
  validProviderApiKeyInput,
  detectProviderFromApiInput,
  hasProviderApi,
  hasAnyConfiguredProvider,
  getProviderProfit,
  setProviderProfit,
  testProviderApi,
  setProviderApiKey,
  removeProviderApiKey,
  providerStatus,
  providerStatuses,
  providerWallet,
  providerStats,
  getConfiguredProviders,
  getAllProviderAdminRows,
  getPublicProvider,
  getBalance,
  listServices,
  listCountries,
  availableServicesSummary,
  availabilityForService,
  quote,
  purchase,
  cancelCustomerOrder,
  pollPendingOrders,
  listUserOrders,
  syncProviderCostAccounting,
  syncProviderCostReversal,
  syncAccountingBacklog
};
