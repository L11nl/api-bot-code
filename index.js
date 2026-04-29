require('dotenv').config();

const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const FormData = require('form-data');
const { Sequelize, DataTypes, Op } = require('sequelize');
const crypto = require('crypto');
const {
  generateDepositNote,
  normalizeOrderId: normalizeBinanceTransferOrderId,
  looksLikeOrderId: looksLikeBinanceTransferOrderId,
  verifyBinanceTransfer
} = require('./binancePay');

const TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID, 10);
const DATABASE_URL = process.env.DATABASE_URL;
const BINANCE_API_KEY = process.env.BINANCE_API_KEY || '';
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET || process.env.BINANCE_SECRET_KEY || '';
const BINANCE_PAY_ID = process.env.BINANCE_PAY_ID || process.env.BINANCE_ID || '842505320';
const BINANCE_PAY_API_KEY = process.env.BINANCE_PAY_API_KEY || '';
const BINANCE_PAY_SECRET_KEY = process.env.BINANCE_PAY_SECRET_KEY || '';
const BINANCE_PAY_BASE_URL = String(process.env.BINANCE_PAY_BASE_URL || 'https://bpay.binanceapi.com').replace(/\/$/, '');
const PUBLIC_WEBHOOK_URL = String(process.env.PUBLIC_WEBHOOK_URL || '').replace(/\/$/, '');
const BINANCE_PAY_WEBHOOK_PATH = String(process.env.BINANCE_PAY_WEBHOOK_PATH || '/webhooks/binance-pay').trim() || '/webhooks/binance-pay';
const BINANCE_PAY_RETURN_URL = String(process.env.BINANCE_PAY_RETURN_URL || '').trim();
const BINANCE_PAY_CANCEL_URL = String(process.env.BINANCE_PAY_CANCEL_URL || '').trim();
const BINANCE_PAY_ORDER_EXPIRE_MS = Math.max(5 * 60 * 1000, parseInt(process.env.BINANCE_PAY_ORDER_EXPIRE_MS || String(30 * 60 * 1000), 10) || (30 * 60 * 1000));
const BINANCE_PAY_PENDING_POLL_INTERVAL_MS = Math.max(30 * 1000, parseInt(process.env.BINANCE_PAY_PENDING_POLL_INTERVAL_MS || String(2 * 60 * 1000), 10) || (2 * 60 * 1000));
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_BASE_URL = String(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');

if (!TOKEN || Number.isNaN(ADMIN_ID) || !DATABASE_URL) {
  console.error('❌ Missing required environment variables');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
let BOT_USERNAME_CACHE = process.env.PUBLIC_BOT_USERNAME || '';
const app = express();
app.use(express.json({
  verify: (req, res, buf) => {
    if (buf && buf.length) {
      req.rawBody = buf.toString('utf8');
    }
  }
}));

const sequelize = new Sequelize(DATABASE_URL, {
  dialect: 'postgres',
  logging: false,
  dialectOptions: {
    ssl: { require: true, rejectUnauthorized: false }
  },
  pool: { max: 10, min: 0, acquire: 30000, idle: 10000 }
});

const User = sequelize.define('User', {
  id: { type: DataTypes.BIGINT, primaryKey: true },
  lang: { type: DataTypes.STRING(2), defaultValue: 'en' },
  balance: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0.00 },
  state: { type: DataTypes.TEXT, allowNull: true },
  referralCode: { type: DataTypes.STRING, unique: true, allowNull: true },
  referredBy: { type: DataTypes.BIGINT, allowNull: true },
  referralPoints: { type: DataTypes.INTEGER, defaultValue: 0 },
  freeChatgptReceived: { type: DataTypes.BOOLEAN, defaultValue: false },
  lastFreeCodeClaimAt: { type: DataTypes.DATE, allowNull: true },
  forceFreeCodeButton: { type: DataTypes.BOOLEAN, defaultValue: false },
  freeCodeRenewalVersionClaimed: { type: DataTypes.INTEGER, defaultValue: 0 },
  creatorDiscountPercent: { type: DataTypes.INTEGER, defaultValue: 0 },
  adminGrantedPoints: { type: DataTypes.INTEGER, defaultValue: 0 },
  referralMilestoneGrantedPoints: { type: DataTypes.INTEGER, defaultValue: 0 },
  referralStockClaimedCodes: { type: DataTypes.INTEGER, defaultValue: 0 },
  totalPurchases: { type: DataTypes.INTEGER, defaultValue: 0 },
  verified: { type: DataTypes.BOOLEAN, defaultValue: false },
  referralRewarded: { type: DataTypes.BOOLEAN, defaultValue: false }
});

const Setting = sequelize.define('Setting', {
  key: { type: DataTypes.STRING, allowNull: false },
  lang: { type: DataTypes.STRING(10), allowNull: false },
  value: { type: DataTypes.TEXT, allowNull: false }
}, {
  indexes: [{ unique: true, fields: ['key', 'lang'] }]
});

const Merchant = sequelize.define('Merchant', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  nameEn: { type: DataTypes.STRING, allowNull: false },
  nameAr: { type: DataTypes.STRING, allowNull: false },
  price: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
  category: { type: DataTypes.STRING, defaultValue: 'general' },
  type: { type: DataTypes.STRING, defaultValue: 'single' },
  description: { type: DataTypes.JSONB, allowNull: true }
});

const DigitalSection = sequelize.define('DigitalSection', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  nameEn: { type: DataTypes.STRING, allowNull: false },
  nameAr: { type: DataTypes.STRING, allowNull: false },
  sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true }
});

const PaymentMethod = sequelize.define('PaymentMethod', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  nameEn: { type: DataTypes.STRING, allowNull: false },
  nameAr: { type: DataTypes.STRING, allowNull: false },
  details: { type: DataTypes.TEXT, allowNull: false },
  type: { type: DataTypes.STRING, defaultValue: 'manual' },
  config: { type: DataTypes.JSONB, defaultValue: {} },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  minDeposit: { type: DataTypes.FLOAT, defaultValue: 1.0 },
  maxDeposit: { type: DataTypes.FLOAT, defaultValue: 10000.0 }
});

const Code = sequelize.define('Code', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  value: { type: DataTypes.TEXT, allowNull: false },
  extra: { type: DataTypes.TEXT, allowNull: true },
  merchantId: { type: DataTypes.INTEGER, references: { model: Merchant, key: 'id' } },
  isUsed: { type: DataTypes.BOOLEAN, defaultValue: false },
  usedBy: { type: DataTypes.BIGINT, allowNull: true },
  soldAt: { type: DataTypes.DATE, allowNull: true },
  expiresAt: { type: DataTypes.DATE, allowNull: true }
});

const BalanceTransaction = sequelize.define('BalanceTransaction', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  userId: { type: DataTypes.BIGINT, allowNull: false },
  amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  type: { type: DataTypes.STRING, allowNull: false },
  paymentMethodId: { type: DataTypes.INTEGER, references: { model: PaymentMethod, key: 'id' }, allowNull: true },
  txid: { type: DataTypes.STRING, allowNull: true },
  imageFileId: { type: DataTypes.STRING, allowNull: true },
  caption: { type: DataTypes.TEXT, allowNull: true },
  status: { type: DataTypes.STRING, defaultValue: 'pending' },
  adminMessageId: { type: DataTypes.BIGINT, allowNull: true },
  lastReminderAt: { type: DataTypes.DATE, allowNull: true },
  createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
});

const BinancePayPayment = sequelize.define('BinancePayPayment', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  userId: { type: DataTypes.BIGINT, allowNull: false },
  balanceTransactionId: { type: DataTypes.INTEGER, allowNull: true, references: { model: BalanceTransaction, key: 'id' } },
  merchantTradeNo: { type: DataTypes.STRING(32), allowNull: false, unique: true },
  prepayId: { type: DataTypes.STRING, allowNull: true },
  amount: { type: DataTypes.DECIMAL(18, 8), allowNull: false },
  currency: { type: DataTypes.STRING(16), allowNull: false },
  status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'CREATED' },
  bizStatus: { type: DataTypes.STRING, allowNull: true },
  binanceTransactionId: { type: DataTypes.STRING, allowNull: true },
  passThroughInfo: { type: DataTypes.TEXT, allowNull: true },
  checkoutUrl: { type: DataTypes.TEXT, allowNull: true },
  deeplink: { type: DataTypes.TEXT, allowNull: true },
  universalUrl: { type: DataTypes.TEXT, allowNull: true },
  qrcodeLink: { type: DataTypes.TEXT, allowNull: true },
  qrContent: { type: DataTypes.TEXT, allowNull: true },
  orderPayload: { type: DataTypes.JSONB, allowNull: true },
  webhookPayload: { type: DataTypes.JSONB, allowNull: true },
  queryPayload: { type: DataTypes.JSONB, allowNull: true },
  creditedAt: { type: DataTypes.DATE, allowNull: true },
  lastQueriedAt: { type: DataTypes.DATE, allowNull: true },
  expireTime: { type: DataTypes.DATE, allowNull: true },
  meta: { type: DataTypes.JSONB, defaultValue: {} }
}, {
  indexes: [
    { unique: true, fields: ['merchantTradeNo'] },
    { fields: ['prepayId'] },
    { fields: ['status'] },
    { fields: ['userId'] }
  ]
});

const BotService = sequelize.define('BotService', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  token: { type: DataTypes.STRING, unique: true, allowNull: false },
  name: { type: DataTypes.STRING, allowNull: false },
  allowedActions: { type: DataTypes.JSONB, defaultValue: [] },
  ownerId: { type: DataTypes.BIGINT, allowNull: true },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true }
});

const BotStat = sequelize.define('BotStat', {
  botId: { type: DataTypes.INTEGER, references: { model: BotService, key: 'id' } },
  action: { type: DataTypes.STRING },
  count: { type: DataTypes.INTEGER, defaultValue: 0 },
  lastUsed: { type: DataTypes.DATE }
});

const DiscountCode = sequelize.define('DiscountCode', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  code: { type: DataTypes.STRING, unique: true, allowNull: false },
  discountPercent: { type: DataTypes.INTEGER, defaultValue: 0 },
  validUntil: { type: DataTypes.DATE, allowNull: true },
  maxUses: { type: DataTypes.INTEGER, defaultValue: 1 },
  usedCount: { type: DataTypes.INTEGER, defaultValue: 0 },
  createdBy: { type: DataTypes.BIGINT, allowNull: false }
});

const ReferralReward = sequelize.define('ReferralReward', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  referrerId: { type: DataTypes.BIGINT, allowNull: false },
  referredId: { type: DataTypes.BIGINT, allowNull: false },
  amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  status: { type: DataTypes.STRING, defaultValue: 'pending' }
});

const RedeemService = sequelize.define('RedeemService', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  nameEn: { type: DataTypes.STRING, allowNull: false },
  nameAr: { type: DataTypes.STRING, allowNull: false },
  merchantDictId: { type: DataTypes.STRING, allowNull: false },
  platformId: { type: DataTypes.STRING, defaultValue: '1' }
});

const DepositConfig = sequelize.define('DepositConfig', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  currency: { type: DataTypes.STRING, allowNull: false, unique: true },
  rate: { type: DataTypes.FLOAT, defaultValue: 1500 },
  walletAddress: { type: DataTypes.STRING, allowNull: false },
  instructions: { type: DataTypes.TEXT, allowNull: false },
  displayNameEn: { type: DataTypes.STRING, allowNull: true },
  displayNameAr: { type: DataTypes.STRING, allowNull: true },
  templateEn: { type: DataTypes.TEXT, allowNull: true },
  templateAr: { type: DataTypes.TEXT, allowNull: true },
  methods: { type: DataTypes.JSONB, defaultValue: [] },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true }
});

const ChannelConfig = sequelize.define('ChannelConfig', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  enabled: { type: DataTypes.BOOLEAN, defaultValue: false },
  link: { type: DataTypes.STRING, allowNull: true },
  messageText: { type: DataTypes.TEXT, allowNull: true },
  chatId: { type: DataTypes.STRING, allowNull: true },
  username: { type: DataTypes.STRING, allowNull: true },
  title: { type: DataTypes.STRING, allowNull: true }
});

const Captcha = sequelize.define('Captcha', {
  userId: { type: DataTypes.BIGINT, primaryKey: true },
  challenge: { type: DataTypes.STRING, allowNull: false },
  answer: { type: DataTypes.INTEGER, allowNull: false },
  expiresAt: { type: DataTypes.DATE, allowNull: false }
});

const PrivateChannelCodePostCache = sequelize.define('PrivateChannelCodePostCache', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  channelChatId: { type: DataTypes.STRING, allowNull: false },
  messageId: { type: DataTypes.BIGINT, allowNull: false },
  content: { type: DataTypes.TEXT, allowNull: true },
  isCaption: { type: DataTypes.BOOLEAN, defaultValue: false },
  extractedCodes: { type: DataTypes.JSONB, defaultValue: [] },
  importedAt: { type: DataTypes.DATE, allowNull: true },
  importedCount: { type: DataTypes.INTEGER, defaultValue: 0 }
}, {
  indexes: [{ unique: true, fields: ['channelChatId', 'messageId'] }]
});

Merchant.hasMany(Code, { foreignKey: 'merchantId' });
Code.belongsTo(Merchant);
BalanceTransaction.belongsTo(User, { foreignKey: 'userId' });
BalanceTransaction.belongsTo(PaymentMethod);
User.hasMany(BinancePayPayment, { foreignKey: 'userId' });
BinancePayPayment.belongsTo(User, { foreignKey: 'userId' });
BinancePayPayment.belongsTo(BalanceTransaction, { foreignKey: 'balanceTransactionId' });
BotService.hasMany(BotStat, { foreignKey: 'botId' });
BotStat.belongsTo(BotService);
User.hasMany(ReferralReward, { as: 'Referrer', foreignKey: 'referrerId' });
User.hasMany(ReferralReward, { as: 'Referred', foreignKey: 'referredId' });
DiscountCode.belongsTo(User, { as: 'creator', foreignKey: 'createdBy' });

const DEFAULT_TEXTS = {
  en: {
    start: '🌍 Choose language',
    menu: '✨ Main Menu\nChoose the service you want from the buttons below:',
    redeem: '🔄 Redeem Code',
    buy: '🛒 Buy Codes',
    myBalance: '💰 My Balance',
    myBalanceButton: '💰 My Balance ({balance} USD)',
    balanceInfoText: '💰 Your current balance: {balance} USD',
    currentBalanceLine: '💰 Current balance: {balance} USD',
    remainingBalanceLine: '💰 Remaining balance: {balance} USD',
    totalPaidLine: '💳 Total paid: {total} USD',
    quantityPurchasedLine: '🧮 Quantity: {qty}',
    continueShopping: '🛒 Continue Shopping',
    enterDepositAmount: '💰 Send the amount in USD:',
    deposit: '💳 Deposit',
    support: '📞 Support',
    chooseMerchant: '👋 Choose merchant:',
    processing: '⏳ Processing...',
    enterQty: '✍️ Enter quantity:',
    noCodes: '❌ Stock is currently empty.',
    back: '🔙 Back',
    cancel: 'Cancel',
    adminPanel: '🔧 Admin Panel',
    addMerchant: '➕ Add Merchant',
    listMerchants: '📋 List Merchants',
    addCodes: '📦 Add Codes',
    stats: '📊 Stats',
    setPrice: '💰 Set Price',
    setChatgptPrice: '🤖 Set ChatGPT Price',
    enterChatgptPrice: 'Send new ChatGPT code price (USD):',
    chatgptPriceUpdated: '✅ ChatGPT code price updated to {price} USD!',
    paymentMethods: '💳 Payment Methods',
    manageBots: '🤖 Manage Bots',
    manageMenuButtons: '🎛️ Manage Menu Buttons',
    moveUp: '⬆️ Move Up',
    moveDown: '⬇️ Move Down',
    buttonOrderUpdated: '✅ Button order updated!',
    manageChannel: '📢 Manage Required Channel',
    manageDepositSettings: '💱 Manage Deposit Settings',
    manageDepositOptions: '🧩 Manage Deposit Options',
    depositOptionIQD: 'Iraqi Dinar button',
    depositOptionUSD: 'USD button',
    depositOptionBinanceAuto: 'Binance Auto button',
    depositOptionsUpdated: '✅ Deposit options visibility updated!',
    referralSettings: '👥 Referral Settings',
    manageRedeemServices: '🔄 Manage Redeem Services',
    manageDiscountCodes: '🎟️ Manage Discount Codes',
    sendAnnouncement: '📢 Send Announcement',
    editCodeDeliveryMessage: '✏️ Edit Code Delivery Message',
    chooseCodeMessageLanguage: 'Choose the language of the code message:',
    codeMessageArabic: '🇮🇶 Arabic Code Message',
    codeMessageEnglish: '🇺🇸 English Code Message',
    enterAnnouncementText: 'Send the announcement/notice text to broadcast to bot users:',
    announcementSent: '✅ Announcement sent. Delivered: {sent} | Failed: {failed}',
    enterCodeDeliveryMessage: 'Send the text you want to appear before the code. Send /empty to clear it.',
    codeDeliveryMessageUpdated: '✅ Code delivery message updated.',
    enterBotToken: 'Send bot token:',
    botAdded: '✅ Bot added!',
    botRemoved: '❌ Bot removed!',
    chooseCurrency: '💱 Choose currency for deposit:',
    currency_usd_name: 'Binance',
    currency_iqd_name: 'Iraqi Dinar',
    depositInstructionsUSD: '💰 Send {amount} USDT to one of the following payment methods:\n\n{methods_block}\n\nThen send a screenshot of the payment with any message.\n\n{instructions}',
    depositInstructionsIQD: '💰 Send {amountIQD} Iraqi Dinar (≈ {amountUSD} USD at rate {rate} IQD/USD) to one of the following payment methods:\n\n{methods_block}\n\nThen send a screenshot of the payment with any message.\n\n{instructions}',
    depositProofReceived: '✅ Deposit proof received! Admin will review it shortly.',
    depositSuccess: '✅ Deposit successful! New balance: {balance} USD',
    depositRejected: '❌ Your deposit was rejected.',
    depositNotification: '💳 New deposit request from user {userId}\nAmount: {amount} {currency}\nPayment Method: {method}\n\nMessage: {message}',
    approve: '✅ Approve',
    reject: '❌ Reject',
    success: '✅ Purchase successful! Here are your codes:',
    error: '❌ Error',
    askMerchantNameEn: 'Send merchant name in English:',
    askMerchantNameAr: 'Send merchant name in Arabic:',
    askMerchantPrice: 'Send price in USD:',
    askMerchantType: 'Select merchant type:',
    typeSingle: 'Single (one code per line)',
    typeBulk: 'Bulk (email/password pairs)',
    askDescription: 'Send description (text, photo, video, or /skip):',
    merchantCreated: '✅ Merchant created! ID: {id}',
    enterPrice: 'Enter new price (USD):',
    priceUpdated: '💰 Price updated!',
    enterCodes: 'Send codes separated by new lines or spaces:',
    codesAdded: '✅ Codes added successfully!',
    merchantList: '📋 Merchants list:\n',
    askCategory: 'Send category name:',
    categoryUpdated: 'Category updated!',
    setReferralPercent: 'Set referral reward percentage:',
    referralPercentUpdated: 'Referral reward percentage updated to {percent}%.',
    showDescription: '📖 View Description',
    redeemServiceNameEn: 'Send service name in English:',
    redeemServiceNameAr: 'Send service name in Arabic:',
    redeemServiceMerchantId: 'Send merchant dict ID (from NodeCard):',
    redeemServicePlatformId: 'Send platform ID (default 1):',
    redeemServiceAdded: '✅ Redeem service added!',
    chooseRedeemService: 'Choose the service to redeem:',
    sendCodeToRedeem: 'Send the code to redeem:',
    redeemSuccess: '✅ Card redeemed successfully!\n\n💳 Card Details:\n{details}',
    redeemFailed: '❌ Failed to redeem card: {reason}',
    listRedeemServices: '📋 List Redeem Services',
    addRedeemService: '➕ Add Redeem Service',
    deleteRedeemService: '🗑️ Delete Redeem Service',
    listDiscountCodes: '📋 List Discount Codes',
    addDiscountCode: '➕ Add Discount Code',
    deleteDiscountCode: '🗑️ Delete Discount Code',
    enterDiscountCodeValue: 'Enter discount code (e.g., SAVE10):',
    enterDiscountPercent: 'Enter discount percentage (e.g., 10):',
    enterDiscountValidUntil: 'Enter expiry date (YYYY-MM-DD) or /skip:',
    enterDiscountMaxUses: 'Enter max uses (e.g., 100):',
    discountCodeAdded: '✅ Discount code added!',
    discountCodeDeleted: '❌ Discount code deleted!',
    noDiscountCodes: 'No discount codes found.',
    enterDiscountCode: 'Send your discount code:',
    discountApplied: '✅ Discount code applied! You get {percent}% off.',
    discountInvalid: '❌ Invalid or expired discount code.',
    myPurchases: '📜 My Purchases',
    noPurchases: 'No purchases yet.',
    purchaseHistory: '🛍️ Purchase History:\n{history}',
    confirmDelete: '⚠️ Are you sure you want to delete this merchant?',
    yes: '✅ Yes',
    no: '❌ No',
    merchantDeleted: 'Merchant deleted successfully.',
    referral: '🤝 Invite Friends',
    redeemPoints: '🎁 Redeem Points',
    getFreeCode: '🎁 Get your free code',
    freeCodeMenu: '🎁 Get your free code',
    referralInfo: 'Share your referral link with friends and earn 1 point per successful referral!\n\nYour referral link:\n<code>{link}</code>\n\nYour points: {points}\nYou can get {redeemableCodes} code(s) with your points.\n🎁 Every {requiredPoints} points = 1 free ChatGPT code!',
    referralEarned: '🎉 You earned 1 referral point! Total points: {points}',
    notEnoughPoints: '❌ You do not have enough points. You have {points} points, and each code needs {requiredPoints} points.',
    redeemPointsAskAmount: 'Send the number of ChatGPT codes you want to redeem using your points. Each code costs {requiredPoints} points.',
    redeemPointsInvalidAmount: '❌ Invalid number. Send a valid positive number of codes.',
    pointsRedeemed: '✅ Points redeemed successfully! Here are your ChatGPT GO code(s):\n\n{code}',
    setRedeemPoints: '🎁 Set Redeem Points',
    enterRedeemPoints: 'Enter required points for a free ChatGPT code:',
    redeemPointsUpdated: '✅ Redeem points updated to {points}.',
    grantPoints: '🎁 Grant Points',
    enterGrantPointsUserId: 'Send the Telegram user ID of the user:',
    enterGrantPointsAmount: 'Send the number of points to grant:',
    grantPointsUserNotFound: '❌ User not found.',
    grantPointsDone: '✅ Added {points} points to user {userId}. New total: {total}',
    pointsGrantedNotification: '🎁 You received {points} referral points from admin. Your total points: {total}',
    setFreeCodeDays: '⏳ Set Free Code Cooldown',
    enterFreeCodeDays: 'Send the number of days before the free-code button appears again:',
    freeCodeDaysUpdated: '✅ Free-code cooldown updated to {days} day(s).',
    currentRedeemPoints: 'Current required points: {points}',
    currentReferralPercent: 'Current referral reward percentage: {percent}%',
    currentFreeCodeDays: 'Free-code cooldown: {days} day(s)',
    manageFreeCodeAccess: '🎁 Manage Free Code Access',
    renewFreeCode: '🔄 Renew Code',
    renewFreeCodeDone: '✅ Free code renewed for all users for 24 hours. Each user can claim once until you press it again.',
    enableFreeCodeForUser: '✅ Enable for User',
    disableFreeCodeForUser: '⛔ Disable for User',
    enterFreeCodeAccessUserId: 'Send the Telegram user ID:',
    freeCodeAccessEnabledDone: '✅ Free-code feature enabled for user {userId}. It will stay visible for them.',
    freeCodeAccessDisabledDone: '✅ Free-code feature disabled for user {userId}.',
    grantCreatorDiscount: '🎟️ Grant Creator Discount',
    editReferralMilestones: '🎯 Edit Referral Milestone Rewards',
    enterReferralMilestones: 'Send milestone rewards in this format:\n15:5,40:5,80:10,150:30',
    referralMilestonesUpdated: '✅ Referral milestone rewards updated.',
    currentReferralMilestones: 'Current milestone rewards: {milestones}',
    referralEligibleUsers: '🎁 Eligible Referral Users',
    deductReferralPoints: '➖ Deduct Points',
    referralStockSettings: '📦 Referral ChatGPT Stock',
    referralStockClaim: '🎁 Referral Prize',
    noReferralEligibleUsers: 'No users currently have referral history with redeemable referral compensation.',
    referralEligibleUsersTitle: 'Eligible referral users:',
    referralEligibleUserLine: 'Name: {name}\nUsername: {username}\nID: {id}\nTotal points: {points}\nGranted by admin: {adminGranted}\nReferral count: {referrals}\nMilestone rewards: {milestoneRewards}\nClaimed codes before: {claimedCodes}\nAvailable now: {redeemableCodes}',
    referralClaimAdminNotice: '🎁 Referral compensation claimed\nBy: {name}\nUsername: {username}\nID: {id}\nClaimed now: {claimedNow}\nClaimed before: {claimedBefore}\nTotal claimed after this: {claimedAfter}\nStill eligible now: {eligibleNow}\nCurrent referral points: {points}\nGranted by admin: {adminGranted}\nReferral count: {referrals}\nMilestone rewards: {milestoneRewards}',
    referralStockAccessDenied: '❌ This stock is only for users who have previous successful referrals.',
    enterDeductPointsUserId: 'Send the Telegram user ID whose points you want to deduct:',
    enterDeductPointsAmount: 'Send the number of points to deduct:',
    deductPointsDone: '✅ Points deducted. User {userId} now has {points} points.',
    deductPointsUserNotFound: '❌ User not found.',
    toggleReferrals: '🔁 Stop/Start Referrals',
    referralsEnabledStatus: '✅ Referrals counting is enabled',
    referralsDisabledStatus: '⛔ Referrals counting is stopped',
    referralsTurnedOn: '✅ Referrals enabled.',
    referralsTurnedOff: '⛔ Referrals stopped.',
    addReferralStockCodes: '➕ Add Referral Stock Codes',
    viewReferralStockCount: '📦 View Referral Stock',
    searchReferralStockDuplicates: '🔎 Search Duplicate Codes',
    importReferralStockFromPrivateChannel: '📥 Add Codes From Private Channel',
    privateReferralChannelButton: '📦 Codes Channel',
    referralCodesChannelButton: '📦 Codes Channel',
    searchDeleteReferralStockCodes: '🔍 Search Codes And Delete',
    enterSearchDeleteReferralStockCodes: 'Send the codes you want to search for and delete from referral stock.',
    referralStockSearchDeleteResult: '✅ Deleted: {deleted}\n❌ Not found: {missing}\n\n{details}',
    referralStockImportNoPosts: '❌ No cached posts were found from the codes channel yet. Add the bot as admin in that channel, then publish new posts there or forward old channel posts to the bot once. Telegram bots do not receive old channel history automatically.',
    referralStockImportNoCodes: '❌ No valid ChatGPT code links were found in cached code-channel posts. Publish a new post in the configured channel, or forward old channel posts to the bot once, then try again.',
    referralStockImportedFromPrivateChannel: '✅ Imported {added} code(s) from the private channel.\n♻️ Skipped duplicates: {duplicates}\n📚 Cached posts scanned: {posts}',
    referralStockDuplicatesNone: '✅ No duplicate codes were found in referral stock.',
    referralStockDuplicatesFound: '🔎 Duplicate codes found: {count}\n\n{codes}',
    deleteReferralStockDuplicates: '🗑️ Delete Duplicate Codes',
    referralStockDuplicatesDeleted: '✅ Deleted {count} duplicate code(s) from referral stock.',
    referralStockCountText: 'Referral ChatGPT stock: {count} code(s).',
    enterReferralStockCodes: 'Send referral ChatGPT stock codes separated by new lines or spaces:',
    referralStockCodesAdded: '✅ Referral stock codes added.\n📊 Added count: {count}',
    referralStockNotEnough: '❌ Not enough referral ChatGPT stock for this request.',
    referralStockNoCodesAvailable: '❌ No referral ChatGPT stock available right now.',
    referralClaimAskCount: 'Send the number of referral-stock codes you want to claim. Available by your points: {maxCodes}.',
    botAllowedUsers: '👤 Allowed Users While Bot Stopped',
    balanceManagement: '💰 Balance Management',
    usersWithBalance: '👥 Users With Balance',
    addBalanceAdmin: '➕ Add Balance',
    deductBalanceAdmin: '➖ Deduct Balance',
    enterBalanceUserId: 'Send the Telegram user ID:',
    enterBalanceAmount: 'Send the balance amount in USD:',
    usersWithBalanceTitle: 'Users with balance:',
    noUsersWithBalance: 'No users currently have a balance greater than 0.',
    balanceUserLine: 'Name: {name}\nUsername: {username}\nID: {id}\nBalance: {balance} USD',
    balanceUserNotFound: '❌ User not found.',
    balanceAmountInvalid: '❌ Invalid balance amount.',
    balanceAddedDone: '✅ Added {amount} USD to user {userId}. New balance: {balance} USD',
    balanceDeductedDone: '✅ Deducted {amount} USD from user {userId}. New balance: {balance} USD',
    balanceReceivedNotification: '💰 {amount} USD has been added to your balance. New balance: {balance} USD',
    balanceDeductedNotification: '💰 {amount} USD has been deducted from your balance. New balance: {balance} USD',
    stockClaimAdminShort: '📦 Stock withdrawal\nUser: {name}\nUsername: {username}\nID: {id}\nCount: {count}',
    balancePurchaseAdminNotice: '💳 Purchase by balance\nUser: {name}\nUsername: {username}\nID: {id}\nMerchant: {merchant}\nQuantity: {qty}\nTotal: {total} USD',
    enterAllowedUsers: 'Send allowed Telegram user IDs separated by commas, spaces, or new lines. Send /empty to clear.',
    allowedUsersUpdated: '✅ Allowed users updated.',
    currentAllowedUsers: 'Current allowed IDs: {ids}',
    quantityDiscountSettings: '💸 Quantity Discount Settings',
    setBulkDiscountThreshold: '📦 Set Discount Quantity',
    setBulkDiscountPrice: '💵 Set Price After Discount',
    enterBulkDiscountThreshold: 'Send the quantity at which the discount starts:',
    enterBulkDiscountPrice: 'Send the new per-code price after discount (USD):',
    currentBulkDiscountThreshold: 'Discount starts from quantity: {threshold}',
    currentBulkDiscountPrice: 'Price after discount: {price} USD per code',
    quantityDiscountSettingsText: '💸 Quantity Discount Settings\n\n{thresholdLine}\n{priceLine}',
    bulkDiscountSettingsUpdated: '✅ Quantity discount settings updated.',
    botControl: '🤖 Bot Control',
    botStatusLine: 'Current bot status: {status}',
    botEnabledStatus: '✅ Running',
    botDisabledStatus: '⛔ Stopped',
    enableBot: '✅ Turn Bot On',
    disableBot: '⛔ Turn Bot Off',
    botTurnedOn: '✅ Bot enabled for users.',
    botTurnedOff: '⛔ Bot stopped for users.',
    botPausedMessage: '⛔ The bot is temporarily stopped. Please try again later.',
    depositReminderPending: '⏰ Pending deposit reminder\nUser ID: {userId}\nAmount: {amount} {currency}',
    grantPointsDoneDetailed: '✅ Points granted successfully.\n\nUser ID: {userId}\nUsername: {username}\nName: {name}\nGranted now: {points}\nTotal points: {total}\nAdmin-granted points: {adminGranted}\nReferral count: {referrals}\nReferral rewards points: {milestoneRewards}',
    enterCreatorDiscountUserId: 'Send the Telegram user ID of the creator:',
    enterCreatorDiscountPercent: 'Send the discount percent for referral redemption (0-100):',
    creatorDiscountUserNotFound: '❌ User not found.',
    creatorDiscountUpdated: '✅ Creator discount for user {userId} updated to {percent}%. Effective required points: {requiredPoints}.',
    creatorDiscountGrantedNotification: '🎟️ You received a creator discount of {percent}%. Your required points per free code are now {requiredPoints}.',
    currentCreatorDiscount: 'Your creator discount: {percent}%',
    manageReferralSettingsText: '👥 Referral Settings\n\n{percentLine}\n{pointsLine}\n{freeCodeDaysLine}\n{milestonesLine}\n{referralsStatusLine}',
    chatgptCode: '🤖 ChatGPT Code',
    askEmail: 'Please enter your email address:',
    freeCodeSuccess: '🎉 Here is your free ChatGPT GO code:\n\n{code}',
    alreadyGotFree: 'You have already received your free code. You can purchase more codes.',
    askQuantity: 'How many ChatGPT codes would you like to buy? Send the number only.\n\n🔥 Quantity discount: if you buy 20 codes or more, the price becomes 1 USD per code.',
    enterEmailForPurchase: 'Enter your email to receive the code:',
    purchaseSuccess: '✅ Purchase successful! Here are your ChatGPT GO code(s):\n\n{code}',
    insufficientBalance: '❌ Insufficient balance. Your balance: {balance} USD. Price per code: {price} USD\n\nYou need: {needed} USD to get this quantity of codes.',
    depositNow: '💳 Deposit Balance',
    bulkDiscountInfo: '🔥 Quantity discount: if you buy {threshold} codes or more, the price becomes {price} USD per code.',
    referralMilestoneBonus: '🎁 Referral milestone reached! You received {bonus} bonus points. Total points: {points}',
    invalidQuantity: '❌ Invalid quantity. Please send a valid positive number. Maximum allowed is 70 codes per request.',
    mustJoinChannel: '🔒 Please join our channel first\n\n{message}\n\nThen press the check button.',
    joinChannel: '📢 Join Channel',
    checkSubscription: '🔄 Check Subscription',
    captchaChallenge: '🤖 Human verification\n\nPlease solve: {challenge} = ?',
    captchaSuccess: '✅ Verification successful! Welcome!',
    captchaWrong: '❌ Wrong answer. Try again.',
    setChannelLink: '🔗 Set Channel Link',
    setChannelMessage: '📝 Set Channel Message',
    currentChannelLink: 'Current channel link: {link}',
    currentChannelMessage: 'Current channel message: {message}',
    enterNewChannelLink: 'Send new channel link (e.g., https://t.me/yourchannel or @yourchannel or -100...):',
    enterNewChannelMessage: 'Send new channel message (text):',
    verificationStatus: 'Verification status: {status}',
    verificationEnabled: '✅ Enabled',
    verificationDisabled: '❌ Disabled',
    enableVerification: '✅ Enable mandatory verification',
    disableVerification: '⛔ Disable mandatory verification',
    verificationToggledOn: '✅ Mandatory verification enabled.',
    verificationToggledOff: '⛔ Mandatory verification disabled.',
    verificationNeedsChannel: '❌ Set and resolve the channel first before enabling mandatory verification.',
    channelHelpText: 'You can send @channelusername, -100 chat id, or forward a post from the channel to save it accurately.',
    channelLinkSet: '✅ Channel link updated!',
    channelMessageSet: '✅ Channel message updated!',
    buttonVisibilityUpdated: '✅ Button visibility updated!',
    setIQDRate: '💰 Set IQD Exchange Rate',
    setUSDTWallet: '🏦 Set USDT Wallet Address',
    setIQDWallet: '🏦 Set IQD SuperKey',
    editCurrencyNames: '✏️ Edit Currency Names',
    editDepositInstructions: '📝 Edit Deposit Instructions',
    editUSDName: 'Edit USDT name',
    editIQDName: 'Edit IQD name',
    editUSDInstructions: 'Edit USDT instructions',
    editIQDInstructions: 'Edit IQD instructions',
    enterNewRate: 'Send new exchange rate (1 USD = ? IQD):',
    enterWalletAddress: 'Send wallet address / SuperKey:',
    enterInstructions: 'Send deposit instructions (text):',
    enterNewCurrencyName: 'Send new currency name:',
    manageIQDMethods: 'Manage Iraqi Dinar Methods',
    manageUSDMethods: 'Manage Binance Methods',
    addDepositMethod: 'Add Payment Method',
    deleteDepositMethod: 'Delete Payment Method',
    editDepositTemplates: 'Edit Deposit Messages',
    editIQDTemplateAr: 'Edit IQD Arabic message',
    editIQDTemplateEn: 'Edit IQD English message',
    editUSDTemplateAr: 'Edit Binance Arabic message',
    editUSDTemplateEn: 'Edit Binance English message',
    editIQDNameAr: 'Edit IQD Arabic name',
    editIQDNameEn: 'Edit IQD English name',
    editUSDNameAr: 'Edit Binance Arabic name',
    editUSDNameEn: 'Edit Binance English name',
    enterMethodNameAr: 'Send payment method name in Arabic:',
    enterMethodNameEn: 'Send payment method name in English:',
    enterMethodValue: 'Send payment number / address / account:',
    methodAdded: '✅ Payment method added!',
    methodDeleted: '✅ Payment method deleted!',
    noMethods: 'No payment methods added yet.',
    enterNewTemplate: 'Send the full message template. Use placeholders like {amount}, {amountUSD}, {amountIQD}, {rate}, {methods_block}, {instructions}.',
    currencyNameUpdated: '✅ Currency name updated!',
    walletSet: '✅ Wallet address updated!',
    instructionsSet: '✅ Instructions updated!',
    rateSet: '✅ Exchange rate updated!',
    totalCodes: '📦 Total codes in stock: {count}',
    totalSales: '💰 Total sales: {amount} USD',
    pendingDeposits: '⏳ Pending deposits: {count}',
    sendReply: 'Send your message:',
    supportMessageSent: '📨 Your message has been sent to support. You will receive a reply soon.',
    supportNotification: '📩 New support message\n\nUsername: {username}\nName: {name}\nUser ID: {userId}\n\nMessage: {message}',
    replyToSupport: 'Reply to this user:',
    replyMessage: 'Your reply from support:',
    confirm: '✅ Confirm',
    buyNow: '🛒 Buy',
    digitalSubscriptions: '🧩 Add Digital Subscriptions',
    digitalSubscriptionsMenu: '🧩 Digital Subscriptions',
    addDigitalSectionToMainMenu: '➕ Add section to: 👋 Main menu',
    askDigitalSectionNameEn: 'Send the section name in English:',
    askDigitalSectionNameAr: 'Send the section name in Arabic:',
    digitalSectionCreated: '✅ The section was added to the main menu successfully!',
    digitalSubscriptionsChooseSection: 'Choose the digital section you want to manage:',
    digitalSectionManageTitle: '🧩 Manage section: {name}',
    addDigitalProductInSection: '➕ Add item inside {name}',
    askDigitalProductNameEn: 'Send the item name in English:',
    askDigitalProductNameAr: 'Send the item name in Arabic:',
    askDigitalProductPrice: 'Send the item price in USD:',
    askDigitalProductDescription: 'Send the item details (text, photo, video, or /skip):',
    digitalProductCreated: '✅ The digital item was created successfully! ID: {id}',
    digitalProductManageText: '🧾 {name}\nPrice: {price} USD\nRemaining stock: {stock}\nType: {type}',
    addDigitalProductStock: '📦 Add stock/accounts',
    digitalStockInputPrompt: 'Send the stock/accounts now.\n\nFor account items, send the email on one line and the password on the next line for each account.',
    digitalSectionEmpty: 'No subscriptions are available in this section yet.',
    digitalSectionChooseProduct: 'Choose the subscription you want:',
    digitalProductListButton: '{name} - {price} USD ({stock})',
    digitalProductDetailsText: '🧩 {name}\n\nRemaining stock: {stock}\nPrice: {price} USD\n\nDetails:\n{details}',
    attachedDetailsNote: 'See the attached media for the full details.',
    productQuantityPrompt: 'How many subscriptions would you like to buy? Send the number only.',
    remainingStockLine: 'Remaining stock: {stock}',
    itemPriceLine: 'Price: {price} USD',
    chatgptStockLine: 'Remaining stock: {stock}',
    chatgptPriceLine: 'Code price: {price} USD',
    chatgptDiscountLine: 'Quantity discount: if you buy 20 codes or more, the price becomes 1 USD per code.',
    chatgptDetailsLine: 'Code details: This code is part of a Mexican promotional offer. Turn on a Mexico VPN, copy the code link, open it in the browser while the VPN is active, then complete the activation.',
    chatgptNoteLine: 'Note: At the moment, no guessed BIN or fake BIN works with this offer.',
    chatgptTermsTitle: 'Terms:',
    chatgptTerms1: '1- The validity period of this code is unknown. If it expires, it is not refundable.',
    chatgptTerms2: '2- The code is not refundable if it works properly and has no issue. It will only be replaced if it does not work.',
    chatgptAgreementLine: 'By pressing Confirm & Buy, you agree to these terms.',
    invalidPrice: '❌ Invalid price.',
    sendValidDescription: 'Please send text, photo, video, or /skip.'
  },
  ar: {
    start: '🌍 اختر اللغة',
    menu: '✨ القائمة الرئيسية\nاختر الخدمة المطلوبة من الأزرار بالأسفل:',
    redeem: '🔄 استرداد الكود',
    buy: '🛒 شراء كودات',
    myBalance: '💰 رصيدي',
    myBalanceButton: '💰 رصيدي ({balance} دولار)',
    balanceInfoText: '💰 رصيدك الحالي: {balance} دولار',
    currentBalanceLine: '💰 رصيدك الحالي: {balance} دولار',
    remainingBalanceLine: '💰 الرصيد المتبقي: {balance} دولار',
    totalPaidLine: '💳 إجمالي المبلغ المدفوع: {total} دولار',
    quantityPurchasedLine: '🧮 الكمية: {qty}',
    continueShopping: '🛒 متابعة الشراء',
    enterDepositAmount: '💰 أرسل مبلغ الشحن بالدولار:',
    deposit: '💳 شحن الرصيد',
    support: '📞 الدعم الفني',
    chooseMerchant: '🛍️ اختر التاجر المطلوب:',
    processing: '⏳ جاري المعالجة...',
    enterQty: '✍️ أرسل الكمية:',
    noCodes: '❌ المخزون فارغ حاليًا.',
    back: '🔙 رجوع',
    cancel: 'الــغـــاء',
    adminPanel: '🔧 لوحة التحكم',
    addMerchant: '➕ إضافة تاجر',
    listMerchants: '📋 قائمة التجار',
    addCodes: '📦 إضافة أكواد',
    stats: '📊 الإحصائيات',
    setPrice: '💰 تعديل السعر',
    setChatgptPrice: '🤖 تعديل سعر كود ChatGPT',
    enterChatgptPrice: 'أرسل سعر كود ChatGPT الجديد بالدولار:',
    chatgptPriceUpdated: '✅ تم تحديث سعر كود ChatGPT إلى {price} دولار!',
    paymentMethods: '💳 طرق الدفع',
    manageBots: '🤖 إدارة البوتات',
    manageMenuButtons: '🎛️ إدارة الأزرار',
    moveUp: '⬆️ رفع',
    moveDown: '⬇️ تنزيل',
    buttonOrderUpdated: '✅ تم تحديث ترتيب الزر!',
    manageChannel: '📢 إدارة القناة المطلوبة',
    manageDepositSettings: '💱 إعدادات الشحن',
    manageDepositOptions: '🧩 إدارة ظهور طرق الدفع',
    depositOptionIQD: 'زر الدينار العراقي',
    depositOptionUSD: 'زر الدولار USD',
    depositOptionBinanceAuto: 'زر Binance Auto',
    depositOptionsUpdated: '✅ تم تحديث ظهور طرق الدفع!',
    referralSettings: '👥 إعدادات الإحالة',
    manageRedeemServices: '🔄 إدارة خدمات الاسترداد',
    manageDiscountCodes: '🎟️ إدارة كودات الخصم',
    sendAnnouncement: '📢 إرسال إعلان',
    editCodeDeliveryMessage: '✏️ تعديل رسالة تسليم الكود',
    chooseCodeMessageLanguage: 'اختر لغة رسالة الكود:',
    codeMessageArabic: '🇮🇶 رسالة الكود بالعربية',
    codeMessageEnglish: '🇺🇸 رسالة الكود بالإنجليزية',
    enterAnnouncementText: 'أرسل نص الإعلان/التنويه الذي تريد نشره لمستخدمي البوت:',
    announcementSent: '✅ تم إرسال الإعلان. نجح: {sent} | فشل: {failed}',
    enterCodeDeliveryMessage: 'أرسل النص الذي تريد ظهوره قبل الكود. أرسل /empty للحذف.',
    codeDeliveryMessageUpdated: '✅ تم تحديث رسالة تسليم الكود.',
    enterBotToken: 'أرسل توكن البوت:',
    botAdded: '✅ تمت إضافة البوت!',
    botRemoved: '❌ تم حذف البوت!',
    chooseCurrency: '💱 اختر العملة للشحن:',
    currency_usd_name: 'بايننس',
    currency_iqd_name: 'دينار عراقي',
    depositInstructionsUSD: '💰 قم بإرسال {amount} USDT إلى إحدى طرق الدفع التالية:\n\n{methods_block}\n\nثم أرسل صورة التحويل مع أي رسالة.\n\n{instructions}',
    depositInstructionsIQD: '💰 قم بإرسال {amountIQD} دينار عراقي (≈ {amountUSD} دولار بسعر صرف {rate} دينار/دولار) إلى إحدى طرق الدفع التالية:\n\n{methods_block}\n\nثم أرسل صورة التحويل مع أي رسالة.\n\n{instructions}',
    depositProofReceived: '✅ تم استلام إثبات الدفع! سيقوم الأدمن بمراجعته قريباً.',
    depositSuccess: '✅ تم الشحن بنجاح! الرصيد الجديد: {balance} دولار',
    depositRejected: '❌ تم رفض عملية الشحن.',
    depositNotification: '💳 طلب شحن جديد من المستخدم {userId}\nالمبلغ: {amount} {currency}\nطريقة الدفع: {method}\n\nالرسالة: {message}',
    approve: '✅ موافقة',
    reject: '❌ رفض',
    success: '✅ تم الشراء بنجاح! إليك الأكواد:',
    error: '❌ خطأ',
    askMerchantNameEn: 'أرسل اسم التاجر بالإنجليزية:',
    askMerchantNameAr: 'أرسل اسم التاجر بالعربية:',
    askMerchantPrice: 'أرسل السعر بالدولار:',
    askMerchantType: 'اختر نوع التاجر:',
    typeSingle: 'فردي (كود واحد في كل سطر)',
    typeBulk: 'جملة (إيميل وباسورد في سطرين)',
    askDescription: 'أرسل شرح توضيحي (نص، صورة، فيديو، أو /skip):',
    merchantCreated: '✅ تم إنشاء التاجر! المعرف: {id}',
    enterPrice: 'أدخل السعر الجديد (دولار):',
    priceUpdated: '💰 تم تحديث السعر!',
    enterCodes: 'أرسل الأكواد مفصولة بسطور جديدة أو مسافات:',
    codesAdded: '✅ تمت إضافة الأكواد بنجاح!',
    merchantList: '📋 قائمة التجار:\n',
    askCategory: 'أرسل اسم التصنيف:',
    categoryUpdated: 'تم تحديث التصنيف!',
    setReferralPercent: 'أدخل نسبة مكافأة الإحالة:',
    referralPercentUpdated: 'تم تحديث نسبة مكافأة الإحالة إلى {percent}%.',
    showDescription: '📖 عرض الشرح',
    redeemServiceNameEn: 'أرسل اسم الخدمة بالإنجليزية:',
    redeemServiceNameAr: 'أرسل اسم الخدمة بالعربية:',
    redeemServiceMerchantId: 'أرسل معرف التاجر في NodeCard:',
    redeemServicePlatformId: 'أرسل معرف المنصة (افتراضي 1):',
    redeemServiceAdded: '✅ تمت إضافة خدمة الاسترداد!',
    chooseRedeemService: 'اختر الخدمة المراد استرداد الكود فيها:',
    sendCodeToRedeem: 'أرسل الكود المراد استرداده:',
    redeemSuccess: '✅ تم استرداد البطاقة بنجاح!\n\n💳 تفاصيل البطاقة:\n{details}',
    redeemFailed: '❌ فشل استرداد البطاقة: {reason}',
    listRedeemServices: '📋 قائمة خدمات الاسترداد',
    addRedeemService: '➕ إضافة خدمة استرداد',
    deleteRedeemService: '🗑️ حذف خدمة استرداد',
    listDiscountCodes: '📋 قائمة كودات الخصم',
    addDiscountCode: '➕ إضافة كود خصم',
    deleteDiscountCode: '🗑️ حذف كود خصم',
    enterDiscountCodeValue: 'أدخل كود الخصم:',
    enterDiscountPercent: 'أدخل نسبة الخصم:',
    enterDiscountValidUntil: 'أدخل تاريخ الانتهاء (YYYY-MM-DD) أو /skip:',
    enterDiscountMaxUses: 'أدخل الحد الأقصى للاستخدام:',
    discountCodeAdded: '✅ تمت إضافة كود الخصم!',
    discountCodeDeleted: '❌ تم حذف كود الخصم!',
    noDiscountCodes: 'لا توجد كودات خصم.',
    enterDiscountCode: 'أرسل كود الخصم الخاص بك:',
    discountApplied: '✅ تم تطبيق كود الخصم! تحصل على خصم {percent}%.',
    discountInvalid: '❌ كود خصم غير صالح أو منتهي الصلاحية.',
    myPurchases: '📜 مشترياتي',
    noPurchases: 'لا توجد مشتريات بعد.',
    purchaseHistory: '🛍️ سجل المشتريات:\n{history}',
    confirmDelete: '⚠️ هل أنت متأكد من حذف هذا التاجر؟',
    yes: '✅ نعم',
    no: '❌ لا',
    merchantDeleted: 'تم حذف التاجر بنجاح.',
    referral: '🤝 دعوة الأصدقاء',
    redeemPoints: '🎁 استبدال النقاط',
    getFreeCode: '🎁 احصل على كودك المجاني',
    freeCodeMenu: '🎁 احصل على كودك المجاني',
    referralInfo: 'شارك رابط الإحالة الخاص بك مع أصدقائك واربح نقطة واحدة لكل إحالة ناجحة!\n\nرابطك:\n<code>{link}</code>\n\nنقاطك: {points}\n🎁 استبدل {requiredPoints} نقاط للحصول على كود ChatGPT مجاناً!',
    referralEarned: '🎉 لقد ربحت نقطة إحالة! إجمالي النقاط: {points}',
    notEnoughPoints: '❌ لا تملك نقاطًا كافية. لديك {points} نقطة، وكل كود يحتاج {requiredPoints} نقاط.',
    redeemPointsAskAmount: 'أرسل عدد كودات ChatGPT التي تريد أخذها بالنقاط. كل كود يحتاج {requiredPoints} نقاط.',
    redeemPointsInvalidAmount: '❌ العدد غير صالح. أرسل عددًا موجبًا صحيحًا من الكودات.',
    pointsRedeemed: '✅ تم استبدال النقاط بنجاح! إليك كودات ChatGPT GO:\n\n{code}',
    setRedeemPoints: '🎁 تعيين نقاط الاستبدال',
    enterRedeemPoints: 'أدخل عدد النقاط المطلوبة للحصول على كود ChatGPT مجاني:',
    redeemPointsUpdated: '✅ تم تحديث نقاط الاستبدال إلى {points}.',
    grantPoints: '🎁 منح نقاط',
    enterGrantPointsUserId: 'أرسل آيدي المستخدم في تيليجرام:',
    enterGrantPointsAmount: 'أرسل عدد النقاط المراد منحها:',
    grantPointsUserNotFound: '❌ المستخدم غير موجود.',
    grantPointsDone: '✅ تم إضافة {points} نقطة للمستخدم {userId}. المجموع الجديد: {total}',
    pointsGrantedNotification: '🎁 لقد حصلت على {points} نقطة إحالة من الأدمن. مجموع نقاطك الآن: {total}',
    setFreeCodeDays: '⏳ تعيين مدة ظهور الكود المجاني',
    enterFreeCodeDays: 'أرسل عدد الأيام التي بعدها يظهر زر الكود المجاني مرة أخرى:',
    freeCodeDaysUpdated: '✅ تم تحديث مدة ظهور الكود المجاني إلى {days} يوم.',
    currentRedeemPoints: 'عدد النقاط المطلوبة حالياً: {points}',
    currentReferralPercent: 'نسبة مكافأة الإحالة الحالية: {percent}%',
    currentFreeCodeDays: 'مدة ظهور الكود المجاني: {days} يوم',
    manageFreeCodeAccess: '🎁 إدارة الكود المجاني',
    renewFreeCode: '🔄 تجديد الكود',
    renewFreeCodeDone: '✅ تم تجديد الكود لجميع المستخدمين لمدة 24 ساعة. كل مستخدم يمكنه أخذ كود مرة واحدة إلى أن تضغط الزر مرة ثانية.',
    enableFreeCodeForUser: '✅ تفعيل لمستخدم',
    disableFreeCodeForUser: '⛔ إخفاء عن مستخدم',
    enterFreeCodeAccessUserId: 'أرسل آيدي المستخدم:',
    freeCodeAccessEnabledDone: '✅ تم تفعيل ميزة الكود المجاني للمستخدم {userId} وستبقى ظاهرة له.',
    freeCodeAccessDisabledDone: '✅ تم إخفاء ميزة الكود المجاني عن المستخدم {userId}.',
    grantCreatorDiscount: '🎟️ منح خصم لصانع محتوى',
    editReferralMilestones: '🎯 تعديل مكافآت الإحالة المرحلية',
    enterReferralMilestones: 'أرسل مكافآت الإحالة بهذا الشكل:\n15:5,40:5,80:10,150:30',
    referralMilestonesUpdated: '✅ تم تحديث مكافآت الإحالة المرحلية.',
    currentReferralMilestones: 'مكافآت الإحالة المرحلية الحالية: {milestones}',
    referralEligibleUsers: '🎁 المؤهلون لهدية الإحالة',
    deductReferralPoints: '➖ خصم نقاط',
    referralStockSettings: '📦 مخزون ChatGPT الإحالات',
    referralStockClaim: '🎁 جائزة الإحالات',
    noReferralEligibleUsers: 'لا يوجد حاليًا مستخدمون لديهم إحالات سابقة ورصيد قابل لتعويض الإحالات.',
    referralEligibleUsersTitle: 'المستخدمون المؤهلون:',
    referralEligibleUserLine: 'الاسم: {name}\nالمعرف: {username}\nالايدي: {id}\nإجمالي النقاط: {points}\nتم منحه من الأدمن: {adminGranted}\nعدد الإحالات: {referrals}\nجوائز الإحالات المرحلية: {milestoneRewards}\nتم سحب كودات سابقًا: {claimedCodes}\nالمتاح الآن: {redeemableCodes}',
    referralClaimAdminNotice: '🎁 تم سحب كود من تعويض الإحالات\nبواسطة: {name}\nالمعرف: {username}\nالايدي: {id}\nسحب الآن: {claimedNow}\nسحب سابقًا: {claimedBefore}\nإجمالي ما سحبه بعد العملية: {claimedAfter}\nالمستحق الآن بعد السحب: {eligibleNow}\nنقاطه الحالية: {points}\nتم منحه من الأدمن: {adminGranted}\nعدد إحالاته: {referrals}\nجوائز الإحالات المرحلية: {milestoneRewards}',
    referralStockAccessDenied: '❌ هذا المخزون مخصص فقط للأشخاص الذين لديهم إحالات ناجحة سابقة.',
    enterDeductPointsUserId: 'أرسل آيدي المستخدم الذي تريد خصم نقاطه:',
    enterDeductPointsAmount: 'أرسل عدد النقاط المراد خصمها:',
    deductPointsDone: '✅ تم خصم النقاط. المستخدم {userId} لديه الآن {points} نقطة.',
    deductPointsUserNotFound: '❌ المستخدم غير موجود.',
    toggleReferrals: '🔁 إيقاف/تشغيل الإحالات',
    referralsEnabledStatus: '✅ احتساب الإحالات مفعل',
    referralsDisabledStatus: '⛔ احتساب الإحالات متوقف',
    referralsTurnedOn: '✅ تم تفعيل الإحالات.',
    referralsTurnedOff: '⛔ تم إيقاف الإحالات.',
    addReferralStockCodes: '➕ إضافة أكواد لمخزون الإحالات',
    viewReferralStockCount: '📦 عرض مخزون الإحالات',
    searchReferralStockDuplicates: '🔎 البحث عن الكودات المكررة',
    importReferralStockFromPrivateChannel: '📥 إضافة كودات من القناة الخاصة',
    privateReferralChannelButton: '📦 قناة الكودات',
    referralCodesChannelButton: '📦 قناة الكودات',
    searchDeleteReferralStockCodes: '🔍 البحث عن الكودات وحذفها',
    enterSearchDeleteReferralStockCodes: 'أرسل الكودات التي تريد البحث عنها وحذفها من مخزون الإحالات.',
    referralStockSearchDeleteResult: '✅ تم حذف: {deleted}\n❌ غير موجود: {missing}\n\n{details}',
    referralStockImportNoPosts: '❌ لا توجد منشورات محفوظة من القناة الخاصة حتى الآن. أضف البوت مشرفًا في القناة ثم انشر أو أعد توجيه المنشورات أولاً.',
    referralStockImportNoCodes: '❌ لم يتم العثور على روابط أكواد ChatGPT صحيحة داخل منشورات قناة الكودات المحفوظة. انشر منشورًا جديدًا في القناة أو أعد توجيه المنشورات القديمة إلى البوت مرة واحدة ثم أعد المحاولة.',
    referralStockImportedFromPrivateChannel: '✅ تمت إضافة {added} كود من القناة الخاصة.\n♻️ تم تجاهل المكرر: {duplicates}\n📚 عدد المنشورات المفحوصة: {posts}',
    referralStockDuplicatesNone: '✅ لا توجد كودات مكررة في مخزون الإحالات.',
    referralStockDuplicatesFound: '🔎 تم العثور على كودات مكررة: {count}\n\n{codes}',
    deleteReferralStockDuplicates: '🗑️ حذف الكودات المكررة',
    referralStockDuplicatesDeleted: '✅ تم حذف {count} كود مكرر من مخزون الإحالات.',
    referralStockCountText: 'مخزون ChatGPT الإحالات: {count} كود.',
    enterReferralStockCodes: 'أرسل أكواد مخزون ChatGPT الإحالات مفصولة بأسطر جديدة أو مسافات:',
    referralStockCodesAdded: '✅ تمت إضافة أكواد مخزون الإحالات.\n📊 عدد الأكواد المضافة: {count}',
    referralStockNotEnough: '❌ لا يوجد عدد كافٍ في مخزون ChatGPT الإحالات لهذا الطلب.',
    referralStockNoCodesAvailable: '❌ لا يوجد حاليًا مخزون ChatGPT إحالات متاح.',
    referralClaimAskCount: 'أرسل عدد كودات مخزون الإحالات التي تريد استلامها. المتاح حسب نقاطك: {maxCodes}.',
    botAllowedUsers: '👤 المستخدمون المسموح لهم أثناء إيقاف البوت',
    balanceManagement: '💰 إدارة الرصيد',
    usersWithBalance: '👥 أصحاب الرصيد',
    addBalanceAdmin: '➕ إضافة رصيد',
    deductBalanceAdmin: '➖ سحب رصيد',
    enterBalanceUserId: 'أرسل آيدي المستخدم:',
    enterBalanceAmount: 'أرسل مبلغ الرصيد بالدولار:',
    usersWithBalanceTitle: 'المستخدمون الذين لديهم رصيد:',
    noUsersWithBalance: 'لا يوجد حاليًا مستخدمون لديهم رصيد أكبر من 0.',
    balanceUserLine: 'الاسم: {name}\nالمعرف: {username}\nالايدي: {id}\nالرصيد: {balance} دولار',
    balanceUserNotFound: '❌ المستخدم غير موجود.',
    balanceAmountInvalid: '❌ مبلغ الرصيد غير صالح.',
    balanceAddedDone: '✅ تمت إضافة {amount} دولار إلى المستخدم {userId}. الرصيد الجديد: {balance} دولار',
    balanceDeductedDone: '✅ تم سحب {amount} دولار من المستخدم {userId}. الرصيد الجديد: {balance} دولار',
    balanceReceivedNotification: '💰 تمت إضافة {amount} دولار إلى رصيدك. الرصيد الجديد: {balance} دولار',
    balanceDeductedNotification: '💰 تم سحب {amount} دولار من رصيدك. الرصيد الجديد: {balance} دولار',
    stockClaimAdminShort: '📦 تم السحب من المخزون\nالاسم: {name}\nالمعرف: {username}\nالايدي: {id}\nالعدد: {count}',
    balancePurchaseAdminNotice: '💳 شراء بواسطة الرصيد\nالاسم: {name}\nالمعرف: {username}\nالايدي: {id}\nالتاجر: {merchant}\nالكمية: {qty}\nالإجمالي: {total} دولار',
    enterAllowedUsers: 'أرسل آيديات تيليجرام المسموح لهم مفصولة بفواصل أو مسافات أو أسطر. أرسل /empty للحذف.',
    allowedUsersUpdated: '✅ تم تحديث المستخدمين المسموح لهم.',
    currentAllowedUsers: 'الآيديات المسموح لها حاليًا: {ids}',
    quantityDiscountSettings: '💸 إعدادات خصم الكمية',
    setBulkDiscountThreshold: '📦 تعيين كمية الخصم',
    setBulkDiscountPrice: '💵 تعيين السعر بعد الخصم',
    enterBulkDiscountThreshold: 'أرسل الكمية التي يبدأ عندها الخصم:',
    enterBulkDiscountPrice: 'أرسل سعر الكود بعد الخصم بالدولار:',
    currentBulkDiscountThreshold: 'يبدأ الخصم من كمية: {threshold}',
    currentBulkDiscountPrice: 'السعر بعد الخصم: {price} دولار لكل كود',
    quantityDiscountSettingsText: '💸 إعدادات خصم الكمية\n\n{thresholdLine}\n{priceLine}',
    bulkDiscountSettingsUpdated: '✅ تم تحديث إعدادات خصم الكمية.',
    botControl: '🤖 التحكم بالبوت',
    botStatusLine: 'حالة البوت الحالية: {status}',
    botEnabledStatus: '✅ يعمل',
    botDisabledStatus: '⛔ متوقف',
    enableBot: '✅ تشغيل البوت',
    disableBot: '⛔ إيقاف البوت',
    botTurnedOn: '✅ تم تشغيل البوت للمستخدمين.',
    botTurnedOff: '⛔ تم إيقاف البوت للمستخدمين.',
    botPausedMessage: '⛔ البوت متوقف مؤقتًا. حاول لاحقًا.',
    depositReminderPending: '⏰ تذكير بوجود طلب شحن معلق\nايدي المستخدم: {userId}\nالمبلغ: {amount} {currency}',
    grantPointsDoneDetailed: '✅ تم منح النقاط بنجاح.\n\nايدي المستخدم: {userId}\nالمعرف: {username}\nالاسم: {name}\nتم منحه الآن: {points}\nإجمالي نقاطه: {total}\nإجمالي ما منحه الأدمن: {adminGranted}\nعدد إحالاته: {referrals}\nنقاط جوائز الإحالات: {milestoneRewards}',
    enterCreatorDiscountUserId: 'أرسل آيدي صانع المحتوى:',
    enterCreatorDiscountPercent: 'أرسل نسبة الخصم لاستبدال النقاط (من 0 إلى 100):',
    creatorDiscountUserNotFound: '❌ المستخدم غير موجود.',
    creatorDiscountUpdated: '✅ تم تحديث خصم المستخدم {userId} إلى {percent}%. عدد النقاط المطلوب الآن لكل كود: {requiredPoints}.',
    creatorDiscountGrantedNotification: '🎟️ تم منحك خصم صانع محتوى بنسبة {percent}%. عدد النقاط المطلوب لكل كود أصبح {requiredPoints}.',
    currentCreatorDiscount: 'خصم صانع المحتوى الخاص بك: {percent}%',
    manageReferralSettingsText: '👥 إعدادات الإحالة\n\n{percentLine}\n{pointsLine}\n{freeCodeDaysLine}\n{milestonesLine}\n{referralsStatusLine}',
    chatgptCode: '🤖 كود ChatGPT',
    askEmail: 'يرجى إدخال بريدك الإلكتروني:',
    freeCodeSuccess: '🎉 إليك كود ChatGPT GO المجاني:\n\n{code}',
    alreadyGotFree: 'لقد حصلت بالفعل على كودك المجاني. يمكنك شراء أكواد إضافية.',
    askQuantity: 'كم عدد أكواد ChatGPT التي تريد شراءها؟ أرسل الرقم فقط.\n\n🔥 خصم على الكمية: إذا اشتريت 20 كودًا أو أكثر يصبح سعر الكود الواحد 1 دولار.',
    enterEmailForPurchase: 'أدخل بريدك الإلكتروني لاستلام الكود:',
    purchaseSuccess: '✅ تم الشراء بنجاح! إليك كودات ChatGPT GO:\n\n{code}',
    insufficientBalance: '❌ رصيد غير كاف. رصيدك: {balance} دولار. سعر الكود: {price} دولار\n\nتحتاج إلى: {needed} دولار كي يمكنك الحصول على هذا العدد من الكودات',
    depositNow: '💳 شحن الرصيد',
    bulkDiscountInfo: '🔥 خصم على الكمية: إذا اشتريت {threshold} كودًا أو أكثر يصبح سعر الكود الواحد {price} دولار.',
    referralMilestoneBonus: '🎁 تم تحقيق مستوى إحالة جديد! حصلت على {bonus} نقاط إضافية. مجموع نقاطك الآن: {points}',
    invalidQuantity: '❌ كمية غير صالحة. يرجى إرسال رقمًا موجبًا صحيحًا. الحد الأقصى 70 كود في الطلب الواحد.',
    mustJoinChannel: '🔒 يرجى الاشتراك في القناة أولاً\n\n{message}\n\nثم اضغط زر التحقق.',
    joinChannel: '📢 اشترك الآن',
    checkSubscription: '🔄 تحقق من الاشتراك',
    captchaChallenge: '🤖 التحقق البشري\n\nيرجى حل: {challenge} = ?',
    captchaSuccess: '✅ تم التحقق بنجاح! أهلاً بك!',
    captchaWrong: '❌ إجابة خاطئة. حاول مرة أخرى.',
    setChannelLink: '🔗 تعيين رابط القناة',
    setChannelMessage: '📝 تعيين نص رسالة القناة',
    currentChannelLink: 'رابط القناة الحالي: {link}',
    currentChannelMessage: 'نص الرسالة الحالي: {message}',
    enterNewChannelLink: 'أرسل رابط القناة الجديد (مثال: https://t.me/yourchannel أو @yourchannel أو -100...):',
    enterNewChannelMessage: 'أرسل نص رسالة القناة الجديد:',
    verificationStatus: 'حالة التحقق الإجباري: {status}',
    verificationEnabled: '✅ مفعل',
    verificationDisabled: '❌ متوقف',
    enableVerification: '✅ تفعيل التحقق الإجباري',
    disableVerification: '⛔ إيقاف التحقق الإجباري',
    verificationToggledOn: '✅ تم تفعيل التحقق الإجباري.',
    verificationToggledOff: '⛔ تم إيقاف التحقق الإجباري.',
    verificationNeedsChannel: '❌ يجب ضبط القناة وحفظها بشكل صحيح قبل تفعيل التحقق الإجباري.',
    channelHelpText: 'يمكنك إرسال @channelusername أو معرّف القناة الذي يبدأ بـ -100 أو إعادة توجيه منشور من القناة ليتم حفظها بدقة.',
    channelLinkSet: '✅ تم تحديث رابط القناة!',
    channelMessageSet: '✅ تم تحديث نص الرسالة!',
    buttonVisibilityUpdated: '✅ تم تحديث ظهور الأزرار!',
    setIQDRate: '💰 تعيين سعر صرف الدينار',
    setUSDTWallet: '🏦 تعيين عنوان محفظة USDT',
    setIQDWallet: '🏦 تعيين السوبر كي للدينار',
    editCurrencyNames: '✏️ تعديل أسماء العملات',
    editDepositInstructions: '📝 تعديل تعليمات الدفع',
    editUSDName: 'تعديل اسم USDT',
    editIQDName: 'تعديل اسم الدينار العراقي',
    editUSDInstructions: 'تعديل تعليمات USDT',
    editIQDInstructions: 'تعديل تعليمات الدينار',
    enterNewRate: 'أرسل سعر الصرف الجديد (1 دولار = ? دينار):',
    enterWalletAddress: 'أرسل عنوان المحفظة / السوبر كي:',
    enterInstructions: 'أرسل تعليمات الدفع:',
    enterNewCurrencyName: 'أرسل الاسم الجديد للعملة:',
    currencyNameUpdated: '✅ تم تحديث اسم العملة!',
    walletSet: '✅ تم تحديث عنوان المحفظة!',
    instructionsSet: '✅ تم تحديث التعليمات!',
    rateSet: '✅ تم تحديث سعر الصرف!',
    totalCodes: '📦 إجمالي الأكواد في المخزون: {count}',
    totalSales: '💰 إجمالي المبيعات: {amount} دولار',
    pendingDeposits: '⏳ شحنات معلقة: {count}',
    sendReply: 'أرسل رسالتك:',
    supportMessageSent: '📨 تم إرسال رسالتك إلى الدعم الفني. ستتلقى رداً قريباً.',
    supportNotification: '📩 رسالة دعم جديدة\n\nالمعرف: {username}\nالاسم: {name}\nايدي المستخدم: {userId}\n\nالرسالة: {message}',
    replyToSupport: 'رد على هذا المستخدم:',
    replyMessage: 'ردك من الدعم الفني:',
    confirm: '✅ موافق',
    buyNow: '🛒 شراء',
    digitalSubscriptions: '🧩 إضافة اشتراكات رقمية',
    digitalSubscriptionsMenu: '🧩 الاشتراكات الرقمية',
    addDigitalSectionToMainMenu: '➕ أضف خانة إلى: 👋 القائمة الرئيسية',
    askDigitalSectionNameEn: 'أرسل اسم الخانة بالإنجليزية:',
    askDigitalSectionNameAr: 'أرسل اسم الخانة بالعربية:',
    digitalSectionCreated: '✅ تم إضافة الخانة إلى القائمة الرئيسية بنجاح!',
    digitalSubscriptionsChooseSection: 'اختر الخانة الرقمية التي تريد إدارتها:',
    digitalSectionManageTitle: '🧩 إدارة الخانة: {name}',
    addDigitalProductInSection: '➕ اضف خانة في داخل {name}',
    askDigitalProductNameEn: 'أرسل اسم الاشتراك بالإنجليزية:',
    askDigitalProductNameAr: 'أرسل اسم الاشتراك بالعربية:',
    askDigitalProductPrice: 'أرسل سعر الاشتراك بالدولار:',
    askDigitalProductDescription: 'أرسل تفاصيل الاشتراك (نص، صورة، فيديو، أو /skip):',
    digitalProductCreated: '✅ تم إنشاء الاشتراك الرقمي بنجاح! المعرف: {id}',
    digitalProductManageText: '🧾 {name}\nالسعر: {price} دولار\nالمخزون المتبقي: {stock}\nالنوع: {type}',
    addDigitalProductStock: '📦 إضافة مخزون/حسابات',
    digitalStockInputPrompt: 'أرسل الآن المخزون/الحسابات.\n\nإذا كان المنتج حسابات، فأرسل الإيميل في سطر والباسورد في السطر الذي بعده لكل حساب.',
    digitalSectionEmpty: 'لا توجد اشتراكات متاحة داخل هذه الخانة حالياً.',
    digitalSectionChooseProduct: '🧩 اختر الاشتراك المطلوب من القائمة التالية:',
    digitalProductListButton: '{name} - {price} دولار ({stock})',
    digitalProductDetailsText: '🧩 {name}\n\nالمخزون المتبقي: {stock}\nالسعر: {price} دولار\n\nالتفاصيل:\n{details}',
    attachedDetailsNote: 'شاهد الوسائط المرفقة لمعرفة التفاصيل كاملة.',
    productQuantityPrompt: 'كم عدد الاشتراكات التي تريد شراءها؟ أرسل الرقم فقط.',
    remainingStockLine: 'المخزون المتبقي: {stock}',
    itemPriceLine: 'السعر: {price} دولار',
    chatgptStockLine: 'كم تبقى في المخزون: {stock}',
    chatgptPriceLine: 'سعر الكود: {price} دولار',
    chatgptDiscountLine: 'الخصم على الكمية: إذا اشتريت 20 كودًا أو أكثر يصبح سعر الكود الواحد 1 دولار.',
    chatgptDetailsLine: 'تفاصيل الكود: هذا الكود عبارة عن عرض ترويجي مخصص للمكسيك. يجب تشغيل VPN على المكسيك، ثم نسخ رابط الكود وفتحه من المتصفح أثناء تشغيل الـ VPN، وبعدها تفعيل الاشتراك.',
    chatgptNoteLine: 'ملاحظة: حتى الآن لا يعمل عليه أي BIN تخميني أو وهمي.',
    chatgptTermsTitle: '📌 الشروط:',
    chatgptTerms1: '1- لا توجد مدة صلاحية معلومة لهذا الكود. إذا انتهت صلاحيته فلا يمكن استرجاعه.',
    chatgptTerms2: '2- الكود غير قابل للاسترجاع إذا كان يعمل بشكل سليم ولا توجد به مشكلة. وفي حال كان الكود لا يعمل فقط، سيتم استبداله لك.',
    chatgptAgreementLine: 'بالضغط على «موافق وشراء» فأنت توافق على هذه الشروط.',
    invalidPrice: '❌ السعر غير صالح.',
    sendValidDescription: 'أرسل نصًا أو صورة أو فيديو أو /skip.'
  }
};

Object.assign(DEFAULT_TEXTS.en, {
  cancel: '❌ Cancel',
  discountButton: '🎟️ Discount Code',
  digitalSectionsGroupButton: '🧩 Digital sections in main menu',
  digitalSectionsButtonsHeader: '📚 Order digital sections inside this group',
  digitalSectionManageText: '🧩 Section: {name}\nStatus: {status}\nAdded at: {createdAt}\nProducts: {count}',
  digitalSectionActive: 'Visible in the main menu',
  digitalSectionHidden: 'Hidden from the main menu',
  editDigitalSectionName: '✏️ Edit section name',
  deleteDigitalSection: '🗑️ Delete section',
  askEditDigitalSectionNameEn: 'Send the new section name in English:',
  askEditDigitalSectionNameAr: 'Send the new section name in Arabic:',
  digitalSectionUpdated: '✅ Section name updated successfully!',
  confirmDeleteDigitalSection: '⚠️ Are you sure you want to delete this section with all its products and stock?',
  digitalSectionDeleted: '✅ Section deleted successfully.',
  editDigitalProductName: '✏️ Edit item name',
  editDigitalProductPrice: '💰 Edit item price',
  editDigitalProductDescription: '📝 Edit item details',
  deleteDigitalProduct: '🗑️ Delete item',
  viewDigitalProductStock: '📄 View added stock',
  searchDigitalProductDuplicates: '🔎 Search duplicate stock',
  deleteDigitalProductDuplicates: '🗑️ Delete duplicate stock',
  digitalProductDeleted: '✅ Item deleted successfully.',
  confirmDeleteDigitalProduct: '⚠️ Are you sure you want to delete this item with all its stock?',
  askEditDigitalProductNameEn: 'Send the new item name in English:',
  askEditDigitalProductNameAr: 'Send the new item name in Arabic:',
  askEditDigitalProductPrice: 'Send the new item price in USD:',
  askEditDigitalProductDescription: 'Send the new item details (text, photo, video, /empty to clear, or /skip to cancel):',
  digitalProductNameUpdated: '✅ Item name updated successfully!',
  digitalProductPriceUpdated: '✅ Item price updated successfully!',
  digitalProductDescriptionUpdated: '✅ Item details updated successfully!',
  noDigitalProductStock: 'No stock/accounts were added for this item yet.',
  digitalStockViewTitle: '📄 Added stock for: {name}\nTotal rows: {count}',
  stockEntryLabel: 'Entry #{index}',
  addedAtLine: 'Added at: {createdAt}',
  stockStatusAvailable: 'Available',
  stockStatusSold: 'Sold',
  stockStatusLine: 'Status: {status}',
  digitalDuplicatesNone: '✅ No duplicate codes/accounts were found for this item.',
  digitalDuplicatesFound: '🔎 Duplicate codes/accounts found: {count}\n\n{details}',
  digitalDuplicatesDeleted: '✅ Deleted duplicate stock rows: {count}\n{skippedLine}',
  duplicateSkippedLocked: 'Used duplicate rows kept: {count}',
  codesAddedDetailed: '✅ Stock added successfully.\nAdded: {added}\nSkipped duplicates: {duplicates}',
  invalidPurchaseQuantity: '❌ Invalid quantity. Please send a valid positive number.',
  productDescriptionLine: 'Description: {description}',
  invalidBulkStockPairs: '❌ Bulk stock must be sent as pairs: email on one line and password on the next line.',
  emptyStockInput: '❌ Please send the stock/accounts first.',
  digitalProductManageText: '🧾 {name}\nPrice: {price} USD\nRemaining stock: {stock}\nType: {type}\nAdded at: {createdAt}\nDescription: {description}',
  buyNow: '🛒 Buy Now',
  digitalStockBroadcastToggleOn: '📣 Stock notification: ✅ ON',
  digitalStockBroadcastToggleOff: '📣 Stock notification: ❌ OFF',
  digitalStockBroadcastEnabled: '✅ Digital stock notification enabled.',
  digitalStockBroadcastDisabled: '⛔ Digital stock notification disabled.',
  digitalStockBroadcastMessage: '🧩 New stock is now available\n\nItem: {name}\nAdded: {count}\nPrice: {price} USD',
  changeLanguage: '🌐 Change Language',
  languageUpdated: '✅ Language updated.',
  aiAssistant: '🤖 AI Assistant',
  aiAssistantWelcome: '🤖 Bot Assistant\n\nAsk me about available subscriptions, stock, prices, payment steps, or your balance. I only answer about this bot and its available services.',
  aiAssistantWelcomeForProduct: '🤖 Product Assistant\n\nAsk me anything about {name}: what it does, its price, remaining stock, and whether it suits you.',
  aiAssistantThinking: '🤖 Thinking...',
  aiAssistantUnavailable: '⚠️ AI features are not configured right now. Set OPENAI_API_KEY to enable smart translation and the assistant.',
  aiAssistantScopeLimit: 'I can only help with this bot, its subscriptions, stock, prices, payment flow, and your own balance.',
  aiAssistantContactSupportAsk: 'Would you like me to connect you with support?',
  aiAssistantSupportOpened: '✅ Support chat opened. Send your message now.',
  aiAssistantSupportDeclined: 'No problem. You can open support any time from the main menu.',
  aiAssistantSupportYes: '✅ Yes, contact support',
  aiAssistantSupportNo: '❌ No',
  askAiAboutThisProduct: '🤖 Ask AI about this item',
  stockAvailableInline: 'Available {stock}',
  addEmailPassword: '📧 Add Email & Password',
  enterBulkEmail: 'Send the email now:',
  enterBulkPassword: 'Send the password now:',
  enterBulkVerify: 'Send the verification/check value now, or /skip:',
  enterBulkExtra: 'Send any extra note now, or /skip:',
  bulkAccountSaved: '✅ Account saved.',
  bulkAccountDuplicate: '⚠️ This account already exists in stock.',
  addAnotherAccount: '➕ Add another account',
  done: '✅ Done',
  fieldEmail: 'Email',
  fieldPassword: 'Password',
  fieldVerification: 'Verification',
  fieldExtra: 'Extra',
  accountEntryTitle: 'Account #{index}',
  searchDeleteDigitalProductStock: '🔍 Search stock and delete',
  enterSearchDeleteDigitalProductStock: 'Send the stock/accounts you want to search for and delete. You can send one entry or many entries.',
  digitalProductStockSearchDeleteResult: '✅ Deleted: {deleted}\n❌ Not found: {missing}\n🔒 Kept sold rows: {locked}\n\n{details}',
  closeChat: '🔒 Close Chat',
  supportChatOpened: '✅ A support chat has been opened. Send your message now.',
  supportChatAlreadyOpen: '✅ The support chat is already open. Send your message now.',
  supportChatClosedByUser: '🔒 You closed the support chat.',
  supportChatClosedByAdmin: '🔒 Support closed the chat.',
  supportChatClosedAdminNotice: '🔒 The user closed the support chat.',
  supportChatClosedUserNotice: '🔒 Support closed the chat for the user.',
  supportAdminReplyPrompt: 'Send your reply to the user:',
  supportUserMessageForwarded: '📨 Your message was delivered to support.',
  supportThreadAdminNotice: '📩 Live support message\n\nUsername: {username}\nName: {name}\nUser ID: {userId}\n\nMessage: {message}',
  digitalStockInputPrompt: 'Send the stock/accounts now.\n\nQuick formats supported:\nemail|password\nemail | password\nemail|password|verification\nemail|password|verification|extra note\n\nYou can also use the button below to add one account step by step.',
  digitalProductListButton: '{name} - {price} USD | Available {stock}'
});

Object.assign(DEFAULT_TEXTS.ar, {
  cancel: '❌ إلغاء',
  discountButton: '🎟️ كود خصم',
  digitalSectionsGroupButton: '🧩 الخانات الرقمية في القائمة الرئيسية',
  digitalSectionsButtonsHeader: '📚 ترتيب الخانات الرقمية داخل هذا القسم',
  digitalSectionManageText: '🧩 الخانة: {name}\nالحالة: {status}\nتاريخ الإضافة: {createdAt}\nعدد المنتجات: {count}',
  digitalSectionActive: 'ظاهرة في القائمة الرئيسية',
  digitalSectionHidden: 'مخفية من القائمة الرئيسية',
  editDigitalSectionName: '✏️ تعديل اسم الخانة',
  deleteDigitalSection: '🗑️ حذف الخانة',
  askEditDigitalSectionNameEn: 'أرسل اسم الخانة الجديد بالإنجليزية:',
  askEditDigitalSectionNameAr: 'أرسل اسم الخانة الجديد بالعربية:',
  digitalSectionUpdated: '✅ تم تحديث اسم الخانة بنجاح!',
  confirmDeleteDigitalSection: '⚠️ هل أنت متأكد من حذف هذه الخانة مع جميع المنتجات والمخزون داخلها؟',
  digitalSectionDeleted: '✅ تم حذف الخانة بنجاح.',
  editDigitalProductName: '✏️ تعديل اسم المنتج',
  editDigitalProductPrice: '💰 تعديل سعر المنتج',
  editDigitalProductDescription: '📝 تعديل وصف المنتج',
  deleteDigitalProduct: '🗑️ حذف المنتج',
  viewDigitalProductStock: '📄 عرض المنتج المضاف',
  searchDigitalProductDuplicates: '🔎 البحث عن المكرر',
  deleteDigitalProductDuplicates: '🗑️ حذف المكرر',
  digitalProductDeleted: '✅ تم حذف المنتج بنجاح.',
  confirmDeleteDigitalProduct: '⚠️ هل أنت متأكد من حذف هذا المنتج مع جميع المخزون الخاص به؟',
  askEditDigitalProductNameEn: 'أرسل اسم المنتج الجديد بالإنجليزية:',
  askEditDigitalProductNameAr: 'أرسل اسم المنتج الجديد بالعربية:',
  askEditDigitalProductPrice: 'أرسل سعر المنتج الجديد بالدولار:',
  askEditDigitalProductDescription: 'أرسل تفاصيل المنتج الجديدة (نص أو صورة أو فيديو، أو /empty للحذف، أو /skip للإلغاء):',
  digitalProductNameUpdated: '✅ تم تحديث اسم المنتج بنجاح!',
  digitalProductPriceUpdated: '✅ تم تحديث سعر المنتج بنجاح!',
  digitalProductDescriptionUpdated: '✅ تم تحديث وصف المنتج بنجاح!',
  noDigitalProductStock: 'لا يوجد مخزون/حسابات مضافة لهذا المنتج حتى الآن.',
  digitalStockViewTitle: '📄 المخزون المضاف للمنتج: {name}\nإجمالي السطور: {count}',
  stockEntryLabel: 'العنصر #{index}',
  addedAtLine: 'تاريخ الإضافة: {createdAt}',
  stockStatusAvailable: 'متاح',
  stockStatusSold: 'مباع',
  stockStatusLine: 'الحالة: {status}',
  digitalDuplicatesNone: '✅ لا توجد أكواد/حسابات مكررة لهذا المنتج.',
  digitalDuplicatesFound: '🔎 تم العثور على أكواد/حسابات مكررة: {count}\n\n{details}',
  digitalDuplicatesDeleted: '✅ تم حذف الصفوف المكررة: {count}\n{skippedLine}',
  duplicateSkippedLocked: 'تم الإبقاء على الصفوف المكررة المباعة: {count}',
  codesAddedDetailed: '✅ تمت إضافة المخزون بنجاح.\nتمت الإضافة: {added}\nالمكرر الذي تم تجاهله: {duplicates}',
  invalidPurchaseQuantity: '❌ الكمية غير صالحة. يرجى إرسال رقم موجب صحيح.',
  productDescriptionLine: 'الوصف: {description}',
  invalidBulkStockPairs: '❌ يجب إرسال مخزون الحسابات على شكل أزواج: الإيميل في سطر والباسورد في السطر الذي يليه.',
  emptyStockInput: '❌ أرسل المخزون/الحسابات أولاً.',
  digitalProductManageText: '🧾 {name}\nالسعر: {price} دولار\nالمخزون المتبقي: {stock}\nالنوع: {type}\nتاريخ الإضافة: {createdAt}\nالوصف: {description}',
  buyNow: '🛒 شراء الآن',
  digitalStockBroadcastToggleOn: '📣 إشعار المخزون: ✅ مفعل',
  digitalStockBroadcastToggleOff: '📣 إشعار المخزون: ❌ متوقف',
  digitalStockBroadcastEnabled: '✅ تم تفعيل إشعار إضافة مخزون الاشتراكات الرقمية.',
  digitalStockBroadcastDisabled: '⛔ تم إيقاف إشعار إضافة مخزون الاشتراكات الرقمية.',
  digitalStockBroadcastMessage: '🧩 تمت إضافة مخزون جديد الآن\n\nالمنتج: {name}\nالكمية المضافة: {count}\nالسعر: {price} دولار',
  changeLanguage: '🌐 تغيير اللغة',
  languageUpdated: '✅ تم تحديث اللغة.',
  aiAssistant: '🤖 المساعد الذكي',
  aiAssistantWelcome: '🤖 مساعد البوت الذكي\n\nاسألني عن الاشتراكات المتوفرة، المخزون، الأسعار، خطوات الدفع، أو رصيدك. أنا أجيب فقط عن هذا البوت وخدماته المتوفرة.',
  aiAssistantWelcomeForProduct: '🤖 مساعد المنتج الذكي\n\nاسألني عن {name}: ما هو، ماذا يفعل، كم سعره، وكم تبقى منه في المخزون.',
  aiAssistantThinking: '🤖 جاري التفكير...',
  aiAssistantUnavailable: '⚠️ ميزات الذكاء الاصطناعي غير مفعلة حالياً. أضف OPENAI_API_KEY لتفعيل الترجمة الذكية والمساعد.',
  aiAssistantScopeLimit: 'أنا أساعد فقط فيما يخص هذا البوت، الاشتراكات المتوفرة، المخزون، الأسعار، الشراء، الدفع، ورصيدك أنت فقط.',
  aiAssistantContactSupportAsk: 'هل تريد أن أوصلك بالدعم؟',
  aiAssistantSupportOpened: '✅ تم فتح دردشة الدعم. أرسل رسالتك الآن.',
  aiAssistantSupportDeclined: 'لا مشكلة، يمكنك فتح الدعم في أي وقت من القائمة الرئيسية.',
  aiAssistantSupportYes: '✅ نعم، تواصل مع الدعم',
  aiAssistantSupportNo: '❌ لا',
  askAiAboutThisProduct: '🤖 اسأل الذكاء الاصطناعي عن هذا الاشتراك',
  stockAvailableInline: 'يوجد {stock}',
  addEmailPassword: '📧 إضافة إيميل وباسورد',
  enterBulkEmail: 'أرسل الإيميل الآن:',
  enterBulkPassword: 'أرسل الباسورد الآن:',
  enterBulkVerify: 'أرسل التحقق الآن أو /skip للتخطي:',
  enterBulkExtra: 'أرسل أي ملاحظة إضافية الآن أو /skip للتخطي:',
  bulkAccountSaved: '✅ تم حفظ الحساب.',
  bulkAccountDuplicate: '⚠️ هذا الحساب موجود مسبقاً في المخزون.',
  addAnotherAccount: '➕ إضافة حساب آخر',
  done: '✅ تم',
  fieldEmail: 'ايميل',
  fieldPassword: 'باسورد',
  fieldVerification: 'تحقق',
  fieldExtra: 'إضافة شي آخر',
  accountEntryTitle: 'الحساب #{index}',
  searchDeleteDigitalProductStock: '🔍 البحث في المخزون وحذفه',
  enterSearchDeleteDigitalProductStock: 'أرسل المخزون/الحسابات التي تريد البحث عنها وحذفها. يمكنك إرسال عنصر واحد أو عدة عناصر.',
  digitalProductStockSearchDeleteResult: '✅ تم حذف: {deleted}\n❌ غير موجود: {missing}\n🔒 تم الإبقاء على المباعة: {locked}\n\n{details}',
  closeChat: '🔒 اغلاق الدردشة',
  supportChatOpened: '✅ تم فتح دردشة مع الدعم. أرسل رسالتك الآن.',
  supportChatAlreadyOpen: '✅ دردشة الدعم مفتوحة بالفعل. أرسل رسالتك الآن.',
  supportChatClosedByUser: '🔒 قمت بإغلاق دردشة الدعم.',
  supportChatClosedByAdmin: '🔒 قام الدعم بإغلاق الدردشة.',
  supportChatClosedAdminNotice: '🔒 قام المستخدم بإغلاق دردشة الدعم.',
  supportChatClosedUserNotice: '🔒 قام الدعم بإغلاق دردشة المستخدم.',
  supportAdminReplyPrompt: 'أرسل ردك إلى المستخدم:',
  supportUserMessageForwarded: '📨 تم إيصال رسالتك إلى الدعم.',
  supportThreadAdminNotice: '📩 رسالة دعم مباشرة\n\nالمعرف: {username}\nالاسم: {name}\nايدي المستخدم: {userId}\n\nالرسالة: {message}',
  digitalStockInputPrompt: 'أرسل الآن المخزون/الحسابات.\n\nالصيغ السريعة المدعومة:\nemail|password\nemail | password\nemail|password|verification\nemail|password|verification|ملاحظة إضافية\n\nويمكنك أيضاً استخدام زر «إضافة إيميل وباسورد» لإضافة حساب واحد خطوة بخطوة.',
  digitalProductListButton: '{name} - {price} دولار | يوجد {stock}'
});

Object.assign(DEFAULT_TEXTS.en, {
  aiAssistantPurchaseConfirm: '🛒 Purchase confirmation\n\nProduct: {name}\nQuantity: {qty}\nPrice per item: {price} USD\nTotal: {total} USD\nRemaining stock: {stock}\nYour balance: {balance} USD\n\nAre you sure you want me to complete this purchase now?',
  aiAssistantPurchaseNeedMore: 'Would you like to know more about {name} before purchasing?',
  aiAssistantPurchaseUnavailable: '❌ This item is currently unavailable in the requested quantity. Available stock: {stock}.',
  aiAssistantPurchaseCancelled: '✅ Purchase request cancelled.',
  aiAssistantPurchaseConfirmButton: '✅ Yes, buy now',
  aiAssistantPurchaseMoreButton: 'ℹ️ Tell me more',
  aiAssistantPurchaseCancelButton: '❌ Cancel',
  aiAssistantProductHeader: '🧩 Product details',
  aiAssistantPricesHeader: '💵 Current prices of available products:',
  aiAssistantNoProductMatch: 'I could not identify the product exactly. Tell me the product name more clearly, for example: Buy CapCut account.',
  aiAssistantTrainingSaved: '✅ Assistant training saved successfully.',
  aiAssistantTrainingHelp: 'Use one of these formats:\ntrain assistant: question => answer\n\nor\nدرب المساعد: السؤال => الجواب',
  aiAssistantAdminOpened: '✅ Done. I opened: {target}',
  aiAssistantAdminNoMatch: 'I understood that you want to open an admin interface, but I could not determine which one exactly. Try for example: open stock interface, open prices, open merchants, open balances, or open subscriptions.',
  aiAssistantOpenStocks: 'stock interface',
  aiAssistantOpenPrices: 'prices interface',
  aiAssistantOpenMerchants: 'merchants list',
  aiAssistantOpenBalances: 'balance management',
  aiAssistantOpenButtons: 'button management',
  aiAssistantOpenSubscriptions: 'digital subscriptions',
  aiAssistantOpenAdminPanel: 'admin panel',
  aiAssistantOpenStats: 'statistics',
  aiAssistantOpenReferrals: 'referral settings',
  aiAssistantOpenBots: 'bots management',
  aiAssistantTurnedOn: '✅ AI assistant enabled.',
  aiAssistantTurnedOff: '⛔ AI assistant disabled.',
  aiAssistantDisabledNotice: '⛔ AI assistant is currently disabled by admin.'
});

Object.assign(DEFAULT_TEXTS.ar, {
  aiAssistantPurchaseConfirm: '🛒 تأكيد الشراء\n\nالمنتج: {name}\nالكمية: {qty}\nسعر القطعة: {price} دولار\nالإجمالي: {total} دولار\nالمخزون المتبقي: {stock}\nرصيدك الحالي: {balance} دولار\n\nهل أنت متأكد أنك تريد مني إتمام هذا الشراء الآن؟',
  aiAssistantPurchaseNeedMore: 'هل تريد معرفة المزيد عن {name} قبل الشراء؟',
  aiAssistantPurchaseUnavailable: '❌ هذا المنتج غير متوفر حالياً بالكمية المطلوبة. المتوفر الآن: {stock}.',
  aiAssistantPurchaseCancelled: '✅ تم إلغاء طلب الشراء.',
  aiAssistantPurchaseConfirmButton: '✅ نعم، اشترِ الآن',
  aiAssistantPurchaseMoreButton: 'ℹ️ أريد معرفة المزيد',
  aiAssistantPurchaseCancelButton: '❌ إلغاء',
  aiAssistantProductHeader: '🧩 تفاصيل المنتج',
  aiAssistantPricesHeader: '💵 أسعار المنتجات المتوفرة حالياً:',
  aiAssistantNoProductMatch: 'لم أتمكن من تحديد المنتج بدقة. اكتب اسم المنتج بشكل أوضح، مثلاً: أريد شراء حساب كاب كات.',
  aiAssistantTrainingSaved: '✅ تم حفظ تدريب المساعد بنجاح.',
  aiAssistantTrainingHelp: 'استخدم أحد الشكلين التاليين:\ntrain assistant: question => answer\n\nأو\nدرب المساعد: السؤال => الجواب',
  aiAssistantAdminOpened: '✅ تم. فتحت لك: {target}',
  aiAssistantAdminNoMatch: 'فهمت أنك تريد فتح واجهة إدارية، لكني لم أحدد أي واجهة بالضبط. جرّب مثلاً: افتح المخزونات، افتح الأسعار، افتح التجار، افتح الأرصدة، أو افتح الاشتراكات.',
  aiAssistantOpenStocks: 'واجهة المخزونات',
  aiAssistantOpenPrices: 'واجهة الأسعار',
  aiAssistantOpenMerchants: 'قائمة التجار',
  aiAssistantOpenBalances: 'إدارة الأرصدة',
  aiAssistantOpenButtons: 'إدارة الأزرار',
  aiAssistantOpenSubscriptions: 'الاشتراكات الرقمية',
  aiAssistantOpenAdminPanel: 'لوحة التحكم',
  aiAssistantOpenStats: 'الإحصائيات',
  aiAssistantOpenReferrals: 'إعدادات الإحالة',
  aiAssistantOpenBots: 'إدارة البوتات',
  aiAssistantTurnedOn: '✅ تم تشغيل المساعد الذكي.',
  aiAssistantTurnedOff: '⛔ تم إيقاف المساعد الذكي.',
  aiAssistantDisabledNotice: '⛔ المساعد الذكي متوقف حالياً من قبل الأدمن.'
});

Object.assign(DEFAULT_TEXTS.en, {
  binancePayOrderCreated: '⚡ <b>Binance Pay order created</b>\n\nAmount: <b>{amount} {currency}</b>\nOrder: <code>{merchantTradeNo}</code>\nExpires: <b>{expiresAt}</b>\n\nUse the buttons below to open checkout and then press check payment status after payment.',
  binancePayPayNow: '💳 Pay now',
  binancePayOpenApp: '📱 Open Binance app',
  binancePayCheckStatus: '🔄 Check payment status',
  binancePayStatusPending: '⏳ Payment is still pending. Complete the payment in Binance Pay, then check again.',
  binancePayStatusPaid: '✅ Payment confirmed and the balance has been credited.',
  binancePayStatusExpired: '⌛ This Binance Pay order has expired. Please create a new one.',
  binancePayStatusClosed: '❌ This Binance Pay order was closed or cancelled.',
  binancePayStatusError: '❌ Binance Pay returned an error for this order. Please create a new order.',
  binancePayCreateError: '❌ Failed to create the Binance Pay order right now. Please try again shortly.',
  binancePayNotConfigured: '⚠️ Binance Pay is not configured yet. Please set BINANCE_PAY_API_KEY and BINANCE_PAY_SECRET_KEY.',
  binancePayWebhookInvalid: '❌ Binance Pay webhook is disabled in this build.',
  binancePayMismatch: '❌ Payment verified but amount or currency did not match the original order, so no balance was added.',
  binancePayApiTopupCreated: '✅ Binance Pay topup order created.',
  binancePayApiStatusNotFound: 'Order not found.'
});

Object.assign(DEFAULT_TEXTS.ar, {
  binancePayOrderCreated: '⚡ <b>تم إنشاء طلب Binance Pay</b>\n\nالمبلغ: <b>{amount} {currency}</b>\nرقم الطلب: <code>{merchantTradeNo}</code>\nينتهي في: <b>{expiresAt}</b>\n\nاستخدم الأزرار أدناه لفتح صفحة الدفع، وبعد الدفع اضغط على زر التحقق من حالة الدفع.',
  binancePayPayNow: '💳 ادفع الآن',
  binancePayOpenApp: '📱 افتح تطبيق بايننس',
  binancePayCheckStatus: '🔄 تحقق من حالة الدفع',
  binancePayStatusPending: '⏳ الدفع ما زال معلّقًا. أكمل الدفع داخل Binance Pay ثم اضغط التحقق مرة أخرى.',
  binancePayStatusPaid: '✅ تم تأكيد الدفع وإضافة الرصيد بنجاح.',
  binancePayStatusExpired: '⌛ انتهت صلاحية هذا الطلب في Binance Pay. أنشئ طلبًا جديدًا.',
  binancePayStatusClosed: '❌ تم إغلاق أو إلغاء هذا الطلب في Binance Pay.',
  binancePayStatusError: '❌ أعاد Binance Pay حالة خطأ لهذا الطلب. أنشئ طلبًا جديدًا.',
  binancePayCreateError: '❌ تعذر إنشاء طلب Binance Pay الآن. حاول مرة أخرى بعد قليل.',
  binancePayNotConfigured: '⚠️ Binance Pay غير مهيأ بعد. يرجى ضبط BINANCE_PAY_API_KEY و BINANCE_PAY_SECRET_KEY.',
  binancePayWebhookInvalid: '❌ Webhook الخاص بـ Binance Pay معطل في هذه النسخة.',
  binancePayMismatch: '❌ تم التحقق من الدفع لكن المبلغ أو العملة لا يطابقان الطلب الأصلي، لذلك لم تتم إضافة الرصيد.',
  binancePayApiTopupCreated: '✅ تم إنشاء طلب شحن Binance Pay.',
  binancePayApiStatusNotFound: 'الطلب غير موجود.'
});

Object.assign(DEFAULT_TEXTS.en, {
  binanceTransferTitle: '⚡ Binance (Auto)',
  binanceTransferNotConfigured: '⚠️ Binance transfer verification is not configured yet. Please set BINANCE_API_KEY, BINANCE_API_SECRET and BINANCE_PAY_ID.',
  binanceTransferInstructions: '✅ <b>Order created.</b>\n\n💰 <b>Send:</b> <b>{amount} USDT</b>\n\n🆔 <b>To Binance ID</b>\n\n<code>{payId}</code>\n\n⚠️ <b>Important for payment confirmation:</b>\n\nYou must write this code:\n\n<code>{note}</code>\n\nin the payment note field (Note).',
  binanceTransferCheckButton: '🧾 Verify via Order ID',
  binanceTransferSendOrderIdHint: 'Send the Order ID here only.',
  binanceTransferChecking: '⏳ Checking your payment in Binance, please wait a few seconds...',
  binanceTransferVerified: '🎉 <b>Payment verified successfully!</b>\n✅ <b>{amount} USDT</b> has been added to your balance.\n\n💰 New balance: <b>{balance} USD</b>',
  binanceTransferNotFound: '❌ No matching payment was found yet, or the amount does not match.\nIf you just paid, please wait one minute and try again.',
  binanceTransferDuplicate: '❌ Sorry, this Order ID has already been used before.',
  binanceTransferOrderIdExpired: '⌛ This Order ID has expired. Only transfers from the last hour can be verified.',
  binanceTransferManualPrompt: 'Send the Order ID here:',
  binanceTransferNoPending: '❌ You do not have a pending Binance deposit request. Start a new deposit first.',
  binanceTransferHelp: 'ℹ️ Use the button below if you want to verify via Order ID.',
  binanceTransferCheckByNotePending: '⏳ Payment not found yet. If you paid recently, wait a little and try again using the Order ID button.'
});

Object.assign(DEFAULT_TEXTS.ar, {
  binanceTransferTitle: '⚡ Binance (Auto)',
  binanceTransferNotConfigured: '⚠️ التحقق من تحويلات بايننس غير مهيأ بعد. يرجى ضبط BINANCE_API_KEY و BINANCE_API_SECRET و BINANCE_PAY_ID.',
  binanceTransferInstructions: '✅ <b>تم إنشاء الطلب.</b>\n\n💰 <b>قم بأرسال :</b> <b>{amount} USDT</b>\n\n🆔 <b>إلى معرف بايننس</b>\n\n<code>{payId}</code>\n\n⚠️ <b>هام جدًا لتأكيد الدفع:</b>\n\nيجب عليك كتابة هذا الكود:\n\n<code>{note}</code>\n\nفي خانة الملاحظات (Note) عند التحويل.',
  binanceTransferCheckButton: '🧾 التحقق عبر معرف الطلب',
  binanceTransferSendOrderIdHint: 'قم بأرسال معرف الطلب هنا:',
  binanceTransferChecking: '⏳ جاري التحقق من دفعتك في بايننس، يرجى الانتظار بضع ثوانٍ...',
  binanceTransferVerified: '🎉 <b>تم التحقق من الدفع بنجاح!</b>\n✅ تمت إضافة <b>{amount} USDT</b> إلى رصيدك.\n\n💰 رصيدك الجديد: <b>{balance} USD</b>',
  binanceTransferNotFound: '❌ لم يتم العثور على حوالة مطابقة حتى الآن أو أن المبلغ غير مطابق.\nإذا قمت بالدفع للتو، يرجى الانتظار دقيقة واحدة ثم المحاولة مرة أخرى.',
  binanceTransferDuplicate: '❌ عذرًا، هذا المعرف تم استخدامه من قبل.',
  binanceTransferOrderIdExpired: '⌛ انتهت صلاحية معرف الطلب هذا. يمكن التحقق فقط من الحوالات التي مر عليها أقل من ساعة.',
  binanceTransferManualPrompt: 'قم بأرسال معرف الطلب هنا:',
  binanceTransferNoPending: '❌ ليس لديك طلب إيداع بايننس قيد الانتظار. ابدأ طلب شحن جديد أولاً.',
  binanceTransferHelp: 'ℹ️ استخدم الزر أدناه إذا أردت التحقق عبر معرف الطلب.',
  binanceTransferCheckByNotePending: '⏳ لم تظهر الحوالة بعد. إذا دفعت قبل قليل، انتظر قليلًا ثم جرّب عبر زر معرف الطلب.'
});


Object.assign(DEFAULT_TEXTS.en, {
  changeButtonNames: '✨ Change Button Names',
  enterButtonNameToChange: 'Send the button key you want to change, for example: change_language or deposit',
  buttonNameNotFound: '❌ Invalid button key. Send a key like: change_language or deposit.',
  enterNewButtonNameAr: 'Send the new button name in Arabic:',
  enterNewButtonNameEn: 'Send the new button name in English:',
  buttonNameUpdated: '✅ Button name updated successfully!',
  customEmojiIdsTitle: '⭐ <b>Custom emoji IDs extracted successfully:</b>',
  customEmojiNoMatch: '❌ No custom emoji was found in your message.'
});

Object.assign(DEFAULT_TEXTS.ar, {
  changeButtonNames: '✨ تغيير اسماء الازرار',
  enterButtonNameToChange: 'أرسل مفتاح الزر الذي تريد تغييره، مثال: change_language أو deposit',
  buttonNameNotFound: '❌ مفتاح الزر غير صحيح. أرسل مفتاحًا مثل: change_language أو deposit.',
  enterNewButtonNameAr: 'اختر الاسم الجديد بالعربي:',
  enterNewButtonNameEn: 'اختر الاسم الجديد بالانكليزي:',
  buttonNameUpdated: '✅ تم تحديث اسم الزر بنجاح!',
  customEmojiIdsTitle: '⭐ <b>تم استخراج معرفات الايموجي المخصص بنجاح:</b>',
  customEmojiNoMatch: '❌ لم أجد ايموجي مخصص في رسالتك.'
});


Object.assign(DEFAULT_TEXTS.en, {
  colorButtons: '🎨 Color Buttons',
  buttonColorChooseButton: '🎨 Choose the button you want to color:\n\nSupported Telegram styles: blue, green, red. If a digital product stock is empty, its button becomes red automatically.',
  buttonColorChooseStyle: '🎨 Choose a color for:\n{name}',
  buttonStyleDefault: '⚪ Default',
  buttonStylePrimary: '🔵 Blue',
  buttonStyleSuccess: '🟢 Green',
  buttonStyleDanger: '🔴 Red',
  buttonColorUpdated: '✅ Button color updated!',
  showDigitalProductInFront: '📌 Show in front',
  hideDigitalProductFromFront: '📌 Hide from front',
  frontDigitalProductUpdated: '✅ Front display updated!'
});

Object.assign(DEFAULT_TEXTS.ar, {
  colorButtons: '🎨 تلوين الأزرار',
  buttonColorChooseButton: '🎨 اختر الزر الذي تريد تلوينه:\n\nالألوان المدعومة من تيليجرام: أزرق، أخضر، أحمر. إذا نفد مخزون اشتراك رقمي يصبح زره أحمر تلقائيًا.',
  buttonColorChooseStyle: '🎨 اختر لون الزر:\n{name}',
  buttonStyleDefault: '⚪ افتراضي',
  buttonStylePrimary: '🔵 أزرق',
  buttonStyleSuccess: '🟢 أخضر',
  buttonStyleDanger: '🔴 أحمر',
  buttonColorUpdated: '✅ تم تحديث لون الزر!',
  showDigitalProductInFront: '📌 إظهار في المقدمة',
  hideDigitalProductFromFront: '📌 إخفاء من المقدمة',
  frontDigitalProductUpdated: '✅ تم تحديث الظهور في المقدمة!'
});

function isAdmin(userId) {
  return Number(userId) === ADMIN_ID;
}

function safeParseState(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function setUserState(userId, state) {
  await User.update({ state: JSON.stringify(state) }, { where: { id: userId } });
}

async function clearUserState(userId) {
  await User.update({ state: null }, { where: { id: userId } });
}

async function cancelUserStateAndReturnToMenu(userId) {
  await clearUserState(userId);
  await sendMainMenu(userId);
}

async function getUserBalanceValue(userId) {
  const user = await User.findByPk(userId, { attributes: ['balance'] });
  return Number(user?.balance || 0);
}

async function getUserBalanceFormatted(userId) {
  return (await getUserBalanceValue(userId)).toFixed(2);
}

async function getCurrentBalanceLineText(userId) {
  return await getText(userId, 'currentBalanceLine', { balance: await getUserBalanceFormatted(userId) });
}

async function getBalanceButtonLabel(userId) {
  return await getText(userId, 'myBalanceButton', { balance: await getUserBalanceFormatted(userId) });
}

async function getBackAndCancelReplyMarkup(userId, backCallback = 'back_to_menu') {
  const rows = [];
  if (backCallback) rows.push([{ text: await getText(userId, 'back'), callback_data: backCallback }]);
  rows.push([{ text: await getText(userId, 'cancel'), callback_data: 'cancel_action' }]);
  return { inline_keyboard: rows };
}

async function safeDeleteChatMessage(chatId, messageId) {
  if (!chatId || !messageId) return false;
  try {
    await bot.deleteMessage(chatId, messageId);
    return true;
  } catch {
    return false;
  }
}

function shouldAutoDeleteIncomingMessage(msg, state, admin = false) {
  return false;
}

function scheduleAutoDeleteIncomingMessage(msg, state, admin = false, delayMs = 1500) {
  if (!shouldAutoDeleteIncomingMessage(msg, state, admin)) return;
  setTimeout(() => {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
  }, delayMs);
}

async function cleanupCallbackSourceMessage(query, userId, options = {}) {
  const { skipForAdmins = true } = options;
  if (!query?.message?.message_id) return false;
  if (skipForAdmins && isAdmin(userId)) return false;
  return safeDeleteChatMessage(query.message.chat.id, query.message.message_id);
}

async function getBalanceCenterReplyMarkup(userId) {
  return {
    inline_keyboard: [
      [{ text: await getText(userId, 'depositNow'), callback_data: 'deposit' }],
      [{ text: await getText(userId, 'myPurchases'), callback_data: 'my_purchases' }],
      [{ text: await getText(userId, 'back'), callback_data: 'back_to_menu' }]
    ]
  };
}

async function getPostPurchaseReplyMarkup(userId, options = {}) {
  const { merchant = null, continueCallback = null } = options;
  let nextCallback = continueCallback;

  if (!nextCallback) {
    if (merchant) {
      const digitalSectionId = parseDigitalSectionIdFromCategory(merchant.category);
      nextCallback = digitalSectionId ? `digital_section_${digitalSectionId}` : 'buy';
    } else {
      nextCallback = 'chatgpt_code';
    }
  }

  return {
    inline_keyboard: [
      [{ text: await getText(userId, 'myBalance'), callback_data: 'my_balance' }],
      [{ text: await getText(userId, 'continueShopping'), callback_data: nextCallback }],
      [{ text: await getText(userId, 'back'), callback_data: 'back_to_menu' }]
    ]
  };
}

async function sendPurchaseDeliveryMessage(userId, htmlMessage, options = {}) {
  const { merchant = null, continueCallback = null, totalCost = null, newBalance = null, quantity = null } = options;
  const summaryLines = [];

  if (quantity !== null && quantity !== undefined) {
    summaryLines.push(await getText(userId, 'quantityPurchasedLine', { qty: quantity }));
  }

  if (totalCost !== null && totalCost !== undefined) {
    summaryLines.push(await getText(userId, 'totalPaidLine', { total: Number(totalCost).toFixed(2) }));
  }

  if (newBalance !== null && newBalance !== undefined) {
    summaryLines.push(await getText(userId, 'remainingBalanceLine', { balance: Number(newBalance).toFixed(2) }));
  }

  const finalText = summaryLines.length > 0
    ? `${htmlMessage}\n\n${summaryLines.join('\n')}`
    : htmlMessage;

  await bot.sendMessage(userId, finalText, {
    parse_mode: 'HTML',
    reply_markup: await getPostPurchaseReplyMarkup(userId, { merchant, continueCallback })
  });
}

function generateReferralCode(userId) {
  return `REF${userId}`;
}

function generateRandomEmail() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let localPart = '';
  for (let i = 0; i < 10; i += 1) {
    localPart += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${localPart}@gmail.com`;
}

async function getText(userId, key, replacements = {}) {
  try {
    const user = await User.findByPk(userId);
    const lang = user ? user.lang : 'en';
    const setting = await Setting.findOne({ where: { key, lang } });
    let text = setting ? setting.value : DEFAULT_TEXTS[lang]?.[key];

    if (!text) {
      text = DEFAULT_TEXTS.en?.[key] || key;
    }

    for (const [k, v] of Object.entries(replacements)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
    return text;
  } catch (err) {
    console.error('Error in getText:', err);
    return DEFAULT_TEXTS.en?.[key] || key;
  }
}


function normalizeButtonLabel(value) {
  return String(value || '')
    .replace(/[​-‍️]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractCustomEmojiIdsFromMessage(message) {
  const entities = [
    ...(Array.isArray(message?.entities) ? message.entities : []),
    ...(Array.isArray(message?.caption_entities) ? message.caption_entities : [])
  ];

  return [...new Set(
    entities
      .filter(entity => entity?.type === 'custom_emoji' && entity.custom_emoji_id)
      .map(entity => String(entity.custom_emoji_id))
      .filter(Boolean)
  )];
}

function stripCustomEmojiPlaceholdersFromMessage(message) {
  const sourceText = String(message?.text || message?.caption || '');
  const entities = [
    ...(Array.isArray(message?.entities) ? message.entities : []),
    ...(Array.isArray(message?.caption_entities) ? message.caption_entities : [])
  ]
    .filter(entity => entity?.type === 'custom_emoji' && Number.isInteger(entity.offset) && Number.isInteger(entity.length) && entity.length > 0)
    .sort((a, b) => b.offset - a.offset);

  if (!entities.length) {
    return sourceText.trim();
  }

  let cleaned = sourceText;
  for (const entity of entities) {
    cleaned = cleaned.slice(0, entity.offset) + cleaned.slice(entity.offset + entity.length);
  }

  return cleaned.replace(/\s+/g, ' ').trim();
}

function isRenamableTextValue(value) {
  const text = String(value || '');
  return Boolean(text) && text.length <= 80 && !text.includes('\n') && !text.includes('{');
}

const MENU_BUTTON_TEXT_KEY_MAP = {
  buy: 'buy',
  chatgpt_code: 'chatgptCode',
  my_balance: 'myBalanceButton',
  deposit: 'deposit',
  my_purchases: 'myPurchases',
  redeem: 'redeem',
  referral: 'referral',
  discount: 'discountButton',
  support: 'support',
  ai_assistant: 'aiAssistant',
  change_language: 'changeLanguage',
  free_code: 'freeCodeMenu',
  admin_panel: 'adminPanel',
  digital_sections_group: 'digitalSectionsGroupButton'
};

const RENAMABLE_BUTTON_KEYS = [...new Set([
  ...Object.keys(MENU_BUTTON_TEXT_KEY_MAP),
  ...Object.entries(DEFAULT_TEXTS.en || {}).filter(([, value]) => isRenamableTextValue(value)).map(([key]) => key),
  ...Object.entries(DEFAULT_TEXTS.ar || {}).filter(([, value]) => isRenamableTextValue(value)).map(([key]) => key)
])];

function resolveButtonTextKey(buttonKey) {
  const normalized = String(buttonKey || '').trim();
  return MENU_BUTTON_TEXT_KEY_MAP[normalized] || normalized;
}

async function getTextByLang(key, lang, replacements = {}) {
  try {
    const normalizedLang = lang === 'ar' ? 'ar' : 'en';
    const resolvedKey = resolveButtonTextKey(key);
    const setting = await Setting.findOne({ where: { key: resolvedKey, lang: normalizedLang } });
    let text = setting ? setting.value : DEFAULT_TEXTS[normalizedLang]?.[resolvedKey];

    if (!text) {
      text = DEFAULT_TEXTS.en?.[resolvedKey] || resolvedKey;
    }

    for (const [k, v] of Object.entries(replacements)) {
      text = text.replace(new RegExp(`\{${k}\}`, 'g'), String(v));
    }

    return text;
  } catch (err) {
    console.error('Error in getTextByLang:', err);
    const normalizedLang = lang === 'ar' ? 'ar' : 'en';
    const resolvedKey = resolveButtonTextKey(key);
    return DEFAULT_TEXTS[normalizedLang]?.[resolvedKey] || DEFAULT_TEXTS.en?.[resolvedKey] || resolvedKey;
  }
}

async function findButtonKeyByLabel(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  const normalizedKey = raw.toLowerCase().replace(/[^a-z0-9_]/g, '');
  for (const key of RENAMABLE_BUTTON_KEYS) {
    if (normalizedKey === String(key || '').toLowerCase()) {
      return key;
    }

    const resolvedKey = resolveButtonTextKey(key);
    if (normalizedKey === String(resolvedKey || '').toLowerCase()) {
      return key;
    }
  }

  const target = normalizeButtonLabel(raw);
  if (!target) return null;

  for (const key of RENAMABLE_BUTTON_KEYS) {
    const arText = normalizeButtonLabel(await getTextByLang(key, 'ar'));
    const enText = normalizeButtonLabel(await getTextByLang(key, 'en'));
    if (target === arText || target === enText) {
      return key;
    }
  }

  return null;
}

async function getButtonCustomEmojiMap() {
  const rawValue = await getGlobalSetting('button_custom_emoji_map', '{}');
  try {
    const parsed = JSON.parse(String(rawValue || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function saveButtonCustomEmojiMap(map) {
  await Setting.upsert({
    key: 'button_custom_emoji_map',
    lang: 'global',
    value: JSON.stringify(map || {})
  });
}

async function setButtonCustomEmojiId(key, lang, emojiId) {
  const normalizedLang = lang === 'ar' ? 'ar' : 'en';
  const map = await getButtonCustomEmojiMap();
  map[key] = map[key] || {};

  if (emojiId) {
    map[key][normalizedLang] = String(emojiId);
  } else {
    delete map[key][normalizedLang];
  }

  if (!Object.keys(map[key]).length) {
    delete map[key];
  }

  await saveButtonCustomEmojiMap(map);
}


const TELEGRAM_BUTTON_STYLE_OPTIONS = ['primary', 'success', 'danger'];

function normalizeTelegramButtonStyle(style) {
  const normalized = String(style || '').trim().toLowerCase();
  return TELEGRAM_BUTTON_STYLE_OPTIONS.includes(normalized) ? normalized : '';
}

async function getButtonStyleMap() {
  const rawValue = await getGlobalSetting('button_style_map', '{}');
  try {
    const parsed = JSON.parse(String(rawValue || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function saveButtonStyleMap(map) {
  await Setting.upsert({
    key: 'button_style_map',
    lang: 'global',
    value: JSON.stringify(map || {})
  });
}

async function setButtonStyle(styleKey, style) {
  const normalizedStyle = normalizeTelegramButtonStyle(style);
  const map = await getButtonStyleMap();
  const key = String(styleKey || '').trim();
  if (!key) return;

  if (normalizedStyle) {
    map[key] = normalizedStyle;
  } else {
    delete map[key];
  }

  await saveButtonStyleMap(map);
}

function getStyleKey(type, id) {
  return `${type}:${id}`;
}

function parseStyleKey(styleKey) {
  const match = String(styleKey || '').match(/^(static|section|product):(.+)$/);
  if (!match) return null;
  return { type: match[1], id: match[2] };
}

function getStaticStyleKeyFromCallback(callbackData) {
  const callbackKey = callbackData === 'admin' ? 'admin_panel' : String(callbackData || '').trim();
  if (Object.prototype.hasOwnProperty.call(DEFAULT_BUTTONS, callbackKey)) {
    return getStyleKey('static', callbackKey);
  }
  return '';
}

function getSectionIdFromButtonCallback(callbackData) {
  const match = String(callbackData || '').match(/^(?:admin_)?digital_section_(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}

function getProductIdFromButtonCallback(callbackData) {
  const match = String(callbackData || '').match(/^(?:admin_)?digital_product_(\d+)$|^digital_buy_(\d+)$/);
  if (!match) return null;
  return parseInt(match[1] || match[2], 10);
}

function getButtonStyleLookupKeys(button) {
  const callbackData = String(button?.callback_data || '').trim();
  const keys = [];

  const staticKey = getStaticStyleKeyFromCallback(callbackData);
  if (staticKey) keys.push(staticKey);

  const sectionId = getSectionIdFromButtonCallback(callbackData);
  if (Number.isInteger(sectionId)) keys.push(getStyleKey('section', sectionId));

  const productId = getProductIdFromButtonCallback(callbackData);
  if (Number.isInteger(productId)) keys.push(getStyleKey('product', productId));

  return keys;
}

async function getAutomaticButtonStyle(button) {
  const callbackData = String(button?.callback_data || '').trim();

  if (callbackData === 'deposit') {
    return 'primary';
  }

  const productId = getProductIdFromButtonCallback(callbackData);
  if (!Number.isInteger(productId)) return '';

  const merchant = await Merchant.findByPk(productId);
  if (!merchant || !isDigitalSectionCategory(merchant.category)) return '';

  const stock = await getMerchantAvailableStock(productId);
  return stock <= 0 ? 'danger' : 'success';
}

async function applyButtonStylesToReplyMarkup(chatId, replyMarkup) {
  try {
    if (!replyMarkup || (!Array.isArray(replyMarkup.inline_keyboard) && !Array.isArray(replyMarkup.keyboard))) {
      return replyMarkup;
    }

    const styleMap = await getButtonStyleMap();
    const cloned = JSON.parse(JSON.stringify(replyMarkup));
    const keyboards = [];
    if (Array.isArray(cloned.inline_keyboard)) keyboards.push(cloned.inline_keyboard);
    if (Array.isArray(cloned.keyboard)) keyboards.push(cloned.keyboard);

    for (const keyboard of keyboards) {
      for (const row of keyboard) {
        if (!Array.isArray(row)) continue;
        for (const button of row) {
          if (!button || typeof button !== 'object') continue;

          const automaticStyle = await getAutomaticButtonStyle(button);
          const configuredStyle = getButtonStyleLookupKeys(button)
            .map(key => normalizeTelegramButtonStyle(styleMap[key]))
            .find(Boolean) || '';
          const style = automaticStyle || configuredStyle;

          if (style) {
            button.style = style;
          }
        }
      }
    }

    return cloned;
  } catch (err) {
    console.error('applyButtonStylesToReplyMarkup error:', err);
    return replyMarkup;
  }
}

async function getFeaturedDigitalProductIds() {
  const rawValue = await getGlobalSetting('featured_digital_products', '[]');
  try {
    const parsed = JSON.parse(String(rawValue || '[]'));
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map(id => parseInt(id, 10)).filter(Number.isInteger))];
  } catch {
    return [];
  }
}

async function saveFeaturedDigitalProductIds(ids) {
  const normalized = [...new Set((Array.isArray(ids) ? ids : []).map(id => parseInt(id, 10)).filter(Number.isInteger))];
  await Setting.upsert({
    key: 'featured_digital_products',
    lang: 'global',
    value: JSON.stringify(normalized)
  });
}

async function isFeaturedDigitalProduct(merchantId) {
  const ids = await getFeaturedDigitalProductIds();
  return ids.includes(parseInt(merchantId, 10));
}

async function toggleFeaturedDigitalProduct(merchantId) {
  const normalizedId = parseInt(merchantId, 10);
  if (!Number.isInteger(normalizedId)) return false;

  const ids = await getFeaturedDigitalProductIds();
  const exists = ids.includes(normalizedId);
  const nextIds = exists ? ids.filter(id => id !== normalizedId) : [...ids, normalizedId];
  await saveFeaturedDigitalProductIds(nextIds);
  return !exists;
}

async function getFeaturedDigitalProductsForMenu() {
  const ids = await getFeaturedDigitalProductIds();
  if (!ids.length) return [];

  const products = await Merchant.findAll({
    where: { id: { [Op.in]: ids } },
    order: [['id', 'ASC']]
  });
  const sections = await getDigitalSections();
  const activeSectionIds = new Set(sections.map(section => section.id));
  const hiddenProductIds = new Set(await getHiddenDigitalProductIds());
  const productById = new Map(products.map(product => [product.id, product]));
  const ordered = [];

  for (const id of ids) {
    const product = productById.get(id);
    if (!product || !isDigitalSectionCategory(product.category)) continue;
    if (hiddenProductIds.has(product.id)) continue;
    const sectionId = parseDigitalSectionIdFromCategory(product.category);
    if (!activeSectionIds.has(sectionId)) continue;
    ordered.push(product);
  }

  return ordered;
}


async function getHiddenDigitalProductIds() {
  const rawValue = await getGlobalSetting('hidden_digital_products', '[]');
  try {
    const parsed = JSON.parse(String(rawValue || '[]'));
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map(id => parseInt(id, 10)).filter(Number.isInteger))];
  } catch {
    return [];
  }
}

async function saveHiddenDigitalProductIds(ids) {
  const normalized = [...new Set((Array.isArray(ids) ? ids : []).map(id => parseInt(id, 10)).filter(Number.isInteger))];
  await Setting.upsert({
    key: 'hidden_digital_products',
    lang: 'global',
    value: JSON.stringify(normalized)
  });
}

async function isDigitalProductHidden(merchantId) {
  const ids = await getHiddenDigitalProductIds();
  return ids.includes(parseInt(merchantId, 10));
}

async function setDigitalProductVisibility(merchantId, visible) {
  const normalizedId = parseInt(merchantId, 10);
  if (!Number.isInteger(normalizedId)) return false;

  const merchant = await Merchant.findByPk(normalizedId);
  if (!merchant || !isDigitalSectionCategory(merchant.category)) return false;

  const ids = await getHiddenDigitalProductIds();
  const exists = ids.includes(normalizedId);
  const nextIds = visible
    ? ids.filter(id => id !== normalizedId)
    : (exists ? ids : [...ids, normalizedId]);

  await saveHiddenDigitalProductIds(nextIds);
  return true;
}

async function getVisibleDigitalProductsForSection(sectionId) {
  const products = await getDigitalProductsForSection(sectionId);
  const hiddenProductIds = new Set(await getHiddenDigitalProductIds());
  return products.filter(product => !hiddenProductIds.has(product.id));
}

async function applyCustomEmojiIconsToReplyMarkup(chatId, replyMarkup) {
  try {
    if (!replyMarkup || (!Array.isArray(replyMarkup.inline_keyboard) && !Array.isArray(replyMarkup.keyboard))) {
      return replyMarkup;
    }

    const user = await User.findByPk(chatId);
    const lang = user?.lang === 'ar' ? 'ar' : 'en';
    const map = await getButtonCustomEmojiMap();
    const lookup = {};

    for (const key of Object.keys(map || {})) {
      const iconId = map[key]?.[lang] || map[key]?.ar || map[key]?.en || '';
      if (!iconId) continue;
      lookup[key] = iconId;
      const label = normalizeButtonLabel(await getTextByLang(key, lang));
      if (label) {
        lookup[label] = iconId;
      }
    }

    const cloned = JSON.parse(JSON.stringify(replyMarkup));
    const keyboards = [];
    if (Array.isArray(cloned.inline_keyboard)) keyboards.push(cloned.inline_keyboard);
    if (Array.isArray(cloned.keyboard)) keyboards.push(cloned.keyboard);

    for (const keyboard of keyboards) {
      for (const row of keyboard) {
        if (!Array.isArray(row)) continue;
        for (const button of row) {
          if (!button || typeof button !== 'object' || button.icon_custom_emoji_id) continue;
          const callbackKey = button.callback_data === 'admin' ? 'admin_panel' : String(button.callback_data || '').trim();
          const iconId = lookup[callbackKey] || lookup[normalizeButtonLabel(button.text)];
          if (iconId) {
            button.icon_custom_emoji_id = iconId;
          }
        }
      }
    }

    return cloned;
  } catch (err) {
    console.error('applyCustomEmojiIconsToReplyMarkup error:', err);
    return replyMarkup;
  }
}

async function decorateSendOptions(chatId, options = {}) {
  if (!options || !options.reply_markup) return options;
  const withIcons = await applyCustomEmojiIconsToReplyMarkup(chatId, options.reply_markup);
  const withStyles = await applyButtonStylesToReplyMarkup(chatId, withIcons);
  return {
    ...options,
    reply_markup: withStyles
  };
}

const originalBotSendMessage = bot.sendMessage.bind(bot);
bot.sendMessage = async function patchedSendMessage(chatId, messageText, options = {}) {
  return originalBotSendMessage(chatId, messageText, await decorateSendOptions(chatId, options));
};

const originalBotSendPhoto = bot.sendPhoto.bind(bot);
bot.sendPhoto = async function patchedSendPhoto(chatId, photo, options = {}) {
  return originalBotSendPhoto(chatId, photo, await decorateSendOptions(chatId, options));
};

const originalBotSendVideo = bot.sendVideo.bind(bot);
bot.sendVideo = async function patchedSendVideo(chatId, video, options = {}) {
  return originalBotSendVideo(chatId, video, await decorateSendOptions(chatId, options));
};

const originalBotEditMessageText = bot.editMessageText.bind(bot);
bot.editMessageText = async function patchedEditMessageText(messageText, options = {}) {
  const chatId = options?.chat_id;
  return originalBotEditMessageText(messageText, chatId ? await decorateSendOptions(chatId, options) : options);
};

const originalBotEditMessageCaption = bot.editMessageCaption.bind(bot);
bot.editMessageCaption = async function patchedEditMessageCaption(caption, options = {}) {
  const chatId = options?.chat_id;
  return originalBotEditMessageCaption(caption, chatId ? await decorateSendOptions(chatId, options) : options);
};

async function getGlobalSetting(key, defaultValue) {
  const setting = await Setting.findOne({ where: { key, lang: 'global' } });
  if (!setting) return defaultValue;
  return setting.value;
}

async function getCodeDeliveryMessage(userId) {
  const user = await User.findByPk(userId);
  const lang = user?.lang || 'en';
  const setting = await Setting.findOne({ where: { key: 'code_delivery_message', lang } });
  return setting?.value || '';
}

async function getCodeDeliveryPrefixHtml(userId) {
  const customMessage = String(await getCodeDeliveryMessage(userId) || '').trim();
  if (!customMessage) return '';
  return `${escapeHtml(customMessage)}\n\n`;
}

async function broadcastAnnouncement(messageText) {
  const users = await User.findAll({ attributes: ['id', 'lang'] });
  let sent = 0;
  let failed = 0;

  for (const u of users) {
    try {
      const localizedText = await translateTextForLang(u.lang || 'en', messageText);
      await bot.sendMessage(u.id, localizedText || messageText);
      sent += 1;
    } catch {
      failed += 1;
    }
  }

  return { sent, failed };
}

async function getDigitalStockBroadcastEnabled() {
  const rawValue = await getGlobalSetting('digital_stock_broadcast_enabled', 'false');
  return String(rawValue).toLowerCase() === 'true';
}

async function broadcastDigitalStockAdded(merchant, addedCount) {
  const enabled = await getDigitalStockBroadcastEnabled();
  const normalizedCount = parseInt(addedCount, 10);

  if (!enabled || !merchant || !Number.isInteger(normalizedCount) || normalizedCount <= 0) {
    return { sent: 0, failed: 0, skipped: true };
  }

  const users = await User.findAll({ attributes: ['id', 'lang'] });
  let sent = 0;
  let failed = 0;

  for (const u of users) {
    try {
      const lang = u.lang === 'ar' ? 'ar' : 'en';
      const template = DEFAULT_TEXTS[lang]?.digitalStockBroadcastMessage || DEFAULT_TEXTS.en.digitalStockBroadcastMessage;
      const productName = lang === 'ar'
        ? (merchant.nameAr || merchant.nameEn || '-')
        : (merchant.nameEn || merchant.nameAr || '-');
      const messageText = template
        .replace(/\{name\}/g, String(productName))
        .replace(/\{count\}/g, String(normalizedCount))
        .replace(/\{price\}/g, formatUsdPrice(merchant.price));

      await bot.sendMessage(u.id, messageText);
      sent += 1;
    } catch (err) {
      failed += 1;
    }
  }

  return { sent, failed, skipped: false };
}

async function getReferralPercent() {
  const rawValue = await getGlobalSetting('referral_percent', process.env.REFERRAL_PERCENT || '10');
  const value = parseFloat(rawValue);
  return Number.isFinite(value) && value >= 0 ? value : 10;
}

async function getReferralRedeemPoints() {
  const rawValue = await getGlobalSetting('referral_redeem_points', '10');
  const value = parseInt(rawValue, 10);
  return Number.isInteger(value) && value > 0 ? value : 10;
}

async function getFreeCodeCooldownDays() {
  const rawValue = await getGlobalSetting('free_code_cooldown_days', '5');
  const value = parseInt(rawValue, 10);
  return Number.isInteger(value) && value > 0 ? value : 5;
}

async function getActiveFreeCodeRenewalVersion() {
  const rawVersion = await getGlobalSetting('free_code_renewal_version', '0');
  const version = Math.max(0, parseInt(rawVersion, 10) || 0);
  const rawExpiresAt = String(await getGlobalSetting('free_code_renewal_expires_at', '') || '').trim();

  if (!version || !rawExpiresAt) return 0;

  const expiresAt = new Date(rawExpiresAt);
  if (Number.isNaN(expiresAt.getTime())) return 0;

  return expiresAt.getTime() > Date.now() ? version : 0;
}

async function getBotEnabled() {
  const rawValue = await getGlobalSetting('bot_enabled', 'true');
  return String(rawValue).toLowerCase() !== 'false';
}

async function getAiAssistantEnabled() {
  const rawValue = await getGlobalSetting('ai_assistant_enabled', 'true');
  return String(rawValue).toLowerCase() !== 'false';
}

async function setAiAssistantEnabled(enabled) {
  await Setting.upsert({
    key: 'ai_assistant_enabled',
    lang: 'global',
    value: enabled ? 'true' : 'false'
  });
}

async function getAllowedUserIds() {
  const rawValue = await getGlobalSetting('bot_allowed_user_ids', '');
  return String(rawValue || '')
    .split(/[\s,]+/)
    .map(v => parseInt(v, 10))
    .filter(v => Number.isInteger(v) && v > 0);
}

async function isUserAllowedWhenBotStopped(userId) {
  if (isAdmin(userId)) return true;
  const ids = await getAllowedUserIds();
  return ids.includes(Number(userId));
}

async function getReferralEnabled() {
  const rawValue = await getGlobalSetting('referral_enabled', 'true');
  return String(rawValue).toLowerCase() !== 'false';
}

async function getReferralStockMerchant() {
  let merchant = await Merchant.findOne({ where: { nameEn: 'ChatGPT Referral Stock' } });
  if (!merchant) {
    merchant = await Merchant.create({
      nameEn: 'ChatGPT Referral Stock',
      nameAr: 'مخزون ChatGPT الإحالات',
      price: 0,
      category: 'AI Services',
      type: 'single',
      description: { type: 'text', content: 'Referral-only ChatGPT stock' }
    });
  }
  return merchant;
}

async function getReferralStockDuplicateRows() {
  const merchant = await getReferralStockMerchant();
  const rows = await Code.findAll({
    where: { merchantId: merchant.id, isUsed: false },
    order: [['id', 'ASC']]
  });

  const seen = new Map();
  const duplicates = [];
  for (const row of rows) {
    const key = `${String(row.value || '').trim()}\n${String(row.extra || '').trim()}`;
    if (!seen.has(key)) {
      seen.set(key, row.id);
    } else {
      duplicates.push(row);
    }
  }

  return duplicates;
}

function formatDuplicateCodesForAdmin(rows, limit = 40) {
  const sliced = rows.slice(0, limit);
  let output = sliced.map((row, i) => {
    const body = row.extra ? `${row.value}\n${row.extra}` : `${row.value}`;
    return `${i + 1}) ${body}`;
  }).join('\n\n');

  if (rows.length > limit) {
    output += `\n\n... +${rows.length - limit} more`;
  }

  return output || '-';
}

async function deleteReferralStockDuplicateRows() {
  const duplicates = await getReferralStockDuplicateRows();
  if (!duplicates.length) return { count: 0 };

  const ids = duplicates.map(row => row.id);
  await Code.destroy({ where: { id: ids } });
  return { count: ids.length };
}



function normalizeChatGptUpCode(rawValue) {
  const cleaned = String(rawValue || '').trim();
  const match = cleaned.match(/(?:https?:\/\/)?(?:www\.)?chatgpt\.com\/up\/([A-Za-z0-9]{16})(?=(?:https?:\/\/)?(?:www\.)?chatgpt\.com\/up\/|[^A-Za-z0-9]|$)/i);
  if (!match) return '';
  return `http://www.chatgpt.com/up/${String(match[1]).toUpperCase()}`;
}

function extractChatGptUpCodes(textValue) {
  const text = String(textValue || '');
  const regex = /(?:https?:\/\/)?(?:www\.)?chatgpt\.com\/up\/([A-Za-z0-9]{16})(?=(?:https?:\/\/)?(?:www\.)?chatgpt\.com\/up\/|[^A-Za-z0-9]|$)/ig;
  const found = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    found.push(`http://www.chatgpt.com/up/${String(match[1]).toUpperCase()}`);
  }
  return [...new Set(found)];
}


function chunkArray(input, size) {
  const arr = Array.isArray(input) ? input : [];
  const chunkSize = Math.max(1, parseInt(size, 10) || 100);
  const out = [];
  for (let i = 0; i < arr.length; i += chunkSize) {
    out.push(arr.slice(i, i + chunkSize));
  }
  return out;
}

function getReferralStockInputReplyMarkup() {
  return {
    inline_keyboard: [
      [{ text: 'تــــــم', callback_data: 'admin_finish_add_referral_stock_codes' }]
    ]
  };
}

async function takeExactReferralStockCodes(userId, quantity) {
  const count = Math.max(0, parseInt(quantity, 10) || 0);
  if (count <= 0) return { codes: [], remainingStock: 0 };

  const merchant = await getReferralStockMerchant();
  const rows = await Code.findAll({
    where: { merchantId: merchant.id, isUsed: false },
    order: [['id', 'ASC']],
    limit: Math.max(count * 5, 200)
  });

  const selectedCodes = [];
  const rowIdsToConsume = [];
  const leftoverCodes = [];

  for (const row of rows) {
    if (selectedCodes.length >= count) break;

    let extracted = extractChatGptUpCodes(`${String(row.value || '')}\n${String(row.extra || '')}`);
    if (!extracted.length) {
      const single = normalizeChatGptUpCode(row.value);
      if (single) extracted = [single];
    }

    if (!extracted.length) continue;

    rowIdsToConsume.push(row.id);

    const needed = count - selectedCodes.length;
    selectedCodes.push(...extracted.slice(0, needed));
    leftoverCodes.push(...extracted.slice(needed));
  }

  if (selectedCodes.length < count) {
    return { codes: [], remainingStock: await Code.count({ where: { merchantId: merchant.id, isUsed: false } }) };
  }

  const t = await sequelize.transaction();
  try {
    await Code.update(
      { isUsed: true, usedBy: userId, soldAt: new Date() },
      { where: { id: rowIdsToConsume }, transaction: t }
    );

    if (leftoverCodes.length) {
      const dedupLeftovers = [...new Set(leftoverCodes.map(normalizeChatGptUpCode).filter(Boolean))];
      if (dedupLeftovers.length) {
        await Code.bulkCreate(
          dedupLeftovers.map(value => ({ value, merchantId: merchant.id, isUsed: false })),
          { transaction: t }
        );
      }
    }

    await t.commit();
    const remainingStock = await Code.count({ where: { merchantId: merchant.id, isUsed: false } });
    return { codes: selectedCodes, remainingStock };
  } catch (err) {
    await t.rollback();
    console.error('takeExactReferralStockCodes error:', err);
    return { codes: [], remainingStock: 0 };
  }
}

async function cachePrivateChannelPostMessage(message) {
  try {
    const content = String(message.text || message.caption || '').trim();
    if (!content) return false;

    const extractedCodes = extractChatGptUpCodes(content);
    if (!extractedCodes.length) return false;

    const config = await getReferralCodesChannelConfig();

    if (!config.chatId) {
      if (!config.enabled) return false;
      await savePrivateCodesChannelConfig({
        ...config,
        enabled: true,
        chatId: String(message?.chat?.id || ''),
        title: message?.chat?.title || config.title || '',
        username: message?.chat?.username ? `@${message.chat.username}` : (config.username || '')
      });
    } else if (String(message?.chat?.id || '') !== String(config.chatId)) {
      return false;
    }

    await PrivateChannelCodePostCache.upsert({
      channelChatId: String(message.chat.id),
      messageId: Number(message.message_id),
      content,
      isCaption: Boolean(message.caption && !message.text),
      extractedCodes
    });
    return true;
  } catch (err) {
    console.error('cachePrivateChannelPostMessage error:', err);
    return false;
  }
}

async function cacheReferralCodesChannelPostMessage(message) {
  try {
    const content = String(message.text || message.caption || '').trim();
    if (!content) return false;

    const extractedCodes = extractChatGptUpCodes(content);
    if (!extractedCodes.length) return false;

    const config = await getReferralCodesChannelConfig();

    if (!config.chatId) {
      if (!config.enabled) return false;
      await saveReferralCodesChannelConfig({
        ...config,
        enabled: true,
        chatId: String(message?.chat?.id || ''),
        title: message?.chat?.title || config.title || '',
        username: message?.chat?.username ? `@${message.chat.username}` : (config.username || '')
      });
    } else if (String(message?.chat?.id || '') !== String(config.chatId)) {
      return false;
    }

    await PrivateChannelCodePostCache.upsert({
      channelChatId: String(message.chat.id),
      messageId: Number(message.message_id),
      content,
      isCaption: Boolean(message.caption && !message.text),
      extractedCodes
    });
    return true;
  } catch (err) {
    console.error('cacheReferralCodesChannelPostMessage error:', err);
    return false;
  }
}

async function markPrivateChannelPostImported(chatId, messageId, originalContent, isCaption = false) {
  const note = '✅ تم نقله الى المخزون';
  const content = String(originalContent || '').trim();
  if (!content || content.includes(note)) return false;

  const updated = `${content}\n\n${note}`;
  try {
    if (isCaption) {
      await bot.editMessageCaption(updated, { chat_id: chatId, message_id: messageId });
    } else {
      await bot.editMessageText(updated, { chat_id: chatId, message_id: messageId });
    }
    return true;
  } catch (err) {
    console.error('markPrivateChannelPostImported error:', err.response?.body || err.message);
    return false;
  }
}

async function importReferralStockCodesFromPrivateChannel() {
  const config = await getReferralCodesChannelConfig();
  if (!config.enabled || !config.chatId) {
    return { success: false, reason: 'channel_not_configured' };
  }

  const cachedPosts = await PrivateChannelCodePostCache.findAll({
    where: { channelChatId: String(config.chatId) },
    order: [['messageId', 'DESC']],
    limit: 500
  });

  if (!cachedPosts.length) {
    return { success: false, reason: 'no_posts' };
  }

  const merchant = await getReferralStockMerchant();
  const toCreate = [];
  const perPostImported = new Map();

  for (const post of cachedPosts) {
    const extracted = Array.isArray(post.extractedCodes) && post.extractedCodes.length ? post.extractedCodes : extractChatGptUpCodes(post.content || '');
    let addedForPost = 0;

    for (const code of extracted) {
      const normalized = normalizeChatGptUpCode(code);
      if (!normalized) continue;

      toCreate.push({ value: normalized, merchantId: merchant.id, isUsed: false });
      addedForPost += 1;
    }

    if (addedForPost > 0) {
      perPostImported.set(post.id, addedForPost);
    }
  }

  if (!toCreate.length) {
    return { success: false, reason: 'no_codes', posts: cachedPosts.length, duplicates: 0 };
  }

  await Code.bulkCreate(toCreate);

  for (const post of cachedPosts) {
    const importedCount = perPostImported.get(post.id) || 0;
    if (importedCount > 0) {
      await PrivateChannelCodePostCache.update(
        { importedAt: new Date(), importedCount: Number(post.importedCount || 0) + importedCount },
        { where: { id: post.id } }
      );
      await markPrivateChannelPostImported(post.channelChatId, post.messageId, post.content, post.isCaption);
    }
  }

  return {
    success: true,
    added: toCreate.length,
    duplicates: skippedDuplicates,
    posts: cachedPosts.length
  };
}

async function deleteReferralStockCodesByInput(inputText) {
  const merchant = await getReferralStockMerchant();
  const codeLinks = extractChatGptUpCodes(inputText || '');
  let values = codeLinks;

  if (!values.length) {
    values = String(inputText || '')
      .split(/\r?\n+/)
      .map(v => v.trim())
      .filter(Boolean)
      .map(normalizeChatGptUpCode);
  }

  values = [...new Set(values.filter(Boolean))];
  if (!values.length) {
    return { deleted: 0, missing: 0, details: '-' };
  }

  const rows = await Code.findAll({
    where: {
      merchantId: merchant.id,
      value: { [Op.in]: values }
    }
  });

  const foundSet = new Set(rows.map(row => normalizeChatGptUpCode(row.value)));
  const missingValues = values.filter(v => !foundSet.has(v));

  if (rows.length) {
    await Code.destroy({ where: { id: rows.map(row => row.id) } });
  }

  let details = '';
  if (missingValues.length) {
    details = missingValues.slice(0, 30).join('\n');
    if (missingValues.length > 30) {
      details += `\n... +${missingValues.length - 30} more`;
    }
  } else {
    details = '-';
  }

  return {
    deleted: rows.length,
    missing: missingValues.length,
    details
  };
}


async function getSuccessfulReferralCount(userId) {
  return await User.count({ where: { referredBy: userId, referralRewarded: true } });
}

async function getRedeemableReferralCodesCount(userId) {
  const user = await User.findByPk(userId);
  if (!user) return 0;
  const referralCount = await getSuccessfulReferralCount(userId);
  if (referralCount <= 0) return 0;
  const requiredPoints = await getEffectiveRedeemPointsForUser(userId);
  return Math.floor(Number(user.referralPoints || 0) / requiredPoints);
}

async function getEligibleReferralUsers(minReferrals = 1) {
  const result = [];
  for (const user of await User.findAll({ order: [['referralPoints', 'DESC'], ['id', 'ASC']] })) {
    const referralCount = await getSuccessfulReferralCount(user.id);
    const requiredPoints = await getEffectiveRedeemPointsForUser(user.id);
    const redeemableCodes = referralCount > 0 ? Math.floor(Number(user.referralPoints || 0) / requiredPoints) : 0;
    if (referralCount >= minReferrals && redeemableCodes > 0) {
      result.push({
        user,
        referralCount,
        redeemableCodes,
        adminGranted: Number(user.adminGrantedPoints || 0),
        totalPoints: Number(user.referralPoints || 0),
        milestoneRewards: Number(user.referralMilestoneGrantedPoints || 0),
        claimedCodes: Number(user.referralStockClaimedCodes || 0)
      });
    }
  }
  return result;
}

async function claimReferralStockCodes(userId, requestedCodes) {
  const user = await User.findByPk(userId);
  if (!user) return { success: false, reason: 'User not found' };

  const referralCount = await getSuccessfulReferralCount(userId);
  if (referralCount <= 0) {
    return { success: false, reason: 'no_referrals' };
  }

  const requiredPoints = await getEffectiveRedeemPointsForUser(userId);
  const maxCodes = Math.floor(Number(user.referralPoints || 0) / requiredPoints);
  const count = parseInt(requestedCodes, 10);
  if (!Number.isInteger(count) || count <= 0 || count > maxCodes) {
    return { success: false, reason: 'invalid_count', maxCodes };
  }

  const claimedBefore = Number(user.referralStockClaimedCodes || 0);
  const takeResult = await takeExactReferralStockCodes(userId, count);
  if (!takeResult.codes.length || takeResult.codes.length < count) {
    return { success: false, reason: 'not_enough_stock' };
  }

  const t = await sequelize.transaction();
  try {
    user.referralPoints = Number(user.referralPoints || 0) - (count * requiredPoints);
    user.referralStockClaimedCodes = claimedBefore + count;
    await user.save({ transaction: t });
    await t.commit();

    const codeText = takeResult.codes.join('\n\n');
    return {
      success: true,
      codes: codeText,
      count,
      claimedBefore,
      claimedAfter: Number(user.referralStockClaimedCodes || 0),
      eligibleNow: Math.floor(Number(user.referralPoints || 0) / requiredPoints),
      points: Number(user.referralPoints || 0),
      adminGranted: Number(user.adminGrantedPoints || 0),
      referralCount,
      milestoneRewards: Number(user.referralMilestoneGrantedPoints || 0),
      remainingStock: takeResult.remainingStock
    };
  } catch (err) {
    await t.rollback();
    console.error('claimReferralStockCodes error:', err);
    return { success: false, reason: 'db_error' };
  }
}

async function takeFallbackChatGptCodesFromReferralStock(userId, quantity) {
  const count = Math.max(0, parseInt(quantity, 10) || 0);
  if (count <= 0) return [];
  const result = await takeExactReferralStockCodes(userId, count);
  return result.codes || [];
}

async function getBulkDiscountThreshold() {
  const rawValue = await getGlobalSetting('bulk_discount_threshold', '50');
  const value = parseInt(rawValue, 10);
  return Number.isInteger(value) && value > 0 ? value : 50;
}

async function getBulkDiscountPrice() {
  const rawValue = await getGlobalSetting('bulk_discount_price', '1');
  const value = parseFloat(rawValue);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

async function getBulkDiscountInfoText(userId) {
  const threshold = await getBulkDiscountThreshold();
  const price = await getBulkDiscountPrice();
  return getText(userId, 'bulkDiscountInfo', { threshold, price });
}

async function getReferralMilestones() {
  const rawValue = await getGlobalSetting('referral_milestones', '15:5,40:5,80:10,150:30');
  const parsed = {};
  for (const part of String(rawValue).split(',')) {
    const [referralsStr, pointsStr] = part.split(':').map(v => String(v || '').trim());
    const referrals = parseInt(referralsStr, 10);
    const points = parseInt(pointsStr, 10);
    if (Number.isInteger(referrals) && referrals > 0 && Number.isInteger(points) && points > 0) {
      parsed[referrals] = points;
    }
  }
  if (!Object.keys(parsed).length) {
    return { 15: 5, 40: 5, 80: 10, 150: 30 };
  }
  return parsed;
}

async function getReferralMilestonesText() {
  const milestones = await getReferralMilestones();
  return Object.entries(milestones)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([count, bonus]) => `${count}:${bonus}`)
    .join(', ');
}

async function getReferralMilestoneBonus(referralCount) {
  const milestones = await getReferralMilestones();
  return Number(milestones[String(referralCount)] || 0);
}

async function getCumulativeReferralMilestonePoints(referralCount) {
  const milestones = await getReferralMilestones();
  return Object.entries(milestones)
    .filter(([count]) => Number(referralCount) >= Number(count))
    .reduce((sum, [, bonus]) => sum + Number(bonus || 0), 0);
}

async function getEffectiveRedeemPointsForUser(userId) {
  const basePoints = await getReferralRedeemPoints();
  const user = await User.findByPk(userId);
  const discountPercent = Math.max(0, Math.min(100, parseInt(user?.creatorDiscountPercent || 0, 10) || 0));
  if (discountPercent <= 0) return basePoints;
  return Math.max(1, Math.ceil(basePoints * (100 - discountPercent) / 100));
}

async function canUserClaimFreeCode(userId) {
  const user = await User.findByPk(userId);
  if (!user) return false;
  if (user.forceFreeCodeButton) return true;

  const activeRenewalVersion = await getActiveFreeCodeRenewalVersion();
  if (activeRenewalVersion > Number(user.freeCodeRenewalVersionClaimed || 0)) {
    return true;
  }

  if (!user.lastFreeCodeClaimAt) return true;
  const cooldownDays = await getFreeCodeCooldownDays();
  const nextAllowedAt = new Date(new Date(user.lastFreeCodeClaimAt).getTime() + (cooldownDays * 24 * 60 * 60 * 1000));
  return Date.now() >= nextAllowedAt.getTime();
}

async function shouldShowFreeCodeButton(userId) {
  const user = await User.findByPk(userId);
  if (!user) return false;
  if (user.forceFreeCodeButton) return true;

  const activeRenewalVersion = await getActiveFreeCodeRenewalVersion();
  if (activeRenewalVersion > Number(user.freeCodeRenewalVersionClaimed || 0)) {
    return true;
  }

  return (await canUserClaimFreeCode(userId)) && !user.freeChatgptReceived;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatCodesForHtml(codeTextOrArray) {
  const codes = Array.isArray(codeTextOrArray)
    ? codeTextOrArray
    : String(codeTextOrArray || '').split(/\n\n+/).filter(Boolean);
  return codes.map(code => `<code>${escapeHtml(code)}</code>`).join('\n\n');
}

async function getPerCodePriceForQuantity(basePrice, quantity) {
  const safeBasePrice = parseFloat(basePrice) || 0;
  const safeQty = parseInt(quantity, 10) || 0;
  const threshold = await getBulkDiscountThreshold();
  const discountPrice = await getBulkDiscountPrice();
  if (safeQty >= threshold && safeBasePrice > discountPrice) return discountPrice;
  return safeBasePrice;
}

function formatUsdPrice(value) {
  const numeric = parseFloat(value);
  if (!Number.isFinite(numeric)) return '0';
  return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(2).replace(/\.00$/, '');
}

function getDigitalSectionCategory(sectionId) {
  return `digital_section_${parseInt(sectionId, 10)}`;
}

function parseDigitalSectionIdFromCategory(category) {
  const match = String(category || '').match(/^digital_section_(\d+)$/i);
  return match ? parseInt(match[1], 10) : null;
}

function isDigitalSectionCategory(category) {
  return Number.isInteger(parseDigitalSectionIdFromCategory(category));
}

async function getDigitalSections(options = {}) {
  const { includeInactive = false } = options;
  const where = includeInactive ? {} : { isActive: true };
  return await DigitalSection.findAll({
    where,
    order: [['sortOrder', 'ASC'], ['id', 'ASC']]
  });
}

async function getAllDigitalSections() {
  return await getDigitalSections({ includeInactive: true });
}

async function getDigitalSectionDisplayName(section, userId) {
  const user = await User.findByPk(userId);
  const lang = user?.lang === 'ar' ? 'ar' : 'en';
  const preferred = lang === 'ar' ? (section?.nameAr || '') : (section?.nameEn || '');
  const fallback = lang === 'ar' ? (section?.nameEn || '') : (section?.nameAr || '');
  if (preferred) return preferred;
  return fallback ? await translateTextForLang(lang, fallback) : '';
}

async function getMerchantDisplayName(merchant, userId) {
  const user = await User.findByPk(userId);
  const lang = user?.lang === 'ar' ? 'ar' : 'en';
  const preferred = lang === 'ar' ? (merchant?.nameAr || '') : (merchant?.nameEn || '');
  const fallback = lang === 'ar' ? (merchant?.nameEn || '') : (merchant?.nameAr || '');
  if (preferred) return preferred;
  return fallback ? await translateTextForLang(lang, fallback) : '';
}

async function getMerchantAvailableStock(merchantId) {
  return await Code.count({ where: { merchantId, isUsed: false } });
}

async function getDigitalProductsForSection(sectionId) {
  return await Merchant.findAll({
    where: { category: getDigitalSectionCategory(sectionId) },
    order: [['id', 'ASC']]
  });
}

async function getChatGptDiscountThreshold() {
  return 20;
}

async function getChatGptDiscountPrice() {
  return 1;
}

async function getChatGptUnitPrice(quantity) {
  const merchant = await getOrCreateChatGptMerchant();
  const basePrice = parseFloat(merchant?.price || 0) || 0;
  const threshold = await getChatGptDiscountThreshold();
  const discountPrice = await getChatGptDiscountPrice();
  if ((parseInt(quantity, 10) || 0) >= threshold && basePrice > discountPrice) {
    return discountPrice;
  }
  return basePrice;
}

async function getChatGptPriceValue() {
  const merchant = await getOrCreateChatGptMerchant();
  return parseFloat(merchant?.price || 0) || 0;
}

async function getChatGptMenuLabel(userId) {
  const baseLabel = await getText(userId, 'chatgptCode');
  const price = formatUsdPrice(await getChatGptPriceValue());
  return `${baseLabel} - ${price} USD`;
}

async function buildChatGptPurchaseInfoText(userId) {
  const fallbackMerchant = await getReferralStockMerchant();
  const stock = await Code.count({ where: { merchantId: fallbackMerchant.id, isUsed: false } });
  const price = formatUsdPrice(await getChatGptPriceValue());
  const title = escapeHtml(await getText(userId, 'chatgptCode'));

  return [
    `✨ <b>${title}</b>`,
    await getText(userId, 'chatgptStockLine', { stock }),
    await getText(userId, 'chatgptPriceLine', { price }),
    await getCurrentBalanceLineText(userId),
    await getText(userId, 'chatgptDiscountLine'),
    await getText(userId, 'chatgptDetailsLine'),
    await getText(userId, 'chatgptNoteLine'),
    '',
    await getText(userId, 'chatgptTermsTitle'),
    await getText(userId, 'chatgptTerms1'),
    await getText(userId, 'chatgptTerms2'),
    '',
    await getText(userId, 'chatgptAgreementLine')
  ].join('\n\n');
}

function getMerchantPlainDescription(merchant) {
  if (!merchant?.description) return '';
  if (merchant.description.type === 'text') return String(merchant.description.content || '').trim();
  return '';
}

async function showChatGptPurchaseInfo(userId) {
  const messageText = await buildChatGptPurchaseInfoText(userId);
  await bot.sendMessage(userId, messageText, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: await getText(userId, 'confirm'), callback_data: 'chatgpt_buy_accept' },
        { text: await getText(userId, 'cancel'), callback_data: 'cancel_action' }
      ]]
    }
  });
}

function truncateText(value, maxLength = 700) {
  const textValue = String(value || '');
  if (textValue.length <= maxLength) return textValue;
  return `${textValue.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatAdminDateTime(value) {
  if (!value) return '-';
  const parts = formatDateParts(value);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

async function getDigitalSectionStatusText(userId, section) {
  return await getText(userId, section?.isActive ? 'digitalSectionActive' : 'digitalSectionHidden');
}

async function getMerchantAdminDescriptionSummary(userId, merchant) {
  const plain = getMerchantPlainDescription(merchant);
  if (plain) return truncateText(plain, 700);
  if (merchant?.description?.type === 'photo' || merchant?.description?.type === 'video') {
    return await getText(userId, 'attachedDetailsNote');
  }
  return '-';
}

async function resequenceDigitalSections(sectionsInput = null) {
  const sections = Array.isArray(sectionsInput) && sectionsInput.length
    ? sectionsInput
    : await getAllDigitalSections();

  for (let i = 0; i < sections.length; i += 1) {
    const desired = i + 1;
    if (Number(sections[i].sortOrder) !== desired) {
      sections[i].sortOrder = desired;
      await sections[i].save();
    }
  }

  return sections;
}

async function moveDigitalSection(sectionId, direction) {
  return await moveMenuButton(getDigitalSectionCategory(sectionId), direction);
}

async function setDigitalSectionVisibility(sectionId, visible) {
  const section = await DigitalSection.findByPk(sectionId);
  if (!section) return false;
  section.isActive = Boolean(visible);
  await section.save();

  if (visible) {
    const entryId = getDigitalSectionCategory(sectionId);
    const order = await getMenuButtonsOrder();
    if (!order.includes(entryId)) {
      order.push(entryId);
      await setMenuButtonsOrder(order);
    }
  }

  return true;
}

function getMerchantStockCompositeKey(value, extra = '') {
  return `${String(value || '').trim()}\n${String(extra || '').trim()}`;
}

function buildMerchantStockRowText(rowOrEntry) {
  if (!rowOrEntry) return '';
  return rowOrEntry.extra ? `${rowOrEntry.value}\n${rowOrEntry.extra}` : String(rowOrEntry.value || '');
}

function parseMerchantStockEntries(merchant, rawInput) {
  const inputText = String(rawInput || '').trim();
  if (!inputText) return { error: 'empty' };

  if (merchant.type === 'bulk') {
    const lines = inputText.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
    const entries = [];
    const pairBuffer = [];

    for (const line of lines) {
      if (line.includes('|')) {
        const parsedLine = parseBulkStockPipeLine(line);
        if (!parsedLine) return { error: 'pair_mismatch' };
        entries.push(parsedLine);
      } else {
        pairBuffer.push(line);
      }
    }

    if (pairBuffer.length % 2 !== 0) return { error: 'pair_mismatch' };

    for (let i = 0; i < pairBuffer.length; i += 2) {
      entries.push({
        value: pairBuffer[i],
        extra: createStructuredBulkExtra(pairBuffer[i + 1])
      });
    }

    return { entries };
  }

  const values = inputText.split(/[\s\r\n]+/).map(v => v.trim()).filter(Boolean);
  return { entries: values.map(value => ({ value, extra: null })) };
}

async function addMerchantStockEntriesWithDedup(merchant, rawInput) {
  const parsed = parseMerchantStockEntries(merchant, rawInput);
  if (parsed.error) return { success: false, reason: parsed.error };

  const existingRows = await Code.findAll({
    where: { merchantId: merchant.id },
    attributes: ['value', 'extra']
  });

  const seen = new Set(existingRows.map(row => getMerchantStockCompositeKey(row.value, row.extra)));
  const toCreate = [];
  let duplicates = 0;

  for (const entry of parsed.entries) {
    const key = getMerchantStockCompositeKey(entry.value, entry.extra);
    if (!entry.value || seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    toCreate.push({
      value: entry.value,
      extra: entry.extra || null,
      merchantId: merchant.id,
      isUsed: false
    });
  }

  if (toCreate.length) {
    await Code.bulkCreate(toCreate);
  }

  return {
    success: true,
    added: toCreate.length,
    duplicates,
    inputCount: parsed.entries.length
  };
}

async function getMerchantDuplicateGroups(merchantId) {
  const rows = await Code.findAll({
    where: { merchantId },
    order: [['id', 'ASC']]
  });

  const groups = new Map();
  for (const row of rows) {
    const key = getMerchantStockCompositeKey(row.value, row.extra);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  return [...groups.entries()]
    .filter(([, groupRows]) => groupRows.length > 1)
    .map(([key, groupRows]) => ({
      key,
      rows: groupRows,
      text: buildMerchantStockRowText(groupRows[0]),
      total: groupRows.length,
      unused: groupRows.filter(row => !row.isUsed).length,
      used: groupRows.filter(row => row.isUsed).length
    }));
}

async function formatMerchantDuplicateGroups(userId, groups, limit = 20) {
  const availableLabel = await getText(userId, 'stockStatusAvailable');
  const soldLabel = await getText(userId, 'stockStatusSold');
  const sliced = groups.slice(0, limit);
  let output = sliced.map((group, index) => {
    return `${index + 1}) x${group.total} | ${availableLabel}: ${group.unused} | ${soldLabel}: ${group.used}\n${truncateText(group.text, 500)}`;
  }).join('\n\n');

  if (groups.length > limit) {
    output += `\n\n... +${groups.length - limit} more`;
  }

  return output || '-';
}

async function deleteMerchantDuplicateRows(merchantId) {
  const rows = await Code.findAll({
    where: { merchantId },
    order: [['id', 'ASC']]
  });

  const seen = new Set();
  const deletableIds = [];
  let locked = 0;

  for (const row of rows) {
    const key = getMerchantStockCompositeKey(row.value, row.extra);
    if (!seen.has(key)) {
      seen.add(key);
      continue;
    }

    if (row.isUsed) {
      locked += 1;
      continue;
    }

    deletableIds.push(row.id);
  }

  if (deletableIds.length) {
    await Code.destroy({ where: { id: deletableIds } });
  }

  return { count: deletableIds.length, locked };
}

async function sendDigitalProductStockPreview(userId, merchantId) {
  const merchant = await Merchant.findByPk(merchantId);
  if (!merchant) {
    await bot.sendMessage(userId, await getText(userId, 'error'));
    return;
  }

  const rows = await Code.findAll({
    where: { merchantId },
    order: [['id', 'ASC']]
  });

  if (!rows.length) {
    await bot.sendMessage(userId, await getText(userId, 'noDigitalProductStock'));
    return;
  }

  const displayName = `${merchant.nameEn} / ${merchant.nameAr}`;
  const availableLabel = await getText(userId, 'stockStatusAvailable');
  const soldLabel = await getText(userId, 'stockStatusSold');

  await bot.sendMessage(userId, await getText(userId, 'digitalStockViewTitle', {
    name: displayName,
    count: rows.length
  }));

  const entryBlocks = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    entryBlocks.push([
      await getText(userId, 'stockEntryLabel', { index: index + 1 }),
      await getText(userId, 'addedAtLine', { createdAt: formatAdminDateTime(row.createdAt) }),
      await getText(userId, 'stockStatusLine', { status: row.isUsed ? soldLabel : availableLabel }),
      `<code>${escapeHtml(buildMerchantStockRowText(row))}</code>`
    ].join('\n'));
  }

  for (const chunk of chunkArray(entryBlocks, 10)) {
    await bot.sendMessage(userId, chunk.join('\n\n'), { parse_mode: 'HTML' });
  }
}

async function deleteDigitalProductAndStock(merchantId) {
  await Code.destroy({ where: { merchantId } });
  await Merchant.destroy({ where: { id: merchantId } });
}

async function deleteDigitalSectionAndContent(sectionId) {
  const merchants = await getDigitalProductsForSection(sectionId);
  const merchantIds = merchants.map(merchant => merchant.id);

  if (merchantIds.length) {
    await Code.destroy({ where: { merchantId: { [Op.in]: merchantIds } } });
    await Merchant.destroy({ where: { id: { [Op.in]: merchantIds } } });
  }

  await DigitalSection.destroy({ where: { id: sectionId } });
  await resequenceDigitalSections();
}

async function showDigitalSubscriptionsAdmin(userId) {
  const sections = await getAllDigitalSections();
  const broadcastEnabled = await getDigitalStockBroadcastEnabled();
  const keyboard = [
    [{ text: await getText(userId, 'addDigitalSectionToMainMenu'), callback_data: 'admin_digital_add_section' }],
    [{ text: await getText(userId, broadcastEnabled ? 'digitalStockBroadcastToggleOn' : 'digitalStockBroadcastToggleOff'), callback_data: 'admin_toggle_digital_stock_broadcast' }]
  ];

  for (const section of sections) {
    keyboard.push([{
      text: `${section.isActive ? '✅' : '⛔'} 🧩 ${section.nameEn} / ${section.nameAr}`,
      callback_data: `admin_digital_section_${section.id}`
    }]);
  }

  keyboard.push([{ text: await getText(userId, 'back'), callback_data: 'admin' }]);

  await bot.sendMessage(userId, await getText(userId, 'digitalSubscriptionsChooseSection'), {
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function showDigitalSectionAdmin(userId, sectionId) {
  const section = await DigitalSection.findByPk(sectionId);
  if (!section) {
    await bot.sendMessage(userId, await getText(userId, 'error'));
    return;
  }

  const sectionName = `${section.nameEn} / ${section.nameAr}`;
  const products = await getDigitalProductsForSection(section.id);
  const statusText = await getDigitalSectionStatusText(userId, section);
  const keyboard = [
    [{ text: await getText(userId, 'addDigitalProductInSection', { name: sectionName }), callback_data: `admin_digital_add_product_${section.id}` }],
    [{ text: await getText(userId, 'editDigitalSectionName'), callback_data: `admin_edit_digital_section_${section.id}` }],
    [{ text: await getText(userId, 'deleteDigitalSection'), callback_data: `admin_delete_digital_section_${section.id}` }]
  ];

  for (const product of products) {
    const stock = await getMerchantAvailableStock(product.id);
    keyboard.push([{
      text: `${product.nameEn} / ${product.nameAr} - ${formatUsdPrice(product.price)} USD (${stock})`,
      callback_data: `admin_digital_product_${product.id}`
    }]);
  }

  keyboard.push([{ text: await getText(userId, 'back'), callback_data: 'admin_digital_subscriptions' }]);

  await bot.sendMessage(userId, await getText(userId, 'digitalSectionManageText', {
    name: sectionName,
    status: statusText,
    createdAt: formatAdminDateTime(section.createdAt),
    count: products.length
  }), {
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function showDigitalProductAdmin(userId, merchantId) {
  const merchant = await Merchant.findByPk(merchantId);
  if (!merchant) {
    await bot.sendMessage(userId, await getText(userId, 'error'));
    return;
  }

  const sectionId = parseDigitalSectionIdFromCategory(merchant.category);
  const stock = await getMerchantAvailableStock(merchant.id);
  const typeText = merchant.type === 'bulk'
    ? await getText(userId, 'typeBulk')
    : await getText(userId, 'typeSingle');
  const description = await getMerchantAdminDescriptionSummary(userId, merchant);

  const featured = await isFeaturedDigitalProduct(merchant.id);

  await bot.sendMessage(
    userId,
    await getText(userId, 'digitalProductManageText', {
      name: `${merchant.nameEn} / ${merchant.nameAr}`,
      price: formatUsdPrice(merchant.price),
      stock,
      type: typeText,
      createdAt: formatAdminDateTime(merchant.createdAt),
      description
    }),
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: await getText(userId, 'addDigitalProductStock'), callback_data: `admin_digital_add_stock_${merchant.id}` }],
          [{ text: await getText(userId, 'viewDigitalProductStock'), callback_data: `admin_view_digital_product_stock_${merchant.id}` }],
          [{ text: await getText(userId, 'searchDeleteDigitalProductStock'), callback_data: `admin_search_delete_digital_product_stock_${merchant.id}` }],
          [{ text: await getText(userId, 'searchDigitalProductDuplicates'), callback_data: `admin_search_digital_product_duplicates_${merchant.id}` }],
          [{ text: await getText(userId, 'deleteDigitalProductDuplicates'), callback_data: `admin_delete_digital_product_duplicates_${merchant.id}` }],
          [{ text: await getText(userId, 'editDigitalProductName'), callback_data: `admin_edit_digital_product_name_${merchant.id}` }],
          [{ text: await getText(userId, 'editDigitalProductPrice'), callback_data: `admin_edit_digital_product_price_${merchant.id}` }],
          [{ text: await getText(userId, 'editDigitalProductDescription'), callback_data: `admin_edit_digital_product_description_${merchant.id}` }],
          [{ text: await getText(userId, featured ? 'hideDigitalProductFromFront' : 'showDigitalProductInFront'), callback_data: `admin_toggle_front_digital_product_${merchant.id}` }],
          [{ text: await getText(userId, 'deleteDigitalProduct'), callback_data: `admin_delete_digital_product_${merchant.id}` }],
          [{ text: await getText(userId, 'back'), callback_data: sectionId ? `admin_digital_section_${sectionId}` : 'admin_digital_subscriptions' }]
        ]
      }
    }
  );
}

async function showDigitalSectionForUser(userId, sectionId) {
  const section = await DigitalSection.findByPk(sectionId);
  if (!section || !section.isActive) {
    await bot.sendMessage(userId, await getText(userId, 'error'));
    return;
  }

  const products = await getVisibleDigitalProductsForSection(section.id);
  const sectionName = await getDigitalSectionDisplayName(section, userId);
  if (!products.length) {
    await bot.sendMessage(userId, `🧩 <b>${escapeHtml(sectionName)}</b>

${await getText(userId, 'digitalSectionEmpty')}`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: await getText(userId, 'back'), callback_data: 'back_to_menu' }]] }
    });
    return;
  }

  const buttons = [];
  for (const product of products) {
    const stock = await getMerchantAvailableStock(product.id);
    const name = await getMerchantDisplayName(product, userId);
    buttons.push([{
      text: await getText(userId, 'digitalProductListButton', {
        name,
        price: formatUsdPrice(product.price),
        stock
      }),
      callback_data: `digital_product_${product.id}`
    }]);
  }

  buttons.push([{ text: await getText(userId, 'back'), callback_data: 'back_to_menu' }]);

  await bot.sendMessage(userId, `🧩 <b>${escapeHtml(sectionName)}</b>

${await getText(userId, 'digitalSectionChooseProduct')}
${await getCurrentBalanceLineText(userId)}`, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons }
  });
}

async function showDigitalProductDetails(userId, merchantId) {
  const merchant = await Merchant.findByPk(merchantId);
  if (!merchant) {
    await bot.sendMessage(userId, await getText(userId, 'error'));
    return;
  }

  const sectionId = parseDigitalSectionIdFromCategory(merchant.category);
  const section = sectionId ? await DigitalSection.findByPk(sectionId) : null;
  if (!section || !section.isActive || await isDigitalProductHidden(merchant.id)) {
    await bot.sendMessage(userId, await getText(userId, 'error'));
    return;
  }
  const stock = await getMerchantAvailableStock(merchant.id);
  const name = await getMerchantDisplayName(merchant, userId);
  let details = await getMerchantDescriptionForUser(userId, merchant);

  if (!details) {
    details = merchant?.description?.type === 'photo' || merchant?.description?.type === 'video'
      ? await getText(userId, 'attachedDetailsNote')
      : '-';
  }

  if (merchant?.description?.type === 'photo' && merchant.description.fileId) {
    await bot.sendPhoto(userId, merchant.description.fileId);
  } else if (merchant?.description?.type === 'video' && merchant.description.fileId) {
    await bot.sendVideo(userId, merchant.description.fileId);
  }

  const aiAssistantEnabled = await getAiAssistantEnabled();
  const inlineKeyboard = [
    [{ text: await getText(userId, 'buyNow'), callback_data: `digital_buy_${merchant.id}` }]
  ];
  if (aiAssistantEnabled) {
    inlineKeyboard.push([{ text: await getText(userId, 'askAiAboutThisProduct'), callback_data: `ai_about_product_${merchant.id}` }]);
  }
  inlineKeyboard.push([{ text: await getText(userId, 'back'), callback_data: `digital_section_${sectionId}` }]);

  await bot.sendMessage(
    userId,
    `${await getText(userId, 'digitalProductDetailsText', {
      name,
      stock,
      price: formatUsdPrice(merchant.price),
      details
    })}

${await getCurrentBalanceLineText(userId)}`,
    {
      reply_markup: {
        inline_keyboard: inlineKeyboard
      }
    }
  );
}




const AI_TEXT_CACHE = new Map();

function containsArabicText(value) {
  return /[\u0600-\u06FF]/.test(String(value || ''));
}

function normalizeOpenAIContentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') return String(part.text || part.content || '');
      return '';
    }).join('\n').trim();
  }
  if (content && typeof content === 'object') {
    return String(content.text || content.content || '').trim();
  }
  return '';
}

function extractJsonObjectFromText(rawValue) {
  const raw = normalizeOpenAIContentToText(rawValue).trim();
  if (!raw) return null;

  const candidates = [raw];
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) candidates.push(fenceMatch[1].trim());

  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(raw.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  return null;
}

async function callOpenAIJson(messages, options = {}) {
  if (!OPENAI_API_KEY) return null;

  const sendRequest = async (useJsonMode = true) => {
    const body = {
      model: OPENAI_MODEL,
      messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 700
    };

    if (useJsonMode && options.disableResponseFormat !== true) {
      body.response_format = { type: 'json_object' };
    }

    return await axios.post(`${OPENAI_BASE_URL}/chat/completions`, body, {
      timeout: options.timeout ?? 25000,
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
  };

  try {
    const response = await sendRequest(true);
    const message = response?.data?.choices?.[0]?.message;
    const parsed = message?.parsed || extractJsonObjectFromText(message?.content);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (err) {
    const status = err?.response?.status;
    if (![400, 404, 415, 422].includes(status)) {
      console.error('OpenAI JSON error:', err?.response?.data || err.message);
    }
  }

  try {
    const response = await sendRequest(false);
    const message = response?.data?.choices?.[0]?.message;
    const parsed = message?.parsed || extractJsonObjectFromText(message?.content);
    if (parsed && typeof parsed === 'object') return parsed;
    console.error('OpenAI JSON parse error: response was not valid JSON');
  } catch (err) {
    console.error('OpenAI JSON retry error:', err?.response?.data || err.message);
  }

  return null;
}

async function translateTextForLang(lang, textValue, options = {}) {
  const targetLang = lang === 'ar' ? 'ar' : 'en';
  const trimmed = String(textValue || '').trim();
  if (!trimmed || !OPENAI_API_KEY) return trimmed;

  const cacheKey = `translate:${targetLang}:${trimmed}`;
  if (AI_TEXT_CACHE.has(cacheKey)) return AI_TEXT_CACHE.get(cacheKey);

  const payload = await callOpenAIJson([
    {
      role: 'system',
      content: 'You translate user-facing Telegram bot text. Keep emojis, line breaks, URLs, emails, usernames, product names, codes, and numbers unchanged unless translation is clearly needed. Return JSON with translated_text only.'
    },
    {
      role: 'user',
      content: `Target language: ${targetLang === 'ar' ? 'Arabic' : 'English'}\n\nTranslate this text for a Telegram bot. If it is already suitable, return it naturally without extra commentary.\n\n${trimmed}`
    }
  ], { temperature: 0, maxTokens: Math.min(1500, Math.max(250, trimmed.length * 2)) });

  const translated = String(payload?.translated_text || '').trim() || trimmed;
  AI_TEXT_CACHE.set(cacheKey, translated);
  return translated;
}

async function translateTextForUserLanguage(userId, textValue, options = {}) {
  const user = await User.findByPk(userId, { attributes: ['lang'] });
  return await translateTextForLang(user?.lang || 'en', textValue, options);
}

async function getMerchantDescriptionForUser(userId, merchant) {
  const plain = getMerchantPlainDescription(merchant);
  if (!plain) return '';
  return await translateTextForUserLanguage(userId, plain);
}

function createStructuredBulkExtra(password, verify = '', note = '') {
  return JSON.stringify({
    password: String(password || '').trim(),
    verify: String(verify || '').trim(),
    note: String(note || '').trim()
  });
}

function parseStructuredStockExtra(extra) {
  const raw = String(extra || '').trim();
  if (!raw) return { password: '', verify: '', note: '', structured: false };

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const password = String(parsed.password || parsed.pass || '').trim();
      const verify = String(parsed.verify || parsed.verification || parsed.check || '').trim();
      const note = String(parsed.note || parsed.extra || parsed.additional || '').trim();
      if (password || verify || note) {
        return { password, verify, note, structured: true };
      }
    }
  } catch {
    // ignore JSON parse errors
  }

  return { password: raw, verify: '', note: '', structured: false };
}

function getMerchantStockCompositeKey(value, extra = '') {
  const parsed = parseStructuredStockExtra(extra);
  const normalizedExtra = (parsed.password || parsed.verify || parsed.note)
    ? createStructuredBulkExtra(parsed.password, parsed.verify, parsed.note)
    : String(extra || '').trim();
  return `${String(value || '').trim()}\n${normalizedExtra}`;
}

function buildMerchantStockRowText(rowOrEntry) {
  if (!rowOrEntry) return '';
  const value = String(rowOrEntry.value || '').trim();
  const rawExtra = String(rowOrEntry.extra || '').trim();
  const parsed = parseStructuredStockExtra(rawExtra);
  const looksLikeAccount = Boolean(value.includes('@') || rawExtra.startsWith('{') || parsed.verify || parsed.note);

  if (looksLikeAccount && (parsed.password || rawExtra)) {
    const lines = [
      `Email: ${value}`,
      `Password: ${parsed.password || rawExtra}`
    ];
    if (parsed.verify) lines.push(`Verification: ${parsed.verify}`);
    if (parsed.note) lines.push(`Extra: ${parsed.note}`);
    return lines.join('\n');
  }

  return rawExtra ? `${value}\n${rawExtra}` : value;
}

function parseBulkStockPipeLine(line) {
  const parts = String(line || '').split('|').map(v => v.trim());
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return {
    value: parts[0],
    extra: createStructuredBulkExtra(parts[1], parts[2] || '', parts.slice(3).join(' | '))
  };
}

async function formatMerchantDeliveryHtml(userId, merchant, rawEntries = []) {
  const entries = Array.isArray(rawEntries) ? rawEntries : [];
  if (!entries.length) return '';

  if (merchant?.type !== 'bulk') {
    return formatCodesForHtml(entries.map(entry => buildMerchantStockRowText(entry)));
  }

  const titleLabel = await getText(userId, 'accountEntryTitle', { index: '{index}' });
  const emailLabel = await getText(userId, 'fieldEmail');
  const passwordLabel = await getText(userId, 'fieldPassword');
  const verificationLabel = await getText(userId, 'fieldVerification');
  const extraLabel = await getText(userId, 'fieldExtra');

  return entries.map((entry, index) => {
    const parsed = parseStructuredStockExtra(entry.extra);
    const lines = [
      `<b>${escapeHtml(titleLabel.replace('{index}', String(index + 1)))}</b>`,
      `<b>${escapeHtml(emailLabel)}:</b>\n<code>${escapeHtml(entry.value)}</code>`,
      `<b>${escapeHtml(passwordLabel)}:</b>\n<code>${escapeHtml(parsed.password || '')}</code>`
    ];

    if (parsed.verify) {
      lines.push(`<b>${escapeHtml(verificationLabel)}:</b>\n<code>${escapeHtml(parsed.verify)}</code>`);
    }

    if (parsed.note) {
      lines.push(`<b>${escapeHtml(extraLabel)}:</b>\n<code>${escapeHtml(parsed.note)}</code>`);
    }

    return lines.join('\n');
  }).join('\n\n');
}

async function getDigitalStockInputReplyMarkup(userId, merchant) {
  const rows = [];
  if (merchant?.type === 'bulk') {
    rows.push([{ text: await getText(userId, 'addEmailPassword'), callback_data: `admin_bulk_add_account_${merchant.id}` }]);
  }
  rows.push([{ text: await getText(userId, 'cancel'), callback_data: merchant?.category ? `admin_digital_product_${merchant.id}` : 'cancel_action' }]);
  return { inline_keyboard: rows };
}

async function addSingleBulkAccountStock(merchant, accountData = {}) {
  const value = String(accountData.email || '').trim();
  const extra = createStructuredBulkExtra(accountData.password, accountData.verify, accountData.note);
  if (!value || !String(accountData.password || '').trim()) {
    return { success: false, reason: 'empty' };
  }

  const existingRows = await Code.findAll({ where: { merchantId: merchant.id }, attributes: ['value', 'extra'] });
  const wantedKey = getMerchantStockCompositeKey(value, extra);
  if (existingRows.some(row => getMerchantStockCompositeKey(row.value, row.extra) === wantedKey)) {
    return { success: true, added: 0, duplicate: true };
  }

  await Code.create({ value, extra, merchantId: merchant.id, isUsed: false });
  return { success: true, added: 1, duplicate: false };
}

async function deleteMerchantStockEntriesByInput(merchant, rawInput) {
  const parsed = parseMerchantStockEntries(merchant, rawInput);
  if (parsed.error) {
    return { success: false, reason: parsed.error };
  }

  const wantedEntries = [];
  const seenWanted = new Set();
  for (const entry of parsed.entries) {
    const key = getMerchantStockCompositeKey(entry.value, entry.extra);
    if (!seenWanted.has(key)) {
      seenWanted.add(key);
      wantedEntries.push({ key, entry });
    }
  }

  const rows = await Code.findAll({ where: { merchantId: merchant.id }, order: [['id', 'ASC']] });
  const idsToDelete = [];
  const missing = [];
  let locked = 0;

  for (const wanted of wantedEntries) {
    const matches = rows.filter(row => getMerchantStockCompositeKey(row.value, row.extra) === wanted.key);
    if (!matches.length) {
      missing.push(buildMerchantStockRowText(wanted.entry));
      continue;
    }

    for (const row of matches) {
      if (row.isUsed) {
        locked += 1;
      } else {
        idsToDelete.push(row.id);
      }
    }
  }

  if (idsToDelete.length) {
    await Code.destroy({ where: { id: idsToDelete } });
  }

  let details = missing.slice(0, 25).join('\n\n');
  if (missing.length > 25) {
    details += `\n\n... +${missing.length - 25} more`;
  }
  if (!details) details = '-';

  return {
    success: true,
    deleted: idsToDelete.length,
    missing: missing.length,
    locked,
    details
  };
}

function getSupportThreadKey(userId) {
  return `support_thread_${Number(userId)}`;
}

async function getSupportThread(userId) {
  const setting = await Setting.findOne({ where: { key: getSupportThreadKey(userId), lang: 'global' } });
  if (!setting) return null;
  try {
    return JSON.parse(setting.value);
  } catch {
    return null;
  }
}

async function isSupportThreadOpen(userId) {
  const thread = await getSupportThread(userId);
  return Boolean(thread?.open);
}

async function openSupportThread(userId, openedBy = 'user') {
  await Setting.upsert({
    key: getSupportThreadKey(userId),
    lang: 'global',
    value: JSON.stringify({ open: true, openedBy, updatedAt: new Date().toISOString() })
  });
}

async function closeSupportThread(userId) {
  await Setting.destroy({ where: { key: getSupportThreadKey(userId), lang: 'global' } });
}

async function getSupportUserCloseReplyMarkup(userId) {
  return {
    inline_keyboard: [[{ text: await getText(userId, 'closeChat'), callback_data: 'support_close' }]]
  };
}

async function getSupportAdminReplyMarkup(targetUserId) {
  return {
    inline_keyboard: [[
      { text: await getText(ADMIN_ID, 'replyToSupport'), callback_data: `support_reply_${targetUserId}` },
      { text: await getText(ADMIN_ID, 'closeChat'), callback_data: `support_close_user_${targetUserId}` }
    ]]
  };
}

async function startSupportConversation(userId, openedBy = 'user') {
  const alreadyOpen = await isSupportThreadOpen(userId);
  if (!alreadyOpen) {
    await openSupportThread(userId, openedBy);
  }

  await bot.sendMessage(
    userId,
    await getText(userId, alreadyOpen ? 'supportChatAlreadyOpen' : 'supportChatOpened'),
    { reply_markup: await getSupportUserCloseReplyMarkup(userId) }
  );
}

async function forwardSupportMessageToAdmin(userId, msg) {
  const supportText = String(msg.text || msg.caption || '').trim();
  const photoFileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : null;
  const videoFileId = msg.video ? msg.video.file_id : null;
  const notifText = await getText(ADMIN_ID, 'supportThreadAdminNotice', {
    userId,
    username: msg.from?.username ? `@${msg.from.username}` : 'لا يوجد',
    name: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ').trim() || 'لا يوجد',
    message: supportText || 'No message'
  });
  const replyMarkup = await getSupportAdminReplyMarkup(userId);

  if (photoFileId) {
    await bot.sendPhoto(ADMIN_ID, photoFileId, { caption: notifText, reply_markup: replyMarkup });
  } else if (videoFileId) {
    await bot.sendVideo(ADMIN_ID, videoFileId, { caption: notifText, reply_markup: replyMarkup });
  } else {
    await bot.sendMessage(ADMIN_ID, notifText, { reply_markup: replyMarkup });
  }
}

async function closeSupportConversationForUser(userId, closedBy = 'user', adminId = ADMIN_ID) {
  await closeSupportThread(userId);
  try {
    await bot.sendMessage(userId, await getText(userId, closedBy === 'user' ? 'supportChatClosedByUser' : 'supportChatClosedByAdmin'));
  } catch {}

  if (adminId) {
    try {
      const noticeKey = closedBy === 'user' ? 'supportChatClosedAdminNotice' : 'supportChatClosedUserNotice';
      await bot.sendMessage(adminId, await getText(adminId, noticeKey));
    } catch {}
  }
}

function isSupportIntentText(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return false;
  return /(support|agent|human|admin|help me|contact support|تواصل مع الدعم|الدعم|دعم|مشكلة|شكوى|اكلم الادمن|اكلم الدعم|مراسلة الدعم)/i.test(normalized);
}

function isAffirmativeText(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return /^(yes|y|ok|okay|sure|please|نعم|اي|أجل|ايوه|اريد|أريد|تمام|موافق)/i.test(normalized);
}

function isNegativeText(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return /^(no|n|cancel|later|لا|مو|ليس الآن|لاحقاً|الغاء|إلغاء)/i.test(normalized);
}

async function buildAssistantCatalogContext(userId, state = {}) {
  const user = await User.findByPk(userId, { attributes: ['lang', 'balance'] });
  const digitalSections = await getDigitalSections();
  const sectionPayload = [];

  for (const section of digitalSections) {
    const products = await getDigitalProductsForSection(section.id);
    const productPayload = [];
    for (const product of products) {
      productPayload.push({
        id: product.id,
        nameEn: product.nameEn,
        nameAr: product.nameAr,
        priceUSD: Number(product.price || 0),
        stock: await getMerchantAvailableStock(product.id),
        type: product.type,
        details: truncateText(getMerchantPlainDescription(product), 220)
      });
    }

    sectionPayload.push({
      id: section.id,
      nameEn: section.nameEn,
      nameAr: section.nameAr,
      products: productPayload
    });
  }

  const generalMerchants = (await Merchant.findAll({ order: [['category', 'ASC'], ['id', 'ASC']] }))
    .filter(merchant => !isDigitalSectionCategory(merchant.category))
    .filter(merchant => String(merchant.nameEn || '') !== 'ChatGPT Code');

  const generalCatalog = [];
  for (const merchant of generalMerchants) {
    generalCatalog.push({
      id: merchant.id,
      nameEn: merchant.nameEn,
      nameAr: merchant.nameAr,
      category: merchant.category,
      priceUSD: Number(merchant.price || 0),
      stock: await getMerchantAvailableStock(merchant.id),
      type: merchant.type,
      details: truncateText(getMerchantPlainDescription(merchant), 160)
    });
  }

  const referralMerchant = await getReferralStockMerchant();
  const chatgptFallbackStock = await Code.count({ where: { merchantId: referralMerchant.id, isUsed: false } });
  const usdConfig = await getDepositConfig('USD');
  const iqdConfig = await getDepositConfig('IQD');
  const focusMerchantId = Number.isInteger(parseInt(state.focusMerchantId, 10)) ? parseInt(state.focusMerchantId, 10) : null;
  const focusProduct = focusMerchantId ? await Merchant.findByPk(focusMerchantId) : null;

  return {
    currentUser: {
      id: userId,
      language: user?.lang || 'en',
      ownBalanceUSD: Number(user?.balance || 0).toFixed(2)
    },
    chatgptCode: {
      priceUSD: Number(await getChatGptPriceValue()).toFixed(2),
      fallbackStock: chatgptFallbackStock
    },
    depositOptions: [
      { currency: 'USD', nameEn: usdConfig.displayNameEn || 'Binance', nameAr: usdConfig.displayNameAr || 'بايننس' },
      { currency: 'IQD', nameEn: iqdConfig.displayNameEn || 'Iraqi Dinar', nameAr: iqdConfig.displayNameAr || 'دينار عراقي' }
    ],
    digitalSections: sectionPayload,
    generalCatalog,
    focusProduct: focusProduct ? {
      id: focusProduct.id,
      nameEn: focusProduct.nameEn,
      nameAr: focusProduct.nameAr,
      priceUSD: Number(focusProduct.price || 0),
      stock: await getMerchantAvailableStock(focusProduct.id),
      type: focusProduct.type,
      details: truncateText(getMerchantPlainDescription(focusProduct), 250)
    } : null
  };
}

async function buildFallbackAssistantReply(userId, userMessage, state = {}) {
  const user = await User.findByPk(userId, { attributes: ['lang', 'balance'] });
  const isArabic = (user?.lang || 'en') === 'ar';
  const lines = [];
  lines.push(await getText(userId, 'balanceInfoText', { balance: Number(user?.balance || 0).toFixed(2) }));

  const focusMerchantId = Number.isInteger(parseInt(state.focusMerchantId, 10)) ? parseInt(state.focusMerchantId, 10) : null;
  if (focusMerchantId) {
    const merchant = await Merchant.findByPk(focusMerchantId);
    if (merchant) {
      lines.unshift(await getMerchantDisplayName(merchant, userId));
      lines.push(await getText(userId, 'itemPriceLine', { price: formatUsdPrice(merchant.price) }));
      lines.push(await getText(userId, 'remainingStockLine', { stock: await getMerchantAvailableStock(merchant.id) }));
      const details = await getMerchantDescriptionForUser(userId, merchant);
      if (details) lines.push(`${await getText(userId, 'productDescriptionLine', { description: details })}`);
      return lines.join('\n');
    }
  }

  const detectedMerchant = await resolveAssistantMerchantFromText(userId, userMessage, state);
  if (detectedMerchant) {
    return await buildAssistantMerchantInfoText(userId, detectedMerchant, extractAssistantQuantity(userMessage, 1));
  }

  const sections = await getDigitalSections();
  const previewLines = [];
  for (const section of sections.slice(0, 4)) {
    const products = await getDigitalProductsForSection(section.id);
    for (const product of products.slice(0, 3)) {
      previewLines.push(`• ${await getMerchantDisplayName(product, userId)} - ${formatUsdPrice(product.price)} USD - ${await getText(userId, 'stockAvailableInline', { stock: await getMerchantAvailableStock(product.id) })}`);
    }
  }

  if (previewLines.length) {
    lines.push(isArabic ? 'الاشتراكات المتوفرة حالياً:' : 'Currently available subscriptions:');
    lines.push(previewLines.join('\n'));
  } else {
    lines.push(await getText(userId, 'aiAssistantUnavailable'));
  }

  return lines.join('\n\n');
}


function normalizeAssistantDigits(value) {
  return String(value || '')
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
}

function normalizeAssistantText(value) {
  return normalizeAssistantDigits(value)
    .toLowerCase()
    .replace(/[\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[^A-Za-z0-9\u0600-\u06FF]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSlashCommandText(value) {
  return /^\/[A-Za-z_]+(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(String(value || '').trim());
}

function extractAssistantQuantity(value, fallback = 1) {
  const normalized = normalizeAssistantDigits(value);
  const match = normalized.match(/\b(\d{1,3})\b/);
  const qty = parseInt(match?.[1] || '', 10);
  if (Number.isInteger(qty) && qty > 0) return qty;
  return fallback;
}

function isPurchaseIntentText(value) {
  const normalized = normalizeAssistantText(value);
  return /(buy|purchase|order|get|اشتري|شراء|اريد شراء|أريد شراء|ابغي اشتري|اريد حساب|أريد حساب|اريد اشتراك|أريد اشتراك|خذ لي|جيب لي)/i.test(normalized);
}

function isPriceIntentText(value) {
  const normalized = normalizeAssistantText(value);
  return /(price|prices|cost|how much|pricing|سعر|اسعار|الاسعار|الأسعار|بكم|كم السعر|تكلفه)/i.test(normalized);
}

function isNeedMoreInfoText(value) {
  const normalized = normalizeAssistantText(value);
  return /(more info|more details|details|tell me more|about|what is|تفاصيل|مزيد|اعرف اكثر|اعرف المزيد|شنو هذا|ما هو|اشرح|وصف)/i.test(normalized);
}

function isAdminOpenIntentText(value) {
  const normalized = normalizeAssistantText(value);
  return /(open|show|go to|take me to|افتح|وريني|اعرض|روح|خذني|دخلني|افتح لي)/i.test(normalized);
}

function isAssistantCancelIntentText(value) {
  return isNegativeText(value) || /cancel purchase|الغ الشراء|الغي الشراء|إلغاء الشراء/i.test(String(value || ''));
}

function getAssistantTrainingSettingKey() {
  return 'assistant_training_examples';
}

async function getAssistantTrainingExamples() {
  const raw = await getGlobalSetting(getAssistantTrainingSettingKey(), '[]');
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(item => item && typeof item === 'object')
      .map(item => ({
        question: String(item.question || '').trim(),
        answer: String(item.answer || '').trim(),
        createdAt: String(item.createdAt || ''),
        createdBy: item.createdBy || null
      }))
      .filter(item => item.question && item.answer)
      .slice(-80);
  } catch {
    return [];
  }
}

async function saveAssistantTrainingExample(question, answer, adminId) {
  const items = await getAssistantTrainingExamples();
  const normalizedQuestion = normalizeAssistantText(question);
  const remaining = items.filter(item => normalizeAssistantText(item.question) !== normalizedQuestion);
  remaining.push({
    question: String(question || '').trim(),
    answer: String(answer || '').trim(),
    createdAt: new Date().toISOString(),
    createdBy: adminId
  });

  await Setting.upsert({
    key: getAssistantTrainingSettingKey(),
    lang: 'global',
    value: JSON.stringify(remaining.slice(-80))
  });
}

function parseAssistantTrainingCommand(value) {
  const textValue = String(value || '').trim();
  if (!textValue) return null;

  const colonMatch = textValue.match(/^(?:train assistant|assistant training|درب المساعد|تدريب المساعد|عل[مّ] المساعد)\s*:\s*([\s\S]+)$/i);
  if (colonMatch?.[1]) {
    const body = colonMatch[1].trim();
    const arrowSplit = body.split(/\s*=>\s*/);
    if (arrowSplit.length >= 2) {
      return {
        question: arrowSplit.shift().trim(),
        answer: arrowSplit.join(' => ').trim()
      };
    }
  }

  const qaMatch = textValue.match(/question\s*:\s*([\s\S]+?)\n+answer\s*:\s*([\s\S]+)/i)
    || textValue.match(/السؤال\s*:\s*([\s\S]+?)\n+الجواب\s*:\s*([\s\S]+)/i);
  if (qaMatch) {
    return { question: qaMatch[1].trim(), answer: qaMatch[2].trim() };
  }

  return null;
}

async function findAssistantTrainingAnswer(userMessage) {
  const normalizedMessage = normalizeAssistantText(userMessage);
  if (!normalizedMessage) return '';
  const items = await getAssistantTrainingExamples();

  for (const item of items.slice().reverse()) {
    const normalizedQuestion = normalizeAssistantText(item.question);
    if (!normalizedQuestion) continue;
    if (normalizedMessage === normalizedQuestion || normalizedMessage.includes(normalizedQuestion) || normalizedQuestion.includes(normalizedMessage)) {
      return item.answer;
    }
  }

  return '';
}

async function getAssistantCandidateMerchants() {
  const merchants = await Merchant.findAll({ order: [['id', 'ASC']] });
  return merchants.filter(merchant => String(merchant.nameEn || '') !== 'ChatGPT Referral Stock');
}

function getAssistantMerchantSearchBlob(merchant) {
  return normalizeAssistantText([
    merchant?.nameEn || '',
    merchant?.nameAr || '',
    merchant?.category || '',
    getMerchantPlainDescription(merchant) || ''
  ].join(' '));
}

function scoreAssistantMerchantMatch(queryText, merchant) {
  const normalizedQuery = normalizeAssistantText(queryText);
  if (!normalizedQuery) return 0;
  const haystack = getAssistantMerchantSearchBlob(merchant);
  if (!haystack) return 0;

  let score = 0;
  const compactQuery = normalizedQuery.replace(/\s+/g, '');
  const compactHaystack = haystack.replace(/\s+/g, '');

  if (compactQuery && compactHaystack.includes(compactQuery)) score += 100;

  const tokens = normalizedQuery.split(' ').filter(token => token.length >= 2);
  for (const token of tokens) {
    if (haystack.includes(token)) score += token.length >= 4 ? 18 : 8;
  }

  const nameEn = normalizeAssistantText(merchant?.nameEn || '');
  const nameAr = normalizeAssistantText(merchant?.nameAr || '');
  if (nameEn && normalizedQuery.includes(nameEn)) score += 60;
  if (nameAr && normalizedQuery.includes(nameAr)) score += 60;

  return score;
}

async function resolveAssistantMerchantFromText(userId, userMessage, state = {}) {
  const focusMerchantId = Number.isInteger(parseInt(state.focusMerchantId, 10)) ? parseInt(state.focusMerchantId, 10) : null;
  if (focusMerchantId) {
    const focused = await Merchant.findByPk(focusMerchantId);
    if (focused) return focused;
  }

  const merchants = await getAssistantCandidateMerchants();
  let bestMerchant = null;
  let bestScore = 0;
  for (const merchant of merchants) {
    const score = scoreAssistantMerchantMatch(userMessage, merchant);
    if (score > bestScore) {
      bestScore = score;
      bestMerchant = merchant;
    }
  }

  if (bestMerchant && bestScore >= 30) return bestMerchant;

  if (!OPENAI_API_KEY || !merchants.length) return null;

  const payload = await callOpenAIJson([
    {
      role: 'system',
      content: 'Choose the single best matching merchant for the user query. Return JSON with merchant_id only when there is a strong match; otherwise return merchant_id as null.'
    },
    {
      role: 'user',
      content: JSON.stringify({
        query: String(userMessage || ''),
        merchants: merchants.slice(0, 150).map(merchant => ({
          id: merchant.id,
          nameEn: merchant.nameEn,
          nameAr: merchant.nameAr,
          category: merchant.category,
          details: truncateText(getMerchantPlainDescription(merchant), 120)
        }))
      })
    }
  ], { temperature: 0, maxTokens: 220 });

  const merchantId = parseInt(payload?.merchant_id, 10);
  if (Number.isInteger(merchantId)) {
    return await Merchant.findByPk(merchantId);
  }

  return null;
}

async function buildAssistantMerchantInfoText(userId, merchant, quantity = 1) {
  const name = await getMerchantDisplayName(merchant, userId);
  const stock = await getMerchantAvailableStock(merchant.id);
  const unitPrice = await getPerCodePriceForQuantity(merchant.price, quantity);
  const total = unitPrice * Math.max(1, quantity);
  const details = await getMerchantDescriptionForUser(userId, merchant);
  const lines = [
    `🧩 ${name}`,
    await getText(userId, 'itemPriceLine', { price: formatUsdPrice(unitPrice) }),
    await getText(userId, 'remainingStockLine', { stock }),
    await getText(userId, 'currentBalanceLine', { balance: await getUserBalanceFormatted(userId) })
  ];

  if (quantity > 1) {
    lines.push(await getText(userId, 'quantityPurchasedLine', { qty: quantity }));
    lines.push(await getText(userId, 'totalPaidLine', { total: formatUsdPrice(total) }));
  }

  if (details) {
    lines.push(await getText(userId, 'productDescriptionLine', { description: details }));
  }

  return lines.join('\n');
}

async function buildAssistantPricesCatalogReply(userId) {
  const sections = await getDigitalSections();
  const lines = [await getText(userId, 'aiAssistantPricesHeader')];

  for (const section of sections.slice(0, 6)) {
    const sectionName = await getDigitalSectionDisplayName(section, userId);
    lines.push(`\n• ${sectionName}`);
    const products = await getDigitalProductsForSection(section.id);
    for (const product of products.slice(0, 6)) {
      lines.push(`  - ${await getMerchantDisplayName(product, userId)}: ${formatUsdPrice(product.price)} USD (${await getText(userId, 'stockAvailableInline', { stock: await getMerchantAvailableStock(product.id) })})`);
    }
  }

  const generalMerchants = (await Merchant.findAll({ order: [['id', 'ASC']] }))
    .filter(merchant => !isDigitalSectionCategory(merchant.category))
    .filter(merchant => String(merchant.nameEn || '') !== 'ChatGPT Referral Stock')
    .slice(0, 10);

  if (generalMerchants.length) {
    lines.push('');
    for (const merchant of generalMerchants) {
      lines.push(`- ${await getMerchantDisplayName(merchant, userId)}: ${formatUsdPrice(merchant.price)} USD (${await getText(userId, 'stockAvailableInline', { stock: await getMerchantAvailableStock(merchant.id) })})`);
    }
  }

  lines.push('');
  lines.push(await getCurrentBalanceLineText(userId));
  return lines.join('\n');
}

async function buildAssistantPurchaseConfirmationText(userId, merchant, quantity = 1) {
  const stock = await getMerchantAvailableStock(merchant.id);
  const unitPrice = await getPerCodePriceForQuantity(merchant.price, quantity);
  const total = unitPrice * Math.max(1, quantity);
  return await getText(userId, 'aiAssistantPurchaseConfirm', {
    name: await getMerchantDisplayName(merchant, userId),
    qty: quantity,
    price: formatUsdPrice(unitPrice),
    total: formatUsdPrice(total),
    stock,
    balance: await getUserBalanceFormatted(userId)
  });
}

async function getAssistantPurchaseReplyMarkup(userId, merchantId, quantity = 1, backCallback = 'back_to_menu') {
  return {
    inline_keyboard: [
      [{ text: await getText(userId, 'aiAssistantPurchaseConfirmButton'), callback_data: `ai_buy_yes_${merchantId}_${quantity}` }],
      [{ text: await getText(userId, 'aiAssistantPurchaseMoreButton'), callback_data: `ai_buy_info_${merchantId}_${quantity}` }],
      [{ text: await getText(userId, 'aiAssistantPurchaseCancelButton'), callback_data: 'ai_buy_no' }],
      [{ text: await getText(userId, 'back'), callback_data: backCallback }]
    ]
  };
}

async function getAssistantProductInfoReplyMarkup(userId, merchantId, quantity = 1, backCallback = 'back_to_menu') {
  return {
    inline_keyboard: [
      [{ text: await getText(userId, 'aiAssistantPurchaseConfirmButton'), callback_data: `ai_buy_yes_${merchantId}_${quantity}` }],
      [{ text: await getText(userId, 'support'), callback_data: 'support' }],
      [{ text: await getText(userId, 'back'), callback_data: backCallback }]
    ]
  };
}

async function awardReferralRewardForMerchantPurchase(userId, totalCost) {
  const userObj = await User.findByPk(userId);
  if (!userObj?.referredBy) return;

  const referralPercent = parseFloat(process.env.REFERRAL_PERCENT || '10');
  const rewardAmount = Number(totalCost || 0) * referralPercent / 100;
  if (!(rewardAmount > 0)) return;

  const referrer = await User.findByPk(userObj.referredBy);
  if (!referrer) return;

  await BalanceTransaction.create({ userId: referrer.id, amount: rewardAmount, type: 'referral', status: 'completed' });
  await User.update({ balance: parseFloat(referrer.balance) + rewardAmount }, { where: { id: referrer.id } });
  await bot.sendMessage(referrer.id, `🎉 Referral reward added: ${rewardAmount.toFixed(2)} USD`);
}

async function completeAssistantMerchantPurchase(userId, merchantId, quantity = 1, state = {}) {
  const merchant = await Merchant.findByPk(merchantId);
  if (!merchant) {
    await bot.sendMessage(userId, await getText(userId, 'error'));
    return { success: false, reason: 'merchant_not_found' };
  }

  const available = await Code.count({ where: { merchantId: merchant.id, isUsed: false } });
  if (available < quantity) {
    await bot.sendMessage(userId, await getText(userId, 'aiAssistantPurchaseUnavailable', { stock: available }), {
      reply_markup: await getBackAndCancelReplyMarkup(userId, state.focusMerchantId ? `digital_product_${state.focusMerchantId}` : 'back_to_menu')
    });
    return { success: false, reason: 'not_enough_stock' };
  }

  const result = await processPurchase(userId, merchant.id, quantity, state.discountCode || null);
  if (result.success) {
    let msgText = await getText(userId, 'success');
    if (result.discountApplied) {
      msgText += `\n${await getText(userId, 'discountApplied', { percent: result.discountApplied })}`;
    }
    const deliveryHtml = await formatMerchantDeliveryHtml(userId, merchant, result.rawEntries || []);
    msgText += `\n\n${deliveryHtml}`;
    const deliveryPrefix = await getCodeDeliveryPrefixHtml(userId);
    await clearUserState(userId);
    await sendPurchaseDeliveryMessage(userId, `${deliveryPrefix}${msgText}`, {
      merchant,
      totalCost: result.totalCost,
      newBalance: result.newBalance,
      quantity
    });

    const remainingMerchantStock = await Code.count({ where: { merchantId: merchant.id, isUsed: false } });
    await sendAdminCodeActionNotice(userId, {
      sourceKey: 'balance',
      serviceType: `${merchant.nameAr || merchant.nameEn}`,
      codesCount: quantity,
      remainingStockText: String(remainingMerchantStock)
    });
    await awardReferralRewardForMerchantPurchase(userId, result.totalCost || (merchant.price * quantity));
    return { success: true };
  }

  if (result.reason === 'Insufficient balance') {
    await clearUserState(userId);
    await bot.sendMessage(
      userId,
      await getText(userId, 'insufficientBalance', {
        balance: Number(result.balance || 0).toFixed(2),
        price: Number(result.price || merchant.price || 0).toFixed(2),
        needed: Number(result.totalCost || 0).toFixed(2)
      }),
      {
        reply_markup: {
          inline_keyboard: [[{ text: await getText(userId, 'depositNow'), callback_data: 'deposit' }]]
        }
      }
    );
    return { success: false, reason: 'insufficient_balance' };
  }

  await bot.sendMessage(userId, `${await getText(userId, 'error')}: ${result.reason || 'unknown error'}`);
  return { success: false, reason: result.reason || 'unknown_error' };
}

async function showAdminAddCodesMenu(userId) {
  const merchants = await Merchant.findAll();
  const buttons = merchants.map(m => ([{ text: `${m.nameEn} (ID: ${m.id})`, callback_data: `add_codes_merchant_${m.id}` }]));
  buttons.push([{ text: await getText(userId, 'back'), callback_data: 'admin' }]);
  await bot.sendMessage(userId, await getText(userId, 'addCodes'), { reply_markup: { inline_keyboard: buttons } });
}

async function showAdminSetPriceMenu(userId) {
  const merchants = await Merchant.findAll();
  const buttons = merchants.map(m => ([{ text: `${m.nameEn} (ID: ${m.id})`, callback_data: `set_price_merchant_${m.id}` }]));
  buttons.push([{ text: await getText(userId, 'back'), callback_data: 'admin' }]);
  await bot.sendMessage(userId, await getText(userId, 'setPrice'), { reply_markup: { inline_keyboard: buttons } });
}

async function showAdminMerchantsListMenu(userId) {
  const merchants = await Merchant.findAll();
  let msg = await getText(userId, 'merchantList');
  for (const m of merchants) {
    msg += `ID: ${m.id} | ${m.nameEn} / ${m.nameAr} | Price: ${m.price} USD | Category: ${m.category} | Type: ${m.type}\n`;
  }
  const keyboard = {
    inline_keyboard: [
      [{ text: '✏️ Edit', callback_data: 'admin_edit_merchant' }],
      [{ text: '🗑️ Delete', callback_data: 'admin_delete_merchant' }],
      [{ text: '📂 Edit Category', callback_data: 'admin_edit_category' }],
      [{ text: await getText(userId, 'back'), callback_data: 'admin' }]
    ]
  };
  await bot.sendMessage(userId, msg, { reply_markup: keyboard });
}

async function showAdminStatsSummary(userId) {
  const totalCodes = await Code.count();
  const totalSales = await BalanceTransaction.sum('amount', { where: { type: 'purchase', status: 'completed' } });
  const pendingDeposits = await BalanceTransaction.count({ where: { type: 'deposit', status: 'pending' } });
  await bot.sendMessage(userId,
    `${await getText(userId, 'totalCodes', { count: totalCodes })}\n` +
    `${await getText(userId, 'totalSales', { amount: Math.abs(totalSales || 0) })}\n` +
    `${await getText(userId, 'pendingDeposits', { count: pendingDeposits })}`
  );
}

async function executeAdminAssistantShortcut(userId, userMessage) {
  if (!isAdmin(userId)) return { handled: false };
  const normalized = normalizeAssistantText(userMessage);
  if (!isAdminOpenIntentText(normalized)) return { handled: false };

  const items = [
    { targetTextKey: 'aiAssistantOpenStocks', patterns: [/مخزون|مخزونات|inventory|stock/i], handler: showAdminAddCodesMenu },
    { targetTextKey: 'aiAssistantOpenSubscriptions', patterns: [/اشتراك|اشتراكات|subscriptions|digital/i], handler: showDigitalSubscriptionsAdmin },
    { targetTextKey: 'aiAssistantOpenPrices', patterns: [/سعر|اسعار|الاسعار|الأسعار|prices|pricing/i], handler: showAdminSetPriceMenu },
    { targetTextKey: 'aiAssistantOpenMerchants', patterns: [/تاجر|تجار|merchant/i], handler: showAdminMerchantsListMenu },
    { targetTextKey: 'aiAssistantOpenBalances', patterns: [/رصيد|ارصده|أرصدة|balance/i], handler: showBalanceManagementAdmin },
    { targetTextKey: 'aiAssistantOpenButtons', patterns: [/زر|ازرار|أزرار|buttons|menu/i], handler: showMenuButtonsAdmin },
    { targetTextKey: 'aiAssistantOpenAdminPanel', patterns: [/لوحه التحكم|لوحة التحكم|admin panel|panel/i], handler: showAdminPanel },
    { targetTextKey: 'aiAssistantOpenStats', patterns: [/احصائيات|إحصائيات|stats|statistics/i], handler: showAdminStatsSummary },
    { targetTextKey: 'aiAssistantOpenReferrals', patterns: [/احاله|إحالة|احالات|إحالات|referral/i], handler: showReferralSettingsAdmin },
    { targetTextKey: 'aiAssistantOpenBots', patterns: [/بوتات|bots|manage bots/i], handler: showBotsList }
  ];

  for (const item of items) {
    if (item.patterns.some(pattern => pattern.test(normalized))) {
      await item.handler(userId);
      return {
        handled: true,
        reply: await getText(userId, 'aiAssistantAdminOpened', { target: await getText(userId, item.targetTextKey) })
      };
    }
  }

  return { handled: true, reply: await getText(userId, 'aiAssistantAdminNoMatch') };
}

async function handleDeterministicAssistantRequest(userId, cleanMessage, state = {}) {
  if (!cleanMessage) return { handled: false };

  if (isAdmin(userId)) {
    const training = parseAssistantTrainingCommand(cleanMessage);
    if (training?.question && training?.answer) {
      await saveAssistantTrainingExample(training.question, training.answer, userId);
      return {
        handled: true,
        reply: `${await getText(userId, 'aiAssistantTrainingSaved')}\n\nQ: ${training.question}\nA: ${training.answer}`,
        replyMarkup: await getBackAndCancelReplyMarkup(userId)
      };
    }

    if (/^(?:train assistant|assistant training|درب المساعد|تدريب المساعد|عل[مّ] المساعد)/i.test(String(cleanMessage || '').trim())) {
      return {
        handled: true,
        reply: await getText(userId, 'aiAssistantTrainingHelp'),
        replyMarkup: await getBackAndCancelReplyMarkup(userId)
      };
    }

    const adminShortcut = await executeAdminAssistantShortcut(userId, cleanMessage);
    if (adminShortcut.handled) {
      return {
        handled: true,
        reply: adminShortcut.reply,
        replyMarkup: await getBackAndCancelReplyMarkup(userId, 'admin')
      };
    }
  }

  const trainedAnswer = await findAssistantTrainingAnswer(cleanMessage);
  if (trainedAnswer) {
    return {
      handled: true,
      reply: trainedAnswer,
      replyMarkup: await getBackAndCancelReplyMarkup(userId, state.focusMerchantId ? `digital_product_${state.focusMerchantId}` : 'back_to_menu')
    };
  }

  const merchant = await resolveAssistantMerchantFromText(userId, cleanMessage, state);
  if (merchant && isPurchaseIntentText(cleanMessage)) {
    const quantity = extractAssistantQuantity(cleanMessage, 1);
    const stock = await getMerchantAvailableStock(merchant.id);
    if (stock < quantity || stock <= 0) {
      return {
        handled: true,
        reply: await getText(userId, 'aiAssistantPurchaseUnavailable', { stock }),
        replyMarkup: await getBackAndCancelReplyMarkup(userId, state.focusMerchantId ? `digital_product_${state.focusMerchantId}` : 'back_to_menu')
      };
    }

    return {
      handled: true,
      reply: `${await buildAssistantPurchaseConfirmationText(userId, merchant, quantity)}\n\n${await getText(userId, 'aiAssistantPurchaseNeedMore', { name: await getMerchantDisplayName(merchant, userId) })}`,
      replyMarkup: await getAssistantPurchaseReplyMarkup(userId, merchant.id, quantity, state.focusMerchantId ? `digital_product_${state.focusMerchantId}` : 'back_to_menu'),
      nextState: {
        action: 'ai_assistant',
        history: Array.isArray(state.history) ? state.history.slice(-8) : [],
        focusMerchantId: merchant.id,
        awaitingSupportConfirm: false,
        awaitingPurchaseConfirm: true,
        pendingMerchantId: merchant.id,
        pendingQuantity: quantity
      }
    };
  }

  if (merchant && (isPriceIntentText(cleanMessage) || isNeedMoreInfoText(cleanMessage))) {
    const quantity = extractAssistantQuantity(cleanMessage, 1);
    return {
      handled: true,
      reply: await buildAssistantMerchantInfoText(userId, merchant, quantity),
      replyMarkup: await getAssistantProductInfoReplyMarkup(userId, merchant.id, quantity, state.focusMerchantId ? `digital_product_${state.focusMerchantId}` : 'back_to_menu'),
      nextState: {
        action: 'ai_assistant',
        history: Array.isArray(state.history) ? state.history.slice(-8) : [],
        focusMerchantId: merchant.id,
        awaitingSupportConfirm: false,
        awaitingPurchaseConfirm: false
      }
    };
  }

  if (!merchant && isPriceIntentText(cleanMessage)) {
    return {
      handled: true,
      reply: await buildAssistantPricesCatalogReply(userId),
      replyMarkup: await getBackAndCancelReplyMarkup(userId)
    };
  }

  if (!merchant && isPurchaseIntentText(cleanMessage)) {
    return {
      handled: true,
      reply: await getText(userId, 'aiAssistantNoProductMatch'),
      replyMarkup: await getBackAndCancelReplyMarkup(userId)
    };
  }

  if (merchant) {
    const quantity = extractAssistantQuantity(cleanMessage, 1);
    return {
      handled: true,
      reply: await buildAssistantMerchantInfoText(userId, merchant, quantity),
      replyMarkup: await getAssistantProductInfoReplyMarkup(userId, merchant.id, quantity, state.focusMerchantId ? `digital_product_${state.focusMerchantId}` : 'back_to_menu'),
      nextState: {
        action: 'ai_assistant',
        history: Array.isArray(state.history) ? state.history.slice(-8) : [],
        focusMerchantId: merchant.id,
        awaitingSupportConfirm: false,
        awaitingPurchaseConfirm: false
      }
    };
  }

  return { handled: false };
}

async function askBotAssistant(userId, userMessage, state = {}) {
  const cleanMessage = String(userMessage || '').trim();
  if (!cleanMessage) {
    return { reply: await getText(userId, 'aiAssistantScopeLimit'), offerSupport: false, history: Array.isArray(state.history) ? state.history : [] };
  }

  if (isSupportIntentText(cleanMessage)) {
    return {
      reply: await getText(userId, 'aiAssistantContactSupportAsk'),
      offerSupport: true,
      history: Array.isArray(state.history) ? state.history : []
    };
  }

  const trainedAnswer = await findAssistantTrainingAnswer(cleanMessage);
  if (trainedAnswer) {
    const previousHistory = Array.isArray(state.history) ? state.history.slice(-8) : [];
    return {
      reply: trainedAnswer,
      offerSupport: false,
      history: [...previousHistory, { role: 'user', content: cleanMessage }, { role: 'assistant', content: trainedAnswer }].slice(-8)
    };
  }

  const previousHistory = Array.isArray(state.history) ? state.history.slice(-8) : [];
  if (!OPENAI_API_KEY) {
    const fallbackReply = await buildFallbackAssistantReply(userId, cleanMessage, state);
    return {
      reply: `${await getText(userId, 'aiAssistantUnavailable')}

${fallbackReply}`,
      offerSupport: false,
      history: [...previousHistory, { role: 'user', content: cleanMessage }, { role: 'assistant', content: fallbackReply }].slice(-8)
    };
  }

  const context = await buildAssistantCatalogContext(userId, state);
  const trainingExamples = await getAssistantTrainingExamples();
  const trainingText = trainingExamples.length
    ? trainingExamples.slice(-20).map((item, index) => `Example ${index + 1}
Q: ${item.question}
A: ${item.answer}`).join('\n\n')
    : 'No custom training examples.';

  const payload = await callOpenAIJson([
    {
      role: 'system',
      content: 'You are the AI assistant inside a Telegram bot that sells digital subscriptions and codes. Answer ONLY about this bot, its available products, remaining stock, prices, payment flow, verification flow, and the current user own balance. You may compare products, explain what a subscription is, suggest the next step, and keep answers concise and practical. Never reveal secrets, tokens, raw database content, admin-only settings, payment wallet addresses, internal configuration, or other users balances. If the user asks about anything outside the bot services, politely say you only help with this bot. If the user wants a human or support, set offer_support to true. Return strict JSON with keys reply and offer_support.'
    },
    {
      role: 'system',
      content: `Bot context JSON:
${JSON.stringify(context)}`
    },
    {
      role: 'system',
      content: `Admin training examples:
${trainingText}`
    },
    ...previousHistory,
    { role: 'user', content: cleanMessage }
  ], { temperature: 0.2, maxTokens: 850 });

  const reply = String(payload?.reply || '').trim() || await buildFallbackAssistantReply(userId, cleanMessage, state);
  const offerSupport = Boolean(payload?.offer_support);
  const nextHistory = [...previousHistory, { role: 'user', content: cleanMessage }, { role: 'assistant', content: reply }].slice(-8);
  return { reply, offerSupport, history: nextHistory };
}

async function processAssistantMessageTurn(userId, trimmed, state = {}) {
  const deterministic = await handleDeterministicAssistantRequest(userId, trimmed, state);
  if (deterministic.handled) {
    if (deterministic.nextState) {
      await setUserState(userId, deterministic.nextState);
    } else {
      await setUserState(userId, {
        action: 'ai_assistant',
        history: Array.isArray(state.history) ? state.history.slice(-8) : [],
        focusMerchantId: state.focusMerchantId || null,
        awaitingSupportConfirm: false,
        awaitingPurchaseConfirm: false
      });
    }

    await bot.sendMessage(userId, deterministic.reply, {
      reply_markup: deterministic.replyMarkup || await getBackAndCancelReplyMarkup(userId, state.focusMerchantId ? `digital_product_${state.focusMerchantId}` : 'back_to_menu')
    });
    return true;
  }

  const thinkingMessage = await bot.sendMessage(userId, await getText(userId, 'aiAssistantThinking'));
  const aiResult = await askBotAssistant(userId, trimmed, state);
  await bot.deleteMessage(userId, thinkingMessage.message_id).catch(() => {});

  await setUserState(userId, {
    action: 'ai_assistant',
    history: aiResult.history,
    focusMerchantId: state.focusMerchantId || null,
    awaitingSupportConfirm: Boolean(aiResult.offerSupport),
    awaitingPurchaseConfirm: false
  });

  const replyMarkup = aiResult.offerSupport
    ? {
        inline_keyboard: [
          [{ text: await getText(userId, 'aiAssistantSupportYes'), callback_data: 'ai_support_yes' }],
          [{ text: await getText(userId, 'aiAssistantSupportNo'), callback_data: 'ai_support_no' }],
          [{ text: await getText(userId, 'back'), callback_data: 'back_to_menu' }]
        ]
      }
    : await getBackAndCancelReplyMarkup(userId, state.focusMerchantId ? `digital_product_${state.focusMerchantId}` : 'back_to_menu');

  await bot.sendMessage(userId, aiResult.reply, { reply_markup: replyMarkup });
  return true;
}

function extractChatGptUpLinks(rawText) {
  const text = String(rawText || '');
  const matches = [];
  const regex = /(?:https?:\/\/)?(?:www\.)?chatgpt\.com\/up\/[A-Z0-9]{16}/gi;
  let m;
  while ((m = regex.exec(text)) !== null) {
    let link = m[0].trim();
    if (!/^https?:\/\//i.test(link)) {
      link = `http://${link.replace(/^\/+/, '')}`;
    }
    link = link.replace(/^http:\/\/www\./i, 'http://www.');
    link = link.replace(/^http:\/\/(?!www\.)/i, 'http://');
    matches.push(link);
  }
  return [...new Set(matches)];
}

function formatDateParts(date) {
  const d = new Date(date);
  return {
    year: d.getFullYear(),
    month: String(d.getMonth() + 1).padStart(2, '0'),
    day: String(d.getDate()).padStart(2, '0'),
    hour: String(d.getHours()).padStart(2, '0'),
    minute: String(d.getMinutes()).padStart(2, '0'),
    second: String(d.getSeconds()).padStart(2, '0')
  };
}

async function getBotUsername() {
  if (BOT_USERNAME_CACHE) return BOT_USERNAME_CACHE;
  try {
    const botInfo = await bot.getMe();
    BOT_USERNAME_CACHE = botInfo?.username || process.env.PUBLIC_BOT_USERNAME || '';
    return BOT_USERNAME_CACHE;
  } catch (err) {
    console.error('getBotUsername error:', err.message);
    return process.env.PUBLIC_BOT_USERNAME || '';
  }
}

async function getUserReferralLink(userId) {
  let publicUsername = await getBotUsername();
  if (!publicUsername) {
    publicUsername = process.env.PUBLIC_BOT_USERNAME || process.env.BOT_USERNAME || '';
  }
  publicUsername = String(publicUsername || '').replace(/^@/, '').trim();
  if (!publicUsername) return `https://t.me/?start=${userId}`;
  return `https://t.me/${publicUsername}?start=${userId}`;
}

async function getPrivateCodesChannelConfig() {
  const values = await Setting.findAll({
    where: {
      lang: 'global',
      key: {
        [Op.in]: [
          'private_codes_channel_enabled',
          'private_codes_channel_chat_id',
          'private_codes_channel_link',
          'private_codes_channel_title',
          'private_codes_channel_username'
        ]
      }
    }
  });

  const map = Object.fromEntries(values.map(v => [v.key, v.value]));
  return {
    enabled: String(map.private_codes_channel_enabled || 'false').toLowerCase() === 'true',
    chatId: map.private_codes_channel_chat_id || '',
    link: map.private_codes_channel_link || '',
    title: map.private_codes_channel_title || '',
    username: map.private_codes_channel_username || ''
  };
}

async function savePrivateCodesChannelConfig(config = {}) {
  const pairs = {
    private_codes_channel_enabled: config.enabled ? 'true' : 'false',
    private_codes_channel_chat_id: config.chatId || '',
    private_codes_channel_link: config.link || '',
    private_codes_channel_title: config.title || '',
    private_codes_channel_username: config.username || ''
  };
  for (const [key, value] of Object.entries(pairs)) {
    await Setting.upsert({ key, lang: 'global', value: String(value) });
  }
}


async function getReferralCodesChannelConfig() {
  const values = await Setting.findAll({
    where: {
      lang: 'global',
      key: {
        [Op.in]: [
          'referral_codes_channel_enabled',
          'referral_codes_channel_chat_id',
          'referral_codes_channel_link',
          'referral_codes_channel_title',
          'referral_codes_channel_username'
        ]
      }
    }
  });

  const map = Object.fromEntries(values.map(v => [v.key, v.value]));
  return {
    enabled: String(map.referral_codes_channel_enabled || 'false').toLowerCase() === 'true',
    chatId: map.referral_codes_channel_chat_id || '',
    link: map.referral_codes_channel_link || '',
    title: map.referral_codes_channel_title || '',
    username: map.referral_codes_channel_username || ''
  };
}

async function saveReferralCodesChannelConfig(config = {}) {
  const pairs = {
    referral_codes_channel_enabled: config.enabled ? 'true' : 'false',
    referral_codes_channel_chat_id: config.chatId || '',
    referral_codes_channel_link: config.link || '',
    referral_codes_channel_title: config.title || '',
    referral_codes_channel_username: config.username || ''
  };
  for (const [key, value] of Object.entries(pairs)) {
    await Setting.upsert({ key, lang: 'global', value: String(value) });
  }
}

async function showReferralCodesChannelAdmin(userId) {
  const config = await getReferralCodesChannelConfig();
  const status = config.enabled ? '✅ مفعل' : '⛔ متوقف';
  const msg =
    `📦 قناة الكودات\n\n` +
    `الحالة: ${status}\n` +
    `العنوان: ${config.title || 'غير محدد'}\n` +
    `الرابط: ${config.link || 'غير محدد'}\n` +
    `المعرف: ${config.username || config.chatId || 'غير محدد'}\n\n` +
    `ملاحظة: هذه القناة مخصصة فقط لزر 📥 إضافة كودات من القناة الخاصة، وسيتم تجاهل أي منشور لا يحتوي على روابط الأكواد المطلوبة. المنشور الواحد يمكن أن يحتوي على عدة أكواد، وسيتم استخراج كل كود بشكل مستقل.`;

  const keyboard = {
    inline_keyboard: [
      [{ text: config.enabled ? '⛔ إيقاف قناة الكودات' : '✅ تفعيل قناة الكودات', callback_data: 'admin_toggle_referral_codes_channel' }],
      [{ text: '🔗 تعيين قناة الكودات', callback_data: 'admin_set_referral_codes_channel' }],
      [{ text: '🔙 رجوع', callback_data: 'admin_referral_stock_settings' }]
    ]
  };

  await bot.sendMessage(userId, msg, { reply_markup: keyboard });
}


async function showPrivateCodesChannelAdmin(userId) {
  const config = await getPrivateCodesChannelConfig();
  const status = config.enabled ? '✅ مفعل' : '⛔ متوقف';
  const msg =
    `📦 إعدادات قناة الكودات الخاصة\n\n` +
    `الحالة: ${status}
` +
    `العنوان: ${config.title || 'غير محدد'}
` +
    `الرابط: ${config.link || 'غير محدد'}
` +
    `المعرف: ${config.username || config.chatId || 'غير محدد'}

` +
    `ملاحظة: أضف البوت مشرفًا في القناة الخاصة. يمكنك إرسال رابط دعوة خاص مثل t.me/+... وسيتم تجاهل أي منشور لا يحتوي على روابط الأكواد المطلوبة. المنشور الواحد يمكن أن يحتوي على عدة أكواد، وسيتم استخراج كل كود بشكل مستقل.`;

  const keyboard = {
    inline_keyboard: [[{ text: config.enabled ? '⛔ إيقاف قناة الأكواد الخاصة' : '✅ تفعيل قناة الأكواد الخاصة', callback_data: 'admin_toggle_private_codes_channel' }],
      [{ text: '🔗 تعيين القناة الخاصة', callback_data: 'admin_set_private_codes_channel' }],
      [{ text: '📤 إرسال 100 كود للقناة الخاصة', callback_data: 'admin_send_100_codes_to_private_channel' }],
      [{ text: '🔙 رجوع', callback_data: 'admin' }]
    ]
  };

  await bot.sendMessage(userId, msg, { reply_markup: keyboard });
}

async function sendCodesToPrivateChannel(adminId, quantity = 100) {
  const config = await getPrivateCodesChannelConfig();
  if (!config.enabled || !config.chatId) {
    return { success: false, reason: config.link ? 'channel_needs_forwarded_post' : 'channel_not_configured' };
  }

  const merchant = await getReferralStockMerchant();
  const codes = await Code.findAll({
    where: { merchantId: merchant.id, isUsed: false },
    limit: quantity,
    order: [['id', 'ASC']]
  });

  if (codes.length < quantity) {
    return { success: false, reason: 'not_enough_stock', available: codes.length };
  }

  const t = await sequelize.transaction();
  try {
    await Code.update(
      { isUsed: true, usedBy: adminId, soldAt: new Date() },
      { where: { id: codes.map(c => c.id) }, transaction: t }
    );
    await t.commit();
  } catch (err) {
    await t.rollback();
    console.error('sendCodesToPrivateChannel stock update error:', err);
    return { success: false, reason: 'db_error' };
  }

  const payloadLines = codes.map((c, index) => `${index + 1}- ${c.extra ? `${c.value}\n${c.extra}` : c.value}`);
  const chunks = [];
  let current = '📦 100 كود جديد للقناة الخاصة\n\n';
  for (const line of payloadLines) {
    const block = `${line}\n\n`;
    if ((current + block).length > 3500) {
      chunks.push(current.trim());
      current = block;
    } else {
      current += block;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  try {
    for (const chunk of chunks) {
      await bot.sendMessage(config.chatId, chunk);
    }
    const remaining = await Code.count({ where: { merchantId: merchant.id, isUsed: false } });
    return { success: true, sent: codes.length, remaining };
  } catch (err) {
    console.error('sendCodesToPrivateChannel telegram send error:', err.response?.body || err.message);
    await Code.update(
      { isUsed: false, usedBy: null, soldAt: null },
      { where: { id: codes.map(c => c.id) } }
    ).catch(() => {});
    return { success: false, reason: 'telegram_send_failed' };
  }
}

async function findOrCreateUser(userId) {
  const [user] = await User.findOrCreate({
    where: { id: userId },
    defaults: {
      lang: 'en',
      balance: 0,
      referralCode: generateReferralCode(userId)
    }
  });

  if (!user.referralCode) {
    user.referralCode = generateReferralCode(userId);
    await user.save();
  }

  return user;
}

async function getTelegramIdentityById(targetUserId) {
  try {
    const chat = await bot.getChat(targetUserId);
    return {
      usernameText: chat?.username ? `@${chat.username}` : 'لا يوجد',
      fullName: [chat?.first_name, chat?.last_name].filter(Boolean).join(' ').trim() || chat?.title || String(targetUserId)
    };
  } catch {
    return {
      usernameText: 'لا يوجد',
      fullName: String(targetUserId)
    };
  }
}



async function getAdminCodeSourceLabel(userId, sourceKey, usedPoints = 0) {
  const user = await User.findByPk(userId);
  const adminGranted = Number(user?.adminGrantedPoints || 0);

  if (sourceKey === 'free') return 'المجاني';
  if (sourceKey === 'referral_stock') return 'من الإحالات';
  if (sourceKey === 'balance') return 'من الرصيد';
  if (sourceKey === 'admin_points') return 'من نقاط الأدمن';
  if (sourceKey === 'points') {
    if (usedPoints > 0 && adminGranted >= usedPoints) return 'من نقاط الأدمن';
    return 'من النقاط';
  }
  return sourceKey || 'غير محدد';
}

async function sendAdminCodeActionNotice(userId, options = {}) {
  try {
    const {
      sourceKey = 'غير محدد',
      serviceType = 'غير محدد',
      codesCount = 1,
      usedPoints = 0,
      remainingStockText = 'من الموقع',
      extraCodeCount = null
    } = options;

    const user = await User.findByPk(userId);
    const identity = await getTelegramIdentityById(userId);
    const referrals = await getSuccessfulReferralCount(userId);
    const sourceLabel = await getAdminCodeSourceLabel(userId, sourceKey, usedPoints);

    const now = new Date();
    const dateText = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const timeText = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

    const message =
      `📢 ${sourceKey === 'balance' ? 'شخص اشترى كود' : 'شخص سحب/استبدل كود'}\n\n` +
      `الاسم: ${identity.fullName}\n` +
      `المعرف: ${identity.usernameText}\n` +
      `الايدي: ${userId}\n` +
      `الرصيد: ${Number(user?.balance || 0).toFixed(2)}\n` +
      `عدد نقاطه: ${Number(user?.referralPoints || 0)}\n` +
      `كم كود سحب: ${extraCodeCount ?? codesCount}\n` +
      `كم عدد الدعوات: ${referrals}\n` +
      `نوع الخدمة: ${serviceType}\n` +
      `مصدر الكود: ${sourceLabel}\n` +
      `الساعة: ${timeText}\n` +
      `التاريخ: ${dateText}\n\n` +
      `كم تبقى بالمخزون: ${remainingStockText}`;

    await bot.sendMessage(ADMIN_ID, message).catch(() => {});
  } catch (err) {
    console.error('sendAdminCodeActionNotice error:', err);
  }
}

async function getChannelConfig() {
  let config = await ChannelConfig.findOne();
  if (!config) {
    config = await ChannelConfig.create({
      enabled: false,
      link: null,
      messageText: null,
      chatId: null,
      username: null,
      title: null
    });
  }

  if (config.link && !config.chatId) {
    await ensureChannelConfigResolved(config);
  }

  return config;
}

async function isMandatoryVerificationEnabled() {
  const config = await getChannelConfig();
  return Boolean(config.enabled);
}

async function isVerificationRequiredForUser(userId) {
  if (isAdmin(userId)) return false;

  const config = await getChannelConfig();
  if (!config.enabled) return false;

  const hasTarget = Boolean(config.chatId || config.username || parseChannelTarget(config.link));
  return hasTarget;
}

function parseChannelTarget(value) {
  if (!value) return null;
  let target = String(value).trim();

  target = target
    .replace(/^https?:\/\/t\.me\//i, '')
    .replace(/^t\.me\//i, '')
    .replace(/^telegram\.me\//i, '');

  target = target.split(/[/?#]/)[0].trim();

  if (!target) return null;
  if (/^(\+|joinchat)/i.test(target)) return null;
  if (/^-100\d+$/.test(target)) return target;
  if (target.startsWith('@')) return target;
  if (/^[A-Za-z0-9_]{5,}$/.test(target)) return `@${target}`;
  return null;
}

async function resolveChannelTarget(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    return { ok: false, reason: 'empty', message: 'Channel value is empty.' };
  }

  if (/t\.me\/(\+|joinchat)/i.test(raw)) {
    return {
      ok: false,
      reason: 'invite_link_not_supported',
      message: 'Invite links like t.me/+... cannot be checked reliably. Send @channelusername or the numeric chat id that starts with -100.'
    };
  }

  const target = parseChannelTarget(raw);
  if (!target) {
    return {
      ok: false,
      reason: 'invalid_target',
      message: 'Invalid channel value. Send @channelusername or the numeric chat id that starts with -100.'
    };
  }

  try {
    const chat = await bot.getChat(target);
    const username = chat.username ? `@${chat.username}` : (target.startsWith('@') ? target : null);
    const link = chat.username ? `https://t.me/${chat.username}` : raw;

    return {
      ok: true,
      chatId: String(chat.id),
      username,
      title: chat.title || username || String(chat.id),
      link,
      type: chat.type
    };
  } catch (err) {
    console.error('Error resolving channel target:', err.response?.body || err.message);
    return {
      ok: false,
      reason: 'resolve_failed',
      message: 'The bot could not access this channel. Make sure the bot is added as an administrator in the channel, then send @channelusername or the chat id again.'
    };
  }
}


function isTelegramInviteLink(value) {
  return /^(https?:\/\/)?t\.me\/(\+|joinchat\/).+/i.test(String(value || '').trim());
}

function normalizeTelegramInviteLink(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^t\.me\//i.test(raw)) return `https://${raw}`;
  return raw;
}

async function resolvePrivateCodesChannelTarget(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    return { ok: false, reason: 'empty', message: 'قيمة القناة فارغة.' };
  }

  if (isTelegramInviteLink(raw)) {
    return {
      ok: true,
      inviteOnly: true,
      chatId: '',
      username: '',
      title: 'قناة خاصة عبر رابط دعوة',
      link: normalizeTelegramInviteLink(raw),
      type: 'channel',
      message: '✅ تم حفظ رابط الدعوة الخاص. لإكمال الإرسال إلى القناة، قم أيضاً بإعادة توجيه منشور من نفس القناة مرة واحدة ليتم حفظ chat_id.'
    };
  }

  return resolveChannelTarget(raw);
}

async function ensureChannelConfigResolved(config) {
  if (!config || !config.link || config.chatId) return config;

  const resolved = await resolveChannelTarget(config.link);
  if (!resolved.ok) return config;

  config.chatId = resolved.chatId;
  config.username = resolved.username;
  config.title = resolved.title;
  config.link = resolved.link || config.link;
  await config.save();
  return config;
}

async function checkChannelMembership(userId) {
  if (isAdmin(userId)) return true;

  const config = await getChannelConfig();
  if (!config.enabled) return true;
  if (!config.link && !config.chatId && !config.username) return true;

  const targets = [];
  if (config.chatId) targets.push(String(config.chatId));
  if (config.username) targets.push(String(config.username));

  const parsedFromLink = parseChannelTarget(config.link);
  if (parsedFromLink && !targets.includes(parsedFromLink)) {
    targets.push(parsedFromLink);
  }

  if (targets.length === 0) {
    console.error('❌ Mandatory verification is enabled, but no verifiable channel target was found.');
    return false;
  }

  for (const target of targets) {
    try {
      const chatMember = await bot.getChatMember(target, userId);

      if (['member', 'administrator', 'creator'].includes(chatMember.status)) {
        return true;
      }

      if (['left', 'kicked'].includes(chatMember.status)) {
        return false;
      }

      if (chatMember.status === 'restricted') {
        return true;
      }
    } catch (err) {
      const body = err.response?.body || {};
      console.error(`Error checking channel membership with target ${target}:`, body || err.message);
    }
  }

  return false;
}

async function sendJoinChannelMessage(userId) {
  const config = await getChannelConfig();
  if (isAdmin(userId) || !config.enabled) return;

  const extraParts = [];
  if (config.messageText) extraParts.push(config.messageText);
  if (config.title) extraParts.push(`Channel: ${config.title}`);
  if (config.username && (!config.link || !config.link.includes('t.me/'))) {
    extraParts.push(config.username);
  }

  const extraMessage = extraParts.join('\n');
  const finalMsg = await getText(userId, 'mustJoinChannel', { message: extraMessage });

  const joinUrl =
    config.link ||
    (config.username ? `https://t.me/${config.username.replace(/^@/, '')}` : null);

  const keyboardRows = [];
  if (joinUrl) {
    keyboardRows.push([{ text: await getText(userId, 'joinChannel'), url: joinUrl }]);
  }
  keyboardRows.push([{ text: await getText(userId, 'checkSubscription'), callback_data: 'check_subscription' }]);

  await bot.sendMessage(userId, finalMsg, {
    reply_markup: { inline_keyboard: keyboardRows }
  });
}

function generateCaptcha() {
  const a = Math.floor(Math.random() * 10);
  const b = Math.floor(Math.random() * 10);
  return { challenge: `${a} + ${b}`, answer: a + b };
}

async function createCaptcha(userId) {
  const { challenge, answer } = generateCaptcha();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await Captcha.upsert({ userId, challenge, answer, expiresAt });
  return challenge;
}

async function verifyCaptcha(userId, answerText) {
  const captcha = await Captcha.findByPk(userId);
  if (!captcha) return false;
  if (captcha.expiresAt < new Date()) {
    await Captcha.destroy({ where: { userId } });
    return false;
  }

  const value = parseInt(String(answerText).trim(), 10);
  if (Number.isNaN(value)) return false;

  if (value === captcha.answer) {
    await Captcha.destroy({ where: { userId } });
    return true;
  }

  return false;
}

async function awardReferralPoints(referredUserId) {
  const t = await sequelize.transaction();
  try {
    const referred = await User.findByPk(referredUserId, {
      transaction: t,
      lock: t.LOCK.UPDATE
    });

    if (!referred || !referred.referredBy || referred.referralRewarded) {
      await t.rollback();
      return false;
    }

    const referrer = await User.findByPk(referred.referredBy, {
      transaction: t,
      lock: t.LOCK.UPDATE
    });

    if (!referrer) {
      await t.rollback();
      return false;
    }

    const [updatedCount] = await User.update(
      { referralRewarded: true },
      {
        where: {
          id: referredUserId,
          referredBy: referred.referredBy,
          referralRewarded: false
        },
        transaction: t
      }
    );

    if (updatedCount !== 1) {
      await t.rollback();
      return false;
    }

    await User.increment(
      { referralPoints: 1 },
      {
        where: { id: referrer.id },
        transaction: t
      }
    );

    const rewardedReferralCount = await User.count({
      where: {
        referredBy: referrer.id,
        referralRewarded: true
      },
      transaction: t
    });

    const milestoneBonus = await getReferralMilestoneBonus(rewardedReferralCount);
    if (milestoneBonus > 0) {
      await User.increment(
        { referralPoints: milestoneBonus, referralMilestoneGrantedPoints: milestoneBonus },
        {
          where: { id: referrer.id },
          transaction: t
        }
      );
    }

    await t.commit();

    const updatedReferrer = await User.findByPk(referrer.id);
    const updatedPoints = Number(updatedReferrer?.referralPoints || 0);

    await bot.sendMessage(referrer.id, await getText(referrer.id, 'referralEarned', {
      points: updatedPoints
    }));

    if (milestoneBonus > 0) {
      await bot.sendMessage(referrer.id, await getText(referrer.id, 'referralMilestoneBonus', {
        bonus: milestoneBonus,
        points: updatedPoints
      }));
    }

    return true;
  } catch (err) {
    await t.rollback().catch(() => {});
    console.error('awardReferralPoints error:', err);
    return false;
  }
}

async function tryAwardReferralIfEligible(userId) {
  if (!(await getReferralEnabled())) return false;
  const user = await User.findByPk(userId);
  if (!user || !user.referredBy || user.referralRewarded) return false;

  const verificationRequired = await isVerificationRequiredForUser(userId);
  if (verificationRequired && !user.verified) return false;

  return awardReferralPoints(userId);
}

async function ensureUserAccess(userId, options = {}) {
  const { sendJoinPrompt = true, sendCaptchaPrompt = true } = options;
  const user = await User.findByPk(userId);
  if (!user) return false;
  if (isAdmin(userId)) return true;

  const verificationRequired = await isVerificationRequiredForUser(userId);
  if (!verificationRequired) return true;

  const isMember = await checkChannelMembership(userId);
  if (!isMember) {
    if (sendJoinPrompt) await sendJoinChannelMessage(userId);
    return false;
  }

  if (user.verified) return true;

  let captcha = await Captcha.findByPk(userId);
  if (!captcha || captcha.expiresAt < new Date()) {
    const challenge = await createCaptcha(userId);
    if (sendCaptchaPrompt) {
      await bot.sendMessage(userId, await getText(userId, 'captchaChallenge', { challenge }));
    }
    return false;
  }

  if (sendCaptchaPrompt) {
    await bot.sendMessage(userId, await getText(userId, 'captchaChallenge', { challenge: captcha.challenge }));
  }

  return false;
}

async function handleVerificationSuccess(userId) {
  const user = await User.findByPk(userId);
  if (!user) return;

  if (!user.verified) {
    user.verified = true;
    await user.save();
  }

  await bot.sendMessage(userId, await getText(userId, 'captchaSuccess'));

  await tryAwardReferralIfEligible(userId);

  await sendMainMenu(userId);
}

const DEFAULT_BUTTONS = {
  redeem: true,
  buy: true,
  my_balance: true,
  deposit: true,
  referral: true,
  discount: true,
  my_purchases: true,
  support: true,
  ai_assistant: true,
  change_language: true,
  chatgpt_code: true,
  digital_sections_group: true,
  free_code: true,
  admin_panel: true
};

const DEFAULT_BUTTON_ORDER = [
  'buy',
  'chatgpt_code',
  'digital_sections_group',
  'my_balance',
  'deposit',
  'my_purchases',
  'redeem',
  'referral',
  'discount',
  'support',
  'ai_assistant',
  'change_language',
  'free_code',
  'admin_panel'
];

async function getMenuButtonsVisibility() {
  const setting = await Setting.findOne({ where: { key: 'menu_buttons', lang: 'global' } });
  if (!setting) return { ...DEFAULT_BUTTONS };

  try {
    return { ...DEFAULT_BUTTONS, ...JSON.parse(setting.value) };
  } catch {
    return { ...DEFAULT_BUTTONS };
  }
}

async function setMenuButtonsVisibility(visibility) {
  await Setting.upsert({
    key: 'menu_buttons',
    lang: 'global',
    value: JSON.stringify(visibility)
  });
}

async function getExpandedDefaultButtonOrder() {
  const digitalEntries = (await getAllDigitalSections()).map(section => getDigitalSectionCategory(section.id));
  const expanded = [];

  for (const id of DEFAULT_BUTTON_ORDER) {
    if (id === 'digital_sections_group') {
      expanded.push(...digitalEntries);
    } else {
      expanded.push(id);
    }
  }

  return expanded;
}

async function getMenuButtonsOrder() {
  const defaultOrder = await getExpandedDefaultButtonOrder();
  const activeDigitalEntries = new Set((await getAllDigitalSections()).map(section => getDigitalSectionCategory(section.id)));
  const staticEntries = new Set(DEFAULT_BUTTON_ORDER.filter(id => id !== 'digital_sections_group'));
  const setting = await Setting.findOne({ where: { key: 'menu_buttons_order', lang: 'global' } });
  if (!setting) return defaultOrder;

  try {
    const savedOrder = JSON.parse(setting.value);
    if (!Array.isArray(savedOrder)) return defaultOrder;

    const normalized = [];
    for (const id of savedOrder) {
      if (id === 'digital_sections_group') {
        for (const digitalId of activeDigitalEntries) {
          if (!normalized.includes(digitalId)) normalized.push(digitalId);
        }
        continue;
      }

      if ((staticEntries.has(id) || activeDigitalEntries.has(id)) && !normalized.includes(id)) {
        normalized.push(id);
      }
    }

    for (const id of defaultOrder) {
      if (!normalized.includes(id)) normalized.push(id);
    }

    return normalized;
  } catch {
    return defaultOrder;
  }
}

async function syncDigitalSectionOrderWithMainMenu(orderInput = null) {
  const order = Array.isArray(orderInput) ? orderInput : await getMenuButtonsOrder();
  const digitalIds = order
    .map(id => parseDigitalSectionIdFromCategory(id))
    .filter(id => Number.isInteger(id));

  if (!digitalIds.length) return false;

  for (let i = 0; i < digitalIds.length; i += 1) {
    await DigitalSection.update({ sortOrder: i + 1 }, { where: { id: digitalIds[i] } });
  }

  return true;
}

async function setMenuButtonsOrder(order) {
  await Setting.upsert({
    key: 'menu_buttons_order',
    lang: 'global',
    value: JSON.stringify(order)
  });
  await syncDigitalSectionOrderWithMainMenu(order);
}

async function moveMenuButton(buttonId, direction) {
  const order = await getMenuButtonsOrder();
  const index = order.indexOf(buttonId);
  if (index === -1) return false;

  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= order.length) return false;

  [order[index], order[targetIndex]] = [order[targetIndex], order[index]];
  await setMenuButtonsOrder(order);
  return true;
}

async function getMenuButtonItems(userId) {
  return [
    { id: 'buy', name: await getText(userId, 'buy') },
    { id: 'chatgpt_code', name: await getChatGptMenuLabel(userId) },
    { id: 'my_balance', name: await getText(userId, 'myBalance') },
    { id: 'deposit', name: await getText(userId, 'deposit') },
    { id: 'my_purchases', name: await getText(userId, 'myPurchases') },
    { id: 'redeem', name: await getText(userId, 'redeem') },
    { id: 'referral', name: await getText(userId, 'referral') },
    { id: 'discount', name: await getText(userId, 'discountButton') },
    { id: 'support', name: await getText(userId, 'support') },
    { id: 'ai_assistant', name: await getText(userId, 'aiAssistant') },
    { id: 'change_language', name: await getText(userId, 'changeLanguage') },
    { id: 'free_code', name: await getText(userId, 'freeCodeMenu') },
    { id: 'admin_panel', name: await getText(userId, 'adminPanel') }
  ];
}

async function showMenuButtonsAdmin(userId) {
  const visibility = await getMenuButtonsVisibility();
  const items = await getMenuButtonItems(userId);
  const digitalSections = await getAllDigitalSections();
  const hiddenProductIds = new Set(await getHiddenDigitalProductIds());
  const digitalProductItemsBySectionId = new Map();
  const itemsMap = new Map(items.map(item => [item.id, { ...item, type: 'static' }]));

  for (const section of digitalSections) {
    itemsMap.set(getDigitalSectionCategory(section.id), {
      id: getDigitalSectionCategory(section.id),
      sectionId: section.id,
      type: 'digital',
      name: `🧩 ${section.nameEn} / ${section.nameAr}`,
      enabled: section.isActive
    });

    const products = await getDigitalProductsForSection(section.id);
    digitalProductItemsBySectionId.set(section.id, products.map(product => ({
      productId: product.id,
      name: `${product.nameEn} / ${product.nameAr}`
    })));
  }

  const order = await getMenuButtonsOrder();
  const orderedItems = order.map(id => itemsMap.get(id)).filter(Boolean);

  const keyboard = [];
  for (let i = 0; i < orderedItems.length; i += 1) {
    const item = orderedItems[i];
    const enabled = item.type === 'digital' ? item.enabled : visibility[item.id] !== false;
    const action = enabled ? 'hide' : 'show';

    keyboard.push([
      {
        text: `${enabled ? '✅' : '❌'} ${item.name}`,
        callback_data: item.type === 'digital'
          ? `toggle_digital_menu_button_${item.sectionId}_${action}`
          : `toggle_button_${item.id}_${action}`
      },
      {
        text: '⬆️',
        callback_data: i === 0
          ? 'ignore'
          : (item.type === 'digital'
            ? `move_digital_menu_button_${item.sectionId}_up`
            : `move_button_${item.id}_up`)
      },
      {
        text: '⬇️',
        callback_data: i === orderedItems.length - 1
          ? 'ignore'
          : (item.type === 'digital'
            ? `move_digital_menu_button_${item.sectionId}_down`
            : `move_button_${item.id}_down`)
      }
    ]);

    if (item.type === 'digital') {
      const productItems = digitalProductItemsBySectionId.get(item.sectionId) || [];
      for (const productItem of productItems) {
        const productEnabled = !hiddenProductIds.has(productItem.productId);
        const productAction = productEnabled ? 'hide' : 'show';
        keyboard.push([{
          text: `${productEnabled ? '✅' : '❌'} └ 🧾 ${productItem.name}`,
          callback_data: `toggle_digital_product_menu_button_${productItem.productId}_${productAction}`
        }]);
      }
    }
  }

  keyboard.push([{ text: await getText(userId, 'colorButtons'), callback_data: 'admin_color_buttons' }]);
  keyboard.push([{ text: await getText(userId, 'back'), callback_data: 'admin' }]);

  await bot.sendMessage(userId, await getText(userId, 'manageMenuButtons'), {
    reply_markup: { inline_keyboard: keyboard }
  });
}


async function getButtonStyleLabel(userId, style) {
  const normalized = normalizeTelegramButtonStyle(style);
  if (!normalized) return await getText(userId, 'buttonStyleDefault');
  if (normalized === 'primary') return await getText(userId, 'buttonStylePrimary');
  if (normalized === 'success') return await getText(userId, 'buttonStyleSuccess');
  if (normalized === 'danger') return await getText(userId, 'buttonStyleDanger');
  return await getText(userId, 'buttonStyleDefault');
}

async function getColorableButtonItems(userId) {
  const items = [];
  const staticItems = await getMenuButtonItems(userId);

  for (const item of staticItems) {
    items.push({
      type: 'static',
      id: item.id,
      styleKey: getStyleKey('static', item.id),
      name: item.name
    });
  }

  const sections = await getAllDigitalSections();
  for (const section of sections) {
    items.push({
      type: 'section',
      id: section.id,
      styleKey: getStyleKey('section', section.id),
      name: `🧩 ${section.nameEn} / ${section.nameAr}`
    });
  }

  const sectionCategories = sections.map(section => getDigitalSectionCategory(section.id));
  if (sectionCategories.length) {
    const products = await Merchant.findAll({
      where: { category: { [Op.in]: sectionCategories } },
      order: [['id', 'ASC']]
    });

    for (const product of products) {
      const stock = await getMerchantAvailableStock(product.id);
      items.push({
        type: 'product',
        id: product.id,
        styleKey: getStyleKey('product', product.id),
        name: `🧾 ${product.nameEn} / ${product.nameAr} (${stock})`,
        stock
      });
    }
  }

  return items;
}

async function findColorableButtonItem(userId, type, id) {
  const items = await getColorableButtonItems(userId);
  return items.find(item => item.type === type && String(item.id) === String(id)) || null;
}

async function showButtonColorAdmin(userId) {
  const items = await getColorableButtonItems(userId);
  const styleMap = await getButtonStyleMap();
  const keyboard = [];

  for (const item of items) {
    const currentStyle = normalizeTelegramButtonStyle(styleMap[item.styleKey]);
    const styleLabel = await getButtonStyleLabel(userId, currentStyle);
    const stockWarning = item.type === 'product' ? (Number(item.stock || 0) <= 0 ? ' 🔴' : ' 🟢') : '';
    keyboard.push([{
      text: `${styleLabel}${stockWarning} ${item.name}`,
      callback_data: `admin_button_color_item_${item.type}_${item.id}`
    }]);
  }

  keyboard.push([{ text: await getText(userId, 'back'), callback_data: 'admin' }]);

  await bot.sendMessage(userId, await getText(userId, 'buttonColorChooseButton'), {
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function showButtonColorChoices(userId, type, id) {
  const item = await findColorableButtonItem(userId, type, id);
  if (!item) {
    await bot.sendMessage(userId, await getText(userId, 'buttonNameNotFound'), {
      reply_markup: await getBackAndCancelReplyMarkup(userId, 'admin_color_buttons')
    });
    return;
  }

  const styleMap = await getButtonStyleMap();
  const currentStyle = normalizeTelegramButtonStyle(styleMap[item.styleKey]);
  const colorRows = [
    { style: 'primary', textKey: 'buttonStylePrimary' },
    { style: 'success', textKey: 'buttonStyleSuccess' },
    { style: 'danger', textKey: 'buttonStyleDanger' },
    { style: 'default', textKey: 'buttonStyleDefault' }
  ];

  const keyboard = [];
  for (const row of colorRows) {
    keyboard.push([{
      text: `${currentStyle === row.style || (!currentStyle && row.style === 'default') ? '✅ ' : ''}${await getText(userId, row.textKey)}`,
      callback_data: `admin_button_color_set_${type}_${id}_${row.style}`
    }]);
  }
  keyboard.push([{ text: await getText(userId, 'back'), callback_data: 'admin_color_buttons' }]);

  await bot.sendMessage(userId, await getText(userId, 'buttonColorChooseStyle', { name: item.name }), {
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function toggleMenuButton(buttonId, action) {
  const digitalSectionId = parseDigitalSectionIdFromCategory(buttonId);
  if (Number.isInteger(digitalSectionId)) {
    return await setDigitalSectionVisibility(digitalSectionId, action === 'show');
  }

  const visibility = await getMenuButtonsVisibility();
  visibility[buttonId] = action === 'show';
  await setMenuButtonsVisibility(visibility);
}

function getDefaultDepositValues(currency) {
  if (currency === 'USD') {
    return {
      currency: 'USD',
      rate: 1,
      walletAddress: 'T...',
      instructions: 'Send USDT to one of the payment methods above.',
      displayNameEn: 'Binance',
      displayNameAr: 'بايننس',
      templateEn: '💰 Send {amount} USDT to one of the following payment methods:\n\n{methods_block}\n\nThen send a screenshot of the payment with any message.\n\n{instructions}',
      templateAr: '💰 قم بإرسال {amount} USDT إلى إحدى طرق الدفع التالية:\n\n{methods_block}\n\nثم أرسل صورة التحويل مع أي رسالة.\n\n{instructions}',
      methods: [{ nameAr: 'بايننس', nameEn: 'Binance', value: '123456' }]
    };
  }
  return {
    currency: 'IQD',
    rate: 1500,
    walletAddress: 'SuperKey...',
    instructions: 'Send IQD to one of the payment methods above.',
    displayNameEn: 'Iraqi Dinar',
    displayNameAr: 'دينار عراقي',
    templateEn: '💰 Send {amountIQD} Iraqi Dinar (≈ {amountUSD} USD at rate {rate} IQD/USD) to one of the following payment methods:\n\n{methods_block}\n\nThen send a screenshot of the payment with any message.\n\n{instructions}',
    templateAr: '💰 قم بإرسال {amountIQD} دينار عراقي (≈ {amountUSD} دولار بسعر صرف {rate} دينار/دولار) إلى إحدى طرق الدفع التالية:\n\n{methods_block}\n\nثم أرسل صورة التحويل مع أي رسالة.\n\n{instructions}',
    methods: [{ nameAr: 'سوبركي', nameEn: 'SuperKey', value: '123456' }]
  };
}

function normalizeDepositMethods(methods) {
  if (Array.isArray(methods)) return methods.filter(Boolean);
  if (!methods) return [];
  try {
    const parsed = typeof methods === 'string' ? JSON.parse(methods) : methods;
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function getDepositConfig(currency) {
  let config = await DepositConfig.findOne({ where: { currency } });
  const defaults = getDefaultDepositValues(currency);

  if (!config) {
    config = await DepositConfig.create({ ...defaults, isActive: true });
  } else {
    let changed = false;

    for (const [key, value] of Object.entries(defaults)) {
      const current = config[key];
      if (
        current === null ||
        current === undefined ||
        current === '' ||
        (key === 'methods' && (!Array.isArray(current) || current.length === 0))
      ) {
        config[key] = value;
        changed = true;
      }
    }

    const methods = normalizeDepositMethods(config.methods);
    if (methods.length === 0 && config.walletAddress) {
      config.methods = [{
        nameAr: currency === 'USD' ? 'بايننس' : 'سوبركي',
        nameEn: currency === 'USD' ? 'Binance' : 'SuperKey',
        value: config.walletAddress
      }];
      changed = true;
    } else {
      config.methods = methods;
    }

    if (changed) await config.save();
  }

  return config;
}

async function updateDepositConfig(currency, field, value) {
  const config = await getDepositConfig(currency);
  config[field] = value;
  await config.save();
  return config;
}

async function getDepositDisplayName(userId, currency) {
  const user = await User.findByPk(userId);
  const lang = user?.lang || 'en';
  const config = await getDepositConfig(currency);
  return lang === 'ar' ? (config.displayNameAr || getDefaultDepositValues(currency).displayNameAr) : (config.displayNameEn || getDefaultDepositValues(currency).displayNameEn);
}

function formatDepositMethodsForMessage(methods, lang) {
  const list = normalizeDepositMethods(methods);
  if (list.length === 0) return '`N/A`';
  return list.map((item) => {
    const name = lang === 'ar' ? (item.nameAr || item.nameEn || 'طريقة دفع') : (item.nameEn || item.nameAr || 'Payment Method');
    return `• ${name}: \`${item.value}\``;
  }).join('\n');
}

async function renderDepositMessage(userId, currency, amount) {
  const user = await User.findByPk(userId);
  const lang = user?.lang || 'en';
  const config = await getDepositConfig(currency);
  const template = lang === 'ar' ? (config.templateAr || getDefaultDepositValues(currency).templateAr) : (config.templateEn || getDefaultDepositValues(currency).templateEn);
  const amountIQDRaw = currency === 'IQD' ? amount * config.rate : null;
  const amountIQD = amountIQDRaw === null ? null : Number(amountIQDRaw).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  });
  const methodsBlock = formatDepositMethodsForMessage(config.methods, lang);

  let msg = template;
  const replacements = {
    amount: amount,
    amountUSD: amount,
    amountIQD: amountIQD,
    rate: config.rate,
    methods_block: methodsBlock,
    instructions: config.instructions || '',
    address: config.walletAddress || ''
  };

  for (const [k, v] of Object.entries(replacements)) {
    msg = msg.replace(new RegExp(`\\{${k}\\}`, 'g'), v === null || v === undefined ? '' : String(v));
  }

  return msg;
}

async function showDepositSettingsAdmin(userId) {
  const usdConfig = await getDepositConfig('USD');
  const iqdConfig = await getDepositConfig('IQD');

  const formatMethods = (methods, lang) => {
    const list = normalizeDepositMethods(methods);
    if (list.length === 0) return lang === 'ar' ? 'لا توجد طرق دفع' : 'No methods';
    return list.map((m, i) => {
      const name = lang === 'ar' ? (m.nameAr || m.nameEn) : (m.nameEn || m.nameAr);
      return `${i + 1}. ${name}: ${m.value}`;
    }).join('\n');
  };

  const msg =
    `💱 *${await getText(userId, 'manageDepositSettings')}*\n\n` +
    `• ${iqdConfig.displayNameAr} / ${iqdConfig.displayNameEn}\n` +
    `Rate: ${iqdConfig.rate} IQD/USD\n` +
    `${formatMethods(iqdConfig.methods, 'ar')}\n\n` +
    `• ${usdConfig.displayNameAr} / ${usdConfig.displayNameEn}\n` +
    `${formatMethods(usdConfig.methods, 'ar')}`;

  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, 'setIQDRate'), callback_data: 'admin_set_iqd_rate' }],
      [{ text: await getText(userId, 'editCurrencyNames'), callback_data: 'admin_edit_currency_names' }],
      [{ text: await getText(userId, 'editDepositTemplates'), callback_data: 'admin_edit_deposit_instructions' }],
      [{ text: await getText(userId, 'manageIQDMethods'), callback_data: 'admin_manage_iqd_methods' }],
      [{ text: await getText(userId, 'manageUSDMethods'), callback_data: 'admin_manage_usd_methods' }],
      [{ text: await getText(userId, 'manageDepositOptions'), callback_data: 'admin_manage_deposit_options' }],
      [{ text: await getText(userId, 'back'), callback_data: 'admin' }]
    ]
  };

  await bot.sendMessage(userId, msg, { parse_mode: 'Markdown', reply_markup: keyboard });
}

async function showCurrencyNamesEdit(userId) {
  const usd = await getDepositConfig('USD');
  const iqd = await getDepositConfig('IQD');
  const msg =
    `✏️ *${await getText(userId, 'editCurrencyNames')}*\n\n` +
    `IQD: ${iqd.displayNameAr} / ${iqd.displayNameEn}\n` +
    `USD: ${usd.displayNameAr} / ${usd.displayNameEn}`;

  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, 'editIQDNameAr'), callback_data: 'admin_edit_name_IQD_ar' }],
      [{ text: await getText(userId, 'editIQDNameEn'), callback_data: 'admin_edit_name_IQD_en' }],
      [{ text: await getText(userId, 'editUSDNameAr'), callback_data: 'admin_edit_name_USD_ar' }],
      [{ text: await getText(userId, 'editUSDNameEn'), callback_data: 'admin_edit_name_USD_en' }],
      [{ text: await getText(userId, 'back'), callback_data: 'admin_manage_deposit_settings' }]
    ]
  };

  await bot.sendMessage(userId, msg, { parse_mode: 'Markdown', reply_markup: keyboard });
}

async function showDepositInstructionsEdit(userId) {
  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, 'editIQDTemplateAr'), callback_data: 'admin_edit_template_IQD_ar' }],
      [{ text: await getText(userId, 'editIQDTemplateEn'), callback_data: 'admin_edit_template_IQD_en' }],
      [{ text: await getText(userId, 'editUSDTemplateAr'), callback_data: 'admin_edit_template_USD_ar' }],
      [{ text: await getText(userId, 'editUSDTemplateEn'), callback_data: 'admin_edit_template_USD_en' }],
      [{ text: await getText(userId, 'back'), callback_data: 'admin_manage_deposit_settings' }]
    ]
  };

  await bot.sendMessage(userId, await getText(userId, 'editDepositTemplates'), { reply_markup: keyboard });
}

async function showDepositMethodsAdmin(userId, currency) {
  const config = await getDepositConfig(currency);
  const methods = normalizeDepositMethods(config.methods);
  const title = currency === 'IQD' ? await getText(userId, 'manageIQDMethods') : await getText(userId, 'manageUSDMethods');

  let msg = `💳 *${title}*\n\n`;
  if (methods.length === 0) {
    msg += await getText(userId, 'noMethods');
  } else {
    msg += methods.map((m, i) => `${i + 1}. ${m.nameAr || m.nameEn} / ${m.nameEn || m.nameAr}\n\`${m.value}\``).join('\n\n');
  }

  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, 'addDepositMethod'), callback_data: `admin_add_deposit_method_${currency}` }],
      [{ text: await getText(userId, 'deleteDepositMethod'), callback_data: `admin_delete_deposit_method_menu_${currency}` }],
      [{ text: await getText(userId, 'back'), callback_data: 'admin_manage_deposit_settings' }]
    ]
  };

  await bot.sendMessage(userId, msg, { parse_mode: 'Markdown', reply_markup: keyboard });
}

async function showDeleteDepositMethodsMenu(userId, currency) {
  const config = await getDepositConfig(currency);
  const methods = normalizeDepositMethods(config.methods);
  const buttons = methods.map((m, i) => [{ text: `${m.nameAr || m.nameEn} / ${m.nameEn || m.nameAr}`, callback_data: `admin_delete_deposit_method_${currency}_${i}` }]);
  buttons.push([{ text: await getText(userId, 'back'), callback_data: currency === 'IQD' ? 'admin_manage_iqd_methods' : 'admin_manage_usd_methods' }]);
  await bot.sendMessage(userId, await getText(userId, 'deleteDepositMethod'), { reply_markup: { inline_keyboard: buttons } });
}

async function addDepositMethod(currency, methodData) {
  const config = await getDepositConfig(currency);
  const methods = normalizeDepositMethods(config.methods);
  methods.push(methodData);
  config.methods = methods;
  if (!config.walletAddress) config.walletAddress = methodData.value;
  await config.save();
  return config;
}

async function deleteDepositMethod(currency, index) {
  const config = await getDepositConfig(currency);
  const methods = normalizeDepositMethods(config.methods);
  if (index >= 0 && index < methods.length) {
    methods.splice(index, 1);
    config.methods = methods;
    await config.save();
  }
  return config;
}


const DEFAULT_DEPOSIT_OPTION_VISIBILITY = {
  IQD: false,
  USD: false,
  BINANCE_AUTO: true
};

async function getDepositOptionVisibility() {
  const setting = await Setting.findOne({ where: { key: 'deposit_option_visibility', lang: 'global' } });
  if (!setting) return { ...DEFAULT_DEPOSIT_OPTION_VISIBILITY };
  try {
    return { ...DEFAULT_DEPOSIT_OPTION_VISIBILITY, ...JSON.parse(setting.value) };
  } catch {
    return { ...DEFAULT_DEPOSIT_OPTION_VISIBILITY };
  }
}

async function setDepositOptionVisibility(visibility) {
  await Setting.upsert({
    key: 'deposit_option_visibility',
    lang: 'global',
    value: JSON.stringify(visibility)
  });
}

async function showDepositOptionsAdmin(userId) {
  const visibility = await getDepositOptionVisibility();
  const keyboard = {
    inline_keyboard: [
      [{ text: `${visibility.BINANCE_AUTO ? '✅' : '❌'} ${await getText(userId, 'depositOptionBinanceAuto')}`, callback_data: 'admin_toggle_deposit_option_BINANCE_AUTO' }],
      [{ text: await getText(userId, 'back'), callback_data: 'admin_manage_deposit_settings' }]
    ]
  };
  await bot.sendMessage(userId, await getText(userId, 'manageDepositOptions'), { reply_markup: keyboard });
}


// -------------------------------------------------------------------
// تعديل showCurrencyOptions لإضافة زر بايننس أوتوماتيكي
async function showCurrencyOptions(userId) {
  const user = await User.findByPk(userId);
  const lang = user?.lang || 'en';
  const visibility = await getDepositOptionVisibility();
  const rows = [];
  if (visibility.BINANCE_AUTO !== false) rows.push([{ text: '⚡ Binance (USDT)', callback_data: 'deposit_binance_auto' }]);
  rows.push([{ text: await getText(userId, 'back'), callback_data: 'back_to_menu' }]);

  const extraText = visibility.BINANCE_AUTO === false ? '' : (lang === 'ar'
    ? '\n\nطريقة الشحن الحالية: ⚡ Binance (USDT)'
    : '\n\nCurrent topup method: ⚡ Binance (USDT)');

  await bot.sendMessage(userId, `${await getText(userId, 'chooseCurrency')}${extraText}`, { reply_markup: { inline_keyboard: rows } });
}

async function showBinanceAutoAmountOptions(userId) {
  const user = await User.findByPk(userId);
  const lang = user?.lang || 'en';
  const amounts = [1, 5, 10, 20, 35];
  const buttons = amounts.map(amount => ([{ text: `${amount}$`, callback_data: `deposit_binance_amount_${amount}` }]));
  buttons.push([{ text: await getText(userId, 'back'), callback_data: 'deposit' }]);

  const msg = lang === 'ar'
    ? '⚡ اختر مبلغ الشحن عبر بايننس:'
    : '⚡ Choose the Binance deposit amount:';

  await bot.sendMessage(userId, msg, {
    reply_markup: { inline_keyboard: buttons }
  });
}

async function getBinanceTransferReplyMarkup(userId) {
  return {
    inline_keyboard: [
      [{ text: await getText(userId, 'binanceTransferCheckButton'), callback_data: 'binance_transfer_prompt_order_id' }],
      [
        { text: await getText(userId, 'back'), callback_data: 'deposit_binance_auto' },
        { text: await getText(userId, 'cancel'), callback_data: 'cancel_action' }
      ]
    ]
  };
}

async function sendLegacyBinanceAutoInstructions(userId, amount) {
  return sendBinanceAutoInstructions(userId, amount);
}

async function sendBinanceAutoInstructions(userId, amount) {
  const credentials = await getBinanceCredentials();
  if (!credentials?.apiKey || !credentials?.apiSecret || !credentials?.payId) {
    await bot.sendMessage(userId, await getText(userId, 'binanceTransferNotConfigured')).catch(() => {});
    return;
  }

  const note = generateDepositNote();
  const normalizedAmount = formatUsdPrice(amount);

  await setUserState(userId, {
    action: 'binance_transfer_pending',
    amount: Number(amount),
    currency: 'USDT',
    note,
    payId: String(credentials.payId || BINANCE_PAY_ID || '').trim(),
    createdAt: Date.now()
  });

  const message = await getText(userId, 'binanceTransferInstructions', {
    amount: escapeHtml(normalizedAmount),
    payId: escapeHtml(String(credentials.payId || BINANCE_PAY_ID || '').trim()),
    note: escapeHtml(note)
  });

  await bot.sendMessage(userId, message, {
    parse_mode: 'HTML',
    reply_markup: await getBinanceTransferReplyMarkup(userId)
  });

}


async function showPaymentMethodsForDeposit(userId, amount, currency) {
  const msg = await renderDepositMessage(userId, currency, amount);
  await bot.sendMessage(userId, msg, {
    parse_mode: 'Markdown',
    reply_markup: await getBackAndCancelReplyMarkup(userId, 'deposit')
  });
  await setUserState(userId, { action: 'deposit_awaiting_proof', amount, currency });
}

const BINANCE_PAY_CERT_CACHE = {
  fetchedAt: 0,
  bySerial: new Map()
};

function isBinancePayConfigured() {
  return Boolean(BINANCE_PAY_API_KEY && BINANCE_PAY_SECRET_KEY && BINANCE_PAY_BASE_URL);
}

function getBinancePayWebhookPath() {
  return BINANCE_PAY_WEBHOOK_PATH.startsWith('/') ? BINANCE_PAY_WEBHOOK_PATH : `/${BINANCE_PAY_WEBHOOK_PATH}`;
}

function buildBinancePayWebhookUrl() {
  if (!PUBLIC_WEBHOOK_URL) return '';
  return `${PUBLIC_WEBHOOK_URL}${getBinancePayWebhookPath()}`;
}

function normalizeBinancePayCurrency(currency) {
  const value = String(currency || 'USDT').trim().toUpperCase();
  if (value === 'USD') return 'USDT';
  return value;
}

function normalizeBinancePayAmount(amount) {
  const parsed = Number(amount);
  if (!Number.isFinite(parsed)) return NaN;
  return Number(parsed.toFixed(8));
}

function isSupportedBinancePayCurrency(currency) {
  return ['USDT'].includes(normalizeBinancePayCurrency(currency));
}

function amountsMatchExactly(expected, actual) {
  const a = Number(expected);
  const b = Number(actual);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= 0.00000001;
}

function createBinancePayNonce() {
  return crypto.randomBytes(16).toString('hex').toUpperCase();
}

function buildBinancePaySignaturePayload(timestamp, nonce, bodyText) {
  return `${timestamp}
${nonce}
${bodyText}
`;
}

function signBinancePayRequest(timestamp, nonce, bodyText, secretKey) {
  const payload = buildBinancePaySignaturePayload(timestamp, nonce, bodyText);
  return crypto.createHmac('sha512', secretKey).update(payload, 'utf8').digest('hex').toUpperCase();
}

function formatBinancePayExpiresAt(value) {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  const parts = formatDateParts(date);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function generateBinancePayMerchantTradeNo(userId) {
  const userPart = String(Math.abs(parseInt(userId, 10) || 0)).slice(-8).padStart(8, '0');
  const timePart = Date.now().toString().slice(-10);
  const randomPart = crypto.randomBytes(6).toString('hex').toUpperCase();
  return `TP${timePart}${userPart}${randomPart}`.replace(/[^A-Z0-9]/g, '').slice(0, 32);
}

async function callBinancePayApi(path, payload = {}) {
  if (!isBinancePayConfigured()) {
    return { success: false, reason: 'not_configured', code: 'NOT_CONFIGURED', errorMessage: 'Binance Pay is not configured.' };
  }

  const bodyText = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
  const timestamp = Date.now().toString();
  const nonce = createBinancePayNonce();
  const signature = signBinancePayRequest(timestamp, nonce, bodyText, BINANCE_PAY_SECRET_KEY);
  const endpoint = `${BINANCE_PAY_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;

  try {
    const response = await axios.post(endpoint, bodyText, {
      timeout: 20000,
      validateStatus: () => true,
      headers: {
        'Content-Type': 'application/json',
        'BinancePay-Timestamp': timestamp,
        'BinancePay-Nonce': nonce,
        'BinancePay-Certificate-SN': BINANCE_PAY_API_KEY,
        'BinancePay-Signature': signature
      }
    });

    const body = response.data || {};
    const ok = response.status >= 200 && response.status < 300 && body.status === 'SUCCESS' && String(body.code) === '000000';
    return {
      success: ok,
      statusCode: response.status,
      code: body.code || null,
      errorMessage: body.errorMessage || body.message || null,
      data: body.data || null,
      raw: body
    };
  } catch (err) {
    console.error('Binance Pay API request error:', err.response?.data || err.message);
    return {
      success: false,
      reason: 'network_error',
      code: err.response?.data?.code || 'NETWORK_ERROR',
      errorMessage: err.response?.data?.errorMessage || err.message || 'Network error',
      data: null,
      raw: err.response?.data || null
    };
  }
}

async function fetchBinancePayCertificates(forceRefresh = false) {
  const ttlMs = 30 * 60 * 1000;
  const now = Date.now();

  if (!forceRefresh && BINANCE_PAY_CERT_CACHE.bySerial.size > 0 && (now - BINANCE_PAY_CERT_CACHE.fetchedAt) < ttlMs) {
    return { success: true, bySerial: BINANCE_PAY_CERT_CACHE.bySerial };
  }

  const response = await callBinancePayApi('/binancepay/openapi/certificates', {});
  if (!response.success) return { success: false, reason: response.reason || response.code || 'api_error', response };

  const data = response.data;
  const rows = Array.isArray(data)
    ? data
    : Array.isArray(data?.certificates)
      ? data.certificates
      : Array.isArray(data?.data)
        ? data.data
        : [];

  const bySerial = new Map();
  for (const row of rows) {
    const serial = String(row?.certSerial || row?.certSN || row?.serial || '').trim();
    const publicKey = String(row?.certPublic || row?.publicKey || '').trim();
    if (!serial || !publicKey) continue;
    bySerial.set(serial, publicKey);
  }

  if (!bySerial.size) {
    return { success: false, reason: 'empty_certificates', response };
  }

  BINANCE_PAY_CERT_CACHE.bySerial = bySerial;
  BINANCE_PAY_CERT_CACHE.fetchedAt = now;
  return { success: true, bySerial };
}

async function getBinancePayPublicKeyBySerial(certSerial) {
  const normalized = String(certSerial || '').trim();
  if (!normalized) return null;

  if (BINANCE_PAY_CERT_CACHE.bySerial.has(normalized)) {
    return BINANCE_PAY_CERT_CACHE.bySerial.get(normalized);
  }

  const refresh = await fetchBinancePayCertificates(true);
  if (!refresh.success) return null;
  return refresh.bySerial.get(normalized) || null;
}

function getBinancePayHeader(headers, key) {
  if (!headers) return '';
  return headers[key.toLowerCase()] || headers[key] || '';
}

async function verifyBinancePayWebhookSignature(req) {
  const certSerial = String(getBinancePayHeader(req.headers, 'BinancePay-Certificate-SN') || '').trim();
  const nonce = String(getBinancePayHeader(req.headers, 'BinancePay-Nonce') || '').trim();
  const timestamp = String(getBinancePayHeader(req.headers, 'BinancePay-Timestamp') || '').trim();
  const signature = String(getBinancePayHeader(req.headers, 'BinancePay-Signature') || '').trim();
  const rawBody = typeof req.rawBody === 'string'
    ? req.rawBody
    : (req.body ? JSON.stringify(req.body) : '');

  if (!certSerial || !nonce || !timestamp || !signature || !rawBody) {
    return { success: false, reason: 'missing_signature_parts' };
  }

  const publicKey = await getBinancePayPublicKeyBySerial(certSerial);
  if (!publicKey) {
    return { success: false, reason: 'certificate_not_found' };
  }

  try {
    const payload = buildBinancePaySignaturePayload(timestamp, nonce, rawBody);
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(payload, 'utf8');
    verifier.end();
    const ok = verifier.verify(publicKey, Buffer.from(signature, 'base64'));
    return { success: ok, reason: ok ? null : 'invalid_signature', certSerial };
  } catch (err) {
    console.error('Binance Pay webhook verification error:', err.message);
    return { success: false, reason: 'verification_error', certSerial };
  }
}

function buildBinancePayLedgerCaption(payment, extra = {}) {
  const parts = [
    'Binance Pay',
    `merchantTradeNo=${payment?.merchantTradeNo || '-'}`,
    `prepayId=${extra.prepayId || payment?.prepayId || '-'}`,
    `transactionId=${extra.transactionId || payment?.binanceTransactionId || '-'}`,
    `amount=${formatUsdPrice(extra.amount || payment?.amount || 0)}`,
    `currency=${extra.currency || payment?.currency || '-'}`,
    `status=${extra.status || payment?.status || '-'}`,
    `bizStatus=${extra.bizStatus || payment?.bizStatus || '-'}`
  ];
  return parts.join(' | ');
}

async function getOrCreateBinancePayPaymentMethod(transaction = null) {
  let paymentMethod = await PaymentMethod.findOne({ where: { type: 'binance_pay' }, transaction }).catch(() => null);
  if (paymentMethod) return paymentMethod;

  return await PaymentMethod.create({
    nameEn: 'Binance Pay',
    nameAr: 'بايننس باي',
    details: 'Automatic Binance Pay topup',
    type: 'binance_pay',
    config: {},
    isActive: true,
    minDeposit: 1,
    maxDeposit: 100000
  }, { transaction });
}

async function createBinancePayTopupOrder({ userId, amount, currency = 'USDT', source = 'bot', terminalType = 'WAP', returnUrl = '', cancelUrl = '' }) {
  const normalizedCurrency = normalizeBinancePayCurrency(currency);
  const normalizedAmount = normalizeBinancePayAmount(amount);

  if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
    return { success: false, reason: 'invalid_amount' };
  }

  if (!isSupportedBinancePayCurrency(normalizedCurrency)) {
    return { success: false, reason: 'unsupported_currency' };
  }

  await findOrCreateUser(userId);

  const merchantTradeNo = generateBinancePayMerchantTradeNo(userId);
  const passThroughInfo = JSON.stringify({
    userId: Number(userId),
    amount: normalizedAmount,
    currency: normalizedCurrency,
    source: String(source || 'bot')
  });

  const requestBody = {
    env: { terminalType: terminalType || 'WAP' },
    merchantTradeNo,
    orderAmount: normalizedAmount,
    currency: normalizedCurrency,
    goods: {
      goodsType: '02',
      goodsCategory: 'Z000',
      referenceGoodsId: `TOPUP${String(userId).slice(-8)}`,
      goodsName: 'BalanceTopup',
      goodsDetail: 'Telegram bot balance topup'
    },
    passThroughInfo,
    orderExpireTime: Date.now() + BINANCE_PAY_ORDER_EXPIRE_MS
  };

  const effectiveReturnUrl = returnUrl || BINANCE_PAY_RETURN_URL;
  const effectiveCancelUrl = cancelUrl || BINANCE_PAY_CANCEL_URL;
  if (effectiveReturnUrl) requestBody.returnUrl = effectiveReturnUrl;
  if (effectiveCancelUrl) requestBody.cancelUrl = effectiveCancelUrl;

  const response = await callBinancePayApi('/binancepay/openapi/v2/order', requestBody);
  if (!response.success || !response.data) {
    return {
      success: false,
      reason: response.reason || response.code || 'api_error',
      errorMessage: response.errorMessage || 'Binance Pay create order failed.',
      response: response.raw || null
    };
  }

  const paymentMethod = await getOrCreateBinancePayPaymentMethod();
  const data = response.data;
  const t = await sequelize.transaction();
  try {
    const ledger = await BalanceTransaction.create({
      userId,
      amount: normalizedAmount,
      type: 'deposit',
      paymentMethodId: paymentMethod.id,
      txid: merchantTradeNo,
      caption: `Binance Pay order created | merchantTradeNo=${merchantTradeNo} | prepayId=${data.prepayId || '-'} | amount=${normalizedAmount} | currency=${normalizedCurrency}`,
      status: 'created',
      lastReminderAt: new Date()
    }, { transaction: t });

    const payment = await BinancePayPayment.create({
      userId,
      balanceTransactionId: ledger.id,
      merchantTradeNo,
      prepayId: data.prepayId || null,
      amount: normalizedAmount,
      currency: normalizedCurrency,
      status: 'CREATED',
      bizStatus: null,
      binanceTransactionId: null,
      passThroughInfo,
      checkoutUrl: data.checkoutUrl || null,
      deeplink: data.deeplink || null,
      universalUrl: data.universalUrl || null,
      qrcodeLink: data.qrcodeLink || null,
      qrContent: data.qrContent || null,
      orderPayload: requestBody,
      webhookPayload: null,
      queryPayload: null,
      creditedAt: null,
      lastQueriedAt: null,
      expireTime: data.expireTime ? new Date(Number(data.expireTime)) : new Date(Date.now() + BINANCE_PAY_ORDER_EXPIRE_MS),
      meta: {
        source,
        createResponse: response.raw || null
      }
    }, { transaction: t });

    await t.commit();
    return { success: true, payment, raw: response.raw || null };
  } catch (err) {
    await t.rollback().catch(() => {});
    console.error('createBinancePayTopupOrder db error:', err.message);
    return { success: false, reason: 'db_error', errorMessage: err.message };
  }
}

function mapBinancePayStatus(remoteStatus, bizStatus = null) {
  const value = String(bizStatus || remoteStatus || '').trim().toUpperCase();
  if (value === 'PAY_SUCCESS' || value === 'PAID') return 'PAID';
  if (value === 'PAY_CLOSED' || value === 'CANCELED') return 'CANCELED';
  if (value === 'PAY_FAIL' || value === 'ERROR') return 'ERROR';
  if (value === 'EXPIRED') return 'EXPIRED';
  if (value === 'INITIAL' || value === 'CREATED') return 'INITIAL';
  if (value === 'PENDING') return 'PENDING';
  if (value === 'REFUNDING') return 'REFUNDING';
  if (value === 'REFUNDED' || value === 'FULL_REFUNDED') return value;
  return value || 'UNKNOWN';
}

function mapBinancePayLedgerStatus(status) {
  const value = String(status || '').toUpperCase();
  if (value === 'PAID') return 'completed';
  if (value === 'CANCELED') return 'canceled';
  if (value === 'EXPIRED') return 'expired';
  if (value === 'ERROR') return 'error';
  if (value === 'INITIAL' || value === 'PENDING' || value === 'CREATED') return 'pending';
  return value.toLowerCase() || 'pending';
}

async function updateBinancePayPaymentStatus(paymentInput, nextStatus, extra = {}) {
  const paymentId = typeof paymentInput === 'object' ? paymentInput?.id : paymentInput;
  if (!paymentId) return null;

  const t = await sequelize.transaction();
  try {
    const payment = await BinancePayPayment.findByPk(paymentId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!payment) {
      await t.commit();
      return null;
    }

    payment.status = nextStatus || payment.status;
    if (extra.bizStatus) payment.bizStatus = extra.bizStatus;
    if (extra.prepayId) payment.prepayId = extra.prepayId;
    if (extra.transactionId) payment.binanceTransactionId = extra.transactionId;
    if (extra.passThroughInfo) payment.passThroughInfo = typeof extra.passThroughInfo === 'string' ? extra.passThroughInfo : JSON.stringify(extra.passThroughInfo);
    if (extra.expireTime) payment.expireTime = extra.expireTime instanceof Date ? extra.expireTime : new Date(extra.expireTime);
    if (extra.webhookPayload !== undefined) payment.webhookPayload = extra.webhookPayload;
    if (extra.queryPayload !== undefined) payment.queryPayload = extra.queryPayload;
    if (extra.lastQueriedAt) payment.lastQueriedAt = extra.lastQueriedAt;
    payment.meta = {
      ...(payment.meta || {}),
      ...(extra.meta || {})
    };
    await payment.save({ transaction: t });

    const ledger = payment.balanceTransactionId
      ? await BalanceTransaction.findByPk(payment.balanceTransactionId, { transaction: t, lock: t.LOCK.UPDATE })
      : await BalanceTransaction.findOne({ where: { txid: payment.merchantTradeNo, type: 'deposit' }, transaction: t, lock: t.LOCK.UPDATE });

    if (ledger && ledger.status !== 'completed') {
      ledger.status = mapBinancePayLedgerStatus(payment.status);
      ledger.caption = buildBinancePayLedgerCaption(payment, {
        status: payment.status,
        bizStatus: payment.bizStatus,
        transactionId: payment.binanceTransactionId,
        prepayId: payment.prepayId,
        currency: payment.currency,
        amount: payment.amount
      });
      await ledger.save({ transaction: t });
    }

    await t.commit();
    return payment;
  } catch (err) {
    await t.rollback().catch(() => {});
    console.error('updateBinancePayPaymentStatus error:', err.message);
    return null;
  }
}

async function ensureBinancePayPaymentFromRemote(remoteData = {}, options = {}) {
  const merchantTradeNo = String(remoteData?.merchantTradeNo || options.merchantTradeNo || '').trim();
  const prepayId = String(remoteData?.prepayId || options.prepayId || '').trim();
  if (!merchantTradeNo && !prepayId) return null;

  let payment = merchantTradeNo ? await BinancePayPayment.findOne({ where: { merchantTradeNo } }) : null;
  if (!payment && prepayId) payment = await BinancePayPayment.findOne({ where: { prepayId } });
  if (payment) return payment;

  const passInfo = tryParseJson(remoteData?.passThroughInfo || options.passThroughInfo || null) || {};
  const userId = parseInt(passInfo.userId || options.userId || 0, 10);
  const amount = normalizeBinancePayAmount(remoteData?.totalFee ?? remoteData?.orderAmount ?? passInfo.amount);
  const currency = normalizeBinancePayCurrency(remoteData?.currency || passInfo.currency || 'USDT');

  if (!Number.isInteger(userId) || userId <= 0 || !Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  await findOrCreateUser(userId);

  const paymentMethod = await getOrCreateBinancePayPaymentMethod();
  const t = await sequelize.transaction();
  try {
    const ledger = await BalanceTransaction.create({
      userId,
      amount,
      type: 'deposit',
      paymentMethodId: paymentMethod.id,
      txid: merchantTradeNo || prepayId,
      caption: `Binance Pay order imported | merchantTradeNo=${merchantTradeNo || '-'} | prepayId=${prepayId || '-'}`,
      status: 'created',
      lastReminderAt: new Date()
    }, { transaction: t });

    payment = await BinancePayPayment.create({
      userId,
      balanceTransactionId: ledger.id,
      merchantTradeNo: merchantTradeNo || prepayId,
      prepayId: prepayId || null,
      amount,
      currency,
      status: options.status || 'CREATED',
      bizStatus: options.bizStatus || null,
      binanceTransactionId: remoteData?.transactionId || null,
      passThroughInfo: remoteData?.passThroughInfo || (Object.keys(passInfo).length ? JSON.stringify(passInfo) : null),
      checkoutUrl: null,
      deeplink: null,
      universalUrl: null,
      qrcodeLink: null,
      qrContent: null,
      orderPayload: null,
      webhookPayload: options.webhookPayload || null,
      queryPayload: options.queryPayload || null,
      expireTime: remoteData?.expireTime ? new Date(remoteData.expireTime) : null,
      meta: { imported: true }
    }, { transaction: t });

    await t.commit();
    return payment;
  } catch (err) {
    await t.rollback().catch(() => {});
    console.error('ensureBinancePayPaymentFromRemote error:', err.message);
    return await BinancePayPayment.findOne({ where: { merchantTradeNo: merchantTradeNo || prepayId } }).catch(() => null);
  }
}

async function creditSuccessfulBinancePayOrder(paymentInput, settlement = {}) {
  const paymentId = typeof paymentInput === 'object' ? paymentInput?.id : paymentInput;
  if (!paymentId) return { success: false, reason: 'payment_not_found' };

  const t = await sequelize.transaction();
  try {
    const payment = await BinancePayPayment.findByPk(paymentId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!payment) {
      await t.commit();
      return { success: false, reason: 'payment_not_found' };
    }

    if (payment.creditedAt) {
      payment.status = 'PAID';
      if (settlement.bizStatus) payment.bizStatus = settlement.bizStatus;
      if (settlement.prepayId) payment.prepayId = settlement.prepayId;
      if (settlement.transactionId) payment.binanceTransactionId = settlement.transactionId;
      if (settlement.webhookPayload !== undefined) payment.webhookPayload = settlement.webhookPayload;
      if (settlement.queryPayload !== undefined) payment.queryPayload = settlement.queryPayload;
      await payment.save({ transaction: t });
      await t.commit();
      return { success: true, alreadyCredited: true, payment, userId: payment.userId, amount: Number(payment.amount) };
    }

    const settledAmount = normalizeBinancePayAmount(settlement.totalFee ?? settlement.orderAmount ?? payment.amount);
    const settledCurrency = normalizeBinancePayCurrency(settlement.currency || payment.currency);

    if (!amountsMatchExactly(payment.amount, settledAmount) || String(payment.currency || '').toUpperCase() !== String(settledCurrency || '').toUpperCase()) {
      payment.status = 'ERROR';
      payment.bizStatus = settlement.bizStatus || payment.bizStatus || 'MISMATCH';
      payment.binanceTransactionId = settlement.transactionId || payment.binanceTransactionId;
      payment.prepayId = settlement.prepayId || payment.prepayId;
      if (settlement.webhookPayload !== undefined) payment.webhookPayload = settlement.webhookPayload;
      if (settlement.queryPayload !== undefined) payment.queryPayload = settlement.queryPayload;
      await payment.save({ transaction: t });
      const ledger = payment.balanceTransactionId
        ? await BalanceTransaction.findByPk(payment.balanceTransactionId, { transaction: t, lock: t.LOCK.UPDATE })
        : null;
      if (ledger && ledger.status !== 'completed') {
        ledger.status = 'error';
        ledger.caption = buildBinancePayLedgerCaption(payment, {
          status: 'ERROR',
          bizStatus: payment.bizStatus,
          transactionId: settlement.transactionId,
          prepayId: settlement.prepayId,
          currency: settledCurrency,
          amount: settledAmount
        });
        await ledger.save({ transaction: t });
      }
      await t.commit();
      return {
        success: false,
        reason: 'amount_or_currency_mismatch',
        payment,
        expectedAmount: Number(payment.amount),
        settledAmount,
        expectedCurrency: payment.currency,
        settledCurrency
      };
    }

    let ledger = payment.balanceTransactionId
      ? await BalanceTransaction.findByPk(payment.balanceTransactionId, { transaction: t, lock: t.LOCK.UPDATE })
      : await BalanceTransaction.findOne({ where: { txid: payment.merchantTradeNo, type: 'deposit' }, transaction: t, lock: t.LOCK.UPDATE });

    if (ledger && ledger.status === 'completed') {
      payment.status = 'PAID';
      payment.bizStatus = settlement.bizStatus || payment.bizStatus || 'PAY_SUCCESS';
      payment.binanceTransactionId = settlement.transactionId || payment.binanceTransactionId;
      payment.prepayId = settlement.prepayId || payment.prepayId;
      payment.creditedAt = payment.creditedAt || new Date();
      if (settlement.webhookPayload !== undefined) payment.webhookPayload = settlement.webhookPayload;
      if (settlement.queryPayload !== undefined) payment.queryPayload = settlement.queryPayload;
      await payment.save({ transaction: t });
      await t.commit();
      return { success: true, alreadyCredited: true, payment, userId: payment.userId, amount: Number(payment.amount) };
    }

    const user = await User.findByPk(payment.userId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!user) {
      await t.rollback();
      return { success: false, reason: 'user_not_found' };
    }

    const currentBalance = Number(user.balance || 0);
    const newBalance = currentBalance + Number(payment.amount);
    await User.update({ balance: newBalance }, { where: { id: payment.userId }, transaction: t });

    if (!ledger) {
      const paymentMethod = await getOrCreateBinancePayPaymentMethod(t);
      ledger = await BalanceTransaction.create({
        userId: payment.userId,
        amount: Number(payment.amount),
        type: 'deposit',
        paymentMethodId: paymentMethod.id,
        txid: payment.merchantTradeNo,
        caption: buildBinancePayLedgerCaption(payment, {
          status: 'PAID',
          bizStatus: settlement.bizStatus || 'PAY_SUCCESS',
          transactionId: settlement.transactionId,
          prepayId: settlement.prepayId,
          currency: settledCurrency,
          amount: settledAmount
        }),
        status: 'completed',
        lastReminderAt: new Date()
      }, { transaction: t });
      payment.balanceTransactionId = ledger.id;
    } else {
      ledger.amount = Number(payment.amount);
      ledger.type = 'deposit';
      ledger.status = 'completed';
      ledger.caption = buildBinancePayLedgerCaption(payment, {
        status: 'PAID',
        bizStatus: settlement.bizStatus || 'PAY_SUCCESS',
        transactionId: settlement.transactionId,
        prepayId: settlement.prepayId,
        currency: settledCurrency,
        amount: settledAmount
      });
      await ledger.save({ transaction: t });
    }

    payment.status = 'PAID';
    payment.bizStatus = settlement.bizStatus || payment.bizStatus || 'PAY_SUCCESS';
    payment.binanceTransactionId = settlement.transactionId || payment.binanceTransactionId;
    payment.prepayId = settlement.prepayId || payment.prepayId;
    payment.creditedAt = new Date();
    if (settlement.webhookPayload !== undefined) payment.webhookPayload = settlement.webhookPayload;
    if (settlement.queryPayload !== undefined) payment.queryPayload = settlement.queryPayload;
    payment.lastQueriedAt = new Date();
    await payment.save({ transaction: t });

    await t.commit();
    return {
      success: true,
      alreadyCredited: false,
      payment,
      userId: payment.userId,
      amount: Number(payment.amount),
      newBalance
    };
  } catch (err) {
    await t.rollback().catch(() => {});
    console.error('creditSuccessfulBinancePayOrder error:', err.message);
    return { success: false, reason: 'db_error', errorMessage: err.message };
  }
}

async function notifyBinancePayCredit(result, source = 'query') {
  if (!result?.success || result.alreadyCredited || !result.payment) return;

  try {
    const userRecord = await User.findByPk(result.userId, { attributes: ['state'] }).catch(() => null);
    const currentState = safeParseState(userRecord?.state);
    if (currentState?.action === 'binance_pay_pending_order') {
      const pendingTradeNo = String(currentState.merchantTradeNo || '').trim();
      if (!pendingTradeNo || pendingTradeNo === String(result.payment.merchantTradeNo || '').trim()) {
        await clearUserState(result.userId);
      }
    }
  } catch (err) {
    console.error('notifyBinancePayCredit clear state error:', err.message);
  }

  try {
    await bot.sendMessage(result.userId, await getText(result.userId, 'depositSuccess', {
      balance: Number(result.newBalance || 0).toFixed(2)
    }));
  } catch (err) {
    console.error('notifyBinancePayCredit user message error:', err.message);
  }

  try {
    const identity = await getTelegramIdentityById(result.userId);
    await bot.sendMessage(
      ADMIN_ID,
      `💰 Binance Pay Deposit

` +
      `Name: ${identity.fullName}
` +
      `Username: ${identity.usernameText}
` +
      `ID: ${result.userId}
` +
      `Amount: ${formatUsdPrice(result.amount)} USD
` +
      `merchantTradeNo: ${result.payment.merchantTradeNo || '-'}
` +
      `prepayId: ${result.payment.prepayId || '-'}
` +
      `transactionId: ${result.payment.binanceTransactionId || '-'}
` +
      `Source: ${source}`
    ).catch(() => {});
  } catch (err) {
    console.error('notifyBinancePayCredit admin message error:', err.message);
  }
}

async function syncBinancePayOrderStatus(identifier, options = {}) {
  const merchantTradeNo = typeof identifier === 'object' ? String(identifier?.merchantTradeNo || '').trim() : String(identifier || '').trim();
  const prepayId = typeof identifier === 'object' ? String(identifier?.prepayId || '').trim() : '';

  let payment = merchantTradeNo ? await BinancePayPayment.findOne({ where: { merchantTradeNo } }) : null;
  if (!payment && prepayId) payment = await BinancePayPayment.findOne({ where: { prepayId } });

  const requestBody = payment?.prepayId
    ? { prepayId: payment.prepayId }
    : payment?.merchantTradeNo
      ? { merchantTradeNo: payment.merchantTradeNo }
      : prepayId
        ? { prepayId }
        : { merchantTradeNo };

  if (!requestBody.merchantTradeNo && !requestBody.prepayId) {
    return { success: false, reason: 'missing_identifier' };
  }

  const response = await callBinancePayApi('/binancepay/openapi/v2/order/query', requestBody);
  if (!response.success || !response.data) {
    return {
      success: false,
      reason: response.reason || response.code || 'api_error',
      errorMessage: response.errorMessage || 'Binance Pay query order failed.',
      payment: payment || null,
      response: response.raw || null
    };
  }

  const remote = response.data || {};
  const remoteStatus = mapBinancePayStatus(remote.status, options.bizStatus || null);
  payment = payment || await ensureBinancePayPaymentFromRemote({
    ...remote,
    prepayId: remote.prepayId || requestBody.prepayId
  }, {
    status: remoteStatus,
    queryPayload: response.raw || null,
    prepayId: remote.prepayId || requestBody.prepayId
  });

  if (!payment) {
    return { success: false, reason: 'payment_not_found', response: response.raw || null };
  }

  if (remoteStatus === 'PAID') {
    const creditResult = await creditSuccessfulBinancePayOrder(payment, {
      bizStatus: options.bizStatus || 'PAY_SUCCESS',
      transactionId: remote.transactionId || null,
      prepayId: remote.prepayId || payment.prepayId || null,
      currency: remote.currency || payment.currency,
      totalFee: remote.orderAmount || payment.amount,
      orderAmount: remote.orderAmount || payment.amount,
      passThroughInfo: remote.passThroughInfo || payment.passThroughInfo || null,
      queryPayload: response.raw || null
    });

    if (creditResult.success && !creditResult.alreadyCredited && options.notifyUser !== false) {
      await notifyBinancePayCredit(creditResult, options.source || 'query');
    }

    return {
      success: creditResult.success,
      reason: creditResult.reason || null,
      payment: creditResult.payment || payment,
      remoteStatus,
      creditedNow: Boolean(creditResult.success && !creditResult.alreadyCredited),
      alreadyCredited: Boolean(creditResult.alreadyCredited),
      creditResult,
      response: response.raw || null
    };
  }

  const updatedPayment = await updateBinancePayPaymentStatus(payment, remoteStatus, {
    bizStatus: options.bizStatus || remote.status || payment.bizStatus,
    prepayId: remote.prepayId || payment.prepayId || null,
    transactionId: remote.transactionId || null,
    passThroughInfo: remote.passThroughInfo || payment.passThroughInfo || null,
    queryPayload: response.raw || null,
    lastQueriedAt: new Date(),
    meta: {
      lastRemoteStatus: remote.status || null
    }
  });

  return {
    success: true,
    payment: updatedPayment || payment,
    remoteStatus,
    creditedNow: false,
    alreadyCredited: Boolean(updatedPayment?.creditedAt || payment.creditedAt),
    response: response.raw || null
  };
}

async function getBinancePayCheckoutReplyMarkup(userId, payment) {
  const rows = [];
  const checkoutUrl = payment?.checkoutUrl || payment?.universalUrl || payment?.qrContent || null;
  const openAppUrl = payment?.universalUrl || payment?.checkoutUrl || payment?.qrContent || null;

  if (checkoutUrl) {
    rows.push([{ text: await getText(userId, 'binancePayPayNow'), url: checkoutUrl }]);
  }

  if (openAppUrl && openAppUrl !== checkoutUrl) {
    rows.push([{ text: await getText(userId, 'binancePayOpenApp'), url: openAppUrl }]);
  }

  rows.push([{ text: await getText(userId, 'binancePayCheckStatus'), callback_data: `binance_pay_check_${payment.merchantTradeNo}` }]);
  rows.push([{ text: await getText(userId, 'back'), callback_data: 'deposit_binance_auto' }]);
  return { inline_keyboard: rows };
}

async function sendBinancePayCheckoutMessage(userId, payment) {
  const msg = await getText(userId, 'binancePayOrderCreated', {
    amount: formatUsdPrice(payment.amount),
    currency: payment.currency,
    merchantTradeNo: payment.merchantTradeNo,
    expiresAt: formatBinancePayExpiresAt(payment.expireTime)
  });

  const replyMarkup = await getBinancePayCheckoutReplyMarkup(userId, payment);
  if (payment?.qrcodeLink) {
    try {
      await bot.sendPhoto(userId, payment.qrcodeLink, {
        caption: msg,
        parse_mode: 'HTML',
        reply_markup: replyMarkup
      });
      return;
    } catch (err) {
      console.error('sendBinancePayCheckoutMessage photo error:', err.message);
    }
  }

  await bot.sendMessage(userId, msg, {
    parse_mode: 'HTML',
    reply_markup: replyMarkup
  });
}

async function reconcilePendingBinancePayOrders() {
  if (!isBinancePayConfigured()) return;

  const pending = await BinancePayPayment.findAll({
    where: {
      creditedAt: null,
      status: { [Op.in]: ['CREATED', 'INITIAL', 'PENDING'] },
      createdAt: { [Op.gt]: new Date(Date.now() - (24 * 60 * 60 * 1000)) }
    },
    order: [['createdAt', 'ASC']],
    limit: 15
  }).catch(() => []);

  for (const payment of pending) {
    await syncBinancePayOrderStatus({ merchantTradeNo: payment.merchantTradeNo }, {
      source: 'poller',
      notifyUser: true
    }).catch(err => {
      console.error('reconcilePendingBinancePayOrders sync error:', err.message);
    });
    await sleep(150);
  }
}

async function handleBinancePayWebhook(req, res) {
  try {
    const verified = await verifyBinancePayWebhookSignature(req);
    if (!verified.success) {
      return res.status(400).json({ returnCode: 'FAIL', returnMessage: 'INVALID_SIGNATURE' });
    }

    const payload = req.body && typeof req.body === 'object'
      ? req.body
      : tryParseJson(req.rawBody || null);

    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ returnCode: 'FAIL', returnMessage: 'INVALID_BODY' });
    }

    if (String(payload.bizType || '').toUpperCase() !== 'PAY') {
      return res.json({ returnCode: 'SUCCESS', returnMessage: null });
    }

    const bizStatus = String(payload.bizStatus || '').toUpperCase();
    const webhookData = tryParseJson(payload.data) || {};
    const merchantTradeNo = String(webhookData?.merchantTradeNo || '').trim();
    const prepayId = String(payload.bizIdStr || payload.bizId || webhookData?.prepayId || '').trim();
    const mappedStatus = mapBinancePayStatus(webhookData?.status || null, bizStatus);

    let payment = merchantTradeNo ? await BinancePayPayment.findOne({ where: { merchantTradeNo } }) : null;
    if (!payment && prepayId) payment = await BinancePayPayment.findOne({ where: { prepayId } });
    if (!payment) {
      payment = await ensureBinancePayPaymentFromRemote({
        ...webhookData,
        prepayId
      }, {
        status: mappedStatus,
        bizStatus,
        webhookPayload: payload
      });
    }

    if (!payment) {
      return res.status(404).json({ returnCode: 'FAIL', returnMessage: 'ORDER_NOT_FOUND' });
    }

    if (mappedStatus === 'PAID') {
      const creditResult = await creditSuccessfulBinancePayOrder(payment, {
        bizStatus,
        prepayId,
        transactionId: webhookData?.transactionId || null,
        currency: webhookData?.currency || payment.currency,
        totalFee: webhookData?.totalFee || payment.amount,
        orderAmount: webhookData?.totalFee || payment.amount,
        passThroughInfo: webhookData?.passThroughInfo || payment.passThroughInfo || null,
        webhookPayload: payload
      });

      if (!creditResult.success && creditResult.reason === 'amount_or_currency_mismatch') {
        await bot.sendMessage(payment.userId, await getText(payment.userId, 'binancePayMismatch')).catch(() => {});
      }

      if (creditResult.success && !creditResult.alreadyCredited) {
        await notifyBinancePayCredit(creditResult, 'webhook');
      }
    } else {
      await updateBinancePayPaymentStatus(payment, mappedStatus, {
        bizStatus,
        prepayId,
        transactionId: webhookData?.transactionId || null,
        passThroughInfo: webhookData?.passThroughInfo || payment.passThroughInfo || null,
        webhookPayload: payload,
        meta: {
          lastWebhookBizStatus: bizStatus
        }
      });
    }

    return res.json({ returnCode: 'SUCCESS', returnMessage: null });
  } catch (err) {
    console.error('handleBinancePayWebhook error:', err.message);
    return res.status(500).json({ returnCode: 'FAIL', returnMessage: 'SERVER_ERROR' });
  }
}

// -------------------------------------------------------------------
// أدوات التحقق من Binance Auto
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeBinanceIdentifier(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .toLowerCase();
}

function getBinanceHistoryAmountUSDT(item) {
  const directCurrency = String(item?.currency || '').toUpperCase();
  const directAmount = Math.abs(parseFloat(item?.amount || 0));
  if (directCurrency === 'USDT' && Number.isFinite(directAmount) && directAmount > 0) {
    return directAmount;
  }

  const funds = Array.isArray(item?.fundsDetail) ? item.fundsDetail : [];
  const usdtPart = funds.find(part => String(part?.currency || '').toUpperCase() === 'USDT');
  if (!usdtPart) return 0;

  const detailedAmount = Math.abs(parseFloat(usdtPart.amount || 0));
  return Number.isFinite(detailedAmount) ? detailedAmount : 0;
}

function itemMatchesBinanceOrder(item, orderNumber) {
  const wanted = normalizeBinanceIdentifier(orderNumber);
  if (!wanted) return false;

  const candidates = [
    item?.transactionId,
    item?.orderId,
    item?.merchantTradeNo,
    item?.prepayId,
    item?.bizNo,
    item?.transferId,
    item?.trxId,
    item?.id
  ];

  return candidates.some(value => normalizeBinanceIdentifier(value) === wanted);
}

// -------------------------------------------------------------------
// دالة التحقق من إيداعات Binance (قراءة فقط)
function normalizeBinanceNoteCode(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase();
}

function generateBinanceNoteCode(userId) {
  const userPart = String(userId || '').slice(-4).padStart(4, '0');
  const randomPart = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `BN${userPart}${randomPart}`;
}

function tryParseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseLooseConfigText(value) {
  const result = {};
  const textValue = String(value || '').trim();
  if (!textValue) return result;

  for (const line of textValue.split(/\r?\n/)) {
    const match = line.match(/^\s*([a-zA-Z0-9_.-]+)\s*[:=]\s*(.+?)\s*$/);
    if (!match) continue;
    result[match[1]] = match[2];
  }

  return result;
}

function pickFirstNonEmpty(source, keys = []) {
  if (!source || typeof source !== 'object') return null;
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return null;
}

async function getBinanceCredentials() {
  if (BINANCE_API_KEY && BINANCE_API_SECRET) {
    return {
      apiKey: BINANCE_API_KEY,
      apiSecret: BINANCE_API_SECRET,
      payId: BINANCE_PAY_ID || null,
      source: 'env'
    };
  }

  const globalSettings = await Setting.findAll({
    where: {
      lang: 'global',
      key: {
        [Op.in]: [
          'binance_api_key',
          'binance_api_secret',
          'binance_pay_id',
          'binance_apiKey',
          'binance_apiSecret'
        ]
      }
    }
  }).catch(() => []);

  const settingsMap = Object.fromEntries((globalSettings || []).map(item => [item.key, item.value]));
  const globalApiKey = settingsMap.binance_api_key || settingsMap.binance_apiKey || null;
  const globalApiSecret = settingsMap.binance_api_secret || settingsMap.binance_apiSecret || null;
  const globalPayId = settingsMap.binance_pay_id || BINANCE_PAY_ID || null;

  if (globalApiKey && globalApiSecret) {
    return {
      apiKey: String(globalApiKey).trim(),
      apiSecret: String(globalApiSecret).trim(),
      payId: globalPayId ? String(globalPayId).trim() : null,
      source: 'settings'
    };
  }

  const methods = await PaymentMethod.findAll({
    where: { isActive: true },
    order: [['id', 'DESC']]
  }).catch(() => []);

  for (const method of methods) {
    const haystack = [method?.nameEn, method?.nameAr, method?.type, method?.details]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    if (!haystack.includes('binance') && !haystack.includes('بايننس')) continue;

    const configs = [
      tryParseJson(method?.config),
      tryParseJson(method?.details),
      parseLooseConfigText(method?.details)
    ].filter(Boolean);

    for (const cfg of configs) {
      const apiKey = pickFirstNonEmpty(cfg, ['apiKey', 'api_key', 'binanceApiKey', 'binance_api_key', 'key']);
      const apiSecret = pickFirstNonEmpty(cfg, ['apiSecret', 'api_secret', 'binanceApiSecret', 'binance_api_secret', 'secret']);
      const payId = pickFirstNonEmpty(cfg, ['payId', 'pay_id', 'binancePayId', 'binance_pay_id', 'merchantId', 'merchant_id', 'accountId', 'account_id']);

      if (apiKey && apiSecret) {
        return {
          apiKey,
          apiSecret,
          payId: payId || BINANCE_PAY_ID || null,
          source: `payment_method:${method.id}`
        };
      }
    }
  }

  return null;
}

function flattenBinanceItemStrings(value, seen = new Set()) {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }
  if (typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);

  const parts = [];
  if (Array.isArray(value)) {
    for (const item of value) parts.push(...flattenBinanceItemStrings(item, seen));
    return parts;
  }

  for (const [key, item] of Object.entries(value)) {
    parts.push(String(key));
    parts.push(...flattenBinanceItemStrings(item, seen));
  }
  return parts;
}

let BINANCE_SERVER_TIME_OFFSET_MS = 0;

function getBinanceClientNowMs() {
  return Date.now() + BINANCE_SERVER_TIME_OFFSET_MS;
}

function normalizeBinanceDigits(value) {
  return String(value || '')
    .trim()
    .replace(/\D/g, '');
}

function getBinanceIdentifierCandidates(item) {
  return [
    item?.transactionId,
    item?.orderId,
    item?.merchantTradeNo,
    item?.prepayId,
    item?.bizNo,
    item?.transferId,
    item?.trxId,
    item?.id,
    item?.transactionNo,
    item?.tradeNo,
    item?.merchantOrderNo,
    item?.merchantTransId,
    item?.sourceId,
    item?.requestId,
    item?.payRequestId,
    item?.extendInfo?.merchantTradeNo,
    item?.extendInfo?.orderId,
    item?.extend?.merchantTradeNo,
    item?.extend?.orderId,
    item?.paymentInfo?.payerId,
    item?.paymentInfo?.channel,
    item?.receiverInfo?.accountId,
    item?.receiverInfo?.binanceId,
    item?.payerInfo?.accountId,
    item?.payerInfo?.binanceId
  ].filter(Boolean);
}

function getBinanceFlattenedNormalizedData(item) {
  const rawStrings = flattenBinanceItemStrings(item);
  return {
    identifierStrings: [...new Set(rawStrings.map(normalizeBinanceIdentifier).filter(Boolean))],
    noteStrings: [...new Set(rawStrings.map(normalizeBinanceNoteCode).filter(Boolean))],
    digitStrings: [...new Set(rawStrings.map(normalizeBinanceDigits).filter(Boolean))]
  };
}

function itemMatchesBinanceOrder(item, orderNumber) {
  const wanted = normalizeBinanceIdentifier(orderNumber);
  const wantedDigits = normalizeBinanceDigits(orderNumber);
  if (!wanted && !wantedDigits) return false;

  const candidates = getBinanceIdentifierCandidates(item)
    .map(normalizeBinanceIdentifier)
    .filter(Boolean);

  if (wanted && candidates.some(value => value === wanted)) {
    return true;
  }

  const flattened = getBinanceFlattenedNormalizedData(item);
  if (wanted && flattened.identifierStrings.some(value => value === wanted)) {
    return true;
  }

  if (wantedDigits && flattened.digitStrings.some(value => value === wantedDigits)) {
    return true;
  }

  return false;
}

function itemMatchesBinanceOrderRelaxed(item, orderNumber) {
  const wanted = normalizeBinanceIdentifier(orderNumber);
  const wantedDigits = normalizeBinanceDigits(orderNumber);
  if ((!wanted || wanted.length < 6) && (!wantedDigits || wantedDigits.length < 8)) return false;

  const candidateIdentifiers = getBinanceIdentifierCandidates(item)
    .map(normalizeBinanceIdentifier)
    .filter(Boolean);

  if (wanted && candidateIdentifiers.some(value => value.includes(wanted) || wanted.includes(value))) {
    return true;
  }

  const flattened = getBinanceFlattenedNormalizedData(item);
  if (wanted && flattened.identifierStrings.some(value => value.includes(wanted) || wanted.includes(value))) {
    return true;
  }

  if (wantedDigits && wantedDigits.length >= 8 && flattened.digitStrings.some(value => value.includes(wantedDigits) || wantedDigits.includes(value))) {
    return true;
  }

  return false;
}

function itemMatchesBinanceNoteCode(item, verificationCode) {
  const wanted = normalizeBinanceNoteCode(verificationCode);
  if (!wanted) return false;

  const flattened = getBinanceFlattenedNormalizedData(item);
  return flattened.noteStrings.some(value => value === wanted || (wanted.length >= 8 && (value.includes(wanted) || wanted.includes(value))));
}

function getBinanceTransactionTime(item) {
  const txTime = Number(item?.transactionTime || item?.transactTime || item?.createTime || 0);
  return Number.isFinite(txTime) && txTime > 0 ? txTime : 0;
}

function getBinanceTransactionUniqueKey(item) {
  const identifiers = getBinanceIdentifierCandidates(item)
    .map(normalizeBinanceIdentifier)
    .filter(Boolean);
  if (identifiers.length) return identifiers[0];

  return normalizeBinanceIdentifier([
    item?.transactionTime,
    item?.amount,
    item?.currency,
    item?.payerInfo?.binanceId,
    item?.receiverInfo?.accountId,
    item?.receiverInfo?.binanceId,
    item?.paymentInfo?.payerId
  ].filter(Boolean).join('-'));
}

function getBinanceReceiverIdentifiers(item) {
  return [
    item?.receiverInfo?.accountId,
    item?.receiverInfo?.binanceId,
    item?.receiverInfo?.email,
    item?.receiverInfo?.name,
    item?.receiverInfo?.phoneNumber,
    item?.receiver,
    item?.payId,
    item?.merchantId
  ].map(normalizeBinanceIdentifier).filter(Boolean);
}

function getBinancePayIdMatchLevel(item, payId) {
  const normalizedPayId = normalizeBinanceIdentifier(payId);
  if (!normalizedPayId) return 0;

  const receiverIds = getBinanceReceiverIdentifiers(item);
  if (receiverIds.some(value => value === normalizedPayId)) return 4;
  if (receiverIds.some(value => value.includes(normalizedPayId) || normalizedPayId.includes(value))) return 3;

  const flattened = getBinanceFlattenedNormalizedData(item);
  if (flattened.identifierStrings.some(value => value === normalizedPayId)) return 2;
  if (flattened.identifierStrings.some(value => value.includes(normalizedPayId) || normalizedPayId.includes(value))) return 1;

  return 0;
}

function isLikelyIncomingBinancePayment(item, payId) {
  const directAmount = parseFloat(item?.amount || 0);
  const fundsAmount = getBinanceHistoryAmountUSDT(item);
  const resolvedAmount = fundsAmount > 0 ? fundsAmount : Math.abs(directAmount);
  if (!Number.isFinite(resolvedAmount) || resolvedAmount <= 0) return false;
  if (Number.isFinite(directAmount) && directAmount < 0) return false;

  const orderType = String(item?.orderType || '').toUpperCase();
  if (['PAY_REFUND', 'C2C_HOLDING_RF', 'CRYPTO_BOX_RF', 'REFUND', 'FULL_REFUNDED'].includes(orderType)) {
    return false;
  }

  const normalizedPayId = normalizeBinanceIdentifier(payId);
  if (!normalizedPayId) return true;

  const receiverIds = getBinanceReceiverIdentifiers(item);
  if (!receiverIds.length) return true;

  return getBinancePayIdMatchLevel(item, payId) > 0;
}

function doesBinanceAmountMatch(item, expectedAmountUSDT) {
  const amount = getBinanceHistoryAmountUSDT(item);
  if (!Number.isFinite(amount) || amount <= 0) return false;
  return Math.abs(amount - Number(expectedAmountUSDT || 0)) <= 0.0001;
}

function buildBinanceHistoryWindows(sessionCreatedAt) {
  const now = getBinanceClientNowMs();
  const sessionMs = Number(sessionCreatedAt || 0);
  const anchor = Number.isFinite(sessionMs) && sessionMs > 0 ? Math.min(sessionMs, now) : now - (5 * 60 * 1000);

  const rawWindows = [
    { mode: 'latest' },
    { startTime: Math.max(now - (10 * 60 * 1000), anchor - (2 * 60 * 1000)), endTime: now },
    { startTime: Math.max(now - (30 * 60 * 1000), anchor - (5 * 60 * 1000)), endTime: now },
    { startTime: Math.max(now - (2 * 60 * 60 * 1000), anchor - (15 * 60 * 1000)), endTime: now },
    { startTime: Math.max(now - (12 * 60 * 60 * 1000), anchor - (30 * 60 * 1000)), endTime: now },
    { startTime: Math.max(now - (24 * 60 * 60 * 1000), anchor - (60 * 60 * 1000)), endTime: now },
    { startTime: Math.max(now - (7 * 24 * 60 * 60 * 1000), anchor - (2 * 60 * 60 * 1000)), endTime: now }
  ];

  const unique = [];
  const seen = new Set();
  for (const entry of rawWindows) {
    const key = entry.mode === 'latest'
      ? 'latest'
      : `${Number(entry.startTime || 0)}-${Number(entry.endTime || 0)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }

  return unique;
}

function isBinanceTimestampError(errorValue) {
  const haystack = JSON.stringify(errorValue || '').toLowerCase();
  return haystack.includes('invalid_timestamp')
    || haystack.includes('timestamp for this request is outside the time window')
    || haystack.includes('outside of the time window')
    || haystack.includes('-1021');
}

async function syncBinanceServerTimeOffset() {
  try {
    const response = await axios.get('https://api.binance.com/api/v3/time', { timeout: 10000 });
    const serverTime = Number(response?.data?.serverTime || 0);
    if (!Number.isFinite(serverTime) || serverTime <= 0) return false;
    BINANCE_SERVER_TIME_OFFSET_MS = serverTime - Date.now();
    return true;
  } catch (err) {
    console.error('Binance server time sync error:', err.response?.data || err.message || err);
    return false;
  }
}

async function fetchBinancePayTransactionsWindow(credentials, startTime = null, endTime = null) {
  const attempts = 4;
  let lastError = null;
  let syncedServerTime = false;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const params = new URLSearchParams({
      limit: '100',
      recvWindow: '60000',
      timestamp: String(getBinanceClientNowMs())
    });

    if (Number.isFinite(Number(startTime)) && Number(startTime) > 0) {
      params.set('startTime', String(Number(startTime)));
    }
    if (Number.isFinite(Number(endTime)) && Number(endTime) > 0) {
      params.set('endTime', String(Number(endTime)));
    }

    const queryString = params.toString();
    const signature = crypto.createHmac('sha256', credentials.apiSecret).update(queryString).digest('hex');
    const url = `https://api.binance.com/sapi/v1/pay/transactions?${queryString}&signature=${signature}`;

    try {
      const response = await axios.get(url, {
        headers: { 'X-MBX-APIKEY': credentials.apiKey },
        timeout: 20000
      });

      const payload = response.data || {};
      const rows = Array.isArray(payload.data) ? payload.data : [];
      return { ok: true, rows };
    } catch (err) {
      lastError = err.response?.data || err.message || 'API error';
      console.error('Binance Pay API error:', lastError);

      if (!syncedServerTime && isBinanceTimestampError(lastError)) {
        syncedServerTime = await syncBinanceServerTimeOffset();
        if (syncedServerTime) {
          continue;
        }
      }

      if (attempt < attempts) {
        await sleep(2500);
      }
    }
  }

  return { ok: false, error: lastError || 'API error', rows: [] };
}

async function fetchCandidateBinanceTransactions(credentials, sessionCreatedAt) {
  const allRows = [];
  const seen = new Set();
  let hadSuccess = false;
  let lastError = null;

  for (const window of buildBinanceHistoryWindows(sessionCreatedAt)) {
    const result = await fetchBinancePayTransactionsWindow(
      credentials,
      window.mode === 'latest' ? null : window.startTime,
      window.mode === 'latest' ? null : window.endTime
    );

    if (!result.ok) {
      lastError = result.error || lastError;
      continue;
    }

    hadSuccess = true;
    for (const row of result.rows || []) {
      const key = getBinanceTransactionUniqueKey(row);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      allRows.push(row);
    }
  }

  allRows.sort((a, b) => getBinanceTransactionTime(b) - getBinanceTransactionTime(a));

  return {
    ok: hadSuccess,
    rows: allRows,
    error: hadSuccess ? null : (lastError || 'API error')
  };
}

function buildFastBinanceVerificationWindow(sessionCreatedAt) {
  const now = getBinanceClientNowMs();
  const sessionMs = Number(sessionCreatedAt || 0);
  const fallbackStart = now - (2 * 60 * 60 * 1000);

  if (!Number.isFinite(sessionMs) || sessionMs <= 0) {
    return { startTime: fallbackStart, endTime: now };
  }

  return {
    startTime: Math.max(fallbackStart, sessionMs - (15 * 60 * 1000)),
    endTime: now
  };
}

async function fetchCandidateBinanceTransactionsFast(credentials, sessionCreatedAt) {
  const executeRequest = async () => {
    const window = buildFastBinanceVerificationWindow(sessionCreatedAt);
    const params = new URLSearchParams({
      limit: '100',
      recvWindow: '60000',
      timestamp: String(getBinanceClientNowMs()),
      startTime: String(Number(window.startTime || 0)),
      endTime: String(Number(window.endTime || 0))
    });

    const queryString = params.toString();
    const signature = crypto.createHmac('sha256', credentials.apiSecret).update(queryString).digest('hex');
    const url = `https://api.binance.com/sapi/v1/pay/transactions?${queryString}&signature=${signature}`;

    try {
      const response = await axios.get(url, {
        headers: { 'X-MBX-APIKEY': credentials.apiKey },
        timeout: 10000
      });

      const payload = response.data || {};
      return {
        ok: true,
        rows: Array.isArray(payload.data) ? payload.data : []
      };
    } catch (err) {
      return {
        ok: false,
        error: err.response?.data || err.message || 'API error',
        rows: []
      };
    }
  };

  let result = await executeRequest();
  if (!result.ok && isBinanceTimestampError(result.error)) {
    const synced = await syncBinanceServerTimeOffset();
    if (synced) {
      result = await executeRequest();
    }
  }

  if (result.ok) {
    const seen = new Set();
    const rows = [];
    for (const row of result.rows || []) {
      const key = getBinanceTransactionUniqueKey(row);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
    rows.sort((a, b) => getBinanceTransactionTime(b) - getBinanceTransactionTime(a));
    return { ok: true, rows };
  }

  return { ok: false, error: result.error || 'API error', rows: [] };
}

function getBinanceVerificationFailureReason(reason, lang) {
  const ar = lang === 'ar';
  switch (reason) {
    case 'binance_not_configured':
      return ar ? '⚠️ إعدادات Binance API غير مكتملة على السيرفر.' : '⚠️ Binance API credentials are not configured on the server.';
    case 'invalid_payload':
      return ar ? '⚠️ بيانات التحقق غير صالحة.' : '⚠️ Invalid verification payload.';
    case 'api_error':
      return ar ? '⚠️ تعذر الاتصال بـ Binance API حاليًا، حاول مرة أخرى بعد قليل.' : '⚠️ Binance API is currently unavailable. Please try again shortly.';
    case 'duplicate_tx':
      return ar ? '❌ هذه العملية مستخدمة مسبقًا.' : '❌ This transaction has already been used.';
    case 'ambiguous_match':
      return ar ? '⚠️ تم العثور على أكثر من عملية محتملة بنفس البيانات، لذلك يلزم التحقق اليدوي.' : '⚠️ More than one possible matching transaction was found, so manual verification is required.';
    case 'no_match':
    default:
      return ar ? '❌ لم يتم العثور على عملية مطابقة حتى الآن.' : '❌ No matching transaction was found yet.';
  }
}

function pickBestBinanceMatch(rows, orderNumber, verificationCode, options = {}) {
  const wantedIdentifier = normalizeBinanceIdentifier(orderNumber);
  const wantedCode = normalizeBinanceNoteCode(verificationCode || orderNumber);
  const sessionCreatedAt = Number(options.sessionCreatedAt || 0);
  const payId = options.payId || '';
  const now = getBinanceClientNowMs();

  const candidates = rows.map(item => {
    const txTime = getBinanceTransactionTime(item);
    const payIdLevel = getBinancePayIdMatchLevel(item, payId);
    const identifierExact = wantedIdentifier ? itemMatchesBinanceOrder(item, wantedIdentifier) : false;
    const noteExact = wantedCode ? itemMatchesBinanceNoteCode(item, wantedCode) : false;
    const identifierRelaxed = !identifierExact && wantedIdentifier ? itemMatchesBinanceOrderRelaxed(item, wantedIdentifier) : false;

    let timeScore = 0;
    let deltaScore = 0;
    let deltaMs = Number.MAX_SAFE_INTEGER;
    if (sessionCreatedAt > 0 && txTime > 0) {
      deltaMs = Math.abs(txTime - sessionCreatedAt);
      if (txTime >= (sessionCreatedAt - (10 * 60 * 1000)) && txTime <= (now + (5 * 60 * 1000))) {
        timeScore = 1;
      }
      if (deltaMs <= (2 * 60 * 1000)) {
        deltaScore = 4;
      } else if (deltaMs <= (10 * 60 * 1000)) {
        deltaScore = 3;
      } else if (deltaMs <= (30 * 60 * 1000)) {
        deltaScore = 2;
      } else if (deltaMs <= (6 * 60 * 60 * 1000)) {
        deltaScore = 1;
      }
    }

    let method = null;
    let score = 0;

    if (identifierExact) {
      method = 'identifier_exact';
      score += 120;
    } else if (noteExact) {
      method = 'note_code';
      score += 108;
    } else if (identifierRelaxed) {
      method = 'identifier_relaxed';
      score += 82;
    }

    if (payIdLevel > 0) {
      score += payIdLevel * 8;
    }

    if (timeScore > 0) {
      score += 12;
    }
    score += deltaScore * 4;

    if (!method && payIdLevel >= 3 && timeScore > 0 && deltaScore >= 2) {
      method = 'payid_recent';
      score += 52;
    } else if (!method && payIdLevel >= 1 && timeScore > 0 && deltaScore >= 3) {
      method = 'payid_recent_loose';
      score += 44;
    } else if (!method && timeScore > 0 && deltaScore >= 3) {
      method = 'recent_unique_fallback';
      score += 36;
    } else if (!method && payIdLevel >= 4) {
      method = 'payid_exact_only';
      score += 28;
    }

    if (txTime > 0) {
      const ageMs = now - txTime;
      if (ageMs >= 0 && ageMs <= (10 * 60 * 1000)) {
        score += 3;
      } else if (ageMs <= (60 * 60 * 1000)) {
        score += 1;
      }
    }

    return {
      item,
      txTime,
      deltaMs,
      score,
      method,
      payIdLevel,
      identifierExact,
      noteExact,
      identifierRelaxed
    };
  }).filter(candidate => candidate.method);

  if (!candidates.length) {
    return { candidate: null, reason: 'no_match', candidates: [] };
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.payIdLevel !== a.payIdLevel) return b.payIdLevel - a.payIdLevel;
    if (a.deltaMs !== b.deltaMs) return a.deltaMs - b.deltaMs;
    return b.txTime - a.txTime;
  });

  const top = candidates[0];
  const second = candidates[1] || null;
  const scoreGap = second ? (top.score - second.score) : Number.POSITIVE_INFINITY;

  if (top.identifierExact || top.noteExact) {
    return { candidate: top, reason: null, candidates };
  }

  if (top.identifierRelaxed && scoreGap >= 8) {
    return { candidate: top, reason: null, candidates };
  }

  if ((top.method === 'payid_recent' || top.method === 'payid_recent_loose') && scoreGap >= 10) {
    return { candidate: top, reason: null, candidates };
  }

  if (rows.length === 1 && top.method && (top.payIdLevel > 0 || top.deltaMs <= (10 * 60 * 1000))) {
    return { candidate: top, reason: null, candidates };
  }

  if (candidates.length === 1 && (top.method === 'recent_unique_fallback' || top.method === 'payid_exact_only')) {
    return { candidate: top, reason: null, candidates };
  }

  return {
    candidate: null,
    reason: candidates.length > 1 ? 'ambiguous_match' : 'no_match',
    candidates
  };
}

function buildBinanceDuplicateCandidates(rawInput, checkResult = {}) {
  const matchedItem = checkResult?.matchedItem || null;
  const values = [
    rawInput,
    checkResult?.rawOrderId,
    checkResult?.txId,
    matchedItem?.transactionId,
    matchedItem?.orderId,
    matchedItem?.prepayId,
    matchedItem?.merchantTradeNo,
    matchedItem?.transactionNo,
    matchedItem?.tradeNo,
    matchedItem ? getBinanceTransactionUniqueKey(matchedItem) : null
  ];

  return [...new Set(values.map(normalizeBinanceIdentifier).filter(Boolean))];
}

async function checkBinanceDeposit(orderNumber, expectedAmountUSDT, options = {}) {
  const credentials = await getBinanceCredentials();
  if (!credentials?.apiKey || !credentials?.apiSecret) {
    console.error('❌ Binance API keys missing');
    return { success: false, reason: 'binance_not_configured' };
  }

  const expected = Number(expectedAmountUSDT || 0);
  const wantedIdentifier = normalizeBinanceIdentifier(orderNumber);
  if (!wantedIdentifier || !Number.isFinite(expected) || expected <= 0) {
    return { success: false, reason: 'invalid_payload' };
  }

  const fetched = await fetchCandidateBinanceTransactionsFast(credentials, options.sessionCreatedAt);
  if (!fetched.ok) {
    return { success: false, reason: 'api_error', error: fetched.error || null };
  }

  const rows = fetched.rows || [];
  const matchedRows = rows.filter(item => (
    doesBinanceAmountMatch(item, expected)
    && isLikelyIncomingBinancePayment(item, credentials.payId || null)
    && itemMatchesBinanceOrder(item, wantedIdentifier)
  ));

  if (matchedRows.length === 1) {
    const matchedItem = matchedRows[0];
    return {
      success: true,
      method: 'exact_order_id',
      amount: getBinanceHistoryAmountUSDT(matchedItem),
      txId: matchedItem.transactionId || matchedItem.orderId || matchedItem.prepayId || getBinanceTransactionUniqueKey(matchedItem) || orderNumber,
      rawOrderId: orderNumber,
      currency: 'USDT',
      transactionTime: getBinanceTransactionTime(matchedItem) || getBinanceClientNowMs(),
      orderType: matchedItem.orderType || null,
      payId: credentials.payId || null,
      matchedItem,
      searchedRows: rows.length,
      matchedRows: matchedRows.length,
      amountMatchedRows: matchedRows.length,
      payIdMatchedRows: matchedRows.length,
      matchScore: 100
    };
  }

  return {
    success: false,
    reason: matchedRows.length > 1 ? 'ambiguous_match' : 'no_match',
    searchedRows: rows.length,
    matchedRows: matchedRows.length,
    amountMatchedRows: matchedRows.length,
    payIdMatchedRows: matchedRows.length,
    payId: credentials.payId || null
  };
}

async function getOrCreateBinanceTransferPaymentMethod(transaction = null) {
  let paymentMethod = await PaymentMethod.findOne({ where: { type: 'binance_note_order' }, transaction }).catch(() => null);
  if (paymentMethod) return paymentMethod;

  return PaymentMethod.create({
    nameEn: 'Binance',
    nameAr: 'بايننس',
    details: 'Binance transfer verified by note or order id',
    type: 'binance_note_order',
    config: { mode: 'note_or_order_id' },
    isActive: true,
    minDeposit: 1.0,
    maxDeposit: 10000.0
  }, { transaction });
}

async function reconcilePendingBinanceTransferOrders() {
  const users = await User.findAll({ where: { state: { [Op.like]: '%binance_transfer_pending%' } }, attributes: ['id', 'state'] }).catch(() => []);
  for (const user of users || []) {
    const state = safeParseState(user.state);
    if (state?.action !== 'binance_transfer_pending') continue;
    try {
      await processBinanceAutoVerification(user.id, state, { rawInput: '', silent: true });
    } catch (err) {
      console.error(`Binance transfer reconcile error for user ${user.id}:`, err.message);
    }
  }
}

async function processBinanceAutoVerification(userId, state, options = {}) {
  const user = await User.findByPk(userId);
  if (!user) return { handled: false };

  const lang = user.lang === 'ar' ? 'ar' : 'en';
  const expectedAmount = Number(state?.amount || 0);
  const note = String(state?.note || '').trim();
  const rawInput = String(options.rawInput || '').trim();
  const normalizedInput = looksLikeBinanceTransferOrderId(rawInput) ? normalizeBinanceTransferOrderId(rawInput) : '';

  if (!Number.isFinite(expectedAmount) || expectedAmount <= 0 || !note) {
    await clearUserState(userId);
    await bot.sendMessage(userId, await getText(userId, 'binanceTransferNoPending'));
    return { handled: true, success: false, reason: 'invalid_state' };
  }

  if (normalizedInput) {
    const existing = await BalanceTransaction.findOne({
      where: {
        type: 'deposit',
        status: 'completed',
        txid: normalizedInput
      }
    });

    if (existing) {
      await bot.sendMessage(userId, await getText(userId, 'binanceTransferDuplicate'));
      return { handled: true, success: false, reason: 'duplicate_tx' };
    }
  }

  const credentials = await getBinanceCredentials();
  if (!credentials?.apiKey || !credentials?.apiSecret || !(state?.payId || credentials?.payId)) {
    await bot.sendMessage(userId, await getText(userId, 'binanceTransferNotConfigured'));
    return { handled: true, success: false, reason: 'binance_not_configured' };
  }

  if (!options.silent) {
    await bot.sendMessage(userId, await getText(userId, 'binanceTransferChecking'));
  }

  const checkResult = await verifyBinanceTransfer({
    apiKey: credentials.apiKey,
    apiSecret: credentials.apiSecret,
    payId: state?.payId || credentials?.payId || '',
    expectedAmount,
    expectedNote: note,
    orderIdToCheck: normalizedInput || '',
    sessionCreatedAt: state?.createdAt || null,
    recentWindowMs: normalizedInput ? (60 * 60 * 1000) : undefined
  });

  if (!checkResult.success) {
    if (options.silent) {
      return { handled: true, success: false, reason: checkResult.reason || 'not_found' };
    }
    if (checkResult.reason === 'api_error') {
      await bot.sendMessage(userId, getBinanceVerificationFailureReason('api_error', lang));
    } else if (checkResult.reason === 'expired_order_id') {
      await bot.sendMessage(userId, await getText(userId, 'binanceTransferOrderIdExpired'), {
        reply_markup: await getBinanceTransferReplyMarkup(userId)
      });
    } else if (!normalizedInput) {
      await bot.sendMessage(userId, await getText(userId, 'binanceTransferCheckByNotePending'), {
        reply_markup: await getBinanceTransferReplyMarkup(userId)
      });
    } else {
      await bot.sendMessage(userId, await getText(userId, 'binanceTransferNotFound'), {
        reply_markup: await getBinanceTransferReplyMarkup(userId)
      });
    }
    return { handled: true, success: false, reason: checkResult.reason || 'not_found' };
  }

  if (normalizedInput) {
    const ageMs = Math.max(0, Date.now() - Number(checkResult.transactionTime || 0));
    if (!Number.isFinite(ageMs) || ageMs > (60 * 60 * 1000)) {
      await bot.sendMessage(userId, await getText(userId, 'binanceTransferOrderIdExpired'), {
        reply_markup: await getBinanceTransferReplyMarkup(userId)
      });
      return { handled: true, success: false, reason: 'expired_order_id' };
    }
  }

  const matchedOrderId = normalizeBinanceTransferOrderId(checkResult.orderId || normalizedInput || '');
  const duplicateKey = matchedOrderId || normalizedInput || note;

  const t = await sequelize.transaction();
  try {
    const freshUser = await User.findByPk(userId, { transaction: t, lock: t.LOCK.UPDATE });
    const existingDeposit = await BalanceTransaction.findOne({
      where: {
        type: 'deposit',
        status: 'completed',
        txid: duplicateKey
      },
      transaction: t,
      lock: t.LOCK.UPDATE
    });

    if (existingDeposit) {
      await t.rollback().catch(() => {});
      await bot.sendMessage(userId, await getText(userId, 'binanceTransferDuplicate'));
      return { handled: true, success: false, reason: 'duplicate_tx' };
    }

    const paymentMethod = await getOrCreateBinanceTransferPaymentMethod(t);
    const newBalance = parseFloat(freshUser.balance || 0) + expectedAmount;

    await User.update({ balance: newBalance }, { where: { id: userId }, transaction: t });
    await BalanceTransaction.create({
      userId,
      amount: expectedAmount,
      type: 'deposit',
      paymentMethodId: paymentMethod.id,
      status: 'completed',
      txid: duplicateKey,
      caption: `Binance | method=${checkResult.method} | note=${note} | input=${rawInput || '-'} | orderId=${matchedOrderId || '-'} | payId=${state?.payId || credentials?.payId || '-'} | amount=${expectedAmount} | searched=${checkResult.searchedRows || 0}`
    }, { transaction: t });

    await t.commit();

    await clearUserState(userId);
    await bot.sendMessage(userId, await getText(userId, 'binanceTransferVerified', {
      amount: escapeHtml(formatUsdPrice(expectedAmount)),
      balance: escapeHtml(newBalance.toFixed(2))
    }), { parse_mode: 'HTML' });

    const identity = await getTelegramIdentityById(userId);
    await bot.sendMessage(ADMIN_ID,
      `💰 Binance Deposit

` +
      `Name: ${identity.fullName}
` +
      `Username: ${identity.usernameText}
` +
      `ID: ${userId}
` +
      `Amount: ${formatUsdPrice(expectedAmount)} USDT
` +
      `Order ID: ${matchedOrderId || '-'}
` +
      `Note: ${note}
` +
      `Method: ${checkResult.method}
` +
      `Binance ID: ${state?.payId || credentials?.payId || BINANCE_PAY_ID || '-'}
` +
      `Rows searched: ${checkResult.searchedRows || 0}
`
    ).catch(() => {});

    await sendMainMenu(userId);
    return { handled: true, success: true, orderId: matchedOrderId || duplicateKey };
  } catch (err) {
    await t.rollback().catch(() => {});
    console.error('processBinanceAutoVerification transaction error:', err);
    await bot.sendMessage(userId, lang === 'ar'
      ? '❌ حدث خطأ أثناء إضافة الرصيد. حاول مرة أخرى أو تواصل مع الدعم.'
      : '❌ An error occurred while adding the balance. Please try again or contact support.');
    return { handled: true, success: false, reason: 'db_error' };
  }
}

async function sendMainMenu(userId) {
  const canUse = await ensureUserAccess(userId, { sendJoinPrompt: true, sendCaptchaPrompt: true });
  if (!canUse) return;

  const visibility = await getMenuButtonsVisibility();
  const order = await getMenuButtonsOrder();
  const redeemableReferralCodes = await getRedeemableReferralCodesCount(userId);
  const showFreeCode = await shouldShowFreeCodeButton(userId);
  const aiAssistantEnabled = await getAiAssistantEnabled();
  const currentBalanceLine = await getCurrentBalanceLineText(userId);
  const digitalSections = await getDigitalSections();
  const digitalSectionMap = new Map(digitalSections.map(section => [getDigitalSectionCategory(section.id), section]));
  const featuredProducts = await getFeaturedDigitalProductsForMenu();

  const buttonLabels = {
    buy: await getText(userId, 'buy'),
    chatgpt_code: await getChatGptMenuLabel(userId),
    my_balance: await getBalanceButtonLabel(userId),
    deposit: await getText(userId, 'deposit'),
    my_purchases: await getText(userId, 'myPurchases'),
    redeem: await getText(userId, 'redeem'),
    referral: await getText(userId, 'referral'),
    discount: await getText(userId, 'discountButton'),
    support: await getText(userId, 'support'),
    ai_assistant: await getText(userId, 'aiAssistant'),
    change_language: await getText(userId, 'changeLanguage'),
    free_code: await getText(userId, 'freeCodeMenu'),
    admin_panel: await getText(userId, 'adminPanel')
  };

  const buttons = [];

  for (const product of featuredProducts) {
    const stock = await getMerchantAvailableStock(product.id);
    const name = await getMerchantDisplayName(product, userId);
    buttons.push([{
      text: await getText(userId, 'digitalProductListButton', {
        name,
        price: formatUsdPrice(product.price),
        stock
      }),
      callback_data: `digital_product_${product.id}`
    }]);
  }

  for (const id of order) {
    const digitalSection = digitalSectionMap.get(id);
    if (digitalSection) {
      buttons.push([{
        text: `🧩 ${await getDigitalSectionDisplayName(digitalSection, userId)}`,
        callback_data: `digital_section_${digitalSection.id}`
      }]);
      continue;
    }

    if (id === 'admin_panel' && !isAdmin(userId)) continue;
    if (id === 'referral_prize' && redeemableReferralCodes <= 0) continue;
    if (id === 'free_code' && !showFreeCode) continue;
    if (id === 'ai_assistant' && !aiAssistantEnabled) continue;
    if (visibility[id] !== false && buttonLabels[id]) {
      buttons.push([{ text: buttonLabels[id], callback_data: id === 'admin_panel' ? 'admin' : id }]);
    }
  }

  await bot.sendMessage(userId, `${await getText(userId, 'menu')}

${currentBalanceLine}`, {
    reply_markup: { inline_keyboard: buttons }
  });
}

async function showAdminPanel(userId) {
  if (!isAdmin(userId)) return;

  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, 'manageBots'), callback_data: 'admin_manage_bots' }],
      [{ text: await getText(userId, 'manageMenuButtons'), callback_data: 'admin_manage_menu_buttons' }],
      [{ text: await getText(userId, 'colorButtons'), callback_data: 'admin_color_buttons' }],
      [{ text: await getText(userId, 'manageChannel'), callback_data: 'admin_manage_channel' }],
      [{ text: '📦 قناة الكودات الخاصة', callback_data: 'admin_private_codes_channel' }],
      [{ text: await getText(userId, 'manageDepositSettings'), callback_data: 'admin_manage_deposit_settings' }],
      [{ text: await getText(userId, 'digitalSubscriptions'), callback_data: 'admin_digital_subscriptions' }],
      [{ text: await getText(userId, 'addMerchant'), callback_data: 'admin_add_merchant' }],
      [{ text: await getText(userId, 'listMerchants'), callback_data: 'admin_list_merchants' }],
      [{ text: await getText(userId, 'setPrice'), callback_data: 'admin_set_price' }],
      [{ text: await getText(userId, 'setChatgptPrice'), callback_data: 'admin_set_chatgpt_price' }],
      [{ text: await getText(userId, 'addCodes'), callback_data: 'admin_add_codes' }],
      [{ text: await getText(userId, 'paymentMethods'), callback_data: 'admin_payment_methods' }],
      [{ text: await getText(userId, 'stats'), callback_data: 'admin_stats' }],
      [{ text: await getText(userId, 'referralSettings'), callback_data: 'admin_referral_settings' }],
      [{ text: await getText(userId, 'manageRedeemServices'), callback_data: 'admin_manage_redeem_services' }],
      [{ text: await getText(userId, 'manageDiscountCodes'), callback_data: 'admin_manage_discount_codes' }],
      [{ text: await getText(userId, 'quantityDiscountSettings'), callback_data: 'admin_quantity_discount_settings' }],
      [{ text: `${await getText(userId, 'aiAssistant')} ${await getAiAssistantEnabled() ? '✅' : '⛔'}`, callback_data: 'admin_toggle_ai_assistant' }],
      [{ text: await getText(userId, 'botControl'), callback_data: 'admin_bot_control' }],
      [{ text: await getText(userId, 'balanceManagement'), callback_data: 'admin_balance_management' }],
      [{ text: await getText(userId, 'sendAnnouncement'), callback_data: 'admin_send_announcement' }],
      [{ text: await getText(userId, 'editCodeDeliveryMessage'), callback_data: 'admin_edit_code_delivery_message' }],
      [{ text: await getText(userId, 'changeButtonNames'), callback_data: 'admin_change_button_names' }],
      [{ text: await getText(userId, 'back'), callback_data: 'back_to_menu' }]
    ]
  };

  await bot.sendMessage(userId, await getText(userId, 'adminPanel'), { reply_markup: keyboard });
}

async function showReferralSettingsAdmin(userId) {
  const percent = await getReferralPercent();
  const redeemPoints = await getReferralRedeemPoints();
  const freeCodeDays = await getFreeCodeCooldownDays();
  const milestonesText = await getReferralMilestonesText();
  const referralsEnabled = await getReferralEnabled();
  const percentLine = await getText(userId, 'currentReferralPercent', { percent });
  const pointsLine = await getText(userId, 'currentRedeemPoints', { points: redeemPoints });
  const freeCodeDaysLine = await getText(userId, 'currentFreeCodeDays', { days: freeCodeDays });
  const milestonesLine = await getText(userId, 'currentReferralMilestones', { milestones: milestonesText });
  const referralsStatusLine = await getText(userId, referralsEnabled ? 'referralsEnabledStatus' : 'referralsDisabledStatus');

  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, 'setReferralPercent'), callback_data: 'admin_set_referral_percent' }],
      [{ text: await getText(userId, 'setRedeemPoints'), callback_data: 'admin_set_redeem_points' }],
      [{ text: await getText(userId, 'setFreeCodeDays'), callback_data: 'admin_set_free_code_days' }],
      [{ text: await getText(userId, 'editReferralMilestones'), callback_data: 'admin_edit_referral_milestones' }],
      [{ text: await getText(userId, 'referralEligibleUsers'), callback_data: 'admin_referral_eligible_users' }],
      [{ text: await getText(userId, 'grantPoints'), callback_data: 'admin_grant_points' }],
      [{ text: await getText(userId, 'deductReferralPoints'), callback_data: 'admin_deduct_points' }],
      [{ text: await getText(userId, 'grantCreatorDiscount'), callback_data: 'admin_grant_creator_discount' }],
      [{ text: await getText(userId, 'manageFreeCodeAccess'), callback_data: 'admin_manage_free_code_access' }],
      [{ text: await getText(userId, 'renewFreeCode'), callback_data: 'admin_renew_free_code' }],
      [{ text: await getText(userId, 'referralStockSettings'), callback_data: 'admin_referral_stock_settings' }],
      [{ text: await getText(userId, 'toggleReferrals'), callback_data: 'admin_toggle_referrals' }],
      [{ text: await getText(userId, 'back'), callback_data: 'admin' }]
    ]
  };

  await bot.sendMessage(
    userId,
    await getText(userId, 'manageReferralSettingsText', { percentLine, pointsLine, freeCodeDaysLine, milestonesLine, referralsStatusLine }),
    { reply_markup: keyboard }
  );
}

async function showQuantityDiscountSettingsAdmin(userId) {
  const threshold = await getBulkDiscountThreshold();
  const price = await getBulkDiscountPrice();
  const thresholdLine = await getText(userId, 'currentBulkDiscountThreshold', { threshold });
  const priceLine = await getText(userId, 'currentBulkDiscountPrice', { price });
  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, 'setBulkDiscountThreshold'), callback_data: 'admin_set_bulk_discount_threshold' }],
      [{ text: await getText(userId, 'setBulkDiscountPrice'), callback_data: 'admin_set_bulk_discount_price' }],
      [{ text: await getText(userId, 'back'), callback_data: 'admin' }]
    ]
  };
  await bot.sendMessage(
    userId,
    await getText(userId, 'quantityDiscountSettingsText', { thresholdLine, priceLine }),
    { reply_markup: keyboard }
  );
}

async function showReferralStockSettingsAdmin(userId) {
  const merchant = await getReferralStockMerchant();
  const count = await Code.count({ where: { merchantId: merchant.id, isUsed: false } });
  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, 'addReferralStockCodes'), callback_data: 'admin_add_referral_stock_codes' }],
      [{ text: await getText(userId, 'viewReferralStockCount'), callback_data: 'admin_view_referral_stock_count' }],
      [{ text: await getText(userId, 'searchReferralStockDuplicates'), callback_data: 'admin_search_referral_stock_duplicates' }],
      [{ text: await getText(userId, 'importReferralStockFromPrivateChannel'), callback_data: 'admin_import_referral_stock_from_private_channel' }],
      [{ text: await getText(userId, 'searchDeleteReferralStockCodes'), callback_data: 'admin_prompt_delete_referral_stock_codes' }],
      [{ text: await getText(userId, 'privateReferralChannelButton'), callback_data: 'admin_referral_codes_channel' }],
      [{ text: await getText(userId, 'back'), callback_data: 'admin_referral_settings' }]
    ]
  };
  await bot.sendMessage(userId, await getText(userId, 'referralStockCountText', { count }), { reply_markup: keyboard });
}

async function showBotControlAdmin(userId) {
  const enabled = await getBotEnabled();
  const status = await getText(userId, enabled ? 'botEnabledStatus' : 'botDisabledStatus');
  const allowedIds = await getAllowedUserIds();
  const idsText = allowedIds.length ? allowedIds.join(', ') : '-';
  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, enabled ? 'disableBot' : 'enableBot'), callback_data: 'admin_toggle_bot_enabled' }],
      [{ text: await getText(userId, 'botAllowedUsers'), callback_data: 'admin_set_allowed_users' }],
      [{ text: await getText(userId, 'back'), callback_data: 'admin' }]
    ]
  };
  await bot.sendMessage(
    userId,
    `${await getText(userId, 'botStatusLine', { status })}\n${await getText(userId, 'currentAllowedUsers', { ids: idsText })}`,
    { reply_markup: keyboard }
  );
}

async function showBalanceManagementAdmin(userId) {
  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, 'usersWithBalance'), callback_data: 'admin_users_with_balance' }],
      [{ text: await getText(userId, 'addBalanceAdmin'), callback_data: 'admin_add_balance' }],
      [{ text: await getText(userId, 'deductBalanceAdmin'), callback_data: 'admin_deduct_balance' }],
      [{ text: await getText(userId, 'back'), callback_data: 'admin' }]
    ]
  };
  await bot.sendMessage(userId, await getText(userId, 'balanceManagement'), { reply_markup: keyboard });
}

async function showChannelConfigAdmin(userId) {
  const config = await getChannelConfig();
  const statusText = config.enabled
    ? await getText(userId, 'verificationEnabled')
    : await getText(userId, 'verificationDisabled');

  const msg =
    `📢 *${await getText(userId, 'manageChannel')}*\n\n` +
    `⚙️ ${await getText(userId, 'verificationStatus', { status: statusText })}\n` +
    `🔗 ${await getText(userId, 'currentChannelLink', { link: config.link || 'Not set' })}\n` +
    `🆔 Channel ID: ${config.chatId || 'Not resolved yet'}\n` +
    `👤 Username: ${config.username || 'Not resolved yet'}\n` +
    `🏷️ Title: ${config.title || 'Not resolved yet'}\n` +
    `📝 ${await getText(userId, 'currentChannelMessage', { message: config.messageText || 'Not set' })}\n\n` +
    `${await getText(userId, 'channelHelpText')}`;

  const toggleText = config.enabled
    ? await getText(userId, 'disableVerification')
    : await getText(userId, 'enableVerification');

  const keyboard = {
    inline_keyboard: [
      [{ text: toggleText, callback_data: 'admin_toggle_verification' }],
      [{ text: await getText(userId, 'setChannelLink'), callback_data: 'admin_set_channel_link' }],
      [{ text: await getText(userId, 'setChannelMessage'), callback_data: 'admin_set_channel_message' }],
      [{ text: await getText(userId, 'back'), callback_data: 'admin' }]
    ]
  };

  await bot.sendMessage(userId, msg, { parse_mode: 'Markdown', reply_markup: keyboard });
}

async function showMerchantsForBuy(userId) {
  const merchants = (await Merchant.findAll({ order: [['category', 'ASC'], ['id', 'ASC']] }))
    .filter(merchant => !isDigitalSectionCategory(merchant.category))
    .filter(merchant => String(merchant.nameEn || '') !== 'ChatGPT Code');

  if (!merchants.length) {
    await bot.sendMessage(userId, await getText(userId, 'noCodes'));
    return sendMainMenu(userId);
  }

  const user = await User.findByPk(userId);
  const grouped = {};
  for (const merchant of merchants) {
    if (!grouped[merchant.category]) grouped[merchant.category] = [];
    grouped[merchant.category].push(merchant);
  }

  const buttons = [];
  for (const [category, list] of Object.entries(grouped)) {
    buttons.push([{ text: `📂 ${category}`, callback_data: 'ignore' }]);
    for (const m of list) {
      const row = [{
        text: `${user.lang === 'en' ? m.nameEn : m.nameAr} - ${m.price} USD`,
        callback_data: `buy_merchant_${m.id}`
      }];
      if (m.description && (m.description.content || m.description.fileId)) {
        row.push({ text: await getText(userId, 'showDescription'), callback_data: `show_description_${m.id}` });
      }
      buttons.push(row);
    }
  }

  buttons.push([{ text: await getText(userId, 'back'), callback_data: 'back_to_menu' }]);
  const chooseText = `${await getText(userId, 'chooseMerchant')}

${await getCurrentBalanceLineText(userId)}

${await getBulkDiscountInfoText(userId)}`;
  await bot.sendMessage(userId, chooseText, {
    reply_markup: { inline_keyboard: buttons }
  });
}

async function showBotsList(userId) {
  const bots = await BotService.findAll();
  if (!bots.length) {
    await bot.sendMessage(userId, 'No bots found.');
  } else {
    for (const b of bots) {
      const keyboard = {
        inline_keyboard: [
          [
            { text: '➕ Grant /code', callback_data: `bot_grant_code_${b.id}` },
            { text: '👑 Grant Full', callback_data: `bot_grant_full_${b.id}` },
            { text: '❌ Remove Permissions', callback_data: `bot_remove_perms_${b.id}` }
          ],
          [{ text: '🗑️ Delete Bot', callback_data: `admin_remove_bot_confirm_${b.id}` }]
        ]
      };

      await bot.sendMessage(
        userId,
        `🤖 *${b.name}*\nID: ${b.id}\nAllowed: ${(b.allowedActions || []).join(', ') || 'none'}\nOwner: ${b.ownerId || 'none'}`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
      );
    }
  }

  await bot.sendMessage(userId, '➕ Add Bot', {
    reply_markup: { inline_keyboard: [[{ text: '➕ Add Bot', callback_data: 'admin_add_bot' }]] }
  });
}

async function showRedeemServicesAdmin(userId) {
  const services = await RedeemService.findAll();
  let msg = `${await getText(userId, 'listRedeemServices')}\n`;
  for (const s of services) {
    msg += `ID: ${s.id} | ${s.nameEn} / ${s.nameAr} | MerchantDict: ${s.merchantDictId}\n`;
  }

  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, 'addRedeemService'), callback_data: 'admin_add_redeem_service' }],
      [{ text: await getText(userId, 'deleteRedeemService'), callback_data: 'admin_delete_redeem_service' }],
      [{ text: await getText(userId, 'back'), callback_data: 'admin' }]
    ]
  };

  await bot.sendMessage(userId, msg, { reply_markup: keyboard });
}

async function showDiscountCodesAdmin(userId) {
  const codes = await DiscountCode.findAll();
  let msg = `${await getText(userId, 'listDiscountCodes')}\n`;
  if (!codes.length) {
    msg += await getText(userId, 'noDiscountCodes');
  } else {
    for (const c of codes) {
      msg += `ID: ${c.id} | ${c.code} | ${c.discountPercent}% | Uses: ${c.usedCount}/${c.maxUses} | Expires: ${c.validUntil ? c.validUntil.toISOString().split('T')[0] : 'never'}\n`;
    }
  }

  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, 'addDiscountCode'), callback_data: 'admin_add_discount_code' }],
      [{ text: await getText(userId, 'deleteDiscountCode'), callback_data: 'admin_delete_discount_code' }],
      [{ text: await getText(userId, 'back'), callback_data: 'admin' }]
    ]
  };

  await bot.sendMessage(userId, msg, { reply_markup: keyboard });
}

async function redeemCard(cardKey, merchantDictId, platformId = '1') {
  try {
    const apiKey = process.env.NODE_CARD_API_KEY;
    const baseUrl = process.env.NODE_CARD_BASE_URL || 'https://api.node-card.com';
    const params = new URLSearchParams();
    params.append('card_key', cardKey);
    params.append('merchant_dict_id', merchantDictId);
    params.append('platform_id', platformId);
    if (apiKey) params.append('api_key', apiKey);

    const response = await axios.post(`${baseUrl}/api/open/card/redeem`, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000
    });

    if (response.data && response.data.code === 1) {
      return { success: true, data: response.data.data };
    }
    return { success: false, reason: response.data?.msg || 'Unknown error' };
  } catch (error) {
    console.error('Redeem API error:', error.response?.data || error.message);
    return { success: false, reason: error.response?.data?.msg || error.message || 'API connection failed' };
  }
}

async function redeemCardSmart(cardKey) {
  const services = await RedeemService.findAll();
  if (!services.length) return { success: false, reason: 'No redeem services configured' };

  const preferredNames = ['Amazon', 'Walmart', 'Target'];
  const preferred = [];
  const others = [];

  for (const s of services) {
    const en = (s.nameEn || '').toLowerCase();
    const ar = (s.nameAr || '').toLowerCase();
    const isPreferred = preferredNames.some(name => {
      const n = name.toLowerCase();
      return en.includes(n) || ar.includes(n);
    });
    if (isPreferred) preferred.push(s);
    else others.push(s);
  }

  const ordered = [...preferred, ...others];
  let lastReason = 'No compatible merchant found';
  for (const service of ordered) {
    const result = await redeemCard(cardKey, service.merchantDictId, service.platformId || '1');
    if (result.success) return { success: true, data: result.data, service };
    lastReason = result.reason || lastReason;
  }

  return { success: false, reason: lastReason };
}

function formatCardDetails(cardData) {
  return `💳 ${cardData.card_number}\nCVV: ${cardData.cvv}\nEXP: ${cardData.exp}\n💰 ${cardData.available_amount}\n🏪 ${cardData.merchant_name}`;
}

async function applyDiscount(discountCode, totalAmount) {
  const discount = await DiscountCode.findOne({
    where: {
      code: discountCode,
      [Op.or]: [{ validUntil: null }, { validUntil: { [Op.gt]: new Date() } }]
    }
  });

  if (!discount) return { success: false, reason: 'invalid' };
  if (discount.usedCount >= discount.maxUses) return { success: false, reason: 'maxed' };

  const newTotal = totalAmount * (1 - discount.discountPercent / 100);
  discount.usedCount += 1;
  await discount.save();
  return { success: true, newTotal, discountPercent: discount.discountPercent };
}

async function processPurchase(userId, merchantId, quantity, discountCode = null) {
  const merchant = await Merchant.findByPk(merchantId);
  if (!merchant) return { success: false, reason: 'Merchant not found' };

  const unitPrice = await getPerCodePriceForQuantity(merchant.price, quantity);
  let totalCost = unitPrice * quantity;
  let discountPercent = 0;
  if (discountCode) {
    const disc = await applyDiscount(discountCode, totalCost);
    if (!disc.success) return { success: false, reason: 'Invalid discount code' };
    totalCost = disc.newTotal;
    discountPercent = disc.discountPercent;
  }

  const user = await User.findByPk(userId);
  if (!user) return { success: false, reason: 'User not found' };

  const currentBalance = parseFloat(user.balance);
  if (currentBalance < totalCost) {
    return {
      success: false,
      reason: 'Insufficient balance',
      balance: currentBalance,
      price: unitPrice,
      totalCost
    };
  }

  const codes = await Code.findAll({
    where: { merchantId, isUsed: false },
    limit: quantity,
    order: [['id', 'ASC']]
  });

  if (codes.length < quantity) return { success: false, reason: 'Not enough codes in stock' };

  const t = await sequelize.transaction();
  try {
    await User.update({ balance: currentBalance - totalCost, totalPurchases: user.totalPurchases + quantity }, {
      where: { id: userId },
      transaction: t
    });

    await BalanceTransaction.create({
      userId,
      amount: -totalCost,
      type: 'purchase',
      status: 'completed'
    }, { transaction: t });

    await Code.update({ isUsed: true, usedBy: userId, soldAt: new Date() }, {
      where: { id: codes.map(c => c.id) },
      transaction: t
    });

    await t.commit();
    const rawEntries = codes.map(c => ({ value: c.value, extra: c.extra }));
    const codesText = rawEntries.map(entry => buildMerchantStockRowText(entry)).join('\n\n');
    return { success: true, codes: codesText, rawEntries, discountApplied: discountPercent, unitPrice, totalCost, newBalance: currentBalance - totalCost };
  } catch (err) {
    await t.rollback();
    console.error('Purchase transaction error:', err);
    return { success: false, reason: 'Database error' };
  }
}

async function requestDeposit(userId, amount, currency, message, imageFileId = null, tgUser = null) {
  const now = new Date();
  const deposit = await BalanceTransaction.create({
    userId,
    amount,
    type: 'deposit',
    status: 'pending',
    imageFileId,
    caption: message,
    txid: currency,
    lastReminderAt: now
  });

  const config = await getDepositConfig(currency);
  const parts = formatDateParts(new Date());
  const usernameText = tgUser?.username ? `@${tgUser.username}` : 'لا يوجد';
  const fullName = [tgUser?.first_name, tgUser?.last_name].filter(Boolean).join(' ').trim() || 'لا يوجد';
  const amountUSD = Number(amount).toFixed(2);
  const amountIQD = Number(amount * config.rate).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const currencyDisplay = currency === 'USD'
    ? `${config.displayNameAr || 'بايننس'} / ${config.displayNameEn || 'Binance'}`
    : `${config.displayNameAr || 'دينار عراقي'} / ${config.displayNameEn || 'Iraqi Dinar'}`;

  const notifText =
    `💳 طلب شحن جديد\n\n` +
    `المعرف: ${usernameText}\n` +
    `الاسم: ${fullName}\n` +
    `الايدي: ${userId}\n\n` +
    `العملة المختارة: ${currencyDisplay}\n` +
    `المبلغ بالدولار: ${amountUSD} USD\n` +
    `المبلغ بالدينار: ${amountIQD} IQD\n\n` +
    `الرسالة: ${String(message || '').trim() || 'No message'}\n\n` +
    `السنة: ${parts.year}\n` +
    `الشهر: ${parts.month}\n` +
    `اليوم: ${parts.day}\n` +
    `الساعة: ${parts.hour}:${parts.minute}:${parts.second}`;

  let receiptMsg;
  if (imageFileId) {
    receiptMsg = await bot.sendPhoto(ADMIN_ID, imageFileId, { caption: notifText });
  } else {
    receiptMsg = await bot.sendMessage(ADMIN_ID, notifText);
  }
  await bot.pinChatMessage(ADMIN_ID, receiptMsg.message_id, { disable_notification: true }).catch(() => {});

  const adminMsg = await bot.sendMessage(
    ADMIN_ID,
    `${await getText(ADMIN_ID, 'approve')} / ${await getText(ADMIN_ID, 'reject')}`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: await getText(ADMIN_ID, 'approve'), callback_data: `approve_deposit_${deposit.id}` }],
          [{ text: await getText(ADMIN_ID, 'reject'), callback_data: `reject_deposit_${deposit.id}` }]
        ]
      }
    }
  );

  deposit.adminMessageId = adminMsg.message_id;
  await deposit.save();
  return { success: true, depositId: deposit.id };
}

async function approveDeposit(depositId, adminId) {
  if (!isAdmin(adminId)) return false;
  const deposit = await BalanceTransaction.findByPk(depositId);
  if (!deposit || deposit.status !== 'pending') return false;

  const t = await sequelize.transaction();
  try {
    deposit.status = 'completed';
    await deposit.save({ transaction: t });

    const user = await User.findByPk(deposit.userId);
    const newBalance = parseFloat(user.balance) + parseFloat(deposit.amount);
    await User.update({ balance: newBalance }, { where: { id: deposit.userId }, transaction: t });

    await t.commit();
    await bot.sendMessage(deposit.userId, await getText(deposit.userId, 'depositSuccess', {
      balance: newBalance.toFixed(2)
    }));
    await bot.unpinChatMessage(ADMIN_ID).catch(() => {});
    return true;
  } catch (err) {
    await t.rollback();
    console.error('Approve deposit error:', err);
    return false;
  }
}

async function rejectDeposit(depositId, adminId) {
  if (!isAdmin(adminId)) return false;
  const deposit = await BalanceTransaction.findByPk(depositId);
  if (!deposit || deposit.status !== 'pending') return false;
  deposit.status = 'rejected';
  await deposit.save();
  await bot.sendMessage(deposit.userId, await getText(deposit.userId, 'depositRejected'));
  await bot.unpinChatMessage(ADMIN_ID).catch(() => {});
  return true;
}

const CHATGPT_PAGE_URL = 'https://www.bbvadescuentos.mx/develop/openai-3msc';
const CHATGPT_POST_URL = 'https://www.bbvadescuentos.mx/admin-site/php/_httprequest.php';
const CHATGPT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  Origin: 'https://www.bbvadescuentos.mx',
  Referer: CHATGPT_PAGE_URL,
  Accept: 'application/json, text/plain, */*'
};

let chatGptCookieCache = { cookies: null, fetchedAt: 0 };

function buildCookieHeader(cookieMap = {}) {
  return Object.entries(cookieMap)
    .filter(([, value]) => value !== undefined && value !== null && String(value).length > 0)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

function parseSetCookie(setCookieHeaders = []) {
  const cookieMap = {};
  for (const item of setCookieHeaders) {
    const [pair] = String(item).split(';');
    const eqIndex = pair.indexOf('=');
    if (eqIndex > 0) {
      const key = pair.slice(0, eqIndex).trim();
      const value = pair.slice(eqIndex + 1).trim();
      cookieMap[key] = value;
    }
  }
  return cookieMap;
}

function getFallbackChatGptCookies() {
  const fallback = {};
  if (process.env.CHATGPT_AK_BMSC) fallback.ak_bmsc = process.env.CHATGPT_AK_BMSC;
  if (process.env.CHATGPT_BM_SV) fallback.bm_sv = process.env.CHATGPT_BM_SV;
  return fallback;
}

async function refreshChatGPTCookies(force = false) {
  const now = Date.now();
  if (!force && chatGptCookieCache.cookies && now - chatGptCookieCache.fetchedAt < 5 * 60 * 1000) {
    return chatGptCookieCache.cookies;
  }

  try {
    const response = await axios.get(CHATGPT_PAGE_URL, {
      timeout: 15000,
      headers: CHATGPT_HEADERS,
      validateStatus: () => true
    });

    const cookies = parseSetCookie(response.headers['set-cookie'] || []);
    const merged = { ...getFallbackChatGptCookies(), ...cookies };
    chatGptCookieCache = { cookies: merged, fetchedAt: now };
    return merged;
  } catch (err) {
    console.error('Failed to refresh ChatGPT cookies:', err.message);
    const fallback = getFallbackChatGptCookies();
    chatGptCookieCache = { cookies: fallback, fetchedAt: now };
    return fallback;
  }
}

async function getChatGPTCode(email) {
  const attempt = async (forceRefresh = false) => {
    const cookies = await refreshChatGPTCookies(forceRefresh);
    const cookieHeader = buildCookieHeader(cookies);

    const form = new FormData();
    form.append('assignOpenAICode', 'true');
    form.append('email', email);

    return axios.post(CHATGPT_POST_URL, form, {
      timeout: 20000,
      maxBodyLength: Infinity,
      headers: {
        ...CHATGPT_HEADERS,
        ...form.getHeaders(),
        Cookie: cookieHeader
      },
      validateStatus: () => true
    });
  };

  try {
    let response = await attempt(false);
    if (response.status === 403 || response.status === 429) {
      response = await attempt(true);
    }

    if (response.status !== 200) {
      return { success: false, reason: `HTTP ${response.status}` };
    }

    const data = response.data || {};
    if (data.success === 1 && data.code) {
      return { success: true, code: data.code };
    }

    return { success: false, reason: data.message || 'Unknown error' };
  } catch (err) {
    console.error('ChatGPT API error:', err.response?.data || err.message);
    return { success: false, reason: err.message || 'Request failed' };
  }
}

async function getOrCreateChatGptMerchant() {
  let merchant = await Merchant.findOne({ where: { nameEn: 'ChatGPT Code' } });
  if (!merchant) {
    merchant = await Merchant.create({
      nameEn: 'ChatGPT Code',
      nameAr: 'كود ChatGPT',
      price: 5.00,
      category: 'AI Services',
      type: 'single',
      description: { type: 'text', content: 'Get a ChatGPT GO code via email' }
    });
  }
  return merchant;
}

async function processAutoChatGptCode(userId, options = {}) {
  const { isFree = false, fromPoints = false, quantity = 1, allowFallbackStock = true } = options;
  const safeQuantity = Math.max(1, parseInt(quantity, 10) || 1);
  let merchant = null;
  let currentBalance = 0;
  let price = 0;

  if (!isFree) {
    merchant = await getOrCreateChatGptMerchant();
    price = await getChatGptUnitPrice(safeQuantity);
    const userObj = await User.findByPk(userId);
    currentBalance = parseFloat(userObj.balance);

    const totalCost = price * safeQuantity;
    if (currentBalance < totalCost) {
      return {
        success: false,
        reason: 'INSUFFICIENT_BALANCE',
        balance: currentBalance.toFixed(2),
        price: price.toFixed(2),
        totalCost: totalCost.toFixed(2),
        quantity: safeQuantity
      };
    }
  }

  const codes = [];
  let lastFailureReason = null;

  for (let i = 0; i < safeQuantity; i += 1) {
    const email = generateRandomEmail();
    const result = await getChatGPTCode(email);

    if (!result.success) {
      lastFailureReason = result.reason || 'Unknown error';
      if (allowFallbackStock) {
        const remaining = safeQuantity - codes.length;
        const fallbackCodes = await takeFallbackChatGptCodesFromReferralStock(userId, remaining);
        if (fallbackCodes.length > 0) {
          codes.push(...fallbackCodes);
        }
      }
      break;
    }

    codes.push(result.code);
  }

  if (codes.length === 0) {
    return { success: false, reason: lastFailureReason || 'No codes were generated' };
  }

  if (isFree) {
    if (!fromPoints) {
      const freeUser = await User.findByPk(userId);
      const activeRenewalVersion = await getActiveFreeCodeRenewalVersion();
      const updatePayload = {};

      if (!freeUser?.forceFreeCodeButton) {
        updatePayload.freeChatgptReceived = true;
        updatePayload.lastFreeCodeClaimAt = new Date();
      }

      if (activeRenewalVersion > Number(freeUser?.freeCodeRenewalVersionClaimed || 0)) {
        updatePayload.freeCodeRenewalVersionClaimed = activeRenewalVersion;
      }

      if (Object.keys(updatePayload).length > 0) {
        await User.update(updatePayload, { where: { id: userId } });
      }
    }
  } else {
    const chargedAmount = price * codes.length;
    await User.update({ balance: currentBalance - chargedAmount }, { where: { id: userId } });
    await BalanceTransaction.create({ userId, amount: -chargedAmount, type: 'purchase', status: 'completed' });
  }

  return {
    success: true,
    code: codes.join('\n\n'),
    codes,
    quantity: codes.length,
    requestedQuantity: safeQuantity,
    partial: codes.length !== safeQuantity,
    price: price.toFixed(2),
    totalCost: (price * codes.length).toFixed(2),
    newBalance: isFree ? null : (currentBalance - (price * codes.length)).toFixed(2)
  };
}

bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const userId = msg.chat.id;
  const rawArg = match?.[1] ? match[1].trim() : '';

  try {
    const existedBeforeStart = await User.findByPk(userId);
    const isActuallyNewUser = !existedBeforeStart;

    const currentUser = await findOrCreateUser(userId);
    if (!isAdmin(userId) && !(await getBotEnabled()) && !(await isUserAllowedWhenBotStopped(userId))) {
      await bot.sendMessage(userId, await getText(userId, 'botPausedMessage'));
      return;
    }
    const tgUser = msg.from || {};
    const usernameText = tgUser.username ? `@${tgUser.username}` : 'لا يوجد';
    const fullName = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ').trim() || 'لا يوجد';

    let fromReferrerName = null;
    let fromReferrerCount = null;
    let fromReferrerUsername = 'لا يوجد';
    let fromReferrerId = null;
    let shouldNotifyReferrer = false;
    let actualReferrerId = null;

    if (rawArg) {
      let referrerId = null;
      if (/^\d+$/.test(rawArg)) {
        referrerId = parseInt(rawArg, 10);
      } else if (rawArg.startsWith('ref_')) {
        const legacyCode = rawArg.substring(4);
        const referrer = await User.findOne({ where: { referralCode: legacyCode } });
        if (referrer) referrerId = Number(referrer.id);
      }

      if (referrerId && referrerId !== Number(userId)) {
        const referrer = await User.findByPk(referrerId);
        if (referrer) {
          actualReferrerId = referrerId;

          if (!currentUser.referredBy) {
            await User.update({ referredBy: referrerId }, { where: { id: userId } });
            shouldNotifyReferrer = true;
          }

          const refIdentity = await getTelegramIdentityById(referrerId);
          fromReferrerName = refIdentity.fullName;
          fromReferrerUsername = refIdentity.usernameText;
          fromReferrerId = referrerId;
          fromReferrerCount = await User.count({ where: { referredBy: referrerId } });
        }
      }
    }

    if (userId !== ADMIN_ID && isActuallyNewUser) {
      let adminNotice =
        `مستخدم جديد\n` +
        `معرفه: ${usernameText}\n` +
        `اسمه: ${fullName}\n` +
        `ايديه: ${userId}`;

      if (fromReferrerName) {
        adminNotice += `\n\nمن طرف: ${fromReferrerName}`;
        adminNotice += `\nعدد الاحالات: ${fromReferrerCount}`;
        adminNotice += `\nمعرفه: ${fromReferrerUsername}`;
        adminNotice += `\nايديه: ${fromReferrerId}`;
      }

      await bot.sendMessage(ADMIN_ID, adminNotice).catch(() => {});
    }

    if (shouldNotifyReferrer && actualReferrerId) {
      const refCountNow = await User.count({ where: { referredBy: actualReferrerId } });
      const referrerNotice =
        `🎉 دخل مستخدم جديد من رابط إحالتك\n` +
        `المعرف: ${usernameText}\n` +
        `الاسم: ${fullName}\n` +
        `الايدي: ${userId}\n\n` +
        `إجمالي الإحالات من رابطك: ${refCountNow}`;
      await bot.sendMessage(actualReferrerId, referrerNotice).catch(() => {});
    }

    await tryAwardReferralIfEligible(userId);

    const currentState = safeParseState(currentUser.state);
    const needsLanguageChoice = isActuallyNewUser || currentState?.action === 'awaiting_language';

    if (needsLanguageChoice) {
      await setUserState(userId, { action: 'awaiting_language' });
      await bot.sendMessage(userId, await getText(userId, 'start'), {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🇺🇸 English', callback_data: 'lang_en' }],
            [{ text: '🇮🇶 العربية', callback_data: 'lang_ar' }]
          ]
        }
      });
      return;
    }

    await sendMainMenu(userId);
  } catch (err) {
    console.error('Error in /start:', err);
  }
});

bot.onText(/\/admin/, async msg => {
  const userId = msg.chat.id;
  if (!isAdmin(userId)) return;
  await showAdminPanel(userId);
});

bot.on('callback_query', async query => {
  const userId = query.message.chat.id;
  const data = query.data;

  try {
    const cleanupPressedMessage = async () => cleanupCallbackSourceMessage(query, userId);
    await findOrCreateUser(userId);

    if (!isAdmin(userId) && !(await getBotEnabled())) {
      await bot.answerCallbackQuery(query.id).catch(() => {});
      await bot.sendMessage(userId, await getText(userId, 'botPausedMessage')).catch(() => {});
      return;
    }

    if (data.startsWith('lang_')) {
      const newLang = data.split('_')[1] === 'ar' ? 'ar' : 'en';
      const existingUser = await User.findByPk(userId);
      const currentState = safeParseState(existingUser?.state);
      await User.update({ lang: newLang }, { where: { id: userId } });
      if (currentState?.action === 'awaiting_language') {
        await clearUserState(userId);
      }
      const canUse = await ensureUserAccess(userId, { sendJoinPrompt: true, sendCaptchaPrompt: true });
      if (canUse) {
        await tryAwardReferralIfEligible(userId);
        await bot.sendMessage(userId, await getText(userId, 'languageUpdated')).catch(() => {});
        await sendMainMenu(userId);
      }
      await cleanupPressedMessage();
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'check_subscription') {
      const canUse = await ensureUserAccess(userId, { sendJoinPrompt: true, sendCaptchaPrompt: true });
      if (canUse) {
        await tryAwardReferralIfEligible(userId);
        await sendMainMenu(userId);
      }
      await cleanupPressedMessage();
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'ignore') {
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const canUse = await ensureUserAccess(userId, { sendJoinPrompt: true, sendCaptchaPrompt: false });
    if (!canUse) {
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'cancel_state_and_menu') {
      await cancelUserStateAndReturnToMenu(userId);
      await cleanupPressedMessage();
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'back_to_menu') {
      await clearUserState(userId);
      await sendMainMenu(userId);
      await cleanupPressedMessage();
      await bot.answerCallbackQuery(query.id);
      return;
    }
    if (data === 'cancel_action') {
      await clearUserState(userId);
      await sendMainMenu(userId);
      await cleanupPressedMessage();
      await bot.answerCallbackQuery(query.id);
      return;
    }


    if (data === 'change_language') {
      await bot.sendMessage(userId, await getText(userId, 'start'), {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🇺🇸 English', callback_data: 'lang_en' }],
            [{ text: '🇮🇶 العربية', callback_data: 'lang_ar' }],
            [{ text: await getText(userId, 'back'), callback_data: 'back_to_menu' }]
          ]
        }
      });
      await cleanupPressedMessage();
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const isAiCallbackAction = data === 'ai_assistant'
      || /^ai_about_product_/.test(data)
      || /^ai_support_/.test(data)
      || /^ai_buy_/.test(data);

    if (isAiCallbackAction && !(await getAiAssistantEnabled())) {
      await clearUserState(userId);
      await cleanupPressedMessage();
      await bot.answerCallbackQuery(query.id, { text: await getText(userId, 'aiAssistantDisabledNotice') });
      return;
    }

    if (data === 'ai_assistant') {
      await setUserState(userId, { action: 'ai_assistant', history: [], awaitingSupportConfirm: false });
      await bot.sendMessage(userId, await getText(userId, 'aiAssistantWelcome'), {
        reply_markup: await getBackAndCancelReplyMarkup(userId)
      });
      await cleanupPressedMessage();
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const aiAboutProductMatch = data.match(/^ai_about_product_(\d+)$/);
    if (aiAboutProductMatch) {
      const merchantId = parseInt(aiAboutProductMatch[1], 10);
      const merchant = await Merchant.findByPk(merchantId);
      if (merchant) {
        await setUserState(userId, { action: 'ai_assistant', history: [], focusMerchantId: merchantId, awaitingSupportConfirm: false });
        await bot.sendMessage(userId, await getText(userId, 'aiAssistantWelcomeForProduct', { name: await getMerchantDisplayName(merchant, userId) }), {
          reply_markup: await getBackAndCancelReplyMarkup(userId, `digital_product_${merchantId}`)
        });
      }
      await cleanupPressedMessage();
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'ai_support_yes') {
      await clearUserState(userId);
      await startSupportConversation(userId, 'ai');
      await cleanupPressedMessage();
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'ai_support_no') {
      const currentState = safeParseState((await User.findByPk(userId)).state) || {};
      await setUserState(userId, { ...currentState, action: 'ai_assistant', awaitingSupportConfirm: false });
      await bot.sendMessage(userId, await getText(userId, 'aiAssistantSupportDeclined'), {
        reply_markup: await getBackAndCancelReplyMarkup(userId)
      });
      await cleanupPressedMessage();
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const aiBuyYesMatch = data.match(/^ai_buy_yes_(\d+)_(\d+)$/);
    if (aiBuyYesMatch) {
      const merchantId = parseInt(aiBuyYesMatch[1], 10);
      const quantity = Math.max(1, parseInt(aiBuyYesMatch[2], 10) || 1);
      const currentState = safeParseState((await User.findByPk(userId)).state) || {};
      await cleanupPressedMessage();
      await bot.answerCallbackQuery(query.id);
      await completeAssistantMerchantPurchase(userId, merchantId, quantity, currentState);
      return;
    }

    const aiBuyInfoMatch = data.match(/^ai_buy_info_(\d+)_(\d+)$/);
    if (aiBuyInfoMatch) {
      const merchantId = parseInt(aiBuyInfoMatch[1], 10);
      const quantity = Math.max(1, parseInt(aiBuyInfoMatch[2], 10) || 1);
      const merchant = await Merchant.findByPk(merchantId);
      if (merchant) {
        const currentState = safeParseState((await User.findByPk(userId)).state) || {};
        await setUserState(userId, {
          action: 'ai_assistant',
          history: Array.isArray(currentState.history) ? currentState.history.slice(-8) : [],
          focusMerchantId: merchantId,
          awaitingSupportConfirm: false,
          awaitingPurchaseConfirm: true,
          pendingMerchantId: merchantId,
          pendingQuantity: quantity
        });
        await bot.sendMessage(userId, await buildAssistantMerchantInfoText(userId, merchant, quantity), {
          reply_markup: await getAssistantProductInfoReplyMarkup(userId, merchantId, quantity, currentState.focusMerchantId ? `digital_product_${currentState.focusMerchantId}` : 'back_to_menu')
        });
      }
      await cleanupPressedMessage();
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'ai_buy_no') {
      const currentState = safeParseState((await User.findByPk(userId)).state) || {};
      await setUserState(userId, {
        action: 'ai_assistant',
        history: Array.isArray(currentState.history) ? currentState.history.slice(-8) : [],
        focusMerchantId: currentState.focusMerchantId || null,
        awaitingSupportConfirm: false,
        awaitingPurchaseConfirm: false
      });
      await bot.sendMessage(userId, await getText(userId, 'aiAssistantPurchaseCancelled'), {
        reply_markup: await getBackAndCancelReplyMarkup(userId, currentState.focusMerchantId ? `digital_product_${currentState.focusMerchantId}` : 'back_to_menu')
      });
      await cleanupPressedMessage();
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'support_close') {
      await closeSupportConversationForUser(userId, 'user', ADMIN_ID);
      await cleanupPressedMessage();
      await bot.answerCallbackQuery(query.id);
      return;
    }


    if (data === 'support') {
      await clearUserState(userId);
      await startSupportConversation(userId, 'menu');
      await cleanupPressedMessage();
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('support_reply_user_')) {
      await clearUserState(userId);
      await startSupportConversation(userId, 'reply_button');
      await cleanupPressedMessage();
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin' && isAdmin(userId)) {
      await showAdminPanel(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_manage_channel' && isAdmin(userId)) {
      await showChannelConfigAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_private_codes_channel' && isAdmin(userId)) {
      await showPrivateCodesChannelAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_toggle_private_codes_channel' && isAdmin(userId)) {
      const cfg = await getPrivateCodesChannelConfig();
      cfg.enabled = !cfg.enabled;
      await savePrivateCodesChannelConfig(cfg);
      await showPrivateCodesChannelAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_set_private_codes_channel' && isAdmin(userId)) {
      await setUserState(userId, { action: 'set_private_codes_channel' });
      await bot.sendMessage(userId, 'أرسل رابط الدعوة الخاص مثل\nhttps://t.me/+Sf4X6ek8eLRiOGM5\nأو أرسل آيدي القناة، أو قم بإعادة توجيه منشور منها.\n\nمهم: إذا أرسلت رابط دعوة خاص فقط، فقم بعده بإعادة توجيه منشور من نفس القناة مرة واحدة ليتم حفظ معرّف القناة الداخلي للإرسال.', {
        reply_markup: await getBackAndCancelReplyMarkup(userId, 'admin_private_codes_channel')
      });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_send_100_codes_to_private_channel' && isAdmin(userId)) {
      const result = await sendCodesToPrivateChannel(userId, 100);
      if (!result.success) {
        const msg = result.reason === 'channel_not_configured'
          ? '❌ القناة الخاصة غير مفعلة أو غير محفوظة.'
          : result.reason === 'channel_needs_forwarded_post'
            ? '❌ تم حفظ رابط الدعوة الخاص، لكن الإرسال يحتاج أيضاً إعادة توجيه منشور واحد من نفس القناة ليتم حفظ chat_id الداخلي.'
            : result.reason === 'not_enough_stock'
              ? `❌ لا يوجد 100 كود متاح. المتوفر حالياً: ${result.available || 0}`
              : result.reason === 'telegram_send_failed'
                ? '❌ فشل إرسال الأكواد للقناة. تأكد أن البوت مشرف داخل القناة الخاصة.'
                : '❌ حدث خطأ أثناء الإرسال.';
        await bot.sendMessage(userId, msg);
      } else {
        await bot.sendMessage(userId, `✅ تم إرسال ${result.sent} كود إلى القناة الخاصة.
المتبقي في المخزون: ${result.remaining}`);
      }
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_toggle_verification' && isAdmin(userId)) {
      const config = await getChannelConfig();
      if (!config.enabled) {
        const hasTarget = Boolean(config.chatId || config.username || parseChannelTarget(config.link));
        if (!hasTarget) {
          await bot.answerCallbackQuery(query.id, { text: await getText(userId, 'verificationNeedsChannel'), show_alert: true });
          return;
        }
      }

      config.enabled = !config.enabled;
      await config.save();

      await bot.answerCallbackQuery(query.id, {
        text: await getText(userId, config.enabled ? 'verificationToggledOn' : 'verificationToggledOff')
      });
      await showChannelConfigAdmin(userId);
      return;
    }

    if (data === 'admin_set_channel_link' && isAdmin(userId)) {
      await setUserState(userId, { action: 'set_channel_link' });
      await bot.sendMessage(userId, await getText(userId, 'enterNewChannelLink'), {
        reply_markup: await getBackAndCancelReplyMarkup(userId, 'admin_manage_channel')
      });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_set_channel_message' && isAdmin(userId)) {
      await setUserState(userId, { action: 'set_channel_message' });
      await bot.sendMessage(userId, await getText(userId, 'enterNewChannelMessage'), {
        reply_markup: await getBackAndCancelReplyMarkup(userId, 'admin_manage_channel')
      });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_change_button_names' && isAdmin(userId)) {
      await setUserState(userId, { action: 'rename_button_pick_key' });
      await bot.sendMessage(userId, await getText(userId, 'enterButtonNameToChange'), {
        reply_markup: await getBackAndCancelReplyMarkup(userId, 'admin')
      });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_manage_menu_buttons' && isAdmin(userId)) {
      await showMenuButtonsAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_color_buttons' && isAdmin(userId)) {
      await showButtonColorAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const buttonColorItemMatch = data.match(/^admin_button_color_item_(static|section|product)_(.+)$/);
    if (buttonColorItemMatch && isAdmin(userId)) {
      await showButtonColorChoices(userId, buttonColorItemMatch[1], buttonColorItemMatch[2]);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const buttonColorSetMatch = data.match(/^admin_button_color_set_(static|section|product)_(.+)_(primary|success|danger|default)$/);
    if (buttonColorSetMatch && isAdmin(userId)) {
      const type = buttonColorSetMatch[1];
      const id = buttonColorSetMatch[2];
      const style = buttonColorSetMatch[3] === 'default' ? '' : buttonColorSetMatch[3];
      await setButtonStyle(getStyleKey(type, id), style);
      await bot.answerCallbackQuery(query.id, { text: await getText(userId, 'buttonColorUpdated') });
      await showButtonColorChoices(userId, type, id);
      return;
    }

    if (data.startsWith('toggle_button_') && isAdmin(userId)) {
      const parts = data.split('_');
      const action = parts.pop();
      const buttonId = parts.slice(2).join('_');
      await toggleMenuButton(buttonId, action);
      await bot.answerCallbackQuery(query.id, { text: await getText(userId, 'buttonVisibilityUpdated') });
      await showMenuButtonsAdmin(userId);
      return;
    }

    if (data.startsWith('move_button_') && isAdmin(userId)) {
      const parts = data.split('_');
      const direction = parts.pop();
      const buttonId = parts.slice(2).join('_');
      await moveMenuButton(buttonId, direction);
      await bot.answerCallbackQuery(query.id, { text: await getText(userId, 'buttonOrderUpdated') });
      await showMenuButtonsAdmin(userId);
      return;
    }

    const digitalProductToggleMatch = data.match(/^toggle_digital_product_menu_button_(\d+)_(show|hide)$/);
    if (digitalProductToggleMatch && isAdmin(userId)) {
      const productId = parseInt(digitalProductToggleMatch[1], 10);
      const action = digitalProductToggleMatch[2];
      await setDigitalProductVisibility(productId, action === 'show');
      await bot.answerCallbackQuery(query.id, { text: await getText(userId, 'buttonVisibilityUpdated') });
      await showMenuButtonsAdmin(userId);
      return;
    }

    const digitalToggleMatch = data.match(/^toggle_digital_menu_button_(\d+)_(show|hide)$/);
    if (digitalToggleMatch && isAdmin(userId)) {
      const sectionId = parseInt(digitalToggleMatch[1], 10);
      const action = digitalToggleMatch[2];
      await setDigitalSectionVisibility(sectionId, action === 'show');
      await bot.answerCallbackQuery(query.id, { text: await getText(userId, 'buttonVisibilityUpdated') });
      await showMenuButtonsAdmin(userId);
      return;
    }

    const digitalMoveMatch = data.match(/^move_digital_menu_button_(\d+)_(up|down)$/);
    if (digitalMoveMatch && isAdmin(userId)) {
      const sectionId = parseInt(digitalMoveMatch[1], 10);
      const direction = digitalMoveMatch[2];
      await moveDigitalSection(sectionId, direction);
      await bot.answerCallbackQuery(query.id, { text: await getText(userId, 'buttonOrderUpdated') });
      await showMenuButtonsAdmin(userId);
      return;
    }

    if (data.startsWith('support_close_user_') && isAdmin(userId)) {
      const targetUserId = parseInt(data.split('_')[3], 10);
      await closeSupportConversationForUser(targetUserId, 'admin', userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('support_reply_') && isAdmin(userId)) {
      const targetUserId = parseInt(data.split('_')[2], 10);
      await setUserState(userId, { action: 'support_reply', targetUserId });
      await bot.sendMessage(userId, await getText(userId, 'supportAdminReplyPrompt'), {
        reply_markup: await getBackAndCancelReplyMarkup(userId, 'admin')
      });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'my_balance') {
      await bot.sendMessage(userId, await getText(userId, 'balanceInfoText', {
        balance: await getUserBalanceFormatted(userId)
      }), {
        reply_markup: await getBalanceCenterReplyMarkup(userId)
      });
      await cleanupPressedMessage();
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'referral') {
      const user = await User.findByPk(userId);
      const link = await getUserReferralLink(userId);
      const points = Number(user?.referralPoints || 0);
      const requiredPoints = await getEffectiveRedeemPointsForUser(userId);
      const redeemableCodes = await getRedeemableReferralCodesCount(userId);
      const fallbackLink = (await User.findByPk(userId))?.lang === 'ar' ? 'رابط الإحالة غير متاح حالياً' : 'Referral link is currently unavailable';
      const info = await getText(userId, 'referralInfo', { link: escapeHtml(link || fallbackLink), points, requiredPoints, redeemableCodes });

      const freeCodeButtonRow = await shouldShowFreeCodeButton(userId)
        ? [[{ text: await getText(userId, 'getFreeCode'), callback_data: 'get_free_code' }]]
        : [];

      const keyboard = {
        inline_keyboard: [
          [{ text: await getText(userId, 'redeemPoints'), callback_data: 'redeem_points' }],
          ...freeCodeButtonRow,
          [{ text: await getText(userId, 'back'), callback_data: 'back_to_menu' }]
        ]
      };

      await bot.sendMessage(userId, info, { parse_mode: 'HTML', reply_markup: keyboard });
      await cleanupPressedMessage();
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'redeem_points') {
      const user = await User.findByPk(userId);
      const requiredPoints = await getEffectiveRedeemPointsForUser(userId);

      if (Number(user.referralPoints || 0) < requiredPoints) {
        await bot.sendMessage(userId, await getText(userId, 'notEnoughPoints', { points: user.referralPoints, requiredPoints }));
        await cleanupPressedMessage();
        await bot.answerCallbackQuery(query.id);
        return;
      }

      await setUserState(userId, { action: 'redeem_points_amount' });
      await bot.sendMessage(userId, await getText(userId, 'redeemPointsAskAmount', { requiredPoints }), {
        reply_markup: await getBackAndCancelReplyMarkup(userId, 'referral')
      });
      await cleanupPressedMessage();
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'referral_free_code' || data === 'free_code' || data === 'get_free_code') {
      const canClaim = await canUserClaimFreeCode(userId);

      if (!canClaim) {
        await sendMainMenu(userId);
        await cleanupPressedMessage();
        await bot.answerCallbackQuery(query.id);
        return;
      }

      const waitingMsg = await bot.sendMessage(userId, await getText(userId, 'processing'));
      const result = await processAutoChatGptCode(userId, { isFree: true, fromPoints: false, allowFallbackStock: true });
      await bot.deleteMessage(userId, waitingMsg.message_id).catch(() => {});

      if (result.success) {
        {
        const deliveryPrefix = await getCodeDeliveryPrefixHtml(userId);
        await bot.sendMessage(userId, `${deliveryPrefix}${await getText(userId, 'freeCodeSuccess', { code: formatCodesForHtml(result.codes) })}`, { parse_mode: 'HTML' });
      }
        await sendAdminCodeActionNotice(userId, {
          sourceKey: 'free',
          serviceType: 'ChatGPT GO',
          codesCount: Array.isArray(result.codes) ? result.codes.length : 1,
          remainingStockText: 'من الموقع'
        });
      } else {
        await bot.sendMessage(userId, await getText(userId, 'noCodes'));
      }

      await sendMainMenu(userId);
      await cleanupPressedMessage();
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'discount') {
      await setUserState(userId, { action: 'discount' });
      await bot.sendMessage(userId, await getText(userId, 'enterDiscountCode'), {
        reply_markup: await getBackAndCancelReplyMarkup(userId)
      });
      await cleanupPressedMessage();
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'my_purchases') {
      const purchases = await BalanceTransaction.findAll({
        where: { userId, type: 'purchase', status: 'completed' },
        order: [['createdAt', 'DESC']],
        limit: 20
      });

      if (!purchases.length) {
        await bot.sendMessage(userId, await getText(userId, 'noPurchases'), {
          reply_markup: await getBalanceCenterReplyMarkup(userId)
        });
      } else {
        const history = purchases
          .map(p => `🛒 ${p.createdAt.toLocaleDateString()}: ${Math.abs(Number(p.amount || 0)).toFixed(2)} USD`)
          .join('\n');
        await bot.sendMessage(userId, await getText(userId, 'purchaseHistory', { history }), {
          reply_markup: await getBalanceCenterReplyMarkup(userId)
        });
      }
      await cleanupPressedMessage();
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'deposit') {
      await showCurrencyOptions(userId);
      await cleanupPressedMessage();
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'deposit_currency_iqd' || data === 'deposit_currency_usd') {
      await showBinanceAutoAmountOptions(userId);
      await cleanupPressedMessage();
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // -------------------------------------------------------------------
    // زر الدفع التلقائي عبر Binance
    if (data === 'deposit_binance_auto') {
      await showBinanceAutoAmountOptions(userId);
      await cleanupPressedMessage();
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('deposit_binance_amount_')) {
      const amount = parseFloat(data.replace('deposit_binance_amount_', ''));
      if (!Number.isFinite(amount) || amount <= 0) {
        await bot.answerCallbackQuery(query.id, { text: 'Invalid amount' });
        return;
      }
      await sendBinanceAutoInstructions(userId, amount);
      await cleanupPressedMessage();
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'binance_transfer_prompt_order_id') {
      const currentState = safeParseState((await User.findByPk(userId)).state);
      if (currentState?.action !== 'binance_transfer_pending') {
        await bot.answerCallbackQuery(query.id, { text: await getText(userId, 'binanceTransferNoPending') });
        return;
      }

      currentState.awaitingManualOrderId = true;
      await setUserState(userId, currentState);
      await bot.sendMessage(userId, await getText(userId, 'binanceTransferManualPrompt'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('binance_pay_check_')) {
      const merchantTradeNo = String(data.replace('binance_pay_check_', '') || '').trim();
      const result = await syncBinancePayOrderStatus({ merchantTradeNo }, { source: 'bot_callback', notifyUser: true });
      if (!result.success) {
        await bot.answerCallbackQuery(query.id, { text: await getText(userId, 'error') });
        return;
      }

      if (result.remoteStatus === 'PAID') {
        await clearUserState(userId);
        await bot.answerCallbackQuery(query.id, { text: await getText(userId, 'binancePayStatusPaid') });
        await sendMainMenu(userId);
      } else if (result.remoteStatus === 'EXPIRED') {
        await clearUserState(userId);
        await bot.answerCallbackQuery(query.id, { text: await getText(userId, 'binancePayStatusExpired') });
      } else if (result.remoteStatus === 'CANCELED') {
        await clearUserState(userId);
        await bot.answerCallbackQuery(query.id, { text: await getText(userId, 'binancePayStatusClosed') });
      } else if (result.remoteStatus === 'ERROR') {
        await clearUserState(userId);
        await bot.answerCallbackQuery(query.id, { text: await getText(userId, 'binancePayStatusError') });
      } else {
        await bot.answerCallbackQuery(query.id, { text: await getText(userId, 'binancePayStatusPending') });
      }
      return;
    }


    if (data === 'admin_toggle_ai_assistant' && isAdmin(userId)) {
      const enabled = await getAiAssistantEnabled();
      await setAiAssistantEnabled(!enabled);
      await bot.answerCallbackQuery(query.id, { text: await getText(userId, !enabled ? 'aiAssistantTurnedOn' : 'aiAssistantTurnedOff') });
      await showAdminPanel(userId);
      return;
    }

    // -------------------------------------------------------------------

    if (data === 'admin_manage_bots' && isAdmin(userId)) {
      await showBotsList(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_add_bot' && isAdmin(userId)) {
      await setUserState(userId, { action: 'add_bot', step: 'token' });
      await bot.sendMessage(userId, await getText(userId, 'enterBotToken'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('bot_grant_code_') && isAdmin(userId)) {
      const botId = parseInt(data.split('_')[3], 10);
      const botService = await BotService.findByPk(botId);
      if (botService) {
        const allowed = Array.isArray(botService.allowedActions) ? [...botService.allowedActions] : [];
        if (!allowed.includes('code')) allowed.push('code');
        botService.allowedActions = allowed.filter(a => a !== 'full');
        await botService.save();
        await bot.sendMessage(userId, `✅ Granted /code permission to ${botService.name}`);
      }
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('bot_grant_full_') && isAdmin(userId)) {
      const botId = parseInt(data.split('_')[3], 10);
      await setUserState(userId, { action: 'set_bot_owner', botId });
      await bot.sendMessage(userId, 'Send the Telegram user ID of the new bot owner:');
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('bot_remove_perms_') && isAdmin(userId)) {
      const botId = parseInt(data.split('_')[3], 10);
      const botService = await BotService.findByPk(botId);
      if (botService) {
        botService.allowedActions = [];
        botService.ownerId = null;
        await botService.save();
        await bot.sendMessage(userId, `❌ Removed all permissions from ${botService.name}`);
      }
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('admin_remove_bot_confirm_') && isAdmin(userId)) {
      const botId = parseInt(data.split('_')[4], 10);
      await BotService.destroy({ where: { id: botId } });
      await bot.sendMessage(userId, await getText(userId, 'botRemoved'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('approve_deposit_') && isAdmin(userId)) {
      const depositId = parseInt(data.split('_')[2], 10);
      await approveDeposit(depositId, userId);
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: userId, message_id: query.message.message_id }).catch(() => {});
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('reject_deposit_') && isAdmin(userId)) {
      const depositId = parseInt(data.split('_')[2], 10);
      await rejectDeposit(depositId, userId);
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: userId, message_id: query.message.message_id }).catch(() => {});
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'buy') {
      await showMerchantsForBuy(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'redeem') {
      await setUserState(userId, { action: 'redeem_smart' });
      await bot.sendMessage(userId, await getText(userId, 'sendCodeToRedeem'), {
        reply_markup: await getBackAndCancelReplyMarkup(userId, 'back_to_menu')
      });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('redeem_service_')) {
      const serviceId = parseInt(data.split('_')[2], 10);
      await setUserState(userId, { action: 'redeem_via_service', serviceId });
      await bot.sendMessage(userId, await getText(userId, 'sendCodeToRedeem'), {
        reply_markup: await getBackAndCancelReplyMarkup(userId, 'redeem')
      });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('buy_merchant_')) {
      const merchantId = parseInt(data.split('_')[2], 10);
      const available = await Code.count({ where: { merchantId, isUsed: false } });
      if (!available) {
        await bot.sendMessage(userId, await getText(userId, 'noCodes'));
        await sendMainMenu(userId);
        await bot.answerCallbackQuery(query.id);
        return;
      }
      const currentState = safeParseState((await User.findByPk(userId)).state);
      const discountCode = currentState?.discountCode || null;
      const merchant = await Merchant.findByPk(merchantId);
      await setUserState(userId, { action: 'buy', merchantId, discountCode });
      await bot.sendMessage(userId, `${await getText(userId, 'enterQty')}\n${await getText(userId, 'remainingStockLine', { stock: available })}\n${await getText(userId, 'itemPriceLine', { price: formatUsdPrice(merchant?.price || 0) })}\n${await getCurrentBalanceLineText(userId)}\n\n${await getBulkDiscountInfoText(userId)}`, {
        reply_markup: await getBackAndCancelReplyMarkup(userId, 'buy')
      });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('show_description_')) {
      const merchantId = parseInt(data.split('_')[2], 10);
      const merchant = await Merchant.findByPk(merchantId);
      if (merchant?.description) {
        const desc = merchant.description;
        if (desc.type === 'text') await bot.sendMessage(userId, desc.content);
        else if (desc.type === 'photo') await bot.sendPhoto(userId, desc.fileId);
        else if (desc.type === 'video') await bot.sendVideo(userId, desc.fileId);
      } else {
        await bot.sendMessage(userId, 'No description available.');
      }
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_stats' && isAdmin(userId)) {
      const totalCodes = await Code.count();
      const totalSales = await BalanceTransaction.sum('amount', { where: { type: 'purchase', status: 'completed' } });
      const pendingDeposits = await BalanceTransaction.count({ where: { type: 'deposit', status: 'pending' } });
      await bot.sendMessage(userId,
        `${await getText(userId, 'totalCodes', { count: totalCodes })}\n` +
        `${await getText(userId, 'totalSales', { amount: Math.abs(totalSales || 0) })}\n` +
        `${await getText(userId, 'pendingDeposits', { count: pendingDeposits })}`
      );
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_payment_methods' && isAdmin(userId)) {
      const methods = await PaymentMethod.findAll();
      let msg = '💳 Payment Methods:\n';
      for (const m of methods) {
        msg += `ID: ${m.id} | ${m.nameEn} (${m.type}) - Active: ${m.isActive}\n`;
      }
      const keyboard = {
        inline_keyboard: [
          [{ text: '➕ Add New', callback_data: 'admin_add_payment' }],
          [{ text: '🗑️ Delete', callback_data: 'admin_delete_payment' }],
          [{ text: '⚙️ Set Limits', callback_data: 'admin_set_limits' }],
          [{ text: await getText(userId, 'back'), callback_data: 'admin' }]
        ]
      };
      await bot.sendMessage(userId, msg, { reply_markup: keyboard });
      await bot.answerCallbackQuery(query.id);
      return;
    }


    if (data === 'admin_manage_deposit_options' && isAdmin(userId)) {
      await showDepositOptionsAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('admin_toggle_deposit_option_') && isAdmin(userId)) {
      const key = data.replace('admin_toggle_deposit_option_', '');
      const visibility = await getDepositOptionVisibility();
      visibility[key] = !(visibility[key] !== false);
      await setDepositOptionVisibility(visibility);
      await bot.answerCallbackQuery(query.id, { text: await getText(userId, 'depositOptionsUpdated') });
      await showDepositOptionsAdmin(userId);
      return;
    }

    if (data === 'admin_manage_deposit_settings' && isAdmin(userId)) {
      await showDepositSettingsAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_set_iqd_rate' && isAdmin(userId)) {
      await setUserState(userId, { action: 'set_iqd_rate' });
      await bot.sendMessage(userId, await getText(userId, 'enterNewRate'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_edit_deposit_instructions' && isAdmin(userId)) {
      await showDepositInstructionsEdit(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_edit_currency_names' && isAdmin(userId)) {
      await showCurrencyNamesEdit(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if ((data === 'admin_manage_iqd_methods' || data === 'admin_manage_usd_methods') && isAdmin(userId)) {
      const currency = data.includes('iqd') ? 'IQD' : 'USD';
      await showDepositMethodsAdmin(userId, currency);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if ((data === 'admin_add_deposit_method_IQD' || data === 'admin_add_deposit_method_USD') && isAdmin(userId)) {
      const currency = data.endsWith('IQD') ? 'IQD' : 'USD';
      await setUserState(userId, { action: 'add_deposit_method', currency, step: 'nameAr' });
      await bot.sendMessage(userId, await getText(userId, 'enterMethodNameAr'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if ((data === 'admin_delete_deposit_method_menu_IQD' || data === 'admin_delete_deposit_method_menu_USD') && isAdmin(userId)) {
      const currency = data.endsWith('IQD') ? 'IQD' : 'USD';
      await showDeleteDepositMethodsMenu(userId, currency);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('admin_delete_deposit_method_') && isAdmin(userId)) {
      const parts = data.split('_');
      const currency = parts[4];
      const index = parseInt(parts[5], 10);
      if (!Number.isNaN(index)) {
        await deleteDepositMethod(currency, index);
        await bot.sendMessage(userId, await getText(userId, 'methodDeleted'));
        await showDepositMethodsAdmin(userId, currency);
      }
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('admin_edit_name_') && isAdmin(userId)) {
      const parts = data.split('_');
      const currency = parts[3];
      const langCode = parts[4];
      await setUserState(userId, { action: 'edit_currency_name', currency, langCode });
      await bot.sendMessage(userId, await getText(userId, 'enterNewCurrencyName'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('admin_edit_template_') && isAdmin(userId)) {
      const parts = data.split('_');
      const currency = parts[3];
      const langCode = parts[4];
      await setUserState(userId, { action: 'edit_deposit_template', currency, langCode });
      await bot.sendMessage(userId, await getText(userId, 'enterNewTemplate'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_add_merchant' && isAdmin(userId)) {
      await setUserState(userId, { action: 'add_merchant', step: 'nameEn' });
      await bot.sendMessage(userId, await getText(userId, 'askMerchantNameEn'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_list_merchants' && isAdmin(userId)) {
      const merchants = await Merchant.findAll();
      let msg = await getText(userId, 'merchantList');
      for (const m of merchants) {
        msg += `ID: ${m.id} | ${m.nameEn} / ${m.nameAr} | Price: ${m.price} USD | Category: ${m.category} | Type: ${m.type}\n`;
      }
      const keyboard = {
        inline_keyboard: [
          [{ text: '✏️ Edit', callback_data: 'admin_edit_merchant' }],
          [{ text: '🗑️ Delete', callback_data: 'admin_delete_merchant' }],
          [{ text: '📂 Edit Category', callback_data: 'admin_edit_category' }],
          [{ text: await getText(userId, 'back'), callback_data: 'admin' }]
        ]
      };
      await bot.sendMessage(userId, msg, { reply_markup: keyboard });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_set_chatgpt_price' && isAdmin(userId)) {
      await setUserState(userId, { action: 'set_chatgpt_price' });
      await bot.sendMessage(userId, await getText(userId, 'enterChatgptPrice'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_set_price' && isAdmin(userId)) {
      const merchants = await Merchant.findAll();
      const buttons = merchants.map(m => ([{ text: `${m.nameEn} (ID: ${m.id})`, callback_data: `set_price_merchant_${m.id}` }]));
      buttons.push([{ text: await getText(userId, 'back'), callback_data: 'admin' }]);
      await bot.sendMessage(userId, await getText(userId, 'setPrice'), { reply_markup: { inline_keyboard: buttons } });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('set_price_merchant_') && isAdmin(userId)) {
      const merchantId = parseInt(data.split('_')[3], 10);
      await setUserState(userId, { action: 'set_price', merchantId });
      await bot.sendMessage(userId, await getText(userId, 'enterPrice'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_add_codes' && isAdmin(userId)) {
      const merchants = await Merchant.findAll();
      const buttons = merchants.map(m => ([{ text: `${m.nameEn} (ID: ${m.id})`, callback_data: `add_codes_merchant_${m.id}` }]));
      buttons.push([{ text: await getText(userId, 'back'), callback_data: 'admin' }]);
      await bot.sendMessage(userId, await getText(userId, 'addCodes'), { reply_markup: { inline_keyboard: buttons } });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('add_codes_merchant_') && isAdmin(userId)) {
      const merchantId = parseInt(data.split('_')[3], 10);
      await setUserState(userId, { action: 'add_codes', merchantId });
      await bot.sendMessage(userId, await getText(userId, 'enterCodes'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_referral_settings' && isAdmin(userId)) {
      await showReferralSettingsAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_referral_eligible_users' && isAdmin(userId)) {
      const eligible = await getEligibleReferralUsers(1);
      if (!eligible.length) {
        await bot.sendMessage(userId, await getText(userId, 'noReferralEligibleUsers'));
      } else {
        let msgText = `${await getText(userId, 'referralEligibleUsersTitle')}\n\n`;
        for (const item of eligible.slice(0, 100)) {
          const identity = await getTelegramIdentityById(item.user.id);
          msgText += await getText(userId, 'referralEligibleUserLine', {
            name: identity.fullName,
            username: identity.usernameText,
            id: item.user.id,
            points: item.totalPoints,
            adminGranted: item.adminGranted,
            referrals: item.referralCount,
            milestoneRewards: item.milestoneRewards,
            claimedCodes: item.claimedCodes,
            redeemableCodes: item.redeemableCodes
          });
          msgText += `\n\n`;
        }
        await bot.sendMessage(userId, msgText);
      }
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_deduct_points' && isAdmin(userId)) {
      await setUserState(userId, { action: 'deduct_points', step: 'user_id' });
      await bot.sendMessage(userId, await getText(userId, 'enterDeductPointsUserId'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_referral_stock_settings' && isAdmin(userId)) {
      await showReferralStockSettingsAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_referral_codes_channel' && isAdmin(userId)) {
      await showReferralCodesChannelAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_toggle_referral_codes_channel' && isAdmin(userId)) {
      const config = await getReferralCodesChannelConfig();
      config.enabled = !config.enabled;
      await saveReferralCodesChannelConfig(config);
      await showReferralCodesChannelAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_set_referral_codes_channel' && isAdmin(userId)) {
      await setUserState(userId, { action: 'set_referral_codes_channel' });
      await bot.sendMessage(userId, 'أرسل رابط أو آيدي قناة الكودات، أو قم بإعادة توجيه منشور منها. هذه القناة تخص فقط زر 📥 إضافة كودات من القناة الخاصة.');
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_add_referral_stock_codes' && isAdmin(userId)) {
      await setUserState(userId, { action: 'add_referral_stock_codes' });
      await bot.sendMessage(userId, await getText(userId, 'enterReferralStockCodes'), {
        reply_markup: getReferralStockInputReplyMarkup()
      });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_finish_add_referral_stock_codes' && isAdmin(userId)) {
      await clearUserState(userId);
      await bot.sendMessage(userId, '✅ تم إغلاق وضع إضافة أكواد مخزون الإحالات.');
      await showReferralStockSettingsAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_view_referral_stock_count' && isAdmin(userId)) {
      const merchant = await getReferralStockMerchant();
      const count = await Code.count({ where: { merchantId: merchant.id, isUsed: false } });
      await bot.sendMessage(userId, await getText(userId, 'referralStockCountText', { count }));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_search_referral_stock_duplicates' && isAdmin(userId)) {
      const duplicates = await getReferralStockDuplicateRows();
      if (!duplicates.length) {
        await bot.sendMessage(userId, await getText(userId, 'referralStockDuplicatesNone'));
      } else {
        const codesText = formatDuplicateCodesForAdmin(duplicates);
        await bot.sendMessage(
          userId,
          await getText(userId, 'referralStockDuplicatesFound', { count: duplicates.length, codes: codesText }),
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: await getText(userId, 'deleteReferralStockDuplicates'), callback_data: 'admin_delete_referral_stock_duplicates' }],
                [{ text: await getText(userId, 'back'), callback_data: 'admin_referral_stock_settings' }]
              ]
            }
          }
        );
      }
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_delete_referral_stock_duplicates' && isAdmin(userId)) {
      const result = await deleteReferralStockDuplicateRows();
      await bot.sendMessage(userId, await getText(userId, 'referralStockDuplicatesDeleted', { count: result.count }));
      await showReferralStockSettingsAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_import_referral_stock_from_private_channel' && isAdmin(userId)) {
      const result = await importReferralStockCodesFromPrivateChannel();
      if (!result.success) {
        if (result.reason === 'channel_not_configured') {
          await bot.sendMessage(userId, '❌ القناة الخاصة غير محفوظة أو غير مفعلة.');
        } else if (result.reason === 'no_posts') {
          await bot.sendMessage(userId, await getText(userId, 'referralStockImportNoPosts'));
        } else {
          await bot.sendMessage(userId, await getText(userId, 'referralStockImportNoCodes'));
        }
      } else {
        await bot.sendMessage(userId, await getText(userId, 'referralStockImportedFromPrivateChannel', {
          added: result.added,
          duplicates: result.duplicates,
          posts: result.posts
        }));
      }
      await showReferralStockSettingsAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_prompt_delete_referral_stock_codes' && isAdmin(userId)) {
      await setUserState(userId, { action: 'delete_referral_stock_codes_by_input' });
      await bot.sendMessage(userId, await getText(userId, 'enterSearchDeleteReferralStockCodes'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_toggle_referrals' && isAdmin(userId)) {
      const current = await getReferralEnabled();
      await Setting.upsert({ key: 'referral_enabled', lang: 'global', value: String(!current) });
      await bot.sendMessage(userId, await getText(userId, !current ? 'referralsTurnedOn' : 'referralsTurnedOff'));
      await showReferralSettingsAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_set_allowed_users' && isAdmin(userId)) {
      await setUserState(userId, { action: 'set_allowed_users' });
      await bot.sendMessage(userId, await getText(userId, 'enterAllowedUsers'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'referral_prize' || data === 'referral_stock_claim') {
      const referralCount = await getSuccessfulReferralCount(userId);
      if (referralCount <= 0) {
        await bot.sendMessage(userId, await getText(userId, 'referralStockAccessDenied'));
      } else {
        const maxCodes = await getRedeemableReferralCodesCount(userId);
        if (maxCodes <= 0) {
          await bot.sendMessage(userId, await getText(userId, 'notEnoughPoints', {
            points: (await User.findByPk(userId))?.referralPoints || 0,
            requiredPoints: await getEffectiveRedeemPointsForUser(userId)
          }));
        } else {
          await setUserState(userId, { action: 'claim_referral_stock' });
          await bot.sendMessage(userId, await getText(userId, 'referralClaimAskCount', { maxCodes }));
        }
      }
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_set_referral_percent' && isAdmin(userId)) {
      await setUserState(userId, { action: 'set_referral_percent' });
      await bot.sendMessage(userId, await getText(userId, 'setReferralPercent'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_set_redeem_points' && isAdmin(userId)) {
      await setUserState(userId, { action: 'set_redeem_points' });
      await bot.sendMessage(userId, await getText(userId, 'enterRedeemPoints'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_set_free_code_days' && isAdmin(userId)) {
      await setUserState(userId, { action: 'set_free_code_days' });
      await bot.sendMessage(userId, await getText(userId, 'enterFreeCodeDays'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_renew_free_code' && isAdmin(userId)) {
      const currentVersion = Math.max(0, parseInt(await getGlobalSetting('free_code_renewal_version', '0'), 10) || 0);
      const nextVersion = currentVersion + 1;
      const expiresAt = new Date(Date.now() + (24 * 60 * 60 * 1000));

      await Setting.upsert({ key: 'free_code_renewal_version', lang: 'global', value: String(nextVersion) });
      await Setting.upsert({ key: 'free_code_renewal_expires_at', lang: 'global', value: expiresAt.toISOString() });

      await bot.sendMessage(userId, await getText(userId, 'renewFreeCodeDone'));
      await showReferralSettingsAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_edit_referral_milestones' && isAdmin(userId)) {
      await setUserState(userId, { action: 'edit_referral_milestones' });
      await bot.sendMessage(userId, await getText(userId, 'enterReferralMilestones'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_quantity_discount_settings' && isAdmin(userId)) {
      await showQuantityDiscountSettingsAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_set_bulk_discount_threshold' && isAdmin(userId)) {
      await setUserState(userId, { action: 'set_bulk_discount_threshold' });
      await bot.sendMessage(userId, await getText(userId, 'enterBulkDiscountThreshold'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_set_bulk_discount_price' && isAdmin(userId)) {
      await setUserState(userId, { action: 'set_bulk_discount_price' });
      await bot.sendMessage(userId, await getText(userId, 'enterBulkDiscountPrice'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_bot_control' && isAdmin(userId)) {
      await showBotControlAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_balance_management' && isAdmin(userId)) {
      await showBalanceManagementAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_users_with_balance' && isAdmin(userId)) {
      const users = await User.findAll({
        where: { balance: { [Op.gt]: 0 } },
        order: [['balance', 'DESC']],
        limit: 100
      });
      if (!users.length) {
        await bot.sendMessage(userId, await getText(userId, 'noUsersWithBalance'));
      } else {
        let msgText = `${await getText(userId, 'usersWithBalanceTitle')}\n\n`;
        for (const u of users) {
          const identity = await getTelegramIdentityById(u.id);
          msgText += await getText(userId, 'balanceUserLine', {
            name: identity.fullName,
            username: identity.usernameText,
            id: u.id,
            balance: Number(u.balance || 0).toFixed(2)
          });
          msgText += `\n\n`;
        }
        await bot.sendMessage(userId, msgText);
      }
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_add_balance' && isAdmin(userId)) {
      await setUserState(userId, { action: 'admin_add_balance', step: 'user_id' });
      await bot.sendMessage(userId, await getText(userId, 'enterBalanceUserId'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_deduct_balance' && isAdmin(userId)) {
      await setUserState(userId, { action: 'admin_deduct_balance', step: 'user_id' });
      await bot.sendMessage(userId, await getText(userId, 'enterBalanceUserId'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_toggle_bot_enabled' && isAdmin(userId)) {
      const enabled = await getBotEnabled();
      await Setting.upsert({ key: 'bot_enabled', lang: 'global', value: enabled ? 'false' : 'true' });
      await bot.sendMessage(userId, await getText(userId, enabled ? 'botTurnedOff' : 'botTurnedOn'));
      await showBotControlAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_manage_free_code_access' && isAdmin(userId)) {
      await bot.sendMessage(userId, await getText(userId, 'manageFreeCodeAccess'), {
        reply_markup: {
          inline_keyboard: [
            [{ text: await getText(userId, 'enableFreeCodeForUser'), callback_data: 'admin_enable_free_code_for_user' }],
            [{ text: await getText(userId, 'disableFreeCodeForUser'), callback_data: 'admin_disable_free_code_for_user' }],
            [{ text: await getText(userId, 'back'), callback_data: 'admin_referral_settings' }]
          ]
        }
      });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_enable_free_code_for_user' && isAdmin(userId)) {
      await setUserState(userId, { action: 'toggle_free_code_for_user', mode: 'enable' });
      await bot.sendMessage(userId, await getText(userId, 'enterFreeCodeAccessUserId'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_disable_free_code_for_user' && isAdmin(userId)) {
      await setUserState(userId, { action: 'toggle_free_code_for_user', mode: 'disable' });
      await bot.sendMessage(userId, await getText(userId, 'enterFreeCodeAccessUserId'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_grant_creator_discount' && isAdmin(userId)) {
      await setUserState(userId, { action: 'grant_creator_discount', step: 'user_id' });
      await bot.sendMessage(userId, await getText(userId, 'enterCreatorDiscountUserId'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_grant_points' && isAdmin(userId)) {
      await setUserState(userId, { action: 'grant_points', step: 'user_id' });
      await bot.sendMessage(userId, await getText(userId, 'enterGrantPointsUserId'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_manage_redeem_services' && isAdmin(userId)) {
      await showRedeemServicesAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_add_redeem_service' && isAdmin(userId)) {
      await setUserState(userId, { action: 'add_redeem_service', step: 'nameEn' });
      await bot.sendMessage(userId, await getText(userId, 'redeemServiceNameEn'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_delete_redeem_service' && isAdmin(userId)) {
      const services = await RedeemService.findAll();
      const buttons = services.map(s => ([{ text: `${s.nameEn} (ID: ${s.id})`, callback_data: `delete_redeem_service_${s.id}` }]));
      buttons.push([{ text: await getText(userId, 'back'), callback_data: 'admin_manage_redeem_services' }]);
      await bot.sendMessage(userId, 'Select service to delete:', { reply_markup: { inline_keyboard: buttons } });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('delete_redeem_service_') && isAdmin(userId)) {
      const serviceId = parseInt(data.split('_')[3], 10);
      await RedeemService.destroy({ where: { id: serviceId } });
      await bot.sendMessage(userId, 'Service deleted.');
      await showRedeemServicesAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_manage_discount_codes' && isAdmin(userId)) {
      await showDiscountCodesAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_send_announcement' && isAdmin(userId)) {
      await setUserState(userId, { action: 'broadcast_announcement' });
      await bot.sendMessage(userId, await getText(userId, 'enterAnnouncementText'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_edit_code_delivery_message' && isAdmin(userId)) {
      await bot.sendMessage(userId, await getText(userId, 'chooseCodeMessageLanguage'), {
        reply_markup: {
          inline_keyboard: [
            [{ text: await getText(userId, 'codeMessageArabic'), callback_data: 'admin_edit_code_message_ar' }],
            [{ text: await getText(userId, 'codeMessageEnglish'), callback_data: 'admin_edit_code_message_en' }],
            [{ text: await getText(userId, 'back'), callback_data: 'admin' }]
          ]
        }
      });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_edit_code_message_ar' && isAdmin(userId)) {
      await setUserState(userId, { action: 'edit_code_delivery_message', targetLang: 'ar' });
      await bot.sendMessage(userId, await getText(userId, 'enterCodeDeliveryMessage'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_edit_code_message_en' && isAdmin(userId)) {
      await setUserState(userId, { action: 'edit_code_delivery_message', targetLang: 'en' });
      await bot.sendMessage(userId, await getText(userId, 'enterCodeDeliveryMessage'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_add_discount_code' && isAdmin(userId)) {
      await setUserState(userId, { action: 'add_discount_code', step: 'code' });
      await bot.sendMessage(userId, await getText(userId, 'enterDiscountCodeValue'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_delete_discount_code' && isAdmin(userId)) {
      const codes = await DiscountCode.findAll();
      const buttons = codes.map(c => ([{ text: `${c.code} (${c.discountPercent}%)`, callback_data: `delete_discount_code_${c.id}` }]));
      buttons.push([{ text: await getText(userId, 'back'), callback_data: 'admin_manage_discount_codes' }]);
      await bot.sendMessage(userId, 'Select discount code to delete:', { reply_markup: { inline_keyboard: buttons } });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('delete_discount_code_') && isAdmin(userId)) {
      const codeId = parseInt(data.split('_')[3], 10);
      await DiscountCode.destroy({ where: { id: codeId } });
      await bot.sendMessage(userId, await getText(userId, 'discountCodeDeleted'));
      await showDiscountCodesAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_edit_merchant' && isAdmin(userId)) {
      const merchants = await Merchant.findAll();
      const buttons = merchants.map(m => ([{ text: `${m.nameEn} (ID: ${m.id})`, callback_data: `edit_merchant_${m.id}` }]));
      buttons.push([{ text: await getText(userId, 'back'), callback_data: 'admin_list_merchants' }]);
      await bot.sendMessage(userId, 'Select merchant to edit:', { reply_markup: { inline_keyboard: buttons } });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('edit_merchant_') && isAdmin(userId)) {
      const merchantId = parseInt(data.split('_')[2], 10);
      await setUserState(userId, { action: 'edit_merchant', merchantId, step: 'nameEn' });
      await bot.sendMessage(userId, 'Send new English name (or /skip):');
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_delete_merchant' && isAdmin(userId)) {
      const merchants = await Merchant.findAll();
      const buttons = merchants.map(m => ([{ text: `${m.nameEn} (ID: ${m.id})`, callback_data: `delete_merchant_${m.id}` }]));
      buttons.push([{ text: await getText(userId, 'back'), callback_data: 'admin_list_merchants' }]);
      await bot.sendMessage(userId, 'Select merchant to delete:', { reply_markup: { inline_keyboard: buttons } });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('delete_merchant_') && isAdmin(userId)) {
      const merchantId = parseInt(data.split('_')[2], 10);
      await setUserState(userId, { action: 'confirm_delete_merchant', merchantId });
      await bot.sendMessage(userId, await getText(userId, 'confirmDelete'), {
        reply_markup: {
          inline_keyboard: [
            [{ text: await getText(userId, 'yes'), callback_data: `confirm_delete_merchant_yes_${merchantId}` }],
            [{ text: await getText(userId, 'no'), callback_data: 'admin_list_merchants' }]
          ]
        }
      });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('confirm_delete_merchant_yes_') && isAdmin(userId)) {
      const merchantId = parseInt(data.split('_')[4], 10);
      await Merchant.destroy({ where: { id: merchantId } });
      await bot.sendMessage(userId, await getText(userId, 'merchantDeleted'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_edit_category' && isAdmin(userId)) {
      const merchants = await Merchant.findAll();
      const buttons = merchants.map(m => ([{ text: `${m.nameEn} (ID: ${m.id})`, callback_data: `edit_category_${m.id}` }]));
      buttons.push([{ text: await getText(userId, 'back'), callback_data: 'admin_list_merchants' }]);
      await bot.sendMessage(userId, 'Select merchant to edit category:', { reply_markup: { inline_keyboard: buttons } });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('edit_category_') && isAdmin(userId)) {
      const merchantId = parseInt(data.split('_')[2], 10);
      await setUserState(userId, { action: 'edit_category', merchantId });
      await bot.sendMessage(userId, await getText(userId, 'askCategory'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_add_payment' && isAdmin(userId)) {
      await setUserState(userId, { action: 'add_payment_method', step: 'nameEn' });
      await bot.sendMessage(userId, 'Send payment method name in English:');
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_delete_payment' && isAdmin(userId)) {
      const methods = await PaymentMethod.findAll();
      const buttons = methods.map(m => ([{ text: `${m.nameEn} (ID: ${m.id})`, callback_data: `delete_payment_${m.id}` }]));
      buttons.push([{ text: await getText(userId, 'back'), callback_data: 'admin_payment_methods' }]);
      await bot.sendMessage(userId, 'Select payment method to delete:', { reply_markup: { inline_keyboard: buttons } });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('delete_payment_') && isAdmin(userId)) {
      const paymentId = parseInt(data.split('_')[2], 10);
      await PaymentMethod.destroy({ where: { id: paymentId } });
      await bot.sendMessage(userId, 'Payment method deleted.');
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_set_limits' && isAdmin(userId)) {
      const methods = await PaymentMethod.findAll();
      const buttons = methods.map(m => ([{ text: `${m.nameEn} (ID: ${m.id})`, callback_data: `set_limits_${m.id}` }]));
      buttons.push([{ text: await getText(userId, 'back'), callback_data: 'admin_payment_methods' }]);
      await bot.sendMessage(userId, 'Select payment method to set limits:', { reply_markup: { inline_keyboard: buttons } });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('set_limits_') && isAdmin(userId)) {
      const methodId = parseInt(data.split('_')[2], 10);
      await setUserState(userId, { action: 'set_limits', methodId, step: 'min' });
      await bot.sendMessage(userId, 'Enter minimum deposit amount (USD):');
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'merchant_type_single' || data === 'merchant_type_bulk') {
      const state = safeParseState((await User.findByPk(userId)).state);
      if ((state?.action === 'add_merchant' || state?.action === 'add_digital_product') && state.step === 'type') {
        const selectedType = data === 'merchant_type_single' ? 'single' : 'bulk';
        const nextPrompt = state.action === 'add_digital_product'
          ? await getText(userId, 'askDigitalProductDescription')
          : await getText(userId, 'askDescription');
        await setUserState(userId, { ...state, selectedType, step: 'description' });
        await bot.sendMessage(userId, nextPrompt);
      }
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_digital_subscriptions' && isAdmin(userId)) {
      await showDigitalSubscriptionsAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_toggle_digital_stock_broadcast' && isAdmin(userId)) {
      const current = await getDigitalStockBroadcastEnabled();
      const nextValue = !current;
      await Setting.upsert({ key: 'digital_stock_broadcast_enabled', lang: 'global', value: String(nextValue) });
      await bot.answerCallbackQuery(query.id, { text: await getText(userId, nextValue ? 'digitalStockBroadcastEnabled' : 'digitalStockBroadcastDisabled') });
      await showDigitalSubscriptionsAdmin(userId);
      return;
    }

    if (data === 'admin_digital_add_section' && isAdmin(userId)) {
      await setUserState(userId, { action: 'add_digital_section', step: 'nameEn' });
      await bot.sendMessage(userId, await getText(userId, 'askDigitalSectionNameEn'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('admin_digital_section_') && isAdmin(userId)) {
      const sectionId = parseInt(data.split('_')[3], 10);
      await showDigitalSectionAdmin(userId, sectionId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('admin_digital_add_product_') && isAdmin(userId)) {
      const sectionId = parseInt(data.split('_')[4], 10);
      await setUserState(userId, { action: 'add_digital_product', sectionId, step: 'nameEn' });
      await bot.sendMessage(userId, await getText(userId, 'askDigitalProductNameEn'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('admin_digital_product_') && isAdmin(userId)) {
      const merchantId = parseInt(data.split('_')[3], 10);
      const currentState = safeParseState((await User.findByPk(userId)).state);
      if (['add_codes', 'bulk_account_entry', 'delete_digital_product_stock_by_input'].includes(currentState?.action)) {
        await clearUserState(userId);
      }
      await showDigitalProductAdmin(userId, merchantId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const toggleFrontDigitalProductMatch = data.match(/^admin_toggle_front_digital_product_(\d+)$/);
    if (toggleFrontDigitalProductMatch && isAdmin(userId)) {
      const merchantId = parseInt(toggleFrontDigitalProductMatch[1], 10);
      await toggleFeaturedDigitalProduct(merchantId);
      await bot.answerCallbackQuery(query.id, { text: await getText(userId, 'frontDigitalProductUpdated') });
      await showDigitalProductAdmin(userId, merchantId);
      return;
    }

    if (data.startsWith('admin_digital_add_stock_') && isAdmin(userId)) {
      const merchantId = parseInt(data.split('_')[4], 10);
      const merchant = await Merchant.findByPk(merchantId);
      await setUserState(userId, { action: 'add_codes', merchantId, returnTo: 'digital_product_admin' });
      await bot.sendMessage(userId, await getText(userId, 'digitalStockInputPrompt'), {
        reply_markup: await getDigitalStockInputReplyMarkup(userId, merchant)
      });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const bulkAddAccountMatch = data.match(/^admin_bulk_add_account_(\d+)$/);
    if (bulkAddAccountMatch && isAdmin(userId)) {
      const merchantId = parseInt(bulkAddAccountMatch[1], 10);
      await setUserState(userId, { action: 'bulk_account_entry', merchantId, returnTo: 'digital_product_admin', step: 'email', draft: {} });
      await bot.sendMessage(userId, await getText(userId, 'enterBulkEmail'), {
        reply_markup: await getBackAndCancelReplyMarkup(userId, `admin_digital_product_${merchantId}`)
      });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const bulkAddAnotherMatch = data.match(/^admin_bulk_account_again_(\d+)$/);
    if (bulkAddAnotherMatch && isAdmin(userId)) {
      const merchantId = parseInt(bulkAddAnotherMatch[1], 10);
      await setUserState(userId, { action: 'bulk_account_entry', merchantId, returnTo: 'digital_product_admin', step: 'email', draft: {} });
      await bot.sendMessage(userId, await getText(userId, 'enterBulkEmail'), {
        reply_markup: await getBackAndCancelReplyMarkup(userId, `admin_digital_product_${merchantId}`)
      });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const bulkDoneMatch = data.match(/^admin_bulk_account_done_(\d+)$/);
    if (bulkDoneMatch && isAdmin(userId)) {
      const merchantId = parseInt(bulkDoneMatch[1], 10);
      await clearUserState(userId);
      await showDigitalProductAdmin(userId, merchantId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const editDigitalSectionMatch = data.match(/^admin_edit_digital_section_(\d+)$/);
    if (editDigitalSectionMatch && isAdmin(userId)) {
      const sectionId = parseInt(editDigitalSectionMatch[1], 10);
      await setUserState(userId, { action: 'edit_digital_section_name', sectionId, step: 'nameEn' });
      await bot.sendMessage(userId, await getText(userId, 'askEditDigitalSectionNameEn'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const deleteDigitalSectionMatch = data.match(/^admin_delete_digital_section_(\d+)$/);
    if (deleteDigitalSectionMatch && isAdmin(userId)) {
      const sectionId = parseInt(deleteDigitalSectionMatch[1], 10);
      await bot.sendMessage(userId, await getText(userId, 'confirmDeleteDigitalSection'), {
        reply_markup: {
          inline_keyboard: [
            [{ text: await getText(userId, 'yes'), callback_data: `admin_confirm_delete_digital_section_${sectionId}` }],
            [{ text: await getText(userId, 'no'), callback_data: `admin_digital_section_${sectionId}` }]
          ]
        }
      });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const confirmDeleteDigitalSectionMatch = data.match(/^admin_confirm_delete_digital_section_(\d+)$/);
    if (confirmDeleteDigitalSectionMatch && isAdmin(userId)) {
      const sectionId = parseInt(confirmDeleteDigitalSectionMatch[1], 10);
      await deleteDigitalSectionAndContent(sectionId);
      await bot.sendMessage(userId, await getText(userId, 'digitalSectionDeleted'));
      await showDigitalSubscriptionsAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const editDigitalProductNameMatch = data.match(/^admin_edit_digital_product_name_(\d+)$/);
    if (editDigitalProductNameMatch && isAdmin(userId)) {
      const merchantId = parseInt(editDigitalProductNameMatch[1], 10);
      const merchant = await Merchant.findByPk(merchantId);
      const sectionId = parseDigitalSectionIdFromCategory(merchant?.category);
      await setUserState(userId, { action: 'edit_digital_product_name', merchantId, sectionId, step: 'nameEn' });
      await bot.sendMessage(userId, await getText(userId, 'askEditDigitalProductNameEn'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const editDigitalProductPriceMatch = data.match(/^admin_edit_digital_product_price_(\d+)$/);
    if (editDigitalProductPriceMatch && isAdmin(userId)) {
      const merchantId = parseInt(editDigitalProductPriceMatch[1], 10);
      const merchant = await Merchant.findByPk(merchantId);
      const sectionId = parseDigitalSectionIdFromCategory(merchant?.category);
      await setUserState(userId, { action: 'edit_digital_product_price', merchantId, sectionId });
      await bot.sendMessage(userId, await getText(userId, 'askEditDigitalProductPrice'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const editDigitalProductDescriptionMatch = data.match(/^admin_edit_digital_product_description_(\d+)$/);
    if (editDigitalProductDescriptionMatch && isAdmin(userId)) {
      const merchantId = parseInt(editDigitalProductDescriptionMatch[1], 10);
      const merchant = await Merchant.findByPk(merchantId);
      const sectionId = parseDigitalSectionIdFromCategory(merchant?.category);
      await setUserState(userId, { action: 'edit_digital_product_description', merchantId, sectionId });
      await bot.sendMessage(userId, await getText(userId, 'askEditDigitalProductDescription'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const deleteDigitalProductMatch = data.match(/^admin_delete_digital_product_(\d+)$/);
    if (deleteDigitalProductMatch && isAdmin(userId)) {
      const merchantId = parseInt(deleteDigitalProductMatch[1], 10);
      await bot.sendMessage(userId, await getText(userId, 'confirmDeleteDigitalProduct'), {
        reply_markup: {
          inline_keyboard: [
            [{ text: await getText(userId, 'yes'), callback_data: `admin_confirm_delete_digital_product_${merchantId}` }],
            [{ text: await getText(userId, 'no'), callback_data: `admin_digital_product_${merchantId}` }]
          ]
        }
      });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const confirmDeleteDigitalProductMatch = data.match(/^admin_confirm_delete_digital_product_(\d+)$/);
    if (confirmDeleteDigitalProductMatch && isAdmin(userId)) {
      const merchantId = parseInt(confirmDeleteDigitalProductMatch[1], 10);
      const merchant = await Merchant.findByPk(merchantId);
      const sectionId = parseDigitalSectionIdFromCategory(merchant?.category);
      await deleteDigitalProductAndStock(merchantId);
      await bot.sendMessage(userId, await getText(userId, 'digitalProductDeleted'));
      if (sectionId) {
        await showDigitalSectionAdmin(userId, sectionId);
      } else {
        await showDigitalSubscriptionsAdmin(userId);
      }
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const viewDigitalProductStockMatch = data.match(/^admin_view_digital_product_stock_(\d+)$/);
    if (viewDigitalProductStockMatch && isAdmin(userId)) {
      const merchantId = parseInt(viewDigitalProductStockMatch[1], 10);
      await sendDigitalProductStockPreview(userId, merchantId);
      await showDigitalProductAdmin(userId, merchantId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const searchDeleteDigitalProductStockMatch = data.match(/^admin_search_delete_digital_product_stock_(\d+)$/);
    if (searchDeleteDigitalProductStockMatch && isAdmin(userId)) {
      const merchantId = parseInt(searchDeleteDigitalProductStockMatch[1], 10);
      await setUserState(userId, { action: 'delete_digital_product_stock_by_input', merchantId, returnTo: 'digital_product_admin' });
      await bot.sendMessage(userId, await getText(userId, 'enterSearchDeleteDigitalProductStock'), {
        reply_markup: await getBackAndCancelReplyMarkup(userId, `admin_digital_product_${merchantId}`)
      });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const searchDigitalProductDuplicatesMatch = data.match(/^admin_search_digital_product_duplicates_(\d+)$/);
    if (searchDigitalProductDuplicatesMatch && isAdmin(userId)) {
      const merchantId = parseInt(searchDigitalProductDuplicatesMatch[1], 10);
      const groups = await getMerchantDuplicateGroups(merchantId);
      if (!groups.length) {
        await bot.sendMessage(userId, await getText(userId, 'digitalDuplicatesNone'));
      } else {
        const details = await formatMerchantDuplicateGroups(userId, groups);
        await bot.sendMessage(userId, await getText(userId, 'digitalDuplicatesFound', {
          count: groups.length,
          details
        }));
      }
      await showDigitalProductAdmin(userId, merchantId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const deleteDigitalProductDuplicatesMatch = data.match(/^admin_delete_digital_product_duplicates_(\d+)$/);
    if (deleteDigitalProductDuplicatesMatch && isAdmin(userId)) {
      const merchantId = parseInt(deleteDigitalProductDuplicatesMatch[1], 10);
      const result = await deleteMerchantDuplicateRows(merchantId);
      if (result.count === 0 && result.locked === 0) {
        await bot.sendMessage(userId, await getText(userId, 'digitalDuplicatesNone'));
      } else {
        const skippedLine = result.locked > 0
          ? await getText(userId, 'duplicateSkippedLocked', { count: result.locked })
          : '-';
        await bot.sendMessage(userId, await getText(userId, 'digitalDuplicatesDeleted', {
          count: result.count,
          skippedLine
        }));
      }
      await showDigitalProductAdmin(userId, merchantId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('digital_section_')) {
      const sectionId = parseInt(data.split('_')[2], 10);
      await showDigitalSectionForUser(userId, sectionId);
      await cleanupPressedMessage();
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('digital_product_')) {
      const merchantId = parseInt(data.split('_')[2], 10);
      await showDigitalProductDetails(userId, merchantId);
      await cleanupPressedMessage();
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('digital_buy_')) {
      const merchantId = parseInt(data.split('_')[2], 10);
      const merchant = await Merchant.findByPk(merchantId);
      const available = await getMerchantAvailableStock(merchantId);

      if (!merchant || !available) {
        await bot.sendMessage(userId, await getText(userId, 'noCodes'));
        await sendMainMenu(userId);
        await cleanupPressedMessage();
        await bot.answerCallbackQuery(query.id);
        return;
      }

      const currentState = safeParseState((await User.findByPk(userId)).state);
      const discountCode = currentState?.discountCode || null;
      await setUserState(userId, { action: 'buy', merchantId, discountCode });
      await bot.sendMessage(
        userId,
        `${await getText(userId, 'productQuantityPrompt')}
${await getText(userId, 'remainingStockLine', { stock: available })}
${await getText(userId, 'itemPriceLine', { price: formatUsdPrice(merchant.price) })}
${await getCurrentBalanceLineText(userId)}`,
        {
          reply_markup: await getBackAndCancelReplyMarkup(userId, `digital_product_${merchant.id}`)
        }
      );
      await cleanupPressedMessage();
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'chatgpt_code') {
      await showChatGptPurchaseInfo(userId);
      await cleanupPressedMessage();
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'chatgpt_buy_accept') {
      await setUserState(userId, { action: 'chatgpt_buy_quantity' });
      await bot.sendMessage(userId, await getText(userId, 'askQuantity'), {
        reply_markup: await getBackAndCancelReplyMarkup(userId, 'chatgpt_code')
      });
      await cleanupPressedMessage();
      await bot.answerCallbackQuery(query.id);
      return;
    }

    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    console.error('Callback error:', err);
    await bot.answerCallbackQuery(query.id, { text: 'Error occurred' }).catch(() => {});
  }
});

bot.on('channel_post', async msg => {
  try {
    await cachePrivateChannelPostMessage(msg);
    await cacheReferralCodesChannelPostMessage(msg);
  } catch (err) {
    console.error('channel_post cache error:', err);
  }
});

bot.on('edited_channel_post', async msg => {
  try {
    await cachePrivateChannelPostMessage(msg);
    await cacheReferralCodesChannelPostMessage(msg);
  } catch (err) {
    console.error('edited_channel_post cache error:', err);
  }
});

bot.on('message', async msg => {
  const userId = msg.chat.id;
  const text = msg.text;
  const photo = msg.photo;
  const video = msg.video;

  try {
    const user = await User.findByPk(userId);
    if (!user) return;
    if (!isAdmin(userId) && !(await getBotEnabled()) && !(await isUserAllowedWhenBotStopped(userId))) {
      await bot.sendMessage(userId, await getText(userId, 'botPausedMessage'));
      return;
    }
    let state = safeParseState(user.state);
    scheduleAutoDeleteIncomingMessage(msg, state, isAdmin(userId));

    if (msg.forward_from_chat && msg.forward_from_chat.type === 'channel') {
      const forwardedPayload = {
        chat: { 
          id: msg.forward_from_chat.id,
          title: msg.forward_from_chat.title,
          username: msg.forward_from_chat.username
        },
        message_id: msg.forward_from_message_id || msg.message_id,
        text: msg.text || '',
        caption: msg.caption || ''
      };

      const privateCfg = await getPrivateCodesChannelConfig();
      if (!privateCfg.chatId || String(msg.forward_from_chat.id) === String(privateCfg.chatId)) {
        await cachePrivateChannelPostMessage(forwardedPayload);
      }

      const referralCfg = await getReferralCodesChannelConfig();
      if (!referralCfg.chatId || String(msg.forward_from_chat.id) === String(referralCfg.chatId)) {
        await cacheReferralCodesChannelPostMessage(forwardedPayload);
      }
    }

    const verificationRequired = await isVerificationRequiredForUser(userId);

    if (verificationRequired && !user.verified) {
      const captcha = await Captcha.findByPk(userId);
      if (captcha) {
        const ok = await verifyCaptcha(userId, text || '');
        if (ok) {
          await handleVerificationSuccess(userId);
        } else if (text) {
          await bot.sendMessage(userId, await getText(userId, 'captchaWrong'));
          const challenge = await createCaptcha(userId);
          await bot.sendMessage(userId, await getText(userId, 'captchaChallenge', { challenge }));
        }
        return;
      }

      const isMember = await checkChannelMembership(userId);
      if (!isMember) {
        await sendJoinChannelMessage(userId);
        return;
      }

      const challenge = await createCaptcha(userId);
      await bot.sendMessage(userId, await getText(userId, 'captchaChallenge', { challenge }));
      return;
    }

    if (verificationRequired) {
      const stillMember = await checkChannelMembership(userId);
      if (!stillMember) {
        if (user.verified) {
          user.verified = false;
          await user.save();
        }
        await Captcha.destroy({ where: { userId } });
        await sendJoinChannelMessage(userId);
        return;
      }
    }

    if (state && isAdmin(userId)) {
      if (state.action === 'set_private_codes_channel') {
        let resolved = null;
        const existingCfg = await getPrivateCodesChannelConfig();

        if (msg.forward_from_chat && msg.forward_from_chat.type === 'channel') {
          const forwardedChat = msg.forward_from_chat;
          resolved = {
            ok: true,
            inviteOnly: false,
            chatId: String(forwardedChat.id),
            username: forwardedChat.username ? `@${forwardedChat.username}` : '',
            title: forwardedChat.title || forwardedChat.username || String(forwardedChat.id),
            link: existingCfg.link || (forwardedChat.username ? `https://t.me/${forwardedChat.username}` : ''),
            type: 'channel'
          };
        } else {
          resolved = await resolvePrivateCodesChannelTarget(String(text || '').trim());
        }

        if (!resolved || !resolved.ok) {
          await bot.sendMessage(userId, `❌ ${resolved?.message || 'تعذر حفظ القناة الخاصة.'}`);
          return;
        }
        if (resolved.type && resolved.type !== 'channel') {
          await bot.sendMessage(userId, '❌ الهدف يجب أن يكون قناة تيليجرام وليس مجموعة.');
          return;
        }

        await savePrivateCodesChannelConfig({
          enabled: true,
          chatId: resolved.chatId || existingCfg.chatId || '',
          link: resolved.link || existingCfg.link || '',
          title: resolved.title || existingCfg.title || '',
          username: resolved.username || existingCfg.username || ''
        });
        await clearUserState(userId);
        await bot.sendMessage(
          userId,
          resolved.inviteOnly
            ? (resolved.message || '✅ تم حفظ رابط الدعوة الخاص.')
            : '✅ تم حفظ القناة الخاصة وتفعيلها.'
        );
        await showPrivateCodesChannelAdmin(userId);
        return;
      }

      if (state.action === 'set_referral_codes_channel') {
        let resolved = null;
        const existingCfg = await getReferralCodesChannelConfig();
        let forwardedPayload = null;

        if (msg.forward_from_chat && msg.forward_from_chat.type === 'channel') {
          const forwardedChat = msg.forward_from_chat;
          resolved = {
            ok: true,
            inviteOnly: false,
            chatId: String(forwardedChat.id),
            username: forwardedChat.username ? `@${forwardedChat.username}` : '',
            title: forwardedChat.title || forwardedChat.username || String(forwardedChat.id),
            link: existingCfg.link || (forwardedChat.username ? `https://t.me/${forwardedChat.username}` : ''),
            type: 'channel'
          };
          forwardedPayload = {
            chat: {
              id: forwardedChat.id,
              title: forwardedChat.title,
              username: forwardedChat.username
            },
            message_id: msg.forward_from_message_id || msg.message_id,
            text: msg.text || '',
            caption: msg.caption || ''
          };
        } else {
          resolved = await resolvePrivateCodesChannelTarget(String(text || '').trim());
        }

        if (!resolved || !resolved.ok) {
          await bot.sendMessage(userId, `❌ ${resolved?.message || 'تعذر حفظ قناة الكودات.'}`);
          return;
        }
        if (resolved.type && resolved.type !== 'channel') {
          await bot.sendMessage(userId, '❌ الهدف يجب أن يكون قناة تيليجرام وليس مجموعة.');
          return;
        }

        await saveReferralCodesChannelConfig({
          enabled: true,
          chatId: resolved.chatId || existingCfg.chatId || '',
          link: resolved.link || existingCfg.link || '',
          title: resolved.title || existingCfg.title || '',
          username: resolved.username || existingCfg.username || ''
        });

        let importedHint = '';
        if (forwardedPayload) {
          const cached = await cacheReferralCodesChannelPostMessage(forwardedPayload);
          if (cached) {
            const extractedNow = extractChatGptUpCodes((forwardedPayload.text || forwardedPayload.caption || ''));
            importedHint = `

✅ تم أيضًا حفظ المنشور الذي قمت بإعادة توجيهه للقناة، وعدد الأكواد التي تم التقاطها منه: ${extractedNow.length}`;
          } else {
            importedHint = `

ℹ️ تم حفظ القناة. إذا أردت استيراد الأكواد القديمة، أعد توجيه منشورات القناة التي تحتوي على الأكواد إلى البوت مرة واحدة ثم اضغط زر الاستيراد.`;
          }
        }

        await clearUserState(userId);
        await bot.sendMessage(
          userId,
          (resolved.inviteOnly
            ? (resolved.message || '✅ تم حفظ رابط دعوة قناة الكودات.')
            : '✅ تم حفظ قناة الكودات وتفعيلها.') + importedHint
        );
        await showReferralCodesChannelAdmin(userId);
        return;
      }

      if (state.action === 'set_channel_link') {
        let resolved = null;

        if (msg.forward_from_chat && msg.forward_from_chat.type === 'channel') {
          const forwardedChat = msg.forward_from_chat;
          resolved = {
            ok: true,
            chatId: String(forwardedChat.id),
            username: forwardedChat.username ? `@${forwardedChat.username}` : null,
            title: forwardedChat.title || forwardedChat.username || String(forwardedChat.id),
            link: forwardedChat.username ? `https://t.me/${forwardedChat.username}` : null,
            type: 'channel'
          };
        } else {
          const rawInput = String(text || '').trim();
          resolved = await resolveChannelTarget(rawInput);
        }

        if (!resolved || !resolved.ok) {
          await bot.sendMessage(userId, `❌ ${resolved?.message || 'Invalid channel value.'}`);
          return;
        }

        if (resolved.type && resolved.type !== 'channel') {
          await bot.sendMessage(userId, '❌ The target must be a Telegram channel, not a group.');
          return;
        }

        const config = await getChannelConfig();
        config.link = resolved.link || config.link || null;
        config.chatId = resolved.chatId;
        config.username = resolved.username;
        config.title = resolved.title;
        await config.save();

        await bot.sendMessage(userId, await getText(userId, 'channelLinkSet'));
        await setUserState(userId, null);
        await showChannelConfigAdmin(userId);
        return;
      }

      if (state.action === 'rename_button_pick_key') {
        const incomingLabel = String(text || '').trim();
        if (!incomingLabel) {
          await bot.sendMessage(userId, await getText(userId, 'enterButtonNameToChange'), {
            reply_markup: await getBackAndCancelReplyMarkup(userId, 'admin')
          });
          return;
        }

        const matchedKey = await findButtonKeyByLabel(incomingLabel);
        if (!matchedKey) {
          await bot.sendMessage(userId, await getText(userId, 'buttonNameNotFound'), {
            reply_markup: await getBackAndCancelReplyMarkup(userId, 'admin')
          });
          return;
        }

        await setUserState(userId, { action: 'rename_button_set_ar', targetKey: matchedKey });
        await bot.sendMessage(userId, await getText(userId, 'enterNewButtonNameAr'), {
          reply_markup: await getBackAndCancelReplyMarkup(userId, 'admin')
        });
        return;
      }

      if (state.action === 'rename_button_set_ar') {
        const newArabicName = stripCustomEmojiPlaceholdersFromMessage(msg);
        if (!newArabicName) {
          await bot.sendMessage(userId, await getText(userId, 'enterNewButtonNameAr'), {
            reply_markup: await getBackAndCancelReplyMarkup(userId, 'admin')
          });
          return;
        }

        const customEmojiIds = extractCustomEmojiIdsFromMessage(msg);
        await setUserState(userId, {
          action: 'rename_button_set_en',
          targetKey: state.targetKey,
          newArabicName,
          arabicCustomEmojiId: customEmojiIds[0] || ''
        });
        await bot.sendMessage(userId, await getText(userId, 'enterNewButtonNameEn'), {
          reply_markup: await getBackAndCancelReplyMarkup(userId, 'admin')
        });
        return;
      }

      if (state.action === 'rename_button_set_en') {
        const newEnglishName = stripCustomEmojiPlaceholdersFromMessage(msg);
        if (!newEnglishName) {
          await bot.sendMessage(userId, await getText(userId, 'enterNewButtonNameEn'), {
            reply_markup: await getBackAndCancelReplyMarkup(userId, 'admin')
          });
          return;
        }

        const customEmojiIds = extractCustomEmojiIdsFromMessage(msg);
        const englishCustomEmojiId = customEmojiIds[0] || '';

        const resolvedTextKey = resolveButtonTextKey(state.targetKey);
        await Setting.upsert({ key: resolvedTextKey, lang: 'ar', value: state.newArabicName || await getTextByLang(state.targetKey, 'ar') });
        await Setting.upsert({ key: resolvedTextKey, lang: 'en', value: newEnglishName });

        if (state.arabicCustomEmojiId || englishCustomEmojiId) {
          const fallbackEmojiId = englishCustomEmojiId || state.arabicCustomEmojiId || '';
          await setButtonCustomEmojiId(state.targetKey, 'ar', state.arabicCustomEmojiId || fallbackEmojiId);
          await setButtonCustomEmojiId(state.targetKey, 'en', englishCustomEmojiId || state.arabicCustomEmojiId || fallbackEmojiId);
        }

        await clearUserState(userId);
        await bot.sendMessage(userId, await getText(userId, 'buttonNameUpdated'));
        await showAdminPanel(userId);
        return;
      }
    }

    if (isAdmin(userId) && !state) {
      const customEmojiIds = extractCustomEmojiIdsFromMessage(msg);
      if (customEmojiIds.length) {
        const lines = customEmojiIds.map((emojiId, index) => `${index + 1}. <code>${escapeHtml(emojiId)}</code>`).join('\n');
        await bot.sendMessage(userId, `${await getText(userId, 'customEmojiIdsTitle')}\n\n${lines}`, { parse_mode: 'HTML' });
        return;
      }
    }


    if (state?.action === 'support_reply' && isAdmin(userId)) {
      const targetUserId = state.targetUserId;
      const replyMsg = text || '';
      let fileId = null;
      if (photo) fileId = photo[photo.length - 1].file_id;
      else if (video) fileId = video.file_id;

      const supportReplyText = `${await getText(targetUserId, 'replyMessage')}\n\n${replyMsg}`;
      if (fileId) {
        if (photo) await bot.sendPhoto(targetUserId, fileId, { caption: supportReplyText, reply_markup: await getSupportUserCloseReplyMarkup(targetUserId) });
        else await bot.sendVideo(targetUserId, fileId, { caption: supportReplyText, reply_markup: await getSupportUserCloseReplyMarkup(targetUserId) });
      } else {
        await bot.sendMessage(targetUserId, supportReplyText, { reply_markup: await getSupportUserCloseReplyMarkup(targetUserId) });
      }

      await openSupportThread(targetUserId, 'admin_reply');
      await bot.sendMessage(userId, await getText(userId, 'supportUserMessageForwarded'));
      await clearUserState(userId);
      return;
    }

    if (state && isAdmin(userId)) {
      if (state.action === 'add_bot' && state.step === 'token') {
        try {
          const testBot = new TelegramBot(text, { polling: false });
          const me = await testBot.getMe();
          await BotService.create({ token: text, name: me.username, allowedActions: [] });
          await bot.sendMessage(userId, await getText(userId, 'botAdded'));
          await showBotsList(userId);
        } catch {
          await bot.sendMessage(userId, '❌ Invalid token');
        }
        await clearUserState(userId);
        return;
      }

      if (state.action === 'set_bot_owner') {
        const ownerId = parseInt(text, 10);
        if (Number.isNaN(ownerId)) {
          await bot.sendMessage(userId, '❌ Invalid user ID');
        } else {
          const botService = await BotService.findByPk(state.botId);
          if (botService) {
            botService.ownerId = ownerId;
            botService.allowedActions = ['full'];
            await botService.save();
            await bot.sendMessage(userId, `✅ Granted full permissions to user ${ownerId} for bot ${botService.name}`);
          } else {
            await bot.sendMessage(userId, 'Bot not found');
          }
        }
        await clearUserState(userId);
        return;
      }

      if (state.action === 'add_merchant') {
        if (state.step === 'nameEn') {
          await setUserState(userId, { ...state, nameEn: text, step: 'nameAr' });
          await bot.sendMessage(userId, await getText(userId, 'askMerchantNameAr'));
          return;
        }

        if (state.step === 'nameAr') {
          await setUserState(userId, { ...state, nameAr: text, step: 'price' });
          await bot.sendMessage(userId, await getText(userId, 'askMerchantPrice'));
          return;
        }

        if (state.step === 'price') {
          const price = parseFloat(text);
          if (Number.isNaN(price)) {
            await bot.sendMessage(userId, '❌ Invalid price');
            return;
          }
          await setUserState(userId, { ...state, price, step: 'type' });
          await bot.sendMessage(userId, await getText(userId, 'askMerchantType'), {
            reply_markup: {
              inline_keyboard: [
                [{ text: await getText(userId, 'typeSingle'), callback_data: 'merchant_type_single' }],
                [{ text: await getText(userId, 'typeBulk'), callback_data: 'merchant_type_bulk' }]
              ]
            }
          });
          return;
        }

        if (state.step === 'description') {
          let description = null;
          if (text === '/skip') description = null;
          else if (text) description = { type: 'text', content: text };
          else if (photo) description = { type: 'photo', fileId: photo[photo.length - 1].file_id };
          else if (video) description = { type: 'video', fileId: video.file_id };
          else {
            await bot.sendMessage(userId, 'Please send text, photo, video, or /skip');
            return;
          }

          const merchant = await Merchant.create({
            nameEn: state.nameEn,
            nameAr: state.nameAr,
            price: state.price,
            type: state.selectedType || 'single',
            description
          });

          await bot.sendMessage(userId, await getText(userId, 'merchantCreated', { id: merchant.id }));
          await clearUserState(userId);
          await showAdminPanel(userId);
          return;
        }
      }

      if (state.action === 'add_digital_section') {
        if (state.step === 'nameEn') {
          await setUserState(userId, { ...state, nameEn: text, step: 'nameAr' });
          await bot.sendMessage(userId, await getText(userId, 'askDigitalSectionNameAr'));
          return;
        }

        if (state.step === 'nameAr') {
          const maxSortOrder = await DigitalSection.max('sortOrder');
          const section = await DigitalSection.create({
            nameEn: state.nameEn,
            nameAr: text,
            sortOrder: Number.isFinite(Number(maxSortOrder)) ? Number(maxSortOrder) + 1 : 1,
            isActive: true
          });

          await bot.sendMessage(userId, await getText(userId, 'digitalSectionCreated'));
          await clearUserState(userId);
          await showDigitalSectionAdmin(userId, section.id);
          return;
        }
      }

      if (state.action === 'edit_digital_section_name') {
        const section = await DigitalSection.findByPk(state.sectionId);
        if (!section) {
          await bot.sendMessage(userId, await getText(userId, 'error'));
          await clearUserState(userId);
          return;
        }

        const trimmedText = String(text || '').trim();
        if (!trimmedText) {
          await bot.sendMessage(userId, state.step === 'nameEn'
            ? await getText(userId, 'askEditDigitalSectionNameEn')
            : await getText(userId, 'askEditDigitalSectionNameAr'));
          return;
        }

        if (state.step === 'nameEn') {
          await setUserState(userId, { ...state, nameEn: trimmedText, step: 'nameAr' });
          await bot.sendMessage(userId, await getText(userId, 'askEditDigitalSectionNameAr'));
          return;
        }

        section.nameEn = state.nameEn || section.nameEn;
        section.nameAr = trimmedText;
        await section.save();
        await bot.sendMessage(userId, await getText(userId, 'digitalSectionUpdated'));
        await clearUserState(userId);
        await showDigitalSectionAdmin(userId, section.id);
        return;
      }

      if (state.action === 'edit_digital_product_name') {
        const merchant = await Merchant.findByPk(state.merchantId);
        if (!merchant) {
          await bot.sendMessage(userId, await getText(userId, 'error'));
          await clearUserState(userId);
          return;
        }

        const trimmedText = String(text || '').trim();
        if (!trimmedText) {
          await bot.sendMessage(userId, state.step === 'nameEn'
            ? await getText(userId, 'askEditDigitalProductNameEn')
            : await getText(userId, 'askEditDigitalProductNameAr'));
          return;
        }

        if (state.step === 'nameEn') {
          await setUserState(userId, { ...state, nameEn: trimmedText, step: 'nameAr' });
          await bot.sendMessage(userId, await getText(userId, 'askEditDigitalProductNameAr'));
          return;
        }

        merchant.nameEn = state.nameEn || merchant.nameEn;
        merchant.nameAr = trimmedText;
        await merchant.save();
        await bot.sendMessage(userId, await getText(userId, 'digitalProductNameUpdated'));
        await clearUserState(userId);
        await showDigitalProductAdmin(userId, merchant.id);
        return;
      }

      if (state.action === 'edit_digital_product_price') {
        const merchant = await Merchant.findByPk(state.merchantId);
        if (!merchant) {
          await bot.sendMessage(userId, await getText(userId, 'error'));
          await clearUserState(userId);
          return;
        }

        const price = parseFloat(text);
        if (Number.isNaN(price) || price <= 0) {
          await bot.sendMessage(userId, await getText(userId, 'invalidPrice'));
          return;
        }

        merchant.price = price;
        await merchant.save();
        await bot.sendMessage(userId, await getText(userId, 'digitalProductPriceUpdated'));
        await clearUserState(userId);
        await showDigitalProductAdmin(userId, merchant.id);
        return;
      }

      if (state.action === 'edit_digital_product_description') {
        const merchant = await Merchant.findByPk(state.merchantId);
        if (!merchant) {
          await bot.sendMessage(userId, await getText(userId, 'error'));
          await clearUserState(userId);
          return;
        }

        if (String(text || '').trim() === '/skip') {
          await clearUserState(userId);
          await showDigitalProductAdmin(userId, merchant.id);
          return;
        }

        let description = null;
        if (String(text || '').trim() === '/empty') description = null;
        else if (text) description = { type: 'text', content: text };
        else if (photo) description = { type: 'photo', fileId: photo[photo.length - 1].file_id };
        else if (video) description = { type: 'video', fileId: video.file_id };
        else {
          await bot.sendMessage(userId, await getText(userId, 'sendValidDescription'));
          return;
        }

        merchant.description = description;
        await merchant.save();
        await bot.sendMessage(userId, await getText(userId, 'digitalProductDescriptionUpdated'));
        await clearUserState(userId);
        await showDigitalProductAdmin(userId, merchant.id);
        return;
      }

      if (state.action === 'add_digital_product') {
        if (state.step === 'nameEn') {
          await setUserState(userId, { ...state, nameEn: text, step: 'nameAr' });
          await bot.sendMessage(userId, await getText(userId, 'askDigitalProductNameAr'));
          return;
        }

        if (state.step === 'nameAr') {
          await setUserState(userId, { ...state, nameAr: text, step: 'price' });
          await bot.sendMessage(userId, await getText(userId, 'askDigitalProductPrice'));
          return;
        }

        if (state.step === 'price') {
          const price = parseFloat(text);
          if (Number.isNaN(price) || price <= 0) {
            await bot.sendMessage(userId, await getText(userId, 'invalidPrice'));
            return;
          }
          await setUserState(userId, { ...state, price, step: 'type' });
          await bot.sendMessage(userId, await getText(userId, 'askMerchantType'), {
            reply_markup: {
              inline_keyboard: [
                [{ text: await getText(userId, 'typeSingle'), callback_data: 'merchant_type_single' }],
                [{ text: await getText(userId, 'typeBulk'), callback_data: 'merchant_type_bulk' }]
              ]
            }
          });
          return;
        }

        if (state.step === 'description') {
          let description = null;
          if (text === '/skip') description = null;
          else if (text) description = { type: 'text', content: text };
          else if (photo) description = { type: 'photo', fileId: photo[photo.length - 1].file_id };
          else if (video) description = { type: 'video', fileId: video.file_id };
          else {
            await bot.sendMessage(userId, await getText(userId, 'sendValidDescription'));
            return;
          }

          const merchant = await Merchant.create({
            nameEn: state.nameEn,
            nameAr: state.nameAr,
            price: state.price,
            category: getDigitalSectionCategory(state.sectionId),
            type: state.selectedType || 'bulk',
            description
          });

          await bot.sendMessage(userId, await getText(userId, 'digitalProductCreated', { id: merchant.id }));
          await clearUserState(userId);
          await showDigitalSectionAdmin(userId, state.sectionId);
          return;
        }
      }

      if (state.action === 'set_chatgpt_price') {
        const price = parseFloat(text);
        if (Number.isNaN(price) || price <= 0) {
          await bot.sendMessage(userId, '❌ Invalid price');
          return;
        }
        const merchant = await getOrCreateChatGptMerchant();
        merchant.price = price;
        await merchant.save();
        await bot.sendMessage(userId, await getText(userId, 'chatgptPriceUpdated', { price }));
        await clearUserState(userId);
        await showAdminPanel(userId);
        return;
      }

      if (state.action === 'set_price') {
        const price = parseFloat(text);
        if (Number.isNaN(price)) {
          await bot.sendMessage(userId, '❌ Invalid price');
          return;
        }
        await Merchant.update({ price }, { where: { id: state.merchantId } });
        await bot.sendMessage(userId, await getText(userId, 'priceUpdated'));
        await clearUserState(userId);
        await showAdminPanel(userId);
        return;
      }

      if (state.action === 'add_codes') {
        const merchant = await Merchant.findByPk(state.merchantId);
        if (!merchant) {
          await bot.sendMessage(userId, 'Merchant not found');
          await clearUserState(userId);
          return;
        }

        const saveResult = await addMerchantStockEntriesWithDedup(merchant, text || '');
        if (!saveResult.success) {
          if (saveResult.reason === 'pair_mismatch') {
            await bot.sendMessage(userId, await getText(userId, 'invalidBulkStockPairs'), { reply_markup: await getDigitalStockInputReplyMarkup(userId, merchant) });
          } else {
            await bot.sendMessage(userId, await getText(userId, 'emptyStockInput'), { reply_markup: await getDigitalStockInputReplyMarkup(userId, merchant) });
          }
          return;
        }

        await bot.sendMessage(userId, await getText(userId, 'codesAddedDetailed', {
          added: saveResult.added,
          duplicates: saveResult.duplicates
        }), { reply_markup: await getDigitalStockInputReplyMarkup(userId, merchant) });
        const returnTo = state.returnTo || '';
        const merchantId = state.merchantId;
        const shouldBroadcastDigitalStock = isDigitalSectionCategory(merchant.category) && saveResult.added > 0;
        await clearUserState(userId);

        if (returnTo === 'digital_product_admin') {
          await showDigitalProductAdmin(userId, merchantId);
        } else {
          await showAdminPanel(userId);
        }

        if (shouldBroadcastDigitalStock) {
          broadcastDigitalStockAdded(merchant, saveResult.added).catch(err => {
            console.error('digital stock broadcast error:', err);
          });
        }
        return;
      }

      if (state.action === 'delete_digital_product_stock_by_input') {
        const merchant = await Merchant.findByPk(state.merchantId);
        if (!merchant) {
          await bot.sendMessage(userId, await getText(userId, 'error'));
          await clearUserState(userId);
          return;
        }

        const deleteResult = await deleteMerchantStockEntriesByInput(merchant, text || '');
        if (!deleteResult.success) {
          await bot.sendMessage(userId, deleteResult.reason === 'pair_mismatch'
            ? await getText(userId, 'invalidBulkStockPairs')
            : await getText(userId, 'enterSearchDeleteDigitalProductStock'));
          return;
        }

        await bot.sendMessage(userId, await getText(userId, 'digitalProductStockSearchDeleteResult', {
          deleted: deleteResult.deleted,
          missing: deleteResult.missing,
          locked: deleteResult.locked,
          details: deleteResult.details
        }));
        await clearUserState(userId);
        await showDigitalProductAdmin(userId, merchant.id);
        return;
      }

      if (state.action === 'bulk_account_entry') {
        const merchant = await Merchant.findByPk(state.merchantId);
        if (!merchant) {
          await bot.sendMessage(userId, await getText(userId, 'error'));
          await clearUserState(userId);
          return;
        }

        const trimmed = String(text || '').trim();
        const draft = state.draft || {};

        if (state.step === 'email') {
          if (!trimmed) {
            await bot.sendMessage(userId, await getText(userId, 'enterBulkEmail'));
            return;
          }
          await setUserState(userId, { ...state, step: 'password', draft: { ...draft, email: trimmed } });
          await bot.sendMessage(userId, await getText(userId, 'enterBulkPassword'));
          return;
        }

        if (state.step === 'password') {
          if (!trimmed) {
            await bot.sendMessage(userId, await getText(userId, 'enterBulkPassword'));
            return;
          }
          await setUserState(userId, { ...state, step: 'verify', draft: { ...draft, password: trimmed } });
          await bot.sendMessage(userId, await getText(userId, 'enterBulkVerify'));
          return;
        }

        if (state.step === 'verify') {
          await setUserState(userId, { ...state, step: 'extra', draft: { ...draft, verify: trimmed === '/skip' ? '' : trimmed } });
          await bot.sendMessage(userId, await getText(userId, 'enterBulkExtra'));
          return;
        }

        if (state.step === 'extra') {
          const saveResult = await addSingleBulkAccountStock(merchant, {
            email: draft.email,
            password: draft.password,
            verify: draft.verify || '',
            note: trimmed === '/skip' ? '' : trimmed
          });

          if (!saveResult.success) {
            await bot.sendMessage(userId, await getText(userId, 'emptyStockInput'));
            return;
          }

          if (saveResult.added > 0 && isDigitalSectionCategory(merchant.category)) {
            broadcastDigitalStockAdded(merchant, saveResult.added).catch(err => console.error('digital stock broadcast error:', err));
          }

          await setUserState(userId, { action: 'add_codes', merchantId: merchant.id, returnTo: 'digital_product_admin' });
          await bot.sendMessage(userId, await getText(userId, saveResult.duplicate ? 'bulkAccountDuplicate' : 'bulkAccountSaved'), {
            reply_markup: {
              inline_keyboard: [
                [{ text: await getText(userId, 'addAnotherAccount'), callback_data: `admin_bulk_account_again_${merchant.id}` }],
                [{ text: await getText(userId, 'done'), callback_data: `admin_bulk_account_done_${merchant.id}` }]
              ]
            }
          });
          return;
        }
      }

      if (state.action === 'edit_merchant') {
        const merchant = await Merchant.findByPk(state.merchantId);
        if (!merchant) {
          await bot.sendMessage(userId, 'Merchant not found');
          await clearUserState(userId);
          return;
        }

        if (state.step === 'nameEn') {
          if (text !== '/skip') merchant.nameEn = text;
          await merchant.save();
          await setUserState(userId, { ...state, step: 'nameAr' });
          await bot.sendMessage(userId, 'Send new Arabic name (or /skip):');
          return;
        }

        if (state.step === 'nameAr') {
          if (text !== '/skip') merchant.nameAr = text;
          await merchant.save();
          await setUserState(userId, { ...state, step: 'price' });
          await bot.sendMessage(userId, 'Send new price (or /skip):');
          return;
        }

        if (state.step === 'price') {
          if (text !== '/skip') {
            const price = parseFloat(text);
            if (!Number.isNaN(price)) merchant.price = price;
          }
          await merchant.save();
          await bot.sendMessage(userId, 'Merchant updated successfully.');
          await clearUserState(userId);
          await showAdminPanel(userId);
          return;
        }
      }

      if (state.action === 'edit_category') {
        const merchant = await Merchant.findByPk(state.merchantId);
        if (merchant) {
          merchant.category = text;
          await merchant.save();
          await bot.sendMessage(userId, await getText(userId, 'categoryUpdated'));
        }
        await clearUserState(userId);
        await showAdminPanel(userId);
        return;
      }

      if (state.action === 'add_payment_method') {
        if (state.step === 'nameEn') {
          await setUserState(userId, { ...state, nameEn: text, step: 'nameAr' });
          await bot.sendMessage(userId, 'Send name in Arabic:');
          return;
        }
        if (state.step === 'nameAr') {
          await setUserState(userId, { ...state, nameAr: text, step: 'details' });
          await bot.sendMessage(userId, 'Send payment details (e.g., wallet address):');
          return;
        }
        if (state.step === 'details') {
          await setUserState(userId, { ...state, details: text, step: 'type' });
          await bot.sendMessage(userId, 'Send type (manual/auto):');
          return;
        }
        if (state.step === 'type') {
          const type = String(text || '').toLowerCase();
          if (!['manual', 'auto'].includes(type)) {
            await bot.sendMessage(userId, 'Type must be manual or auto');
            return;
          }
          await PaymentMethod.create({
            nameEn: state.nameEn,
            nameAr: state.nameAr,
            details: state.details,
            type,
            config: {},
            isActive: true,
            minDeposit: 1,
            maxDeposit: 10000
          });
          await bot.sendMessage(userId, 'Payment method added successfully.');
          await clearUserState(userId);
          await showAdminPanel(userId);
          return;
        }
      }

      if (state.action === 'set_limits') {
        if (state.step === 'min') {
          const min = parseFloat(text);
          if (Number.isNaN(min)) {
            await bot.sendMessage(userId, 'Invalid number');
            return;
          }
          await setUserState(userId, { ...state, min, step: 'max' });
          await bot.sendMessage(userId, 'Enter maximum deposit amount (USD):');
          return;
        }
        if (state.step === 'max') {
          const max = parseFloat(text);
          if (Number.isNaN(max)) {
            await bot.sendMessage(userId, 'Invalid number');
            return;
          }
          const method = await PaymentMethod.findByPk(state.methodId);
          if (method) {
            method.minDeposit = state.min;
            method.maxDeposit = max;
            await method.save();
            await bot.sendMessage(userId, `Limits set: Min ${state.min} USD, Max ${max} USD.`);
          } else {
            await bot.sendMessage(userId, 'Method not found');
          }
          await clearUserState(userId);
          await showAdminPanel(userId);
          return;
        }
      }

      if (state.action === 'broadcast_announcement') {
        const messageText = String(text || '').trim();
        if (!messageText) {
          await bot.sendMessage(userId, await getText(userId, 'enterAnnouncementText'));
          return;
        }

        const stats = await broadcastAnnouncement(messageText);
        await bot.sendMessage(userId, await getText(userId, 'announcementSent', stats));
        await clearUserState(userId);
        await showAdminPanel(userId);
        return;
      }

      if (state.action === 'edit_code_delivery_message') {
        const targetLang = state.targetLang === 'ar' ? 'ar' : 'en';
        const value = String(text || '').trim() === '/empty' ? '' : String(text || '');
        await Setting.upsert({ key: 'code_delivery_message', lang: targetLang, value });
        await bot.sendMessage(userId, await getText(userId, 'codeDeliveryMessageUpdated'));
        await clearUserState(userId);
        await showAdminPanel(userId);
        return;
      }

      if (state.action === 'edit_referral_milestones') {
        const raw = String(text || '').trim();
        const parsedPairs = raw.split(',').map(part => part.trim()).filter(Boolean);
        const normalized = [];
        for (const pair of parsedPairs) {
          const [countStr, bonusStr] = pair.split(':').map(v => String(v || '').trim());
          const count = parseInt(countStr, 10);
          const bonus = parseInt(bonusStr, 10);
          if (!Number.isInteger(count) || count <= 0 || !Number.isInteger(bonus) || bonus <= 0) {
            await bot.sendMessage(userId, await getText(userId, 'enterReferralMilestones'));
            return;
          }
          normalized.push(`${count}:${bonus}`);
        }
        if (!normalized.length) {
          await bot.sendMessage(userId, await getText(userId, 'enterReferralMilestones'));
          return;
        }
        await Setting.upsert({ key: 'referral_milestones', lang: 'global', value: normalized.join(',') });
        await bot.sendMessage(userId, await getText(userId, 'referralMilestonesUpdated'));
        await clearUserState(userId);
        await showReferralSettingsAdmin(userId);
        return;
      }

      if (state.action === 'set_bulk_discount_threshold') {
        const threshold = parseInt(text, 10);
        if (!Number.isInteger(threshold) || threshold <= 0) {
          await bot.sendMessage(userId, await getText(userId, 'enterBulkDiscountThreshold'));
          return;
        }
        await Setting.upsert({ key: 'bulk_discount_threshold', lang: 'global', value: String(threshold) });
        await bot.sendMessage(userId, await getText(userId, 'bulkDiscountSettingsUpdated'));
        await clearUserState(userId);
        await showQuantityDiscountSettingsAdmin(userId);
        return;
      }

      if (state.action === 'set_bulk_discount_price') {
        const price = parseFloat(text);
        if (!Number.isFinite(price) || price <= 0) {
          await bot.sendMessage(userId, await getText(userId, 'enterBulkDiscountPrice'));
          return;
        }
        await Setting.upsert({ key: 'bulk_discount_price', lang: 'global', value: String(price) });
        await bot.sendMessage(userId, await getText(userId, 'bulkDiscountSettingsUpdated'));
        await clearUserState(userId);
        await showQuantityDiscountSettingsAdmin(userId);
        return;
      }

      if (state.action === 'set_referral_percent') {
        const percent = parseFloat(text);
        if (Number.isNaN(percent)) {
          await bot.sendMessage(userId, 'Invalid percentage');
          return;
        }
        await Setting.upsert({ key: 'referral_percent', lang: 'global', value: String(percent) });
        process.env.REFERRAL_PERCENT = String(percent);
        await bot.sendMessage(userId, await getText(userId, 'referralPercentUpdated', { percent }));
        await clearUserState(userId);
        await showReferralSettingsAdmin(userId);
        return;
      }

      if (state.action === 'set_redeem_points') {
        const points = parseInt(text, 10);
        if (!Number.isInteger(points) || points <= 0) {
          await bot.sendMessage(userId, 'Invalid points number');
          return;
        }
        await Setting.upsert({ key: 'referral_redeem_points', lang: 'global', value: String(points) });
        await bot.sendMessage(userId, await getText(userId, 'redeemPointsUpdated', { points }));
        await clearUserState(userId);
        await showReferralSettingsAdmin(userId);
        return;
      }

      if (state.action === 'set_free_code_days') {
        const days = parseInt(text, 10);
        if (!Number.isInteger(days) || days <= 0) {
          await bot.sendMessage(userId, await getText(userId, 'enterFreeCodeDays'));
          return;
        }
        await Setting.upsert({ key: 'free_code_cooldown_days', lang: 'global', value: String(days) });
        await bot.sendMessage(userId, await getText(userId, 'freeCodeDaysUpdated', { days }));
        await clearUserState(userId);
        await showReferralSettingsAdmin(userId);
        return;
      }

      if (state.action === 'set_allowed_users') {
        const value = String(text || '').trim() === '/empty'
          ? ''
          : String(text || '')
              .split(/[\s,]+/)
              .map(v => parseInt(v, 10))
              .filter(v => Number.isInteger(v) && v > 0)
              .join(',');
        await Setting.upsert({ key: 'bot_allowed_user_ids', lang: 'global', value });
        await bot.sendMessage(userId, await getText(userId, 'allowedUsersUpdated'));
        await clearUserState(userId);
        await showBotControlAdmin(userId);
        return;
      }

      if (state.action === 'add_referral_stock_codes') {
        const merchant = await getReferralStockMerchant();
        const rawInput = String(text || msg.caption || '');
        let values = extractChatGptUpCodes(rawInput);

        if (!values.length) {
          values = String(rawInput || '')
            .split(/\r?\n|\s+/)
            .map(v => normalizeChatGptUpCode(v))
            .filter(Boolean);
        }

        values = values.filter(Boolean);
        if (!values.length) {
          await bot.sendMessage(userId, await getText(userId, 'enterReferralStockCodes'), {
            reply_markup: getReferralStockInputReplyMarkup()
          });
          return;
        }

        const loadingMsg = await bot.sendMessage(userId, '⏳ جار التحميل...');
        let addedCount = 0;

        try {
          const chunks = chunkArray(values, 200);
          for (const chunk of chunks) {
            const rows = chunk.map(value => ({ value, merchantId: merchant.id, isUsed: false }));
            await Code.bulkCreate(rows);
            addedCount += rows.length;
          }
        } catch (bulkErr) {
          console.error('Bulk insert referral stock error:', bulkErr);
          for (const value of values) {
            try {
              await Code.create({ value, merchantId: merchant.id, isUsed: false });
              addedCount += 1;
            } catch (singleErr) {
              console.error('Single insert referral stock error:', singleErr);
            }
          }
        }

        const totalCount = await Code.count({ where: { merchantId: merchant.id, isUsed: false } });
        await bot.deleteMessage(userId, loadingMsg.message_id).catch(() => {});
        await bot.sendMessage(
          userId,
          `${await getText(userId, 'referralStockCodesAdded', { count: addedCount })}\n📦 إجمالي المخزون الآن: ${totalCount}`,
          { reply_markup: getReferralStockInputReplyMarkup() }
        );
        return;
      }

      if (state.action === 'delete_referral_stock_codes_by_input') {
        const merchant = await getReferralStockMerchant();
        const rawInput = String(text || msg.caption || '');

        let values = extractChatGptUpCodes(rawInput);
        if (!values.length) {
          values = String(rawInput || '')
            .split(/\r?\n|\s+/)
            .map(v => normalizeChatGptUpCode(v))
            .filter(Boolean);
        }

        values = [...new Set(values.filter(Boolean))];

        if (!values.length) {
          await bot.sendMessage(userId, await getText(userId, 'enterSearchDeleteReferralStockCodes'));
          return;
        }

        const rows = await Code.findAll({
          where: {
            merchantId: merchant.id,
            value: { [Op.in]: values }
          },
          attributes: ['id', 'value'],
          order: [['id', 'ASC']]
        });

        const foundValues = new Set(rows.map(r => normalizeChatGptUpCode(r.value)).filter(Boolean));
        const missingValues = values.filter(v => !foundValues.has(v));

        let deletedCount = 0;
        if (rows.length) {
          deletedCount = await Code.destroy({
            where: { id: rows.map(r => r.id) }
          });
        }

        const detailsLines = [];
        if (rows.length) {
          detailsLines.push(`✅ الأكواد الموجودة والمحذوفة:`);
          for (const code of [...foundValues].slice(0, 100)) {
            detailsLines.push(code);
          }
        }
        if (missingValues.length) {
          detailsLines.push(``);
          detailsLines.push(`❌ الأكواد غير الموجودة:`);
          for (const code of missingValues.slice(0, 100)) {
            detailsLines.push(code);
          }
        }

        await bot.sendMessage(
          userId,
          await getText(userId, 'referralStockSearchDeleteResult', {
            deleted: deletedCount,
            missing: missingValues.length,
            details: detailsLines.join('\n') || '-'
          })
        );
        await clearUserState(userId);
        await showReferralStockSettingsAdmin(userId);
        return;
      }

      if (state.action === 'deduct_points') {
        if (state.step === 'user_id') {
          const targetUserId = parseInt(text, 10);
          if (!Number.isInteger(targetUserId)) {
            await bot.sendMessage(userId, await getText(userId, 'enterDeductPointsUserId'));
            return;
          }
          const targetUser = await User.findByPk(targetUserId);
          if (!targetUser) {
            await bot.sendMessage(userId, await getText(userId, 'deductPointsUserNotFound'));
            return;
          }
          await setUserState(userId, { action: 'deduct_points', step: 'points', targetUserId });
          await bot.sendMessage(userId, await getText(userId, 'enterDeductPointsAmount'));
          return;
        }

        if (state.step === 'points') {
          const points = parseInt(text, 10);
          if (!Number.isInteger(points) || points <= 0) {
            await bot.sendMessage(userId, await getText(userId, 'enterDeductPointsAmount'));
            return;
          }
          const targetUser = await User.findByPk(state.targetUserId);
          if (!targetUser) {
            await bot.sendMessage(userId, await getText(userId, 'deductPointsUserNotFound'));
            await clearUserState(userId);
            await showReferralSettingsAdmin(userId);
            return;
          }
          targetUser.referralPoints = Math.max(0, Number(targetUser.referralPoints || 0) - points);
          await targetUser.save();
          await bot.sendMessage(userId, await getText(userId, 'deductPointsDone', {
            userId: targetUser.id,
            points: targetUser.referralPoints
          }));
          await clearUserState(userId);
          await showReferralSettingsAdmin(userId);
          return;
        }
      }

      if (state.action === 'claim_referral_stock') {
        const result = await claimReferralStockCodes(userId, text);
        if (!result.success) {
          if (result.reason === 'invalid_count') {
            await bot.sendMessage(userId, await getText(userId, 'referralClaimAskCount', { maxCodes: result.maxCodes || 0 }));
          } else if (result.reason === 'not_enough_stock') {
            await bot.sendMessage(userId, await getText(userId, 'referralStockNotEnough'));
            await clearUserState(userId);
          } else if (result.reason === 'no_referrals') {
            await bot.sendMessage(userId, await getText(userId, 'referralStockAccessDenied'));
            await clearUserState(userId);
          } else {
            await bot.sendMessage(userId, await getText(userId, 'error'));
          }
          return;
        }
        const deliveryPrefix = await getCodeDeliveryPrefixHtml(userId);
        await bot.sendMessage(userId, `${deliveryPrefix}${await getText(userId, 'pointsRedeemed', { code: formatCodesForHtml(result.codes) })}`, { parse_mode: 'HTML' });

        const identity = await getTelegramIdentityById(userId);
        await bot.sendMessage(ADMIN_ID, await getText(ADMIN_ID, 'referralClaimAdminNotice', {
          name: identity.fullName,
          username: identity.usernameText,
          id: userId,
          claimedNow: result.count,
          claimedBefore: result.claimedBefore,
          claimedAfter: result.claimedAfter,
          eligibleNow: result.eligibleNow,
          points: result.points,
          adminGranted: result.adminGranted,
          referrals: result.referralCount,
          milestoneRewards: result.milestoneRewards
        })).catch(() => {});

        await bot.sendMessage(ADMIN_ID, await getText(ADMIN_ID, 'stockClaimAdminShort', {
          name: identity.fullName,
          username: identity.usernameText,
          id: userId,
          count: result.count
        })).catch(() => {});

        const referralMerchant = await getReferralStockMerchant();
        const referralRemaining = await Code.count({ where: { merchantId: referralMerchant.id, isUsed: false } });
        await sendAdminCodeActionNotice(userId, {
          sourceKey: 'referral_stock',
          serviceType: 'جائزة الإحالات',
          codesCount: result.count,
          remainingStockText: String(referralRemaining)
        });

        await clearUserState(userId);
        await sendMainMenu(userId);
        return;
      }

      if (state.action === 'admin_add_balance') {
        if (state.step === 'user_id') {
          const targetUserId = parseInt(text, 10);
          if (!Number.isInteger(targetUserId)) {
            await bot.sendMessage(userId, await getText(userId, 'enterBalanceUserId'));
            return;
          }
          const targetUser = await User.findByPk(targetUserId);
          if (!targetUser) {
            await bot.sendMessage(userId, await getText(userId, 'balanceUserNotFound'));
            return;
          }
          await setUserState(userId, { action: 'admin_add_balance', step: 'amount', targetUserId });
          await bot.sendMessage(userId, await getText(userId, 'enterBalanceAmount'));
          return;
        }

        if (state.step === 'amount') {
          const amount = parseFloat(text);
          if (!Number.isFinite(amount) || amount <= 0) {
            await bot.sendMessage(userId, await getText(userId, 'balanceAmountInvalid'));
            return;
          }
          const targetUser = await User.findByPk(state.targetUserId);
          if (!targetUser) {
            await bot.sendMessage(userId, await getText(userId, 'balanceUserNotFound'));
            await clearUserState(userId);
            await showBalanceManagementAdmin(userId);
            return;
          }
          const newBalance = Number(targetUser.balance || 0) + amount;
          await User.update({ balance: newBalance }, { where: { id: targetUser.id } });
          await BalanceTransaction.create({
            userId: targetUser.id,
            amount,
            type: 'admin_balance_add',
            status: 'completed'
          });
          await bot.sendMessage(userId, await getText(userId, 'balanceAddedDone', {
            amount: amount.toFixed(2),
            userId: targetUser.id,
            balance: newBalance.toFixed(2)
          }));
          await bot.sendMessage(targetUser.id, await getText(targetUser.id, 'balanceReceivedNotification', {
            amount: amount.toFixed(2),
            balance: newBalance.toFixed(2)
          })).catch(() => {});
          await clearUserState(userId);
          await showBalanceManagementAdmin(userId);
          return;
        }
      }

      if (state.action === 'admin_deduct_balance') {
        if (state.step === 'user_id') {
          const targetUserId = parseInt(text, 10);
          if (!Number.isInteger(targetUserId)) {
            await bot.sendMessage(userId, await getText(userId, 'enterBalanceUserId'));
            return;
          }
          const targetUser = await User.findByPk(targetUserId);
          if (!targetUser) {
            await bot.sendMessage(userId, await getText(userId, 'balanceUserNotFound'));
            return;
          }
          await setUserState(userId, { action: 'admin_deduct_balance', step: 'amount', targetUserId });
          await bot.sendMessage(userId, await getText(userId, 'enterBalanceAmount'));
          return;
        }

        if (state.step === 'amount') {
          const amount = parseFloat(text);
          if (!Number.isFinite(amount) || amount <= 0) {
            await bot.sendMessage(userId, await getText(userId, 'balanceAmountInvalid'));
            return;
          }
          const targetUser = await User.findByPk(state.targetUserId);
          if (!targetUser) {
            await bot.sendMessage(userId, await getText(userId, 'balanceUserNotFound'));
            await clearUserState(userId);
            await showBalanceManagementAdmin(userId);
            return;
          }
          const currentBalance = Number(targetUser.balance || 0);
          const deductAmount = Math.min(currentBalance, amount);
          const newBalance = Math.max(0, currentBalance - deductAmount);
          await User.update({ balance: newBalance }, { where: { id: targetUser.id } });
          await BalanceTransaction.create({
            userId: targetUser.id,
            amount: -deductAmount,
            type: 'admin_balance_deduct',
            status: 'completed'
          });
          await bot.sendMessage(userId, await getText(userId, 'balanceDeductedDone', {
            amount: deductAmount.toFixed(2),
            userId: targetUser.id,
            balance: newBalance.toFixed(2)
          }));
          await bot.sendMessage(targetUser.id, await getText(targetUser.id, 'balanceDeductedNotification', {
            amount: deductAmount.toFixed(2),
            balance: newBalance.toFixed(2)
          })).catch(() => {});
          await clearUserState(userId);
          await showBalanceManagementAdmin(userId);
          return;
        }
      }

      if (state.action === 'grant_points') {
        if (state.step === 'user_id') {
          const targetUserId = parseInt(text, 10);
          if (!Number.isInteger(targetUserId)) {
            await bot.sendMessage(userId, await getText(userId, 'enterGrantPointsUserId'));
            return;
          }

          const targetUser = await User.findByPk(targetUserId);
          if (!targetUser) {
            await bot.sendMessage(userId, await getText(userId, 'grantPointsUserNotFound'));
            return;
          }

          await setUserState(userId, { action: 'grant_points', step: 'points', targetUserId });
          await bot.sendMessage(userId, await getText(userId, 'enterGrantPointsAmount'));
          return;
        }

        if (state.step === 'points') {
          const points = parseInt(text, 10);
          if (!Number.isInteger(points) || points <= 0) {
            await bot.sendMessage(userId, await getText(userId, 'enterGrantPointsAmount'));
            return;
          }

          const targetUser = await User.findByPk(state.targetUserId);
          if (!targetUser) {
            await bot.sendMessage(userId, await getText(userId, 'grantPointsUserNotFound'));
            await clearUserState(userId);
            await showReferralSettingsAdmin(userId);
            return;
          }

          targetUser.referralPoints = (targetUser.referralPoints || 0) + points;
          targetUser.adminGrantedPoints = (targetUser.adminGrantedPoints || 0) + points;
          await targetUser.save();

          const refIdentity = await getTelegramIdentityById(targetUser.id);
          const referralCount = await User.count({ where: { referredBy: targetUser.id, referralRewarded: true } });
          const milestoneRewards = await getCumulativeReferralMilestonePoints(referralCount);

          await bot.sendMessage(
            userId,
            await getText(userId, 'grantPointsDoneDetailed', {
              userId: targetUser.id,
              username: refIdentity.usernameText,
              name: refIdentity.fullName,
              points,
              total: targetUser.referralPoints,
              adminGranted: targetUser.adminGrantedPoints || 0,
              referrals: referralCount,
              milestoneRewards
            })
          );

          try {
            await bot.sendMessage(
              targetUser.id,
              await getText(targetUser.id, 'pointsGrantedNotification', {
                points,
                total: targetUser.referralPoints
              })
            );
          } catch (notifyErr) {
            console.error('Grant points notify error:', notifyErr.message);
          }

          await clearUserState(userId);
          await showReferralSettingsAdmin(userId);
          return;
        }
      }

      if (state.action === 'toggle_free_code_for_user') {
        const targetUserId = parseInt(text, 10);
        if (!Number.isInteger(targetUserId)) {
          await bot.sendMessage(userId, await getText(userId, 'enterFreeCodeAccessUserId'));
          return;
        }
        const targetUser = await User.findByPk(targetUserId);
        if (!targetUser) {
          await bot.sendMessage(userId, await getText(userId, 'grantPointsUserNotFound'));
          return;
        }

        if (state.mode === 'enable') {
          targetUser.forceFreeCodeButton = true;
          await targetUser.save();
          await bot.sendMessage(userId, await getText(userId, 'freeCodeAccessEnabledDone', { userId: targetUserId }));
        } else {
          targetUser.forceFreeCodeButton = false;
          await targetUser.save();
          await bot.sendMessage(userId, await getText(userId, 'freeCodeAccessDisabledDone', { userId: targetUserId }));
        }
        await clearUserState(userId);
        await showReferralSettingsAdmin(userId);
        return;
      }

      if (state.action === 'grant_creator_discount') {
        if (state.step === 'user_id') {
          const targetUserId = parseInt(text, 10);
          if (!Number.isInteger(targetUserId)) {
            await bot.sendMessage(userId, await getText(userId, 'enterCreatorDiscountUserId'));
            return;
          }

          const targetUser = await User.findByPk(targetUserId);
          if (!targetUser) {
            await bot.sendMessage(userId, await getText(userId, 'creatorDiscountUserNotFound'));
            return;
          }

          await setUserState(userId, { action: 'grant_creator_discount', step: 'percent', targetUserId });
          await bot.sendMessage(userId, await getText(userId, 'enterCreatorDiscountPercent'));
          return;
        }

        if (state.step === 'percent') {
          const percent = parseInt(text, 10);
          if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
            await bot.sendMessage(userId, await getText(userId, 'enterCreatorDiscountPercent'));
            return;
          }

          const targetUser = await User.findByPk(state.targetUserId);
          if (!targetUser) {
            await bot.sendMessage(userId, await getText(userId, 'creatorDiscountUserNotFound'));
            await clearUserState(userId);
            await showReferralSettingsAdmin(userId);
            return;
          }

          targetUser.creatorDiscountPercent = percent;
          await targetUser.save();
          const requiredPoints = await getEffectiveRedeemPointsForUser(targetUser.id);

          await bot.sendMessage(
            userId,
            await getText(userId, 'creatorDiscountUpdated', {
              userId: targetUser.id,
              percent,
              requiredPoints
            })
          );

          try {
            await bot.sendMessage(
              targetUser.id,
              await getText(targetUser.id, 'creatorDiscountGrantedNotification', {
                percent,
                requiredPoints
              })
            );
          } catch (notifyErr) {
            console.error('Creator discount notify error:', notifyErr.message);
          }

          await clearUserState(userId);
          await showReferralSettingsAdmin(userId);
          return;
        }
      }

      if (state.action === 'add_redeem_service') {
        if (state.step === 'nameEn') {
          await setUserState(userId, { ...state, nameEn: text, step: 'nameAr' });
          await bot.sendMessage(userId, await getText(userId, 'redeemServiceNameAr'));
          return;
        }
        if (state.step === 'nameAr') {
          await setUserState(userId, { ...state, nameAr: text, step: 'merchantDictId' });
          await bot.sendMessage(userId, await getText(userId, 'redeemServiceMerchantId'));
          return;
        }
        if (state.step === 'merchantDictId') {
          await setUserState(userId, { ...state, merchantDictId: text, step: 'platformId' });
          await bot.sendMessage(userId, await getText(userId, 'redeemServicePlatformId'));
          return;
        }
        if (state.step === 'platformId') {
          await RedeemService.create({
            nameEn: state.nameEn,
            nameAr: state.nameAr,
            merchantDictId: state.merchantDictId,
            platformId: text || '1'
          });
          await bot.sendMessage(userId, await getText(userId, 'redeemServiceAdded'));
          await clearUserState(userId);
          await showRedeemServicesAdmin(userId);
          return;
        }
      }

      if (state.action === 'add_discount_code') {
        if (state.step === 'code') {
          await setUserState(userId, { ...state, code: text, step: 'percent' });
          await bot.sendMessage(userId, await getText(userId, 'enterDiscountPercent'));
          return;
        }
        if (state.step === 'percent') {
          const percent = parseInt(text, 10);
          if (Number.isNaN(percent) || percent < 0 || percent > 100) {
            await bot.sendMessage(userId, 'Invalid percentage (0-100)');
            return;
          }
          await setUserState(userId, { ...state, percent, step: 'validUntil' });
          await bot.sendMessage(userId, await getText(userId, 'enterDiscountValidUntil'));
          return;
        }
        if (state.step === 'validUntil') {
          let validUntil = null;
          if (text !== '/skip') {
            const date = new Date(text);
            if (Number.isNaN(date.getTime())) {
              await bot.sendMessage(userId, 'Invalid date format. Use YYYY-MM-DD or /skip.');
              return;
            }
            validUntil = date;
          }
          await setUserState(userId, { ...state, validUntil, step: 'maxUses' });
          await bot.sendMessage(userId, await getText(userId, 'enterDiscountMaxUses'));
          return;
        }
        if (state.step === 'maxUses') {
          const maxUses = parseInt(text, 10);
          if (Number.isNaN(maxUses) || maxUses < 1) {
            await bot.sendMessage(userId, 'Invalid max uses (minimum 1)');
            return;
          }
          await DiscountCode.create({
            code: state.code,
            discountPercent: state.percent,
            validUntil: state.validUntil,
            maxUses,
            usedCount: 0,
            createdBy: userId
          });
          await bot.sendMessage(userId, await getText(userId, 'discountCodeAdded'));
          await clearUserState(userId);
          await showDiscountCodesAdmin(userId);
          return;
        }
      }

      if (state.action === 'set_iqd_rate') {
        const rate = parseFloat(text);
        if (Number.isNaN(rate) || rate <= 0) {
          await bot.sendMessage(userId, 'Invalid rate');
          return;
        }
        await updateDepositConfig('IQD', 'rate', rate);
        await bot.sendMessage(userId, await getText(userId, 'rateSet'));
        await clearUserState(userId);
        await showDepositSettingsAdmin(userId);
        return;
      }

      if (state.action === 'edit_currency_name') {
        const field = state.langCode === 'ar' ? 'displayNameAr' : 'displayNameEn';
        await updateDepositConfig(state.currency, field, text);
        await bot.sendMessage(userId, await getText(userId, 'currencyNameUpdated'));
        await clearUserState(userId);
        await showDepositSettingsAdmin(userId);
        return;
      }

      if (state.action === 'edit_deposit_template') {
        const field = state.langCode === 'ar' ? 'templateAr' : 'templateEn';
        await updateDepositConfig(state.currency, field, text);
        await bot.sendMessage(userId, await getText(userId, 'instructionsSet'));
        await clearUserState(userId);
        await showDepositSettingsAdmin(userId);
        return;
      }

      if (state.action === 'add_deposit_method') {
        if (state.step === 'nameAr') {
          await setUserState(userId, { ...state, nameAr: text, step: 'nameEn' });
          await bot.sendMessage(userId, await getText(userId, 'enterMethodNameEn'));
          return;
        }
        if (state.step === 'nameEn') {
          await setUserState(userId, { ...state, nameEn: text, step: 'value' });
          await bot.sendMessage(userId, await getText(userId, 'enterMethodValue'));
          return;
        }
        if (state.step === 'value') {
          await addDepositMethod(state.currency, { nameAr: state.nameAr, nameEn: state.nameEn, value: text });
          await bot.sendMessage(userId, await getText(userId, 'methodAdded'));
          await clearUserState(userId);
          await showDepositMethodsAdmin(userId, state.currency);
          return;
        }
      }

      if (state.action === 'edit_deposit_instructions') {
        await updateDepositConfig(state.currency, 'instructions', text);
        await bot.sendMessage(userId, await getText(userId, 'instructionsSet'));
        await clearUserState(userId);
        await showDepositSettingsAdmin(userId);
        return;
      }
    }


    if (state?.action === 'binance_transfer_pending') {
      if (photo || video) {
        await bot.sendMessage(userId, await getText(userId, 'binanceTransferHelp'), {
          reply_markup: await getBinanceTransferReplyMarkup(userId)
        });
        return;
      }

      const trimmedText = String(text || '').trim();
      const claimMatch = trimmedText.match(/^\/claim(?:@\w+)?(?:\s+(.+))?$/i);
      const claimOrderId = claimMatch?.[1] ? claimMatch[1].trim() : '';
      const providedOrderId = looksLikeBinanceTransferOrderId(claimOrderId)
        ? claimOrderId
        : (looksLikeBinanceTransferOrderId(trimmedText) ? trimmedText : '');

      if (providedOrderId && state.awaitingManualOrderId) {
        state.awaitingManualOrderId = false;
        await setUserState(userId, state);
        await processBinanceAutoVerification(userId, state, { rawInput: providedOrderId });
        return;
      }

      if (providedOrderId) {
        return;
      }

      await bot.sendMessage(userId, await getText(userId, 'binanceTransferHelp'), {
        reply_markup: await getBinanceTransferReplyMarkup(userId)
      });
      return;
    }


    if (state?.action === 'binance_auto_waiting_proof') {
      await clearUserState(userId);
      await bot.sendMessage(userId, await getText(userId, 'binancePayStatusExpired'));
      await showBinanceAutoAmountOptions(userId);
      return;
    }

    if (state?.action === 'ai_assistant') {
      if (!(await getAiAssistantEnabled())) {
        await clearUserState(userId);
        await bot.sendMessage(userId, await getText(userId, 'aiAssistantDisabledNotice'));
        await sendMainMenu(userId);
        return;
      }
      const trimmed = String(text || '').trim();
      if (isSlashCommandText(trimmed)) {
        if (/^\/start(?:\s|$)/i.test(trimmed)) {
          await clearUserState(userId);
        }
        return;
      }
      if (state.awaitingSupportConfirm && isAffirmativeText(trimmed)) {
        await clearUserState(userId);
        await startSupportConversation(userId, 'ai_text_confirmation');
        return;
      }
      if (state.awaitingSupportConfirm && isNegativeText(trimmed)) {
        await setUserState(userId, { ...state, awaitingSupportConfirm: false });
        await bot.sendMessage(userId, await getText(userId, 'aiAssistantSupportDeclined'), { reply_markup: await getBackAndCancelReplyMarkup(userId) });
        return;
      }

      if (state.awaitingPurchaseConfirm && isAffirmativeText(trimmed)) {
        await completeAssistantMerchantPurchase(userId, parseInt(state.pendingMerchantId, 10), Math.max(1, parseInt(state.pendingQuantity, 10) || 1), state);
        return;
      }
      if (state.awaitingPurchaseConfirm && isNeedMoreInfoText(trimmed)) {
        const merchant = await Merchant.findByPk(parseInt(state.pendingMerchantId, 10));
        if (merchant) {
          await bot.sendMessage(userId, await buildAssistantMerchantInfoText(userId, merchant, Math.max(1, parseInt(state.pendingQuantity, 10) || 1)), {
            reply_markup: await getAssistantProductInfoReplyMarkup(userId, merchant.id, Math.max(1, parseInt(state.pendingQuantity, 10) || 1), state.focusMerchantId ? `digital_product_${state.focusMerchantId}` : 'back_to_menu')
          });
        }
        return;
      }
      if (state.awaitingPurchaseConfirm && isAssistantCancelIntentText(trimmed)) {
        await setUserState(userId, {
          action: 'ai_assistant',
          history: Array.isArray(state.history) ? state.history.slice(-8) : [],
          focusMerchantId: state.focusMerchantId || null,
          awaitingSupportConfirm: false,
          awaitingPurchaseConfirm: false
        });
        await bot.sendMessage(userId, await getText(userId, 'aiAssistantPurchaseCancelled'), {
          reply_markup: await getBackAndCancelReplyMarkup(userId, state.focusMerchantId ? `digital_product_${state.focusMerchantId}` : 'back_to_menu')
        });
        return;
      }

      await processAssistantMessageTurn(userId, trimmed, state);
      return;
    }

    if (await isSupportThreadOpen(userId)) {
      await forwardSupportMessageToAdmin(userId, msg);
      await bot.sendMessage(userId, await getText(userId, 'supportUserMessageForwarded'), {
        reply_markup: await getSupportUserCloseReplyMarkup(userId)
      });
      return;
    }

    if (state?.action === 'discount') {
      const discountCode = String(text || '').trim();
      const discount = await DiscountCode.findOne({ where: { code: discountCode } });
      if (discount && (!discount.validUntil || discount.validUntil > new Date()) && discount.usedCount < discount.maxUses) {
        await bot.sendMessage(userId, await getText(userId, 'discountApplied', { percent: discount.discountPercent }));
        await setUserState(userId, { action: 'discount_ready', discountCode });
      } else {
        await bot.sendMessage(userId, await getText(userId, 'discountInvalid'));
        await clearUserState(userId);
      }
      await sendMainMenu(userId);
      return;
    }

    if (state?.action === 'buy') {
      const qty = parseInt(text, 10);
      if (Number.isNaN(qty) || qty <= 0) {
        await bot.sendMessage(userId, await getText(userId, 'invalidPurchaseQuantity'), {
          reply_markup: {
            inline_keyboard: [[{ text: await getText(userId, 'cancel'), callback_data: 'cancel_action' }]]
          }
        });
        return;
      }
      const merchant = await Merchant.findByPk(state.merchantId);
      if (!merchant) {
        await bot.sendMessage(userId, 'Merchant not found');
        return;
      }
      const available = await Code.count({ where: { merchantId: merchant.id, isUsed: false } });
      if (qty > available) {
        const backTarget = isDigitalSectionCategory(merchant.category) ? `digital_product_${merchant.id}` : 'buy';
        await bot.sendMessage(userId, `${await getText(userId, 'noCodes')}\n${await getText(userId, 'remainingStockLine', { stock: available })}`, {
          reply_markup: await getBackAndCancelReplyMarkup(userId, backTarget)
        });
        return;
      }
      const result = await processPurchase(userId, merchant.id, qty, state.discountCode || null);
      if (result.success) {
        let msgText = await getText(userId, 'success');
        if (result.discountApplied) msgText += `\n${await getText(userId, 'discountApplied', { percent: result.discountApplied })}`;
        const deliveryHtml = await formatMerchantDeliveryHtml(userId, merchant, result.rawEntries || []);
        msgText += `\n\n${deliveryHtml}`;
        const deliveryPrefix = await getCodeDeliveryPrefixHtml(userId);
        await sendPurchaseDeliveryMessage(userId, `${deliveryPrefix}${msgText}`, {
          merchant,
          totalCost: result.totalCost,
          newBalance: result.newBalance,
          quantity: qty
        });

        const remainingMerchantStock = await Code.count({ where: { merchantId: merchant.id, isUsed: false } });
        await sendAdminCodeActionNotice(userId, {
          sourceKey: 'balance',
          serviceType: `${merchant.nameAr || merchant.nameEn}`,
          codesCount: qty,
          remainingStockText: String(remainingMerchantStock)
        });

        const userObj = await User.findByPk(userId);
        if (userObj.referredBy) {
          const referralPercent = parseFloat(process.env.REFERRAL_PERCENT || '10');
          const rewardAmount = Number(result.totalCost || (merchant.price * qty)) * referralPercent / 100;
          const referrer = await User.findByPk(userObj.referredBy);
          if (referrer) {
            await BalanceTransaction.create({ userId: referrer.id, amount: rewardAmount, type: 'referral', status: 'completed' });
            await User.update({ balance: parseFloat(referrer.balance) + rewardAmount }, { where: { id: referrer.id } });
            await bot.sendMessage(referrer.id, `🎉 Referral reward added: ${rewardAmount.toFixed(2)} USD`);
          }
        }
      } else if (result.reason === 'Insufficient balance') {
        await bot.sendMessage(
          userId,
          await getText(userId, 'insufficientBalance', {
            balance: Number(result.balance || 0).toFixed(2),
            price: Number(result.price || merchant.price || 0).toFixed(2),
            needed: Number(result.totalCost || 0).toFixed(2)
          }),
          {
            reply_markup: {
              inline_keyboard: [[{ text: await getText(userId, 'depositNow'), callback_data: 'deposit' }]]
            }
          }
        );
      } else {
        const reasonText = String(result.reason || '').toLowerCase();
        if (reasonText.includes('no hay códigos disponibles') || reasonText.includes('no codes available')) {
          const fallbackMerchant = await getReferralStockMerchant();
          const fallbackCodes = await Code.findAll({
            where: { merchantId: fallbackMerchant.id, isUsed: false },
            limit: qty,
            order: [['id', 'ASC']]
          });

          if (fallbackCodes.length > 0) {
            const t = await sequelize.transaction();
            try {
              await Code.update(
                { isUsed: true, usedBy: userId, soldAt: new Date() },
                { where: { id: fallbackCodes.map(c => c.id) }, transaction: t }
              );

              const merchant = await getOrCreateChatGptMerchant();
              const userObj = await User.findByPk(userId, { transaction: t });
              const currentBalance = parseFloat(userObj.balance);
              const unitPrice = await getChatGptUnitPrice(fallbackCodes.length);
              const totalCost = unitPrice * fallbackCodes.length;

              if (currentBalance < totalCost) {
                await t.rollback();
                await bot.sendMessage(
                  userId,
                  await getText(userId, 'insufficientBalance', {
                    balance: currentBalance.toFixed(2),
                    price: unitPrice.toFixed(2),
                    needed: totalCost.toFixed(2)
                  }),
                  {
                    reply_markup: {
                      inline_keyboard: [[{ text: await getText(userId, 'depositNow'), callback_data: 'deposit' }]]
                    }
                  }
                );
              } else {
                await User.update({ balance: currentBalance - totalCost }, { where: { id: userId }, transaction: t });
                await BalanceTransaction.create({
                  userId,
                  amount: -totalCost,
                  type: 'purchase',
                  status: 'completed'
                }, { transaction: t });
                await t.commit();

                const deliveredCodes = fallbackCodes.map(c => c.extra ? `${c.value}\n${c.extra}` : c.value);
                const deliveryPrefix = await getCodeDeliveryPrefixHtml(userId);
                await sendPurchaseDeliveryMessage(
                  userId,
                  `${deliveryPrefix}${await getText(userId, 'purchaseSuccess', { code: formatCodesForHtml(deliveredCodes) })}`,
                  {
                    continueCallback: 'chatgpt_code',
                    totalCost,
                    newBalance: currentBalance - totalCost,
                    quantity: deliveredCodes.length
                  }
                );

                const remainingFallback = await Code.count({ where: { merchantId: fallbackMerchant.id, isUsed: false } });
                await sendAdminCodeActionNotice(userId, {
                  sourceKey: 'balance',
                  serviceType: 'ChatGPT GO',
                  codesCount: deliveredCodes.length,
                  remainingStockText: String(remainingFallback)
                });
              }
            } catch (err) {
              await t.rollback().catch(() => {});
              console.error('chatgpt referral fallback error:', err);
              await bot.sendMessage(userId, `${await getText(userId, 'error')}: ${result.reason}`);
            }
          } else {
            await bot.sendMessage(userId, `${await getText(userId, 'error')}: ${result.reason}`);
          }
        } else {
          await bot.sendMessage(userId, `${await getText(userId, 'error')}: ${result.reason}`);
        }
      }
      await clearUserState(userId);
      await sendMainMenu(userId);
      return;
    }

    if (state?.action === 'deposit_amount') {
      const amount = parseFloat(text);
      if (Number.isNaN(amount) || amount <= 0) {
        await bot.sendMessage(userId, await getText(userId, 'enterDepositAmount'), {
          reply_markup: await getBackAndCancelReplyMarkup(userId, 'deposit')
        });
        return;
      }
      await sendBinanceAutoInstructions(userId, amount);
      return;
    }

    if (state?.action === 'deposit_awaiting_proof' || state?.action === 'binance_auto_session' || state?.action === 'binance_auto_waiting_proof') {
      await clearUserState(userId);
      await bot.sendMessage(userId, await getText(userId, 'binancePayStatusExpired'));
      await showBinanceAutoAmountOptions(userId);
      return;
    }

    if (state?.action === 'binance_pay_pending_order') {
      const normalized = normalizeAssistantText(String(text || ''));
      const shouldCheck = !normalized || /(check|status|paid|done|تحقق|تحقق من الدفع|تم الدفع|دفعت|اكتمل|حاله الدفع|حالة الدفع)/i.test(normalized);
      if (shouldCheck) {
        const result = await syncBinancePayOrderStatus({
          merchantTradeNo: String(state.merchantTradeNo || ''),
          prepayId: String(state.prepayId || '')
        }, { source: 'user_message', notifyUser: true });

        if (!result.success) {
          await bot.sendMessage(userId, await getText(userId, 'error'));
          return;
        }

        if (result.remoteStatus === 'PAID') {
          await clearUserState(userId);
          await sendMainMenu(userId);
          return;
        }

        const statusKey = result.remoteStatus === 'EXPIRED'
          ? 'binancePayStatusExpired'
          : result.remoteStatus === 'CANCELED'
            ? 'binancePayStatusClosed'
            : result.remoteStatus === 'ERROR'
              ? 'binancePayStatusError'
              : 'binancePayStatusPending';

        if (result.remoteStatus === 'EXPIRED' || result.remoteStatus === 'CANCELED' || result.remoteStatus === 'ERROR') {
          await clearUserState(userId);
        }

        await bot.sendMessage(userId, await getText(userId, statusKey), {
          reply_markup: result.remoteStatus === 'PENDING' || result.remoteStatus === 'INITIAL' || result.remoteStatus === 'CREATED'
            ? await getBinancePayCheckoutReplyMarkup(userId, result.payment || state)
            : await getBackAndCancelReplyMarkup(userId, 'deposit')
        });
        return;
      }

      await bot.sendMessage(userId, await getText(userId, 'binancePayStatusPending'), {
        reply_markup: await getBinancePayCheckoutReplyMarkup(userId, { merchantTradeNo: state.merchantTradeNo, checkoutUrl: null, universalUrl: null })
      });
      return;
    }

    if (state?.action === 'redeem_via_service') {
      const service = await RedeemService.findByPk(state.serviceId);
      if (!service) {
        await bot.sendMessage(userId, 'Service not found');
        await clearUserState(userId);
        await sendMainMenu(userId);
        return;
      }
      const waitingMsg = await bot.sendMessage(userId, await getText(userId, 'processing'));
      const result = await redeemCard(String(text || '').trim(), service.merchantDictId, service.platformId);
      await bot.deleteMessage(userId, waitingMsg.message_id).catch(() => {});
      if (result.success) {
        await bot.sendMessage(userId, await getText(userId, 'redeemSuccess', { details: formatCardDetails(result.data) }));
      } else {
        await bot.sendMessage(userId, await getText(userId, 'redeemFailed', { reason: result.reason }));
      }
      await clearUserState(userId);
      await sendMainMenu(userId);
      return;
    }

    if (state?.action === 'redeem_smart') {
      const waitingMsg = await bot.sendMessage(userId, await getText(userId, 'processing'));
      const result = await redeemCardSmart(String(text || '').trim());
      await bot.deleteMessage(userId, waitingMsg.message_id).catch(() => {});
      if (result.success) {
        const serviceName = result.service ? `${result.service.nameEn} / ${result.service.nameAr}` : 'Auto';
        await bot.sendMessage(userId, await getText(userId, 'redeemSuccess', {
          details: `${formatCardDetails(result.data)}\n\n🏪 Selected Service: ${serviceName}`
        }));
      } else {
        await bot.sendMessage(userId, await getText(userId, 'redeemFailed', { reason: result.reason }));
      }
      await clearUserState(userId);
      await sendMainMenu(userId);
      return;
    }

    if (state?.action === 'chatgpt_free_email') {
      const email = String(text || '').trim();
      if (!email.includes('@') || !email.includes('.')) {
        await bot.sendMessage(userId, '❌ Invalid email format. Please send a valid email.');
        return;
      }
      const result = await getChatGPTCode(email);
      if (result.success) {
        if (!state.fromPoints) {
          await User.update({ freeChatgptReceived: true }, { where: { id: userId } });
        }
        await clearUserState(userId);
        await bot.sendMessage(userId, await getText(userId, 'freeCodeSuccess', { code: formatCodesForHtml(result.codes || [result.code]) }), { parse_mode: 'HTML' });
        await sendAdminCodeActionNotice(userId, {
          sourceKey: state.fromPoints ? 'points' : 'free',
          serviceType: 'ChatGPT GO',
          codesCount: Array.isArray(result.codes) ? result.codes.length : 1,
          remainingStockText: 'من الموقع'
        });
      } else {
        await bot.sendMessage(userId, `${await getText(userId, 'error')}: ${result.reason}`);
        await clearUserState(userId);
      }
      await sendMainMenu(userId);
      return;
    }

    if (state?.action === 'redeem_points_amount') {
      const requiredPoints = await getEffectiveRedeemPointsForUser(userId);
      const requestedCodes = parseInt(String(text || '').trim(), 10);

      if (Number.isNaN(requestedCodes) || requestedCodes <= 0) {
        await bot.sendMessage(userId, await getText(userId, 'redeemPointsInvalidAmount', { requiredPoints }));
        return;
      }

      const freshUser = await User.findByPk(userId);
      const neededPoints = requestedCodes * requiredPoints;
      if (Number(freshUser.referralPoints || 0) < neededPoints) {
        await bot.sendMessage(userId, await getText(userId, 'notEnoughPoints', { points: freshUser.referralPoints, requiredPoints }));
        await clearUserState(userId);
        return;
      }

      const quantity = requestedCodes;
      const waitingMsg = await bot.sendMessage(userId, await getText(userId, 'processing'));
      const result = await processAutoChatGptCode(userId, { isFree: true, fromPoints: true, quantity });
      await bot.deleteMessage(userId, waitingMsg.message_id).catch(() => {});

      if (result.success) {
        const usedPoints = (parseInt(result.quantity, 10) || 0) * requiredPoints;
        freshUser.referralPoints = Math.max(0, Number(freshUser.referralPoints || 0) - usedPoints);
        await freshUser.save();
        {
        const deliveryPrefix = await getCodeDeliveryPrefixHtml(userId);
        await bot.sendMessage(userId, `${deliveryPrefix}${await getText(userId, 'pointsRedeemed', { code: formatCodesForHtml(result.codes) })}`, { parse_mode: 'HTML' });
      }
        await sendAdminCodeActionNotice(userId, {
          sourceKey: Number(freshUser.adminGrantedPoints || 0) >= usedPoints ? 'admin_points' : 'points',
          serviceType: 'ChatGPT GO',
          codesCount: Array.isArray(result.codes) ? result.codes.length : result.quantity,
          usedPoints,
          remainingStockText: 'من الموقع'
        });
      } else {
        await bot.sendMessage(userId, `${await getText(userId, 'error')}: ${result.reason}`);
      }

      await clearUserState(userId);
      await sendMainMenu(userId);
      return;
    }

    if (state?.action === 'chatgpt_buy_quantity') {
      const qty = parseInt(text, 10);
      if (Number.isNaN(qty) || qty <= 0 || qty > 70) {
        await bot.sendMessage(userId, await getText(userId, 'invalidQuantity'), {
          reply_markup: {
            inline_keyboard: [[{ text: await getText(userId, 'cancel'), callback_data: 'cancel_action' }]]
          }
        });
        return;
      }

      const waitingMsg = await bot.sendMessage(userId, await getText(userId, 'processing'));
      let result = await processAutoChatGptCode(userId, { isFree: false, quantity: qty });
      await bot.deleteMessage(userId, waitingMsg.message_id).catch(() => {});

      if (result.success) {
        let successText = await getText(userId, 'purchaseSuccess', { code: formatCodesForHtml(result.codes) });
        if (result.partial) {
          successText += `

⚠️ Requested: ${result.requestedQuantity} | Delivered: ${result.quantity}`;
        }
        const deliveryPrefix = await getCodeDeliveryPrefixHtml(userId);
        await sendPurchaseDeliveryMessage(userId, `${deliveryPrefix}${successText}`, {
          continueCallback: 'chatgpt_code',
          totalCost: result.totalCost,
          newBalance: result.newBalance,
          quantity: result.quantity
        });
        await sendAdminCodeActionNotice(userId, {
          sourceKey: 'balance',
          serviceType: 'ChatGPT GO',
          codesCount: Array.isArray(result.codes) ? result.codes.length : result.quantity,
          remainingStockText: 'من الموقع'
        });
      } else if (result.reason === 'INSUFFICIENT_BALANCE') {
        const freshUser = await User.findByPk(userId);
        const requiredPoints = await getEffectiveRedeemPointsForUser(userId);
        const neededPoints = qty * requiredPoints;

        if (Number(freshUser?.referralPoints || 0) >= neededPoints) {
          const waitingPointsMsg = await bot.sendMessage(userId, await getText(userId, 'processing'));
          result = await processAutoChatGptCode(userId, { isFree: true, fromPoints: true, quantity: qty });
          await bot.deleteMessage(userId, waitingPointsMsg.message_id).catch(() => {});

          if (result.success) {
            const usedPoints = (parseInt(result.quantity, 10) || 0) * requiredPoints;
            freshUser.referralPoints = Math.max(0, Number(freshUser.referralPoints || 0) - usedPoints);
            await freshUser.save();

            let successText = await getText(userId, 'pointsRedeemed', { code: formatCodesForHtml(result.codes) });
            if (result.partial) {
              successText += `

⚠️ Requested: ${qty} | Delivered: ${result.quantity}`;
            }
            const deliveryPrefix = await getCodeDeliveryPrefixHtml(userId);
            await bot.sendMessage(userId, `${deliveryPrefix}${successText}`, { parse_mode: 'HTML' });
            await sendAdminCodeActionNotice(userId, {
              sourceKey: Number(freshUser.adminGrantedPoints || 0) >= usedPoints ? 'admin_points' : 'points',
              serviceType: 'ChatGPT GO',
              codesCount: Array.isArray(result.codes) ? result.codes.length : result.quantity,
              usedPoints,
              remainingStockText: 'من الموقع'
            });
          } else {
            await bot.sendMessage(userId, `${await getText(userId, 'error')}: ${result.reason}`);
          }
        } else {
          await bot.sendMessage(
            userId,
            await getText(userId, 'insufficientBalance', {
              balance: result.balance,
              price: result.price,
              needed: result.totalCost
            }),
            {
              reply_markup: {
                inline_keyboard: [[{ text: await getText(userId, 'depositNow'), callback_data: 'deposit' }]]
              }
            }
          );
        }
      } else {
        const reasonText = String(result.reason || '').toLowerCase();
        if (reasonText.includes('no hay códigos disponibles') || reasonText.includes('no codes available')) {
          const fallbackMerchant = await getReferralStockMerchant();
          const fallbackCodes = await Code.findAll({
            where: { merchantId: fallbackMerchant.id, isUsed: false },
            limit: qty,
            order: [['id', 'ASC']]
          });

          if (fallbackCodes.length > 0) {
            const t = await sequelize.transaction();
            try {
              await Code.update(
                { isUsed: true, usedBy: userId, soldAt: new Date() },
                { where: { id: fallbackCodes.map(c => c.id) }, transaction: t }
              );

              const merchant = await getOrCreateChatGptMerchant();
              const userObj = await User.findByPk(userId, { transaction: t });
              const currentBalance = parseFloat(userObj.balance);
              const unitPrice = await getChatGptUnitPrice(fallbackCodes.length);
              const totalCost = unitPrice * fallbackCodes.length;

              if (currentBalance < totalCost) {
                await t.rollback();
                await bot.sendMessage(
                  userId,
                  await getText(userId, 'insufficientBalance', {
                    balance: currentBalance.toFixed(2),
                    price: unitPrice.toFixed(2),
                    needed: totalCost.toFixed(2)
                  }),
                  {
                    reply_markup: {
                      inline_keyboard: [[{ text: await getText(userId, 'depositNow'), callback_data: 'deposit' }]]
                    }
                  }
                );
              } else {
                await User.update({ balance: currentBalance - totalCost }, { where: { id: userId }, transaction: t });
                await BalanceTransaction.create({
                  userId,
                  amount: -totalCost,
                  type: 'purchase',
                  status: 'completed'
                }, { transaction: t });
                await t.commit();

                const deliveredCodes = fallbackCodes.map(c => c.extra ? `${c.value}\n${c.extra}` : c.value);
                const deliveryPrefix = await getCodeDeliveryPrefixHtml(userId);
                await sendPurchaseDeliveryMessage(
                  userId,
                  `${deliveryPrefix}${await getText(userId, 'purchaseSuccess', { code: formatCodesForHtml(deliveredCodes) })}`,
                  {
                    continueCallback: 'chatgpt_code',
                    totalCost,
                    newBalance: currentBalance - totalCost,
                    quantity: deliveredCodes.length
                  }
                );

                const remainingFallback = await Code.count({ where: { merchantId: fallbackMerchant.id, isUsed: false } });
                await sendAdminCodeActionNotice(userId, {
                  sourceKey: 'balance',
                  serviceType: 'ChatGPT GO',
                  codesCount: deliveredCodes.length,
                  remainingStockText: String(remainingFallback)
                });
              }
            } catch (err) {
              await t.rollback().catch(() => {});
              console.error('chatgpt referral fallback error:', err);
              await bot.sendMessage(userId, `${await getText(userId, 'error')}: ${result.reason}`);
            }
          } else {
            await bot.sendMessage(userId, `${await getText(userId, 'error')}: ${result.reason}`);
          }
        } else {
          await bot.sendMessage(userId, `${await getText(userId, 'error')}: ${result.reason}`);
        }
      }
      await clearUserState(userId);
      await sendMainMenu(userId);
      return;
    }

    if ((!state?.action || state?.action !== 'binance_transfer_pending') && /^\/claim(?:@\w+)?(?:\s+.*)?$/i.test(String(text || '').trim())) {
      await bot.sendMessage(userId, await getText(userId, 'binanceTransferNoPending'));
      return;
    }

    if ((!state?.action || state?.action !== 'binance_transfer_pending') && looksLikeBinanceTransferOrderId(String(text || '').trim())) {
      return;
    }

    if (!state?.action && msg.chat?.type === 'private' && typeof text === 'string' && String(text).trim() && !isSlashCommandText(text) && (await getAiAssistantEnabled())) {
      await processAssistantMessageTurn(userId, String(text).trim(), {
        action: 'ai_assistant',
        history: [],
        focusMerchantId: null,
        awaitingSupportConfirm: false,
        awaitingPurchaseConfirm: false
      });
      return;
    }

  } catch (err) {
    console.error('Message handler error:', err);
    await bot.sendMessage(userId, '⏳ جار التحميل...').catch(() => {});
  }
});

app.post('/api/payments/binance-pay/create-order', async (req, res) => {
  try {
    const userId = parseInt(req.body?.userId, 10);
    const amount = normalizeBinancePayAmount(req.body?.amount);
    const currency = normalizeBinancePayCurrency(req.body?.currency || 'USDT');

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid userId' });
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid amount' });
    }

    if (!isSupportedBinancePayCurrency(currency)) {
      return res.status(400).json({ success: false, error: 'Unsupported currency. Use USDT or USD.' });
    }

    const result = await createBinancePayTopupOrder({
      userId,
      amount,
      currency,
      source: 'api',
      terminalType: String(req.body?.terminalType || 'WEB').toUpperCase(),
      returnUrl: String(req.body?.returnUrl || '').trim(),
      cancelUrl: String(req.body?.cancelUrl || '').trim()
    });

    if (!result.success || !result.payment) {
      return res.status(400).json({
        success: false,
        error: result.errorMessage || result.reason || 'Failed to create Binance Pay order.'
      });
    }

    return res.json({
      success: true,
      message: 'Binance Pay order created.',
      payment: {
        id: result.payment.id,
        userId: result.payment.userId,
        merchantTradeNo: result.payment.merchantTradeNo,
        prepayId: result.payment.prepayId,
        amount: result.payment.amount,
        currency: result.payment.currency,
        status: result.payment.status,
        checkoutUrl: result.payment.checkoutUrl,
        deeplink: result.payment.deeplink,
        universalUrl: result.payment.universalUrl,
        qrcodeLink: result.payment.qrcodeLink,
        qrContent: result.payment.qrContent,
        expireTime: result.payment.expireTime
      }
    });
  } catch (err) {
    console.error('Create Binance Pay order API error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/api/payments/binance-pay/query-order', async (req, res) => {
  try {
    const merchantTradeNo = String(req.body?.merchantTradeNo || '').trim();
    const prepayId = String(req.body?.prepayId || '').trim();

    if (!merchantTradeNo && !prepayId) {
      return res.status(400).json({ success: false, error: 'merchantTradeNo or prepayId is required' });
    }

    const result = await syncBinancePayOrderStatus({ merchantTradeNo, prepayId }, { source: 'api_query', notifyUser: true });
    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.errorMessage || result.reason || 'Failed to query Binance Pay order.'
      });
    }

    return res.json({
      success: true,
      status: result.remoteStatus,
      creditedNow: Boolean(result.creditedNow),
      alreadyCredited: Boolean(result.alreadyCredited),
      payment: result.payment ? {
        id: result.payment.id,
        userId: result.payment.userId,
        merchantTradeNo: result.payment.merchantTradeNo,
        prepayId: result.payment.prepayId,
        amount: result.payment.amount,
        currency: result.payment.currency,
        status: result.payment.status,
        bizStatus: result.payment.bizStatus,
        binanceTransactionId: result.payment.binanceTransactionId,
        creditedAt: result.payment.creditedAt,
        expireTime: result.payment.expireTime,
        checkoutUrl: result.payment.checkoutUrl,
        universalUrl: result.payment.universalUrl,
        qrcodeLink: result.payment.qrcodeLink
      } : null
    });
  } catch (err) {
    console.error('Query Binance Pay order API error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.get('/api/users/:userId/balance', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid userId' });
    }

    const user = await User.findByPk(userId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    return res.json({
      success: true,
      userId,
      balance: Number(user.balance || 0).toFixed(2)
    });
  } catch (err) {
    console.error('Get user balance API error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/api/code', async (req, res) => {
  try {
    const { token, card_key, merchant_dict_id, platform_id } = req.body;
    const botService = await BotService.findOne({ where: { token, isActive: true } });
    if (!botService || !Array.isArray(botService.allowedActions) || !botService.allowedActions.includes('code')) {
      return res.status(403).json({ error: 'Bot not authorized for /code' });
    }
    if (!card_key) {
      return res.status(400).json({ error: 'Missing card_key' });
    }

    let result;
    if (merchant_dict_id) result = await redeemCard(card_key, merchant_dict_id, platform_id || '1');
    else result = await redeemCardSmart(card_key);

    if (result.success) {
      return res.json({
        success: true,
        data: result.data,
        service: result.service ? {
          id: result.service.id,
          nameEn: result.service.nameEn,
          nameAr: result.service.nameAr,
          merchantDictId: result.service.merchantDictId
        } : null
      });
    }

    return res.status(400).json({ success: false, error: result.reason });
  } catch (err) {
    console.error('API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

setInterval(async () => {
  try {
    const now = new Date();
    const updated = await Code.update({ isUsed: true }, { where: { expiresAt: { [Op.lt]: now }, isUsed: false } });
    if (updated[0] > 0) console.log(`✅ Expired codes marked as used: ${updated[0]} codes`);
  } catch (err) {
    console.error('Error cleaning expired codes:', err);
  }
}, 24 * 60 * 60 * 1000);

setInterval(async () => {
  try {
    await refreshChatGPTCookies(true);
    console.log('✅ ChatGPT cookies refreshed');
  } catch (err) {
    console.error('Cookie refresh error:', err.message);
  }
}, 5 * 60 * 1000);

setInterval(async () => {
  try {
    await reconcilePendingBinancePayOrders();
  } catch (err) {
    console.error('Binance Pay pending order reconciliation error:', err.message);
  }
}, BINANCE_PAY_PENDING_POLL_INTERVAL_MS);

setInterval(async () => {
  try {
    await reconcilePendingBinanceTransferOrders();
  } catch (err) {
    console.error('Binance transfer pending reconciliation error:', err.message);
  }
}, 30 * 1000);

sequelize.sync({ alter: true }).then(async () => {
  console.log('✅ Database synced');
  await getDepositConfig('USD');
  await getDepositConfig('IQD');
  await getOrCreateBinancePayPaymentMethod();
  await getOrCreateBinanceTransferPaymentMethod();
  await getChannelConfig();
  await refreshChatGPTCookies(false);

  await getOrCreateChatGptMerchant();
  await getPrivateCodesChannelConfig();
  await getReferralCodesChannelConfig();
  await getBotUsername();

  const PORT = process.env.PORT || 3000;
  app.get('/', (req, res) => res.send('Bot is running'));
  app.listen(PORT, () => console.log(`🚀 Server started on port ${PORT}`));
}).catch(err => {
  console.error('Database error:', err);
  process.exit(1);
});
