const { Sequelize, DataTypes, Op } = require('sequelize');
const crypto = require('crypto');
const config = require('./config');
const { encryptPayload, decryptPayload, isEncrypted, legacyPayload } = require('./cryptoStore');
const { inventoryFingerprint, inventoryPayloadIsValid, parseDescription } = require('./utils');

// Small in-process caches remove repeated PostgreSQL round-trips from every
// Telegram message/button. All writes invalidate/update the cache immediately.
const settingCache = new Map();
const secureSettingCache = new Map();
const SETTING_CACHE_TTL_MS = Math.max(5000, Number(process.env.SETTING_CACHE_TTL_MS || 60000));
const SECURE_SETTING_CACHE_TTL_MS = Math.max(5000, Number(process.env.SECURE_SETTING_CACHE_TTL_MS || 30000));

function cacheRead(map, key, ttl) {
  const row = map.get(String(key));
  if (!row || Date.now() - row.at > ttl) {
    if (row) map.delete(String(key));
    return null;
  }
  return row;
}


function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function tableSql(tableName) {
  return `${quoteIdent(config.databaseSchema)}.${quoteIdent(tableName)}`;
}

const sequelize = new Sequelize(config.databaseUrl, {
  dialect: 'postgres',
  logging: false,
  dialectOptions: config.databaseUrl.includes('railway.internal')
    ? {}
    : { ssl: { require: true, rejectUnauthorized: false } },
  pool: { max: 10, min: 0, acquire: 30000, idle: 10000 },
  define: { schema: config.databaseSchema }
});

const User = sequelize.define('User', {
  id: { type: DataTypes.BIGINT, primaryKey: true },
  lang: { type: DataTypes.STRING(2), defaultValue: 'ar' },
  balance: { type: DataTypes.DECIMAL(18, 8), defaultValue: 0 },
  state: { type: DataTypes.TEXT, allowNull: true },
  verified: { type: DataTypes.BOOLEAN, defaultValue: false },
  blocked: { type: DataTypes.BOOLEAN, defaultValue: false },
  username: { type: DataTypes.STRING, allowNull: true },
  firstName: { type: DataTypes.STRING, allowNull: true },
  paymentCurrency: { type: DataTypes.STRING(3), allowNull: true },
  referredBy: { type: DataTypes.BIGINT, allowNull: true },
  referralProcessed: { type: DataTypes.BOOLEAN, defaultValue: false },
  referralOfferShown: { type: DataTypes.BOOLEAN, defaultValue: false }
});

const Setting = sequelize.define('Setting', {
  key: { type: DataTypes.STRING, allowNull: false },
  lang: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'global' },
  value: { type: DataTypes.TEXT, allowNull: false }
}, { indexes: [{ unique: true, fields: ['key', 'lang'] }] });


const PaymentMethod = sequelize.define('PaymentMethod', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  nameAr: { type: DataTypes.STRING(120), allowNull: false },
  nameEn: { type: DataTypes.STRING(120), allowNull: false },
  paymentNumber: { type: DataTypes.STRING(255), allowNull: false },
  iconCustomEmojiId: { type: DataTypes.STRING(32), allowNull: true },
  iconAlt: { type: DataTypes.STRING(16), allowNull: false, defaultValue: '💳' },
  isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  settlementCurrency: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'USD' },
  ratePerUsd: { type: DataTypes.DECIMAL(18, 4), allowNull: true },
  minimumTransferAmount: { type: DataTypes.DECIMAL(18, 4), allowNull: false, defaultValue: 0.01 },
  // v13: a payment rail may stay private to this storefront or be shared
  // with the network. Existing methods default to public for compatibility.
  visibilityScope: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'public' },
  createdByAdminId: { type: DataTypes.BIGINT, allowNull: true },
  createdByDisplayName: { type: DataTypes.STRING(160), allowNull: true }
});

const Merchant = sequelize.define('Merchant', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  nameEn: { type: DataTypes.STRING, allowNull: false },
  nameAr: { type: DataTypes.STRING, allowNull: false },
  price: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
  // For network products on client bots: the owner's shared catalog price is
  // the minimum allowed price. A reseller may keep a higher price only in
  // their own schema without changing the master catalog.
  networkBasePriceUsd: { type: DataTypes.DECIMAL(18, 2), allowNull: true },
  localPriceOverrideUsd: { type: DataTypes.DECIMAL(18, 2), allowNull: true },
  category: { type: DataTypes.STRING, defaultValue: 'general' },
  type: { type: DataTypes.STRING, defaultValue: 'free' },
  description: { type: DataTypes.JSONB, allowNull: true, defaultValue: {} },
  image: { type: DataTypes.TEXT, allowNull: true },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  sharedLimit: { type: DataTypes.INTEGER, defaultValue: 1 },
  deliveryMode: { type: DataTypes.STRING, defaultValue: 'instant' },
  sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
  // Secret admin-only field. Never rendered to customers.
  ownerNote: { type: DataTypes.TEXT, allowNull: true },
  networkProductId: { type: DataTypes.STRING(64), allowNull: true, unique: true },
  networkManaged: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  networkOwnerShopId: { type: DataTypes.STRING(80), allowNull: true },
  networkStock: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  // v13: public/private source scope plus a storefront-local publication
  // decision. The source catalog stays independent from each bot's choice to
  // publish, hide, reject or locally delete the product.
  visibilityScope: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'public' },
  localPublicationStatus: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'published' },
  createdByAdminId: { type: DataTypes.BIGINT, allowNull: true },
  createdByDisplayName: { type: DataTypes.STRING(160), allowNull: true },
  localReviewNotifiedAt: { type: DataTypes.DATE, allowNull: true }
});

const Code = sequelize.define('Code', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  value: { type: DataTypes.TEXT, allowNull: false },
  extra: { type: DataTypes.TEXT, allowNull: true },
  merchantId: { type: DataTypes.INTEGER, references: { model: Merchant, key: 'id' } },
  isUsed: { type: DataTypes.BOOLEAN, defaultValue: false },
  usedBy: { type: DataTypes.BIGINT, allowNull: true },
  soldAt: { type: DataTypes.DATE, allowNull: true },
  expiresAt: { type: DataTypes.DATE, allowNull: true },
  maxUses: { type: DataTypes.INTEGER, defaultValue: 1 },
  usedCount: { type: DataTypes.INTEGER, defaultValue: 0 },
  buyers: { type: DataTypes.JSONB, defaultValue: [] },
  fingerprint: { type: DataTypes.STRING(64), allowNull: true },
  // Owner of this exact stock unit inside the shared network.
  // 'master' means the main shop; clients use their NETWORK_SHOP_ID.
  stockOwnerShopId: { type: DataTypes.STRING(80), allowNull: true, defaultValue: 'master' },
  // Snapshot of the contributor's per-unit entitlement when this stock was added.
  contributionPriceUsd: { type: DataTypes.DECIMAL(18, 2), allowNull: true }
});

const PurchaseOrder = sequelize.define('PurchaseOrder', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  userId: { type: DataTypes.BIGINT, allowNull: false },
  merchantId: { type: DataTypes.INTEGER, allowNull: false },
  quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  unitPrice: { type: DataTypes.DECIMAL(18, 2), allowNull: false },
  totalAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: false },
  currency: { type: DataTypes.STRING(10), defaultValue: 'USDT' },
  paymentMethod: { type: DataTypes.STRING, allowNull: false },
  status: { type: DataTypes.STRING, defaultValue: 'pending_payment' },
  proofFileId: { type: DataTypes.TEXT, allowNull: true },
  paymentRef: { type: DataTypes.TEXT, allowNull: true },
  adminMessageId: { type: DataTypes.BIGINT, allowNull: true },
  delivery: { type: DataTypes.JSONB, defaultValue: [] },
  paidAt: { type: DataTypes.DATE, allowNull: true },
  completedAt: { type: DataTypes.DATE, allowNull: true },
  walletApplied: { type: DataTypes.DECIMAL(18, 8), allowNull: false, defaultValue: 0 },
  externalAmount: { type: DataTypes.DECIMAL(18, 8), allowNull: false, defaultValue: 0 },
  paymentOrigin: { type: DataTypes.STRING(24), allowNull: true },
  remoteOrderRef: { type: DataTypes.STRING(96), allowNull: true, unique: true }
});

const BalanceTransaction = sequelize.define('BalanceTransaction', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  userId: { type: DataTypes.BIGINT, allowNull: false },
  amount: { type: DataTypes.DECIMAL(18, 8), allowNull: false },
  type: { type: DataTypes.STRING, allowNull: false },
  paymentMethodId: { type: DataTypes.INTEGER, allowNull: true },
  txid: { type: DataTypes.STRING, allowNull: true },
  imageFileId: { type: DataTypes.STRING, allowNull: true },
  caption: { type: DataTypes.TEXT, allowNull: true },
  status: { type: DataTypes.STRING, defaultValue: 'pending' },
  adminMessageId: { type: DataTypes.BIGINT, allowNull: true },
  lastReminderAt: { type: DataTypes.DATE, allowNull: true },
  paymentOrigin: { type: DataTypes.STRING(24), allowNull: true },
  networkMethod: { type: DataTypes.STRING(80), allowNull: true },
  // Durable audit trail for wallet credits. These fields are intentionally
  // stored on the balance ledger rather than inferred from Telegram messages.
  approvedByTelegramId: { type: DataTypes.BIGINT, allowNull: true },
  approvedByUsername: { type: DataTypes.STRING(64), allowNull: true },
  approvedByDisplayName: { type: DataTypes.STRING(160), allowNull: true },
  approvalSource: { type: DataTypes.STRING(48), allowNull: true }
});

const BinanceTransfer = sequelize.define('BinanceTransfer', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  userId: { type: DataTypes.BIGINT, allowNull: false },
  orderId: { type: DataTypes.INTEGER, allowNull: true },
  balanceTransactionId: { type: DataTypes.INTEGER, allowNull: true },
  verificationCode: { type: DataTypes.STRING(32), allowNull: false },
  expectedAmount: { type: DataTypes.DECIMAL(18, 8), allowNull: false },
  currency: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'USDT' },
  status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'WAITING' },
  submittedOrderId: { type: DataTypes.STRING(128), allowNull: true },
  transactionId: { type: DataTypes.STRING(128), allowNull: true, unique: true },
  verifiedAt: { type: DataTypes.DATE, allowNull: true },
  rawPayload: { type: DataTypes.JSONB, allowNull: true }
}, {
  indexes: [
    { fields: ['userId'] },
    { fields: ['orderId'] },
    { fields: ['status'] },
    { unique: true, fields: ['transactionId'] }
  ]
});

const VirtualNumberOrder = sequelize.define('VirtualNumberOrder', {
  id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  userId: { type: DataTypes.BIGINT, allowNull: false },
  serviceCode: { type: DataTypes.STRING(32), allowNull: false },
  serviceName: { type: DataTypes.STRING(160), allowNull: false },
  countryId: { type: DataTypes.STRING(32), allowNull: false },
  countryName: { type: DataTypes.STRING(160), allowNull: false },
  providerCostUsd: { type: DataTypes.DECIMAL(18, 8), allowNull: false, defaultValue: 0 },
  salePriceUsd: { type: DataTypes.DECIMAL(18, 8), allowNull: false, defaultValue: 0 },
  activationId: { type: DataTypes.STRING(96), allowNull: true },
  phoneNumber: { type: DataTypes.STRING(64), allowNull: true },
  smsCode: { type: DataTypes.TEXT, allowNull: true },
  status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'reserving' },
  refundApplied: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  providerCostAccounted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  providerCostReversed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  accountingLastError: { type: DataTypes.STRING(255), allowNull: true },
  refundedAt: { type: DataTypes.DATE, allowNull: true },
  expiresAt: { type: DataTypes.DATE, allowNull: true },
  completedAt: { type: DataTypes.DATE, allowNull: true },
  lastProviderStatus: { type: DataTypes.STRING(255), allowNull: true },
  rawProvider: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
  providerOwnerShopId: { type: DataTypes.STRING(80), allowNull: true },
  providerSource: { type: DataTypes.STRING(24), allowNull: true }
}, {
  indexes: [
    { fields: ['userId', 'createdAt'] },
    { fields: ['status', 'createdAt'] },
    { unique: true, fields: ['activationId'] }
  ]
});

const SupportTicket = sequelize.define('SupportTicket', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  userId: { type: DataTypes.BIGINT, allowNull: false },
  status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'open' },
  assignedAdminId: { type: DataTypes.BIGINT, allowNull: true },
  lastMessageAt: { type: DataTypes.DATE, allowNull: true },
  closedAt: { type: DataTypes.DATE, allowNull: true }
}, {
  indexes: [
    { fields: ['userId', 'status'] },
    { fields: ['lastMessageAt'] }
  ]
});

const Referral = sequelize.define('Referral', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  referrerId: { type: DataTypes.BIGINT, allowNull: false },
  referredId: { type: DataTypes.BIGINT, allowNull: false, unique: true },
  rewardAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
  status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'rewarded' }
}, {
  indexes: [
    { fields: ['referrerId'] },
    { unique: true, fields: ['referredId'] }
  ]
});

const GiftClaim = sequelize.define('GiftClaim', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  userId: { type: DataTypes.BIGINT, allowNull: false },
  campaignKey: { type: DataTypes.STRING(128), allowNull: false },
  merchantId: { type: DataTypes.INTEGER, allowNull: false },
  status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'pending' },
  orderId: { type: DataTypes.INTEGER, allowNull: true },
  error: { type: DataTypes.TEXT, allowNull: true }
}, {
  indexes: [
    { unique: true, fields: ['userId', 'campaignKey'] },
    { fields: ['status'] }
  ]
});


const SecureSetting = sequelize.define('SecureSetting', {
  key: { type: DataTypes.STRING(80), primaryKey: true },
  value: { type: DataTypes.TEXT, allowNull: false }
});

const DeliveryRecord = sequelize.define('DeliveryRecord', {
  id: { type: DataTypes.STRING(40), primaryKey: true },
  orderId: { type: DataTypes.INTEGER, allowNull: false },
  userId: { type: DataTypes.BIGINT, allowNull: false },
  merchantId: { type: DataTypes.INTEGER, allowNull: false },
  codeId: { type: DataTypes.INTEGER, allowNull: true },
  payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
  sourceShopId: { type: DataTypes.STRING(80), allowNull: true },
  inventoryOwnerShopId: { type: DataTypes.STRING(80), allowNull: true },
  unitPriceUsd: { type: DataTypes.DECIMAL(18, 2), allowNull: true },
  supplierValueUsd: { type: DataTypes.DECIMAL(18, 2), allowNull: true }
}, { indexes: [{ fields: ['orderId'] }, { fields: ['userId'] }] });

const NetworkClient = sequelize.define('NetworkClient', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  shopId: { type: DataTypes.STRING(80), allowNull: false, unique: true },
  name: { type: DataTypes.STRING(120), allowNull: false },
  ownerTelegramId: { type: DataTypes.BIGINT, allowNull: true },
  apiKeyHash: { type: DataTypes.STRING(64), allowNull: false, unique: true },
  settlementCurrency: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'USD' },
  // Public settlement profile only. API secret/key remain inside each shop schema.
  binancePayId: { type: DataTypes.STRING(120), allowNull: true },
  binanceReady: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  capabilities: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} }
});

const NetworkSettlement = sequelize.define('NetworkSettlement', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  debtorShopId: { type: DataTypes.STRING(80), allowNull: false },
  creditorShopId: { type: DataTypes.STRING(80), allowNull: false, defaultValue: 'master' },
  amountUsd: { type: DataTypes.DECIMAL(18, 2), allowNull: false },
  iqdAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: true },
  egpAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: true },
  settlementCurrency: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'USD' },
  settlementAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: true },
  sourceMethod: { type: DataTypes.STRING(80), allowNull: false },
  sourceRef: { type: DataTypes.STRING(160), allowNull: true },
  customerName: { type: DataTypes.STRING(160), allowNull: true },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'open' }
}, { indexes: [{ fields: ['debtorShopId', 'status'] }, { unique: true, fields: ['debtorShopId', 'sourceMethod', 'sourceRef'] }] });



const NetworkLedgerEntry = sequelize.define('NetworkLedgerEntry', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  debtorShopId: { type: DataTypes.STRING(80), allowNull: false },
  creditorShopId: { type: DataTypes.STRING(80), allowNull: false },
  amountUsd: { type: DataTypes.DECIMAL(18, 2), allowNull: false },
  kind: { type: DataTypes.STRING(40), allowNull: false },
  sourceRef: { type: DataTypes.STRING(180), allowNull: false },
  networkProductId: { type: DataTypes.STRING(64), allowNull: true },
  deliveryId: { type: DataTypes.STRING(40), allowNull: true },
  sellerShopId: { type: DataTypes.STRING(80), allowNull: true },
  stockOwnerShopId: { type: DataTypes.STRING(80), allowNull: true },
  metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} }
}, { indexes: [
  { unique: true, fields: ['kind', 'sourceRef'] },
  { fields: ['debtorShopId', 'creditorShopId'] },
  { fields: ['networkProductId', 'stockOwnerShopId'] }
] });

// One net balance per unordered shop pair. Positive means shopA owes shopB;
// negative means shopB owes shopA. This lets opposite debts cancel cleanly
// without losing the detailed ledger above.
const NetworkDebtBalance = sequelize.define('NetworkDebtBalance', {
  pairKey: { type: DataTypes.STRING(170), primaryKey: true },
  shopAId: { type: DataTypes.STRING(80), allowNull: false },
  shopBId: { type: DataTypes.STRING(80), allowNull: false },
  amountSignedUsd: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 }
});

const NetworkDebtPayment = sequelize.define('NetworkDebtPayment', {
  id: { type: DataTypes.STRING(64), primaryKey: true },
  debtorShopId: { type: DataTypes.STRING(80), allowNull: false },
  creditorShopId: { type: DataTypes.STRING(80), allowNull: false },
  amountUsd: { type: DataTypes.DECIMAL(18, 2), allowNull: false },
  settlementCurrency: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'USD' },
  settlementAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: true },
  iqdAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: true },
  egpAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: true },
  status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'pending' },
  requestedByShopId: { type: DataTypes.STRING(80), allowNull: false },
  confirmedByShopId: { type: DataTypes.STRING(80), allowNull: true },
  // Network debt is settled only in USD/USDT via the creditor's Binance ID.
  binancePayId: { type: DataTypes.STRING(120), allowNull: true },
  submittedOrderId: { type: DataTypes.STRING(128), allowNull: true },
  transactionId: { type: DataTypes.STRING(128), allowNull: true },
  verificationError: { type: DataTypes.STRING(80), allowNull: true },
  debtorNotified: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  verifiedAt: { type: DataTypes.DATE, allowNull: true },
  rejectedAt: { type: DataTypes.DATE, allowNull: true },
  confirmedAt: { type: DataTypes.DATE, allowNull: true }
}, { indexes: [
  { fields: ['debtorShopId', 'status'] },
  { fields: ['creditorShopId', 'status'] }
] });

const NetworkPaymentIntent = sequelize.define('NetworkPaymentIntent', {
  id: { type: DataTypes.STRING(64), primaryKey: true },
  shopId: { type: DataTypes.STRING(80), allowNull: false },
  customerId: { type: DataTypes.BIGINT, allowNull: true },
  customerName: { type: DataTypes.STRING(160), allowNull: true },
  activity: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'payment' },
  amountUsd: { type: DataTypes.DECIMAL(18, 8), allowNull: false },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'waiting' },
  submittedOrderId: { type: DataTypes.STRING(128), allowNull: true },
  transactionId: { type: DataTypes.STRING(128), allowNull: true, unique: true },
  expiresAt: { type: DataTypes.DATE, allowNull: false }
}, { indexes: [{ fields: ['shopId', 'status'] }, { unique: true, fields: ['transactionId'] }] });

// Shared notification stream. Every network bot keeps its own local cursor, so
// notifications can be enabled/disabled independently without losing events for
// other shops.
const NetworkNotificationEvent = sequelize.define('NetworkNotificationEvent', {
  id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  eventType: { type: DataTypes.STRING(32), allowNull: false },
  networkProductId: { type: DataTypes.STRING(64), allowNull: true },
  actorShopId: { type: DataTypes.STRING(80), allowNull: false, defaultValue: 'master' },
  actorName: { type: DataTypes.STRING(120), allowNull: true },
  amount: { type: DataTypes.INTEGER, allowNull: true },
  payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} }
}, { indexes: [
  { fields: ['id'] },
  { fields: ['eventType', 'createdAt'] }
] });


// Custom payment methods shared across the network. Core methods such as
// Binance and SuperQi are intentionally NOT stored here; they stay private
// to the bot that configured them.
const NetworkSharedPaymentMethod = sequelize.define('NetworkSharedPaymentMethod', {
  id: { type: DataTypes.STRING(96), primaryKey: true },
  ownerShopId: { type: DataTypes.STRING(80), allowNull: false },
  ownerLocalMethodId: { type: DataTypes.INTEGER, allowNull: false },
  nameAr: { type: DataTypes.STRING(120), allowNull: false },
  nameEn: { type: DataTypes.STRING(120), allowNull: false },
  paymentNumber: { type: DataTypes.STRING(255), allowNull: false },
  iconCustomEmojiId: { type: DataTypes.STRING(32), allowNull: true },
  iconAlt: { type: DataTypes.STRING(16), allowNull: false, defaultValue: '💳' },
  settlementCurrency: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'USD' },
  ratePerUsd: { type: DataTypes.DECIMAL(18, 4), allowNull: false, defaultValue: 1 },
  minimumTransferAmount: { type: DataTypes.DECIMAL(18, 4), allowNull: false, defaultValue: 0.01 },
  isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }
});

// Indexes for this table are created manually in initializeDatabase().
// This avoids PostgreSQL's 63-character identifier truncation causing
// Sequelize to recreate the same auto-named index on every Railway boot.

// A shared payment is approved by the owner of the payment rail, not by the
// storefront that merely displayed it. The source bot completes the local
// order/top-up only after the owner confirms that the money really arrived.
const NetworkSharedPaymentRequest = sequelize.define('NetworkSharedPaymentRequest', {
  id: { type: DataTypes.STRING(72), primaryKey: true },
  sharedPaymentMethodId: { type: DataTypes.STRING(96), allowNull: false },
  paymentOwnerShopId: { type: DataTypes.STRING(80), allowNull: false },
  sourceShopId: { type: DataTypes.STRING(80), allowNull: false },
  activity: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'purchase' },
  sourceRef: { type: DataTypes.STRING(120), allowNull: false },
  sourceEntityId: { type: DataTypes.STRING(80), allowNull: false },
  customerId: { type: DataTypes.BIGINT, allowNull: true },
  customerName: { type: DataTypes.STRING(160), allowNull: true },
  amountUsd: { type: DataTypes.DECIMAL(18, 8), allowNull: false },
  paymentCurrency: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'USD' },
  paymentAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: false },
  status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'waiting_owner' },
  sourceHandled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  approvedByTelegramId: { type: DataTypes.BIGINT, allowNull: true },
  approvedByUsername: { type: DataTypes.STRING(64), allowNull: true },
  approvedByDisplayName: { type: DataTypes.STRING(160), allowNull: true },
  resolvedAt: { type: DataTypes.DATE, allowNull: true }
});

// Indexes for this table are also created manually with short stable names.

Merchant.hasMany(Code, { foreignKey: 'merchantId' });
Code.belongsTo(Merchant, { foreignKey: 'merchantId' });
User.hasMany(PurchaseOrder, { foreignKey: 'userId' });
PurchaseOrder.belongsTo(User, { foreignKey: 'userId' });
Merchant.hasMany(PurchaseOrder, { foreignKey: 'merchantId' });
PurchaseOrder.belongsTo(Merchant, { foreignKey: 'merchantId' });
PurchaseOrder.hasOne(BinanceTransfer, { foreignKey: 'orderId' });
BinanceTransfer.belongsTo(PurchaseOrder, { foreignKey: 'orderId' });
User.hasMany(SupportTicket, { foreignKey: 'userId' });
SupportTicket.belongsTo(User, { foreignKey: 'userId' });
User.hasMany(VirtualNumberOrder, { foreignKey: 'userId' });
VirtualNumberOrder.belongsTo(User, { foreignKey: 'userId' });

async function addColumnIfMissing(tableName, columnName, definition) {
  const qi = sequelize.getQueryInterface();

  // IMPORTANT: QueryInterface methods do not consistently apply options.schema
  // to schema-qualify ALTER TABLE statements. Passing a table reference object
  // guarantees that both describeTable() and addColumn() target the exact
  // DATABASE_SCHEMA for this bot (e.g. client_xxx instead of public).
  const tableRef = { tableName, schema: config.databaseSchema };

  let table;
  try {
    table = await qi.describeTable(tableRef);
  } catch (error) {
    // The table may not exist yet on a brand-new schema; sequelize.sync() will
    // normally create it before this helper is reached. Do not turn that into a
    // second startup failure here.
    return;
  }

  if (table[columnName]) return;

  try {
    await qi.addColumn(tableRef, columnName, definition);
  } catch (error) {
    // PostgreSQL 42701 = duplicate_column. This can happen when two Railway
    // instances overlap during a deploy and race between describe/add. The end
    // state is already correct, so it is safe to continue.
    if (String(error?.original?.code || error?.parent?.code || error?.code || '') === '42701') return;
    throw error;
  }
}

async function migrateLegacySingleFileBotData() {
  // The previous bot used "single" for one code per line and "bulk" for
  // email/password accounts. Convert those values before inventory cleanup,
  // otherwise the v4 parser would treat old codes as private accounts.
  await sequelize.query(`
    UPDATE ${tableSql('Merchants')}
    SET "type" = CASE
      WHEN LOWER(COALESCE("type", '')) = 'single' THEN 'code'
      WHEN LOWER(COALESCE("type", '')) = 'bulk' THEN 'account'
      ELSE "type"
    END
    WHERE LOWER(COALESCE("type", '')) IN ('single', 'bulk')
  `).catch(() => {});

  // Preserve photo/video product cards from the old JSON description format.
  const products = await Merchant.findAll();
  for (const product of products) {
    const description = product.description;
    if (
      description && typeof description === 'object' && !Array.isArray(description) &&
      ['photo', 'video'].includes(String(description.type || '').toLowerCase()) &&
      description.fileId && !product.image
    ) {
      product.image = String(description.fileId);
      await product.save({ fields: ['image'] });
    }
  }

  // Convert old digital-section category ids to their readable section names
  // when the legacy DigitalSections table is still present.
  try {
    const [sections] = await sequelize.query(`
      SELECT "id", "nameAr", "nameEn"
      FROM ${tableSql('DigitalSections')}
    `);
    for (const section of sections || []) {
      const label = String(section.nameAr || section.nameEn || '').trim();
      if (!label) continue;
      await Merchant.update(
        { category: label },
        { where: { category: `digital_section_${section.id}` } }
      );
    }
  } catch {}

  // Reuse the previous SuperQi number / IQD exchange rate if they were already
  // configured in DepositConfigs. The cloned bot itself exposes only the exact
  // Binance ID + SuperQi payment flow of the reference project.
  try {
    const existingNumber = await Setting.findOne({ where: { key: 'superqi_number', lang: 'global' } });
    const existingRate = await Setting.findOne({ where: { key: 'iqd_rate', lang: 'global' } });
    if (!existingNumber || !existingRate) {
      const [rows] = await sequelize.query(`
        SELECT "walletAddress", "rate", "methods"
        FROM ${tableSql('DepositConfigs')}
        WHERE UPPER("currency") = 'IQD'
        ORDER BY "id" ASC
        LIMIT 1
      `);
      const legacy = rows?.[0];
      if (legacy) {
        let methods = legacy.methods;
        if (typeof methods === 'string') {
          try { methods = JSON.parse(methods); } catch { methods = []; }
        }
        const methodNumber = Array.isArray(methods)
          ? String(methods.find(item => item && item.value)?.value || '').trim()
          : '';
        const walletNumber = String(legacy.walletAddress || '').trim();
        const walletLooksPlaceholder = !walletNumber || /superkey|\.\.\.|123456/i.test(walletNumber);
        const superQiNumber = !walletLooksPlaceholder ? walletNumber : methodNumber;
        if (!existingNumber && superQiNumber && !/\.\.\.|123456/i.test(superQiNumber)) {
          await Setting.create({ key: 'superqi_number', lang: 'global', value: superQiNumber });
        }
        const rate = Number(legacy.rate);
        if (!existingRate && Number.isFinite(rate) && rate > 0) {
          await Setting.create({ key: 'iqd_rate', lang: 'global', value: String(rate) });
        }
      }
    }
  } catch {}
}

async function populateMissingFingerprintsOnly() {
  // Persistence guard: upgrades must never delete or rewrite inventory rows.
  // We only fill a missing fingerprint when the existing encrypted payload can
  // be read and validated. Duplicate/invalid cleanup is an explicit admin job,
  // not something startup is allowed to do.
  const rows = await Code.findAll({
    where: {
      [Op.or]: [
        { fingerprint: null },
        { fingerprint: '' }
      ]
    },
    order: [['id', 'ASC']]
  });

  for (const row of rows) {
    const product = await Merchant.findByPk(row.merchantId, { attributes: ['id', 'type'] });
    if (!product || product.type === 'service') continue;
    let payload;
    try { payload = decryptPayload(row.value, row.extra); }
    catch { continue; }
    if (!inventoryPayloadIsValid(product.type, payload)) continue;
    const fingerprint = inventoryFingerprint(product.type, payload);
    if (!fingerprint) continue;
    row.fingerprint = fingerprint;
    await row.save({ fields: ['fingerprint'] });
  }
}

async function normalizeProductDescriptionsNonDestructive() {
  // Only convert truly legacy string descriptions into JSON. If description is
  // already an object, do not rebuild it: it may contain Premium Emoji IDs,
  // service workflow settings, rich-text metadata, or future fields unknown to
  // this version.
  const products = await Merchant.findAll({ attributes: ['id', 'description'] });
  for (const product of products) {
    const current = product.description;
    if (current && typeof current === 'object' && !Array.isArray(current)) continue;
    if (current == null || current === '') continue;
    const normalized = parseDescription(current);
    product.set('description', normalized);
    product.changed('description', true);
    await product.save({ fields: ['description'] });
  }
}

async function runMigrationOnce(key, task) {
  const markerKey = `migration_done:${String(key)}`;
  const existing = await Setting.findOne({ where: { key: markerKey, lang: 'global' } });
  if (existing) return false;
  await task();
  await Setting.findOrCreate({
    where: { key: markerKey, lang: 'global' },
    defaults: { value: new Date().toISOString() }
  });
  return true;
}

async function initializeDatabase() {
  console.log(`[DB] role=${config.network.role} schema=${config.databaseSchema}`);
  await sequelize.authenticate();
  await sequelize.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(config.databaseSchema)}`);
  await sequelize.sync({ alter: false });

  await addColumnIfMissing('Users', 'blocked', { type: DataTypes.BOOLEAN, defaultValue: false });
  await addColumnIfMissing('Users', 'username', { type: DataTypes.STRING, allowNull: true });
  await addColumnIfMissing('Users', 'firstName', { type: DataTypes.STRING, allowNull: true });
  await addColumnIfMissing('Users', 'paymentCurrency', { type: DataTypes.STRING(3), allowNull: true });
  await addColumnIfMissing('Users', 'referredBy', { type: DataTypes.BIGINT, allowNull: true });
  await addColumnIfMissing('Users', 'referralProcessed', { type: DataTypes.BOOLEAN, defaultValue: false });
  await addColumnIfMissing('Users', 'referralOfferShown', { type: DataTypes.BOOLEAN, defaultValue: false });

  await addColumnIfMissing('Merchants', 'image', { type: DataTypes.TEXT, allowNull: true });
  await addColumnIfMissing('Merchants', 'isActive', { type: DataTypes.BOOLEAN, defaultValue: true });
  await addColumnIfMissing('Merchants', 'sharedLimit', { type: DataTypes.INTEGER, defaultValue: 1 });
  await addColumnIfMissing('Merchants', 'deliveryMode', { type: DataTypes.STRING, defaultValue: 'instant' });
  await addColumnIfMissing('Merchants', 'sortOrder', { type: DataTypes.INTEGER, defaultValue: 0 });
  await addColumnIfMissing('Merchants', 'ownerNote', { type: DataTypes.TEXT, allowNull: true });
  await addColumnIfMissing('Merchants', 'networkProductId', { type: DataTypes.STRING(64), allowNull: true });
  await addColumnIfMissing('Merchants', 'networkManaged', { type: DataTypes.BOOLEAN, defaultValue: false });
  await addColumnIfMissing('Merchants', 'networkOwnerShopId', { type: DataTypes.STRING(80), allowNull: true });
  await addColumnIfMissing('Merchants', 'networkStock', { type: DataTypes.INTEGER, defaultValue: 0 });
  await addColumnIfMissing('Merchants', 'networkBasePriceUsd', { type: DataTypes.DECIMAL(18, 2), allowNull: true });
  await addColumnIfMissing('Merchants', 'localPriceOverrideUsd', { type: DataTypes.DECIMAL(18, 2), allowNull: true });
  await addColumnIfMissing('Merchants', 'visibilityScope', { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'public' });
  await addColumnIfMissing('Merchants', 'localPublicationStatus', { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'published' });
  await addColumnIfMissing('Merchants', 'createdByAdminId', { type: DataTypes.BIGINT, allowNull: true });
  await addColumnIfMissing('Merchants', 'createdByDisplayName', { type: DataTypes.STRING(160), allowNull: true });
  await addColumnIfMissing('Merchants', 'localReviewNotifiedAt', { type: DataTypes.DATE, allowNull: true });

  await addColumnIfMissing('PurchaseOrders', 'walletApplied', { type: DataTypes.DECIMAL(18, 8), defaultValue: 0 });
  await addColumnIfMissing('PurchaseOrders', 'externalAmount', { type: DataTypes.DECIMAL(18, 8), defaultValue: 0 });
  await addColumnIfMissing('PurchaseOrders', 'paymentOrigin', { type: DataTypes.STRING(24), allowNull: true });
  await addColumnIfMissing('PurchaseOrders', 'remoteOrderRef', { type: DataTypes.STRING(96), allowNull: true });
  await addColumnIfMissing('BalanceTransactions', 'paymentOrigin', { type: DataTypes.STRING(24), allowNull: true });
  await addColumnIfMissing('BalanceTransactions', 'networkMethod', { type: DataTypes.STRING(80), allowNull: true });
  await addColumnIfMissing('BalanceTransactions', 'approvedByTelegramId', { type: DataTypes.BIGINT, allowNull: true });
  await addColumnIfMissing('BalanceTransactions', 'approvedByUsername', { type: DataTypes.STRING(64), allowNull: true });
  await addColumnIfMissing('BalanceTransactions', 'approvedByDisplayName', { type: DataTypes.STRING(160), allowNull: true });
  await addColumnIfMissing('BalanceTransactions', 'approvalSource', { type: DataTypes.STRING(48), allowNull: true });
  await addColumnIfMissing('DeliveryRecords', 'inventoryOwnerShopId', { type: DataTypes.STRING(80), allowNull: true });
  await addColumnIfMissing('DeliveryRecords', 'unitPriceUsd', { type: DataTypes.DECIMAL(18, 2), allowNull: true });
  await addColumnIfMissing('DeliveryRecords', 'supplierValueUsd', { type: DataTypes.DECIMAL(18, 2), allowNull: true });

  await addColumnIfMissing('PaymentMethods', 'settlementCurrency', { type: DataTypes.STRING(8), defaultValue: 'USD' });
  await addColumnIfMissing('PaymentMethods', 'ratePerUsd', { type: DataTypes.DECIMAL(18, 4), allowNull: true });
  await addColumnIfMissing('PaymentMethods', 'minimumTransferAmount', { type: DataTypes.DECIMAL(18, 4), allowNull: false, defaultValue: 0.01 });
  await addColumnIfMissing('PaymentMethods', 'visibilityScope', { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'public' });
  await addColumnIfMissing('PaymentMethods', 'createdByAdminId', { type: DataTypes.BIGINT, allowNull: true });
  await addColumnIfMissing('PaymentMethods', 'createdByDisplayName', { type: DataTypes.STRING(160), allowNull: true });
  await addColumnIfMissing('NetworkSharedPaymentMethods', 'minimumTransferAmount', { type: DataTypes.DECIMAL(18, 4), allowNull: false, defaultValue: 0.01 });

  await addColumnIfMissing('NetworkPaymentIntents', 'customerName', { type: DataTypes.STRING(160), allowNull: true });
  await addColumnIfMissing('NetworkPaymentIntents', 'activity', { type: DataTypes.STRING(20), defaultValue: 'payment' });

  await addColumnIfMissing('NetworkClients', 'binancePayId', { type: DataTypes.STRING(120), allowNull: true });
  await addColumnIfMissing('NetworkClients', 'binanceReady', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });

  await addColumnIfMissing('NetworkDebtPayments', 'binancePayId', { type: DataTypes.STRING(120), allowNull: true });
  await addColumnIfMissing('NetworkDebtPayments', 'submittedOrderId', { type: DataTypes.STRING(128), allowNull: true });
  await addColumnIfMissing('NetworkDebtPayments', 'transactionId', { type: DataTypes.STRING(128), allowNull: true });
  await addColumnIfMissing('NetworkDebtPayments', 'verificationError', { type: DataTypes.STRING(80), allowNull: true });
  await addColumnIfMissing('NetworkDebtPayments', 'debtorNotified', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
  await addColumnIfMissing('NetworkDebtPayments', 'verifiedAt', { type: DataTypes.DATE, allowNull: true });

  await addColumnIfMissing('NetworkSharedPaymentRequests', 'approvedByTelegramId', { type: DataTypes.BIGINT, allowNull: true });
  await addColumnIfMissing('NetworkSharedPaymentRequests', 'approvedByUsername', { type: DataTypes.STRING(64), allowNull: true });
  await addColumnIfMissing('NetworkSharedPaymentRequests', 'approvedByDisplayName', { type: DataTypes.STRING(160), allowNull: true });

  // v12.7.1: durable accounting state for provider-funded virtual-number sales.
  // Existing rows are preserved; only new columns are added. Client shops owe
  // Master the real provider cost, while refunds reverse that debt exactly once.
  await addColumnIfMissing('VirtualNumberOrders', 'providerCostAccounted', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
  await addColumnIfMissing('VirtualNumberOrders', 'providerCostReversed', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
  await addColumnIfMissing('VirtualNumberOrders', 'accountingLastError', { type: DataTypes.STRING(255), allowNull: true });
  await addColumnIfMissing('VirtualNumberOrders', 'providerOwnerShopId', { type: DataTypes.STRING(80), allowNull: true });
  await addColumnIfMissing('VirtualNumberOrders', 'providerSource', { type: DataTypes.STRING(24), allowNull: true });

  // Historical service products were explicitly local-only before v13. Keep
  // that promise on upgrade; only newly-created services can be chosen public.
  await Merchant.update({ visibilityScope: 'private', localPublicationStatus: 'published' }, {
    where: { type: 'service', networkManaged: false, ownerNote: 'Local service' }
  }).catch(error => console.error('Legacy local service scope migration:', error.message));

  await addColumnIfMissing('Codes', 'maxUses', { type: DataTypes.INTEGER, defaultValue: 1 });
  await addColumnIfMissing('Codes', 'usedCount', { type: DataTypes.INTEGER, defaultValue: 0 });
  await addColumnIfMissing('Codes', 'buyers', { type: DataTypes.JSONB, defaultValue: [] });
  await addColumnIfMissing('Codes', 'fingerprint', { type: DataTypes.STRING(64), allowNull: true });
  await addColumnIfMissing('Codes', 'stockOwnerShopId', { type: DataTypes.STRING(80), allowNull: true, defaultValue: 'master' });
  await addColumnIfMissing('Codes', 'contributionPriceUsd', { type: DataTypes.DECIMAL(18, 2), allowNull: true });

  // v12: keep wallet accounting in high-precision USD internally so a local
  // amount such as 1,000 IQD can round-trip correctly when users switch
  // currencies. Customer-facing screens still show only the selected currency.
  await sequelize.query(`
    ALTER TABLE ${tableSql('Users')}
    ALTER COLUMN "balance" TYPE NUMERIC(18,8)
    USING "balance"::numeric
  `).catch(error => {
    console.error('Wallet precision migration (Users.balance):', error.message);
  });

  await sequelize.query(`
    ALTER TABLE ${tableSql('BalanceTransactions')}
    ALTER COLUMN "amount" TYPE NUMERIC(18,8)
    USING "amount"::numeric
  `).catch(error => {
    console.error('Wallet precision migration (BalanceTransactions.amount):', error.message);
  });

  await sequelize.query(`
    ALTER TABLE ${tableSql('PurchaseOrders')}
    ALTER COLUMN "walletApplied" TYPE NUMERIC(18,8)
    USING "walletApplied"::numeric,
    ALTER COLUMN "externalAmount" TYPE NUMERIC(18,8)
    USING "externalAmount"::numeric
  `).catch(error => {
    console.error('Wallet precision migration (PurchaseOrders wallet split):', error.message);
  });

  await sequelize.query(`
    ALTER TABLE ${tableSql('NetworkSharedPaymentRequests')}
    ALTER COLUMN "amountUsd" TYPE NUMERIC(18,8)
    USING "amountUsd"::numeric
  `).catch(error => {
    console.error('Wallet precision migration (NetworkSharedPaymentRequests.amountUsd):', error.message);
  });


  // Compatibility pass for the user's previous single-file bot. This runs
  // before encryption / validation so old products and stock stay sellable.
  await runMigrationOnce('legacy_single_file_v1', migrateLegacySingleFileBotData);

  // Create indexes only after legacy databases receive the new columns.
  // Defining the fingerprint index inside the Sequelize model made sync() try
  // to create the index before the column existed, crashing Railway startup.
  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS "codes_merchant_id_fingerprint"
    ON ${tableSql('Codes')} ("merchantId", "fingerprint")
  `);
  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS "codes_merchant_id_is_used"
    ON ${tableSql('Codes')} ("merchantId", "isUsed")
  `);
  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS "codes_owner_product_available"
    ON ${tableSql('Codes')} ("merchantId", "stockOwnerShopId", "isUsed")
  `);
  await sequelize.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "merchants_network_product_id_unique"
    ON ${tableSql('Merchants')} ("networkProductId")
    WHERE "networkProductId" IS NOT NULL
  `);
  await sequelize.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "purchase_orders_remote_order_ref_unique"
    ON ${tableSql('PurchaseOrders')} ("remoteOrderRef")
    WHERE "remoteOrderRef" IS NOT NULL
  `);


  // v12.0.1: replace Sequelize's overlong auto-generated network payment
  // index names with short, stable names. PostgreSQL truncates identifiers
  // to 63 bytes; Sequelize then fails to recognize the truncated name on the
  // next boot and crashes with 42P07 (relation already exists).
  await sequelize.query(`
    DROP INDEX IF EXISTS ${quoteIdent(config.databaseSchema)}."network_shared_payment_methods_owner_shop_id_owner_local_method"
  `);
  await sequelize.query(`
    DROP INDEX IF EXISTS ${quoteIdent(config.databaseSchema)}."network_shared_payment_requests_source_shop_id_source_handled_s"
  `);

  await sequelize.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "nspm_owner_local_uq"
    ON ${tableSql('NetworkSharedPaymentMethods')} ("ownerShopId", "ownerLocalMethodId")
  `);
  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS "nspm_currency_active_idx"
    ON ${tableSql('NetworkSharedPaymentMethods')} ("settlementCurrency", "isActive")
  `);

  await sequelize.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "nspr_source_ref_uq"
    ON ${tableSql('NetworkSharedPaymentRequests')} ("sourceShopId", "sourceRef")
  `);
  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS "nspr_owner_status_idx"
    ON ${tableSql('NetworkSharedPaymentRequests')} ("paymentOwnerShopId", "status")
  `);
  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS "nspr_source_handled_idx"
    ON ${tableSql('NetworkSharedPaymentRequests')} ("sourceShopId", "sourceHandled", "status")
  `);
  // These indexes depend on columns introduced by migrations above. Keep them
  // out of the Sequelize model definition so legacy databases do not crash
  // during sequelize.sync() before addColumnIfMissing() has run.
  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS "network_debt_payments_creditor_shop_id_status_submitted_order_id"
    ON ${tableSql('NetworkDebtPayments')} ("creditorShopId", "status", "submittedOrderId")
  `);
  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS "network_debt_payments_transaction_id"
    ON ${tableSql('NetworkDebtPayments')} ("transactionId")
  `);
  await sequelize.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "network_debt_payments_transaction_id_unique"
    ON ${tableSql('NetworkDebtPayments')} ("transactionId")
    WHERE "transactionId" IS NOT NULL
  `);

  // v12.4: hot-path indexes used by customer order history, payment review,
  // product lists and background workers. These are non-destructive and safe
  // to keep across upgrades.
  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS "po_user_status_created_idx"
    ON ${tableSql('PurchaseOrders')} ("userId", "status", "createdAt" DESC)
  `);
  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS "po_status_created_idx"
    ON ${tableSql('PurchaseOrders')} ("status", "createdAt" DESC)
  `);
  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS "bt_user_status_idx"
    ON ${tableSql('BalanceTransactions')} ("userId", "status")
  `);
  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS "bt_method_status_idx"
    ON ${tableSql('BalanceTransactions')} ("paymentMethodId", "status")
  `);
  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS "merchant_active_sort_idx"
    ON ${tableSql('Merchants')} ("isActive", "sortOrder", "id")
  `);
  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS "pm_active_sort_idx"
    ON ${tableSql('PaymentMethods')} ("isActive", "sortOrder", "id")
  `);
  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS "vno_accounting_backlog_idx"
    ON ${tableSql('VirtualNumberOrders')} ("providerCostAccounted", "providerCostReversed", "refundApplied", "createdAt")
  `);

  await sequelize.query(`
    UPDATE ${tableSql('Codes')}
    SET "maxUses" = COALESCE("maxUses", 1),
        "usedCount" = CASE WHEN "isUsed" = TRUE AND COALESCE("usedCount",0)=0 THEN 1 ELSE COALESCE("usedCount",0) END,
        "buyers" = COALESCE("buyers", '[]'::jsonb)
  `).catch(() => {});

  await sequelize.query(`
    UPDATE ${tableSql('Codes')}
    SET "stockOwnerShopId" = COALESCE(NULLIF("stockOwnerShopId", ''), 'master')
  `).catch(() => {});
  await sequelize.query(`
    UPDATE ${tableSql('Codes')} c
    SET "contributionPriceUsd" = COALESCE(c."contributionPriceUsd", m."price")
    FROM ${tableSql('Merchants')} m
    WHERE c."merchantId" = m."id"
  `).catch(() => {});

  // v12.6: remember the catalog floor separately from a shop-local markup.
  // Existing rows start with their current synchronized price as the floor;
  // future catalog syncs keep localPriceOverrideUsd only when it is >= floor.
  await sequelize.query(`
    UPDATE ${tableSql('Merchants')}
    SET "networkBasePriceUsd" = COALESCE("networkBasePriceUsd", "price")
    WHERE COALESCE("networkManaged", FALSE) = TRUE
  `).catch(() => {});

  while (true) {
    const rows = await Code.findAll({
      where: { value: { [Op.notLike]: 'enc:v1:%' } },
      attributes: ['id', 'value', 'extra'],
      raw: true,
      limit: 500,
      order: [['id', 'ASC']]
    });
    if (!rows.length) break;
    const updates = rows.map(row => ({
      id: row.id,
      value: isEncrypted(row.value) ? row.value : encryptPayload(legacyPayload(row.value, row.extra)),
      extra: null
    }));
    await Code.bulkCreate(updates, { updateOnDuplicate: ['value', 'extra'] });
  }

  await populateMissingFingerprintsOnly();
  await normalizeProductDescriptionsNonDestructive();

  const withoutNetworkId = await Merchant.findAll({ where: { networkProductId: null } });
  for (const product of withoutNetworkId) {
    product.networkProductId = crypto.randomUUID();
    product.networkOwnerShopId = product.networkOwnerShopId || 'master';
    await product.save({ fields: ['networkProductId', 'networkOwnerShopId'] });
  }
  await Merchant.update({ networkOwnerShopId: 'master' }, { where: { networkManaged: false, networkOwnerShopId: null } }).catch(() => {});
}

async function getSetting(key, fallback = '') {
  const cacheKey = String(key);
  const cached = cacheRead(settingCache, cacheKey, SETTING_CACHE_TTL_MS);
  if (cached) return cached.exists ? cached.value : fallback;
  const row = await Setting.findOne({ where: { key: cacheKey, lang: 'global' }, attributes: ['value'] });
  if (!row) {
    settingCache.set(cacheKey, { exists: false, value: '', at: Date.now() });
    return fallback;
  }
  const value = String(row.value ?? '');
  settingCache.set(cacheKey, { exists: true, value, at: Date.now() });
  return value;
}

async function setSetting(key, value) {
  const cacheKey = String(key);
  const stringValue = String(value);
  const [row] = await Setting.findOrCreate({
    where: { key: cacheKey, lang: 'global' },
    defaults: { value: stringValue }
  });
  if (row.value !== stringValue) await row.update({ value: stringValue });
  settingCache.set(cacheKey, { exists: true, value: stringValue, at: Date.now() });
  return row;
}

async function getIqdRate() {
  const raw = await getSetting('iqd_rate', String(config.iqdRate));
  const rate = Number(raw);
  return Number.isFinite(rate) && rate > 0 ? rate : config.iqdRate;
}

async function getSuperQiNumber() {
  return getSetting('superqi_number', config.superQiNumber);
}


async function getSecureSetting(key, fallback = '') {
  const cacheKey = String(key);
  const cached = cacheRead(secureSettingCache, cacheKey, SECURE_SETTING_CACHE_TTL_MS);
  if (cached) return cached.exists ? cached.value : fallback;
  const row = await SecureSetting.findByPk(cacheKey, { attributes: ['value'] });
  if (!row) {
    secureSettingCache.set(cacheKey, { exists: false, value: '', at: Date.now() });
    return fallback;
  }
  try {
    const payload = decryptPayload(row.value, null);
    const value = String(payload?.value ?? fallback);
    secureSettingCache.set(cacheKey, { exists: true, value, at: Date.now() });
    return value;
  } catch {
    return fallback;
  }
}

async function setSecureSetting(key, value) {
  const cacheKey = String(key);
  const stringValue = String(value || '');
  const encrypted = encryptPayload({ value: stringValue });
  const [row] = await SecureSetting.findOrCreate({ where: { key: cacheKey }, defaults: { value: encrypted } });
  if (row.value !== encrypted) await row.update({ value: encrypted });
  secureSettingCache.set(cacheKey, { exists: true, value: stringValue, at: Date.now() });
  return row;
}

module.exports = {
  sequelize,
  Op,
  User,
  Setting,
  PaymentMethod,
  Merchant,
  Code,
  PurchaseOrder,
  BalanceTransaction,
  BinanceTransfer,
  VirtualNumberOrder,
  SupportTicket,
  Referral,
  GiftClaim,
  SecureSetting,
  DeliveryRecord,
  NetworkClient,
  NetworkSettlement,
  NetworkLedgerEntry,
  NetworkDebtBalance,
  NetworkDebtPayment,
  NetworkPaymentIntent,
  NetworkNotificationEvent,
  NetworkSharedPaymentMethod,
  NetworkSharedPaymentRequest,
  initializeDatabase,
  getSetting,
  setSetting,
  getIqdRate,
  getSuperQiNumber,
  getSecureSetting,
  setSecureSetting
};
