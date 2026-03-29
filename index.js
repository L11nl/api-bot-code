// ========================
// index.js - البوت المتكامل (نسخة احترافية متطورة مع ChatGPT)
// ========================
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { Sequelize, DataTypes, Op } = require('sequelize');
const FormData = require('form-data'); // لإرسال multipart/form-data

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
  freeChatgptReceived: { type: DataTypes.BOOLEAN, defaultValue: false } // <-- إضافة
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
// 3. دوال مساعدة لجلب الكوكيز تلقائياً (ChatGPT)
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
  // إذا فشل جلب الكوكيز، نستخدم كوكيز افتراضية من env (احتياطي)
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
// 4. النصوص الافتراضية (ديناميكية) – مع إضافة نصوص ChatGPT
// ========================
const DEFAULT_TEXTS = {
  en: {
    // ... (كل النصوص السابقة محفوظة هنا، لكن للاختصار سنضع فقط الإضافات)
    // يجب دمج النصوص القديمة مع الجديدة. سنعطي النص الكامل في الملف النهائي.
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
    // ... باقي النصوص كما هي
  },
  ar: {
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
    // ... باقي النصوص كما هي
  }
};

// ... (باقي الدوال: getText, isAdmin, generateReferralCode, getUserReferralLink, handleReferral, applyDiscount، إلخ)
// يجب أن تكون موجودة كما في الكود الأصلي. سيتم توفيرها في الملف الكامل.

// ========================
// 5. دوال إدارة الأزرار (مثل السابق مع إضافة الزر الجديد)
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

// ... (باقي الدوال: showAdminPanel, showMerchantsForBuy, showPaymentMethodsForDeposit, etc.)
// يجب إدراج جميع الدوال الأخرى كما هي من الكود الأصلي.

// ========================
// 6. معالجة الأوامر والـ callbacks مع إضافة حالة ChatGPT
// ========================
bot.onText(/\/start/, async (msg) => {
  // كما هي من الكود الأصلي
});

bot.onText(/\/admin/, async (msg) => {
  // كما هي
});

bot.on('callback_query', async (query) => {
  const userId = query.message.chat.id;
  const data = query.data;
  try {
    await User.findOrCreate({ where: { id: userId }, defaults: { lang: 'en', balance: 0, referralCode: generateReferralCode(userId) } });
    // ... كل المعالجات القديمة
    // إضافة معالجة زر chatgpt_code
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
    // ... باقي المعالجات
  } catch (err) {
    console.error('Callback error:', err);
    await bot.answerCallbackQuery(query.id, { text: 'Error occurred' });
  }
});

// ========================
// 7. معالجة الرسائل النصية مع إضافة حالات ChatGPT
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

    // ... كل المعالجات القديمة

    // === معالجة ChatGPT ===
    if (state && (state.action === 'chatgpt_free_email' || state.action === 'chatgpt_buy_quantity' || state.action === 'chatgpt_buy_email')) {
      if (state.action === 'chatgpt_free_email') {
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

      if (state.action === 'chatgpt_buy_quantity') {
        const qty = parseInt(text);
        if (isNaN(qty) || qty !== 1) {
          await bot.sendMessage(userId, await getText(userId, 'invalidQuantity'));
          return;
        }
        await User.update({ state: JSON.stringify({ action: 'chatgpt_buy_email', quantity: qty }) }, { where: { id: userId } });
        await bot.sendMessage(userId, await getText(userId, 'enterEmailForPurchase'));
        return;
      }

      if (state.action === 'chatgpt_buy_email') {
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
    }
    // ... باقي المعالجات
  } catch (err) {
    console.error('Message handler error:', err);
    await bot.sendMessage(userId, 'An error occurred. Please try again later.');
  }
});

// ========================
// 8. API للبوتات الأخرى
// ========================
app.post('/api/code', async (req, res) => {
  // كما هي من الكود الأصلي
});

// ========================
// 9. جدولة المهام
// ========================
setInterval(async () => {
  // كما هي
}, 24 * 60 * 60 * 1000);

// ========================
// 10. تشغيل الخادم ومزامنة قاعدة البيانات مع إنشاء تاجر ChatGPT
// ========================
sequelize.sync({ alter: true }).then(async () => {
  console.log('✅ Database synced');
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
  // إنشاء إعدادات الشحن الافتراضية إن لم تكن موجودة
  await getDepositConfig('USD');
  await getDepositConfig('IQD');
  const PORT = process.env.PORT || 3000;
  app.get('/', (req, res) => res.send('Bot is running'));
  app.listen(PORT, () => console.log(`🚀 Server started on port ${PORT}`));
}).catch(err => {
  console.error('Database error:', err);
  process.exit(1);
});
