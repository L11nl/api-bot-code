const crypto = require('crypto');
const { Op } = require('sequelize');
const config = require('../config');
const {
  sequelize,
  NetworkClient,
  NetworkLedgerEntry,
  NetworkDebtBalance,
  NetworkDebtPayment,
  NetworkNotificationEvent,
  getIqdRate,
  getSetting
} = require('../db');

function normalizeShopId(value) {
  const id = String(value || '').trim();
  return id || 'master';
}

function sellerCommissionSplit(retailUnitPriceUsd) {
  const retail = Math.max(0, Number(retailUnitPriceUsd || 0));
  const percent = Math.min(50, Math.max(0, Number(config.network.sellerCommissionPercent || 10)));
  const commission = Number((retail * percent / 100).toFixed(2));
  const supplier = Number(Math.max(0, retail - commission).toFixed(2));
  return {
    retailUsd: Number(retail.toFixed(2)),
    commissionPercent: percent,
    commissionUsd: commission,
    supplierUsd: supplier
  };
}

function pairParts(aRaw, bRaw) {
  const a = normalizeShopId(aRaw);
  const b = normalizeShopId(bRaw);
  if (a === b) return { pairKey: `${a}|${b}`, shopAId: a, shopBId: b };
  const [shopAId, shopBId] = [a, b].sort((x, y) => x.localeCompare(y));
  return { pairKey: `${shopAId}|${shopBId}`, shopAId, shopBId };
}

function signedDelta(shopAId, debtorShopId, creditorShopId, amountUsd) {
  // Positive: A owes B. Negative: B owes A.
  return normalizeShopId(debtorShopId) === shopAId ? Number(amountUsd) : -Number(amountUsd);
}

async function lockBalance(transaction, shop1, shop2) {
  const pair = pairParts(shop1, shop2);
  await NetworkDebtBalance.findOrCreate({
    where: { pairKey: pair.pairKey },
    defaults: {
      pairKey: pair.pairKey,
      shopAId: pair.shopAId,
      shopBId: pair.shopBId,
      amountSignedUsd: 0
    },
    transaction
  });
  return NetworkDebtBalance.findByPk(pair.pairKey, {
    transaction,
    lock: transaction.LOCK.UPDATE
  });
}

async function applyBalanceDelta({ debtorShopId, creditorShopId, amountUsd, transaction }) {
  const debtor = normalizeShopId(debtorShopId);
  const creditor = normalizeShopId(creditorShopId);
  const amount = Number(amountUsd || 0);
  if (debtor === creditor || !Number.isFinite(amount) || amount <= 0) return null;
  const balance = await lockBalance(transaction, debtor, creditor);
  const delta = signedDelta(balance.shopAId, debtor, creditor, amount);
  let next = Number(balance.amountSignedUsd || 0) + delta;
  if (Math.abs(next) < 0.005) next = 0;
  balance.amountSignedUsd = Number(next.toFixed(2));
  await balance.save({ transaction });
  return balance;
}

async function recordObligation({
  debtorShopId,
  creditorShopId,
  amountUsd,
  kind,
  sourceRef,
  networkProductId = null,
  deliveryId = null,
  sellerShopId = null,
  stockOwnerShopId = null,
  metadata = {},
  transaction: externalTransaction = null
}) {
  const debtor = normalizeShopId(debtorShopId);
  const creditor = normalizeShopId(creditorShopId);
  const amount = Number(amountUsd || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { duplicate: false, skipped: true, entry: null };
  }
  const eventKind = String(kind || 'generic').slice(0, 40);
  const eventRef = String(sourceRef || '').slice(0, 180);
  if (!eventRef) throw new Error('LEDGER_SOURCE_REF_REQUIRED');

  const transaction = externalTransaction || await sequelize.transaction();
  try {
    const existing = await NetworkLedgerEntry.findOne({
      where: { kind: eventKind, sourceRef: eventRef },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (existing) {
      if (!externalTransaction) await transaction.commit();
      return { duplicate: true, entry: existing };
    }

    const entry = await NetworkLedgerEntry.create({
      debtorShopId: debtor,
      creditorShopId: creditor,
      amountUsd: Number(amount.toFixed(2)),
      kind: eventKind,
      sourceRef: eventRef,
      networkProductId,
      deliveryId,
      sellerShopId: sellerShopId ? normalizeShopId(sellerShopId) : null,
      stockOwnerShopId: stockOwnerShopId ? normalizeShopId(stockOwnerShopId) : null,
      metadata: metadata || {}
    }, { transaction });

    if (debtor !== creditor) {
      await applyBalanceDelta({ debtorShopId: debtor, creditorShopId: creditor, amountUsd: amount, transaction });
    }
    if (!externalTransaction) await transaction.commit();
    return { duplicate: false, entry };
  } catch (error) {
    if (!externalTransaction) await transaction.rollback();
    throw error;
  }
}

async function getShopName(shopId) {
  const id = normalizeShopId(shopId);
  if (id === 'master') return config.network.ownerName || 'المالك الرئيسي';
  const client = await NetworkClient.findOne({ where: { shopId: id } });
  return client?.name || id;
}

async function getShopCurrency(shopId) {
  const id = normalizeShopId(shopId);
  if (id === 'master') return String(config.network.settlementCurrency || 'USD').toUpperCase();
  const client = await NetworkClient.findOne({ where: { shopId: id } });
  return String(client?.settlementCurrency || 'USD').toUpperCase();
}

function directionFor(row, shopIdRaw) {
  const shopId = normalizeShopId(shopIdRaw);
  const signed = Number(row.amountSignedUsd || 0);
  if (Math.abs(signed) < 0.005) return null;
  const debtor = signed > 0 ? row.shopAId : row.shopBId;
  const creditor = signed > 0 ? row.shopBId : row.shopAId;
  const counterpartyId = shopId === debtor ? creditor : debtor;
  return {
    debtorShopId: debtor,
    creditorShopId: creditor,
    counterpartyId,
    amountUsd: Math.abs(signed),
    direction: shopId === debtor ? 'owe' : 'owed'
  };
}

async function currencySnapshot(amountUsd) {
  const iqdRate = Number(await getIqdRate());
  const egpRateRaw = Number(await getSetting('egp_rate_per_usd', String(config.network.egpRate || 50)));
  const egpRate = Number.isFinite(egpRateRaw) && egpRateRaw > 0 ? egpRateRaw : 50;
  return {
    usd: Number(amountUsd || 0),
    iqd: Number(amountUsd || 0) * iqdRate,
    egp: Number(amountUsd || 0) * egpRate,
    iqdRate,
    egpRate
  };
}

async function commerceStatusForShop(shopIdRaw) {
  const shopId = normalizeShopId(shopIdRaw);
  const balances = await NetworkDebtBalance.findAll({
    where: { [Op.or]: [{ shopAId: shopId }, { shopBId: shopId }] }
  });
  let openOwedUsd = 0;
  for (const row of balances) {
    const dir = directionFor(row, shopId);
    if (dir?.direction === 'owe') openOwedUsd += Number(dir.amountUsd || 0);
  }
  const pendingOutgoingUsd = Number(await NetworkDebtPayment.sum('amountUsd', {
    where: { debtorShopId: shopId, status: 'pending' }
  }) || 0);
  const liabilityUsd = Number((openOwedUsd + pendingOutgoingUsd).toFixed(2));
  const thresholdUsd = Number(config.network.debtSuspendThresholdUsd || 40);
  return {
    shopId,
    openOwedUsd: Number(openOwedUsd.toFixed(2)),
    pendingOutgoingUsd: Number(pendingOutgoingUsd.toFixed(2)),
    liabilityUsd,
    thresholdUsd,
    suspended: liabilityUsd + 1e-9 >= thresholdUsd
  };
}

async function publishNotificationEvent({ eventType, networkProductId = null, actorShopId = 'master', actorName = null, amount = null, payload = {} }) {
  if (!['new_product', 'stock_added'].includes(String(eventType))) throw new Error('INVALID_NOTIFICATION_EVENT');
  const event = await NetworkNotificationEvent.create({
    eventType: String(eventType),
    networkProductId: networkProductId ? String(networkProductId) : null,
    actorShopId: normalizeShopId(actorShopId),
    actorName: actorName ? String(actorName).slice(0, 120) : await getShopName(actorShopId),
    amount: amount == null ? null : Math.max(0, Math.floor(Number(amount || 0))),
    payload: payload || {}
  });
  if (Number(event.id || 0) % 100 === 0) {
    const cutoff = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    NetworkNotificationEvent.destroy({ where: { createdAt: { [Op.lt]: cutoff } } }).catch(() => {});
  }
  return event;
}

async function notificationEventsAfter(afterId = 0, limit = 100) {
  const safeAfter = Math.max(0, Number(afterId || 0));
  const safeLimit = Math.max(1, Math.min(100, Number(limit || 100)));
  return NetworkNotificationEvent.findAll({
    where: { id: { [Op.gt]: safeAfter } },
    order: [['id', 'ASC']],
    limit: safeLimit
  });
}

async function latestNotificationEventId() {
  const max = await NetworkNotificationEvent.max('id');
  return Number(max || 0);
}

async function accountsForShop(shopIdRaw) {
  const shopId = normalizeShopId(shopIdRaw);
  const balances = await NetworkDebtBalance.findAll({
    where: { [Op.or]: [{ shopAId: shopId }, { shopBId: shopId }] },
    order: [['updatedAt', 'DESC']]
  });
  const accounts = [];
  for (const row of balances) {
    const dir = directionFor(row, shopId);
    if (!dir) continue;
    accounts.push({
      ...dir,
      counterpartyName: await getShopName(dir.counterpartyId),
      values: await currencySnapshot(dir.amountUsd)
    });
  }
  const pendingIncoming = await NetworkDebtPayment.findAll({
    where: { creditorShopId: shopId, status: 'pending' },
    order: [['createdAt', 'ASC']]
  });
  const pendingOutgoing = await NetworkDebtPayment.findAll({
    where: { debtorShopId: shopId, status: 'pending' },
    order: [['createdAt', 'ASC']]
  });
  const decorate = async row => {
    const current = await currencySnapshot(Number(row.amountUsd || 0));
    return {
      ...row.toJSON(),
      debtorName: await getShopName(row.debtorShopId),
      creditorName: await getShopName(row.creditorShopId),
      values: {
        ...current,
        iqd: Number(row.iqdAmount ?? current.iqd),
        egp: Number(row.egpAmount ?? current.egp),
        settlementCurrency: row.settlementCurrency || 'USD',
        settlementAmount: Number(row.settlementAmount ?? row.amountUsd ?? 0)
      }
    };
  };
  const sellerCommissionEarnedUsd = Number(await NetworkLedgerEntry.sum('amountUsd', {
    where: { kind: 'sales_commission', sellerShopId: shopId }
  }) || 0);
  return {
    shopId,
    shopName: await getShopName(shopId),
    accounts,
    pendingIncoming: await Promise.all(pendingIncoming.map(decorate)),
    pendingOutgoing: await Promise.all(pendingOutgoing.map(decorate)),
    sellerCommissionEarnedUsd: Number(sellerCommissionEarnedUsd.toFixed(2)),
    sellerCommissionPercent: Number(config.network.sellerCommissionPercent || 10),
    commerceStatus: await commerceStatusForShop(shopId)
  };
}

async function createDebtPaymentRequest(debtorShopIdRaw, creditorShopIdRaw) {
  const debtor = normalizeShopId(debtorShopIdRaw);
  const creditor = normalizeShopId(creditorShopIdRaw);
  if (debtor === creditor) throw new Error('INVALID_COUNTERPARTY');
  const transaction = await sequelize.transaction();
  try {
    const balance = await lockBalance(transaction, debtor, creditor);
    const dir = directionFor(balance, debtor);
    if (!dir || dir.direction !== 'owe' || normalizeShopId(dir.creditorShopId) !== creditor || dir.amountUsd <= 0) {
      throw new Error('NO_DEBT_TO_PAY');
    }
    const existing = await NetworkDebtPayment.findOne({
      where: { debtorShopId: debtor, creditorShopId: creditor, status: 'pending' },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (existing) {
      await transaction.commit();
      return existing;
    }

    const amount = Number(dir.amountUsd.toFixed(2));
    const values = await currencySnapshot(amount);
    const settlementCurrency = await getShopCurrency(creditor);
    const settlementAmount = settlementCurrency === 'IQD' ? values.iqd : settlementCurrency === 'EGP' ? values.egp : values.usd;
    // Reserve the current debt immediately. New sales after this moment build a
    // new balance independently. If the creditor rejects, this amount returns.
    balance.amountSignedUsd = 0;
    await balance.save({ transaction });
    const request = await NetworkDebtPayment.create({
      id: `NDP-${crypto.randomBytes(10).toString('hex').toUpperCase()}`,
      debtorShopId: debtor,
      creditorShopId: creditor,
      amountUsd: amount,
      settlementCurrency,
      settlementAmount: Number(settlementAmount.toFixed(settlementCurrency === 'IQD' ? 0 : 2)),
      iqdAmount: Number(values.iqd.toFixed(2)),
      egpAmount: Number(values.egp.toFixed(2)),
      status: 'pending',
      requestedByShopId: debtor
    }, { transaction });
    await transaction.commit();
    return request;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function resolveDebtPaymentRequest(requestId, actorShopIdRaw, approve) {
  const actor = normalizeShopId(actorShopIdRaw);
  const transaction = await sequelize.transaction();
  try {
    const request = await NetworkDebtPayment.findByPk(String(requestId), {
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!request) throw new Error('PAYMENT_REQUEST_NOT_FOUND');
    if (request.status !== 'pending') throw new Error('PAYMENT_REQUEST_ALREADY_RESOLVED');
    if (normalizeShopId(request.creditorShopId) !== actor) throw new Error('NOT_PAYMENT_CREDITOR');

    if (approve) {
      request.status = 'confirmed';
      request.confirmedByShopId = actor;
      request.confirmedAt = new Date();
      await request.save({ transaction });
    } else {
      await applyBalanceDelta({
        debtorShopId: request.debtorShopId,
        creditorShopId: request.creditorShopId,
        amountUsd: Number(request.amountUsd),
        transaction
      });
      request.status = 'rejected';
      request.rejectedAt = new Date();
      await request.save({ transaction });
    }
    await transaction.commit();
    return request;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function salesStatsForProduct(product) {
  if (!product) throw new Error('PRODUCT_NOT_FOUND');
  const merchantId = Number(product.id);
  const [rows] = await sequelize.query(`
    SELECT COALESCE(NULLIF("stockOwnerShopId", ''), 'master') AS "shopId",
           COALESCE(SUM(COALESCE("maxUses",1)),0)::int AS "addedUnits",
           COALESCE(SUM(COALESCE("usedCount",0)),0)::int AS "soldUnits",
           COALESCE(SUM(GREATEST(COALESCE("maxUses",1)-COALESCE("usedCount",0),0)),0)::int AS "availableUnits"
    FROM "${String(config.databaseSchema).replace(/"/g, '""')}"."Codes"
    WHERE "merchantId" = :merchantId
    GROUP BY COALESCE(NULLIF("stockOwnerShopId", ''), 'master')
    ORDER BY "shopId" ASC
  `, { replacements: { merchantId } });

  const result = [];
  for (const row of rows || []) {
    const supplierEarnings = await NetworkLedgerEntry.sum('amountUsd', {
      where: {
        kind: 'inventory_sale',
        networkProductId: product.networkProductId,
        stockOwnerShopId: String(row.shopId)
      }
    });
    const sellerCommissions = await NetworkLedgerEntry.sum('amountUsd', {
      where: {
        kind: 'sales_commission',
        networkProductId: product.networkProductId,
        sellerShopId: String(row.shopId)
      }
    });
    result.push({
      shopId: String(row.shopId),
      shopName: await getShopName(row.shopId),
      addedUnits: Number(row.addedUnits || 0),
      soldUnits: Number(row.soldUnits || 0),
      availableUnits: Number(row.availableUnits || 0),
      soldValueUsd: Number(supplierEarnings || 0),
      supplierEarningsUsd: Number(supplierEarnings || 0),
      sellerCommissionUsd: Number(sellerCommissions || 0)
    });
  }
  const commissionRows = await NetworkLedgerEntry.findAll({
    attributes: [
      'sellerShopId',
      [sequelize.fn('SUM', sequelize.col('amountUsd')), 'commissionUsd']
    ],
    where: { kind: 'sales_commission', networkProductId: product.networkProductId },
    group: ['sellerShopId'],
    raw: true
  });
  for (const row of commissionRows || []) {
    const shopId = String(row.sellerShopId || '');
    if (!shopId) continue;
    const existing = result.find(item => String(item.shopId) === shopId);
    if (existing) {
      existing.sellerCommissionUsd = Number(row.commissionUsd || existing.sellerCommissionUsd || 0);
    } else {
      result.push({
        shopId,
        shopName: await getShopName(shopId),
        addedUnits: 0,
        soldUnits: 0,
        availableUnits: 0,
        soldValueUsd: 0,
        supplierEarningsUsd: 0,
        sellerCommissionUsd: Number(row.commissionUsd || 0)
      });
    }
  }
  return result;
}

module.exports = {
  normalizeShopId,
  sellerCommissionSplit,
  recordObligation,
  accountsForShop,
  commerceStatusForShop,
  publishNotificationEvent,
  notificationEventsAfter,
  latestNotificationEventId,
  createDebtPaymentRequest,
  resolveDebtPaymentRequest,
  salesStatsForProduct,
  getShopName,
  getShopCurrency,
  currencySnapshot
};
