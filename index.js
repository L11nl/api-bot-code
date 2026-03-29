require('dotenv').config();

const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const FormData = require('form-data');
const { Sequelize, DataTypes, Op } = require('sequelize');

const TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID, 10);
const DATABASE_URL = process.env.DATABASE_URL;

if (!TOKEN || Number.isNaN(ADMIN_ID) || !DATABASE_URL) {
  console.error('❌ Missing required environment variables');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
const app = express();
app.use(express.json());

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

Merchant.hasMany(Code, { foreignKey: 'merchantId' });
Code.belongsTo(Merchant);
BalanceTransaction.belongsTo(User, { foreignKey: 'userId' });
BalanceTransaction.belongsTo(PaymentMethod);
BotService.hasMany(BotStat, { foreignKey: 'botId' });
BotStat.belongsTo(BotService);
User.hasMany(ReferralReward, { as: 'Referrer', foreignKey: 'referrerId' });
User.hasMany(ReferralReward, { as: 'Referred', foreignKey: 'referredId' });
DiscountCode.belongsTo(User, { as: 'creator', foreignKey: 'createdBy' });

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
    processing: '⏳ Processing...',
    enterQty: '✍️ Enter quantity:',
    noCodes: '❌ Not enough codes in stock',
    back: '🔙 Back',
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
    manageChannel: '📢 Manage Required Channel',
    manageDepositSettings: '💱 Manage Deposit Settings',
    referralSettings: '👥 Referral Settings',
    manageRedeemServices: '🔄 Manage Redeem Services',
    manageDiscountCodes: '🎟️ Manage Discount Codes',
    enterBotToken: 'Send bot token:',
    botAdded: '✅ Bot added!',
    botRemoved: '❌ Bot removed!',
    chooseCurrency: '💱 Choose currency for deposit:',
    currency_usd_name: 'USDT (Tether)',
    currency_iqd_name: 'Iraqi Dinar (IQD)',
    depositInstructionsUSD: '💰 Send {amount} USDT to the following address:\n\n`{address}`\n\nThen send a screenshot of the payment with any message.\n\n{instructions}',
    depositInstructionsIQD: '💰 Send {amountIQD} IQD (≈ {amountUSD} USD at rate {rate} IQD/USD) to the following SuperKey:\n\n`{address}`\n\nThen send a screenshot of the payment with any message.\n\n{instructions}',
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
    referralInfo: 'Share your referral link with friends and earn 1 point per successful referral!\n\nYour referral link: {link}\nYour points: {points}\n🎁 Redeem {requiredPoints} points for a free ChatGPT code!',
    referralEarned: '🎉 You earned 1 referral point! Total points: {points}',
    notEnoughPoints: '❌ You need at least {requiredPoints} points to redeem. You have {points} points.',
    setRedeemPoints: '🎁 Set Redeem Points',
    enterRedeemPoints: 'Enter required points for a free ChatGPT code:',
    redeemPointsUpdated: '✅ Redeem points updated to {points}.',
    currentRedeemPoints: 'Current required points: {points}',
    currentReferralPercent: 'Current referral reward percentage: {percent}%',
    manageReferralSettingsText: '👥 Referral Settings\n\n{percentLine}\n{pointsLine}',
    chatgptCode: '🤖 ChatGPT Code',
    askEmail: 'Please enter your email address:',
    freeCodeSuccess: '🎉 Here is your free ChatGPT GO code:\n\n{code}',
    alreadyGotFree: 'You have already received your free code. You can purchase more codes.',
    askQuantity: 'How many codes would you like to buy? (Max 1 per purchase)',
    enterEmailForPurchase: 'Enter your email to receive the code:',
    purchaseSuccess: '✅ Purchase successful! Here is your ChatGPT GO code:\n\n{code}',
    insufficientBalance: '❌ Insufficient balance. Your balance: {balance} USD. Price per code: {price} USD.',
    invalidQuantity: '❌ Invalid quantity. Please send a number (1 only).',
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
    currencyNameUpdated: '✅ Currency name updated!',
    walletSet: '✅ Wallet address updated!',
    instructionsSet: '✅ Instructions updated!',
    rateSet: '✅ Exchange rate updated!',
    totalCodes: '📦 Total codes in stock: {count}',
    totalSales: '💰 Total sales: {amount} USD',
    pendingDeposits: '⏳ Pending deposits: {count}',
    sendReply: 'Send your message:',
    supportMessageSent: '📨 Your message has been sent to support. You will receive a reply soon.',
    supportNotification: '📩 New support message from user {userId}:\n\n{message}',
    replyToSupport: 'Reply to this user:',
    replyMessage: 'Your reply from support:'
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
    processing: '⏳ جاري المعالجة...',
    enterQty: '✍️ أرسل الكمية:',
    noCodes: '❌ لا يوجد عدد كافٍ من الأكواد في المخزون',
    back: '🔙 رجوع',
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
    manageChannel: '📢 إدارة القناة المطلوبة',
    manageDepositSettings: '💱 إعدادات الشحن',
    referralSettings: '👥 إعدادات الإحالة',
    manageRedeemServices: '🔄 إدارة خدمات الاسترداد',
    manageDiscountCodes: '🎟️ إدارة كودات الخصم',
    enterBotToken: 'أرسل توكن البوت:',
    botAdded: '✅ تمت إضافة البوت!',
    botRemoved: '❌ تم حذف البوت!',
    chooseCurrency: '💱 اختر العملة للشحن:',
    currency_usd_name: 'تيثر USDT',
    currency_iqd_name: 'دينار عراقي (IQD)',
    depositInstructionsUSD: '💰 قم بإرسال {amount} USDT إلى العنوان التالي:\n\n`{address}`\n\nثم أرسل صورة التحويل مع أي رسالة.\n\n{instructions}',
    depositInstructionsIQD: '💰 قم بإرسال {amountIQD} دينار عراقي (≈ {amountUSD} دولار بسعر صرف {rate} دينار/دولار) إلى السوبر كي التالي:\n\n`{address}`\n\nثم أرسل صورة التحويل مع أي رسالة.\n\n{instructions}',
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
    referralInfo: 'شارك رابط الإحالة الخاص بك مع أصدقائك واربح نقطة واحدة لكل إحالة ناجحة!\n\nرابطك: {link}\nنقاطك: {points}\n🎁 استبدل {requiredPoints} نقاط للحصول على كود ChatGPT مجاناً!',
    referralEarned: '🎉 لقد ربحت نقطة إحالة! إجمالي النقاط: {points}',
    notEnoughPoints: '❌ تحتاج على الأقل {requiredPoints} نقاط للاستبدال. لديك {points} نقطة.',
    setRedeemPoints: '🎁 تعيين نقاط الاستبدال',
    enterRedeemPoints: 'أدخل عدد النقاط المطلوبة للحصول على كود ChatGPT مجاني:',
    redeemPointsUpdated: '✅ تم تحديث نقاط الاستبدال إلى {points}.',
    currentRedeemPoints: 'عدد النقاط المطلوبة حالياً: {points}',
    currentReferralPercent: 'نسبة مكافأة الإحالة الحالية: {percent}%',
    manageReferralSettingsText: '👥 إعدادات الإحالة\n\n{percentLine}\n{pointsLine}',
    chatgptCode: '🤖 كود ChatGPT',
    askEmail: 'يرجى إدخال بريدك الإلكتروني:',
    freeCodeSuccess: '🎉 إليك كود ChatGPT GO المجاني:\n\n{code}',
    alreadyGotFree: 'لقد حصلت بالفعل على كودك المجاني. يمكنك شراء أكواد إضافية.',
    askQuantity: 'كم عدد الأكواد التي تريد شراءها؟ (واحد فقط)',
    enterEmailForPurchase: 'أدخل بريدك الإلكتروني لاستلام الكود:',
    purchaseSuccess: '✅ تم الشراء بنجاح! إليك كود ChatGPT GO:\n\n{code}',
    insufficientBalance: '❌ رصيد غير كاف. رصيدك: {balance} دولار. سعر الكود: {price} دولار.',
    invalidQuantity: '❌ كمية غير صالحة. يرجى إرسال رقم (1 فقط).',
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
    supportNotification: '📩 رسالة دعم جديدة من المستخدم {userId}:\n\n{message}',
    replyToSupport: 'رد على هذا المستخدم:',
    replyMessage: 'ردك من الدعم الفني:'
  }
};

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

async function getGlobalSetting(key, defaultValue) {
  const setting = await Setting.findOne({ where: { key, lang: 'global' } });
  if (!setting) return defaultValue;
  return setting.value;
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

async function getUserReferralLink(userId) {
  const botInfo = await bot.getMe();
  const publicUsername = process.env.PUBLIC_BOT_USERNAME || botInfo.username;
  return `https://t.me/${publicUsername}?start=${userId}`;
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
  const referred = await User.findByPk(referredUserId);
  if (!referred || !referred.referredBy || referred.referralRewarded) return false;

  const referrer = await User.findByPk(referred.referredBy);
  if (!referrer) return false;

  referrer.referralPoints += 1;
  await referrer.save();

  referred.referralRewarded = true;
  await referred.save();

  await bot.sendMessage(referrer.id, await getText(referrer.id, 'referralEarned', {
    points: referrer.referralPoints
  }));

  return true;
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

  if (user.referredBy && !user.referralRewarded) {
    await awardReferralPoints(userId);
  }

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
  chatgpt_code: true
};

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

async function showMenuButtonsAdmin(userId) {
  const visibility = await getMenuButtonsVisibility();
  const items = [
    { id: 'redeem', name: await getText(userId, 'redeem') },
    { id: 'buy', name: await getText(userId, 'buy') },
    { id: 'my_balance', name: await getText(userId, 'myBalance') },
    { id: 'deposit', name: await getText(userId, 'deposit') },
    { id: 'referral', name: await getText(userId, 'referral') },
    { id: 'discount', name: '🎟️ Discount' },
    { id: 'my_purchases', name: await getText(userId, 'myPurchases') },
    { id: 'support', name: await getText(userId, 'support') },
    { id: 'chatgpt_code', name: await getText(userId, 'chatgptCode') }
  ];

  const keyboard = [];
  for (const item of items) {
    const enabled = visibility[item.id] !== false;
    const action = enabled ? 'hide' : 'show';
    keyboard.push([{
      text: `${enabled ? '✅' : '❌'} ${item.name}`,
      callback_data: `toggle_button_${item.id}_${action}`
    }]);
  }

  keyboard.push([{ text: await getText(userId, 'back'), callback_data: 'admin' }]);

  await bot.sendMessage(userId, await getText(userId, 'manageMenuButtons'), {
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function toggleMenuButton(buttonId, action) {
  const visibility = await getMenuButtonsVisibility();
  visibility[buttonId] = action === 'show';
  await setMenuButtonsVisibility(visibility);
}

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
    } else {
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

async function showDepositSettingsAdmin(userId) {
  const usdConfig = await getDepositConfig('USD');
  const iqdConfig = await getDepositConfig('IQD');

  const msg =
    `💱 *${await getText(userId, 'manageDepositSettings')}*\n\n` +
    `${await getText(userId, 'currency_usd_name')}:\nAddress: \`${usdConfig.walletAddress}\`\nInstructions: ${usdConfig.instructions}\n\n` +
    `${await getText(userId, 'currency_iqd_name')}:\nRate: ${iqdConfig.rate} IQD/USD\nSuperKey: \`${iqdConfig.walletAddress}\`\nInstructions: ${iqdConfig.instructions}`;

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
  const msg =
    `✏️ *${await getText(userId, 'editCurrencyNames')}*\n\n` +
    `${await getText(userId, 'currency_usd_name')}\n${await getText(userId, 'currency_iqd_name')}`;

  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, 'editUSDName'), callback_data: 'admin_edit_usd_name' }],
      [{ text: await getText(userId, 'editIQDName'), callback_data: 'admin_edit_iqd_name' }],
      [{ text: await getText(userId, 'back'), callback_data: 'admin_manage_deposit_settings' }]
    ]
  };

  await bot.sendMessage(userId, msg, { parse_mode: 'Markdown', reply_markup: keyboard });
}

async function showDepositInstructionsEdit(userId) {
  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, 'editUSDInstructions'), callback_data: 'admin_edit_usd_instructions' }],
      [{ text: await getText(userId, 'editIQDInstructions'), callback_data: 'admin_edit_iqd_instructions' }],
      [{ text: await getText(userId, 'back'), callback_data: 'admin_manage_deposit_settings' }]
    ]
  };

  await bot.sendMessage(userId, await getText(userId, 'editDepositInstructions'), { reply_markup: keyboard });
}

async function sendMainMenu(userId) {
  const canUse = await ensureUserAccess(userId, { sendJoinPrompt: true, sendCaptchaPrompt: true });
  if (!canUse) return;

  const visibility = await getMenuButtonsVisibility();
  const buttons = [];

  const addButton = async (id, textKey, fallbackText = null) => {
    if (visibility[id] !== false) {
      buttons.push([{ text: fallbackText || await getText(userId, textKey), callback_data: id }]);
    }
  };

  await addButton('redeem', 'redeem');
  await addButton('buy', 'buy');
  await addButton('my_balance', 'myBalance');
  await addButton('deposit', 'deposit');
  await addButton('referral', 'referral');
  await addButton('discount', 'enterDiscountCode', '🎟️ Discount');
  await addButton('my_purchases', 'myPurchases');
  await addButton('support', 'support');
  await addButton('chatgpt_code', 'chatgptCode');

  if (isAdmin(userId)) {
    buttons.push([{ text: await getText(userId, 'adminPanel'), callback_data: 'admin' }]);
  }

  await bot.sendMessage(userId, await getText(userId, 'menu'), {
    reply_markup: { inline_keyboard: buttons }
  });
}

async function showAdminPanel(userId) {
  if (!isAdmin(userId)) return;

  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, 'manageBots'), callback_data: 'admin_manage_bots' }],
      [{ text: await getText(userId, 'manageMenuButtons'), callback_data: 'admin_manage_menu_buttons' }],
      [{ text: await getText(userId, 'manageChannel'), callback_data: 'admin_manage_channel' }],
      [{ text: await getText(userId, 'manageDepositSettings'), callback_data: 'admin_manage_deposit_settings' }],
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
      [{ text: await getText(userId, 'back'), callback_data: 'back_to_menu' }]
    ]
  };

  await bot.sendMessage(userId, await getText(userId, 'adminPanel'), { reply_markup: keyboard });
}

async function showReferralSettingsAdmin(userId) {
  const percent = await getReferralPercent();
  const redeemPoints = await getReferralRedeemPoints();
  const percentLine = await getText(userId, 'currentReferralPercent', { percent });
  const pointsLine = await getText(userId, 'currentRedeemPoints', { points: redeemPoints });

  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, 'setReferralPercent'), callback_data: 'admin_set_referral_percent' }],
      [{ text: await getText(userId, 'setRedeemPoints'), callback_data: 'admin_set_redeem_points' }],
      [{ text: await getText(userId, 'back'), callback_data: 'admin' }]
    ]
  };

  await bot.sendMessage(
    userId,
    await getText(userId, 'manageReferralSettingsText', { percentLine, pointsLine }),
    { reply_markup: keyboard }
  );
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

async function showCurrencyOptions(userId) {
  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, 'currency_iqd_name'), callback_data: 'deposit_currency_iqd' }],
      [{ text: await getText(userId, 'currency_usd_name'), callback_data: 'deposit_currency_usd' }],
      [{ text: await getText(userId, 'back'), callback_data: 'back_to_menu' }]
    ]
  };

  await bot.sendMessage(userId, await getText(userId, 'chooseCurrency'), { reply_markup: keyboard });
}

async function showMerchantsForBuy(userId) {
  const merchants = await Merchant.findAll({ order: [['category', 'ASC'], ['id', 'ASC']] });
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
  await bot.sendMessage(userId, await getText(userId, 'chooseMerchant'), {
    reply_markup: { inline_keyboard: buttons }
  });
}

async function showPaymentMethodsForDeposit(userId, amount, currency) {
  const config = await getDepositConfig(currency);
  if (currency === 'USD') {
    await bot.sendMessage(userId, await getText(userId, 'depositInstructionsUSD', {
      amount,
      address: config.walletAddress,
      instructions: config.instructions
    }), { parse_mode: 'Markdown' });
  } else {
    const amountIQD = amount * config.rate;
    await bot.sendMessage(userId, await getText(userId, 'depositInstructionsIQD', {
      amountUSD: amount,
      amountIQD,
      rate: config.rate,
      address: config.walletAddress,
      instructions: config.instructions
    }), { parse_mode: 'Markdown' });
  }

  await setUserState(userId, { action: 'deposit_awaiting_proof', amount, currency });
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

  let totalCost = merchant.price * quantity;
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
  if (currentBalance < totalCost) return { success: false, reason: 'Insufficient balance' };

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
    const codesText = codes.map(c => c.extra ? `${c.value}\n${c.extra}` : c.value).join('\n\n');
    return { success: true, codes: codesText, discountApplied: discountPercent };
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
    imageFileId,
    caption: message,
    txid: currency
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
  const { isFree = false, fromPoints = false } = options;
  const email = generateRandomEmail();
  let merchant = null;
  let currentBalance = 0;
  let price = 0;

  if (!isFree) {
    merchant = await getOrCreateChatGptMerchant();
    price = parseFloat(merchant.price);
    const userObj = await User.findByPk(userId);
    currentBalance = parseFloat(userObj.balance);

    if (currentBalance < price) {
      return {
        success: false,
        reason: 'INSUFFICIENT_BALANCE',
        balance: currentBalance.toFixed(2),
        price: price.toFixed(2)
      };
    }
  }

  const result = await getChatGPTCode(email);
  if (!result.success) {
    return { success: false, reason: result.reason };
  }

  if (isFree) {
    if (!fromPoints) {
      await User.update({ freeChatgptReceived: true }, { where: { id: userId } });
    }
  } else {
    await User.update({ balance: currentBalance - price }, { where: { id: userId } });
    await BalanceTransaction.create({ userId, amount: -price, type: 'purchase', status: 'completed' });
  }

  return {
    success: true,
    code: result.code,
    email,
    price: price.toFixed(2)
  };
}

bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const userId = msg.chat.id;
  const rawArg = match?.[1] ? match[1].trim() : '';

  try {
    await findOrCreateUser(userId);

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
          await User.update({ referredBy: referrerId }, { where: { id: userId } });
        }
      }
    }

    await bot.sendMessage(userId, await getText(userId, 'start'), {
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

bot.onText(/\/admin/, async msg => {
  const userId = msg.chat.id;
  if (!isAdmin(userId)) return;
  await showAdminPanel(userId);
});

bot.on('callback_query', async query => {
  const userId = query.message.chat.id;
  const data = query.data;

  try {
    await findOrCreateUser(userId);

    if (data.startsWith('lang_')) {
      const newLang = data.split('_')[1];
      await User.update({ lang: newLang }, { where: { id: userId } });
      const canUse = await ensureUserAccess(userId, { sendJoinPrompt: true, sendCaptchaPrompt: true });
      if (canUse) await sendMainMenu(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'check_subscription') {
      const canUse = await ensureUserAccess(userId, { sendJoinPrompt: true, sendCaptchaPrompt: true });
      if (canUse) await sendMainMenu(userId);
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

    if (data === 'back_to_menu') {
      await sendMainMenu(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'support') {
      await setUserState(userId, { action: 'support' });
      await bot.sendMessage(userId, await getText(userId, 'sendReply'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('support_reply_user_')) {
      const adminId = parseInt(data.split('_')[3], 10);
      await setUserState(userId, { action: 'support_reply_user', targetAdminId: adminId });
      await bot.sendMessage(userId, await getText(userId, 'sendReply'));
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
      await bot.sendMessage(userId, await getText(userId, 'enterNewChannelLink'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_set_channel_message' && isAdmin(userId)) {
      await setUserState(userId, { action: 'set_channel_message' });
      await bot.sendMessage(userId, await getText(userId, 'enterNewChannelMessage'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_manage_menu_buttons' && isAdmin(userId)) {
      await showMenuButtonsAdmin(userId);
      await bot.answerCallbackQuery(query.id);
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

    if (data.startsWith('support_reply_') && isAdmin(userId)) {
      const targetUserId = parseInt(data.split('_')[2], 10);
      await setUserState(userId, { action: 'support_reply', targetUserId });
      await bot.sendMessage(userId, await getText(userId, 'replyToSupport', { userId: targetUserId }));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'my_balance') {
      const user = await User.findByPk(userId);
      await bot.sendMessage(userId, `💰 ${parseFloat(user.balance).toFixed(2)} USD`);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'referral') {
      const user = await User.findByPk(userId);
      const link = await getUserReferralLink(userId);
      const requiredPoints = await getReferralRedeemPoints();
      const info = await getText(userId, 'referralInfo', { link, points: user.referralPoints, requiredPoints });
      const keyboard = {
        inline_keyboard: [
          [{ text: await getText(userId, 'redeemPoints'), callback_data: 'redeem_points' }],
          [{ text: await getText(userId, 'back'), callback_data: 'back_to_menu' }]
        ]
      };
      await bot.sendMessage(userId, info, { reply_markup: keyboard });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'redeem_points') {
      const user = await User.findByPk(userId);
      const requiredPoints = await getReferralRedeemPoints();
      if (user.referralPoints >= requiredPoints) {
        const waitingMsg = await bot.sendMessage(userId, await getText(userId, 'processing'));
        const result = await processAutoChatGptCode(userId, { isFree: true, fromPoints: true });
        await bot.deleteMessage(userId, waitingMsg.message_id).catch(() => {});

        if (result.success) {
          user.referralPoints -= requiredPoints;
          await user.save();
          await bot.sendMessage(userId, `${await getText(userId, 'pointsRedeemed', { code: result.code })}\n\n📧 Email: ${result.email}`);
        } else {
          await bot.sendMessage(userId, `${await getText(userId, 'error')}: ${result.reason}`);
        }
      } else {
        await bot.sendMessage(userId, await getText(userId, 'notEnoughPoints', { points: user.referralPoints, requiredPoints }));
      }
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'discount') {
      await setUserState(userId, { action: 'discount' });
      await bot.sendMessage(userId, await getText(userId, 'enterDiscountCode'));
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
        await bot.sendMessage(userId, await getText(userId, 'noPurchases'));
      } else {
        const history = purchases.map(p => `🛒 ${p.createdAt.toLocaleDateString()}: ${p.amount} USD`).join('\n');
        await bot.sendMessage(userId, await getText(userId, 'purchaseHistory', { history }));
      }
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'deposit') {
      await showCurrencyOptions(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'deposit_currency_iqd') {
      await setUserState(userId, { action: 'deposit_amount', currency: 'IQD' });
      await bot.sendMessage(userId, '💰 USD:');
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'deposit_currency_usd') {
      await setUserState(userId, { action: 'deposit_amount', currency: 'USD' });
      await bot.sendMessage(userId, '💰 USD:');
      await bot.answerCallbackQuery(query.id);
      return;
    }

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
      await bot.sendMessage(userId, await getText(userId, 'sendCodeToRedeem'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('redeem_service_')) {
      const serviceId = parseInt(data.split('_')[2], 10);
      await setUserState(userId, { action: 'redeem_via_service', serviceId });
      await bot.sendMessage(userId, await getText(userId, 'sendCodeToRedeem'));
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
      await setUserState(userId, { action: 'buy', merchantId, discountCode });
      await bot.sendMessage(userId, `${await getText(userId, 'enterQty')}\n📦 Available: ${available}`);
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

    if (data === 'admin_set_usdt_wallet' && isAdmin(userId)) {
      await setUserState(userId, { action: 'set_usdt_wallet' });
      await bot.sendMessage(userId, await getText(userId, 'enterWalletAddress'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_set_iqd_wallet' && isAdmin(userId)) {
      await setUserState(userId, { action: 'set_iqd_wallet' });
      await bot.sendMessage(userId, await getText(userId, 'enterWalletAddress'));
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

    if (data === 'admin_edit_usd_name' && isAdmin(userId)) {
      await setUserState(userId, { action: 'edit_currency_name', currency: 'USD' });
      await bot.sendMessage(userId, await getText(userId, 'enterNewCurrencyName'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_edit_iqd_name' && isAdmin(userId)) {
      await setUserState(userId, { action: 'edit_currency_name', currency: 'IQD' });
      await bot.sendMessage(userId, await getText(userId, 'enterNewCurrencyName'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_edit_usd_instructions' && isAdmin(userId)) {
      await setUserState(userId, { action: 'edit_deposit_instructions', currency: 'USD' });
      await bot.sendMessage(userId, await getText(userId, 'enterInstructions'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_edit_iqd_instructions' && isAdmin(userId)) {
      await setUserState(userId, { action: 'edit_deposit_instructions', currency: 'IQD' });
      await bot.sendMessage(userId, await getText(userId, 'enterInstructions'));
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
      if (state?.action === 'add_merchant' && state.step === 'type') {
        const selectedType = data === 'merchant_type_single' ? 'single' : 'bulk';
        await setUserState(userId, { ...state, selectedType, step: 'description' });
        await bot.sendMessage(userId, await getText(userId, 'askDescription'));
      }
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'chatgpt_code') {
      const user = await User.findByPk(userId);
      if (!user.freeChatgptReceived) {
        const waitingMsg = await bot.sendMessage(userId, await getText(userId, 'processing'));
        const result = await processAutoChatGptCode(userId, { isFree: true, fromPoints: false });
        await bot.deleteMessage(userId, waitingMsg.message_id).catch(() => {});

        if (result.success) {
          await bot.sendMessage(userId, `${await getText(userId, 'freeCodeSuccess', { code: result.code })}\n\n📧 Email: ${result.email}`);
        } else {
          await bot.sendMessage(userId, `${await getText(userId, 'error')}: ${result.reason}`);
        }
        await sendMainMenu(userId);
      } else {
        await setUserState(userId, { action: 'chatgpt_buy_quantity' });
        await bot.sendMessage(userId, await getText(userId, 'askQuantity'));
      }
      await bot.answerCallbackQuery(query.id);
      return;
    }

    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    console.error('Callback error:', err);
    await bot.answerCallbackQuery(query.id, { text: 'Error occurred' }).catch(() => {});
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
    let state = safeParseState(user.state);

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

      if (state.action === 'set_channel_message') {
        const config = await getChannelConfig();
        config.messageText = String(text || '').trim();
        await config.save();
        await bot.sendMessage(userId, await getText(userId, 'channelMessageSet'));
        await clearUserState(userId);
        await showChannelConfigAdmin(userId);
        return;
      }
    }

    if (state?.action === 'support_reply' && isAdmin(userId)) {
      const targetUserId = state.targetUserId;
      const replyMsg = text || '';
      let fileId = null;
      if (photo) fileId = photo[photo.length - 1].file_id;
      else if (video) fileId = video.file_id;

      const supportReplyText = `${await getText(userId, 'replyMessage')}\n\n${replyMsg}`;
      if (fileId) {
        if (photo) await bot.sendPhoto(targetUserId, fileId, { caption: supportReplyText });
        else await bot.sendVideo(targetUserId, fileId, { caption: supportReplyText });
      } else {
        await bot.sendMessage(targetUserId, supportReplyText);
      }

      const replyButton = { inline_keyboard: [[{ text: await getText(targetUserId, 'replyToSupport'), callback_data: `support_reply_user_${userId}` }]] };
      await bot.sendMessage(targetUserId, await getText(targetUserId, 'replyToSupport'), { reply_markup: replyButton });
      await bot.sendMessage(userId, await getText(userId, 'supportMessageSent'));
      await clearUserState(userId);
      return;
    }

    if (state?.action === 'support_reply_user') {
      const targetAdminId = state.targetAdminId;
      const supportText = text || '';
      const photoFileId = photo ? photo[photo.length - 1].file_id : null;
      const notifText = await getText(targetAdminId, 'supportNotification', { userId, message: supportText });
      if (photoFileId) {
        await bot.sendPhoto(targetAdminId, photoFileId, { caption: notifText });
      } else {
        await bot.sendMessage(targetAdminId, notifText);
      }
      await bot.sendMessage(userId, await getText(userId, 'supportMessageSent'));
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
        const lines = String(text || '').split(/\r?\n/).map(v => v.trim()).filter(Boolean);
        const merchant = await Merchant.findByPk(state.merchantId);
        if (!merchant) {
          await bot.sendMessage(userId, 'Merchant not found');
          await clearUserState(userId);
          return;
        }

        if (merchant.type === 'single') {
          await Code.bulkCreate(lines.map(value => ({ value, merchantId: merchant.id, isUsed: false })));
        } else {
          if (lines.length % 2 !== 0) {
            await bot.sendMessage(userId, '❌ Bulk codes must be pairs (email / password).');
            return;
          }
          const pairs = [];
          for (let i = 0; i < lines.length; i += 2) {
            pairs.push({ value: lines[i], extra: lines[i + 1], merchantId: merchant.id, isUsed: false });
          }
          await Code.bulkCreate(pairs);
        }

        await bot.sendMessage(userId, await getText(userId, 'codesAdded'));
        await clearUserState(userId);
        await showAdminPanel(userId);
        return;
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

      if (state.action === 'set_usdt_wallet') {
        await updateDepositConfig('USD', 'walletAddress', text);
        await bot.sendMessage(userId, await getText(userId, 'walletSet'));
        await clearUserState(userId);
        await showDepositSettingsAdmin(userId);
        return;
      }

      if (state.action === 'set_iqd_wallet') {
        await updateDepositConfig('IQD', 'walletAddress', text);
        await bot.sendMessage(userId, await getText(userId, 'walletSet'));
        await clearUserState(userId);
        await showDepositSettingsAdmin(userId);
        return;
      }

      if (state.action === 'edit_currency_name') {
        const key = state.currency === 'USD' ? 'currency_usd_name' : 'currency_iqd_name';
        await Setting.upsert({ key, lang: user.lang, value: text });
        await bot.sendMessage(userId, await getText(userId, 'currencyNameUpdated'));
        await clearUserState(userId);
        await showDepositSettingsAdmin(userId);
        return;
      }

      if (state.action === 'edit_deposit_instructions') {
        await updateDepositConfig(state.currency, 'instructions', text);
        await bot.sendMessage(userId, await getText(userId, 'instructionsSet'));
        await clearUserState(userId);
        await showDepositSettingsAdmin(userId);
        return;
      }
    }

    if (state?.action === 'support') {
      const supportText = text || '';
      const photoFileId = photo ? photo[photo.length - 1].file_id : null;
      const notifText = await getText(ADMIN_ID, 'supportNotification', { userId, message: supportText });
      if (photoFileId) {
        await bot.sendPhoto(ADMIN_ID, photoFileId, { caption: notifText });
      } else {
        await bot.sendMessage(ADMIN_ID, notifText);
      }
      const replyButton = { inline_keyboard: [[{ text: await getText(ADMIN_ID, 'replyToSupport'), callback_data: `support_reply_${userId}` }]] };
      await bot.sendMessage(ADMIN_ID, await getText(ADMIN_ID, 'replyToSupport'), { reply_markup: replyButton });
      await bot.sendMessage(userId, await getText(userId, 'supportMessageSent'));
      await clearUserState(userId);
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
        await bot.sendMessage(userId, `${await getText(userId, 'noCodes')} Available: ${available}`);
        return;
      }
      const result = await processPurchase(userId, merchant.id, qty, state.discountCode || null);
      if (result.success) {
        let msgText = await getText(userId, 'success');
        if (result.discountApplied) msgText += `\n🎟️ Discount applied: ${result.discountApplied}%`;
        msgText += `\n\n${result.codes}`;
        await bot.sendMessage(userId, msgText);

        const userObj = await User.findByPk(userId);
        if (userObj.referredBy) {
          const referralPercent = parseFloat(process.env.REFERRAL_PERCENT || '10');
          const rewardAmount = (merchant.price * qty) * referralPercent / 100;
          const referrer = await User.findByPk(userObj.referredBy);
          if (referrer) {
            await BalanceTransaction.create({ userId: referrer.id, amount: rewardAmount, type: 'referral', status: 'completed' });
            await User.update({ balance: parseFloat(referrer.balance) + rewardAmount }, { where: { id: referrer.id } });
            await bot.sendMessage(referrer.id, `🎉 Referral reward added: ${rewardAmount.toFixed(2)} USD`);
          }
        }
      } else {
        await bot.sendMessage(userId, `${await getText(userId, 'error')}: ${result.reason}`);
      }
      await clearUserState(userId);
      await sendMainMenu(userId);
      return;
    }

    if (state?.action === 'deposit_amount') {
      const amount = parseFloat(text);
      if (Number.isNaN(amount) || amount <= 0) {
        await bot.sendMessage(userId, '❌ Invalid amount');
        return;
      }
      await showPaymentMethodsForDeposit(userId, amount, state.currency);
      return;
    }

    if (state?.action === 'deposit_awaiting_proof') {
      const imageFileId = photo ? photo[photo.length - 1].file_id : null;
      const caption = text || '';
      if (!imageFileId) return;
      await requestDeposit(userId, state.amount, state.currency, caption, imageFileId);
      await bot.sendMessage(userId, await getText(userId, 'depositProofReceived'));
      await clearUserState(userId);
      await sendMainMenu(userId);
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
        await bot.sendMessage(userId, await getText(userId, 'freeCodeSuccess', { code: result.code }));
      } else {
        await bot.sendMessage(userId, `${await getText(userId, 'error')}: ${result.reason}`);
        await clearUserState(userId);
      }
      await sendMainMenu(userId);
      return;
    }

    if (state?.action === 'chatgpt_buy_quantity') {
      const qty = parseInt(text, 10);
      if (Number.isNaN(qty) || qty !== 1) {
        await bot.sendMessage(userId, await getText(userId, 'invalidQuantity'));
        return;
      }

      const waitingMsg = await bot.sendMessage(userId, await getText(userId, 'processing'));
      const result = await processAutoChatGptCode(userId, { isFree: false });
      await bot.deleteMessage(userId, waitingMsg.message_id).catch(() => {});

      if (result.success) {
        await bot.sendMessage(userId, `${await getText(userId, 'purchaseSuccess', { code: result.code })}\n\n📧 Email: ${result.email}`);
      } else if (result.reason === 'INSUFFICIENT_BALANCE') {
        await bot.sendMessage(userId, await getText(userId, 'insufficientBalance', { balance: result.balance, price: result.price }));
      } else {
        await bot.sendMessage(userId, `${await getText(userId, 'error')}: ${result.reason}`);
      }
      await clearUserState(userId);
      await sendMainMenu(userId);
      return;
    }

    if (state?.action === 'chatgpt_buy_email') {
      const email = String(text || '').trim();
      if (!email.includes('@') || !email.includes('.')) {
        await bot.sendMessage(userId, '❌ Invalid email format.');
        return;
      }
      const userObj = await User.findByPk(userId);
      const merchant = await Merchant.findOne({ where: { nameEn: 'ChatGPT Code' } });
      if (!merchant) {
        await bot.sendMessage(userId, '❌ ChatGPT merchant not found. Contact admin.');
        await clearUserState(userId);
        await sendMainMenu(userId);
        return;
      }

      const price = merchant.price;
      const currentBalance = parseFloat(userObj.balance);
      if (currentBalance < price) {
        await bot.sendMessage(userId, await getText(userId, 'insufficientBalance', { balance: currentBalance.toFixed(2), price }));
        await clearUserState(userId);
        await sendMainMenu(userId);
        return;
      }

      const result = await getChatGPTCode(email);
      if (result.success) {
        await User.update({ balance: currentBalance - price }, { where: { id: userId } });
        await BalanceTransaction.create({ userId, amount: -price, type: 'purchase', status: 'completed' });
        await bot.sendMessage(userId, await getText(userId, 'purchaseSuccess', { code: result.code }));
      } else {
        await bot.sendMessage(userId, `${await getText(userId, 'error')}: ${result.reason}`);
      }
      await clearUserState(userId);
      await sendMainMenu(userId);
      return;
    }

  } catch (err) {
    console.error('Message handler error:', err);
    await bot.sendMessage(userId, 'An error occurred. Please try again later.').catch(() => {});
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

sequelize.sync({ alter: true }).then(async () => {
  console.log('✅ Database synced');
  await getDepositConfig('USD');
  await getDepositConfig('IQD');
  await getChannelConfig();
  await refreshChatGPTCookies(false);

  await getOrCreateChatGptMerchant();

  const PORT = process.env.PORT || 3000;
  app.get('/', (req, res) => res.send('Bot is running'));
  app.listen(PORT, () => console.log(`🚀 Server started on port ${PORT}`));
}).catch(err => {
  console.error('Database error:', err);
  process.exit(1);
});
