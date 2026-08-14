const { Sequelize, DataTypes, Op } = require('sequelize');
const crypto = require('crypto');
const config = require('./config');
const { encryptPayload, decryptPayload, isEncrypted, legacyPayload } = require('./cryptoStore');
const { inventoryFingerprint, inventoryPayloadIsValid, parseDescription } = require('./utils');

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
  balance: { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  state: { type: DataTypes.TEXT, allowNull: true },
  verified: { type: DataTypes.BOOLEAN, defaultValue: false },
  blocked: { type: DataTypes.BOOLEAN, defaultValue: false },
  username: { type: DataTypes.STRING, allowNull: true },
  firstName: { type: DataTypes.STRING, allowNull: true },
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
  ratePerUsd: { type: DataTypes.DECIMAL(18, 4), allowNull: true }
});

const Merchant = sequelize.define('Merchant', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  nameEn: { type: DataTypes.STRING, allowNull: false },
  nameAr: { type: DataTypes.STRING, allowNull: false },
  price: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
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
  networkStock: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
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
  walletApplied: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
  externalAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
  paymentOrigin: { type: DataTypes.STRING(24), allowNull: true },
  remoteOrderRef: { type: DataTypes.STRING(96), allowNull: true, unique: true }
});

const BalanceTransaction = sequelize.define('BalanceTransaction', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  userId: { type: DataTypes.BIGINT, allowNull: false },
  amount: { type: DataTypes.DECIMAL(18, 2), allowNull: false },
  type: { type: DataTypes.STRING, allowNull: false },
  paymentMethodId: { type: DataTypes.INTEGER, allowNull: true },
  txid: { type: DataTypes.STRING, allowNull: true },
  imageFileId: { type: DataTypes.STRING, allowNull: true },
  caption: { type: DataTypes.TEXT, allowNull: true },
  status: { type: DataTypes.STRING, defaultValue: 'pending' },
  adminMessageId: { type: DataTypes.BIGINT, allowNull: true },
  lastReminderAt: { type: DataTypes.DATE, allowNull: true },
  paymentOrigin: { type: DataTypes.STRING(24), allowNull: true },
  networkMethod: { type: DataTypes.STRING(80), allowNull: true }
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

async function populateFingerprintsAndRemoveUnusedDuplicates() {
  const products = await Merchant.findAll({ attributes: ['id', 'type'], raw: true });
  for (const product of products) {
    const rows = await Code.findAll({
      where: { merchantId: product.id },
      order: [['id', 'ASC']]
    });
    const availableSeen = new Set();

    for (const row of rows) {
      let payload;
      try { payload = decryptPayload(row.value, row.extra); }
      catch { continue; }

      const usedCount = Number(row.usedCount || 0);
      const maxUses = Number(row.maxUses || 1);
      const isAvailable = !row.isUsed && usedCount < maxUses;
      const isAvailableUnused = isAvailable && usedCount === 0;

      if (product.type === 'shared') {
        const cleaned = {
          email: String(payload.email || '').trim(),
          password: String(payload.password || '').trim(),
          twoFactor: '',
          code: '',
          extra: ''
        };
        if (JSON.stringify(cleaned) !== JSON.stringify({
          email: String(payload.email || '').trim(),
          password: String(payload.password || '').trim(),
          twoFactor: String(payload.twoFactor || ''),
          code: String(payload.code || ''),
          extra: String(payload.extra || '')
        })) {
          payload = cleaned;
          row.value = encryptPayload(payload);
          row.extra = null;
        }
      }

      if (!inventoryPayloadIsValid(product.type, payload)) {
        if (isAvailableUnused) {
          await row.destroy();
        } else {
          // Preserve purchase history but stop any invalid row from being sold again.
          row.isUsed = true;
          row.maxUses = Math.max(1, Number(row.usedCount || 1));
          await row.save({ fields: ['isUsed', 'maxUses'] });
        }
        continue;
      }

      const fingerprint = inventoryFingerprint(product.type, payload);

      if (isAvailable && availableSeen.has(fingerprint)) {
        if (usedCount === 0) {
          await row.destroy();
        } else {
          // Keep historical buyers but exhaust the duplicate so it cannot be sold again.
          row.isUsed = true;
          row.maxUses = Math.max(1, usedCount);
          await row.save({ fields: ['isUsed', 'maxUses'] });
        }
        continue;
      }

      if (isAvailable) availableSeen.add(fingerprint);
      if (row.fingerprint !== fingerprint || row.changed('value') || row.changed('extra')) {
        row.fingerprint = fingerprint;
        await row.save({ fields: ['fingerprint', 'value', 'extra'] });
      }
    }
  }
}

async function normalizeProductDescriptions() {
  const products = await Merchant.findAll();
  for (const product of products) {
    const normalized = parseDescription(product.description);
    const canonical = {
      ar: normalized.ar,
      en: normalized.en,
      warrantyAr: normalized.warrantyAr,
      warrantyEn: normalized.warrantyEn,
      sold: normalized.sold
    };
    if (JSON.stringify(product.description || {}) !== JSON.stringify(canonical)) {
      product.set('description', canonical);
      product.changed('description', true);
      await product.save({ fields: ['description'] });
    }
  }
}

async function initializeDatabase() {
  console.log(`[DB] role=${config.network.role} schema=${config.databaseSchema}`);
  await sequelize.authenticate();
  await sequelize.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(config.databaseSchema)}`);
  await sequelize.sync({ alter: false });

  await addColumnIfMissing('Users', 'blocked', { type: DataTypes.BOOLEAN, defaultValue: false });
  await addColumnIfMissing('Users', 'username', { type: DataTypes.STRING, allowNull: true });
  await addColumnIfMissing('Users', 'firstName', { type: DataTypes.STRING, allowNull: true });
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

  await addColumnIfMissing('PurchaseOrders', 'walletApplied', { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 });
  await addColumnIfMissing('PurchaseOrders', 'externalAmount', { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 });
  await addColumnIfMissing('PurchaseOrders', 'paymentOrigin', { type: DataTypes.STRING(24), allowNull: true });
  await addColumnIfMissing('PurchaseOrders', 'remoteOrderRef', { type: DataTypes.STRING(96), allowNull: true });
  await addColumnIfMissing('BalanceTransactions', 'paymentOrigin', { type: DataTypes.STRING(24), allowNull: true });
  await addColumnIfMissing('BalanceTransactions', 'networkMethod', { type: DataTypes.STRING(80), allowNull: true });
  await addColumnIfMissing('DeliveryRecords', 'inventoryOwnerShopId', { type: DataTypes.STRING(80), allowNull: true });
  await addColumnIfMissing('DeliveryRecords', 'unitPriceUsd', { type: DataTypes.DECIMAL(18, 2), allowNull: true });
  await addColumnIfMissing('DeliveryRecords', 'supplierValueUsd', { type: DataTypes.DECIMAL(18, 2), allowNull: true });

  await addColumnIfMissing('PaymentMethods', 'settlementCurrency', { type: DataTypes.STRING(8), defaultValue: 'USD' });
  await addColumnIfMissing('PaymentMethods', 'ratePerUsd', { type: DataTypes.DECIMAL(18, 4), allowNull: true });

  await addColumnIfMissing('NetworkPaymentIntents', 'customerName', { type: DataTypes.STRING(160), allowNull: true });
  await addColumnIfMissing('NetworkPaymentIntents', 'activity', { type: DataTypes.STRING(20), defaultValue: 'payment' });

  await addColumnIfMissing('Codes', 'maxUses', { type: DataTypes.INTEGER, defaultValue: 1 });
  await addColumnIfMissing('Codes', 'usedCount', { type: DataTypes.INTEGER, defaultValue: 0 });
  await addColumnIfMissing('Codes', 'buyers', { type: DataTypes.JSONB, defaultValue: [] });
  await addColumnIfMissing('Codes', 'fingerprint', { type: DataTypes.STRING(64), allowNull: true });
  await addColumnIfMissing('Codes', 'stockOwnerShopId', { type: DataTypes.STRING(80), allowNull: true, defaultValue: 'master' });
  await addColumnIfMissing('Codes', 'contributionPriceUsd', { type: DataTypes.DECIMAL(18, 2), allowNull: true });

  // Compatibility pass for the user's previous single-file bot. This runs
  // before encryption / validation so old products and stock stay sellable.
  await migrateLegacySingleFileBotData();

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

  await populateFingerprintsAndRemoveUnusedDuplicates();
  await normalizeProductDescriptions();

  const withoutNetworkId = await Merchant.findAll({ where: { networkProductId: null } });
  for (const product of withoutNetworkId) {
    product.networkProductId = crypto.randomUUID();
    product.networkOwnerShopId = product.networkOwnerShopId || 'master';
    await product.save({ fields: ['networkProductId', 'networkOwnerShopId'] });
  }
  await Merchant.update({ networkOwnerShopId: 'master' }, { where: { networkManaged: false, networkOwnerShopId: null } }).catch(() => {});
}

async function getSetting(key, fallback = '') {
  const row = await Setting.findOne({ where: { key, lang: 'global' } });
  return row ? row.value : fallback;
}

async function setSetting(key, value) {
  const [row] = await Setting.findOrCreate({
    where: { key, lang: 'global' },
    defaults: { value: String(value) }
  });
  if (row.value !== String(value)) await row.update({ value: String(value) });
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
  const row = await SecureSetting.findByPk(key);
  if (!row) return fallback;
  try {
    const payload = decryptPayload(row.value, null);
    return String(payload?.value ?? fallback);
  } catch { return fallback; }
}

async function setSecureSetting(key, value) {
  const encrypted = encryptPayload({ value: String(value || '') });
  const [row] = await SecureSetting.findOrCreate({ where: { key }, defaults: { value: encrypted } });
  if (row.value !== encrypted) await row.update({ value: encrypted });
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
  initializeDatabase,
  getSetting,
  setSetting,
  getIqdRate,
  getSuperQiNumber,
  getSecureSetting,
  setSecureSetting
};
