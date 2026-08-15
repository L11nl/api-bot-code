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

const shopInfoCache = new Map();
const SHOP_INFO_CACHE_TTL_MS = Math.max(10000, Number(process.env.NETWORK_SHOP_INFO_CACHE_TTL_MS || 60000));

async function cachedShopInfo(shopId) {
  const id = normalizeShopId(shopId);
  if (id === 'master') {
    return {
      name: config.network.ownerName || 'المالك الرئيسي',
      settlementCurrency: String(config.network.settlementCurrency || 'USD').toUpperCase()
    };
  }
  const cached = shopInfoCache.get(id);
  if (cached && Date.now() - cached.at < SHOP_INFO_CACHE_TTL_MS) return cached.value;
  const client = await NetworkClient.findOne({
    where: { shopId: id },
    attributes: ['name', 'settlementCurrency']
  });
  const value = {
    name: client?.name || id,
    settlementCurrency: String(client?.settlementCurrency || 'USD').toUpperCase()
  };
  shopInfoCache.set(id, { at: Date.now(), value });
  return value;
}


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


async function updatePendingAfterNet(row, remainingUsd, transaction) {
  const remaining = Number(Math.max(0, Number(remainingUsd || 0)).toFixed(2));
  if (remaining < 0.005) {
    // Nothing is actually due anymore. Keep the historical request, but remove it
    // from all pending debt calculations. This is intentionally NOT "confirmed":
    // no money changed hands; the two opposite obligations simply cancelled out.
    row.status = 'netted';
    row.debtorNotified = true;
    row.verificationError = null;
    row.submittedOrderId = null;
    await row.save({
      transaction,
      fields: ['status', 'debtorNotified', 'verificationError', 'submittedOrderId']
    });
    return 0;
  }

  row.amountUsd = remaining;
  row.settlementCurrency = 'USD';
  row.settlementAmount = remaining;
  row.iqdAmount = null;
  row.egpAmount = null;
  row.debtorNotified = false;
  await row.save({
    transaction,
    fields: [
      'amountUsd',
      'settlementCurrency',
      'settlementAmount',
      'iqdAmount',
      'egpAmount',
      'debtorNotified'
    ]
  });
  return remaining;
}

async function reconcilePairDebts(shop1Raw, shop2Raw, externalTransaction = null) {
  const pair = pairParts(shop1Raw, shop2Raw);
  if (pair.shopAId === pair.shopBId) return null;

  const transaction = externalTransaction || await sequelize.transaction();
  try {
    const balance = await lockBalance(transaction, pair.shopAId, pair.shopBId);

    // Only requests that have NOT submitted a Binance Order ID can be netted.
    // Once an Order ID exists, money may already have been sent, so that request
    // must finish verification instead of being silently cancelled.
    const pending = await NetworkDebtPayment.findAll({
      where: {
        status: 'pending',
        submittedOrderId: null,
        [Op.or]: [
          { debtorShopId: pair.shopAId, creditorShopId: pair.shopBId },
          { debtorShopId: pair.shopBId, creditorShopId: pair.shopAId }
        ]
      },
      order: [['createdAt', 'ASC']],
      transaction,
      lock: transaction.LOCK.UPDATE
    });

    const aToB = pending.filter(row =>
      normalizeShopId(row.debtorShopId) === pair.shopAId &&
      normalizeShopId(row.creditorShopId) === pair.shopBId
    );
    const bToA = pending.filter(row =>
      normalizeShopId(row.debtorShopId) === pair.shopBId &&
      normalizeShopId(row.creditorShopId) === pair.shopAId
    );

    // 1) Pending request vs pending request in the opposite direction.
    let i = 0;
    let j = 0;
    while (i < aToB.length && j < bToA.length) {
      const left = aToB[i];
      const right = bToA[j];
      const leftAmount = Number(left.amountUsd || 0);
      const rightAmount = Number(right.amountUsd || 0);

      if (leftAmount < 0.005) {
        await updatePendingAfterNet(left, 0, transaction);
        i += 1;
        continue;
      }
      if (rightAmount < 0.005) {
        await updatePendingAfterNet(right, 0, transaction);
        j += 1;
        continue;
      }

      const offset = Math.min(leftAmount, rightAmount);
      const leftRemaining = await updatePendingAfterNet(left, leftAmount - offset, transaction);
      const rightRemaining = await updatePendingAfterNet(right, rightAmount - offset, transaction);
      if (leftRemaining < 0.005) i += 1;
      if (rightRemaining < 0.005) j += 1;
    }

    // 2) Any remaining pending request can also cancel an opposite open balance.
    // Positive balance: A owes B. Negative balance: B owes A.
    let signed = Number(balance.amountSignedUsd || 0);
    if (Math.abs(signed) >= 0.005) {
      const oppositePending = pending.filter(row => {
        if (row.status !== 'pending' || row.submittedOrderId) return false;
        if (signed > 0) {
          return normalizeShopId(row.debtorShopId) === pair.shopBId &&
            normalizeShopId(row.creditorShopId) === pair.shopAId;
        }
        return normalizeShopId(row.debtorShopId) === pair.shopAId &&
          normalizeShopId(row.creditorShopId) === pair.shopBId;
      });

      for (const row of oppositePending) {
        if (Math.abs(signed) < 0.005) break;
        const requestAmount = Number(row.amountUsd || 0);
        if (requestAmount < 0.005) continue;
        const offset = Math.min(Math.abs(signed), requestAmount);
        await updatePendingAfterNet(row, requestAmount - offset, transaction);
        signed = signed > 0 ? signed - offset : signed + offset;
      }
    }

    if (Math.abs(signed) < 0.005) signed = 0;
    const rounded = Number(signed.toFixed(2));
    if (Number(balance.amountSignedUsd || 0) !== rounded) {
      balance.amountSignedUsd = rounded;
      await balance.save({ transaction, fields: ['amountSignedUsd'] });
    }

    if (!externalTransaction) await transaction.commit();
    return balance;
  } catch (error) {
    if (!externalTransaction) await transaction.rollback();
    throw error;
  }
}

async function reconcileAllForShop(shopIdRaw) {
  const shopId = normalizeShopId(shopIdRaw);
  const pairs = await NetworkDebtBalance.findAll({
    where: { [Op.or]: [{ shopAId: shopId }, { shopBId: shopId }] },
    attributes: ['shopAId', 'shopBId'],
    raw: true
  });

  // Also include pairs that may currently exist only as pending requests because
  // createDebtPaymentRequest() reserves the open balance to zero.
  const pendingPairs = await NetworkDebtPayment.findAll({
    where: {
      status: 'pending',
      submittedOrderId: null,
      [Op.or]: [{ debtorShopId: shopId }, { creditorShopId: shopId }]
    },
    attributes: ['debtorShopId', 'creditorShopId'],
    raw: true
  });

  const seen = new Set();
  for (const row of [...pairs, ...pendingPairs]) {
    const a = row.shopAId || row.debtorShopId;
    const b = row.shopBId || row.creditorShopId;
    const pair = pairParts(a, b);
    if (pair.shopAId === pair.shopBId || seen.has(pair.pairKey)) continue;
    seen.add(pair.pairKey);
    await reconcilePairDebts(pair.shopAId, pair.shopBId);
  }
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
      // Immediately offset this new obligation against any opposite, still-unpaid
      // settlement request for the same two shops.
      await reconcilePairDebts(debtor, creditor, transaction);
    }
    if (!externalTransaction) await transaction.commit();
    return { duplicate: false, entry };
  } catch (error) {
    if (!externalTransaction) await transaction.rollback();
    throw error;
  }
}

async function getShopName(shopId) {
  return (await cachedShopInfo(shopId)).name;
}

async function getShopCurrency(shopId) {
  return (await cachedShopInfo(shopId)).settlementCurrency;
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
  await reconcileAllForShop(shopId);
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
  // Self-heal old v12.0.x data too: opening the accounts screen is enough to
  // net opposite unpaid requests that were created before this fix.
  await reconcileAllForShop(shopId);
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

async function createDebtPaymentRequest(debtorShopIdRaw, creditorShopIdRaw, options = {}) {
  const debtor = normalizeShopId(debtorShopIdRaw);
  const creditor = normalizeShopId(creditorShopIdRaw);
  if (debtor === creditor) throw new Error('INVALID_COUNTERPARTY');
  const binancePayId = String(options?.binancePayId || '').trim();
  if (!binancePayId) throw new Error('CREDITOR_BINANCE_NOT_CONFIGURED');

  const transaction = await sequelize.transaction();
  try {
    await reconcilePairDebts(debtor, creditor, transaction);
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
      if (!existing.binancePayId && binancePayId) {
        existing.binancePayId = binancePayId;
        await existing.save({ transaction, fields: ['binancePayId'] });
      }
      await transaction.commit();
      return existing;
    }

    const amount = Number(dir.amountUsd.toFixed(2));
    // Reserve the current debt immediately. New operations after this point build
    // a new balance independently. The reserved amount stays part of liability
    // until Binance verification succeeds.
    balance.amountSignedUsd = 0;
    await balance.save({ transaction });
    const request = await NetworkDebtPayment.create({
      id: `NDP-${crypto.randomBytes(10).toString('hex').toUpperCase()}`,
      debtorShopId: debtor,
      creditorShopId: creditor,
      amountUsd: amount,
      settlementCurrency: 'USD',
      settlementAmount: amount,
      iqdAmount: null,
      egpAmount: null,
      status: 'pending',
      requestedByShopId: debtor,
      binancePayId,
      submittedOrderId: null,
      transactionId: null,
      verificationError: null,
      debtorNotified: false
    }, { transaction });
    await transaction.commit();
    return request;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function submitDebtBinanceOrder(requestId, debtorShopIdRaw, submittedOrderId) {
  const debtor = normalizeShopId(debtorShopIdRaw);
  const orderId = String(submittedOrderId || '').trim();
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(orderId)) throw new Error('INVALID_ORDER_ID');
  const transaction = await sequelize.transaction();
  try {
    const request = await NetworkDebtPayment.findByPk(String(requestId), { transaction, lock: transaction.LOCK.UPDATE });
    if (!request || normalizeShopId(request.debtorShopId) !== debtor) throw new Error('PAYMENT_REQUEST_NOT_FOUND');
    if (request.status !== 'pending') throw new Error('PAYMENT_REQUEST_ALREADY_RESOLVED');
    const duplicate = await NetworkDebtPayment.findOne({
      where: {
        id: { [Op.ne]: request.id },
        [Op.or]: [
          { submittedOrderId: orderId },
          { transactionId: orderId }
        ]
      },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (duplicate) throw new Error('DUPLICATE_TRANSACTION');
    request.submittedOrderId = orderId;
    request.verificationError = null;
    request.debtorNotified = false;
    await request.save({ transaction, fields: ['submittedOrderId', 'verificationError', 'debtorNotified'] });
    await transaction.commit();
    return request;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function debtBinanceVerificationsForCreditor(creditorShopIdRaw) {
  const creditor = normalizeShopId(creditorShopIdRaw);
  return NetworkDebtPayment.findAll({
    where: {
      creditorShopId: creditor,
      status: 'pending',
      submittedOrderId: { [Op.not]: null }
    },
    order: [['createdAt', 'ASC']],
    limit: 100
  });
}

async function finishDebtBinanceVerification(requestId, creditorShopIdRaw, result = {}) {
  const creditor = normalizeShopId(creditorShopIdRaw);
  const transaction = await sequelize.transaction();
  try {
    const request = await NetworkDebtPayment.findByPk(String(requestId), { transaction, lock: transaction.LOCK.UPDATE });
    if (!request || normalizeShopId(request.creditorShopId) !== creditor) throw new Error('PAYMENT_REQUEST_NOT_FOUND');
    if (request.status !== 'pending') {
      await transaction.commit();
      return request;
    }

    if (result.success) {
      const transactionId = String(result.transactionId || '').trim();
      if (!transactionId) throw new Error('TRANSACTION_ID_REQUIRED');
      const duplicate = await NetworkDebtPayment.findOne({
        where: {
          id: { [Op.ne]: request.id },
          transactionId,
          status: 'confirmed'
        },
        transaction,
        lock: transaction.LOCK.UPDATE
      });
      if (duplicate) {
        request.verificationError = 'DUPLICATE_TRANSACTION';
        request.submittedOrderId = null;
        request.debtorNotified = false;
        await request.save({ transaction, fields: ['verificationError', 'submittedOrderId', 'debtorNotified'] });
        await transaction.commit();
        return request;
      }
      request.status = 'confirmed';
      request.confirmedByShopId = creditor;
      request.transactionId = transactionId;
      request.verificationError = null;
      request.verifiedAt = new Date();
      request.confirmedAt = new Date();
      request.debtorNotified = false;
      await request.save({ transaction });
    } else {
      request.verificationError = String(result.reason || 'NO_MATCH').slice(0, 80);
      // Allow the debtor to submit another Order ID without creating a new debt request.
      request.submittedOrderId = null;
      request.debtorNotified = false;
      await request.save({ transaction, fields: ['verificationError', 'submittedOrderId', 'debtorNotified'] });
    }
    await transaction.commit();
    return request;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function debtPaymentResultsForDebtor(debtorShopIdRaw) {
  const debtor = normalizeShopId(debtorShopIdRaw);
  return NetworkDebtPayment.findAll({
    where: {
      debtorShopId: debtor,
      debtorNotified: false,
      [Op.or]: [
        { status: 'confirmed' },
        { verificationError: { [Op.not]: null } }
      ]
    },
    order: [['updatedAt', 'ASC']],
    limit: 100
  });
}

async function acknowledgeDebtPaymentResult(requestId, debtorShopIdRaw) {
  const debtor = normalizeShopId(debtorShopIdRaw);
  const request = await NetworkDebtPayment.findOne({ where: { id: String(requestId), debtorShopId: debtor } });
  if (!request) throw new Error('PAYMENT_REQUEST_NOT_FOUND');
  request.debtorNotified = true;
  await request.save({ fields: ['debtorNotified'] });
  return request;
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
  submitDebtBinanceOrder,
  debtBinanceVerificationsForCreditor,
  finishDebtBinanceVerification,
  debtPaymentResultsForDebtor,
  acknowledgeDebtPaymentResult,
  resolveDebtPaymentRequest,
  salesStatsForProduct,
  getShopName,
  getShopCurrency,
  currencySnapshot,
  reconcilePairDebts,
  reconcileAllForShop
};
