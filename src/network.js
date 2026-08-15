const crypto = require('crypto');
const axios = require('axios');
const config = require('./config');
const {
  sequelize,
  User,
  Merchant,
  Code,
  PurchaseOrder,
  PaymentMethod,
  NetworkClient,
  NetworkSettlement,
  NetworkPaymentIntent,
  NetworkSharedPaymentMethod,
  NetworkSharedPaymentRequest,
  NetworkDebtPayment,
  getIqdRate,
  getSuperQiNumber,
  getSetting
} = require('./db');
const { encryptPayload } = require('./cryptoStore');
const { inventoryFingerprint, escapeHtml } = require('./utils');
const { getProductStock, getProductStocksMap, fulfillOrder } = require('./services/orders');
const binancePay = require('./payments/binancePay');
const ledger = require('./services/networkLedger');

// Runtime caches for read-heavy network data. They cut repeated HTTP/DB work
// from every button press while keeping writes authoritative.
const CATALOG_CACHE_TTL_MS = Math.max(3000, Number(process.env.NETWORK_CATALOG_CACHE_TTL_MS || 12000));
const SHARED_METHODS_CACHE_TTL_MS = Math.max(3000, Number(process.env.NETWORK_SHARED_METHODS_CACHE_TTL_MS || 12000));
const SHARED_DISCOVERY_TTL_MS = Math.max(10000, Number(process.env.NETWORK_SHARED_DISCOVERY_TTL_MS || 30000));
let catalogSyncCache = { at: 0, products: null };
let catalogSyncPromise = null;
let sharedMethodsCache = { at: 0, data: null };
let sharedDiscoveryAt = 0;
let sharedDiscoveryPromise = null;
let fallbackPaymentsCache = { at: 0, data: null };
let publicPaymentProfileHash = '';
let publicPaymentProfileSyncedAt = 0;
let masterCatalogSnapshotCache = { at: 0, products: null };
const authClientCache = new Map();
const AUTH_CLIENT_CACHE_TTL_MS = Math.max(5000, Number(process.env.NETWORK_AUTH_CACHE_TTL_MS || 15000));

function invalidateSharedMethodsCache() { sharedMethodsCache = { at: 0, data: null }; }
function invalidateCatalogCache() {
  catalogSyncCache = { at: 0, products: null };
  masterCatalogSnapshotCache = { at: 0, products: null };
}


function role() { return config.network.role; }
function isClient() { return role() === 'client'; }
function isMaster() { return role() === 'master'; }
function enabledClient() { return isClient() && config.network.apiUrl && config.network.apiKey; }
function hashKey(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
function newApiKey() { return `net_${crypto.randomBytes(24).toString('hex')}`; }
function clientDatabaseSchema(shopId) {
  const suffix = String(shopId || '').replace(/^shop-/, '').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 40) || crypto.randomBytes(6).toString('hex');
  return `client_${suffix}`;
}
function newProductId() { return crypto.randomUUID(); }
function newPaymentIntentId() { return `NPI-${crypto.randomBytes(12).toString('hex').toUpperCase()}`; }
function newSharedPaymentRequestId() { return `SPR-${crypto.randomBytes(12).toString('hex').toUpperCase()}`; }
function localShopId() { return enabledClient() ? String(config.network.shopId) : 'master'; }
function sharedPaymentMethodId(ownerShopId, ownerLocalMethodId) {
  const digest = crypto.createHash('sha256').update(`${String(ownerShopId)}:${String(ownerLocalMethodId)}`).digest('hex').slice(0, 28);
  return `spm_${digest}`;
}
function normalizePaymentCurrency(value) {
  const code = String(value || 'USD').toUpperCase();
  return ['USD', 'IQD', 'EGP'].includes(code) ? code : 'USD';
}

function normalizeMinimumTransferAmount(value, currency) {
  const code = normalizePaymentCurrency(currency);
  const numeric = Number(value);
  const fallback = code === 'IQD' ? 1 : 0.01;
  const amount = Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
  if (code === 'IQD') return Math.max(1, Math.ceil(amount));
  return Math.max(0.01, Math.ceil((amount - 1e-9) * 100) / 100);
}


function clientHeaders() {
  return {
    'x-store-api-key': config.network.apiKey,
    'x-store-shop-id': config.network.shopId
  };
}

async function clientRequest(method, path, data, options = {}) {
  if (!enabledClient()) throw new Error('NETWORK_API_NOT_CONFIGURED');
  const normalizedMethod = String(method || 'get').toLowerCase();
  const timeout = Number(options.timeout || (normalizedMethod === 'get' ? 7000 : 12000));
  const response = await axios({
    method: normalizedMethod,
    url: `${config.network.apiUrl}${path}`,
    data,
    headers: clientHeaders(),
    timeout,
    validateStatus: status => status >= 200 && status < 500
  });
  if (response.status >= 400 || response.data?.ok === false) {
    const error = new Error(response.data?.error || `NETWORK_HTTP_${response.status}`);
    error.responseData = response.data;
    throw error;
  }
  return response.data;
}

async function authenticateRequest(req) {
  if (!isMaster()) return null;
  const apiEnabled = String(await getSetting('network_api_enabled', 'true')).toLowerCase() !== 'false';
  if (!apiEnabled) return null;
  const key = String(req.headers['x-store-api-key'] || '').trim();
  if (!key) return null;
  const digest = hashKey(key);
  const cached = authClientCache.get(digest);
  if (cached && Date.now() - cached.at < AUTH_CLIENT_CACHE_TTL_MS) return cached.client;
  const row = await NetworkClient.findOne({ where: { apiKeyHash: digest, isActive: true } });
  if (row) authClientCache.set(digest, { at: Date.now(), client: row });
  return row || null;
}

async function createClient({ name, ownerTelegramId, settlementCurrency = 'USD' }) {
  if (!isMaster()) throw new Error('MASTER_ONLY');
  const apiKey = newApiKey();
  const shopId = `shop-${crypto.randomBytes(6).toString('hex')}`;
  const currency = ['USD', 'IQD', 'EGP'].includes(String(settlementCurrency).toUpperCase())
    ? String(settlementCurrency).toUpperCase()
    : 'USD';
  const row = await NetworkClient.create({
    shopId,
    name: String(name || 'Partner').trim(),
    ownerTelegramId: ownerTelegramId ? String(ownerTelegramId) : null,
    apiKeyHash: hashKey(apiKey),
    settlementCurrency: currency,
    isActive: true,
    capabilities: {
      products: true,
      localPayments: true,
      fallbackPayments: true,
      apiControl: false
    }
  });
  return { row, apiKey, databaseSchema: clientDatabaseSchema(shopId) };
}

async function catalogSnapshot() {
  if (masterCatalogSnapshotCache.products && Date.now() - masterCatalogSnapshotCache.at < 5000) {
    return masterCatalogSnapshotCache.products;
  }
  const products = await Merchant.findAll({ where: { isActive: true }, order: [['sortOrder', 'ASC'], ['id', 'ASC']] });
  const sharedProducts = products.filter(product => String(product.type || '') !== 'service');
  const stocks = await getProductStocksMap(sharedProducts);
  const snapshot = sharedProducts.map(product => ({
    networkProductId: product.networkProductId,
    nameAr: product.nameAr,
    nameEn: product.nameEn,
    price: Number(product.price),
    category: product.category,
    type: product.type,
    description: product.description || {},
    image: product.image || null,
    isActive: Boolean(product.isActive),
    sharedLimit: Number(product.sharedLimit || 1),
    deliveryMode: product.deliveryMode,
    sortOrder: Number(product.sortOrder || 0),
    stock: Number(stocks.get(Number(product.id)) || 0),
    networkOwnerShopId: product.networkOwnerShopId || 'master'
  }));
  masterCatalogSnapshotCache = { at: Date.now(), products: snapshot };
  return snapshot;
}

async function productStockProtection(merchantId, productOwnerShopId = 'master') {
  const schema = `"${String(config.databaseSchema).replace(/"/g, '""')}"`;
  const [rows] = await sequelize.query(`
    SELECT
      COALESCE(MAX(COALESCE("contributionPriceUsd",0)),0)::numeric AS "maxContributionPriceUsd",
      COALESCE(SUM(CASE WHEN COALESCE(NULLIF("stockOwnerShopId", ''), 'master') <> :productOwnerShopId
                        THEN GREATEST(COALESCE("maxUses",1)-COALESCE("usedCount",0),0) ELSE 0 END),0)::int AS "externalAvailable"
    FROM ${schema}."Codes"
    WHERE "merchantId" = :merchantId
      AND COALESCE("isUsed", FALSE) = FALSE
      AND COALESCE("usedCount",0) < COALESCE("maxUses",1)
      AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
  `, { replacements: { merchantId, productOwnerShopId: String(productOwnerShopId || 'master') } });
  return {
    maxContributionPriceUsd: Number(rows?.[0]?.maxContributionPriceUsd || 0),
    externalAvailable: Number(rows?.[0]?.externalAvailable || 0)
  };
}

async function syncCatalogToLocalNow() {
  if (!enabledClient()) return null;
  const thisShopId = String(config.network.shopId || '');

  // Service products are local-only. This compatibility pass is small and only
  // updates legacy rows when their ownership flags are actually wrong.
  const localServices = await Merchant.findAll({ where: { type: 'service' } });
  for (const service of localServices) {
    const owner = String(service.networkOwnerShopId || '').trim();
    if (!owner || owner === thisShopId) {
      if (service.networkManaged || service.ownerNote !== 'Local service') {
        await service.update({
          networkManaged: false,
          networkOwnerShopId: thisShopId,
          isActive: true,
          ownerNote: 'Local service'
        });
      }
    } else if (service.isActive) {
      await service.update({ isActive: false });
    }
  }

  const data = await clientRequest('get', '/api/v1/catalog');
  const remoteProducts = (data.products || []).filter(remote => String(remote.type || '') !== 'service');
  const values = remoteProducts.map(remote => ({
    nameAr: remote.nameAr,
    nameEn: remote.nameEn,
    price: Number(remote.price),
    category: remote.category || 'general',
    type: remote.type || 'free',
    description: remote.description || {},
    image: remote.image || null,
    isActive: Boolean(remote.isActive),
    sharedLimit: Number(remote.sharedLimit || 1),
    deliveryMode: remote.deliveryMode || 'instant',
    sortOrder: Number(remote.sortOrder || 0),
    networkProductId: remote.networkProductId,
    networkManaged: true,
    networkOwnerShopId: remote.networkOwnerShopId || null,
    networkStock: Number(remote.stock || 0)
  })).filter(row => row.networkProductId);

  // One PostgreSQL upsert replaces N findOne + N update queries.
  if (values.length) {
    await Merchant.bulkCreate(values, {
      updateOnDuplicate: [
        'nameAr', 'nameEn', 'price', 'category', 'type', 'description', 'image',
        'isActive', 'sharedLimit', 'deliveryMode', 'sortOrder', 'networkManaged',
        'networkOwnerShopId', 'networkStock'
      ]
    });
  }

  const seen = remoteProducts.map(remote => String(remote.networkProductId || '')).filter(Boolean);
  const { Op } = require('sequelize');
  const staleWhere = { networkManaged: true, type: { [Op.ne]: 'service' } };
  if (seen.length) staleWhere.networkProductId = { [Op.notIn]: seen };
  await Merchant.update({ isActive: false }, { where: staleWhere });
  return data.products || [];
}

async function syncCatalogToLocal(options = {}) {
  if (!enabledClient()) return null;
  const force = options === true || Boolean(options?.force);
  const now = Date.now();
  if (!force && catalogSyncCache.products && now - catalogSyncCache.at < CATALOG_CACHE_TTL_MS) {
    return catalogSyncCache.products;
  }
  if (catalogSyncPromise) return catalogSyncPromise;
  catalogSyncPromise = syncCatalogToLocalNow()
    .then(products => {
      catalogSyncCache = { at: Date.now(), products: Array.isArray(products) ? products : [] };
      return catalogSyncCache.products;
    })
    .catch(error => {
      // If the master has a short hiccup, keep the last good catalog instead of
      // making the customer's button wait/fail.
      if (catalogSyncCache.products) return catalogSyncCache.products;
      throw error;
    })
    .finally(() => { catalogSyncPromise = null; });
  return catalogSyncPromise;
}

async function createRemoteProduct(payload) {
  const result = await clientRequest('post', '/api/v1/products', payload);
  invalidateCatalogCache();
  return result;
}

async function updateRemoteProduct(networkProductId, payload) {
  const result = await clientRequest('patch', `/api/v1/products/${encodeURIComponent(networkProductId)}`, payload);
  invalidateCatalogCache();
  return result;
}

async function deleteRemoteProduct(networkProductId) {
  const result = await clientRequest('delete', `/api/v1/products/${encodeURIComponent(networkProductId)}`);
  invalidateCatalogCache();
  return result;
}

async function addRemoteInventory(networkProductId, items, options = {}) {
  const result = await clientRequest('post', `/api/v1/products/${encodeURIComponent(networkProductId)}/inventory`, {
    items,
    suppressNotification: Boolean(options.suppressNotification)
  });
  invalidateCatalogCache();
  return result;
}

async function fulfillRemote({ networkProductId, quantity, localOrderId, customerId }) {
  const result = await clientRequest('post', '/api/v1/fulfill', {
    networkProductId,
    quantity,
    localOrderId,
    customerId
  });
  invalidateCatalogCache();
  return result;
}

async function lookupRemoteDelivery(deliveryId) {
  return clientRequest('get', `/api/v1/deliveries/${encodeURIComponent(deliveryId)}`);
}

async function fallbackPayments() {
  if (!enabledClient()) return { methods: [] };
  const now = Date.now();
  if (fallbackPaymentsCache.data && now - fallbackPaymentsCache.at < SHARED_METHODS_CACHE_TTL_MS) {
    return fallbackPaymentsCache.data;
  }
  try {
    const data = await clientRequest('get', '/api/v1/payment-options');
    fallbackPaymentsCache = { at: Date.now(), data };
    return data;
  } catch (error) {
    if (fallbackPaymentsCache.data) return fallbackPaymentsCache.data;
    throw error;
  }
}

async function localPublicBinanceProfile() {
  const ready = await binancePay.configured();
  if (!ready) return { binanceReady: false, binancePayId: null };
  const runtime = await binancePay.getRuntimeConfig();
  return { binanceReady: true, binancePayId: String(runtime.payId || '').trim() || null };
}

async function syncPublicPaymentProfile() {
  const profile = await localPublicBinanceProfile();
  if (isMaster()) return { shopId: 'master', ...profile };
  if (!enabledClient()) return { shopId: localShopId(), ...profile };
  const hash = crypto.createHash('sha256').update(JSON.stringify(profile)).digest('hex');
  if (hash === publicPaymentProfileHash && Date.now() - publicPaymentProfileSyncedAt < 300000) {
    return { shopId: localShopId(), ...profile, cached: true };
  }
  const result = await clientRequest('post', '/api/v1/shop-profile', profile);
  publicPaymentProfileHash = hash;
  publicPaymentProfileSyncedAt = Date.now();
  return result;
}

async function paymentProfileForShop(shopIdRaw) {
  const shopId = String(shopIdRaw || '').trim() || 'master';
  if (shopId === 'master') {
    const profile = await localPublicBinanceProfile();
    return { shopId: 'master', shopName: config.network.ownerName || 'المالك الرئيسي', ...profile };
  }
  const client = await NetworkClient.findOne({ where: { shopId, isActive: true } });
  if (!client) return { shopId, shopName: shopId, binanceReady: false, binancePayId: null };
  return {
    shopId: client.shopId,
    shopName: client.name,
    binanceReady: Boolean(client.binanceReady && client.binancePayId),
    binancePayId: client.binancePayId || null
  };
}

async function getCounterpartyPaymentProfile(shopId) {
  if (isMaster()) return paymentProfileForShop(shopId);
  if (!enabledClient()) return { shopId, binanceReady: false, binancePayId: null };
  return clientRequest('get', `/api/v1/shops/${encodeURIComponent(String(shopId))}/payment-profile`);
}

async function startDebtBinancePayment(counterpartyShopId) {
  if (!enabledClient()) throw new Error('NETWORK_API_NOT_CONFIGURED');
  return clientRequest('post', '/api/v1/accounts/pay/start', { counterpartyShopId });
}

async function submitDebtBinanceOrder(requestId, orderId) {
  if (isMaster()) return { request: (await ledger.submitDebtBinanceOrder(requestId, 'master', orderId)).toJSON() };
  if (!enabledClient()) throw new Error('NETWORK_API_NOT_CONFIGURED');
  return clientRequest('post', `/api/v1/accounts/payments/${encodeURIComponent(requestId)}/order-id`, { orderId });
}

async function ownedDebtBinanceVerifications() {
  if (isMaster()) {
    const rows = await ledger.debtBinanceVerificationsForCreditor('master');
    return { requests: await Promise.all(rows.map(async row => ({
      ...row.toJSON(),
      debtorName: await ledger.getShopName(row.debtorShopId),
      creditorName: await ledger.getShopName(row.creditorShopId)
    }))) };
  }
  if (!enabledClient()) return { requests: [] };
  return clientRequest('get', '/api/v1/accounts/payments/verify-owned');
}

async function finishDebtBinanceVerification(requestId, result) {
  if (isMaster()) return { request: (await ledger.finishDebtBinanceVerification(requestId, 'master', result)).toJSON() };
  if (!enabledClient()) throw new Error('NETWORK_API_NOT_CONFIGURED');
  return clientRequest('post', `/api/v1/accounts/payments/${encodeURIComponent(requestId)}/verify-result`, result || {});
}

async function debtPaymentResults() {
  if (isMaster()) {
    const rows = await ledger.debtPaymentResultsForDebtor('master');
    return { requests: await Promise.all(rows.map(async row => ({
      ...row.toJSON(),
      debtorName: await ledger.getShopName(row.debtorShopId),
      creditorName: await ledger.getShopName(row.creditorShopId)
    }))) };
  }
  if (!enabledClient()) return { requests: [] };
  return clientRequest('get', '/api/v1/accounts/payments/results');
}

async function acknowledgeDebtPaymentResult(requestId) {
  if (isMaster()) return { request: (await ledger.acknowledgeDebtPaymentResult(requestId, 'master')).toJSON() };
  if (!enabledClient()) throw new Error('NETWORK_API_NOT_CONFIGURED');
  return clientRequest('post', `/api/v1/accounts/payments/${encodeURIComponent(requestId)}/ack-result`, {});
}

async function upsertSharedPaymentMethod(payload) {
  const localId = Number(payload?.localMethodId || payload?.id || 0);
  if (!Number.isInteger(localId) || localId <= 0) throw new Error('INVALID_LOCAL_PAYMENT_METHOD_ID');
  const body = {
    localMethodId: localId,
    nameAr: String(payload?.nameAr || '').trim(),
    nameEn: String(payload?.nameEn || payload?.nameAr || '').trim(),
    paymentNumber: String(payload?.paymentNumber || '').trim(),
    iconCustomEmojiId: payload?.iconCustomEmojiId ? String(payload.iconCustomEmojiId) : null,
    iconAlt: String(payload?.iconAlt || '💳'),
    settlementCurrency: normalizePaymentCurrency(payload?.settlementCurrency),
    ratePerUsd: Number(payload?.ratePerUsd || 1),
    minimumTransferAmount: normalizeMinimumTransferAmount(payload?.minimumTransferAmount, payload?.settlementCurrency),
    isActive: payload?.isActive !== false
  };
  if (!body.nameAr || !body.paymentNumber) throw new Error('INVALID_SHARED_PAYMENT_METHOD');
  if (isMaster()) {
    const ownerShopId = 'master';
    const id = sharedPaymentMethodId(ownerShopId, localId);
    const [row] = await NetworkSharedPaymentMethod.findOrCreate({
      where: { id },
      defaults: { id, ownerShopId, ownerLocalMethodId: localId, ...body }
    });
    await row.update({ ownerShopId, ownerLocalMethodId: localId, ...body });
    invalidateSharedMethodsCache();
    return { method: row.toJSON() };
  }
  if (!enabledClient()) return { method: null };
  return clientRequest('post', '/api/v1/shared-payment-methods', body);
}

async function syncSharedPaymentMethodsSnapshot(methods = []) {
  const normalized = (Array.isArray(methods) ? methods : []).map(method => ({
    localMethodId: Number(method?.localMethodId || method?.id || 0),
    nameAr: String(method?.nameAr || '').trim(),
    nameEn: String(method?.nameEn || method?.nameAr || '').trim(),
    paymentNumber: String(method?.paymentNumber || '').trim(),
    iconCustomEmojiId: method?.iconCustomEmojiId ? String(method.iconCustomEmojiId) : null,
    iconAlt: String(method?.iconAlt || '💳'),
    settlementCurrency: normalizePaymentCurrency(method?.settlementCurrency),
    ratePerUsd: Number(method?.ratePerUsd || 1),
    minimumTransferAmount: normalizeMinimumTransferAmount(method?.minimumTransferAmount, method?.settlementCurrency),
    isActive: method?.isActive !== false
  })).filter(method => Number.isInteger(method.localMethodId) && method.localMethodId > 0 && method.nameAr && method.paymentNumber);

  if (isMaster()) {
    const ownerShopId = 'master';
    const seen = [];
    for (const body of normalized) {
      const id = sharedPaymentMethodId(ownerShopId, body.localMethodId);
      seen.push(id);
      const [row] = await NetworkSharedPaymentMethod.findOrCreate({
        where: { id },
        defaults: { id, ownerShopId, ownerLocalMethodId: body.localMethodId, ...body }
      });
      await row.update({ ownerShopId, ownerLocalMethodId: body.localMethodId, ...body });
    }
    const where = { ownerShopId };
    if (seen.length) where.id = { [require('sequelize').Op.notIn]: seen };
    await NetworkSharedPaymentMethod.update({ isActive: false }, { where });
    invalidateSharedMethodsCache();
    return { synced: normalized.length };
  }
  if (!enabledClient()) return { synced: 0 };
  const result = await clientRequest('post', '/api/v1/shared-payment-methods/sync', { methods: normalized });
  invalidateSharedMethodsCache();
  return result;
}


async function discoverSharedPaymentMethodsFromClientSchemasNow() {
  if (!isMaster()) return;
  const clients = await NetworkClient.findAll({ where: { isActive: true }, attributes: ['shopId'] });
  const { Op } = require('sequelize');
  for (const client of clients) {
    const ownerShopId = String(client.shopId);
    const schema = clientDatabaseSchema(ownerShopId);
    let rows;
    try {
      [rows] = await sequelize.query(`
        SELECT *
        FROM "${schema}"."PaymentMethods"
        ORDER BY "id" ASC
      `);
    } catch (error) {
      continue;
    }

    const values = [];
    const seenIds = [];
    for (const method of rows || []) {
      const localId = Number(method.id || 0);
      if (!Number.isInteger(localId) || localId <= 0) continue;
      const nameAr = String(method.nameAr || '').trim();
      const paymentNumber = String(method.paymentNumber || '').trim();
      if (!nameAr || !paymentNumber) continue;
      const id = sharedPaymentMethodId(ownerShopId, localId);
      seenIds.push(id);
      values.push({
        id,
        ownerShopId,
        ownerLocalMethodId: localId,
        nameAr,
        nameEn: String(method.nameEn || method.nameAr || '').trim(),
        paymentNumber,
        iconCustomEmojiId: method.iconCustomEmojiId ? String(method.iconCustomEmojiId) : null,
        iconAlt: String(method.iconAlt || '💳'),
        settlementCurrency: normalizePaymentCurrency(method.settlementCurrency),
        ratePerUsd: Number(method.ratePerUsd || 1),
        minimumTransferAmount: normalizeMinimumTransferAmount(method.minimumTransferAmount, method.settlementCurrency),
        isActive: method.isActive !== false
      });
    }

    if (values.length) {
      await NetworkSharedPaymentMethod.bulkCreate(values, {
        updateOnDuplicate: [
          'ownerShopId', 'ownerLocalMethodId', 'nameAr', 'nameEn', 'paymentNumber',
          'iconCustomEmojiId', 'iconAlt', 'settlementCurrency', 'ratePerUsd',
          'minimumTransferAmount', 'isActive'
        ]
      });
    }

    const where = { ownerShopId };
    if (seenIds.length) where.id = { [Op.notIn]: seenIds };
    await NetworkSharedPaymentMethod.update({ isActive: false }, { where });
  }
}

async function discoverSharedPaymentMethodsFromClientSchemas(options = {}) {
  if (!isMaster()) return;
  const force = options === true || Boolean(options?.force);
  if (!force && Date.now() - sharedDiscoveryAt < SHARED_DISCOVERY_TTL_MS) return;
  if (sharedDiscoveryPromise) return sharedDiscoveryPromise;
  sharedDiscoveryPromise = discoverSharedPaymentMethodsFromClientSchemasNow()
    .then(() => {
      sharedDiscoveryAt = Date.now();
      invalidateSharedMethodsCache();
    })
    .finally(() => { sharedDiscoveryPromise = null; });
  return sharedDiscoveryPromise;
}

async function readMasterSharedPaymentMethods() {
  const now = Date.now();
  if (sharedMethodsCache.data && now - sharedMethodsCache.at < SHARED_METHODS_CACHE_TTL_MS) return sharedMethodsCache.data;
  const rows = await NetworkSharedPaymentMethod.findAll({ where: { isActive: true }, order: [['settlementCurrency', 'ASC'], ['createdAt', 'ASC']] });
  const methods = await Promise.all(rows.map(async row => ({ ...row.toJSON(), ownerShopName: await ledger.getShopName(row.ownerShopId) })));
  const data = { methods };
  sharedMethodsCache = { at: Date.now(), data };
  return data;
}

async function listSharedPaymentMethods() {
  if (isMaster()) {
    // Discovery is a fallback repair mechanism, not a reason to hold a customer
    // button. Refresh it in the background and serve the registry immediately.
    discoverSharedPaymentMethodsFromClientSchemas().catch(error => console.error('Shared payment discovery:', error.message));
    return readMasterSharedPaymentMethods();
  }
  if (!enabledClient()) return { methods: [] };
  const now = Date.now();
  if (sharedMethodsCache.data && now - sharedMethodsCache.at < SHARED_METHODS_CACHE_TTL_MS) return sharedMethodsCache.data;
  try {
    const data = await clientRequest('get', '/api/v1/shared-payment-methods');
    sharedMethodsCache = { at: Date.now(), data };
    return data;
  } catch (error) {
    if (sharedMethodsCache.data) return sharedMethodsCache.data;
    throw error;
  }
}

async function createSharedPaymentRequest(payload) {
  if (isMaster()) return createSharedPaymentRequestForSource('master', payload);
  if (!enabledClient()) throw new Error('NETWORK_API_NOT_CONFIGURED');
  return clientRequest('post', '/api/v1/shared-payment-requests', payload);
}

async function createSharedPaymentRequestForSource(sourceShopIdRaw, payload) {
  const sourceShopId = String(sourceShopIdRaw || 'master');
  const method = await NetworkSharedPaymentMethod.findByPk(String(payload?.sharedPaymentMethodId || ''));
  if (!method || !method.isActive) throw new Error('SHARED_PAYMENT_METHOD_NOT_FOUND');
  const amountUsd = Number(payload?.amountUsd || 0);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) throw new Error('INVALID_AMOUNT');
  const sourceRef = String(payload?.sourceRef || '').trim();
  const sourceEntityId = String(payload?.sourceEntityId || '').trim();
  if (!sourceRef || !sourceEntityId) throw new Error('SOURCE_REF_REQUIRED');
  const paymentCurrency = normalizePaymentCurrency(method.settlementCurrency);
  const rate = Number(method.ratePerUsd || 1);
  const safeRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
  const calculatedPaymentAmount = amountUsd * safeRate;
  const explicitPaymentAmount = Number(payload?.paymentAmount);
  let paymentAmount = Number.isFinite(explicitPaymentAmount) && explicitPaymentAmount > 0 ? explicitPaymentAmount : calculatedPaymentAmount;
  if (Number.isFinite(explicitPaymentAmount) && explicitPaymentAmount > 0) {
    const explicitUsd = explicitPaymentAmount / safeRate;
    if (Math.abs(explicitUsd - amountUsd) > 0.011) throw new Error('PAYMENT_AMOUNT_MISMATCH');
  }
  const minimumTransferAmount = normalizeMinimumTransferAmount(method.minimumTransferAmount, paymentCurrency);
  if (paymentAmount + 1e-9 < minimumTransferAmount) {
    const error = new Error('BELOW_MINIMUM_TRANSFER');
    error.minimumTransferAmount = minimumTransferAmount;
    error.paymentCurrency = paymentCurrency;
    throw error;
  }
  const [row] = await NetworkSharedPaymentRequest.findOrCreate({
    where: { sourceShopId, sourceRef },
    defaults: {
      id: newSharedPaymentRequestId(),
      sharedPaymentMethodId: method.id,
      paymentOwnerShopId: method.ownerShopId,
      sourceShopId,
      activity: ['purchase', 'topup'].includes(String(payload?.activity)) ? String(payload.activity) : 'purchase',
      sourceRef,
      sourceEntityId,
      customerId: payload?.customerId ? String(payload.customerId) : null,
      customerName: payload?.customerName ? String(payload.customerName).slice(0,160) : null,
      amountUsd,
      paymentCurrency,
      paymentAmount,
      status: 'waiting_owner',
      sourceHandled: false
    }
  });
  return { request: row.toJSON(), method: { ...method.toJSON(), ownerShopName: await ledger.getShopName(method.ownerShopId) } };
}

async function ownedSharedPaymentRequests() {
  if (isMaster()) {
    const rows = await NetworkSharedPaymentRequest.findAll({ where: { paymentOwnerShopId: 'master', status: 'waiting_owner' }, order: [['createdAt','ASC']], limit: 100 });
    return decorateSharedPaymentRequests(rows);
  }
  if (!enabledClient()) return { requests: [] };
  return clientRequest('get', '/api/v1/shared-payment-requests/owned');
}

async function sourceSharedPaymentResults() {
  if (isMaster()) {
    const rows = await NetworkSharedPaymentRequest.findAll({ where: { sourceShopId: 'master', sourceHandled: false, status: { [require('sequelize').Op.in]: ['approved','rejected'] } }, order: [['resolvedAt','ASC']], limit: 100 });
    return decorateSharedPaymentRequests(rows);
  }
  if (!enabledClient()) return { requests: [] };
  return clientRequest('get', '/api/v1/shared-payment-requests/results');
}

async function decorateSharedPaymentRequests(rows) {
  const requests = [];
  for (const row of rows || []) {
    const method = await NetworkSharedPaymentMethod.findByPk(row.sharedPaymentMethodId);
    requests.push({
      ...row.toJSON(),
      method: method ? method.toJSON() : null,
      paymentOwnerShopName: await ledger.getShopName(row.paymentOwnerShopId),
      sourceShopName: await ledger.getShopName(row.sourceShopId)
    });
  }
  return { requests };
}

async function resolveSharedPaymentRequest(requestId, approve, actor = {}) {
  if (isMaster()) return resolveSharedPaymentRequestForOwner('master', requestId, approve, actor);
  if (!enabledClient()) throw new Error('NETWORK_API_NOT_CONFIGURED');
  return clientRequest('post', `/api/v1/shared-payment-requests/${encodeURIComponent(requestId)}/resolve`, { approve: Boolean(approve), actor });
}

async function resolveSharedPaymentRequestForOwner(ownerShopIdRaw, requestId, approve, actor = {}) {
  const ownerShopId = String(ownerShopIdRaw || 'master');
  const tx = await sequelize.transaction();
  try {
    const row = await NetworkSharedPaymentRequest.findByPk(String(requestId), { transaction: tx, lock: tx.LOCK.UPDATE });
    if (!row || String(row.paymentOwnerShopId) !== ownerShopId) throw new Error('SHARED_PAYMENT_REQUEST_NOT_FOUND');
    if (row.status !== 'waiting_owner') {
      await tx.commit();
      return { request: row.toJSON(), alreadyResolved: true };
    }
    row.status = approve ? 'approved' : 'rejected';
    row.resolvedAt = new Date();
    if (approve) {
      row.approvedByTelegramId = actor?.telegramId ? String(actor.telegramId) : null;
      row.approvedByUsername = actor?.username ? String(actor.username).replace(/^@/, '').slice(0, 64) : null;
      row.approvedByDisplayName = actor?.displayName ? String(actor.displayName).slice(0, 160) : null;
    }
    await row.save({ transaction: tx });
    await tx.commit();
    if (approve && ownerShopId !== String(row.sourceShopId)) {
      // Money physically landed in the payment-method owner's account. Therefore
      // the owner owes the storefront the FULL captured amount. Product-owner
      // 90/10 commissions are accounted separately by the inventory ledger.
      await ledger.recordObligation({
        debtorShopId: ownerShopId,
        creditorShopId: row.sourceShopId,
        amountUsd: Number(row.amountUsd),
        kind: 'shared_payment_capture',
        sourceRef: `sharedpay:${row.id}`,
        metadata: { sharedPaymentMethodId: row.sharedPaymentMethodId, activity: row.activity, customerName: row.customerName || '' }
      });
    }
    return { request: row.toJSON() };
  } catch (error) {
    await tx.rollback().catch(() => {});
    throw error;
  }
}

async function acknowledgeSharedPaymentRequest(requestId) {
  if (isMaster()) {
    const row = await NetworkSharedPaymentRequest.findOne({ where: { id: String(requestId), sourceShopId: 'master' } });
    if (!row) throw new Error('SHARED_PAYMENT_REQUEST_NOT_FOUND');
    row.sourceHandled = true;
    await row.save({ fields: ['sourceHandled'] });
    return { ok: true };
  }
  if (!enabledClient()) throw new Error('NETWORK_API_NOT_CONFIGURED');
  return clientRequest('post', `/api/v1/shared-payment-requests/${encodeURIComponent(requestId)}/ack`, {});
}

async function createFallbackBinanceIntent(amountUsd, customerId, activity = 'payment', customerName = '') {
  return clientRequest('post', '/api/v1/payments/binance/intents', { amountUsd, customerId, activity, customerName });
}

async function verifyFallbackBinanceIntent(intentId, orderId) {
  return clientRequest('post', `/api/v1/payments/binance/intents/${encodeURIComponent(intentId)}/verify`, { orderId });
}

async function recordFallbackSettlement({ amountUsd, method, sourceRef, customerName, activity = 'payment' }) {
  if (!enabledClient()) return null;
  return clientRequest('post', '/api/v1/settlements', { amountUsd, method, sourceRef, customerName, activity });
}

async function getMySettlementSummary() {
  if (!enabledClient()) return null;
  return clientRequest('get', '/api/v1/settlements/me');
}

async function getMyAccounts() {
  if (!enabledClient()) return null;
  return clientRequest('get', '/api/v1/accounts/me');
}

async function getMyCommerceStatus() {
  if (!enabledClient()) return { suspended: false, liabilityUsd: 0, thresholdUsd: Number(config.network.debtSuspendThresholdUsd || 40) };
  const data = await clientRequest('get', '/api/v1/status/me');
  return data.status || { suspended: false, liabilityUsd: 0, thresholdUsd: Number(config.network.debtSuspendThresholdUsd || 40) };
}

async function getNotificationEvents(afterId = null) {
  if (!enabledClient()) return { events: [], latestId: 0 };
  const bootstrap = afterId == null;
  const query = bootstrap ? '?bootstrap=1' : `?after=${encodeURIComponent(String(Math.max(0, Number(afterId || 0))))}`;
  return clientRequest('get', `/api/v1/notifications/events${query}`);
}

async function publishNotificationEvent(event) {
  if (!isMaster()) throw new Error('MASTER_ONLY');
  return ledger.publishNotificationEvent(event);
}

async function localNotificationEventsAfter(afterId = 0) {
  if (!isMaster()) return [];
  return ledger.notificationEventsAfter(afterId);
}

async function latestLocalNotificationEventId() {
  if (!isMaster()) return 0;
  return ledger.latestNotificationEventId();
}

async function markDebtPaid(counterpartyShopId) {
  if (!enabledClient()) throw new Error('NETWORK_API_NOT_CONFIGURED');
  return clientRequest('post', '/api/v1/accounts/pay', { counterpartyShopId });
}

async function resolveIncomingDebtPayment(requestId, approve) {
  if (!enabledClient()) throw new Error('NETWORK_API_NOT_CONFIGURED');
  return clientRequest('post', `/api/v1/accounts/payments/${encodeURIComponent(requestId)}/resolve`, { approve: Boolean(approve) });
}

async function getProductContributors(networkProductId) {
  if (!enabledClient()) throw new Error('NETWORK_API_NOT_CONFIGURED');
  return clientRequest('get', `/api/v1/products/${encodeURIComponent(networkProductId)}/contributors`);
}

async function createSettlementForClient(client, payload) {
  const amountUsd = Number(payload.amountUsd || 0);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) throw new Error('INVALID_AMOUNT');
  const sourceMethod = String(payload.method || 'shared_payment');
  const sourceRef = payload.sourceRef ? String(payload.sourceRef) : null;
  if (sourceRef) {
    const existing = await NetworkSettlement.findOne({
      where: { debtorShopId: client.shopId, creditorShopId: 'master', sourceMethod, sourceRef }
    });
    if (existing) return existing;
  }
  const iqdRate = await getIqdRate();
  const egpRateRaw = Number(await getSetting('egp_rate_per_usd', String(config.network.egpRate || 50)));
  const egpRate = Number.isFinite(egpRateRaw) && egpRateRaw > 0 ? egpRateRaw : 50;

  // Settlement is always shown and recorded in the CLIENT SHOP currency,
  // regardless of which payment rail received the money. Binance/SuperQi/custom
  // remain recorded in sourceMethod only. This keeps Ahmed(EGP), Iraqi(IQD), etc.
  // consistent across customer screens and partner debts.
  const currency = ['USD', 'IQD', 'EGP'].includes(String(client.settlementCurrency || '').toUpperCase())
    ? String(client.settlementCurrency).toUpperCase()
    : 'USD';
  const methodRate = currency === 'IQD' ? iqdRate : currency === 'EGP' ? egpRate : 1;

  const iqdAmount = amountUsd * iqdRate;
  const egpAmount = amountUsd * egpRate;
  const settlementAmount = amountUsd * (Number.isFinite(methodRate) && methodRate > 0 ? methodRate : 1);
  return NetworkSettlement.create({
    debtorShopId: client.shopId,
    creditorShopId: 'master',
    amountUsd,
    iqdAmount,
    egpAmount,
    settlementCurrency: currency,
    settlementAmount,
    sourceMethod,
    sourceRef,
    customerName: payload.customerName ? String(payload.customerName).slice(0, 160) : null,
    status: 'open'
  });
}

async function settlementSummary(shopId) {
  const rows = await NetworkSettlement.findAll({ where: { debtorShopId: shopId, status: 'open' } });
  return rows.reduce((acc, row) => {
    acc.amountUsd += Number(row.amountUsd || 0);
    acc.iqdAmount += Number(row.iqdAmount || 0);
    acc.egpAmount += Number(row.egpAmount || 0);
    return acc;
  }, { amountUsd: 0, iqdAmount: 0, egpAmount: 0 });
}

async function notifySettlement(bot, client, row, summary, activity = 'payment') {
  if (!bot) return;
  const customer = row.customerName || 'زبون';
  const source = String(row.sourceMethod || 'shared_payment');
  let methodName = source === 'binance' ? 'Binance ID' : source === 'superqi' ? 'سوبركي' : 'طريقة دفع';
  if (source.startsWith('custom:')) {
    const method = await PaymentMethod.findByPk(Number(source.split(':')[1]));
    if (method) methodName = method.nameAr || method.nameEn || methodName;
  }
  const headline = activity === 'topup'
    ? `💰 تم شحن رصيد عن طريق <b>${escapeHtml(methodName)}</b> الخاص بك من <b>${escapeHtml(client.name)}</b>`
    : `💰 تم دفع طلب عن طريق <b>${escapeHtml(methodName)}</b> الخاص بك من <b>${escapeHtml(client.name)}</b>`;
  const shopCurrency = ['USD', 'IQD', 'EGP'].includes(String(client.settlementCurrency || '').toUpperCase())
    ? String(client.settlementCurrency).toUpperCase()
    : 'USD';
  const localValue = shopCurrency === 'IQD'
    ? `${Math.round(Number(row.iqdAmount || 0)).toLocaleString('en-US')} IQD`
    : shopCurrency === 'EGP'
      ? `${Number(row.egpAmount || 0).toFixed(2)} EGP`
      : `$${Number(row.amountUsd || 0).toFixed(2)}`;
  const summaryLocal = shopCurrency === 'IQD'
    ? `${Math.round(Number(summary.iqdAmount || 0)).toLocaleString('en-US')} IQD`
    : shopCurrency === 'EGP'
      ? `${Number(summary.egpAmount || 0).toFixed(2)} EGP`
      : `$${Number(summary.amountUsd || 0).toFixed(2)}`;
  const text = [
    headline,
    `الزبون: <b>${escapeHtml(customer)}</b>`,
    `المبلغ: <b>$${Number(row.amountUsd).toFixed(2)}</b>`,
    ...(shopCurrency === 'USD' ? [] : [`بعملة ${escapeHtml(client.name)} (${shopCurrency}): <b>${localValue}</b>`]),
    '',
    `<b>${escapeHtml(client.name)}</b> يطلبك الآن إجمالاً: <b>$${summary.amountUsd.toFixed(2)}</b>`,
    ...(shopCurrency === 'USD' ? [] : [`الإجمالي بعملة المتجر: <b>${summaryLocal}</b>`])
  ].join('\n');
  for (const adminId of config.admins) bot.sendMessage(adminId, text, { parse_mode: 'HTML' }).catch(() => {});
}

function installMasterRoutes(app, getBot) {
  const route = async (req, res, handler) => {
    try {
      const client = await authenticateRequest(req);
      if (!client) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
      const result = await handler(client);
      return res.json({ ok: true, ...result });
    } catch (error) {
      console.error('Network API:', error.message);
      return res.status(400).json({ ok: false, error: error.message });
    }
  };

  app.get('/api/v1/catalog', (req, res) => route(req, res, async () => ({
    // "service" is a local-only product type. Never expose it through the
    // shared network catalog, even if an old database row still exists.
    products: (await catalogSnapshot()).filter(product => String(product.type || '') !== 'service')
  })));

  app.get('/api/v1/status/me', (req, res) => route(req, res, async client => ({
    status: await ledger.commerceStatusForShop(client.shopId)
  })));

  app.get('/api/v1/notifications/events', (req, res) => route(req, res, async () => {
    const latestId = await ledger.latestNotificationEventId();
    if (String(req.query?.bootstrap || '') === '1') return { events: [], latestId };
    const after = Math.max(0, Number(req.query?.after || 0));
    const events = await ledger.notificationEventsAfter(after, 100);
    return { events: events.map(row => row.toJSON()), latestId };
  }));

  app.post('/api/v1/products', (req, res) => route(req, res, async client => {
    const body = req.body || {};
    const nameAr = String(body.nameAr || '').trim();
    const price = Number(body.price);
    const type = String(body.type || 'free');
    if (type === 'service') throw new Error('SERVICE_PRODUCTS_ARE_LOCAL_ONLY');
    if (!nameAr || nameAr.length > 160) throw new Error('INVALID_PRODUCT_NAME');
    if (!Number.isFinite(price) || price < 0 || price > 1000000) throw new Error('INVALID_PRODUCT_PRICE');
    if (!['code', 'account', 'free', 'private', 'shared'].includes(type)) throw new Error('INVALID_PRODUCT_TYPE');
    const networkProductId = newProductId();
    const [product] = await Merchant.findOrCreate({
      where: { networkProductId },
      defaults: {
        nameAr,
        nameEn: String(body.nameEn || nameAr).trim(),
        price,
        category: body.category || 'general',
        type,
        description: body.description || {},
        image: body.image || null,
        sharedLimit: Number(body.sharedLimit || 1),
        deliveryMode: body.deliveryMode || 'instant',
        isActive: true,
        networkManaged: false,
        networkOwnerShopId: client.shopId,
        ownerNote: `Added via ${client.shopId}`
      }
    });
    if (!product.nameAr) throw new Error('INVALID_PRODUCT');
    const event = await ledger.publishNotificationEvent({
      eventType: 'new_product',
      networkProductId: product.networkProductId,
      actorShopId: client.shopId,
      actorName: client.name,
      payload: { nameAr: product.nameAr, nameEn: product.nameEn, price: Number(product.price) }
    });
    invalidateCatalogCache();
    return { product: { ...(product.toJSON()), stock: await getProductStock(product.id) }, eventId: Number(event.id) };
  }));

  app.patch('/api/v1/products/:networkProductId', (req, res) => route(req, res, async client => {
    const product = await Merchant.findOne({ where: { networkProductId: req.params.networkProductId } });
    if (!product) throw new Error('PRODUCT_NOT_FOUND');
    if (String(product.networkOwnerShopId || 'master') !== String(client.shopId)) throw new Error('PRODUCT_NOT_OWNED');
    const body = req.body || {};
    if (String(body.type || '') === 'service') throw new Error('SERVICE_PRODUCTS_ARE_LOCAL_ONLY');
    const allowed = ['nameAr','nameEn','price','category','type','description','image','isActive','sharedLimit','deliveryMode','sortOrder'];
    const changes = {};
    for (const key of allowed) if (body[key] !== undefined) changes[key] = body[key];
    const protection = await productStockProtection(product.id, product.networkOwnerShopId || 'master');
    if (changes.price !== undefined && Number(changes.price) + 1e-9 < protection.maxContributionPriceUsd) {
      throw new Error(`PRICE_BELOW_STOCK_VALUE:${protection.maxContributionPriceUsd.toFixed(2)}`);
    }
    if (changes.isActive === false && protection.externalAvailable > 0) {
      throw new Error(`EXTERNAL_STOCK_EXISTS:${protection.externalAvailable}`);
    }
    if (protection.externalAvailable > 0 && ['type','sharedLimit','deliveryMode'].some(key => changes[key] !== undefined && changes[key] !== product[key])) {
      throw new Error(`STRUCTURE_LOCKED_BY_EXTERNAL_STOCK:${protection.externalAvailable}`);
    }
    await product.update(changes);
    invalidateCatalogCache();
    return { product: { ...(product.toJSON()), stock: await getProductStock(product.id) } };
  }));

  app.delete('/api/v1/products/:networkProductId', (req, res) => route(req, res, async client => {
    const product = await Merchant.findOne({ where: { networkProductId: req.params.networkProductId } });
    if (!product) throw new Error('PRODUCT_NOT_FOUND');
    if (String(product.networkOwnerShopId || 'master') !== String(client.shopId)) throw new Error('PRODUCT_NOT_OWNED');
    const protection = await productStockProtection(product.id, product.networkOwnerShopId || 'master');
    if (protection.externalAvailable > 0) throw new Error(`EXTERNAL_STOCK_EXISTS:${protection.externalAvailable}`);
    await product.update({ isActive: false });
    invalidateCatalogCache();
    return { deleted: true };
  }));

  app.post('/api/v1/products/:networkProductId/inventory', (req, res) => route(req, res, async client => {
    const product = await Merchant.findOne({ where: { networkProductId: req.params.networkProductId } });
    if (!product) throw new Error('PRODUCT_NOT_FOUND');
    // Any active partner can contribute stock to an existing shared product.
    // Product metadata still belongs to the original product owner.
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 1000) : [];
    const preparedByFingerprint = new Map();
    for (const payload of items) {
      const fingerprint = inventoryFingerprint(product.type, payload);
      if (!preparedByFingerprint.has(fingerprint)) preparedByFingerprint.set(fingerprint, payload);
    }
    const fingerprints = [...preparedByFingerprint.keys()];
    const { Op } = require('sequelize');
    const existingRows = fingerprints.length
      ? await Code.findAll({
          where: { merchantId: product.id, fingerprint: { [Op.in]: fingerprints } },
          attributes: ['fingerprint'],
          raw: true
        })
      : [];
    const existing = new Set(existingRows.map(row => String(row.fingerprint || '')));
    const newRows = [];
    for (const [fingerprint, payload] of preparedByFingerprint.entries()) {
      if (existing.has(fingerprint)) continue;
      newRows.push({
        value: encryptPayload(payload),
        extra: null,
        merchantId: product.id,
        isUsed: false,
        usedCount: 0,
        maxUses: product.type === 'shared' ? Math.max(1, Number(product.sharedLimit || 1)) : 1,
        buyers: [],
        fingerprint,
        stockOwnerShopId: client.shopId,
        contributionPriceUsd: Number(product.price || 0)
      });
    }
    if (newRows.length) await Code.bulkCreate(newRows);
    const added = newRows.length;
    let eventId = null;
    if (added > 0 && !Boolean(req.body?.suppressNotification)) {
      const event = await ledger.publishNotificationEvent({
        eventType: 'stock_added',
        networkProductId: product.networkProductId,
        actorShopId: client.shopId,
        actorName: client.name,
        amount: added,
        payload: { nameAr: product.nameAr, nameEn: product.nameEn, price: Number(product.price) }
      });
      eventId = Number(event.id);
    }
    if (added > 0) invalidateCatalogCache();
    return { added, stock: await getProductStock(product.id), sourceShopId: client.shopId, eventId };
  }));

  app.get('/api/v1/products/:networkProductId/contributors', (req, res) => route(req, res, async () => {
    const product = await Merchant.findOne({ where: { networkProductId: req.params.networkProductId } });
    if (!product) throw new Error('PRODUCT_NOT_FOUND');
    return { contributors: await ledger.salesStatsForProduct(product) };
  }));

  app.post('/api/v1/fulfill', (req, res) => route(req, res, async client => {
    const body = req.body || {};
    const product = await Merchant.findOne({ where: { networkProductId: body.networkProductId, isActive: true } });
    if (!product) throw new Error('PRODUCT_NOT_FOUND');
    const remoteRef = `${client.shopId}:${String(body.localOrderId)}`;
    const quantity = Math.max(1, Math.min(100, Number(body.quantity || 1)));
    if (!Number.isInteger(quantity)) throw new Error('INVALID_QUANTITY');
    const [order] = await PurchaseOrder.findOrCreate({
      where: { remoteOrderRef: remoteRef },
      defaults: {
        userId: String(body.customerId || 0),
        merchantId: product.id,
        quantity,
        unitPrice: Number(product.price),
        totalAmount: Number(product.price) * quantity,
        currency: 'USDT',
        paymentMethod: `network:${client.shopId}`,
        status: 'paid',
        paidAt: new Date(),
        remoteOrderRef: remoteRef,
        paymentOrigin: 'network_client'
      }
    });
    const result = await fulfillOrder(order.id, { paymentRef: remoteRef, sourceShopId: client.shopId });
    invalidateCatalogCache();
    const deliveries = [];
    for (const delivery of result.deliveries || []) {
      deliveries.push({
        ...delivery,
        inventoryOwnerShopName: await ledger.getShopName(delivery.inventoryOwnerShopId || 'master')
      });
    }
    return {
      remoteOrderId: order.id,
      product: { networkProductId: product.networkProductId, nameAr: product.nameAr, nameEn: product.nameEn, type: product.type },
      deliveries
    };
  }));

  app.get('/api/v1/deliveries/:deliveryId', (req, res) => route(req, res, async client => {
    const { DeliveryRecord } = require('./db');
    const row = await DeliveryRecord.findByPk(req.params.deliveryId);
    if (!row || String(row.sourceShopId || '') !== String(client.shopId)) throw new Error('DELIVERY_NOT_FOUND');
    const product = await Merchant.findByPk(row.merchantId);
    const delivery = row.toJSON();
    delivery.inventoryOwnerShopName = await ledger.getShopName(delivery.inventoryOwnerShopId || 'master');
    return { delivery, product: product ? { nameAr: product.nameAr, nameEn: product.nameEn, type: product.type } : null };
  }));

  app.get('/api/v1/shared-payment-methods', (req, res) => route(req, res, async () => {
    discoverSharedPaymentMethodsFromClientSchemas().catch(error => console.error('Shared payment discovery:', error.message));
    return readMasterSharedPaymentMethods();
  }));

  app.post('/api/v1/shared-payment-methods/sync', (req, res) => route(req, res, async client => {
    const methods = Array.isArray(req.body?.methods) ? req.body.methods.slice(0, 200) : [];
    const seenIds = [];
    let synced = 0;

    for (const body of methods) {
      const localMethodId = Number(body?.localMethodId || 0);
      if (!Number.isInteger(localMethodId) || localMethodId <= 0) continue;
      const values = {
        ownerShopId: client.shopId,
        ownerLocalMethodId: localMethodId,
        nameAr: String(body?.nameAr || '').trim(),
        nameEn: String(body?.nameEn || body?.nameAr || '').trim(),
        paymentNumber: String(body?.paymentNumber || '').trim(),
        iconCustomEmojiId: body?.iconCustomEmojiId ? String(body.iconCustomEmojiId) : null,
        iconAlt: String(body?.iconAlt || '💳'),
        settlementCurrency: normalizePaymentCurrency(body?.settlementCurrency),
        ratePerUsd: Number(body?.ratePerUsd || 1),
        minimumTransferAmount: normalizeMinimumTransferAmount(body?.minimumTransferAmount, body?.settlementCurrency),
        isActive: body?.isActive !== false
      };
      if (!values.nameAr || !values.paymentNumber) continue;
      const id = sharedPaymentMethodId(client.shopId, localMethodId);
      seenIds.push(id);
      const [row] = await NetworkSharedPaymentMethod.findOrCreate({ where: { id }, defaults: { id, ...values } });
      await row.update(values);
      synced += 1;
    }

    const where = { ownerShopId: client.shopId };
    if (seenIds.length) where.id = { [require('sequelize').Op.notIn]: seenIds };
    await NetworkSharedPaymentMethod.update({ isActive: false }, { where });

    invalidateSharedMethodsCache();
    return { synced };
  }));

  app.post('/api/v1/shared-payment-methods', (req, res) => route(req, res, async client => {
    const body = req.body || {};
    const localMethodId = Number(body.localMethodId || 0);
    if (!Number.isInteger(localMethodId) || localMethodId <= 0) throw new Error('INVALID_LOCAL_PAYMENT_METHOD_ID');
    const id = sharedPaymentMethodId(client.shopId, localMethodId);
    const values = {
      ownerShopId: client.shopId,
      ownerLocalMethodId: localMethodId,
      nameAr: String(body.nameAr || '').trim(),
      nameEn: String(body.nameEn || body.nameAr || '').trim(),
      paymentNumber: String(body.paymentNumber || '').trim(),
      iconCustomEmojiId: body.iconCustomEmojiId ? String(body.iconCustomEmojiId) : null,
      iconAlt: String(body.iconAlt || '💳'),
      settlementCurrency: normalizePaymentCurrency(body.settlementCurrency),
      ratePerUsd: Number(body.ratePerUsd || 1),
      minimumTransferAmount: normalizeMinimumTransferAmount(body.minimumTransferAmount, body.settlementCurrency),
      isActive: body.isActive !== false
    };
    if (!values.nameAr || !values.paymentNumber) throw new Error('INVALID_SHARED_PAYMENT_METHOD');
    const [row] = await NetworkSharedPaymentMethod.findOrCreate({ where: { id }, defaults: { id, ...values } });
    await row.update(values);
    return { method: { ...row.toJSON(), ownerShopName: client.name } };
  }));

  app.post('/api/v1/shared-payment-requests', (req, res) => route(req, res, async client => {
    return createSharedPaymentRequestForSource(client.shopId, req.body || {});
  }));

  app.get('/api/v1/shared-payment-requests/owned', (req, res) => route(req, res, async client => {
    const rows = await NetworkSharedPaymentRequest.findAll({ where: { paymentOwnerShopId: client.shopId, status: 'waiting_owner' }, order: [['createdAt','ASC']], limit: 100 });
    return decorateSharedPaymentRequests(rows);
  }));

  app.get('/api/v1/shared-payment-requests/results', (req, res) => route(req, res, async client => {
    const rows = await NetworkSharedPaymentRequest.findAll({
      where: { sourceShopId: client.shopId, sourceHandled: false, status: { [require('sequelize').Op.in]: ['approved','rejected'] } },
      order: [['resolvedAt','ASC']],
      limit: 100
    });
    return decorateSharedPaymentRequests(rows);
  }));

  app.post('/api/v1/shared-payment-requests/:id/resolve', (req, res) => route(req, res, async client => {
    return resolveSharedPaymentRequestForOwner(client.shopId, req.params.id, Boolean(req.body?.approve), req.body?.actor || {});
  }));

  app.post('/api/v1/shared-payment-requests/:id/ack', (req, res) => route(req, res, async client => {
    const row = await NetworkSharedPaymentRequest.findOne({ where: { id: req.params.id, sourceShopId: client.shopId } });
    if (!row) throw new Error('SHARED_PAYMENT_REQUEST_NOT_FOUND');
    row.sourceHandled = true;
    await row.save({ fields: ['sourceHandled'] });
    return { ok: true };
  }));

  app.post('/api/v1/shop-profile', (req, res) => route(req, res, async client => {
    const ready = Boolean(req.body?.binanceReady && String(req.body?.binancePayId || '').trim());
    client.binanceReady = ready;
    client.binancePayId = ready ? String(req.body.binancePayId).trim().slice(0, 120) : null;
    await client.save({ fields: ['binanceReady', 'binancePayId'] });
    return { shopId: client.shopId, binanceReady: client.binanceReady, binancePayId: client.binancePayId };
  }));

  app.get('/api/v1/shops/:shopId/payment-profile', (req, res) => route(req, res, async () => {
    return paymentProfileForShop(req.params.shopId);
  }));

  app.get('/api/v1/payment-options', (req, res) => route(req, res, async () => {
    const methods = [];
    if (await binancePay.configured()) {
      const runtime = await binancePay.getRuntimeConfig();
      methods.push({ type: 'binance', nameAr: 'Binance ID', nameEn: 'Binance ID', paymentNumber: runtime.payId, iconCustomEmojiId: '5875443023873053217', settlementCurrency: 'USD', ratePerUsd: 1 });
    }
    const superQi = await getSuperQiNumber();
    if (superQi) methods.push({ type: 'superqi', nameAr: 'سوبركي', nameEn: 'SuperQi', paymentNumber: superQi, iconCustomEmojiId: '5184203496831846429', settlementCurrency: 'IQD', ratePerUsd: await getIqdRate() });
    return { methods };
  }));

  app.post('/api/v1/payments/binance/intents', (req, res) => route(req, res, async client => {
    const status = await ledger.commerceStatusForShop(client.shopId);
    if (status.suspended) throw new Error(`SHOP_DEBT_SUSPENDED:${status.liabilityUsd.toFixed(2)}`);
    if (!(await binancePay.configured())) throw new Error('BINANCE_NOT_CONFIGURED');
    const amount = Number(req.body?.amountUsd || 0);
    if (!Number.isFinite(amount) || amount < 0.01) throw new Error('INVALID_AMOUNT');
    const runtime = await binancePay.getRuntimeConfig();
    const intent = await NetworkPaymentIntent.create({
      id: newPaymentIntentId(),
      shopId: client.shopId,
      customerId: req.body?.customerId ? String(req.body.customerId) : null,
      customerName: req.body?.customerName ? String(req.body.customerName).slice(0, 160) : null,
      activity: ['purchase', 'topup'].includes(String(req.body?.activity)) ? String(req.body.activity) : 'payment',
      amountUsd: amount,
      status: 'waiting',
      expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000)
    });
    return { intentId: intent.id, amountUsd: amount, payId: runtime.payId, expiresAt: intent.expiresAt };
  }));

  app.post('/api/v1/payments/binance/intents/:intentId/verify', (req, res) => route(req, res, async client => {
    const intent = await NetworkPaymentIntent.findOne({ where: { id: req.params.intentId, shopId: client.shopId } });
    if (!intent) throw new Error('INTENT_NOT_FOUND');
    if (intent.status === 'verified') {
      if (intent.transactionId) {
        await ledger.recordObligation({
          debtorShopId: 'master',
          creditorShopId: client.shopId,
          amountUsd: Number(intent.amountUsd),
          kind: 'fallback_payment_received',
          sourceRef: `binance:${intent.transactionId}`,
          metadata: { method: 'binance', activity: intent.activity || 'payment', customerName: intent.customerName || intent.customerId || 'زبون' }
        });
      }
      return { verified: true, transactionId: intent.transactionId };
    }
    if (new Date(intent.expiresAt).getTime() < Date.now()) throw new Error('INTENT_EXPIRED');
    const result = await binancePay.verifyStandalone({
      submittedOrderId: req.body?.orderId,
      expectedAmount: Number(intent.amountUsd),
      createdAt: intent.createdAt
    });
    if (!result.success) return { verified: false, reason: result.reason };
    intent.status = 'verified';
    intent.submittedOrderId = String(req.body?.orderId || '');
    intent.transactionId = result.transactionId;
    await intent.save();
    const recorded = await ledger.recordObligation({
      debtorShopId: 'master',
      creditorShopId: client.shopId,
      amountUsd: Number(intent.amountUsd),
      kind: 'fallback_payment_received',
      sourceRef: `binance:${result.transactionId}`,
      metadata: { method: 'binance', activity: intent.activity || 'payment', customerName: intent.customerName || intent.customerId || 'زبون' }
    });
    if (!recorded.duplicate) {
      const bot = getBot?.();
      if (bot) {
        const text = `💰 تم استلام $${Number(intent.amountUsd).toFixed(2)} عبر Binance الرئيسي لصالح ${escapeHtml(client.name)}. تم تسجيلها تلقائياً في الحسابات.`;
        for (const adminId of config.admins) bot.sendMessage(adminId, text).catch(() => {});
      }
    }
    return { verified: true, transactionId: result.transactionId };
  }));

  app.post('/api/v1/settlements', (req, res) => route(req, res, async client => {
    const body = req.body || {};
    const amountUsd = Number(body.amountUsd || 0);
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) throw new Error('INVALID_AMOUNT');
    const method = String(body.method || 'shared_payment');
    const sourceRef = String(body.sourceRef || `${client.shopId}:${Date.now()}`);
    const recorded = await ledger.recordObligation({
      debtorShopId: 'master',
      creditorShopId: client.shopId,
      amountUsd,
      kind: 'fallback_payment_received',
      sourceRef: `${method}:${sourceRef}`,
      metadata: { method, activity: body.activity || 'payment', customerName: body.customerName || 'زبون' }
    });
    return { duplicate: Boolean(recorded.duplicate), accounts: await ledger.accountsForShop(client.shopId) };
  }));

  app.get('/api/v1/settlements/me', (req, res) => route(req, res, async client => {
    const data = await ledger.accountsForShop(client.shopId);
    const masterAccount = data.accounts.find(row => row.counterpartyId === 'master');
    const amount = masterAccount && masterAccount.direction === 'owe' ? masterAccount.amountUsd : 0;
    const values = await ledger.currencySnapshot(amount);
    return {
      shop: { shopId: client.shopId, name: client.name, settlementCurrency: client.settlementCurrency },
      ownerName: config.network.ownerName,
      summary: { amountUsd: values.usd, iqdAmount: values.iqd, egpAmount: values.egp }
    };
  }));

  app.get('/api/v1/accounts/me', (req, res) => route(req, res, async client => ({
    accounts: await ledger.accountsForShop(client.shopId)
  })));

  app.post('/api/v1/accounts/pay/start', (req, res) => route(req, res, async client => {
    const counterpartyShopId = String(req.body?.counterpartyShopId || '').trim();
    if (!counterpartyShopId) throw new Error('COUNTERPARTY_REQUIRED');
    const profile = await paymentProfileForShop(counterpartyShopId);
    if (!profile.binanceReady || !profile.binancePayId) throw new Error('CREDITOR_BINANCE_NOT_CONFIGURED');
    const request = await ledger.createDebtPaymentRequest(client.shopId, counterpartyShopId, { binancePayId: profile.binancePayId });
    return { request: request.toJSON(), creditor: profile, accounts: await ledger.accountsForShop(client.shopId) };
  }));

  // Legacy endpoint kept so old buttons still start the Binance settlement flow.
  app.post('/api/v1/accounts/pay', (req, res) => route(req, res, async client => {
    const counterpartyShopId = String(req.body?.counterpartyShopId || '').trim();
    if (!counterpartyShopId) throw new Error('COUNTERPARTY_REQUIRED');
    const profile = await paymentProfileForShop(counterpartyShopId);
    if (!profile.binanceReady || !profile.binancePayId) throw new Error('CREDITOR_BINANCE_NOT_CONFIGURED');
    const request = await ledger.createDebtPaymentRequest(client.shopId, counterpartyShopId, { binancePayId: profile.binancePayId });
    return { request: request.toJSON(), creditor: profile, accounts: await ledger.accountsForShop(client.shopId) };
  }));

  app.post('/api/v1/accounts/payments/:id/order-id', (req, res) => route(req, res, async client => {
    const request = await ledger.submitDebtBinanceOrder(req.params.id, client.shopId, req.body?.orderId);
    return { request: request.toJSON() };
  }));

  app.get('/api/v1/accounts/payments/verify-owned', (req, res) => route(req, res, async client => {
    const rows = await ledger.debtBinanceVerificationsForCreditor(client.shopId);
    return { requests: await Promise.all(rows.map(async row => ({
      ...row.toJSON(),
      debtorName: await ledger.getShopName(row.debtorShopId),
      creditorName: client.name
    }))) };
  }));

  app.post('/api/v1/accounts/payments/:id/verify-result', (req, res) => route(req, res, async client => {
    const request = await ledger.finishDebtBinanceVerification(req.params.id, client.shopId, {
      success: Boolean(req.body?.success),
      transactionId: req.body?.transactionId,
      reason: req.body?.reason
    });
    return { request: request.toJSON() };
  }));

  app.get('/api/v1/accounts/payments/results', (req, res) => route(req, res, async client => {
    const rows = await ledger.debtPaymentResultsForDebtor(client.shopId);
    return { requests: await Promise.all(rows.map(async row => ({
      ...row.toJSON(),
      debtorName: client.name,
      creditorName: await ledger.getShopName(row.creditorShopId)
    }))) };
  }));

  app.post('/api/v1/accounts/payments/:id/ack-result', (req, res) => route(req, res, async client => {
    const request = await ledger.acknowledgeDebtPaymentResult(req.params.id, client.shopId);
    return { request: request.toJSON() };
  }));

  app.post('/api/v1/accounts/payments/:id/resolve', (req, res) => route(req, res, async client => {
    const request = await ledger.resolveDebtPaymentRequest(req.params.id, client.shopId, Boolean(req.body?.approve));
    return { request: request.toJSON(), accounts: await ledger.accountsForShop(client.shopId) };
  }));
}

module.exports = {
  role,
  isClient,
  isMaster,
  enabledClient,
  createClient,
  clientDatabaseSchema,
  syncCatalogToLocal,
  createRemoteProduct,
  updateRemoteProduct,
  deleteRemoteProduct,
  addRemoteInventory,
  fulfillRemote,
  lookupRemoteDelivery,
  fallbackPayments,
  syncPublicPaymentProfile,
  getCounterpartyPaymentProfile,
  startDebtBinancePayment,
  submitDebtBinanceOrder,
  ownedDebtBinanceVerifications,
  finishDebtBinanceVerification,
  debtPaymentResults,
  acknowledgeDebtPaymentResult,
  upsertSharedPaymentMethod,
  syncSharedPaymentMethodsSnapshot,
  listSharedPaymentMethods,
  createSharedPaymentRequest,
  ownedSharedPaymentRequests,
  sourceSharedPaymentResults,
  resolveSharedPaymentRequest,
  acknowledgeSharedPaymentRequest,
  createFallbackBinanceIntent,
  verifyFallbackBinanceIntent,
  recordFallbackSettlement,
  getMySettlementSummary,
  getMyAccounts,
  getMyCommerceStatus,
  getNotificationEvents,
  publishNotificationEvent,
  localNotificationEventsAfter,
  latestLocalNotificationEventId,
  markDebtPaid,
  resolveIncomingDebtPayment,
  getProductContributors,
  productStockProtection,
  settlementSummary,
  installMasterRoutes
};
