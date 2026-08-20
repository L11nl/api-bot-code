const { QueryTypes } = require('sequelize');
const crypto = require('crypto');
const { sequelize, User, Merchant, Code, PurchaseOrder, DeliveryRecord, BalanceTransaction } = require('../db');
const { parseDescription } = require('../utils');
const { decryptPayload } = require('../cryptoStore');
const config = require('../config');
const networkLedger = require('./networkLedger');

function quotedSchema() {
  return `"${String(config.databaseSchema).replace(/"/g, '""')}"`;
}

function sellerShopIdFromOptions(options = {}) {
  return String(options.sourceShopId || 'master');
}

function currentShopId() {
  try {
    const network = require('../network');
    if (network.enabledClient()) return String(config.network.shopId || '');
    if (network.isMaster()) return 'master';
  } catch {}
  return String(config.network.shopId || 'master');
}

function productAccessibleInCurrentShop(product) {
  if (!product) return false;
  const scope = String(product.visibilityScope || (product.type === 'service' ? 'private' : 'public')).toLowerCase();
  if (scope !== 'private') return true;
  const owner = String(product.networkOwnerShopId || '').trim();
  if (!owner) return !product.networkManaged;
  return owner === currentShopId();
}

function productVisibleInCurrentShop(product) {
  if (!productAccessibleInCurrentShop(product)) return false;
  if (product.isActive === false) return false;
  const status = String(product.localPublicationStatus || 'published').toLowerCase();
  return status === 'published';
}

function effectiveProductPrice(product) {
  const base = Math.max(0, Number(product?.price || 0));
  const override = product?.localPriceOverrideUsd == null ? NaN : Number(product.localPriceOverrideUsd);
  return Number.isFinite(override) && override >= 0 ? override : base;
}

async function getProductStock(merchantId) {
  const product = await Merchant.findByPk(merchantId);
  if (product?.type === 'service') return productVisibleInCurrentShop(product) ? 999999 : 0;
  if (product?.networkManaged) return Number(product.networkStock || 0);
  const [rows] = await sequelize.query(`
    SELECT COALESCE(SUM(GREATEST(COALESCE("maxUses",1)-COALESCE("usedCount",0),0)),0)::int AS stock
    FROM ${quotedSchema()}."Codes"
    WHERE "merchantId" = :merchantId
      AND COALESCE("isUsed", FALSE) = FALSE
      AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
  `, { replacements: { merchantId } });
  return Number(rows[0]?.stock || 0);
}

async function getProductStocksMap(products = []) {
  const list = Array.isArray(products) ? products.filter(Boolean) : [];
  const result = new Map();
  const localIds = [];

  for (const product of list) {
    const id = Number(product?.id || product);
    if (!Number.isInteger(id) || id <= 0) continue;
    if (product?.type === 'service') {
      result.set(id, productVisibleInCurrentShop(product) ? 999999 : 0);
    } else if (product?.networkManaged) {
      result.set(id, Number(product.networkStock || 0));
    } else {
      result.set(id, 0);
      localIds.push(id);
    }
  }

  if (!localIds.length) return result;
  const rows = await sequelize.query(`
    SELECT "merchantId" AS id,
           COALESCE(SUM(GREATEST(COALESCE("maxUses",1)-COALESCE("usedCount",0),0)),0)::int AS stock
    FROM ${quotedSchema()}."Codes"
    WHERE "merchantId" IN (:merchantIds)
      AND COALESCE("isUsed", FALSE) = FALSE
      AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
    GROUP BY "merchantId"
  `, {
    replacements: { merchantIds: localIds },
    type: QueryTypes.SELECT
  });
  for (const row of rows || []) result.set(Number(row.id), Number(row.stock || 0));
  return result;
}

function normalizeProductFamilyName(name) {
  const normalized = String(name || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

  if (!normalized) return '';

  const stopWords = new Set([
    'برو', 'premium', 'pro',
    'شهري', 'شهريا', 'شهر', 'شهور', 'اشهر', 'سنوي', 'سنويا', 'سنه', 'سنوات',
    'يوم', 'ايام', 'اسبوع', 'اسابيع',
    'ضمان', 'حساب', 'مفعل', 'مفعله', 'مشترك', 'مشتركه', 'خدمه', 'اشتراك', 'اشتراكات',
    'month', 'months', 'monthly', 'year', 'years', 'annual', 'annually', 'day', 'days',
    'week', 'weeks', 'account', 'activated', 'shared', 'service', 'subscription', 'subscriptions',
    'warranty', 'guarantee', 'usd', 'usdt', 'iqd', 'egp'
  ]);

  const rawTokens = normalized.split(/\s+/u).filter(Boolean);
  const familyTokens = rawTokens.filter(token => {
    if (stopWords.has(token)) return false;
    if (/^\d+(?:[.,]\d+)?$/u.test(token)) return false;
    if (/^\d+(?:m|mo|mon|month|months|y|yr|year|years|d|day|days)$/u.test(token)) return false;
    if (/^\d+%$/u.test(token)) return false;
    return true;
  });

  // Keep the meaningful part of the title. Two or three words are enough to
  // keep multi-word brands such as "Cap Cut" together while stripping plan
  // details such as duration, warranty and account type.
  const selected = familyTokens.length ? familyTokens.slice(0, 3) : rawTokens.slice(0, 3);
  return selected.join(' ');
}

function productRowSortKey(row) {
  const product = row?.product || row || {};
  const stock = Number(row?.stock ?? product.stock ?? 0);
  const available = String(product.type || '') === 'service' || stock > 0;
  const name = String(product.nameAr || product.nameEn || '');
  return {
    available,
    family: normalizeProductFamilyName(name),
    sortOrder: Number(product.sortOrder || 0),
    id: Number(product.id || 0),
    name
  };
}

function sortProductStockRows(rows = []) {
  return [...rows].sort((a, b) => {
    const ka = productRowSortKey(a);
    const kb = productRowSortKey(b);

    // Products with real stock always stay above empty products.
    if (ka.available !== kb.available) return ka.available ? -1 : 1;

    // Similar product names stay next to each other (Gemini monthly, Gemini
    // 3 months, Gemini 18 months, etc.).
    const familyCompare = ka.family.localeCompare(kb.family, 'ar', { numeric: true, sensitivity: 'base' });
    if (familyCompare !== 0) return familyCompare;

    // Preserve the admin's original creation/order sequence inside a family.
    if (ka.sortOrder !== kb.sortOrder) return ka.sortOrder - kb.sortOrder;
    if (ka.id !== kb.id) return ka.id - kb.id;
    return ka.name.localeCompare(kb.name, 'ar', { numeric: true, sensitivity: 'base' });
  });
}

async function listActiveProducts() {
  try {
    const network = require('../network');
    if (network.enabledClient()) await network.syncCatalogToLocal();
  } catch (error) {
    console.error('Catalog sync failed:', error.message);
  }
  const products = await Merchant.findAll({ where: { isActive: true }, order: [['sortOrder','ASC'], ['id','ASC']] });
  const visible = products.filter(productVisibleInCurrentShop);
  const stocks = await getProductStocksMap(visible);
  const rows = visible.map(product => ({ product, stock: Number(stocks.get(Number(product.id)) || 0) }));
  return sortProductStockRows(rows);
}

async function createOrder({ userId, merchantId, quantity, paymentMethod }) {
  const product = await Merchant.findByPk(merchantId);
  if (!product || !product.isActive || !productVisibleInCurrentShop(product)) throw new Error('PRODUCT_NOT_FOUND');
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1 || qty > 100) throw new Error('INVALID_QUANTITY');
  const stock = product.type === 'service' ? 999999 : await getProductStock(product.id);
  if (product.type !== 'service' && stock < qty) throw new Error('OUT_OF_STOCK');
  const unitPrice = effectiveProductPrice(product);
  return PurchaseOrder.create({
    userId,
    merchantId,
    quantity: qty,
    unitPrice,
    totalAmount: unitPrice * qty,
    currency: 'USDT',
    paymentMethod,
    status: 'pending_payment',
    walletApplied: 0,
    externalAmount: unitPrice * qty
  });
}

async function createGiftOrder({ userId, merchantId }) {
  const product = await Merchant.findByPk(merchantId);
  if (!product || !productVisibleInCurrentShop(product)) throw new Error('PRODUCT_NOT_FOUND');
  if (String(product.type || '') === 'service') throw new Error('PRODUCT_NOT_GIFT_ELIGIBLE');
  const stock = await getProductStock(product.id);
  if (stock < 1) throw new Error('OUT_OF_STOCK');
  return PurchaseOrder.create({
    userId,
    merchantId,
    quantity: 1,
    unitPrice: 0,
    totalAmount: 0,
    currency: 'USDT',
    paymentMethod: 'referral_gift',
    status: 'paid',
    paidAt: new Date()
  });
}

async function fulfillOrder(orderId, options = {}) {
  const transaction = await sequelize.transaction();
  try {
    const order = await PurchaseOrder.findByPk(orderId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!order) throw new Error('ORDER_NOT_FOUND');
    if (order.status === 'completed' || order.status === 'waiting_code') {
      await transaction.commit();
      return { order, deliveries: order.delivery || [], alreadyProcessed: true };
    }
    if (!['pending_payment','paid','proof_pending'].includes(order.status)) throw new Error('ORDER_ALREADY_PROCESSED');

    const product = await Merchant.findByPk(order.merchantId, { transaction, lock: transaction.LOCK.UPDATE });

    if (product?.type === 'service') {
      const description = parseDescription(product.description);
      const inputMode = String(description.serviceInputMode || 'text');
      const servicePayload = {
        serviceRequest: true,
        inputMode,
        inputLabelAr: inputMode === 'email' ? 'الإيميل' : inputMode === 'phone' ? 'الرقم' : 'النص',
        inputLabelEn: inputMode === 'email' ? 'Email' : inputMode === 'phone' ? 'Phone number' : 'Text',
        promptAr: String(description.servicePromptAr || 'أرسل البيانات المطلوبة حتى نباشر تنفيذ الخدمة.'),
        promptEn: String(description.servicePromptEn || 'Send the required details so we can start the service.'),
        submitted: false,
        needsAdminAction: true
      };
      order.status = 'service_pending_input';
      order.delivery = [servicePayload];
      order.paidAt = order.paidAt || new Date();
      if (options.paymentRef) order.paymentRef = options.paymentRef;
      await order.save({ transaction });
      description.sold = Number(description.sold || 0) + Number(order.quantity || 0);
      product.description = description;
      await product.save({ transaction });
      await transaction.commit();
      return { order, deliveries: [servicePayload], product, servicePendingInput: true };
    }

    if (product?.networkManaged) {
      await transaction.commit();
      const network = require('../network');
      const remote = await network.fulfillRemote({
        networkProductId: product.networkProductId,
        quantity: order.quantity,
        localOrderId: order.id,
        customerId: order.userId,
        retailUnitPriceUsd: Number(order.unitPrice || product.price || 0),
        resellerPriceOverride: Number(product.localPriceOverrideUsd || 0) > Number(product.networkBasePriceUsd || 0) + 1e-9
      });
      const fresh = await PurchaseOrder.findByPk(order.id);
      fresh.status = 'completed';
      fresh.delivery = remote.deliveries || [];
      fresh.paidAt = fresh.paidAt || new Date();
      fresh.completedAt = new Date();
      fresh.remoteOrderRef = String(remote.remoteOrderId || '');
      if (options.paymentRef) fresh.paymentRef = options.paymentRef;
      await fresh.save();
      for (const delivery of remote.deliveries || []) {
        if (!delivery.deliveryId) continue;
        await DeliveryRecord.findOrCreate({
          where: { id: delivery.deliveryId },
          defaults: {
            orderId: fresh.id,
            userId: fresh.userId,
            merchantId: fresh.merchantId,
            codeId: delivery.codeId || null,
            payload: delivery.payload || {},
            sourceShopId: config.network.shopId,
            inventoryOwnerShopId: delivery.inventoryOwnerShopId || null,
            unitPriceUsd: Number(fresh.unitPrice || 0),
            supplierValueUsd: Number(delivery.supplierValueUsd ?? delivery.contributionPriceUsd ?? fresh.unitPrice ?? 0)
          }
        });
      }
      return { order: fresh, deliveries: remote.deliveries || [], product, remote: true };
    }

    const deliveries = [];
    for (let i = 0; i < order.quantity; i++) {
      const sellerShopId = sellerShopIdFromOptions(options);
      const inventoryRows = await sequelize.query(`
        WITH owner_stats AS (
          SELECT COALESCE(NULLIF("stockOwnerShopId", ''), 'master') AS owner,
                 SUM(COALESCE("maxUses",1))::numeric AS total_units,
                 SUM(COALESCE("usedCount",0))::numeric AS sold_units
          FROM ${quotedSchema()}."Codes"
          WHERE "merchantId" = :merchantId
          GROUP BY COALESCE(NULLIF("stockOwnerShopId", ''), 'master')
        )
        SELECT c.*
        FROM ${quotedSchema()}."Codes" c
        LEFT JOIN owner_stats os
          ON os.owner = COALESCE(NULLIF(c."stockOwnerShopId", ''), 'master')
        WHERE c."merchantId" = :merchantId
          AND COALESCE(c."isUsed", FALSE) = FALSE
          AND COALESCE(c."usedCount",0) < COALESCE(c."maxUses",1)
          AND (c."expiresAt" IS NULL OR c."expiresAt" > NOW())
        ORDER BY
          CASE WHEN COALESCE(NULLIF(c."stockOwnerShopId", ''), 'master') = :sellerShopId THEN 0 ELSE 1 END ASC,
          CASE WHEN COALESCE(NULLIF(c."stockOwnerShopId", ''), 'master') = :sellerShopId THEN 0
               ELSE COALESCE(os.sold_units / NULLIF(os.total_units, 0), 0) END ASC,
          c."createdAt" ASC,
          c."id" ASC
        FOR UPDATE OF c SKIP LOCKED
        LIMIT 1
      `, {
        replacements: { merchantId: product.id, sellerShopId },
        type: QueryTypes.SELECT,
        transaction
      });
      const inventoryRow = inventoryRows[0];
      if (!inventoryRow) throw new Error('OUT_OF_STOCK');
      const inventory = inventoryRow;

      const nextCount = Number(inventory.usedCount || 0) + 1;
      const maxUses = Number(inventory.maxUses || 1);
      const exhausted = nextCount >= maxUses;
      const buyers = Array.isArray(inventory.buyers) ? inventory.buyers : [];
      buyers.push({ userId: String(order.userId), orderId: order.id, usedAt: new Date().toISOString(), position: nextCount });

      await Code.update({
        usedCount: nextCount,
        maxUses,
        buyers,
        isUsed: exhausted,
        usedBy: exhausted ? order.userId : inventory.usedBy,
        soldAt: exhausted ? new Date() : inventory.soldAt
      }, { where: { id: inventory.id }, transaction });

      const payload = decryptPayload(inventory.value, inventory.extra);
      const waitingCode = product.deliveryMode === 'wait_code';
      const deliveryId = `DLV-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
      deliveries.push({
        deliveryId,
        codeId: inventory.id,
        inventoryOwnerShopId: String(inventory.stockOwnerShopId || 'master'),
        contributionPriceUsd: Number(inventory.contributionPriceUsd ?? order.unitPrice ?? product.price ?? 0),
        payload,
        sharedPosition: maxUses > 1 ? { current: nextCount, max: maxUses } : null,
        waitingCode
      });
    }

    for (const delivery of deliveries) {
      const sellerShopId = sellerShopIdFromOptions(options);
      const inventoryOwnerShopId = String(delivery.inventoryOwnerShopId || 'master');
      const retailUnitPriceUsd = Number(order.unitPrice || product.price || 0);
      const externalStock = inventoryOwnerShopId !== sellerShopId;
      const basePriceUsd = Number(product.networkBasePriceUsd ?? product.price ?? 0);
      const hasLocalPriceOverride = Number(product.localPriceOverrideUsd || 0) > basePriceUsd + 1e-9;
      const resellerPriceOverride = externalStock && (Boolean(options.resellerPriceOverride) || hasLocalPriceOverride);
      let split;
      if (resellerPriceOverride) {
        // Reseller markup model: the stock owner keeps the exact value recorded
        // when that inventory was contributed, and the selling bot keeps only
        // the amount above it. The legacy 10% commission does not apply.
        const supplierFloorUsd = Math.max(0, Number(delivery.contributionPriceUsd || 0));
        const supplierUsd = Math.min(retailUnitPriceUsd, supplierFloorUsd);
        const markupUsd = Math.max(0, retailUnitPriceUsd - supplierUsd);
        split = {
          retailUsd: retailUnitPriceUsd,
          supplierUsd,
          commissionUsd: 0,
          commissionPercent: 0,
          markupUsd,
          priceOverride: true
        };
      } else {
        split = externalStock
          ? networkLedger.sellerCommissionSplit(retailUnitPriceUsd)
          : { retailUsd: retailUnitPriceUsd, supplierUsd: retailUnitPriceUsd, commissionUsd: 0, commissionPercent: 0, markupUsd: 0, priceOverride: false };
      }

      delivery.supplierValueUsd = Number(split.supplierUsd || 0);
      delivery.sellerCommissionUsd = Number(split.commissionUsd || 0);
      delivery.sellerCommissionPercent = Number(split.commissionPercent || 0);
      delivery.sellerMarkupUsd = Number(split.markupUsd || 0);
      delivery.resellerPriceOverride = Boolean(split.priceOverride);

      await DeliveryRecord.create({
        id: delivery.deliveryId,
        orderId: order.id,
        userId: order.userId,
        merchantId: product.id,
        codeId: delivery.codeId || null,
        payload: delivery.payload || {},
        sourceShopId: sellerShopId,
        inventoryOwnerShopId,
        unitPriceUsd: retailUnitPriceUsd,
        supplierValueUsd: Number(split.supplierUsd || 0)
      }, { transaction });

      // Cross-shop sale rule: a deliberate local markup pays the stock owner
      // their recorded contribution value and leaves the exact difference with
      // the selling bot. Without a local markup, the legacy configurable 10%
      // commission split remains in force.
      if (Number(split.supplierUsd || 0) > 0) {
        await networkLedger.recordObligation({
          debtorShopId: sellerShopId,
          creditorShopId: inventoryOwnerShopId,
          amountUsd: Number(split.supplierUsd),
          kind: 'inventory_sale',
          sourceRef: delivery.deliveryId,
          networkProductId: product.networkProductId,
          deliveryId: delivery.deliveryId,
          sellerShopId,
          stockOwnerShopId: inventoryOwnerShopId,
          metadata: {
            orderId: order.id,
            customerId: String(order.userId),
            retailUnitPriceUsd,
            supplierValueUsd: Number(split.supplierUsd),
            sellerCommissionUsd: Number(split.commissionUsd || 0),
            sellerCommissionPercent: Number(split.commissionPercent || 0),
            sellerMarkupUsd: Number(split.markupUsd || 0),
            resellerPriceOverride: Boolean(split.priceOverride)
          },
          transaction
        });
      }
      if (externalStock && Number(split.commissionUsd || 0) > 0) {
        await networkLedger.recordObligation({
          debtorShopId: sellerShopId,
          creditorShopId: sellerShopId,
          amountUsd: Number(split.commissionUsd),
          kind: 'sales_commission',
          sourceRef: delivery.deliveryId,
          networkProductId: product.networkProductId,
          deliveryId: delivery.deliveryId,
          sellerShopId,
          stockOwnerShopId: inventoryOwnerShopId,
          metadata: {
            orderId: order.id,
            retailUnitPriceUsd,
            commissionPercent: Number(split.commissionPercent || 0)
          },
          transaction
        });
      }
      if (externalStock && Boolean(split.priceOverride) && Number(split.markupUsd || 0) > 0) {
        await networkLedger.recordObligation({
          debtorShopId: sellerShopId,
          creditorShopId: sellerShopId,
          amountUsd: Number(split.markupUsd),
          kind: 'sales_markup',
          sourceRef: delivery.deliveryId,
          networkProductId: product.networkProductId,
          deliveryId: delivery.deliveryId,
          sellerShopId,
          stockOwnerShopId: inventoryOwnerShopId,
          metadata: {
            orderId: order.id,
            retailUnitPriceUsd,
            supplierValueUsd: Number(split.supplierUsd || 0),
            markupUsd: Number(split.markupUsd || 0)
          },
          transaction
        });
      }
    }

    const waitingCode = deliveries.some(d => d.waitingCode);
    order.status = waitingCode ? 'waiting_code' : 'completed';
    order.delivery = deliveries;
    order.paidAt = order.paidAt || new Date();
    if (!waitingCode) order.completedAt = new Date();
    if (options.paymentRef) order.paymentRef = options.paymentRef;
    await order.save({ transaction });

    const description = parseDescription(product.description);
    description.sold = Number(description.sold || 0) + Number(order.quantity || 0);
    product.description = description;
    await product.save({ transaction });

    await transaction.commit();
    return { order, deliveries, product };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}


async function reserveWalletForOrder(orderId) {
  const transaction = await sequelize.transaction();
  try {
    const order = await PurchaseOrder.findByPk(orderId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!order) throw new Error('ORDER_NOT_FOUND');
    if (order.status !== 'pending_payment') throw new Error('ORDER_ALREADY_PROCESSED');
    if (Number(order.walletApplied || 0) > 0) {
      await transaction.commit();
      return { order, walletApplied: Number(order.walletApplied), externalAmount: Number(order.externalAmount) };
    }
    const user = await User.findByPk(order.userId, { transaction, lock: transaction.LOCK.UPDATE });
    const total = Number(order.totalAmount || 0);
    const balance = Number(user.balance || 0);
    const walletApplied = Math.min(Math.max(balance, 0), total);
    const externalAmount = Math.max(0, total - walletApplied);
    if (walletApplied > 0) {
      user.balance = balance - walletApplied;
      await user.save({ transaction });
      await BalanceTransaction.create({
        userId: user.id,
        amount: -walletApplied,
        type: 'wallet_reservation',
        txid: `ORDER-RESERVE:${order.id}`,
        caption: `Wallet reserved for order #${order.id} / merchant ${order.merchantId}`,
        status: 'completed',
        paymentOrigin: 'wallet',
        networkMethod: 'order_checkout',
        approvalSource: 'system_checkout'
      }, { transaction });
    }
    order.walletApplied = walletApplied;
    order.externalAmount = externalAmount;
    order.paymentOrigin = walletApplied > 0 && externalAmount > 0 ? 'wallet_plus_external' : externalAmount > 0 ? 'external' : 'wallet';
    await order.save({ transaction });
    await transaction.commit();
    return { order, walletApplied, externalAmount };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function refundWalletReservation(orderId) {
  const transaction = await sequelize.transaction();
  try {
    const order = await PurchaseOrder.findByPk(orderId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!order) throw new Error('ORDER_NOT_FOUND');
    const amount = Number(order.walletApplied || 0);
    if (amount <= 0 || ['completed', 'waiting_code', 'paid'].includes(order.status)) {
      await transaction.commit();
      return { refunded: 0 };
    }
    const user = await User.findByPk(order.userId, { transaction, lock: transaction.LOCK.UPDATE });
    user.balance = Number(user.balance || 0) + amount;
    await user.save({ transaction });
    await BalanceTransaction.create({
      userId: user.id,
      amount,
      type: 'wallet_reservation_refund',
      txid: `ORDER-RESERVE-REFUND:${order.id}`,
      caption: `Wallet reservation refunded for order #${order.id} / merchant ${order.merchantId}`,
      status: 'completed',
      paymentOrigin: 'wallet',
      networkMethod: 'order_checkout',
      approvalSource: 'system_refund'
    }, { transaction });
    order.walletApplied = 0;
    order.externalAmount = Number(order.totalAmount || 0);
    order.status = 'cancelled';
    order.paymentRef = 'wallet_reservation_refunded';
    await order.save({ transaction });
    await transaction.commit();
    return { refunded: amount };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function completeExternalPayment(orderId, paymentRef = 'external') {
  const order = await PurchaseOrder.findByPk(orderId);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.status === 'completed' || order.status === 'waiting_code') {
    return { order, deliveries: order.delivery || [], alreadyProcessed: true };
  }
  if (!['pending_payment', 'proof_pending', 'paid'].includes(order.status)) throw new Error('ORDER_ALREADY_PROCESSED');
  order.status = 'paid';
  order.paidAt = order.paidAt || new Date();
  order.paymentRef = paymentRef;
  await order.save();
  return fulfillOrder(order.id, { paymentRef });
}

async function payFromWallet(orderId) {
  const transaction = await sequelize.transaction();
  try {
    const order = await PurchaseOrder.findByPk(orderId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!order) throw new Error('ORDER_NOT_FOUND');
    if (order.status !== 'pending_payment') throw new Error('ORDER_ALREADY_PROCESSED');
    const user = await User.findByPk(order.userId, { transaction, lock: transaction.LOCK.UPDATE });
    const balance = Number(user.balance || 0);
    const total = Number(order.totalAmount);
    if (balance + 1e-9 < total) throw new Error('INSUFFICIENT_BALANCE');
    user.balance = balance - total;
    await user.save({ transaction });
    await BalanceTransaction.create({
      userId: user.id,
      amount: -total,
      type: 'wallet_purchase',
      txid: `ORDER-WALLET:${order.id}`,
      caption: `Wallet purchase for order #${order.id} / merchant ${order.merchantId}`,
      status: 'completed',
      paymentOrigin: 'wallet',
      networkMethod: 'order_purchase',
      approvalSource: 'system_checkout'
    }, { transaction });
    order.status = 'paid';
    order.paidAt = new Date();
    await order.save({ transaction });
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
  try {
    return await fulfillOrder(orderId, { paymentRef: 'wallet' });
  } catch (error) {
    // Compensating refund if inventory disappeared between checkout and fulfilment.
    const refundTx = await sequelize.transaction();
    try {
      const order = await PurchaseOrder.findByPk(orderId, { transaction: refundTx, lock: refundTx.LOCK.UPDATE });
      const user = await User.findByPk(order.userId, { transaction: refundTx, lock: refundTx.LOCK.UPDATE });
      if (order.status === 'paid' && order.paymentRef !== 'wallet_refunded') {
        user.balance = Number(user.balance || 0) + Number(order.totalAmount || 0);
        await user.save({ transaction: refundTx });
        await BalanceTransaction.create({
          userId: user.id,
          amount: Number(order.totalAmount || 0),
          type: 'wallet_purchase_refund',
          txid: `ORDER-WALLET-REFUND:${order.id}`,
          caption: `Automatic wallet refund after fulfillment failure for order #${order.id}`,
          status: 'completed',
          paymentOrigin: 'wallet',
          networkMethod: 'order_purchase',
          approvalSource: 'system_refund'
        }, { transaction: refundTx });
        order.status = 'payment_error';
        order.paymentRef = 'wallet_refunded';
        await order.save({ transaction: refundTx });
      }
      await refundTx.commit();
    } catch (refundError) {
      await refundTx.rollback();
      console.error('Wallet refund failed:', refundError.message);
    }
    throw error;
  }
}

async function refundServiceOrderToWallet(orderId, reason = 'service_refund_wallet') {
  const transaction = await sequelize.transaction();
  try {
    const order = await PurchaseOrder.findByPk(orderId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!order) throw new Error('ORDER_NOT_FOUND');
    const product = await Merchant.findByPk(order.merchantId, { transaction });
    if (!product || String(product.type || '') !== 'service') throw new Error('NOT_SERVICE_ORDER');

    if (String(order.status || '') === 'refunded_service') {
      await transaction.commit();
      return { order, refunded: 0, alreadyRefunded: true };
    }
    if (!['service_pending_input', 'service_pending_admin'].includes(String(order.status || ''))) {
      throw new Error('SERVICE_ORDER_ALREADY_FINALIZED');
    }

    const amount = Number(order.totalAmount || 0);
    const user = await User.findByPk(order.userId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!user) throw new Error('USER_NOT_FOUND');
    user.balance = Number(user.balance || 0) + amount;
    await user.save({ transaction, fields: ['balance'] });
    await BalanceTransaction.create({
      userId: user.id,
      amount,
      type: 'service_refund',
      txid: `SERVICE-REFUND:${order.id}`,
      caption: `Service order #${order.id} refunded to wallet (${String(reason || 'service_refund_wallet')})`,
      status: 'completed',
      paymentOrigin: 'wallet',
      networkMethod: 'service_order',
      approvalSource: String(reason || '').startsWith('admin_') ? 'admin_service_refund' : 'system_service_refund'
    }, { transaction });

    order.status = 'refunded_service';
    order.paymentRef = String(reason || 'service_refund_wallet');
    order.completedAt = new Date();
    await order.save({ transaction, fields: ['status', 'paymentRef', 'completedAt'] });

    await transaction.commit();
    return { order, refunded: amount, newBalance: Number(user.balance), alreadyRefunded: false };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function addWaitingCode(orderId, code) {
  const transaction = await sequelize.transaction();
  try {
    const order = await PurchaseOrder.findByPk(orderId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!order) throw new Error('ORDER_NOT_FOUND');
    if (order.status !== 'waiting_code') throw new Error('ORDER_NOT_WAITING_CODE');
    const deliveries = Array.isArray(order.delivery) ? [...order.delivery] : [];
    const target = deliveries.find(d => d.waitingCode && !d.payload?.code);
    if (!target) throw new Error('NO_WAITING_ITEM');
    target.payload = { ...(target.payload || {}), code: String(code) };
    target.waitingCode = false;
    if (target.deliveryId) {
      await DeliveryRecord.update({ payload: target.payload }, { where: { id: target.deliveryId }, transaction });
    }
    const stillWaiting = deliveries.some(d => d.waitingCode && !d.payload?.code);
    order.delivery = deliveries;
    order.status = stillWaiting ? 'waiting_code' : 'completed';
    if (!stillWaiting) order.completedAt = new Date();
    await order.save({ transaction });
    await transaction.commit();
    return { order, delivery: target, stillWaiting };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

module.exports = {
  getProductStock,
  getProductStocksMap,
  productAccessibleInCurrentShop,
  productVisibleInCurrentShop,
  effectiveProductPrice,
  normalizeProductFamilyName,
  sortProductStockRows,
  listActiveProducts,
  createOrder,
  createGiftOrder,
  fulfillOrder,
  reserveWalletForOrder,
  refundWalletReservation,
  completeExternalPayment,
  payFromWallet,
  refundServiceOrderToWallet,
  addWaitingCode
};
