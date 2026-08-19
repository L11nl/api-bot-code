const axios = require('axios');
const { sequelize, Op, User, BalanceTransaction, VirtualNumberOrder } = require('../db');
const config = require('../config');

const servicesCache = { at: 0, value: [] };
const countriesCache = { at: 0, value: [] };
const pricesCache = new Map();
const allPricesCache = { at: 0, value: [] };
const purchaseLocks = new Set();

const SERVICES_TTL_MS = Math.max(60_000, Number(process.env.VIRTUAL_NUMBERS_SERVICES_CACHE_MS || 10 * 60_000));
const COUNTRIES_TTL_MS = Math.max(60_000, Number(process.env.VIRTUAL_NUMBERS_COUNTRIES_CACHE_MS || 24 * 60 * 60_000));
const PRICES_TTL_MS = Math.max(5_000, Number(process.env.VIRTUAL_NUMBERS_PRICES_CACHE_MS || 30_000));

function enabled() {
  return Boolean(config.virtualNumbers?.enabled && config.virtualNumbers?.apiKey && config.virtualNumbers?.baseUrl);
}

function roundMoney(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round((Number(value || 0) + Number.EPSILON) * factor) / factor;
}

// Virtual-number pricing requested by the store owner:
// <= $0.03       -> $0.30
// > $0.03 < $0.30 -> $0.50
// >= $0.30       -> provider cost + a fixed $0.30 margin.
// This guarantees that higher-cost numbers never sell below provider cost.
function retailPrice(providerCost) {
  const cost = Number(providerCost || 0);
  if (!Number.isFinite(cost) || cost < 0) return 0;
  if (cost <= 0.03 + 1e-9) return 0.30;
  if (cost < 0.30 - 1e-9) return 0.50;
  return roundMoney(cost + 0.30, 2);
}

function apiError(code, detail = '') {
  const error = new Error(code);
  error.code = code;
  error.detail = detail;
  return error;
}

async function apiRequest(action, extra = {}, options = {}) {
  if (!enabled()) throw apiError('VIRTUAL_NUMBERS_NOT_CONFIGURED');
  const params = {
    api_key: config.virtualNumbers.apiKey,
    action,
    ...extra
  };
  let response;
  try {
    response = await axios.get(config.virtualNumbers.baseUrl, {
      params,
      timeout: options.timeoutMs || config.virtualNumbers.timeoutMs,
      responseType: 'text',
      transformResponse: [data => data]
    });
  } catch (error) {
    throw apiError('PROVIDER_UNAVAILABLE', error?.message || 'request failed');
  }
  const text = typeof response.data === 'string' ? response.data.trim() : String(response.data ?? '').trim();
  if (/^(BAD_KEY|BAD_ACTION|BAD_SERVICE|BAD_COUNTRY|NO_ACTIVATION)/i.test(text)) {
    throw apiError(text.split(':')[0].trim().toUpperCase(), text);
  }
  return text;
}

function parseJson(text, fallback = null) {
  try { return JSON.parse(text); }
  catch { return fallback; }
}

async function getBalance() {
  const text = await apiRequest('getBalance');
  if (!text.startsWith('ACCESS_BALANCE:')) throw apiError('BAD_PROVIDER_RESPONSE', text);
  const amount = Number(text.slice('ACCESS_BALANCE:'.length));
  if (!Number.isFinite(amount)) throw apiError('BAD_PROVIDER_RESPONSE', text);
  return amount;
}


function safeProviderErrorText(value) {
  const text = String(value || '').replace(/api_key=[^&\s]+/gi, 'api_key=***').trim();
  return text.slice(0, 180);
}

async function probeProvider({ name, baseUrl, apiKey, walletUrl = '' }) {
  const startedAt = Date.now();
  const result = {
    name: String(name || 'Provider'),
    configured: Boolean(apiKey && baseUrl),
    siteReachable: false,
    apiWorking: false,
    keyState: apiKey ? 'unknown' : 'missing',
    balance: null,
    servicesWorking: false,
    servicesCount: null,
    walletConfigured: Boolean(walletUrl),
    walletReachable: null,
    latencyMs: null,
    errorCode: '',
    errorDetail: ''
  };

  if (!baseUrl) {
    result.errorCode = 'NO_BASE_URL';
    result.latencyMs = Date.now() - startedAt;
    return result;
  }

  const timeout = Math.min(10_000, Math.max(3_000, Number(config.virtualNumbers?.timeoutMs || 8_000)));
  const request = async action => {
    const response = await axios.get(baseUrl, {
      params: { api_key: apiKey || '__missing_api_key__', action },
      timeout,
      responseType: 'text',
      transformResponse: [data => data],
      validateStatus: status => status >= 200 && status < 500
    });
    return {
      status: Number(response.status || 0),
      text: typeof response.data === 'string' ? response.data.trim() : String(response.data ?? '').trim()
    };
  };

  try {
    const balanceResponse = await request('getBalance');
    result.siteReachable = true;
    const text = balanceResponse.text;
    if (!apiKey) {
      result.keyState = 'missing';
    } else if (/^ACCESS_BALANCE:/i.test(text)) {
      const balance = Number(text.slice(text.indexOf(':') + 1));
      result.keyState = 'valid';
      result.apiWorking = true;
      result.balance = Number.isFinite(balance) ? balance : null;
    } else if (/^BAD_KEY/i.test(text)) {
      result.keyState = 'invalid';
      result.errorCode = 'BAD_KEY';
    } else {
      result.errorCode = 'UNEXPECTED_BALANCE_RESPONSE';
      result.errorDetail = safeProviderErrorText(text);
    }
  } catch (error) {
    result.errorCode = 'UNREACHABLE';
    result.errorDetail = safeProviderErrorText(error?.message || 'request failed');
  }

  if (result.apiWorking && result.keyState === 'valid') {
    try {
      const servicesResponse = await request('getServicesList');
      const parsed = parseJson(servicesResponse.text);
      const rows = Array.isArray(parsed?.services) ? parsed.services : (Array.isArray(parsed) ? parsed : []);
      result.servicesCount = rows.filter(row => row && (row.code || row.id) && (row.name || row.title || row.code)).length;
      result.servicesWorking = result.servicesCount > 0;
      if (!result.servicesWorking && !result.errorCode) {
        result.errorCode = 'SERVICES_EMPTY';
        result.errorDetail = safeProviderErrorText(servicesResponse.text);
      }
    } catch (error) {
      if (!result.errorCode) result.errorCode = 'SERVICES_CHECK_FAILED';
      if (!result.errorDetail) result.errorDetail = safeProviderErrorText(error?.message || 'services request failed');
    }
  }

  if (walletUrl) {
    try {
      const walletResponse = await axios.get(walletUrl, {
        timeout,
        responseType: 'text',
        transformResponse: [data => data],
        validateStatus: status => status >= 200 && status < 500
      });
      result.walletReachable = Number(walletResponse.status || 0) >= 200 && Number(walletResponse.status || 0) < 400;
    } catch {
      result.walletReachable = false;
    }
  }

  result.latencyMs = Date.now() - startedAt;
  return result;
}

async function diagnoseProviders() {
  const secondary = config.virtualNumbers?.secondaryProvider || {};
  const [primary, second] = await Promise.all([
    probeProvider({
      name: 'SMSBower',
      baseUrl: config.virtualNumbers?.baseUrl,
      apiKey: config.virtualNumbers?.apiKey
    }),
    probeProvider({
      name: secondary.name || 'GrizzlySMS',
      baseUrl: secondary.baseUrl,
      apiKey: secondary.apiKey,
      walletUrl: secondary.walletUrl
    })
  ]);
  return { primary, secondary: second, checkedAt: new Date() };
}

async function listServices(force = false) {
  const now = Date.now();
  if (!force && servicesCache.value.length && now - servicesCache.at < SERVICES_TTL_MS) return servicesCache.value;
  const text = await apiRequest('getServicesList');
  const json = parseJson(text);
  let rows = [];
  if (json && Array.isArray(json.services)) rows = json.services;
  else if (Array.isArray(json)) rows = json;
  rows = rows
    .map(row => ({
      code: String(row?.code ?? row?.id ?? '').trim(),
      name: String(row?.name ?? row?.title ?? row?.code ?? '').trim()
    }))
    .filter(row => row.code && row.name)
    .filter(row => /^[A-Za-z0-9_-]{1,24}$/.test(row.code));
  const seen = new Set();
  rows = rows.filter(row => {
    if (seen.has(row.code)) return false;
    seen.add(row.code);
    return true;
  }).sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  if (!rows.length) throw apiError('NO_SERVICES_AVAILABLE', text.slice(0, 200));
  servicesCache.at = now;
  servicesCache.value = rows;
  return rows;
}

function flattenCountries(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.countries)) return json.countries;
  if (Array.isArray(json.data)) return json.data;
  if (typeof json === 'object') {
    return Object.entries(json).map(([key, value]) => {
      if (value && typeof value === 'object') return { id: value.id ?? key, ...value };
      return { id: key, eng: String(value ?? key) };
    });
  }
  return [];
}

async function listCountries(force = false) {
  const now = Date.now();
  if (!force && countriesCache.value.length && now - countriesCache.at < COUNTRIES_TTL_MS) return countriesCache.value;
  const text = await apiRequest('getCountries');
  const json = parseJson(text);
  let rows = flattenCountries(json).map(row => ({
    id: String(row?.id ?? row?.country ?? row?.code ?? '').trim(),
    name: String(row?.eng ?? row?.en ?? row?.name ?? row?.rus ?? row?.id ?? '').trim()
  })).filter(row => row.id && row.name);
  const seen = new Set();
  rows = rows.filter(row => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
  if (!rows.length) throw apiError('NO_COUNTRIES_AVAILABLE', text.slice(0, 200));
  countriesCache.at = now;
  countriesCache.value = rows;
  return rows;
}

function extractPriceRows(json, serviceCode) {
  const out = [];
  if (!json || typeof json !== 'object') return out;
  for (const [countryId, countryData] of Object.entries(json)) {
    if (!countryData || typeof countryData !== 'object') continue;
    let serviceData = countryData[serviceCode];
    if (!serviceData && String(countryId) === String(serviceCode)) continue;
    if (!serviceData && ('cost' in countryData || 'price' in countryData)) serviceData = countryData;
    if (!serviceData || typeof serviceData !== 'object') continue;

    let cost = Number(serviceData.cost ?? serviceData.price);
    let count = Number(serviceData.count ?? 0);
    if (!Number.isFinite(cost)) {
      const priceTiers = Object.entries(serviceData)
        .map(([price, amount]) => ({ price: Number(price), count: Number(amount) }))
        .filter(row => Number.isFinite(row.price) && Number.isFinite(row.count) && row.count > 0)
        .sort((a, b) => a.price - b.price);
      if (priceTiers.length) {
        cost = priceTiers[0].price;
        count = priceTiers.reduce((sum, row) => sum + row.count, 0);
      }
    }
    if (!Number.isFinite(cost) || cost < 0 || !Number.isFinite(count) || count <= 0) continue;
    out.push({ countryId: String(countryId), providerCost: cost, count: Math.floor(count) });
  }
  return out;
}

function parseServicePriceData(serviceData) {
  if (!serviceData || typeof serviceData !== 'object') return null;
  let cost = Number(serviceData.cost ?? serviceData.price);
  let count = Number(serviceData.count ?? 0);
  if (!Number.isFinite(cost)) {
    const priceTiers = Object.entries(serviceData)
      .map(([price, amount]) => ({ price: Number(price), count: Number(amount) }))
      .filter(row => Number.isFinite(row.price) && Number.isFinite(row.count) && row.count > 0)
      .sort((a, b) => a.price - b.price);
    if (priceTiers.length) {
      cost = priceTiers[0].price;
      count = priceTiers.reduce((sum, row) => sum + row.count, 0);
    }
  }
  if (!Number.isFinite(cost) || cost < 0 || !Number.isFinite(count) || count <= 0) return null;
  return { providerCost: cost, count: Math.floor(count), retailPrice: retailPrice(cost) };
}

// One getPrices call without service returns availability for the whole catalog.
// This is used to hide dead service buttons before the customer taps them.
async function availableServicesSummary(force = false) {
  const now = Date.now();
  if (!force && allPricesCache.value.length && now - allPricesCache.at < PRICES_TTL_MS) return allPricesCache.value;
  const text = await apiRequest('getPrices');
  const json = parseJson(text);
  const byService = new Map();
  if (json && typeof json === 'object') {
    for (const countryData of Object.values(json)) {
      if (!countryData || typeof countryData !== 'object') continue;
      for (const [serviceCode, serviceData] of Object.entries(countryData)) {
        const parsed = parseServicePriceData(serviceData);
        if (!parsed) continue;
        const key = String(serviceCode || '').trim();
        if (!/^[A-Za-z0-9_-]{1,24}$/.test(key)) continue;
        const current = byService.get(key) || { serviceCode: key, count: 0, providerCost: Infinity, retailPrice: Infinity };
        current.count += parsed.count;
        if (parsed.retailPrice < current.retailPrice || (parsed.retailPrice === current.retailPrice && parsed.providerCost < current.providerCost)) {
          current.providerCost = parsed.providerCost;
          current.retailPrice = parsed.retailPrice;
        }
        byService.set(key, current);
      }
    }
  }
  const value = [...byService.values()]
    .filter(row => row.count > 0 && Number.isFinite(row.retailPrice))
    .sort((a, b) => Number(a.retailPrice) - Number(b.retailPrice) || String(a.serviceCode).localeCompare(String(b.serviceCode)));
  allPricesCache.at = now;
  allPricesCache.value = value;
  return value;
}

async function availabilityForService(serviceCode, force = false) {
  const code = String(serviceCode || '').trim();
  if (!/^[A-Za-z0-9_-]{1,24}$/.test(code)) throw apiError('BAD_SERVICE');
  const cached = pricesCache.get(code);
  if (!force && cached && Date.now() - cached.at < PRICES_TTL_MS) return cached.value;
  const text = await apiRequest('getPrices', { service: code });
  const json = parseJson(text);
  const rows = extractPriceRows(json, code);
  const countries = await listCountries().catch(() => []);
  const countryMap = new Map(countries.map(row => [String(row.id), row.name]));
  const value = rows.map(row => ({
    ...row,
    countryName: countryMap.get(String(row.countryId)) || `Country ${row.countryId}`,
    retailPrice: retailPrice(row.providerCost)
  })).sort((a, b) =>
    Number(a.retailPrice || 0) - Number(b.retailPrice || 0) ||
    Number(a.providerCost || 0) - Number(b.providerCost || 0) ||
    a.countryName.localeCompare(b.countryName, 'en', { sensitivity: 'base' })
  );
  pricesCache.set(code, { at: Date.now(), value });
  return value;
}

async function quote(serviceCode, countryId, force = false) {
  const rows = await availabilityForService(serviceCode, force);
  return rows.find(row => String(row.countryId) === String(countryId)) || null;
}

async function getNumberV2(serviceCode, countryId, maxPrice) {
  const text = await apiRequest('getNumberV2', {
    service: serviceCode,
    country: countryId,
    maxPrice: Number(maxPrice).toFixed(4)
  });
  const json = parseJson(text);
  if (json && (json.activationId || json.phoneNumber)) {
    return {
      activationId: String(json.activationId || '').trim(),
      phoneNumber: String(json.phoneNumber || '').trim(),
      activationCost: Number(json.activationCost),
      raw: json
    };
  }
  if (text.startsWith('ACCESS_NUMBER:')) {
    const parts = text.split(':');
    return {
      activationId: String(parts[1] || '').trim(),
      phoneNumber: String(parts[2] || '').trim(),
      activationCost: Number(maxPrice),
      raw: { legacy: text }
    };
  }
  if (/^(NO_NUMBERS|NO_NUMBER|NO_BALANCE|NO_MONEY|ERROR_SQL|WRONG_MAX_PRICE|BAD_SERVICE|BAD_COUNTRY)/i.test(text)) {
    throw apiError(text.split(':')[0].trim().toUpperCase(), text);
  }
  throw apiError('BAD_PROVIDER_RESPONSE', text.slice(0, 300));
}

async function getStatus(activationId) {
  return apiRequest('getStatus', { id: activationId });
}

async function setStatus(activationId, status) {
  return apiRequest('setStatus', { id: activationId, status });
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
      serviceCode: orderData.serviceCode,
      serviceName: orderData.serviceName,
      countryId: String(orderData.countryId),
      countryName: orderData.countryName,
      providerCostUsd: orderData.providerCost,
      salePriceUsd: price,
      status: 'reserving',
      expiresAt: new Date(Date.now() + config.virtualNumbers.activationTimeoutMinutes * 60_000)
    }, { transaction: tx });
    user.balance = balance - price;
    await user.save({ transaction: tx, fields: ['balance'] });
    await BalanceTransaction.create({
      userId,
      amount: -price,
      type: 'virtual_number_purchase',
      txid: `VN:${order.id}`,
      status: 'completed',
      caption: `${orderData.serviceName} / ${orderData.countryName}`,
      paymentOrigin: 'wallet'
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
      txid: `VN-REFUND:${order.id}`,
      status: 'completed',
      caption: `${order.serviceName} / ${order.countryName}`,
      paymentOrigin: 'wallet'
    }, { transaction: tx });
    await tx.commit();
    await syncProviderCostReversal(order).catch(error => {
      console.error('Virtual number provider-cost reversal:', order.id, error.message);
    });
    return { order, refunded: amount, alreadyRefunded: false };
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

async function purchase({ userId, serviceCode, serviceName, countryId, countryName, expectedRetailCents }) {
  const lockKey = String(userId);
  if (purchaseLocks.has(lockKey)) throw apiError('PURCHASE_IN_PROGRESS');
  purchaseLocks.add(lockKey);
  let order = null;
  try {
    const freshQuote = await quote(serviceCode, countryId, true);
    if (!freshQuote || freshQuote.count < 1) throw apiError('NO_NUMBERS');
    const currentCents = Math.round(Number(freshQuote.retailPrice) * 100);
    if (Number(expectedRetailCents) !== currentCents) {
      const error = apiError('PRICE_CHANGED');
      error.quote = freshQuote;
      throw error;
    }
    order = await reserveCustomerWallet(userId, {
      serviceCode,
      serviceName,
      countryId,
      countryName: countryName || freshQuote.countryName,
      providerCost: freshQuote.providerCost,
      salePrice: freshQuote.retailPrice
    });

    let provider;
    try {
      provider = await getNumberV2(serviceCode, countryId, freshQuote.providerCost);
    } catch (error) {
      await refundOrder(order.id, 'failed', error.code || error.message).catch(() => {});
      throw error;
    }
    if (!provider.activationId || !provider.phoneNumber) {
      await refundOrder(order.id, 'failed', 'BAD_NUMBER_RESPONSE').catch(() => {});
      throw apiError('BAD_PROVIDER_RESPONSE');
    }
    order.activationId = provider.activationId;
    order.phoneNumber = provider.phoneNumber;
    if (Number.isFinite(provider.activationCost) && provider.activationCost >= 0) order.providerCostUsd = provider.activationCost;
    order.status = 'waiting_sms';
    order.rawProvider = provider.raw || {};
    order.lastProviderStatus = 'STATUS_WAIT_CODE';
    // Start the five-minute protection window from the moment the real number
    // is allocated, not from the earlier wallet-reservation step.
    order.expiresAt = new Date(Date.now() + 5 * 60_000);
    await order.save();
    await syncProviderCostAccounting(order).catch(error => {
      console.error('Virtual number provider-cost accounting:', order.id, error.message);
    });
    return order;
  } finally {
    purchaseLocks.delete(lockKey);
  }
}

async function cancelCustomerOrder(userId, orderId) {
  const order = await VirtualNumberOrder.findByPk(orderId);
  if (!order || String(order.userId) !== String(userId)) throw apiError('ORDER_NOT_FOUND');
  if (['cancelled', 'auto_cancelled', 'provider_cancelled', 'failed'].includes(order.status)) {
    return { order, alreadyDone: true, refunded: Number(order.refundApplied ? order.salePriceUsd : 0) };
  }
  if (order.status === 'completed') throw apiError('ORDER_ALREADY_COMPLETED');
  if (!order.activationId) {
    const refunded = await refundOrder(order.id, 'cancelled', 'LOCAL_CANCEL');
    return { ...refunded, providerResponse: 'LOCAL_CANCEL' };
  }
  const response = await setStatus(order.activationId, 8);
  if (response === 'EARLY_CANCEL_DENIED') throw apiError('EARLY_CANCEL_DENIED', response);
  if (!['ACCESS_CANCEL', 'STATUS_CANCEL'].includes(response)) {
    if (/EARLY_CANCEL_DENIED/i.test(response)) throw apiError('EARLY_CANCEL_DENIED', response);
    throw apiError('CANCEL_NOT_CONFIRMED', response);
  }
  const refunded = await refundOrder(order.id, 'cancelled', response);
  return { ...refunded, providerResponse: response };
}

async function pollPendingOrders(limit = 40) {
  if (!enabled()) return [];
  const rows = await VirtualNumberOrder.findAll({
    where: { status: 'waiting_sms', activationId: { [Op.ne]: null } },
    order: [['createdAt', 'ASC']],
    limit: Math.max(1, Math.min(100, Number(limit) || 40))
  });
  const events = [];
  const concurrency = 8;
  for (let offset = 0; offset < rows.length; offset += concurrency) {
    const chunk = rows.slice(offset, offset + concurrency);
    const results = await Promise.all(chunk.map(async order => {
      try {
        // Always check for an SMS first. This avoids cancelling at the five-minute
        // boundary when the provider already has the code waiting for us.
        const status = await getStatus(order.activationId);
        order.lastProviderStatus = String(status).slice(0, 255);
        await order.save({ fields: ['lastProviderStatus'] });
        if (status.startsWith('STATUS_OK:')) {
          const code = status.slice('STATUS_OK:'.length).trim();
          const fresh = await VirtualNumberOrder.findByPk(order.id);
          if (!fresh || fresh.status !== 'waiting_sms') return null;
          fresh.smsCode = code;
          fresh.status = 'completed';
          fresh.completedAt = new Date();
          fresh.lastProviderStatus = status.slice(0, 255);
          await fresh.save();
          setStatus(fresh.activationId, 6).catch(error => console.error('Virtual number close activation:', fresh.id, error.message));
          return { type: 'sms', order: fresh, code };
        }
        if (status === 'STATUS_CANCEL') {
          const refund = await refundOrder(order.id, 'provider_cancelled', status);
          return { type: 'provider_cancelled', order: refund.order, refunded: refund.refunded };
        }

        // No code arrived. Once five minutes pass, ask the provider to cancel.
        // Refund only after the provider confirms cancellation, so wallet money
        // and provider money can never diverge. If the provider/API is briefly
        // unavailable, the order remains waiting_sms and the watcher retries.
        if (order.expiresAt && new Date(order.expiresAt).getTime() <= Date.now()) {
          try {
            const cancelResponse = await setStatus(order.activationId, 8);
            if (['ACCESS_CANCEL', 'STATUS_CANCEL'].includes(cancelResponse)) {
              const refund = await refundOrder(order.id, 'auto_cancelled', cancelResponse);
              return { type: 'expired_refund', order: refund.order, refunded: refund.refunded };
            }
            order.lastProviderStatus = String(cancelResponse || status).slice(0, 255);
            await order.save({ fields: ['lastProviderStatus'] });
          } catch (error) {
            console.error('Virtual number expiry cancel:', order.id, error.message);
          }
        }
        return null;
      } catch (error) {
        if (!['PROVIDER_UNAVAILABLE'].includes(error.code)) {
          console.error('Virtual number poll:', order.id, error.code || error.message, error.detail || '');
        }
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
  enabled,
  retailPrice,
  getBalance,
  diagnoseProviders,
  listServices,
  listCountries,
  availableServicesSummary,
  availabilityForService,
  quote,
  purchase,
  cancelCustomerOrder,
  pollPendingOrders,
  syncAccountingBacklog,
  syncProviderCostAccounting,
  syncProviderCostReversal,
  listUserOrders
};
