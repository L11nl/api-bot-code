// ========================
// index.js - البوت المتكامل (نسخة احترافية متطورة مع اشتراك قناة، كابتشا، ونقاط إحالة)
// ========================
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { Sequelize, DataTypes, Op } = require('sequelize');

// ========================
// 1. إعدادات البيئة
// ========================
const TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const DATABASE_URL = process.env.DATABASE_URL;

if (!TOKEN || !ADMIN_ID || !DATABASE_URL) {
  console.error('❌ Missing required environment variables');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
const app = express();
app.use(express.json());

// ========================
// 2. قاعدة البيانات
// ========================
const sequelize = new Sequelize(DATABASE_URL, {
  dialect: 'postgres',
  logging: false,
  dialectOptions: { ssl: { require: true, rejectUnauthorized: false } },
  pool: { max: 10, min: 0, acquire: 30000, idle: 10000 }
});

// النماذج (Models)
const User = sequelize.define('User', {
  id: { type: DataTypes.BIGINT, primaryKey: true },
  lang: { type: DataTypes.STRING(2), defaultValue: 'en' },
  balance: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0.00 },
  state: { type: DataTypes.TEXT, allowNull: true },
  referralCode: { type: DataTypes.STRING, unique: true },
  referredBy: { type: DataTypes.BIGINT, allowNull: true },
  referralPoints: { type: DataTypes.INTEGER, defaultValue: 0 },          // النقاط من الإحالات
  freeChatgptReceived: { type: DataTypes.BOOLEAN, defaultValue: false }, // هل حصل على كود ChatGPT مجانًا
  totalPurchases: { type: DataTypes.INTEGER, defaultValue: 0 },
  verified: { type: DataTypes.BOOLEAN, defaultValue: false },            // اجتاز الكابتشا
  referralRewarded: { type: DataTypes.BOOLEAN, defaultValue: false }     // هل تم منح نقطة الإحالة لهذا المستخدم
});

const Setting = sequelize.define('Setting', {
  key: { type: DataTypes.STRING, allowNull: false },
  lang: { type: DataTypes.STRING(2), allowNull: false },
  value: { type: DataTypes.TEXT, allowNull: false }
}, { indexes: [{ unique: true, fields: ['key', 'lang'] }] });

const Merchant = sequelize.define('Merchant', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  nameEn: { type: DataTypes.STRING, allowNull: false },
  nameAr: { type: DataTypes.STRING, allowNull: false },
  price: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
  category: { type: DataTypes.STRING, defaultValue: 'general' },
  type: { type: DataTypes.STRING, defaultValue: 'single' },
  description: { type: DataTypes.JSONB, allowNull: true }
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
  createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
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
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true }
});

// نموذج إعدادات القناة
const ChannelConfig = sequelize.define('ChannelConfig', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  link: { type: DataTypes.STRING, allowNull: true },
  messageText: { type: DataTypes.TEXT, allowNull: true }
});

// نموذج Captcha
const Captcha = sequelize.define('Captcha', {
  userId: { type: DataTypes.BIGINT, primaryKey: true },
  challenge: { type: DataTypes.STRING, allowNull: false },     // مثل "1+3"
  answer: { type: DataTypes.INTEGER, allowNull: false },       // الناتج
  expiresAt: { type: DataTypes.DATE, allowNull: false }
});

// العلاقات
Merchant.hasMany(Code, { foreignKey: 'merchantId' });
Code.belongsTo(Merchant);
BalanceTransaction.belongsTo(User, { foreignKey: 'userId' });
BalanceTransaction.belongsTo(PaymentMethod);
BotService.hasMany(BotStat, { foreignKey: 'botId' });
BotStat.belongsTo(BotService);
User.hasMany(ReferralReward, { as: 'Referrer', foreignKey: 'referrerId' });
User.hasMany(ReferralReward, { as: 'Referred', foreignKey: 'referredId' });
DiscountCode.belongsTo(User, { as: 'creator', foreignKey: 'createdBy' });

// ========================
// 3. النصوص الافتراضية (ديناميكية) – مع إضافة نصوص جديدة
// ========================
const DEFAULT_TEXTS = {
  en: {
    start: '🌍 Choose language',
    menu: '👋 Main menu:',
    redeem: '🔄 Redeem Code',
    buy: '🛒 Buy Codes',
    myBalance: '💰 My Balance',
    deposit: '💳 Deposit',
    support: '📞 Support',
    chooseMerchant: '👋 Choose merchant:',
    sendCard: '✍️ Send the card code:',
    processing: '⏳ Processing...',
    enterQty: '✍️ Enter quantity:',
    notEnoughBalance: '❌ Insufficient balance. Your balance: {balance} USD',
    choosePaymentMethod: '💳 Choose payment method:',
    enterDepositAmount: '💰 Enter amount in USD (min {min} / max {max}):',
    pay: '💰 Send payment to:',
    sendTx: '🔗 Send TXID (transaction ID) after payment:',
    sendImage: '📸 Send a screenshot of the payment receipt:',
    checking: '⏳ Checking...',
    error: '❌ Error',
    invalidTx: '❌ Invalid TXID or insufficient amount',
    depositSuccess: '✅ Deposit successful! New balance: {balance} USD',
    depositRejected: '❌ Your deposit was rejected.',
    success: '✅ Purchase successful! Here are your codes:',
    noCodes: '❌ Not enough codes in stock',
    back: '🔙 Back',
    adminPanel: '🔧 Admin Panel',
    addMerchant: '➕ Add Merchant',
    listMerchants: '📋 List Merchants',
    addCodes: '📦 Add Codes',
    stats: '📊 Stats',
    setPrice: '💰 Set Price',
    paymentMethods: '💳 Payment Methods',
    addPaymentMethod: '➕ Add Payment Method',
    deletePaymentMethod: '🗑️ Delete Payment Method',
    noPaymentMethods: '❌ No payment methods available.',
    enterMerchantId: 'Enter merchant ID:',
    enterPrice: 'Enter new price (USD):',
    enterCodes: 'Send codes separated by new lines or spaces:',
    codesAdded: '✅ Codes added successfully!',
    priceUpdated: '💰 Price updated!',
    selectMerchantToSetPrice: 'Select merchant to set price:',
    selectMerchantToAddCodes: 'Select merchant to add codes:',
    merchantList: '📋 Merchants list:\n',
    merchantCreated: '✅ Merchant created! ID: {id}',
    askMerchantNameEn: 'Send merchant name in English:',
    askMerchantNameAr: 'Send merchant name in Arabic:',
    askMerchantPrice: 'Send price in USD:',
    totalCodes: '📦 Total codes in stock: {count}',
    totalSales: '💰 Total sales: {amount} USDT',
    pendingDeposits: '⏳ Pending deposits: {count}',
    manageBots: '🤖 Manage Bots',
    addBot: '➕ Add Bot',
    listBots: '📋 List Bots',
    removeBot: '❌ Remove Bot',
    editBotPerms: '✏️ Edit Permissions',
    botStats: '📊 Bot Stats',
    enterBotToken: 'Send bot token:',
    enterBotName: 'Send bot name:',
    selectBotActions: 'Select allowed actions (multiple):',
    botAdded: '✅ Bot added!',
    botRemoved: '❌ Bot removed!',
    botStatsText: '📊 Bot stats for {name}:\n',
    permissionsUpdated: '✅ Bot permissions updated!',
    depositRequestPending: '📝 Your deposit request has been sent to admin. Please wait for approval.',
    depositNotification: '💳 New deposit request from user {userId}\nAmount: {amount} {currency}\nPayment Method: {method}\n\nMessage: {message}',
    approve: '✅ Approve',
    reject: '❌ Reject',
    supportMessageSent: '📨 Your message has been sent to support. You will receive a reply soon.',
    supportNotification: '📩 New support message from user {userId}:\n\n{message}',
    replyToSupport: 'Reply to this user:',
    sendReply: 'Send your reply:',
    supportReplySent: '✅ Reply sent to user.',
    redeemSuccess: '✅ Card redeemed successfully!\n\n💳 Card Details:\n{details}',
    redeemFailed: '❌ Failed to redeem card: {reason}',
    sendCode: '✍️ Send the card code:',
    referral: '🤝 Invite Friends',
    referralInfo: 'Share your referral link with friends and earn 1 point per successful referral!\n\nYour referral link: {link}\nYour points: {points}\n🎁 *Redeem 10 points for a free ChatGPT code!*',
    referralEarned: '🎉 You earned 1 referral point! Total points: {points}',
    discount: '🎟️ Apply Discount Code',
    enterDiscountCode: 'Send your discount code:',
    discountApplied: '✅ Discount code applied! You get {percent}% off.',
    discountInvalid: '❌ Invalid or expired discount code.',
    myPurchases: '📜 My Purchases',
    noPurchases: 'No purchases yet.',
    purchaseHistory: '🛍️ Purchase History:\n{history}',
    deleteMerchant: '🗑️ Delete Merchant',
    confirmDelete: '⚠️ Are you sure you want to delete this merchant?',
    yes: '✅ Yes',
    no: '❌ No',
    merchantDeleted: 'Merchant deleted successfully.',
    editMerchant: '✏️ Edit Merchant',
    editCategory: '📂 Edit Category',
    askCategory: 'Send category name (e.g., gaming, giftcard):',
    categoryUpdated: 'Category updated!',
    referralSettings: '👥 Referral Settings',
    setReferralPercent: 'Set referral reward percentage:',
    referralPercentUpdated: 'Referral reward percentage updated to {percent}%.',
    redeemViaApi: '🔑 Redeem via API (for bots)',
    askMerchantType: 'Select merchant type:',
    typeSingle: 'Single (one code per line)',
    typeBulk: 'Bulk (email/password pairs)',
    askDescription: 'Send description (text, photo, video, or /skip):',
    descriptionSaved: '✅ Description saved!',
    showDescription: '📖 View Description',
    manageRedeemServices: '🔄 Manage Redeem Services',
    addRedeemService: '➕ Add Redeem Service',
    listRedeemServices: '📋 List Redeem Services',
    deleteRedeemService: '🗑️ Delete Redeem Service',
    redeemServiceNameEn: 'Send service name in English:',
    redeemServiceNameAr: 'Send service name in Arabic:',
    redeemServiceMerchantId: 'Send merchant dict ID (from NodeCard):',
    redeemServicePlatformId: 'Send platform ID (default 1):',
    redeemServiceAdded: '✅ Redeem service added!',
    chooseRedeemService: 'Choose the service to redeem:',
    sendCodeToRedeem: 'Send the code to redeem:',
    manageDiscountCodes: '🎟️ Manage Discount Codes',
    addDiscountCode: '➕ Add Discount Code',
    listDiscountCodes: '📋 List Discount Codes',
    deleteDiscountCode: '🗑️ Delete Discount Code',
    enterDiscountCodeValue: 'Enter discount code (e.g., SAVE10):',
    enterDiscountPercent: 'Enter discount percentage (e.g., 10):',
    enterDiscountValidUntil: 'Enter expiry date (YYYY-MM-DD) or /skip:',
    enterDiscountMaxUses: 'Enter max uses (e.g., 100):',
    discountCodeAdded: '✅ Discount code added!',
    discountCodeDeleted: '❌ Discount code deleted!',
    noDiscountCodes: 'No discount codes found.',
    manageMenuButtons: '🎛️ Manage Menu Buttons',
    hide: 'Hide',
    show: 'Show',
    buttonVisibilityUpdated: '✅ Button visibility updated!',
    replyToUser: 'Reply to user {userId}:',
    replyMessage: 'Your reply from support:',
    // إعدادات الشحن
    chooseCurrency: '💱 Choose currency for deposit:',
    currencyIQD: 'Iraqi Dinar (IQD)',
    currencyUSD: 'USDT (Tether)',
    enterDepositAmountUSD: '💰 Enter amount in USD:',
    depositInstructionsUSD: '💰 Send {amount} USDT to the following address:\n\n`{address}`\n\nThen send a screenshot of the payment with any message.\n\n{instructions}',
    depositInstructionsIQD: '💰 Send {amountIQD} IQD (≈ {amountUSD} USD at rate {rate} IQD/USD) to the following SuperKey:\n\n`{address}`\n\nThen send a screenshot of the payment with any message.\n\n{instructions}',
    depositAwaitingProof: '📸 Please send the payment screenshot (photo) with any message (optional).',
    depositProofReceived: '✅ Deposit proof received! Admin will review it shortly.',
    manageDepositSettings: '💱 Manage Deposit Settings',
    setIQDRate: '💰 Set IQD Exchange Rate',
    setUSDTWallet: '🏦 Set USDT Wallet Address',
    setIQDWallet: '🏦 Set IQD SuperKey',
    setDepositInstructions: '📝 Set Deposit Instructions',
    currentRate: 'Current IQD rate: {rate} IQD per 1 USD',
    walletSet: '✅ Wallet address updated!',
    instructionsSet: '✅ Instructions updated!',
    rateSet: '✅ Exchange rate updated!',
    enterNewRate: 'Send new exchange rate (1 USD = ? IQD):',
    enterWalletAddress: 'Send wallet address / SuperKey:',
    enterInstructions: 'Send deposit instructions (text):',
    editCurrencyNames: '✏️ Edit Currency Names',
    editUSDName: 'Edit USDT name',
    editIQDName: 'Edit IQD name',
    editDepositInstructionsUSD: 'Edit USDT instructions',
    editDepositInstructionsIQD: 'Edit IQD instructions',
    currency_usd_name: 'USDT (Tether)',
    currency_iqd_name: 'Iraqi Dinar (IQD)',
    enterNewCurrencyName: 'Send new currency name:',
    currencyNameUpdated: '✅ Currency name updated!',
    editDepositInstructions: '📝 Edit Deposit Instructions',
    editUSDInstructions: 'Edit USDT instructions',
    editIQDInstructions: 'Edit IQD instructions',
    // إضافة ChatGPT
    chatgptCode: '🤖 ChatGPT Code',
    askEmail: 'Please enter your email address:',
    freeCodeSuccess: '🎉 Here is your free ChatGPT GO code:\n\n{code}',
    alreadyGotFree: 'You have already received your free code. You can purchase more codes.',
    buyChatgpt: 'Purchase ChatGPT Code',
    askQuantity: 'How many codes would you like to buy? (Max 1 per purchase)',
    enterEmailForPurchase: 'Enter your email to receive the code:',
    purchaseSuccess: '✅ Purchase successful! Here is your ChatGPT GO code:\n\n{code}',
    insufficientBalance: '❌ Insufficient balance. Your balance: {balance} USD. Price per code: {price} USD.',
    invalidQuantity: '❌ Invalid quantity. Please send a number (1 only).',
    // التحقق من القناة وCaptcha
    mustJoinChannel: '🔒 *Please join our channel first*\n\n{message}\n\nThen press the check button.',
    joinChannel: '📢 Join Channel',
    checkSubscription: '🔄 Check Subscription',
    captchaChallenge: '🤖 *Human verification*\n\nPlease solve: {challenge} = ?',
    captchaSuccess: '✅ Verification successful! Welcome!',
    captchaWrong: '❌ Wrong answer. Try again.',
    redeemPoints: '🎁 Redeem Points',
    redeemPointsInfo: 'You have {points} points. Redeem 10 points for a free ChatGPT code.',
    notEnoughPoints: '❌ You need at least 10 points to redeem. You have {points} points.',
    pointsRedeemed: '✅ Points redeemed! You got a free ChatGPT code.\n\n{code}',
    // إعدادات القناة في لوحة الأدمن
    manageChannel: '📢 Manage Required Channel',
    setChannelLink: '🔗 Set Channel Link',
    setChannelMessage: '📝 Set Channel Message',
    channelLinkSet: '✅ Channel link updated!',
    channelMessageSet: '✅ Channel message updated!',
    currentChannelLink: 'Current channel link: {link}',
    currentChannelMessage: 'Current channel message: {message}',
    enterNewChannelLink: 'Send new channel link (e.g., https://t.me/...):',
    enterNewChannelMessage: 'Send new channel message (text):'
  },
  ar: {
    start: '🌍 اختر اللغة',
    menu: '👋 القائمة الرئيسية:',
    redeem: '🔄 استرداد الكود',
    buy: '🛒 شراء كودات',
    myBalance: '💰 رصيدي',
    deposit: '💳 شحن الرصيد',
    support: '📞 الدعم الفني',
    chooseMerchant: '👋 اختر التاجر:',
    sendCard: '✍️ أرسل كود البطاقة:',
    processing: '⏳ جاري المعالجة...',
    enterQty: '✍️ أرسل الكمية:',
    notEnoughBalance: '❌ رصيد غير كاف. رصيدك: {balance} دولار',
    choosePaymentMethod: '💳 اختر طريقة الدفع:',
    enterDepositAmount: '💰 أدخل المبلغ بالدولار (الحد الأدنى {min} / الأقصى {max}):',
    pay: '💰 قم بالتحويل إلى:',
    sendTx: '🔗 أرسل TXID بعد الدفع:',
    sendImage: '📸 أرسل صورة إيصال الدفع:',
    checking: '⏳ جاري التحقق...',
    error: '❌ خطأ',
    invalidTx: '❌ TXID غير صحيح أو المبلغ غير كاف',
    depositSuccess: '✅ تم الشحن بنجاح! الرصيد الجديد: {balance} دولار',
    depositRejected: '❌ تم رفض عملية الشحن.',
    success: '✅ تم الشراء بنجاح! إليك الأكواد:',
    noCodes: '❌ لا يوجد عدد كافٍ من الأكواد في المخزون',
    back: '🔙 رجوع',
    adminPanel: '🔧 لوحة التحكم',
    addMerchant: '➕ إضافة تاجر',
    listMerchants: '📋 قائمة التجار',
    addCodes: '📦 إضافة أكواد',
    stats: '📊 الإحصائيات',
    setPrice: '💰 تعديل السعر',
    paymentMethods: '💳 طرق الدفع',
    addPaymentMethod: '➕ إضافة طريقة دفع',
    deletePaymentMethod: '🗑️ حذف طريقة دفع',
    noPaymentMethods: '❌ لا توجد طرق دفع متاحة.',
    enterMerchantId: 'أدخل رقم التاجر:',
    enterPrice: 'أدخل السعر الجديد (دولار):',
    enterCodes: 'أرسل الأكواد مفصولة بسطور جديدة أو مسافات:',
    codesAdded: '✅ تمت إضافة الأكواد بنجاح!',
    priceUpdated: '💰 تم تحديث السعر!',
    selectMerchantToSetPrice: 'اختر التاجر لتعديل السعر:',
    selectMerchantToAddCodes: 'اختر التاجر لإضافة الأكواد:',
    merchantList: '📋 قائمة التجار:\n',
    merchantCreated: '✅ تم إنشاء التاجر! المعرف: {id}',
    askMerchantNameEn: 'أرسل اسم التاجر بالإنجليزية:',
    askMerchantNameAr: 'أرسل اسم التاجر بالعربية:',
    askMerchantPrice: 'أرسل السعر بالدولار:',
    totalCodes: '📦 إجمالي الأكواد في المخزون: {count}',
    totalSales: '💰 إجمالي المبيعات: {amount} USDT',
    pendingDeposits: '⏳ شحنات معلقة: {count}',
    manageBots: '🤖 إدارة البوتات',
    addBot: '➕ إضافة بوت',
    listBots: '📋 قائمة البوتات',
    removeBot: '❌ حذف بوت',
    editBotPerms: '✏️ تعديل الصلاحيات',
    botStats: '📊 إحصائيات البوت',
    enterBotToken: 'أرسل توكن البوت:',
    enterBotName: 'أرسل اسم البوت:',
    selectBotActions: 'اختر الصلاحيات المسموحة (متعدد):',
    botAdded: '✅ تمت إضافة البوت!',
    botRemoved: '❌ تم حذف البوت!',
    botStatsText: '📊 إحصائيات البوت {name}:\n',
    permissionsUpdated: '✅ تم تحديث صلاحيات البوت!',
    depositRequestPending: '📝 تم إرسال طلب الشحن إلى الأدمن. يرجى الانتظار للموافقة.',
    depositNotification: '💳 طلب شحن جديد من المستخدم {userId}\nالمبلغ: {amount} {currency}\nطريقة الدفع: {method}\n\nالرسالة: {message}',
    approve: '✅ موافقة',
    reject: '❌ رفض',
    supportMessageSent: '📨 تم إرسال رسالتك إلى الدعم الفني. ستتلقى رداً قريباً.',
    supportNotification: '📩 رسالة دعم جديدة من المستخدم {userId}:\n\n{message}',
    replyToSupport: 'رد على هذا المستخدم:',
    sendReply: 'أرسل ردك:',
    supportReplySent: '✅ تم إرسال الرد إلى المستخدم.',
    redeemSuccess: '✅ تم استرداد البطاقة بنجاح!\n\n💳 تفاصيل البطاقة:\n{details}',
    redeemFailed: '❌ فشل استرداد البطاقة: {reason}',
    sendCode: '✍️ أرسل كود البطاقة:',
    referral: '🤝 دعوة الأصدقاء',
    referralInfo: 'شارك رابط الإحالة الخاص بك مع أصدقائك واربح نقطة واحدة لكل إحالة ناجحة!\n\nرابطك: {link}\nنقاطك: {points}\n🎁 *استبدل 10 نقاط للحصول على كود ChatGPT مجاناً!*',
    referralEarned: '🎉 لقد ربحت نقطة إحالة! إجمالي النقاط: {points}',
    discount: '🎟️ تطبيق كود خصم',
    enterDiscountCode: 'أرسل كود الخصم الخاص بك:',
    discountApplied: '✅ تم تطبيق كود الخصم! تحصل على خصم {percent}%.',
    discountInvalid: '❌ كود خصم غير صالح أو منتهي الصلاحية.',
    myPurchases: '📜 مشترياتي',
    noPurchases: 'لا توجد مشتريات بعد.',
    purchaseHistory: '🛍️ سجل المشتريات:\n{history}',
    deleteMerchant: '🗑️ حذف تاجر',
    confirmDelete: '⚠️ هل أنت متأكد من حذف هذا التاجر؟',
    yes: '✅ نعم',
    no: '❌ لا',
    merchantDeleted: 'تم حذف التاجر بنجاح.',
    editMerchant: '✏️ تعديل تاجر',
    editCategory: '📂 تعديل التصنيف',
    askCategory: 'أرسل اسم التصنيف (مثال: ألعاب، بطاقات هدايا):',
    categoryUpdated: 'تم تحديث التصنيف!',
    referralSettings: '👥 إعدادات الإحالة',
    setReferralPercent: 'أدخل نسبة مكافأة الإحالة:',
    referralPercentUpdated: 'تم تحديث نسبة مكافأة الإحالة إلى {percent}%.',
    redeemViaApi: '🔑 استرداد عبر API (للبوتات)',
    askMerchantType: 'اختر نوع التاجر:',
    typeSingle: 'فردي (كود واحد في كل سطر)',
    typeBulk: 'جملة (إيميل وباسورد في سطرين)',
    askDescription: 'أرسل شرح توضيحي (نص، صورة، فيديو، أو /skip):',
    descriptionSaved: '✅ تم حفظ الشرح!',
    showDescription: '📖 عرض الشرح',
    manageRedeemServices: '🔄 إدارة خدمات الاسترداد',
    addRedeemService: '➕ إضافة خدمة استرداد',
    listRedeemServices: '📋 قائمة خدمات الاسترداد',
    deleteRedeemService: '🗑️ حذف خدمة استرداد',
    redeemServiceNameEn: 'أرسل اسم الخدمة بالإنجليزية:',
    redeemServiceNameAr: 'أرسل اسم الخدمة بالعربية:',
    redeemServiceMerchantId: 'أرسل معرف التاجر في NodeCard:',
    redeemServicePlatformId: 'أرسل معرف المنصة (افتراضي 1):',
    redeemServiceAdded: '✅ تمت إضافة خدمة الاسترداد!',
    chooseRedeemService: 'اختر الخدمة المراد استرداد الكود فيها:',
    sendCodeToRedeem: 'أرسل الكود المراد استرداده:',
    manageDiscountCodes: '🎟️ إدارة كودات الخصم',
    addDiscountCode: '➕ إضافة كود خصم',
    listDiscountCodes: '📋 قائمة كودات الخصم',
    deleteDiscountCode: '🗑️ حذف كود خصم',
    enterDiscountCodeValue: 'أدخل كود الخصم (مثال: SAVE10):',
    enterDiscountPercent: 'أدخل نسبة الخصم (مثال: 10):',
    enterDiscountValidUntil: 'أدخل تاريخ الانتهاء (YYYY-MM-DD) أو /skip:',
    enterDiscountMaxUses: 'أدخل الحد الأقصى للاستخدام (مثال: 100):',
    discountCodeAdded: '✅ تمت إضافة كود الخصم!',
    discountCodeDeleted: '❌ تم حذف كود الخصم!',
    noDiscountCodes: 'لا توجد كودات خصم.',
    manageMenuButtons: '🎛️ إدارة الأزرار',
    hide: 'إخفاء',
    show: 'إظهار',
    buttonVisibilityUpdated: '✅ تم تحديث ظهور الأزرار!',
    replyToUser: 'رد على المستخدم {userId}:',
    replyMessage: 'ردك من الدعم الفني:',
    // إعدادات الشحن بالعربية
    chooseCurrency: '💱 اختر العملة للشحن:',
    currencyIQD: 'دينار عراقي (IQD)',
    currencyUSD: 'تيثر USDT',
    enterDepositAmountUSD: '💰 أدخل المبلغ بالدولار:',
    depositInstructionsUSD: '💰 قم بإرسال {amount} USDT إلى العنوان التالي:\n\n`{address}`\n\nثم أرسل صورة التحويل مع أي رسالة.\n\n{instructions}',
    depositInstructionsIQD: '💰 قم بإرسال {amountIQD} دينار عراقي (≈ {amountUSD} دولار بسعر صرف {rate} دينار/دولار) إلى السوبر كي التالي:\n\n`{address}`\n\nثم أرسل صورة التحويل مع أي رسالة.\n\n{instructions}',
    depositAwaitingProof: '📸 يرجى إرسال صورة إثبات الدفع (صورة) مع أي رسالة (اختياري).',
    depositProofReceived: '✅ تم استلام إثبات الدفع! سيقوم الأدمن بمراجعته قريباً.',
    manageDepositSettings: '💱 إعدادات الشحن',
    setIQDRate: '💰 تعيين سعر صرف الدينار',
    setUSDTWallet: '🏦 تعيين عنوان محفظة USDT',
    setIQDWallet: '🏦 تعيين السوبر كي للدينار',
    setDepositInstructions: '📝 تعيين تعليمات الدفع',
    currentRate: 'سعر الصرف الحالي: {rate} دينار لكل 1 دولار',
    walletSet: '✅ تم تحديث عنوان المحفظة!',
    instructionsSet: '✅ تم تحديث التعليمات!',
    rateSet: '✅ تم تحديث سعر الصرف!',
    enterNewRate: 'أرسل سعر الصرف الجديد (1 دولار = ? دينار):',
    enterWalletAddress: 'أرسل عنوان المحفظة / السوبر كي:',
    enterInstructions: 'أرسل تعليمات الدفع (نص):',
    editCurrencyNames: '✏️ تعديل أسماء العملات',
    editUSDName: 'تعديل اسم USDT',
    editIQDName: 'تعديل اسم الدينار العراقي',
    editDepositInstructionsUSD: 'تعديل تعليمات USDT',
    editDepositInstructionsIQD: 'تعديل تعليمات الدينار',
    currency_usd_name: 'تيثر USDT',
    currency_iqd_name: 'دينار عراقي (IQD)',
    enterNewCurrencyName: 'أرسل الاسم الجديد للعملة:',
    currencyNameUpdated: '✅ تم تحديث اسم العملة!',
    editDepositInstructions: '📝 تعديل تعليمات الدفع',
    editUSDInstructions: 'تعديل تعليمات USDT',
    editIQDInstructions: 'تعديل تعليمات الدينار',
    // إضافة ChatGPT
    chatgptCode: '🤖 كود ChatGPT',
    askEmail: 'يرجى إدخال بريدك الإلكتروني:',
    freeCodeSuccess: '🎉 إليك كود ChatGPT GO المجاني:\n\n{code}',
    alreadyGotFree: 'لقد حصلت بالفعل على كودك المجاني. يمكنك شراء أكواد إضافية.',
    buyChatgpt: 'شراء كود ChatGPT',
    askQuantity: 'كم عدد الأكواد التي تريد شراءها؟ (واحد فقط)',
    enterEmailForPurchase: 'أدخل بريدك الإلكتروني لاستلام الكود:',
    purchaseSuccess: '✅ تم الشراء بنجاح! إليك كود ChatGPT GO:\n\n{code}',
    insufficientBalance: '❌ رصيد غير كاف. رصيدك: {balance} دولار. سعر الكود: {price} دولار.',
    invalidQuantity: '❌ كمية غير صالحة. يرجى إرسال رقم (1 فقط).',
    // التحقق من القناة وCaptcha
    mustJoinChannel: '🔒 *يرجى الاشتراك في قناتنا أولاً*\n\n{message}\n\nثم اضغط زر التحقق.',
    joinChannel: '📢 اشترك الآن',
    checkSubscription: '🔄 تحقق من الاشتراك',
    captchaChallenge: '🤖 *التحقق البشري*\n\nيرجى حل: {challenge} = ?',
    captchaSuccess: '✅ تم التحقق بنجاح! أهلاً بك!',
    captchaWrong: '❌ إجابة خاطئة. حاول مرة أخرى.',
    redeemPoints: '🎁 استبدال النقاط',
    redeemPointsInfo: 'لديك {points} نقطة. استبدل 10 نقاط للحصول على كود ChatGPT مجاناً.',
    notEnoughPoints: '❌ تحتاج على الأقل 10 نقاط للاستبدال. لديك {points} نقطة.',
    pointsRedeemed: '✅ تم استبدال النقاط! حصلت على كود ChatGPT مجاناً.\n\n{code}',
    // إعدادات القناة في لوحة الأدمن
    manageChannel: '📢 إدارة القناة المطلوبة',
    setChannelLink: '🔗 تعيين رابط القناة',
    setChannelMessage: '📝 تعيين نص رسالة القناة',
    channelLinkSet: '✅ تم تحديث رابط القناة!',
    channelMessageSet: '✅ تم تحديث نص الرسالة!',
    currentChannelLink: 'رابط القناة الحالي: {link}',
    currentChannelMessage: 'نص الرسالة الحالي: {message}',
    enterNewChannelLink: 'أرسل رابط القناة الجديد (مثال: https://t.me/...):',
    enterNewChannelMessage: 'أرسل نص رسالة القناة الجديد:'
  }
};

// دوال مساعدة للنصوص
async function getText(userId, key, replacements = {}) {
  try {
    const user = await User.findByPk(userId);
    const lang = user ? user.lang : 'en';
    let setting = await Setting.findOne({ where: { key, lang } });
    let text = setting ? setting.value : DEFAULT_TEXTS[lang][key];
    if (!text) text = DEFAULT_TEXTS.en[key];
    for (const [k, v] of Object.entries(replacements)) {
      text = text.replace(new RegExp(`{${k}}`, 'g'), v);
    }
    return text;
  } catch (err) {
    console.error('Error in getText:', err);
    return DEFAULT_TEXTS.en[key] || key;
  }
}

function isAdmin(userId) {
  return userId === ADMIN_ID;
}

function generateReferralCode(userId) {
  return `REF${userId}${Date.now().toString(36)}`;
}

async function getUserReferralLink(userId) {
  const user = await User.findByPk(userId);
  if (!user.referralCode) {
    user.referralCode = generateReferralCode(userId);
    await user.save();
  }
  const botInfo = await bot.getMe();
  return `https://t.me/${botInfo.username}?start=ref_${user.referralCode}`;
}

// إدارة القناة
async function getChannelConfig() {
  let config = await ChannelConfig.findOne();
  if (!config) {
    config = await ChannelConfig.create({
      link: null,
      messageText: null
    });
  }
  return config;
}

async function checkChannelMembership(userId) {
  const config = await getChannelConfig();
  if (!config.link) return true; // لا يوجد قناة مطلوبة
  // استخراج اسم القناة من الرابط
  let channelUsername = config.link;
  if (channelUsername.includes('t.me/')) {
    channelUsername = channelUsername.split('t.me/')[1];
  }
  if (!channelUsername.startsWith('@')) channelUsername = '@' + channelUsername;
  try {
    const chatMember = await bot.getChatMember(channelUsername, userId);
    return chatMember.status === 'member' || chatMember.status === 'administrator' || chatMember.status === 'creator';
  } catch (err) {
    console.error('Error checking channel membership:', err);
    return false;
  }
}

async function sendJoinChannelMessage(userId) {
  const config = await getChannelConfig();
  if (!config.link) return;
  const message = config.messageText || await getText(userId, 'mustJoinChannel', { message: '' });
  const finalMsg = await getText(userId, 'mustJoinChannel', { message: message });
  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, 'joinChannel'), url: config.link }],
      [{ text: await getText(userId, 'checkSubscription'), callback_data: 'check_subscription' }]
    ]
  };
  await bot.sendMessage(userId, finalMsg, { parse_mode: 'Markdown', reply_markup: keyboard });
}

// Captcha
function generateCaptcha() {
  const a = Math.floor(Math.random() * 10);
  const b = Math.floor(Math.random() * 10);
  const operator = '+';
  const challenge = `${a} ${operator} ${b}`;
  const answer = a + b;
  return { challenge, answer };
}

async function createCaptcha(userId) {
  const { challenge, answer } = generateCaptcha();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 دقائق
  await Captcha.upsert({
    userId,
    challenge,
    answer,
    expiresAt
  });
  return challenge;
}

async function verifyCaptcha(userId, answerText) {
  const captcha = await Captcha.findByPk(userId);
  if (!captcha || captcha.expiresAt < new Date()) {
    return false;
  }
  const userAnswer = parseInt(answerText);
  if (isNaN(userAnswer)) return false;
  if (userAnswer === captcha.answer) {
    await Captcha.destroy({ where: { userId } });
    return true;
  }
  return false;
}

// منح نقاط الإحالة بعد التحقق من القناة والكابتشا
async function awardReferralPoints(referredUserId) {
  const referred = await User.findByPk(referredUserId);
  if (!referred || !referred.referredBy || referred.referralRewarded) return false;
  const referrer = await User.findByPk(referred.referredBy);
  if (!referrer) return false;

  // زيادة النقاط للمحيل
  referrer.referralPoints += 1;
  await referrer.save();
  // تسجيل أن المستخدم تم منح النقاط له
  referred.referralRewarded = true;
  await referred.save();

  // إرسال إشعار للمحيل
  await bot.sendMessage(referrer.id, await getText(referrer.id, 'referralEarned', { points: referrer.referralPoints }));
  return true;
}

// التحقق من اكتمال متطلبات المستخدم (قناة + كابتشا)
async function isUserReady(userId) {
  const user = await User.findByPk(userId);
  if (!user) return false;
  if (user.verified) return true;
  const isMember = await checkChannelMembership(userId);
  if (!isMember) return false;
  // إذا كان العضو لكن لم يتحقق بعد، نرسل الكابتشا
  const captchaExists = await Captcha.findByPk(userId);
  if (!captchaExists) {
    const challenge = await createCaptcha(userId);
    await bot.sendMessage(userId, await getText(userId, 'captchaChallenge', { challenge }));
  }
  return false; // لم يتحقق بعد
}

// معالجة نجاح التحقق
async function handleVerificationSuccess(userId) {
  const user = await User.findByPk(userId);
  if (!user || user.verified) return;
  user.verified = true;
  await user.save();
  await bot.sendMessage(userId, await getText(userId, 'captchaSuccess'));
  await sendMainMenu(userId);
  // منح نقاط الإحالة إذا كان مدعوًا ولم يتم منحها بعد
  if (user.referredBy && !user.referralRewarded) {
    await awardReferralPoints(userId);
  }
}

// ========================
// دوال إدارة الأزرار (كما هي)
// ========================
const DEFAULT_BUTTONS = {
  redeem: true,
  buy: true,
  myBalance: true,
  deposit: true,
  referral: true,
  discount: true,
  myPurchases: true,
  support: true,
  chatgpt_code: true
};

async function getMenuButtonsVisibility() {
  const setting = await Setting.findOne({ where: { key: 'menu_buttons', lang: 'global' } });
  if (!setting) return DEFAULT_BUTTONS;
  try {
    return JSON.parse(setting.value);
  } catch {
    return DEFAULT_BUTTONS;
  }
}

async function setMenuButtonsVisibility(visibility) {
  await Setting.upsert({
    key: 'menu_buttons',
    lang: 'global',
    value: JSON.stringify(visibility)
  });
}

async function showMenuButtonsAdmin(userId) {
  const visibility = await getMenuButtonsVisibility();
  const lang = (await User.findByPk(userId)).lang;
  const buttons = [
    { id: 'redeem', name: await getText(userId, 'redeem') },
    { id: 'buy', name: await getText(userId, 'buy') },
    { id: 'myBalance', name: await getText(userId, 'myBalance') },
    { id: 'deposit', name: await getText(userId, 'deposit') },
    { id: 'referral', name: await getText(userId, 'referral') },
    { id: 'discount', name: await getText(userId, 'discount') },
    { id: 'myPurchases', name: await getText(userId, 'myPurchases') },
    { id: 'support', name: await getText(userId, 'support') },
    { id: 'chatgpt_code', name: await getText(userId, 'chatgptCode') }
  ];
  let msg = await getText(userId, 'manageMenuButtons') + '\n\n';
  const keyboard = [];
  for (const btn of buttons) {
    const status = visibility[btn.id] !== false;
    const statusText = status ? '✅' : '❌';
    const action = status ? 'hide' : 'show';
    keyboard.push([{
      text: `${statusText} ${btn.name}`,
      callback_data: `toggle_button_${btn.id}_${action}`
    }]);
  }
  keyboard.push([{ text: await getText(userId, 'back'), callback_data: 'admin' }]);
  await bot.sendMessage(userId, msg, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
}

async function toggleMenuButton(buttonId, newState, adminId) {
  if (!isAdmin(adminId)) return false;
  const visibility = await getMenuButtonsVisibility();
  visibility[buttonId] = newState === 'show';
  await setMenuButtonsVisibility(visibility);
  return true;
}

// ========================
// دوال إعدادات الشحن (كما هي)
// ========================
async function getDepositConfig(currency) {
  let config = await DepositConfig.findOne({ where: { currency } });
  if (!config) {
    if (currency === 'USD') {
      config = await DepositConfig.create({
        currency: 'USD',
        rate: 1,
        walletAddress: 'T...',
        instructions: 'Send USDT (TRC20) to the address above.',
        isActive: true
      });
    } else if (currency === 'IQD') {
      config = await DepositConfig.create({
        currency: 'IQD',
        rate: 1500,
        walletAddress: 'SuperKey...',
        instructions: 'Send IQD to the SuperKey above.',
        isActive: true
      });
    }
  }
  return config;
}

async function updateDepositConfig(currency, field, value) {
  const config = await getDepositConfig(currency);
  config[field] = value;
  await config.save();
  return config;
}

async function getCurrencyName(userId, currency) {
  if (currency === 'USD') {
    return await getText(userId, 'currency_usd_name');
  } else {
    return await getText(userId, 'currency_iqd_name');
  }
}

async function showDepositSettingsAdmin(userId) {
  const usdConfig = await getDepositConfig('USD');
  const iqdConfig = await getDepositConfig('IQD');
  const usdName = await getText(userId, 'currency_usd_name');
  const iqdName = await getText(userId, 'currency_iqd_name');
  const msg = `💱 *${await getText(userId, 'manageDepositSettings')}*\n\n` +
              `${usdName}:\n` +
              `  Address: \`${usdConfig.walletAddress}\`\n` +
              `  Instructions: ${usdConfig.instructions}\n\n` +
              `${iqdName}:\n` +
              `  Rate: ${iqdConfig.rate} IQD/USD\n` +
              `  SuperKey: \`${iqdConfig.walletAddress}\`\n` +
              `  Instructions: ${iqdConfig.instructions}\n`;
  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, 'setIQDRate'), callback_data: 'admin_set_iqd_rate' }],
      [{ text: await getText(userId, 'setUSDTWallet'), callback_data: 'admin_set_usdt_wallet' }],
      [{ text: await getText(userId, 'setIQDWallet'), callback_data: 'admin_set_iqd_wallet' }],
      [{ text: await getText(userId, 'editCurrencyNames'), callback_data: 'admin_edit_currency_names' }],
      [{ text: await getText(userId, 'editDepositInstructions'), callback_data: 'admin_edit_deposit_instructions' }],
      [{ text: await getText(userId, 'back'), callback_data: 'admin' }]
    ]
  };
  await bot.sendMessage(userId, msg, { parse_mode: 'Markdown', reply_markup: keyboard });
}

async function showCurrencyNamesEdit(userId) {
  const usdName = await getText(userId, 'currency_usd_name');
  const iqdName = await getText(userId, 'currency_iqd_name');
  const msg = `✏️ *${await getText(userId, 'editCurrencyNames')}*\n\n` +
              `Current USDT name: ${usdName}\n` +
              `Current IQD name: ${iqdName}\n\n` +
              `Choose which to edit:`;
  const keyboard = {
    inline_keyboard: [
      [{ text: `✏️ ${await getText(userId, 'editUSDName')}`, callback_data: 'admin_edit_usd_name' }],
      [{ text: `✏️ ${await getText(userId, 'editIQDName')}`, callback_data: 'admin_edit_iqd_name' }],
      [{ text: await getText(userId, 'back'), callback_data: 'admin_manage_deposit_settings' }]
    ]
  };
  await bot.sendMessage(userId, msg, { reply_markup: keyboard });
}

async function showDepositInstructionsEdit(userId) {
  const msg = await getText(userId, 'editDepositInstructions');
  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, 'editUSDInstructions'), callback_data: 'admin_edit_usd_instructions' }],
      [{ text: await getText(userId, 'editIQDInstructions'), callback_data: 'admin_edit_iqd_instructions' }],
      [{ text: await getText(userId, 'back'), callback_data: 'admin_manage_deposit_settings' }]
    ]
  };
  await bot.sendMessage(userId, msg, { reply_markup: keyboard });
}

// ========================
// دوال عرض القوائم (تعديل showPaymentMethodsForDeposit)
// ========================
async function sendMainMenu(userId) {
  // التأكد من أن المستخدم جاهز (قناة + كابتشا)
  const isReady = await isUserReady(userId);
  if (!isReady) return;

  const menuText = await getText(userId, 'menu');
  const visibility = await getMenuButtonsVisibility();
  const buttons = [];

  const addButton = (id, text) => {
    if (visibility[id] !== false) {
      buttons.push([{ text, callback_data: id }]);
    }
  };

  addButton('redeem', await getText(userId, 'redeem'));
  addButton('buy', await getText(userId, 'buy'));
  addButton('my_balance', await getText(userId, 'myBalance'));
  addButton('deposit', await getText(userId, 'deposit'));
  addButton('referral', await getText(userId, 'referral'));
  addButton('discount', await getText(userId, 'discount'));
  addButton('my_purchases', await getText(userId, 'myPurchases'));
  addButton('support', await getText(userId, 'support'));
  addButton('chatgpt_code', await getText(userId, 'chatgptCode'));

  if (isAdmin(userId)) {
    buttons.push([{ text: await getText(userId, 'adminPanel'), callback_data: 'admin' }]);
  }

  await bot.sendMessage(userId, menuText, { reply_markup: { inline_keyboard: buttons } });
}

async function showAdminPanel(userId) {
  if (!isAdmin(userId)) return;
  const panelText = await getText(userId, 'adminPanel');
  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, 'manageBots'), callback_data: 'admin_manage_bots' }],
      [{ text: await getText(userId, 'manageMenuButtons'), callback_data: 'admin_manage_menu_buttons' }],
      [{ text: await getText(userId, 'manageChannel'), callback_data: 'admin_manage_channel' }],
      [{ text: await getText(userId, 'manageDepositSettings'), callback_data: 'admin_manage_deposit_settings' }],
      [{ text: await getText(userId, 'addMerchant'), callback_data: 'admin_add_merchant' }],
      [{ text: await getText(userId, 'listMerchants'), callback_data: 'admin_list_merchants' }],
      [{ text: await getText(userId, 'setPrice'), callback_data: 'admin_set_price' }],
      [{ text: await getText(userId, 'addCodes'), callback_data: 'admin_add_codes' }],
      [{ text: await getText(userId, 'paymentMethods'), callback_data: 'admin_payment_methods' }],
      [{ text: await getText(userId, 'stats'), callback_data: 'admin_stats' }],
      [{ text: await getText(userId, 'referralSettings'), callback_data: 'admin_referral_settings' }],
      [{ text: await getText(userId, 'manageRedeemServices'), callback_data: 'admin_manage_redeem_services' }],
      [{ text: await getText(userId, 'manageDiscountCodes'), callback_data: 'admin_manage_discount_codes' }],
      [{ text: await getText(userId, 'back'), callback_data: 'back_to_menu' }]
    ]
  };
  await bot.sendMessage(userId, panelText, { reply_markup: keyboard });
}

async function showChannelConfigAdmin(userId) {
  const config = await getChannelConfig();
  const linkText = config.link || 'Not set';
  const messageText = config.messageText || 'Not set';
  const msg = `📢 *${await getText(userId, 'manageChannel')}*\n\n` +
              `🔗 ${await getText(userId, 'currentChannelLink', { link: linkText })}\n` +
              `📝 ${await getText(userId, 'currentChannelMessage', { message: messageText })}`;
  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, 'setChannelLink'), callback_data: 'admin_set_channel_link' }],
      [{ text: await getText(userId, 'setChannelMessage'), callback_data: 'admin_set_channel_message' }],
      [{ text: await getText(userId, 'back'), callback_data: 'admin' }]
    ]
  };
  await bot.sendMessage(userId, msg, { parse_mode: 'Markdown', reply_markup: keyboard });
}

async function showCurrencyOptions(userId) {
  const chooseCurrencyText = await getText(userId, 'chooseCurrency');
  const currencyUSDName = await getText(userId, 'currency_usd_name');
  const currencyIQDName = await getText(userId, 'currency_iqd_name');
  const keyboard = {
    inline_keyboard: [
      [{ text: currencyIQDName, callback_data: 'deposit_currency_iqd' }],
      [{ text: currencyUSDName, callback_data: 'deposit_currency_usd' }],
      [{ text: await getText(userId, 'back'), callback_data: 'back_to_menu' }]
    ]
  };
  await bot.sendMessage(userId, chooseCurrencyText, { reply_markup: keyboard });
}

async function showMerchantsForBuy(userId) {
  const merchants = await Merchant.findAll({ order: [['category', 'ASC'], ['id', 'ASC']] });
  if (merchants.length === 0) {
    await bot.sendMessage(userId, await getText(userId, 'noCodes'));
    return sendMainMenu(userId);
  }
  const lang = (await User.findByPk(userId)).lang;
  const grouped = {};
  merchants.forEach(m => {
    if (!grouped[m.category]) grouped[m.category] = [];
    grouped[m.category].push(m);
  });
  const buttons = [];
  for (const [cat, list] of Object.entries(grouped)) {
    buttons.push([{ text: `📂 ${cat}`, callback_data: `ignore` }]);
    for (const m of list) {
      const row = [];
      row.push({
        text: `${lang === 'en' ? m.nameEn : m.nameAr} - ${m.price} USD`,
        callback_data: `buy_merchant_${m.id}`
      });
      if (m.description && (m.description.content || m.description.fileId)) {
        const showDescText = await getText(userId, 'showDescription');
        row.push({
          text: showDescText,
          callback_data: `show_description_${m.id}`
        });
      }
      buttons.push(row);
    }
  }
  const backText = await getText(userId, 'back');
  buttons.push([{ text: backText, callback_data: 'back_to_menu' }]);
  const chooseMerchantText = await getText(userId, 'chooseMerchant');
  await bot.sendMessage(userId, chooseMerchantText, { reply_markup: { inline_keyboard: buttons } });
}

async function showMerchantsForRedeem(userId) {
  const merchants = await Merchant.findAll({ order: [['category', 'ASC'], ['id', 'ASC']] });
  if (merchants.length === 0) {
    await bot.sendMessage(userId, await getText(userId, 'noCodes'));
    return sendMainMenu(userId);
  }
  const lang = (await User.findByPk(userId)).lang;
  const buttons = [];
  for (const m of merchants) {
    buttons.push([{
      text: lang === 'en' ? m.nameEn : m.nameAr,
      callback_data: `redeem_merchant_${m.id}`
    }]);
  }
  const backText = await getText(userId, 'back');
  buttons.push([{ text: backText, callback_data: 'back_to_menu' }]);
  const chooseMerchantText = await getText(userId, 'chooseMerchant');
  await bot.sendMessage(userId, chooseMerchantText, { reply_markup: { inline_keyboard: buttons } });
}

async function showPaymentMethodsForDeposit(userId, amount, currency) {
  const config = await getDepositConfig(currency);
  const lang = (await User.findByPk(userId)).lang;
  if (currency === 'USD') {
    const msg = await getText(userId, 'depositInstructionsUSD', {
      amount,
      address: config.walletAddress,
      instructions: config.instructions
    });
    await bot.sendMessage(userId, msg, { parse_mode: 'Markdown' });
  } else if (currency === 'IQD') {
    const amountIQD = amount * config.rate;
    const msg = await getText(userId, 'depositInstructionsIQD', {
      amountUSD: amount,
      amountIQD: amountIQD,
      rate: config.rate,
      address: config.walletAddress,
      instructions: config.instructions
    });
    await bot.sendMessage(userId, msg, { parse_mode: 'Markdown' });
  }
  // ننتظر الصورة مباشرة دون إرسال رسالة إضافية
  await User.update({ state: JSON.stringify({ action: 'deposit_awaiting_proof', amount, currency }) }, { where: { id: userId } });
}

async function showBotsList(userId) {
  if (!isAdmin(userId)) return;
  const bots = await BotService.findAll();
  if (bots.length === 0) {
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
      await bot.sendMessage(userId, `🤖 *${b.name}*\nID: ${b.id}\nAllowed: ${b.allowedActions.join(', ') || 'none'}\nOwner: ${b.ownerId || 'none'}`, { parse_mode: 'Markdown', reply_markup: keyboard });
    }
  }
  const addBotText = await getText(userId, 'addBot');
  const addBtn = {
    inline_keyboard: [[{ text: addBotText, callback_data: 'admin_add_bot' }]]
  };
  await bot.sendMessage(userId, addBotText, { reply_markup: addBtn });
}

async function showRedeemServices(userId) {
  const services = await RedeemService.findAll();
  if (services.length === 0) {
    await bot.sendMessage(userId, '❌ No redeem services available.');
    return sendMainMenu(userId);
  }
  const lang = (await User.findByPk(userId)).lang;
  const buttons = [];
  for (const s of services) {
    buttons.push([{
      text: lang === 'en' ? s.nameEn : s.nameAr,
      callback_data: `redeem_service_${s.id}`
    }]);
  }
  const backText = await getText(userId, 'back');
  buttons.push([{ text: backText, callback_data: 'back_to_menu' }]);
  const chooseServiceText = await getText(userId, 'chooseRedeemService');
  await bot.sendMessage(userId, chooseServiceText, { reply_markup: { inline_keyboard: buttons } });
}

async function showRedeemServicesAdmin(userId) {
  const services = await RedeemService.findAll();
  let msg = await getText(userId, 'listRedeemServices') + '\n';
  for (const s of services) {
    msg += `ID: ${s.id} | ${s.nameEn} / ${s.nameAr} | MerchantDict: ${s.merchantDictId}\n`;
  }
  const addText = await getText(userId, 'addRedeemService');
  const delText = await getText(userId, 'deleteRedeemService');
  const backText = await getText(userId, 'back');
  const keyboard = {
    inline_keyboard: [
      [{ text: addText, callback_data: 'admin_add_redeem_service' }],
      [{ text: delText, callback_data: 'admin_delete_redeem_service' }],
      [{ text: backText, callback_data: 'admin' }]
    ]
  };
  await bot.sendMessage(userId, msg, { reply_markup: keyboard });
}

async function showDiscountCodesAdmin(userId) {
  const codes = await DiscountCode.findAll();
  let msg = await getText(userId, 'listDiscountCodes') + '\n';
  for (const c of codes) {
    msg += `ID: ${c.id} | ${c.code} | ${c.discountPercent}% | Uses: ${c.usedCount}/${c.maxUses} | Expires: ${c.validUntil ? c.validUntil.toISOString().split('T')[0] : 'never'}\n`;
  }
  const addText = await getText(userId, 'addDiscountCode');
  const delText = await getText(userId, 'deleteDiscountCode');
  const backText = await getText(userId, 'back');
  const keyboard = {
    inline_keyboard: [
      [{ text: addText, callback_data: 'admin_add_discount_code' }],
      [{ text: delText, callback_data: 'admin_delete_discount_code' }],
      [{ text: backText, callback_data: 'admin' }]
    ]
  };
  await bot.sendMessage(userId, msg || await getText(userId, 'noDiscountCodes'), { reply_markup: keyboard });
}

// دوال الاسترداد (كما هي)
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
    } else {
      return { success: false, reason: response.data?.msg || 'Unknown error' };
    }
  } catch (error) {
    console.error('Redeem API error:', error.response?.data || error.message);
    return {
      success: false,
      reason: error.response?.data?.msg || error.message || 'API connection failed'
    };
  }
}

async function redeemCardSmart(cardKey) {
  const services = await RedeemService.findAll();

  if (!services || services.length === 0) {
    return { success: false, reason: 'No redeem services configured' };
  }

  // ضع هنا أسماء التجار المفضلة لديك بالترتيب
  const preferredNames = [
    'Amazon',
    'Walmart',
    'Target'
  ];

  const preferred = [];
  const others = [];

  for (const s of services) {
    const en = (s.nameEn || '').toLowerCase();
    const ar = (s.nameAr || '').toLowerCase();

    const isPreferred = preferredNames.some(name => {
      const n = name.toLowerCase();
      return en.includes(n) || ar.includes(n);
    });

    if (isPreferred) {
      preferred.push(s);
    } else {
      others.push(s);
    }
  }

  const orderedServices = [...preferred, ...others];

  let lastReason = 'No compatible merchant found';

  for (const service of orderedServices) {
    const result = await redeemCard(cardKey, service.merchantDictId, service.platformId || '1');

    if (result.success) {
      return {
        success: true,
        data: result.data,
        service
      };
    }

    lastReason = result.reason || lastReason;
  }

  return { success: false, reason: lastReason };
}

function formatCardDetails(cardData) {
  return `💳 ${cardData.card_number}\nCVV: ${cardData.cvv}\nEXP: ${cardData.exp}\n💰 ${cardData.available_amount}\n🏪 ${cardData.merchant_name}`;
}

async function checkAutoPayment(txid, expectedAmount) {
  try {
    const res = await axios.get(`https://apilist.tronscan.org/api/transaction-info?hash=${txid}`, { timeout: 8000 });
    if (!res.data || !res.data.toAddress) return false;
    const value = res.data.amount / 1e6;
    return value >= expectedAmount;
  } catch {
    return false;
  }
}

async function processPurchase(userId, merchantId, quantity, discountCode = null) {
  const merchant = await Merchant.findByPk(merchantId);
  if (!merchant) return { success: false, reason: 'Merchant not found' };
  let totalCost = merchant.price * quantity;
  let discountPercent = 0;
  if (discountCode) {
    const disc = await applyDiscount(userId, discountCode, totalCost);
    if (disc.success) {
      totalCost = disc.newTotal;
      discountPercent = disc.discountPercent;
    } else {
      return { success: false, reason: 'Invalid discount code' };
    }
  }
  const user = await User.findByPk(userId);
  if (!user) return { success: false, reason: 'User not found' };
  const currentBalance = parseFloat(user.balance);
  if (currentBalance < totalCost) {
    return { success: false, reason: 'Insufficient balance' };
  }
  const codes = await Code.findAll({ where: { merchantId, isUsed: false }, limit: quantity, order: [['id', 'ASC']] });
  if (codes.length < quantity) {
    return { success: false, reason: 'Not enough codes in stock' };
  }
  const t = await sequelize.transaction();
  try {
    await User.update({ balance: currentBalance - totalCost, totalPurchases: user.totalPurchases + quantity }, { where: { id: userId }, transaction: t });
    await BalanceTransaction.create({
      userId,
      amount: -totalCost,
      type: 'purchase',
      status: 'completed'
    }, { transaction: t });
    await Code.update({ isUsed: true, usedBy: userId, soldAt: new Date() }, { where: { id: codes.map(c => c.id) }, transaction: t });
    await t.commit();

    let codesList = '';
    for (const c of codes) {
      if (c.extra) {
        codesList += `${c.value}\n${c.extra}\n\n`;
      } else {
        codesList += `${c.value}\n\n`;
      }
    }
    return { success: true, codes: codesList.trim(), discountApplied: discountPercent };
  } catch (err) {
    await t.rollback();
    console.error('Purchase transaction error:', err);
    return { success: false, reason: 'Database error' };
  }
}

async function requestDeposit(userId, amount, currency, message, imageFileId = null) {
  const deposit = await BalanceTransaction.create({
    userId,
    amount,
    type: 'deposit',
    status: 'pending',
    imageFileId: imageFileId,
    caption: message,
    txid: currency // تخزين العملة مؤقتاً في txid
  });
  const notifText = await getText(ADMIN_ID, 'depositNotification', {
    userId,
    amount,
    currency: currency === 'USD' ? 'USDT' : 'IQD',
    method: currency === 'USD' ? 'USDT' : 'IQD',
    message: message || 'No message'
  });
  if (imageFileId) {
    await bot.sendPhoto(ADMIN_ID, imageFileId, { caption: notifText });
  } else {
    await bot.sendMessage(ADMIN_ID, notifText);
  }
  const adminMsg = await bot.sendMessage(ADMIN_ID, await getText(ADMIN_ID, 'approve') + ' / ' + await getText(ADMIN_ID, 'reject'), {
    reply_markup: {
      inline_keyboard: [
        [{ text: await getText(ADMIN_ID, 'approve'), callback_data: `approve_deposit_${deposit.id}` }],
        [{ text: await getText(ADMIN_ID, 'reject'), callback_data: `reject_deposit_${deposit.id}` }]
      ]
    }
  });
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
    const successMsg = await getText(deposit.userId, 'depositSuccess', { balance: newBalance.toFixed(2) });
    await bot.sendMessage(deposit.userId, successMsg);
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
  const rejectMsg = await getText(deposit.userId, 'depositRejected');
  await bot.sendMessage(deposit.userId, rejectMsg);
  return true;
}

async function applyDiscount(userId, discountCode, totalAmount) {
  const discount = await DiscountCode.findOne({
    where: {
      code: discountCode,
      validUntil: { [Op.gt]: new Date() },
      maxUses: { [Op.gt]: Sequelize.col('usedCount') }
    }
  });
  if (!discount) return { success: false, reason: 'invalid' };
  const newTotal = totalAmount * (1 - discount.discountPercent / 100);
  discount.usedCount += 1;
  await discount.save();
  return { success: true, newTotal, discountPercent: discount.discountPercent };
}

// دوال ChatGPT (جلب الكوكيز تلقائياً)
async function getCookiesForChatGPT() {
  try {
    const mainPageRes = await axios.get('https://www.bbvadescuentos.mx/', {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'
      }
    });
    const cookies = mainPageRes.headers['set-cookie'];
    if (!cookies) return null;
    const cookieMap = {};
    cookies.forEach(c => {
      const [keyVal] = c.split(';');
      const [key, val] = keyVal.split('=');
      if (key && val) cookieMap[key] = val;
    });
    return cookieMap;
  } catch (err) {
    console.error('Failed to fetch cookies from bbva site:', err.message);
    return null;
  }
}

async function getChatGPTCode(email) {
  let cookies = await getCookiesForChatGPT();
  if (!cookies) {
    cookies = {
      ak_bmsc: process.env.CHATGPT_AK_BMSC || '',
      bm_sv: process.env.CHATGPT_BM_SV || ''
    };
  }

  const url = "https://www.bbvadescuentos.mx/admin-site/php/_httprequest.php";
  const headers = {
    "accept": "application/json, text/plain, */*",
    "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
    "origin": "https://www.bbvadescuentos.mx",
    "referer": "https://www.bbvadescuentos.mx/develop/openai-3msc"
  };

  const form = new FormData();
  form.append('assignOpenAICode', 'true');
  form.append('email', email);

  try {
    const response = await axios.post(url, form, {
      headers: { ...headers, ...form.getHeaders() },
      cookies: cookies,
      timeout: 15000
    });
    if (response.data && response.data.success === 1) {
      return { success: true, code: response.data.code };
    } else {
      return { success: false, reason: response.data?.message || 'Unknown error' };
    }
  } catch (err) {
    console.error('ChatGPT API error:', err.response?.data || err.message);
    return { success: false, reason: err.message };
  }
}

// ========================
// 5. أوامر البوت الأساسية
// ========================
bot.onText(/\/start/, async (msg) => {
  const userId = msg.chat.id;
  const args = msg.text.split(' ');
  try {
    await User.findOrCreate({ where: { id: userId }, defaults: { lang: 'en', balance: 0, referralCode: generateReferralCode(userId) } });
    if (args.length > 1 && args[1].startsWith('ref_')) {
      const referralCode = args[1].substring(4);
      // تخزين المحيل دون منح النقطة الآن (سيتم المنح بعد التحقق)
      const referrer = await User.findOne({ where: { referralCode } });
      if (referrer && referrer.id !== userId) {
        await User.update({ referredBy: referrer.id }, { where: { id: userId } });
      }
    }
    const startText = await getText(userId, 'start');
    await bot.sendMessage(userId, startText, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🇺🇸 English', callback_data: 'lang_en' }],
          [{ text: '🇮🇶 العربية', callback_data: 'lang_ar' }]
        ]
      }
    });
  } catch (err) {
    console.error('Error in /start:', err);
  }
});

bot.onText(/\/admin/, async (msg) => {
  const userId = msg.chat.id;
  if (!isAdmin(userId)) return;
  await showAdminPanel(userId);
});

// ========================
// 6. معالجة callback_query (جميع الأزرار)
// ========================
bot.on('callback_query', async (query) => {
  const userId = query.message.chat.id;
  const data = query.data;

  try {
    await User.findOrCreate({ where: { id: userId }, defaults: { lang: 'en', balance: 0, referralCode: generateReferralCode(userId) } });

    // اختيار اللغة
    if (data.startsWith('lang_')) {
      const newLang = data.split('_')[1];
      await User.update({ lang: newLang }, { where: { id: userId } });
      // بعد اختيار اللغة، نتحقق من القناة والكابتشا
      const isReady = await isUserReady(userId);
      if (!isReady) return;
      await sendMainMenu(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // التحقق من الاشتراك
    if (data === 'check_subscription') {
      const isMember = await checkChannelMembership(userId);
      if (isMember) {
        // إذا كان عضواً، نتحقق من وجود الكابتشا
        const captchaExists = await Captcha.findByPk(userId);
        if (!captchaExists) {
          const challenge = await createCaptcha(userId);
          await bot.sendMessage(userId, await getText(userId, 'captchaChallenge', { challenge }));
        } else {
          // الكابتشا موجودة بالفعل، نرسلها
          const captcha = await Captcha.findByPk(userId);
          await bot.sendMessage(userId, await getText(userId, 'captchaChallenge', { challenge: captcha.challenge }));
        }
        await bot.answerCallbackQuery(query.id);
      } else {
        await sendJoinChannelMessage(userId);
        await bot.answerCallbackQuery(query.id);
      }
      return;
    }

    // العودة للقائمة الرئيسية
    if (data === 'back_to_menu') {
      await sendMainMenu(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // الدعم الفني (مستخدم يطلب الدعم)
    if (data === 'support') {
      await User.update({ state: JSON.stringify({ action: 'support' }) }, { where: { id: userId } });
      await bot.sendMessage(userId, await getText(userId, 'sendReply'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // رد المستخدم على رسالة الدعم (زر "رد على الدعم")
    if (data.startsWith('support_reply_user_')) {
      const adminId = parseInt(data.split('_')[3]);
      await User.update({ state: JSON.stringify({ action: 'support_reply_user', targetAdminId: adminId }) }, { where: { id: userId } });
      await bot.sendMessage(userId, await getText(userId, 'sendReply'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // لوحة الأدمن الرئيسية
    if (data === 'admin' && isAdmin(userId)) {
      await showAdminPanel(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // إدارة القناة
    if (data === 'admin_manage_channel' && isAdmin(userId)) {
      await showChannelConfigAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_set_channel_link' && isAdmin(userId)) {
      await User.update({ state: JSON.stringify({ action: 'set_channel_link' }) }, { where: { id: userId } });
      await bot.sendMessage(userId, await getText(userId, 'enterNewChannelLink'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_set_channel_message' && isAdmin(userId)) {
      await User.update({ state: JSON.stringify({ action: 'set_channel_message' }) }, { where: { id: userId } });
      await bot.sendMessage(userId, await getText(userId, 'enterNewChannelMessage'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // إدارة الأزرار
    if (data === 'admin_manage_menu_buttons' && isAdmin(userId)) {
      await showMenuButtonsAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // تبديل زر
    if (data.startsWith('toggle_button_') && isAdmin(userId)) {
      const parts = data.split('_');
      const buttonId = parts[2];
      const action = parts[3];
      await toggleMenuButton(buttonId, action, userId);
      await bot.answerCallbackQuery(query.id, { text: await getText(userId, 'buttonVisibilityUpdated') });
      await showMenuButtonsAdmin(userId);
      return;
    }

    // رد الدعم الفني (من الأدمن على المستخدم)
    if (data.startsWith('support_reply_')) {
      const targetUserId = parseInt(data.split('_')[2]);
      if (!isAdmin(userId)) {
        await bot.answerCallbackQuery(query.id, { text: 'Unauthorized', show_alert: true });
        return;
      }
      await User.update({ state: JSON.stringify({ action: 'support_reply', targetUserId }) }, { where: { id: userId } });
      await bot.sendMessage(userId, await getText(userId, 'replyToUser', { userId: targetUserId }));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // عرض الرصيد
    if (data === 'my_balance') {
      const user = await User.findByPk(userId);
      const balance = parseFloat(user.balance).toFixed(2);
      await bot.sendMessage(userId, `💰 Your balance: ${balance} USD`);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // الإحالة
    if (data === 'referral') {
      const user = await User.findByPk(userId);
      const link = await getUserReferralLink(userId);
      const points = user.referralPoints;
      const info = await getText(userId, 'referralInfo', { link, points });
      // إضافة زر لاستبدال النقاط
      const keyboard = {
        inline_keyboard: [
          [{ text: await getText(userId, 'redeemPoints'), callback_data: 'redeem_points' }],
          [{ text: await getText(userId, 'back'), callback_data: 'back_to_menu' }]
        ]
      };
      await bot.sendMessage(userId, info, { parse_mode: 'Markdown', reply_markup: keyboard });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // استبدال النقاط
    if (data === 'redeem_points') {
      const user = await User.findByPk(userId);
      if (user.referralPoints >= 10 && !user.freeChatgptReceived) {
        // خصم 10 نقاط
        user.referralPoints -= 10;
        await user.save();
        // طلب بريد إلكتروني لإرسال الكود
        await User.update({ state: JSON.stringify({ action: 'chatgpt_free_email', fromPoints: true }) }, { where: { id: userId } });
        await bot.sendMessage(userId, await getText(userId, 'askEmail'));
      } else if (user.freeChatgptReceived) {
        await bot.sendMessage(userId, await getText(userId, 'alreadyGotFree'));
      } else {
        await bot.sendMessage(userId, await getText(userId, 'notEnoughPoints', { points: user.referralPoints }));
      }
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // كود الخصم
    if (data === 'discount') {
      await User.update({ state: JSON.stringify({ action: 'discount' }) }, { where: { id: userId } });
      await bot.sendMessage(userId, await getText(userId, 'enterDiscountCode'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // مشترياتي
    if (data === 'my_purchases') {
      const purchases = await BalanceTransaction.findAll({ where: { userId, type: 'purchase', status: 'completed' }, order: [['createdAt', 'DESC']], limit: 20 });
      if (purchases.length === 0) {
        await bot.sendMessage(userId, await getText(userId, 'noPurchases'));
      } else {
        let history = '';
        for (const p of purchases) {
          history += `🛒 ${p.createdAt.toLocaleDateString()}: -${p.amount} USD\n`;
        }
        await bot.sendMessage(userId, await getText(userId, 'purchaseHistory', { history }));
      }
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // بدء عملية الشحن - عرض خيارات العملات
    if (data === 'deposit') {
      await showCurrencyOptions(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // اختيار العملة
    if (data === 'deposit_currency_iqd') {
      await User.update({ state: JSON.stringify({ action: 'deposit_amount', currency: 'IQD' }) }, { where: { id: userId } });
      await bot.sendMessage(userId, await getText(userId, 'enterDepositAmountUSD'));
      await bot.answerCallbackQuery(query.id);
      return;
    }
    if (data === 'deposit_currency_usd') {
      await User.update({ state: JSON.stringify({ action: 'deposit_amount', currency: 'USD' }) }, { where: { id: userId } });
      await bot.sendMessage(userId, await getText(userId, 'enterDepositAmountUSD'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // إدارة البوتات (عرض القائمة)
    if (data === 'admin_manage_bots' && isAdmin(userId)) {
      await showBotsList(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // إضافة بوت (بداية)
    if (data === 'admin_add_bot' && isAdmin(userId)) {
      await User.update({ state: JSON.stringify({ action: 'add_bot', step: 'token' }) }, { where: { id: userId } });
      await bot.sendMessage(userId, await getText(userId, 'enterBotToken'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // منح صلاحية /code لبوت
    if (data.startsWith('bot_grant_code_') && isAdmin(userId)) {
      const botId = parseInt(data.split('_')[3]);
      const botService = await BotService.findByPk(botId);
      if (botService) {
        let allowed = botService.allowedActions || [];
        if (!allowed.includes('code')) allowed.push('code');
        allowed = allowed.filter(a => a !== 'full');
        botService.allowedActions = allowed;
        await botService.save();
        await bot.sendMessage(userId, `✅ Granted /code permission to ${botService.name}`);
      }
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // منح جميع الصلاحيات (يتطلب إدخال ID المالك)
    if (data.startsWith('bot_grant_full_') && isAdmin(userId)) {
      const botId = parseInt(data.split('_')[3]);
      await User.update({ state: JSON.stringify({ action: 'set_bot_owner', botId }) }, { where: { id: userId } });
      await bot.sendMessage(userId, 'Send the Telegram user ID of the new bot owner:');
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // إزالة جميع الصلاحيات من بوت
    if (data.startsWith('bot_remove_perms_') && isAdmin(userId)) {
      const botId = parseInt(data.split('_')[3]);
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

    // حذف بوت
    if (data.startsWith('admin_remove_bot_confirm_') && isAdmin(userId)) {
      const botId = parseInt(data.split('_')[4]);
      await BotService.destroy({ where: { id: botId } });
      await bot.sendMessage(userId, await getText(userId, 'botRemoved'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // موافقة/رفض الإيداعات
    if (data.startsWith('approve_deposit_')) {
      if (!isAdmin(userId)) {
        await bot.answerCallbackQuery(query.id, { text: 'Unauthorized', show_alert: true });
        return;
      }
      const depositId = parseInt(data.split('_')[2]);
      await approveDeposit(depositId, userId);
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: userId, message_id: query.message.message_id });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('reject_deposit_')) {
      if (!isAdmin(userId)) {
        await bot.answerCallbackQuery(query.id, { text: 'Unauthorized', show_alert: true });
        return;
      }
      const depositId = parseInt(data.split('_')[2]);
      await rejectDeposit(depositId, userId);
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: userId, message_id: query.message.message_id });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // الشراء والاسترداد
    if (data === 'buy') {
      await showMerchantsForBuy(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'redeem') {
      await User.update({ state: JSON.stringify({ action: 'redeem_smart' }) }, { where: { id: userId } });
      await bot.sendMessage(userId, await getText(userId, 'sendCodeToRedeem'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('redeem_service_')) {
      const serviceId = parseInt(data.split('_')[2]);
      await User.update({ state: JSON.stringify({ action: 'redeem_via_service', serviceId }) }, { where: { id: userId } });
      await bot.sendMessage(userId, await getText(userId, 'sendCodeToRedeem'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('buy_merchant_')) {
      const merchantId = parseInt(data.split('_')[2]);
      const available = await Code.count({ where: { merchantId, isUsed: false } });
      if (available === 0) {
        await bot.sendMessage(userId, await getText(userId, 'noCodes'));
        await sendMainMenu(userId);
        await bot.answerCallbackQuery(query.id);
        return;
      }
      await User.update({ state: JSON.stringify({ action: 'buy', merchantId }) }, { where: { id: userId } });
      await bot.sendMessage(userId, `${await getText(userId, 'enterQty')}\n📦 Available: ${available}`);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('show_description_')) {
      const merchantId = parseInt(data.split('_')[2]);
      const merchant = await Merchant.findByPk(merchantId);
      if (merchant && merchant.description) {
        const desc = merchant.description;
        if (desc.type === 'text') {
          await bot.sendMessage(userId, desc.content);
        } else if (desc.type === 'photo') {
          await bot.sendPhoto(userId, desc.fileId);
        } else if (desc.type === 'video') {
          await bot.sendVideo(userId, desc.fileId);
        }
      } else {
        await bot.sendMessage(userId, 'No description available.');
      }
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // إحصائيات الأدمن
    if (data === 'admin_stats' && isAdmin(userId)) {
      const totalCodes = await Code.count();
      const usedCodes = await Code.count({ where: { isUsed: true } });
      const totalSales = await BalanceTransaction.sum('amount', { where: { type: 'purchase', status: 'completed' } });
      const pendingDeposits = await BalanceTransaction.count({ where: { type: 'deposit', status: 'pending' } });
      const statsText = await getText(userId, 'totalCodes', { count: totalCodes }) + '\n' +
                        await getText(userId, 'totalSales', { amount: totalSales || 0 }) + '\n' +
                        await getText(userId, 'pendingDeposits', { count: pendingDeposits });
      await bot.sendMessage(userId, statsText);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // طرق الدفع (للأدمن)
    if (data === 'admin_payment_methods' && isAdmin(userId)) {
      const methods = await PaymentMethod.findAll();
      let msg = '💳 Payment Methods:\n';
      for (const m of methods) {
        msg += `ID: ${m.id} | ${m.nameEn} (${m.type}) - Active: ${m.isActive}\n`;
      }
      const addText = '➕ Add New';
      const delText = '🗑️ Delete';
      const limitsText = '⚙️ Set Limits';
      const backText = await getText(userId, 'back');
      const keyboard = {
        inline_keyboard: [
          [{ text: addText, callback_data: 'admin_add_payment' }],
          [{ text: delText, callback_data: 'admin_delete_payment' }],
          [{ text: limitsText, callback_data: 'admin_set_limits' }],
          [{ text: backText, callback_data: 'admin' }]
        ]
      };
      await bot.sendMessage(userId, msg, { reply_markup: keyboard });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // إدارة إعدادات الشحن
    if (data === 'admin_manage_deposit_settings' && isAdmin(userId)) {
      await showDepositSettingsAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // تعديل سعر الدينار
    if (data === 'admin_set_iqd_rate' && isAdmin(userId)) {
      await User.update({ state: JSON.stringify({ action: 'set_iqd_rate' }) }, { where: { id: userId } });
      await bot.sendMessage(userId, await getText(userId, 'enterNewRate'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // تعديل محفظة USDT
    if (data === 'admin_set_usdt_wallet' && isAdmin(userId)) {
      await User.update({ state: JSON.stringify({ action: 'set_usdt_wallet' }) }, { where: { id: userId } });
      await bot.sendMessage(userId, await getText(userId, 'enterWalletAddress'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // تعديل سوبر كي الدينار
    if (data === 'admin_set_iqd_wallet' && isAdmin(userId)) {
      await User.update({ state: JSON.stringify({ action: 'set_iqd_wallet' }) }, { where: { id: userId } });
      await bot.sendMessage(userId, await getText(userId, 'enterWalletAddress'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // تعديل تعليمات الدفع (الانتقال إلى قائمة الاختيار)
    if (data === 'admin_edit_deposit_instructions' && isAdmin(userId)) {
      await showDepositInstructionsEdit(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // تعديل أسماء العملات
    if (data === 'admin_edit_currency_names' && isAdmin(userId)) {
      await showCurrencyNamesEdit(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // تعديل اسم USDT
    if (data === 'admin_edit_usd_name' && isAdmin(userId)) {
      await User.update({ state: JSON.stringify({ action: 'edit_currency_name', currency: 'USD' }) }, { where: { id: userId } });
      await bot.sendMessage(userId, await getText(userId, 'enterNewCurrencyName'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // تعديل اسم الدينار
    if (data === 'admin_edit_iqd_name' && isAdmin(userId)) {
      await User.update({ state: JSON.stringify({ action: 'edit_currency_name', currency: 'IQD' }) }, { where: { id: userId } });
      await bot.sendMessage(userId, await getText(userId, 'enterNewCurrencyName'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // تعديل تعليمات USDT
    if (data === 'admin_edit_usd_instructions' && isAdmin(userId)) {
      await User.update({ state: JSON.stringify({ action: 'edit_deposit_instructions', currency: 'USD' }) }, { where: { id: userId } });
      await bot.sendMessage(userId, await getText(userId, 'enterInstructions'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // تعديل تعليمات الدينار
    if (data === 'admin_edit_iqd_instructions' && isAdmin(userId)) {
      await User.update({ state: JSON.stringify({ action: 'edit_deposit_instructions', currency: 'IQD' }) }, { where: { id: userId } });
      await bot.sendMessage(userId, await getText(userId, 'enterInstructions'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // إضافة تاجر
    if (data === 'admin_add_merchant' && isAdmin(userId)) {
      await User.update({ state: JSON.stringify({ action: 'add_merchant', step: 'nameEn' }) }, { where: { id: userId } });
      await bot.sendMessage(userId, await getText(userId, 'askMerchantNameEn'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // قائمة التجار
    if (data === 'admin_list_merchants' && isAdmin(userId)) {
      const merchants = await Merchant.findAll();
      let msg = await getText(userId, 'merchantList');
      for (const m of merchants) {
        msg += `ID: ${m.id} | ${m.nameEn} / ${m.nameAr} | Price: ${m.price} USD | Category: ${m.category} | Type: ${m.type}\n`;
      }
      const editText = '✏️ Edit';
      const delText = '🗑️ Delete';
      const catText = '📂 Edit Category';
      const backText = await getText(userId, 'back');
      const keyboard = {
        inline_keyboard: [
          [{ text: editText, callback_data: 'admin_edit_merchant' }],
          [{ text: delText, callback_data: 'admin_delete_merchant' }],
          [{ text: catText, callback_data: 'admin_edit_category' }],
          [{ text: backText, callback_data: 'admin' }]
        ]
      };
      await bot.sendMessage(userId, msg, { reply_markup: keyboard });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // تعديل السعر
    if (data === 'admin_set_price' && isAdmin(userId)) {
      const merchants = await Merchant.findAll();
      let msg = await getText(userId, 'selectMerchantToSetPrice') + '\n';
      const buttons = [];
      for (const m of merchants) {
        buttons.push([{ text: `${m.nameEn} (ID: ${m.id})`, callback_data: `set_price_merchant_${m.id}` }]);
      }
      const backText = await getText(userId, 'back');
      buttons.push([{ text: backText, callback_data: 'admin' }]);
      await bot.sendMessage(userId, msg, { reply_markup: { inline_keyboard: buttons } });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('set_price_merchant_') && isAdmin(userId)) {
      const merchantId = parseInt(data.split('_')[3]);
      await User.update({ state: JSON.stringify({ action: 'set_price', merchantId }) }, { where: { id: userId } });
      await bot.sendMessage(userId, await getText(userId, 'enterPrice'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // إضافة أكواد
    if (data === 'admin_add_codes' && isAdmin(userId)) {
      const merchants = await Merchant.findAll();
      let msg = await getText(userId, 'selectMerchantToAddCodes') + '\n';
      const buttons = [];
      for (const m of merchants) {
        buttons.push([{ text: `${m.nameEn} (ID: ${m.id})`, callback_data: `add_codes_merchant_${m.id}` }]);
      }
      const backText = await getText(userId, 'back');
      buttons.push([{ text: backText, callback_data: 'admin' }]);
      await bot.sendMessage(userId, msg, { reply_markup: { inline_keyboard: buttons } });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('add_codes_merchant_') && isAdmin(userId)) {
      const merchantId = parseInt(data.split('_')[3]);
      await User.update({ state: JSON.stringify({ action: 'add_codes', merchantId }) }, { where: { id: userId } });
      await bot.sendMessage(userId, await getText(userId, 'enterCodes'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // إعدادات الإحالة
    if (data === 'admin_referral_settings' && isAdmin(userId)) {
      await User.update({ state: JSON.stringify({ action: 'set_referral_percent' }) }, { where: { id: userId } });
      await bot.sendMessage(userId, await getText(userId, 'setReferralPercent'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // إدارة خدمات الاسترداد
    if (data === 'admin_manage_redeem_services' && isAdmin(userId)) {
      await showRedeemServicesAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_add_redeem_service' && isAdmin(userId)) {
      await User.update({ state: JSON.stringify({ action: 'add_redeem_service', step: 'nameEn' }) }, { where: { id: userId } });
      await bot.sendMessage(userId, await getText(userId, 'redeemServiceNameEn'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_delete_redeem_service' && isAdmin(userId)) {
      const services = await RedeemService.findAll();
      const buttons = [];
      for (const s of services) {
        buttons.push([{ text: `${s.nameEn} (ID: ${s.id})`, callback_data: `delete_redeem_service_${s.id}` }]);
      }
      const backText = await getText(userId, 'back');
      buttons.push([{ text: backText, callback_data: 'admin_manage_redeem_services' }]);
      await bot.sendMessage(userId, 'Select service to delete:', { reply_markup: { inline_keyboard: buttons } });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('delete_redeem_service_') && isAdmin(userId)) {
      const serviceId = parseInt(data.split('_')[3]);
      await RedeemService.destroy({ where: { id: serviceId } });
      await bot.sendMessage(userId, 'Service deleted.');
      await showRedeemServicesAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // إدارة كودات الخصم
    if (data === 'admin_manage_discount_codes' && isAdmin(userId)) {
      await showDiscountCodesAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_add_discount_code' && isAdmin(userId)) {
      await User.update({ state: JSON.stringify({ action: 'add_discount_code', step: 'code' }) }, { where: { id: userId } });
      await bot.sendMessage(userId, await getText(userId, 'enterDiscountCodeValue'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_delete_discount_code' && isAdmin(userId)) {
      const codes = await DiscountCode.findAll();
      const buttons = [];
      for (const c of codes) {
        buttons.push([{ text: `${c.code} (${c.discountPercent}%)`, callback_data: `delete_discount_code_${c.id}` }]);
      }
      const backText = await getText(userId, 'back');
      buttons.push([{ text: backText, callback_data: 'admin_manage_discount_codes' }]);
      await bot.sendMessage(userId, 'Select discount code to delete:', { reply_markup: { inline_keyboard: buttons } });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('delete_discount_code_') && isAdmin(userId)) {
      const codeId = parseInt(data.split('_')[3]);
      await DiscountCode.destroy({ where: { id: codeId } });
      await bot.sendMessage(userId, await getText(userId, 'discountCodeDeleted'));
      await showDiscountCodesAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // تعديل تاجر
    if (data === 'admin_edit_merchant' && isAdmin(userId)) {
      const merchants = await Merchant.findAll();
      const buttons = [];
      for (const m of merchants) {
        buttons.push([{ text: `${m.nameEn} (ID: ${m.id})`, callback_data: `edit_merchant_${m.id}` }]);
      }
      const backText = await getText(userId, 'back');
      buttons.push([{ text: backText, callback_data: 'admin_list_merchants' }]);
      await bot.sendMessage(userId, 'Select merchant to edit:', { reply_markup: { inline_keyboard: buttons } });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('edit_merchant_') && isAdmin(userId)) {
      const merchantId = parseInt(data.split('_')[2]);
      await User.update({ state: JSON.stringify({ action: 'edit_merchant', merchantId, step: 'nameEn' }) }, { where: { id: userId } });
      await bot.sendMessage(userId, 'Send new English name (or /skip):');
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // حذف تاجر
    if (data === 'admin_delete_merchant' && isAdmin(userId)) {
      const merchants = await Merchant.findAll();
      const buttons = [];
      for (const m of merchants) {
        buttons.push([{ text: `${m.nameEn} (ID: ${m.id})`, callback_data: `delete_merchant_${m.id}` }]);
      }
      const backText = await getText(userId, 'back');
      buttons.push([{ text: backText, callback_data: 'admin_list_merchants' }]);
      await bot.sendMessage(userId, 'Select merchant to delete:', { reply_markup: { inline_keyboard: buttons } });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('delete_merchant_') && isAdmin(userId)) {
      const merchantId = parseInt(data.split('_')[2]);
      await User.update({ state: JSON.stringify({ action: 'confirm_delete_merchant', merchantId }) }, { where: { id: userId } });
      const yesText = await getText(userId, 'yes');
      const noText = await getText(userId, 'no');
      await bot.sendMessage(userId, await getText(userId, 'confirmDelete'), {
        reply_markup: {
          inline_keyboard: [
            [{ text: yesText, callback_data: `confirm_delete_merchant_yes_${merchantId}` }],
            [{ text: noText, callback_data: 'admin_list_merchants' }]
          ]
        }
      });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('confirm_delete_merchant_yes_') && isAdmin(userId)) {
      const merchantId = parseInt(data.split('_')[4]);
      await Merchant.destroy({ where: { id: merchantId } });
      await bot.sendMessage(userId, await getText(userId, 'merchantDeleted'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // تعديل التصنيف
    if (data === 'admin_edit_category' && isAdmin(userId)) {
      const merchants = await Merchant.findAll();
      const buttons = [];
      for (const m of merchants) {
        buttons.push([{ text: `${m.nameEn} (ID: ${m.id})`, callback_data: `edit_category_${m.id}` }]);
      }
      const backText = await getText(userId, 'back');
      buttons.push([{ text: backText, callback_data: 'admin_list_merchants' }]);
      await bot.sendMessage(userId, 'Select merchant to edit category:', { reply_markup: { inline_keyboard: buttons } });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('edit_category_') && isAdmin(userId)) {
      const merchantId = parseInt(data.split('_')[2]);
      await User.update({ state: JSON.stringify({ action: 'edit_category', merchantId }) }, { where: { id: userId } });
      await bot.sendMessage(userId, await getText(userId, 'askCategory'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // إضافة طريقة دفع
    if (data === 'admin_add_payment' && isAdmin(userId)) {
      await User.update({ state: JSON.stringify({ action: 'add_payment_method', step: 'nameEn' }) }, { where: { id: userId } });
      await bot.sendMessage(userId, 'Send payment method name in English:');
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // حذف طريقة دفع
    if (data === 'admin_delete_payment' && isAdmin(userId)) {
      const methods = await PaymentMethod.findAll();
      const buttons = [];
      for (const m of methods) {
        buttons.push([{ text: `${m.nameEn} (ID: ${m.id})`, callback_data: `delete_payment_${m.id}` }]);
      }
      const backText = await getText(userId, 'back');
      buttons.push([{ text: backText, callback_data: 'admin_payment_methods' }]);
      await bot.sendMessage(userId, 'Select payment method to delete:', { reply_markup: { inline_keyboard: buttons } });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('delete_payment_') && isAdmin(userId)) {
      const paymentId = parseInt(data.split('_')[2]);
      await PaymentMethod.destroy({ where: { id: paymentId } });
      await bot.sendMessage(userId, 'Payment method deleted.');
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // تعيين حدود الإيداع
    if (data === 'admin_set_limits' && isAdmin(userId)) {
      const methods = await PaymentMethod.findAll();
      const buttons = [];
      for (const m of methods) {
        buttons.push([{ text: `${m.nameEn} (ID: ${m.id})`, callback_data: `set_limits_${m.id}` }]);
      }
      const backText = await getText(userId, 'back');
      buttons.push([{ text: backText, callback_data: 'admin_payment_methods' }]);
      await bot.sendMessage(userId, 'Select payment method to set limits:', { reply_markup: { inline_keyboard: buttons } });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('set_limits_') && isAdmin(userId)) {
      const methodId = parseInt(data.split('_')[2]);
      await User.update({ state: JSON.stringify({ action: 'set_limits', methodId, step: 'min' }) }, { where: { id: userId } });
      await bot.sendMessage(userId, 'Enter minimum deposit amount (USD):');
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // معالجة اختيار نوع التاجر (فردي/جملة)
    if (data === 'merchant_type_single' || data === 'merchant_type_bulk') {
      const userState = await User.findByPk(userId);
      if (userState && userState.state) {
        let stateObj = JSON.parse(userState.state);
        if (stateObj.action === 'add_merchant' && stateObj.step === 'type') {
          const selectedType = data === 'merchant_type_single' ? 'single' : 'bulk';
          await User.update({ state: JSON.stringify({ ...stateObj, selectedType, step: 'description' }) }, { where: { id: userId } });
          await bot.sendMessage(userId, await getText(userId, 'askDescription'));
          await bot.answerCallbackQuery(query.id);
          return;
        }
      }
    }

    // ChatGPT
    if (data === 'chatgpt_code') {
      const user = await User.findByPk(userId);
      if (!user.freeChatgptReceived) {
        await User.update({ state: JSON.stringify({ action: 'chatgpt_free_email' }) }, { where: { id: userId } });
        await bot.sendMessage(userId, await getText(userId, 'askEmail'));
      } else {
        await User.update({ state: JSON.stringify({ action: 'chatgpt_buy_quantity' }) }, { where: { id: userId } });
        await bot.sendMessage(userId, await getText(userId, 'askQuantity'));
      }
      await bot.answerCallbackQuery(query.id);
      return;
    }

    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    console.error('Callback error:', err);
    await bot.answerCallbackQuery(query.id, { text: 'Error occurred' });
  }
});

// ========================
// 7. معالجة الرسائل النصية والصور
// ========================
bot.on('message', async (msg) => {
  const userId = msg.chat.id;
  const text = msg.text;
  const photo = msg.photo;
  const video = msg.video;

  try {
    const user = await User.findByPk(userId);
    if (!user) return;

    let state = user.state ? JSON.parse(user.state) : null;

    // معالجة إدخالات الأدمن (إعدادات القناة)
    if (state && isAdmin(userId)) {
      if (state.action === 'set_channel_link') {
        const config = await getChannelConfig();
        config.link = text;
        await config.save();
        await bot.sendMessage(userId, await getText(userId, 'channelLinkSet'));
        await showChannelConfigAdmin(userId);
        await User.update({ state: null }, { where: { id: userId } });
        return;
      }
      if (state.action === 'set_channel_message') {
        const config = await getChannelConfig();
        config.messageText = text;
        await config.save();
        await bot.sendMessage(userId, await getText(userId, 'channelMessageSet'));
        await showChannelConfigAdmin(userId);
        await User.update({ state: null }, { where: { id: userId } });
        return;
      }
    }

    // معالجة إجابة الكابتشا
    if (!user.verified) {
      const captcha = await Captcha.findByPk(userId);
      if (captcha) {
        const isValid = await verifyCaptcha(userId, text);
        if (isValid) {
          await handleVerificationSuccess(userId);
          return;
        } else {
          await bot.sendMessage(userId, await getText(userId, 'captchaWrong'));
          // إعادة إرسال التحدي الجديد
          const newChallenge = await createCaptcha(userId);
          await bot.sendMessage(userId, await getText(userId, 'captchaChallenge', { challenge: newChallenge }));
          return;
        }
      } else {
        // إذا لم يكن هناك كابتشا والتحقق من القناة ناجح، ننشئ كابتشا
        const isMember = await checkChannelMembership(userId);
        if (isMember) {
          const challenge = await createCaptcha(userId);
          await bot.sendMessage(userId, await getText(userId, 'captchaChallenge', { challenge }));
          return;
        } else {
          await sendJoinChannelMessage(userId);
          return;
        }
      }
    }

    // معالجة الرد على الدعم (من الأدمن)
    if (state && state.action === 'support_reply' && isAdmin(userId)) {
      const targetUserId = state.targetUserId;
      let replyMsg = text || '';
      let fileId = null;
      if (photo) fileId = photo[photo.length - 1].file_id;
      else if (video) fileId = video.file_id;

      const supportReplyText = await getText(userId, 'replyMessage') + `\n\n${replyMsg}`;
      if (fileId) {
        if (photo) await bot.sendPhoto(targetUserId, fileId, { caption: supportReplyText });
        else await bot.sendVideo(targetUserId, fileId, { caption: supportReplyText });
      } else {
        await bot.sendMessage(targetUserId, supportReplyText);
      }
      const replyButton = {
        inline_keyboard: [[{ text: await getText(targetUserId, 'replyToSupport'), callback_data: `support_reply_user_${userId}` }]]
      };
      await bot.sendMessage(targetUserId, await getText(targetUserId, 'replyToSupport'), { reply_markup: replyButton });
      await bot.sendMessage(userId, await getText(userId, 'supportReplySent'));
      await User.update({ state: null }, { where: { id: userId } });
      return;
    }

    // معالجة رد المستخدم على الدعم (من مستخدم عادي)
    if (state && state.action === 'support_reply_user') {
      const targetAdminId = state.targetAdminId;
      let supportText = text || '';
      let photoFileId = null;
      if (photo) photoFileId = photo[photo.length - 1].file_id;

      const notifText = await getText(targetAdminId, 'supportNotification', { userId, message: supportText });
      if (photoFileId) {
        await bot.sendPhoto(targetAdminId, photoFileId, { caption: notifText });
      } else {
        await bot.sendMessage(targetAdminId, notifText);
      }
      await bot.sendMessage(userId, await getText(userId, 'supportMessageSent'));
      await User.update({ state: null }, { where: { id: userId } });
      return;
    }

    // معالجة إدخالات الأدمن (إعدادات البوت، إضافة تاجر، الخ)
    if (state && isAdmin(userId)) {
      if (state.action === 'add_bot' && state.step === 'token') {
        try {
          const testBot = new TelegramBot(text, { polling: false });
          const me = await testBot.getMe();
          const botName = me.username;
          await BotService.create({
            token: text,
            name: botName,
            allowedActions: []
          });
          await bot.sendMessage(userId, await getText(userId, 'botAdded'));
          await showBotsList(userId);
        } catch {
          await bot.sendMessage(userId, '❌ Invalid token');
        }
        await User.update({ state: null }, { where: { id: userId } });
        return;
      }

      if (state.action === 'set_bot_owner') {
        const ownerId = parseInt(text);
        if (isNaN(ownerId)) {
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
        await User.update({ state: null }, { where: { id: userId } });
        return;
      }

      if (state.action === 'add_merchant') {
        if (state.step === 'nameEn') {
          await User.update({ state: JSON.stringify({ ...state, nameEn: text, step: 'nameAr' }) }, { where: { id: userId } });
          await bot.sendMessage(userId, await getText(userId, 'askMerchantNameAr'));
          return;
        } else if (state.step === 'nameAr') {
          await User.update({ state: JSON.stringify({ ...state, nameAr: text, step: 'price' }) }, { where: { id: userId } });
          await bot.sendMessage(userId, await getText(userId, 'askMerchantPrice'));
          return;
        } else if (state.step === 'price') {
          const price = parseFloat(text);
          if (isNaN(price)) {
            await bot.sendMessage(userId, '❌ Invalid price');
            return;
          }
          await User.update({ state: JSON.stringify({ ...state, price, step: 'type' }) }, { where: { id: userId } });
          const typeSingleText = await getText(userId, 'typeSingle');
          const typeBulkText = await getText(userId, 'typeBulk');
          const keyboard = {
            inline_keyboard: [
              [{ text: typeSingleText, callback_data: 'merchant_type_single' }],
              [{ text: typeBulkText, callback_data: 'merchant_type_bulk' }]
            ]
          };
          await bot.sendMessage(userId, await getText(userId, 'askMerchantType'), { reply_markup: keyboard });
          return;
        } else if (state.step === 'description') {
          let description = null;
          if (text === '/skip') {
            description = null;
          } else if (text) {
            description = { type: 'text', content: text };
          } else if (photo) {
            description = { type: 'photo', fileId: photo[photo.length - 1].file_id };
          } else if (video) {
            description = { type: 'video', fileId: video.file_id };
          } else {
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
          await User.update({ state: null }, { where: { id: userId } });
          await showAdminPanel(userId);
          return;
        }
      }

      if (state.action === 'set_price') {
        const price = parseFloat(text);
        if (isNaN(price)){
          await bot.sendMessage(userId, '❌ Invalid price');
          return;
        }
        await Merchant.update({ price }, { where: { id: state.merchantId } });
        await bot.sendMessage(userId, await getText(userId, 'priceUpdated'));
        await User.update({ state: null }, { where: { id: userId } });
        await showAdminPanel(userId);
        return;
      }

      if (state.action === 'add_codes') {
        const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
        const merchant = await Merchant.findByPk(state.merchantId);
        if (!merchant) {
          await bot.sendMessage(userId, 'Merchant not found');
          await User.update({ state: null }, { where: { id: userId } });
          return;
        }
        if (merchant.type === 'single') {
          const codes = lines.map(value => ({ value, merchantId: merchant.id, isUsed: false }));
          await Code.bulkCreate(codes);
        } else { // bulk
          if (lines.length % 2 !== 0) {
            await bot.sendMessage(userId, '❌ Bulk codes must be sent as pairs (email and password on separate lines). Please send an even number of lines.');
            return;
          }
          const pairs = [];
          for (let i = 0; i < lines.length; i += 2) {
            pairs.push({
              value: lines[i],
              extra: lines[i+1],
              merchantId: merchant.id,
              isUsed: false
            });
          }
          await Code.bulkCreate(pairs);
        }
        await bot.sendMessage(userId, await getText(userId, 'codesAdded'));
        await User.update({ state: null }, { where: { id: userId } });
        await showAdminPanel(userId);
        return;
      }

      if (state.action === 'edit_merchant') {
        const merchant = await Merchant.findByPk(state.merchantId);
        if (!merchant) {
          await bot.sendMessage(userId, 'Merchant not found');
          await User.update({ state: null }, { where: { id: userId } });
          return;
        }
        if (state.step === 'nameEn') {
          if (text !== '/skip') merchant.nameEn = text;
          await User.update({ state: JSON.stringify({ ...state, step: 'nameAr' }) }, { where: { id: userId } });
          await bot.sendMessage(userId, 'Send new Arabic name (or /skip):');
          return;
        } else if (state.step === 'nameAr') {
          if (text !== '/skip') merchant.nameAr = text;
          await User.update({ state: JSON.stringify({ ...state, step: 'price' }) }, { where: { id: userId } });
          await bot.sendMessage(userId, 'Send new price (or /skip):');
          return;
        } else if (state.step === 'price') {
          if (text !== '/skip') {
            const price = parseFloat(text);
            if (!isNaN(price)) merchant.price = price;
          }
          await merchant.save();
          await bot.sendMessage(userId, 'Merchant updated successfully.');
          await User.update({ state: null }, { where: { id: userId } });
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
        await User.update({ state: null }, { where: { id: userId } });
        await showAdminPanel(userId);
        return;
      }

      if (state.action === 'add_payment_method') {
        if (state.step === 'nameEn') {
          await User.update({ state: JSON.stringify({ ...state, nameEn: text, step: 'nameAr' }) }, { where: { id: userId } });
          await bot.sendMessage(userId, 'Send name in Arabic:');
          return;
        } else if (state.step === 'nameAr') {
          await User.update({ state: JSON.stringify({ ...state, nameAr: text, step: 'details' }) }, { where: { id: userId } });
          await bot.sendMessage(userId, 'Send payment details (e.g., wallet address):');
          return;
        } else if (state.step === 'details') {
          await User.update({ state: JSON.stringify({ ...state, details: text, step: 'type' }) }, { where: { id: userId } });
          await bot.sendMessage(userId, 'Send type (manual/auto):');
          return;
        } else if (state.step === 'type') {
          const type = text.toLowerCase();
          if (type !== 'manual' && type !== 'auto') {
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
          await User.update({ state: null }, { where: { id: userId } });
          await showAdminPanel(userId);
          return;
        }
      }

      if (state.action === 'set_limits') {
        if (state.step === 'min') {
          const min = parseFloat(text);
          if (isNaN(min)) {
            await bot.sendMessage(userId, 'Invalid number');
            return;
          }
          await User.update({ state: JSON.stringify({ ...state, min, step: 'max' }) }, { where: { id: userId } });
          await bot.sendMessage(userId, 'Enter maximum deposit amount (USD):');
          return;
        } else if (state.step === 'max') {
          const max = parseFloat(text);
          if (isNaN(max)) {
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
          await User.update({ state: null }, { where: { id: userId } });
          await showAdminPanel(userId);
          return;
        }
      }

      if (state.action === 'set_referral_percent') {
        const percent = parseFloat(text);
        if (isNaN(percent)) {
          await bot.sendMessage(userId, 'Invalid percentage');
          return;
        }
        process.env.REFERRAL_PERCENT = percent;
        await Setting.upsert({ key: 'referral_percent', lang: 'en', value: percent.toString() });
        await bot.sendMessage(userId, await getText(userId, 'referralPercentUpdated', { percent }));
        await User.update({ state: null }, { where: { id: userId } });
        await showAdminPanel(userId);
        return;
      }

      if (state.action === 'add_redeem_service') {
        if (state.step === 'nameEn') {
          await User.update({ state: JSON.stringify({ ...state, nameEn: text, step: 'nameAr' }) }, { where: { id: userId } });
          await bot.sendMessage(userId, await getText(userId, 'redeemServiceNameAr'));
          return;
        } else if (state.step === 'nameAr') {
          await User.update({ state: JSON.stringify({ ...state, nameAr: text, step: 'merchantDictId' }) }, { where: { id: userId } });
          await bot.sendMessage(userId, await getText(userId, 'redeemServiceMerchantId'));
          return;
        } else if (state.step === 'merchantDictId') {
          await User.update({ state: JSON.stringify({ ...state, merchantDictId: text, step: 'platformId' }) }, { where: { id: userId } });
          await bot.sendMessage(userId, await getText(userId, 'redeemServicePlatformId'));
          return;
        } else if (state.step === 'platformId') {
          const platformId = text || '1';
          await RedeemService.create({
            nameEn: state.nameEn,
            nameAr: state.nameAr,
            merchantDictId: state.merchantDictId,
            platformId
          });
          await bot.sendMessage(userId, await getText(userId, 'redeemServiceAdded'));
          await User.update({ state: null }, { where: { id: userId } });
          await showRedeemServicesAdmin(userId);
          return;
        }
      }

      if (state.action === 'add_discount_code') {
        if (state.step === 'code') {
          await User.update({ state: JSON.stringify({ ...state, code: text, step: 'percent' }) }, { where: { id: userId } });
          await bot.sendMessage(userId, await getText(userId, 'enterDiscountPercent'));
          return;
        } else if (state.step === 'percent') {
          const percent = parseInt(text);
          if (isNaN(percent) || percent < 0 || percent > 100) {
            await bot.sendMessage(userId, 'Invalid percentage (0-100)');
            return;
          }
          await User.update({ state: JSON.stringify({ ...state, percent, step: 'validUntil' }) }, { where: { id: userId } });
          await bot.sendMessage(userId, await getText(userId, 'enterDiscountValidUntil'));
          return;
        } else if (state.step === 'validUntil') {
          let validUntil = null;
          if (text !== '/skip') {
            const date = new Date(text);
            if (isNaN(date.getTime())) {
              await bot.sendMessage(userId, 'Invalid date format. Use YYYY-MM-DD or /skip.');
              return;
            }
            validUntil = date;
          }
          await User.update({ state: JSON.stringify({ ...state, validUntil, step: 'maxUses' }) }, { where: { id: userId } });
          await bot.sendMessage(userId, await getText(userId, 'enterDiscountMaxUses'));
          return;
        } else if (state.step === 'maxUses') {
          const maxUses = parseInt(text);
          if (isNaN(maxUses) || maxUses < 1) {
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
          await User.update({ state: null }, { where: { id: userId } });
          await showDiscountCodesAdmin(userId);
          return;
        }
      }

      // إعدادات الشحن (الأدمن)
      if (state.action === 'set_iqd_rate') {
        const rate = parseFloat(text);
        if (isNaN(rate) || rate <= 0) {
          await bot.sendMessage(userId, 'Invalid rate');
          return;
        }
        await updateDepositConfig('IQD', 'rate', rate);
        await bot.sendMessage(userId, await getText(userId, 'rateSet'));
        await User.update({ state: null }, { where: { id: userId } });
        await showDepositSettingsAdmin(userId);
        return;
      }
      if (state.action === 'set_usdt_wallet') {
        await updateDepositConfig('USD', 'walletAddress', text);
        await bot.sendMessage(userId, await getText(userId, 'walletSet'));
        await User.update({ state: null }, { where: { id: userId } });
        await showDepositSettingsAdmin(userId);
        return;
      }
      if (state.action === 'set_iqd_wallet') {
        await updateDepositConfig('IQD', 'walletAddress', text);
        await bot.sendMessage(userId, await getText(userId, 'walletSet'));
        await User.update({ state: null }, { where: { id: userId } });
        await showDepositSettingsAdmin(userId);
        return;
      }
      if (state.action === 'edit_currency_name') {
        const currency = state.currency;
        const newName = text;
        const key = currency === 'USD' ? 'currency_usd_name' : 'currency_iqd_name';
        const lang = user.lang;
        await Setting.upsert({ key, lang, value: newName });
        await bot.sendMessage(userId, await getText(userId, 'currencyNameUpdated'));
        await User.update({ state: null }, { where: { id: userId } });
        await showDepositSettingsAdmin(userId);
        return;
      }
      if (state.action === 'edit_deposit_instructions') {
        const currency = state.currency;
        const newInstructions = text;
        await updateDepositConfig(currency, 'instructions', newInstructions);
        await bot.sendMessage(userId, await getText(userId, 'instructionsSet'));
        await User.update({ state: null }, { where: { id: userId } });
        await showDepositSettingsAdmin(userId);
        return;
      }
    }

    // معالجة الدعم (إرسال رسالة من المستخدم)
    if (state && state.action === 'support') {
      let supportText = text || '';
      let photoFileId = null;
      if (photo) photoFileId = photo[photo.length - 1].file_id;
      const notifText = await getText(ADMIN_ID, 'supportNotification', { userId, message: supportText });
      if (photoFileId) {
        await bot.sendPhoto(ADMIN_ID, photoFileId, { caption: notifText });
      } else {
        await bot.sendMessage(ADMIN_ID, notifText);
      }
      const replyButton = {
        inline_keyboard: [[{ text: await getText(ADMIN_ID, 'replyToSupport'), callback_data: `support_reply_${userId}` }]]
      };
      await bot.sendMessage(ADMIN_ID, await getText(ADMIN_ID, 'replyToSupport'), { reply_markup: replyButton });
      await bot.sendMessage(userId, await getText(userId, 'supportMessageSent'));
      await User.update({ state: null }, { where: { id: userId } });
      return;
    }

    // معالجة كود الخصم
    if (state && state.action === 'discount') {
      const discountCode = text.trim();
      const discount = await DiscountCode.findOne({ where: { code: discountCode } });
      if (discount && (discount.validUntil === null || discount.validUntil > new Date()) && discount.usedCount < discount.maxUses) {
        await User.update({ state: JSON.stringify({ action: 'discount_applied', discountCode }) }, { where: { id: userId } });
        await bot.sendMessage(userId, await getText(userId, 'discountApplied', { percent: discount.discountPercent }));
        await sendMainMenu(userId);
      } else {
        await bot.sendMessage(userId, await getText(userId, 'discountInvalid'));
        await sendMainMenu(userId);
      }
      await User.update({ state: null }, { where: { id: userId } });
      return;
    }

    // معالجة الشراء (إدخال الكمية)
    if (state && state.action === 'buy') {
      const qty = parseInt(text);
      if (isNaN(qty) || qty <= 0) {
        await bot.sendMessage(userId, '❌ Invalid quantity.');
        return;
      }
      const merchant = await Merchant.findByPk(state.merchantId);
      if (!merchant) {
        await bot.sendMessage(userId, 'Merchant not found');
        return;
      }
      const available = await Code.count({ where: { merchantId: merchant.id, isUsed: false } });
      if (qty > available) {
        await bot.sendMessage(userId, (await getText(userId, 'noCodes')) + ` Available: ${available}`);
        return;
      }
      let discountCode = null;
      if (user.state && user.state.includes('discount_applied')) {
        const stateObj = JSON.parse(user.state);
        discountCode = stateObj.discountCode;
      }
      const result = await processPurchase(userId, merchant.id, qty, discountCode);
      if (result.success) {
        let msg = await getText(userId, 'success');
        if (result.discountApplied) {
          msg += `\n🎟️ Discount applied: ${result.discountApplied}%`;
        }
        msg += `\n\n${result.codes}`;
        await bot.sendMessage(userId, msg);
        const userObj = await User.findByPk(userId);
        if (userObj.referredBy) {
          const rewardAmount = (merchant.price * qty) * (process.env.REFERRAL_PERCENT || 10) / 100;
          await BalanceTransaction.create({
            userId: userObj.referredBy,
            amount: rewardAmount,
            type: 'referral',
            status: 'completed'
          });
          const referrer = await User.findByPk(userObj.referredBy);
          await User.update({ balance: parseFloat(referrer.balance) + rewardAmount }, { where: { id: referrer.id } });
          await bot.sendMessage(referrer.id, await getText(referrer.id, 'referralEarned', { amount: rewardAmount }));
        }
      } else {
        await bot.sendMessage(userId, await getText(userId, 'error') + `: ${result.reason}`);
      }
      await User.update({ state: null }, { where: { id: userId } });
      await sendMainMenu(userId);
      return;
    }

    // معالجة إدخال المبلغ للشحن
    if (state && state.action === 'deposit_amount') {
      const amount = parseFloat(text);
      if (isNaN(amount) || amount <= 0) {
        await bot.sendMessage(userId, '❌ Invalid amount');
        return;
      }
      const currency = state.currency;
      await showPaymentMethodsForDeposit(userId, amount, currency);
      return;
    }

    // معالجة استلام إثبات الدفع (صورة + نص اختياري)
    if (state && state.action === 'deposit_awaiting_proof') {
      const amount = state.amount;
      const currency = state.currency;
      let imageFileId = null;
      let caption = text || '';
      if (photo) {
        imageFileId = photo[photo.length - 1].file_id;
      } else {
        // إذا لم تكن صورة، لا نرد (لأن التعليمات قالت أرسل صورة)
        return;
      }
      await requestDeposit(userId, amount, currency, caption, imageFileId);
      await bot.sendMessage(userId, await getText(userId, 'depositProofReceived'));
      await User.update({ state: null }, { where: { id: userId } });
      await sendMainMenu(userId);
      return;
    }

    // معالجة الاسترداد عبر الخدمات
    if (state && state.action === 'redeem_via_service') {
      const serviceId = state.serviceId;
      const service = await RedeemService.findByPk(serviceId);
      if (!service) {
        await bot.sendMessage(userId, 'Service not found');
        await sendMainMenu(userId);
        await User.update({ state: null }, { where: { id: userId } });
        return;
      }

      const cardCode = text.trim();
      const waitingMsg = await bot.sendMessage(userId, await getText(userId, 'processing'));
      const result = await redeemCard(cardCode, service.merchantDictId, service.platformId);

      await bot.deleteMessage(userId, waitingMsg.message_id).catch(() => {});

      if (result.success) {
        const cardDetails = formatCardDetails(result.data);
        const successMsg = await getText(userId, 'redeemSuccess', { details: cardDetails });
        await bot.sendMessage(userId, successMsg);
      } else {
        const failMsg = await getText(userId, 'redeemFailed', { reason: result.reason });
        await bot.sendMessage(userId, failMsg);
      }

      await User.update({ state: null }, { where: { id: userId } });
      await sendMainMenu(userId);
      return;
    }

    if (state && state.action === 'redeem_smart') {
      const cardCode = text.trim();
      const waitingMsg = await bot.sendMessage(userId, await getText(userId, 'processing'));

      const result = await redeemCardSmart(cardCode);

      await bot.deleteMessage(userId, waitingMsg.message_id).catch(() => {});

      if (result.success) {
        const cardDetails = formatCardDetails(result.data);
        const serviceName = result.service ? `${result.service.nameEn} / ${result.service.nameAr}` : 'Auto';
        const successMsg = await getText(userId, 'redeemSuccess', {
          details: `${cardDetails}\n\n🏪 Selected Service: ${serviceName}`
        });
        await bot.sendMessage(userId, successMsg);
      } else {
        const failMsg = await getText(userId, 'redeemFailed', { reason: result.reason });
        await bot.sendMessage(userId, failMsg);
      }

      await User.update({ state: null }, { where: { id: userId } });
      await sendMainMenu(userId);
      return;
    }

    // معالجة ChatGPT
    if (state && state.action === 'chatgpt_free_email') {
      const email = text.trim();
      if (!email.includes('@')) {
        await bot.sendMessage(userId, '❌ Invalid email format. Please send a valid email.');
        return;
      }
      const result = await getChatGPTCode(email);
      if (result.success) {
        await User.update({ freeChatgptReceived: true, state: null }, { where: { id: userId } });
        await bot.sendMessage(userId, await getText(userId, 'freeCodeSuccess', { code: result.code }));
      } else {
        await bot.sendMessage(userId, await getText(userId, 'error') + `: ${result.reason}`);
        await User.update({ state: null }, { where: { id: userId } });
      }
      await sendMainMenu(userId);
      return;
    }

    if (state && state.action === 'chatgpt_buy_quantity') {
      const qty = parseInt(text);
      if (isNaN(qty) || qty !== 1) {
        await bot.sendMessage(userId, await getText(userId, 'invalidQuantity'));
        return;
      }
      await User.update({ state: JSON.stringify({ action: 'chatgpt_buy_email', quantity: qty }) }, { where: { id: userId } });
      await bot.sendMessage(userId, await getText(userId, 'enterEmailForPurchase'));
      return;
    }

    if (state && state.action === 'chatgpt_buy_email') {
      const email = text.trim();
      if (!email.includes('@')) {
        await bot.sendMessage(userId, '❌ Invalid email format.');
        return;
      }
      const userObj = await User.findByPk(userId);
      const merchant = await Merchant.findOne({ where: { nameEn: 'ChatGPT Code' } });
      if (!merchant) {
        await bot.sendMessage(userId, '❌ ChatGPT merchant not found. Contact admin.');
        await User.update({ state: null }, { where: { id: userId } });
        await sendMainMenu(userId);
        return;
      }
      const price = merchant.price;
      const currentBalance = parseFloat(userObj.balance);
      if (currentBalance < price) {
        await bot.sendMessage(userId, await getText(userId, 'insufficientBalance', { balance: currentBalance.toFixed(2), price }));
        await User.update({ state: null }, { where: { id: userId } });
        await sendMainMenu(userId);
        return;
      }
      const result = await getChatGPTCode(email);
      if (result.success) {
        await User.update({ balance: currentBalance - price }, { where: { id: userId } });
        await BalanceTransaction.create({
          userId,
          amount: -price,
          type: 'purchase',
          status: 'completed'
        });
        await bot.sendMessage(userId, await getText(userId, 'purchaseSuccess', { code: result.code }));
      } else {
        await bot.sendMessage(userId, await getText(userId, 'error') + `: ${result.reason}`);
      }
      await User.update({ state: null }, { where: { id: userId } });
      await sendMainMenu(userId);
      return;
    }
  } catch (err) {
    console.error('Message handler error:', err);
    await bot.sendMessage(userId, 'An error occurred. Please try again later.');
  }
});

// ========================
// 8. API للبوتات الأخرى
// ========================
app.post('/api/code', async (req, res) => {
  try {
    const { token, card_key, merchant_dict_id, platform_id } = req.body;

    const botService = await BotService.findOne({ where: { token, isActive: true } });
    if (!botService || !botService.allowedActions.includes('code')) {
      return res.status(403).json({ error: 'Bot not authorized for /code' });
    }

    if (!card_key) {
      return res.status(400).json({ error: 'Missing card_key' });
    }

    let result;

    if (merchant_dict_id) {
      result = await redeemCard(card_key, merchant_dict_id, platform_id || '1');
    } else {
      result = await redeemCardSmart(card_key);
    }

    if (result.success) {
      res.json({
        success: true,
        data: result.data,
        service: result.service
          ? {
              id: result.service.id,
              nameEn: result.service.nameEn,
              nameAr: result.service.nameAr,
              merchantDictId: result.service.merchantDictId
            }
          : null
      });
    } else {
      res.status(400).json({ success: false, error: result.reason });
    }
  } catch (err) {
    console.error('API error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========================
// 9. جدولة المهام باستخدام setInterval
// ========================
setInterval(async () => {
  try {
    const now = new Date();
    const updated = await Code.update(
      { isUsed: true },
      { where: { expiresAt: { [Op.lt]: now }, isUsed: false } }
    );
    if (updated[0] > 0) {
      console.log(`✅ Expired codes marked as used: ${updated[0]} codes`);
    }
  } catch (err) {
    console.error('Error cleaning expired codes:', err);
  }
}, 24 * 60 * 60 * 1000);

// ========================
// 10. تشغيل الخادم ومزامنة قاعدة البيانات
// ========================
sequelize.sync({ alter: true }).then(async () => {
  console.log('✅ Database synced');
  // إنشاء إعدادات الشحن الافتراضية إن لم تكن موجودة
  await getDepositConfig('USD');
  await getDepositConfig('IQD');
  // إنشاء تاجر ChatGPT إذا لم يكن موجوداً
  const chatGptMerchant = await Merchant.findOne({ where: { nameEn: 'ChatGPT Code' } });
  if (!chatGptMerchant) {
    await Merchant.create({
      nameEn: 'ChatGPT Code',
      nameAr: 'كود ChatGPT',
      price: 5.00,
      category: 'AI Services',
      type: 'single',
      description: { type: 'text', content: 'Get a ChatGPT GO code via email' }
    });
    console.log('✅ ChatGPT merchant created with default price 5 USD');
  }
  const PORT = process.env.PORT || 3000;
  app.get('/', (req, res) => res.send('Bot is running'));
  app.listen(PORT, () => console.log(`🚀 Server started on port ${PORT}`));
}).catch(err => {
  console.error('Database error:', err);
  process.exit(1);
});
