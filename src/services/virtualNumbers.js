const { sequelize, Op, User, BalanceTransaction, VirtualNumberOrder, getSetting, setSetting } = require('../db');
const { encryptPayload, decryptPayload, isEncrypted } = require('../cryptoStore');
const smsbower = require('../providers/smsbower');
const smsman = require('../providers/smsman');

const DEFAULT_PROFIT = 0.15;
const ACTIVATION_TIMEOUT_MINUTES = 10;
const purchaseLocks = new Set();

const PROVIDERS = {
  smsbower: {
    id: 'smsbower',
    adminName: 'SMSBower',
    adapter: smsbower,
    apiSetting: 'virtual_numbers_smsbower_api',
    profitSetting: 'virtual_numbers_smsbower_profit',
    envKey: 'SMSBOWER_API_KEY'
  },
  smsman: {
    id: 'smsman',
    adminName: 'SMS-MAN',
    adapter: smsman,
    apiSetting: 'virtual_numbers_smsman_api',
    profitSetting: 'virtual_numbers_smsman_profit',
    envKey: 'SMSMAN_API_KEY'
  }
};

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

function decodeStoredSecret(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (!isEncrypted(raw)) return raw;
  try {
    const payload = decryptPayload(raw);
    return String(payload?.value || payload?.apiKey || '').trim();
  } catch {
    return '';
  }
}

async function getProviderApiKey(providerId) {
  const provider = providerRecord(providerId);
  const storedRaw = String(await getSetting(provider.apiSetting, '') || '').trim();
  if (storedRaw === '__DISABLED__') return '';
  const stored = decodeStoredSecret(storedRaw);
  if (stored) return stored;
  return String(process.env[provider.envKey] || '').trim();
}

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
  const key = String(apiKey || await getProviderApiKey(providerId) || '').trim();
  if (!key) throw apiError('BAD_KEY');
  const balance = await provider.adapter.getBalance(key);
  return { providerId: provider.id, balance };
}

async function setProviderApiKey(providerId, apiKey) {
  const provider = providerRecord(providerId);
  const key = String(apiKey || '').trim();
  if (!key) {
    await setSetting(provider.apiSetting, '__DISABLED__');
    return { configured: false, removed: true };
  }
  const test = await testProviderApi(providerId, key);
  await setSetting(provider.apiSetting, encryptPayload({ value: key }));
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
  await setSetting(provider.apiSetting, '__DISABLED__');
  return { configured: false };
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
  rows.sort((a, b) => b.purchased - a.purchased || b.completed - a.completed || a.id.localeCompare(b.id));
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

async function listServices(providerId, force = false) {
  const provider = providerRecord(providerId);
  const apiKey = await getProviderApiKey(providerId);
  if (!apiKey) throw apiError('PROVIDER_NOT_CONFIGURED');
  return provider.adapter.listServices(apiKey, force);
}

async function availableServicesSummary(providerId, force = false) {
  const provider = providerRecord(providerId);
  const apiKey = await getProviderApiKey(providerId);
  if (!apiKey) throw apiError('PROVIDER_NOT_CONFIGURED');
  return provider.adapter.availableServicesSummary(apiKey, force);
}

async function availabilityForService(providerId, serviceCode, force = false) {
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
  const rows = await availabilityForService(providerId, serviceCode, force);
  return rows.find(row => String(row.countryId) === String(countryId)) || null;
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
    user.balance = roundMoney(balance - price, 2);
    await user.save({ transaction: tx, fields: ['balance'] });
    await BalanceTransaction.create({
      userId,
      amount: -price,
      type: 'virtual_number_purchase',
      txid: `VN:${providerRecord(orderData.providerId).id}:${order.id}`,
      status: 'completed',
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
    user.balance = roundMoney(Number(user.balance || 0) + amount, 2);
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
      caption: `${order.serviceName} / ${order.countryName}`
    }, { transaction: tx });
    await tx.commit();
    return { order, refunded: amount, alreadyRefunded: false };
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

async function purchase({ providerId, userId, serviceCode, serviceName, countryId, countryName, expectedRetailCents }) {
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
  providerRecord,
  salePrice,
  getProviderApiKey,
  hasProviderApi,
  hasAnyConfiguredProvider,
  getProviderProfit,
  setProviderProfit,
  testProviderApi,
  setProviderApiKey,
  removeProviderApiKey,
  providerStats,
  getConfiguredProviders,
  getAllProviderAdminRows,
  getPublicProvider,
  listServices,
  availableServicesSummary,
  availabilityForService,
  quote,
  purchase,
  cancelCustomerOrder,
  pollPendingOrders,
  listUserOrders
};
