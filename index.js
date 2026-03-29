// ========================
// index.js - البوت المتكامل مع ChatGPT (نسخة كاملة)
// ========================
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { Sequelize, DataTypes, Op } = require('sequelize');
const FormData = require('form-data');

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
  totalPurchases: { type: DataTypes.INTEGER, defaultValue: 0 },
  freeChatgptReceived: { type: DataTypes.BOOLEAN, defaultValue: false }
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
// 3. دوال مساعدة
// ========================
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

async function handleReferral(userId, referralCode) {
  const referrer = await User.findOne({ where: { referralCode } });
  if (!referrer || referrer.id === userId) return false;
  await User.update({ referredBy: referrer.id }, { where: { id: userId } });
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

// ========================
// 4. دوال ChatGPT (جلب الكوكيز تلقائياً)
// ========================
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
// 5. النصوص الافتراضية (مدمجة بالكامل)
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
    referralInfo: 'Share your referral link with friends and earn {percent}% of their deposits!\n\nYour referral code: `{code}`\nLink: {link}',
    referralEarned: '🎉 You earned {amount} USD from a referral!',
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
    chatgptCode: '🤖 ChatGPT Code',
    askEmail: 'Please enter your email address:',
    freeCodeSuccess: '🎉 Here is your free ChatGPT GO code:\n\n{code}',
    alreadyGotFree: 'You have already received your free code. You can purchase more codes.',
    buyChatgpt: 'Purchase ChatGPT Code',
    askQuantity: 'How many codes would you like to buy? (Max 1 per purchase)',
    enterEmailForPurchase: 'Enter your email to receive the code:',
    purchaseSuccess: '✅ Purchase successful! Here is your ChatGPT GO code:\n\n{code}',
    insufficientBalance: '❌ Insufficient balance. Your balance: {balance} USD. Price per code: {price} USD.',
    invalidQuantity: '❌ Invalid quantity. Please send a number (1 only).'
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
    referralInfo: 'شارك رابط الإحالة الخاص بك مع أصدقائك واربح {percent}% من إيداعاتهم!\n\nكود الإحالة الخاص بك: `{code}`\nالرابط: {link}',
    referralEarned: '🎉 لقد ربحت {amount} دولار من إحالة صديق!',
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
    chatgptCode: '🤖 كود ChatGPT',
    askEmail: 'يرجى إدخال بريدك الإلكتروني:',
    freeCodeSuccess: '🎉 إليك كود ChatGPT GO المجاني:\n\n{code}',
    alreadyGotFree: 'لقد حصلت بالفعل على كودك المجاني. يمكنك شراء أكواد إضافية.',
    buyChatgpt: 'شراء كود ChatGPT',
    askQuantity: 'كم عدد الأكواد التي تريد شراءها؟ (واحد فقط)',
    enterEmailForPurchase: 'أدخل بريدك الإلكتروني لاستلام الكود:',
    purchaseSuccess: '✅ تم الشراء بنجاح! إليك كود ChatGPT GO:\n\n{code}',
    insufficientBalance: '❌ رصيد غير كاف. رصيدك: {balance} دولار. سعر الكود: {price} دولار.',
    invalidQuantity: '❌ كمية غير صالحة. يرجى إرسال رقم (1 فقط).'
  }
};

// ========================
// 6. دوال إدارة الأزرار
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

async function sendMainMenu(userId) {
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

// ========================
// 7. دوال أخرى (الأدمن، الشراء، الإيداع)
// ========================
async function showAdminPanel(userId) {
  if (!isAdmin(userId)) return;
  const panelText = await getText(userId, 'adminPanel');
  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, 'manageBots'), callback_data: 'admin_manage_bots' }],
      [{ text: await getText(userId, 'manageMenuButtons'), callback_data: 'admin_manage_menu_buttons' }],
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

async function showMerchantsForBuy(userId) {
  const merchants = await Merchant.findAll({ order: [['category', 'ASC'], ['id', 'ASC']] });
  if (merchants.length === 0) {
    await bot.sendMessage(userId, await getText(userId, 'noCodes'));
    return sendMainMenu(userId);
  }
  const lang = (await User.findByPk(userId)).lang;
  const buttons = [];
  for (const m of merchants) {
    buttons.push([{
      text: `${lang === 'en' ? m.nameEn : m.nameAr} - ${m.price} USD`,
      callback_data: `buy_merchant_${m.id}`
    }]);
  }
  const backText = await getText(userId, 'back');
  buttons.push([{ text: backText, callback_data: 'back_to_menu' }]);
  const chooseMerchantText = await getText(userId, 'chooseMerchant');
  await bot.sendMessage(userId, chooseMerchantText, { reply_markup: { inline_keyboard: buttons } });
}

async function requestDeposit(userId, amount, currency, message, imageFileId = null) {
  const deposit = await BalanceTransaction.create({
    userId,
    amount,
    type: 'deposit',
    status: 'pending',
    imageFileId: imageFileId,
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

// ========================
// 8. معالجة الأوامر والـ callbacks
// ========================
bot.onText(/\/start/, async (msg) => {
  const userId = msg.chat.id;
  const args = msg.text.split(' ');
  try {
    await User.findOrCreate({ where: { id: userId }, defaults: { lang: 'en', balance: 0, referralCode: generateReferralCode(userId) } });
    if (args.length > 1 && args[1].startsWith('ref_')) {
      const referralCode = args[1].substring(4);
      await handleReferral(userId, referralCode);
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

bot.on('callback_query', async (query) => {
  const userId = query.message.chat.id;
  const data = query.data;

  try {
    await User.findOrCreate({ where: { id: userId }, defaults: { lang: 'en', balance: 0, referralCode: generateReferralCode(userId) } });

    if (data.startsWith('lang_')) {
      const newLang = data.split('_')[1];
      await User.update({ lang: newLang }, { where: { id: userId } });
      await sendMainMenu(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'back_to_menu') {
      await sendMainMenu(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

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

    if (data === 'buy') {
      await showMerchantsForBuy(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'my_balance') {
      const user = await User.findByPk(userId);
      const balance = parseFloat(user.balance).toFixed(2);
      await bot.sendMessage(userId, `💰 Your balance: ${balance} USD`);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'deposit') {
      await bot.sendMessage(userId, await getText(userId, 'chooseCurrency'), {
        reply_markup: {
          inline_keyboard: [
            [{ text: await getText(userId, 'currencyIQD'), callback_data: 'deposit_currency_iqd' }],
            [{ text: await getText(userId, 'currencyUSD'), callback_data: 'deposit_currency_usd' }],
            [{ text: await getText(userId, 'back'), callback_data: 'back_to_menu' }]
          ]
        }
      });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'deposit_currency_iqd' || data === 'deposit_currency_usd') {
      const currency = data === 'deposit_currency_iqd' ? 'IQD' : 'USD';
      await User.update({ state: JSON.stringify({ action: 'deposit_amount', currency }) }, { where: { id: userId } });
      await bot.sendMessage(userId, await getText(userId, 'enterDepositAmountUSD'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin' && isAdmin(userId)) {
      await showAdminPanel(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    console.error('Callback error:', err);
    await bot.answerCallbackQuery(query.id, { text: 'Error occurred' });
  }
});

bot.on('message', async (msg) => {
  const userId = msg.chat.id;
  const text = msg.text;
  const photo = msg.photo;

  try {
    const user = await User.findByPk(userId);
    if (!user) return;

    let state = user.state ? JSON.parse(user.state) : null;

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

    if (state && state.action === 'deposit_amount') {
      const amount = parseFloat(text);
      if (isNaN(amount) || amount <= 0) {
        await bot.sendMessage(userId, '❌ Invalid amount');
        return;
      }
      const currency = state.currency;
      const config = await getDepositConfig(currency);
      if (currency === 'USD') {
        const msg = await getText(userId, 'depositInstructionsUSD', {
          amount,
          address: config.walletAddress,
          instructions: config.instructions
        });
        await bot.sendMessage(userId, msg, { parse_mode: 'Markdown' });
      } else {
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
      await User.update({ state: JSON.stringify({ action: 'deposit_awaiting_proof', amount, currency }) }, { where: { id: userId } });
      return;
    }

    if (state && state.action === 'deposit_awaiting_proof') {
      const amount = state.amount;
      const currency = state.currency;
      let imageFileId = null;
      let caption = text || '';
      if (photo) {
        imageFileId = photo[photo.length - 1].file_id;
      } else {
        return;
      }
      await requestDeposit(userId, amount, currency, caption, imageFileId);
      await bot.sendMessage(userId, await getText(userId, 'depositProofReceived'));
      await User.update({ state: null }, { where: { id: userId } });
      await sendMainMenu(userId);
      return;
    }

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
      const result = await processPurchase(userId, merchant.id, qty);
      if (result.success) {
        let msg = await getText(userId, 'success');
        if (result.discountApplied) {
          msg += `\n🎟️ Discount applied: ${result.discountApplied}%`;
        }
        msg += `\n\n${result.codes}`;
        await bot.sendMessage(userId, msg);
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
// 9. API للبوتات الأخرى
// ========================
app.post('/api/code', async (req, res) => {
  res.json({ error: 'Not implemented' });
});

// ========================
// 10. جدولة المهام
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
// 11. تشغيل الخادم ومزامنة قاعدة البيانات
// ========================
sequelize.sync({ alter: true }).then(async () => {
  console.log('✅ Database synced');
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
  await getDepositConfig('USD');
  await getDepositConfig('IQD');
  const PORT = process.env.PORT || 3000;
  app.get('/', (req, res) => res.send('Bot is running'));
  app.listen(PORT, () => console.log(`🚀 Server started on port ${PORT}`));
}).catch(err => {
  console.error('Database error:', err);
  process.exit(1);
});
