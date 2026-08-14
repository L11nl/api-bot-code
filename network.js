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
  getIqdRate,
  getSuperQiNumber,
  getSetting
} = require('./db');
const { encryptPayload } = require('./cryptoStore');
const { inventoryFingerprint, escapeHtml } = require('./utils');
const { getProductStock, fulfillOrder } = require('./services/orders');
const binancePay = require('./payments/binancePay');

function role() { return config.network.role; }
function isClient() { return role() === 'client'; }
function isMaster() { return role() === 'master'; }
function enabledClient() { return isClient() && config.network.apiUrl && config.network.apiKey; }
function hashKey(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
function newApiKey() { return `net_${crypto.randomBytes(24).toString('hex')}`; }
function newProductId() { return crypto.randomUUID(); }
function newPaymentIntentId() { return `NPI-${crypto.randomBytes(12).toString('hex').toUpperCase()}`; }

function clientHeaders() {
  return {
    'x-store-api-key': config.network.apiKey,
    'x-store-shop-id': config.network.shopId
  };
}

async function clientRequest(method, path, data) {
  if (!enabledClient()) throw new Error('NETWORK_API_NOT_CONFIGURED');
  const response = await axios({
    method,
    url: `${config.network.apiUrl}${path}`,
    data,
    headers: clientHeaders(),
    timeout: 20000,
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
  const row = await NetworkClient.findOne({ where: { apiKeyHash: hashKey(key), isActive: true } });
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
  return { row, apiKey };
}

async function catalogSnapshot() {
  const products = await Merchant.findAll({ where: { isActive: true }, order: [['sortOrder', 'ASC'], ['id', 'ASC']] });
  const output = [];
  for (const product of products) {
    output.push({
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
      stock: await getProductStock(product.id),
      networkOwnerShopId: product.networkOwnerShopId || 'master'
    });
  }
  return output;
}

async function syncCatalogToLocal() {
  if (!enabledClient()) return null;
  const data = await clientRequest('get', '/api/v1/catalog');
  const seen = new Set();
  for (const remote of data.products || []) {
    seen.add(remote.networkProductId);
    let product = await Merchant.findOne({ where: { networkProductId: remote.networkProductId } });
    const values = {
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
    };
    if (!product) product = await Merchant.create(values);
    else await product.update(values);
    product._networkStock = Number(remote.stock || 0);
  }
  const stale = await Merchant.findAll({ where: { networkManaged: true } });
  for (const product of stale) {
    if (!seen.has(product.networkProductId)) await product.update({ isActive: false });
  }
  return data.products || [];
}

async function createRemoteProduct(payload) {
  return clientRequest('post', '/api/v1/products', payload);
}

async function updateRemoteProduct(networkProductId, payload) {
  return clientRequest('patch', `/api/v1/products/${encodeURIComponent(networkProductId)}`, payload);
}

async function deleteRemoteProduct(networkProductId) {
  return clientRequest('delete', `/api/v1/products/${encodeURIComponent(networkProductId)}`);
}

async function addRemoteInventory(networkProductId, items) {
  return clientRequest('post', `/api/v1/products/${encodeURIComponent(networkProductId)}/inventory`, { items });
}

async function fulfillRemote({ networkProductId, quantity, localOrderId, customerId }) {
  return clientRequest('post', '/api/v1/fulfill', {
    networkProductId,
    quantity,
    localOrderId,
    customerId
  });
}

async function lookupRemoteDelivery(deliveryId) {
  return clientRequest('get', `/api/v1/deliveries/${encodeURIComponent(deliveryId)}`);
}

async function fallbackPayments() {
  if (!enabledClient()) return { methods: [] };
  return clientRequest('get', '/api/v1/payment-options');
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

  let currency = String(client.settlementCurrency || 'USD').toUpperCase();
  let methodRate = currency === 'IQD' ? iqdRate : currency === 'EGP' ? egpRate : 1;
  if (sourceMethod === 'binance') {
    currency = 'USD';
    methodRate = 1;
  } else if (sourceMethod === 'superqi') {
    currency = 'IQD';
    methodRate = iqdRate;
  } else if (sourceMethod.startsWith('custom:')) {
    const methodId = Number(sourceMethod.split(':')[1]);
    const method = await PaymentMethod.findByPk(methodId);
    if (method) {
      currency = String(method.settlementCurrency || 'USD').toUpperCase();
      methodRate = Number(method.ratePerUsd || (currency === 'IQD' ? iqdRate : currency === 'EGP' ? egpRate : 1));
    }
  }

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
  const text = [
    headline,
    `الزبون: <b>${escapeHtml(customer)}</b>`,
    `المبلغ: <b>$${Number(row.amountUsd).toFixed(2)}</b>`,
    `بالدينار العراقي: <b>${Math.round(Number(row.iqdAmount || 0)).toLocaleString('en-US')} IQD</b>`,
    `بالجنيه المصري: <b>${Number(row.egpAmount || 0).toFixed(2)} EGP</b>`,
    `حسب طريقة الدفع (${row.settlementCurrency}): <b>${Number(row.settlementAmount || 0).toFixed(row.settlementCurrency === 'IQD' ? 0 : 2)} ${row.settlementCurrency}</b>`,
    '',
    `<b>${escapeHtml(client.name)}</b> يطلبك الآن إجمالاً: <b>$${summary.amountUsd.toFixed(2)}</b>`
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

  app.get('/api/v1/catalog', (req, res) => route(req, res, async () => ({ products: await catalogSnapshot() })));

  app.post('/api/v1/products', (req, res) => route(req, res, async client => {
    const body = req.body || {};
    const nameAr = String(body.nameAr || '').trim();
    const price = Number(body.price);
    const type = String(body.type || 'free');
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
    return { product: { ...(product.toJSON()), stock: await getProductStock(product.id) } };
  }));

  app.patch('/api/v1/products/:networkProductId', (req, res) => route(req, res, async client => {
    const product = await Merchant.findOne({ where: { networkProductId: req.params.networkProductId } });
    if (!product) throw new Error('PRODUCT_NOT_FOUND');
    if (String(product.networkOwnerShopId || 'master') !== String(client.shopId)) throw new Error('PRODUCT_NOT_OWNED');
    const body = req.body || {};
    const allowed = ['nameAr','nameEn','price','category','type','description','image','isActive','sharedLimit','deliveryMode','sortOrder'];
    const changes = {};
    for (const key of allowed) if (body[key] !== undefined) changes[key] = body[key];
    await product.update(changes);
    return { product: { ...(product.toJSON()), stock: await getProductStock(product.id) } };
  }));

  app.delete('/api/v1/products/:networkProductId', (req, res) => route(req, res, async client => {
    const product = await Merchant.findOne({ where: { networkProductId: req.params.networkProductId } });
    if (!product) throw new Error('PRODUCT_NOT_FOUND');
    if (String(product.networkOwnerShopId || 'master') !== String(client.shopId)) throw new Error('PRODUCT_NOT_OWNED');
    await product.update({ isActive: false });
    return { deleted: true };
  }));

  app.post('/api/v1/products/:networkProductId/inventory', (req, res) => route(req, res, async client => {
    const product = await Merchant.findOne({ where: { networkProductId: req.params.networkProductId } });
    if (!product) throw new Error('PRODUCT_NOT_FOUND');
    if (String(product.networkOwnerShopId || 'master') !== String(client.shopId)) throw new Error('PRODUCT_NOT_OWNED');
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    let added = 0;
    for (const payload of items.slice(0, 1000)) {
      const fingerprint = inventoryFingerprint(product.type, payload);
      const duplicate = await Code.findOne({
        where: { merchantId: product.id, fingerprint, isUsed: false }
      });
      if (duplicate) continue;
      await Code.create({
        value: encryptPayload(payload),
        extra: null,
        merchantId: product.id,
        isUsed: false,
        usedCount: 0,
        maxUses: product.type === 'shared' ? Math.max(1, Number(product.sharedLimit || 1)) : 1,
        buyers: [],
        fingerprint
      });
      added += 1;
    }
    return { added, stock: await getProductStock(product.id), sourceShopId: client.shopId };
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
    return {
      remoteOrderId: order.id,
      product: { networkProductId: product.networkProductId, nameAr: product.nameAr, nameEn: product.nameEn, type: product.type },
      deliveries: result.deliveries || []
    };
  }));

  app.get('/api/v1/deliveries/:deliveryId', (req, res) => route(req, res, async client => {
    const { DeliveryRecord } = require('./db');
    const row = await DeliveryRecord.findByPk(req.params.deliveryId);
    if (!row || String(row.sourceShopId || '') !== String(client.shopId)) throw new Error('DELIVERY_NOT_FOUND');
    const product = await Merchant.findByPk(row.merchantId);
    return { delivery: row.toJSON(), product: product ? { nameAr: product.nameAr, nameEn: product.nameEn, type: product.type } : null };
  }));

  app.get('/api/v1/payment-options', (req, res) => route(req, res, async () => {
    const methods = [];
    if (await binancePay.configured()) {
      const runtime = await binancePay.getRuntimeConfig();
      methods.push({ type: 'binance', nameAr: 'Binance ID', nameEn: 'Binance ID', paymentNumber: runtime.payId, iconCustomEmojiId: '5875443023873053217', settlementCurrency: 'USD', ratePerUsd: 1 });
    }
    const superQi = await getSuperQiNumber();
    if (superQi) methods.push({ type: 'superqi', nameAr: 'سوبركي', nameEn: 'SuperQi', paymentNumber: superQi, iconCustomEmojiId: '5184203496831846429', settlementCurrency: 'IQD', ratePerUsd: await getIqdRate() });
    const custom = await PaymentMethod.findAll({ where: { isActive: true }, order: [['sortOrder', 'ASC'], ['id', 'ASC']] });
    for (const method of custom) methods.push({
      type: `custom:${method.id}`,
      nameAr: method.nameAr,
      nameEn: method.nameEn,
      paymentNumber: method.paymentNumber,
      iconCustomEmojiId: method.iconCustomEmojiId,
      iconAlt: method.iconAlt,
      settlementCurrency: method.settlementCurrency,
      ratePerUsd: method.ratePerUsd
    });
    return { methods };
  }));

  app.post('/api/v1/payments/binance/intents', (req, res) => route(req, res, async client => {
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
      const existing = await NetworkSettlement.findOne({
        where: { debtorShopId: client.shopId, creditorShopId: 'master', sourceMethod: 'binance', sourceRef: intent.transactionId }
      });
      if (!existing && intent.transactionId) {
        const settlement = await createSettlementForClient(client, {
          amountUsd: Number(intent.amountUsd),
          method: 'binance',
          sourceRef: intent.transactionId,
          customerName: intent.customerName || intent.customerId || 'زبون',
          activity: intent.activity || 'payment'
        });
        await notifySettlement(getBot?.(), client, settlement, await settlementSummary(client.shopId), intent.activity || 'payment');
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
    const before = await NetworkSettlement.findOne({
      where: { debtorShopId: client.shopId, creditorShopId: 'master', sourceMethod: 'binance', sourceRef: result.transactionId }
    });
    const settlement = await createSettlementForClient(client, {
      amountUsd: Number(intent.amountUsd),
      method: 'binance',
      sourceRef: result.transactionId,
      customerName: intent.customerName || intent.customerId || 'زبون',
      activity: intent.activity || 'payment'
    });
    if (!before) await notifySettlement(getBot?.(), client, settlement, await settlementSummary(client.shopId), intent.activity || 'payment');
    return { verified: true, transactionId: result.transactionId };
  }));

  app.post('/api/v1/settlements', (req, res) => route(req, res, async client => {
    const sourceMethod = String(req.body?.method || 'shared_payment');
    const sourceRef = req.body?.sourceRef ? String(req.body.sourceRef) : null;
    const existing = sourceRef ? await NetworkSettlement.findOne({
      where: { debtorShopId: client.shopId, creditorShopId: 'master', sourceMethod, sourceRef }
    }) : null;
    const row = existing || await createSettlementForClient(client, req.body || {});
    const summary = await settlementSummary(client.shopId);
    if (!existing) await notifySettlement(getBot?.(), client, row, summary, String(req.body?.activity || 'payment'));
    return { settlementId: row.id, summary, duplicate: Boolean(existing) };
  }));


  app.get('/api/v1/settlements/me', (req, res) => route(req, res, async client => ({
    shop: { shopId: client.shopId, name: client.name, settlementCurrency: client.settlementCurrency },
    ownerName: config.network.ownerName,
    summary: await settlementSummary(client.shopId)
  })));
}

module.exports = {
  role,
  isClient,
  isMaster,
  enabledClient,
  createClient,
  syncCatalogToLocal,
  createRemoteProduct,
  updateRemoteProduct,
  deleteRemoteProduct,
  addRemoteInventory,
  fulfillRemote,
  lookupRemoteDelivery,
  fallbackPayments,
  createFallbackBinanceIntent,
  verifyFallbackBinanceIntent,
  recordFallbackSettlement,
  getMySettlementSummary,
  settlementSummary,
  installMasterRoutes
};
