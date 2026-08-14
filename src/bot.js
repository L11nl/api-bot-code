const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const axios = require('axios');
const config = require('./config');
const {
  sequelize,
  Op,
  User,
  PaymentMethod,
  Merchant,
  Code,
  PurchaseOrder,
  BalanceTransaction,
  BinanceTransfer,
  SupportTicket,
  Referral,
  GiftClaim,
  DeliveryRecord,
  NetworkClient,
  NetworkSettlement,
  getIqdRate,
  getSuperQiNumber,
  getSetting,
  setSetting,
  getSecureSetting,
  setSecureSetting
} = require('./db');
const { t } = require('./i18n');
const {
  escapeHtml,
  moneyUsd,
  moneyIqd,
  parseDescription,
  parseInventoryTextForProduct,
  inventoryFingerprint,
  renderDelivery,
  randomCaptcha,
  extractTelegramRichText
} = require('./utils');
const {
  getProductStock,
  listActiveProducts,
  createOrder,
  fulfillOrder,
  reserveWalletForOrder,
  refundWalletReservation,
  completeExternalPayment,
  payFromWallet,
  addWaitingCode
} = require('./services/orders');
const {
  getReferralSettings,
  setReferralCandidate,
  finalizeReferral,
  getReferralStats,
  claimReferralGift
} = require('./services/referrals');
const binancePay = require('./payments/binancePay');
const { encryptPayload } = require('./cryptoStore');
const { translateArToEn } = require('./translator');
const network = require('./network');
const networkLedger = require('./services/networkLedger');

const bot = new TelegramBot(config.token, { polling: false });
const captchaAnswers = new Map();
const memoryRate = new Map();
const pendingPartnerBotTokens = new Map();
let cachedBotUsername = '';
let commerceStatusCache = { at: 0, value: null };

async function currentCommerceStatus(force = false) {
  const now = Date.now();
  const cacheTtl = commerceStatusCache.value?.suspended ? 5000 : 20000;
  if (!force && commerceStatusCache.value && now - commerceStatusCache.at < cacheTtl) return commerceStatusCache.value;
  let value = { suspended: false, liabilityUsd: 0, thresholdUsd: Number(config.network.debtSuspendThresholdUsd || 40) };
  try {
    if (network.isMaster()) value = await networkLedger.commerceStatusForShop('master');
    else if (network.enabledClient()) value = await network.getMyCommerceStatus();
  } catch (error) {
    console.error('Commerce status:', error.message);
    if (network.enabledClient()) {
      value = {
        suspended: true,
        networkUnavailable: true,
        liabilityUsd: 0,
        thresholdUsd: Number(config.network.debtSuspendThresholdUsd || 40)
      };
    }
  }
  commerceStatusCache = { at: now, value };
  return value;
}

function invalidateCommerceStatus() { commerceStatusCache = { at: 0, value: null }; }


function currentNetworkShopId() {
  return network.enabledClient() ? String(config.network.shopId || '') : 'master';
}

async function resolveInventoryOwnerInfo(delivery, storedDelivery = null) {
  const ownerId = String(
    delivery?.inventoryOwnerShopId || storedDelivery?.inventoryOwnerShopId || 'master'
  );
  const deliveryId = String(delivery?.id || delivery?.deliveryId || storedDelivery?.deliveryId || '');
  let ownerName = String(
    delivery?.inventoryOwnerShopName || storedDelivery?.inventoryOwnerShopName || ''
  ).trim();

  if (!ownerName && network.isMaster()) {
    try { ownerName = await networkLedger.getShopName(ownerId); } catch {}
  }

  if (!ownerName && network.enabledClient()) {
    if (ownerId === String(config.network.shopId || '')) {
      ownerName = String(config.network.shopName || ownerId);
    } else if (deliveryId) {
      try {
        const remote = await network.lookupRemoteDelivery(deliveryId);
        ownerName = String(remote?.delivery?.inventoryOwnerShopName || '').trim();
      } catch {}
    }
  }

  if (!ownerName) {
    ownerName = ownerId === 'master'
      ? String(config.network.ownerName || 'المالك الرئيسي')
      : ownerId;
  }

  return {
    ownerId,
    ownerName,
    isOwnStock: ownerId === currentNetworkShopId()
  };
}

function suspendedStoreText(lang = 'ar', status = null) {
  if (status?.networkUnavailable) {
    return lang === 'en'
      ? '⛔ New sales are temporarily paused because this bot cannot reach the main network server. Existing orders and support remain available.'
      : '⛔ تم إيقاف المبيعات الجديدة مؤقتاً لأن البوت ما يگدر يتصل بالسيرفر الرئيسي. الطلبات السابقة والدعم يبقون متاحين.';
  }
  return lang === 'en'
    ? '⛔ This store is temporarily paused while an inter-store account is being settled. Existing orders and support remain available.'
    : '⛔ هذا المتجر متوقف مؤقتاً لحين تسوية حساب بين المتاجر. الطلبات السابقة والدعم يبقون متاحين.';
}

function suspendedMainKeyboard(lang) {
  return {
    keyboard: [
      [emojiButton(t(lang, 'support'), PREMIUM_EMOJI.support), emojiButton(t(lang, 'orders'), PREMIUM_EMOJI.orders)],
      [emojiButton('عربي / English', PREMIUM_EMOJI.language)]
    ],
    resize_keyboard: true,
    is_persistent: true
  };
}

const PREMIUM_EMOJI = Object.freeze({
  binance: { id: '5875443023873053217', alt: '🟡' },
  superqi: { id: '5184203496831846429', alt: '🔵' },
  support: { id: '5882260605850620296', alt: '💬' },
  wallet: { id: '6325416826100519483', alt: '👛' },
  orders: { id: '5882175861850903857', alt: '📦' },
  products: { id: '5800639128961814362', alt: '🛍️' },
  // No language Custom Emoji ID was supplied. Keep a normal globe until a verified ID is configured.
  language: { id: '', alt: '🌐' }
});

function emojiButton(text, emoji, extra = {}) {
  const button = { text, ...extra };
  if (emoji?.id) button.icon_custom_emoji_id = String(emoji.id);
  return button;
}

function premiumEmojiHtml(emoji) {
  if (!emoji?.id) return escapeHtml(emoji?.alt || '');
  return `<tg-emoji emoji-id="${escapeHtml(String(emoji.id))}">${escapeHtml(emoji.alt || '✨')}</tg-emoji>`;
}

function customPaymentEmoji(method) {
  return method?.iconCustomEmojiId
    ? { id: String(method.iconCustomEmojiId), alt: method.iconAlt || '💳' }
    : null;
}

function isAdmin(id) {
  return config.admins.has(Number(id));
}

function canManageNetworkProduct(product) {
  if (!product) return false;
  if (!network.enabledClient() || !product.networkManaged) return true;
  return String(product.networkOwnerShopId || '') === String(config.network.shopId);
}

function canContributeStock(product) {
  return Boolean(product && product.isActive !== false);
}

function isCancelText(value) {
  const text = String(value || '').trim().toLowerCase();
  return ['/cancel', 'إغلاق', 'اغلاق', 'الغاء', 'إلغاء', '❌ إغلاق', 'close', 'cancel'].includes(text);
}

function cancelInlineKeyboard() {
  return { inline_keyboard: [[{ text: '❌ إغلاق العملية', callback_data: 'flow:cancel' }]] };
}

function extractProductNameRichText(text, entities = []) {
  const raw = String(text || '');
  const rich = extractTelegramRichText(raw, entities);
  const manual = raw.match(/\[(\d{5,24})\]/);
  const manualId = manual ? manual[1] : '';
  const cleanPlain = manual ? rich.plain.replace(manual[0], '').replace(/\s{2,}/g, ' ').trim() : rich.plain.trim();
  const emojiId = rich.firstCustomEmojiId || manualId;
  const emojiAlt = rich.firstCustomEmojiAlt || (manualId ? '✨' : '');
  let html = rich.html;
  if (manualId && !rich.firstCustomEmojiId) {
    html = `<tg-emoji emoji-id="${escapeHtml(manualId)}">✨</tg-emoji> ${escapeHtml(cleanPlain)}`;
  } else if (!emojiId) {
    html = escapeHtml(cleanPlain);
  }
  return {
    ...rich,
    plain: cleanPlain,
    html,
    firstCustomEmojiId: emojiId,
    firstCustomEmojiAlt: emojiAlt
  };
}

function isMainMenuText(value) {
  const text = String(value || '').trim();
  return [
    t('ar', 'products'), t('en', 'products'),
    t('ar', 'wallet'), t('en', 'wallet'),
    t('ar', 'orders'), t('en', 'orders'),
    t('ar', 'support'), t('en', 'support'),
    t('ar', 'language'), t('en', 'language'),
    '🎁 الهدايا والمشاركة', '🎁 Gifts & referrals',
    '📢 قناتنا', '📢 Our channel'
  ].includes(text);
}

async function getBotUsername() {
  if (cachedBotUsername) return cachedBotUsername;
  const me = await bot.getMe();
  cachedBotUsername = me.username || '';
  return cachedBotUsername;
}

function parseState(user) {
  try { return user?.state ? JSON.parse(user.state) : null; }
  catch { return null; }
}

async function setState(userId, state) {
  await User.update({ state: state ? JSON.stringify(state) : null }, { where: { id: userId } });
}

async function clearState(userId) {
  pendingPartnerBotTokens.delete(Number(userId));
  await setState(userId, null);
}

async function getOrCreateUser(from) {
  const [user, created] = await User.findOrCreate({
    where: { id: from.id },
    defaults: {
      lang: config.defaultLanguage,
      balance: 0,
      verified: true,
      username: from.username || null,
      firstName: from.first_name || '',
      referralProcessed: false
    }
  });
  const changes = {};
  if (user.username !== (from.username || null)) changes.username = from.username || null;
  if (user.firstName !== (from.first_name || '')) changes.firstName = from.first_name || '';
  if (Object.keys(changes).length) await user.update(changes);
  user._createdNow = created;
  return user;
}

function mainKeyboard(lang, showReferrals = true, showChannel = false) {
  const keyboard = [
    [
      emojiButton(t(lang, 'products'), PREMIUM_EMOJI.products),
      emojiButton(t(lang, 'support'), PREMIUM_EMOJI.support)
    ],
    [
      emojiButton(t(lang, 'wallet'), PREMIUM_EMOJI.wallet, { style: 'primary' }),
      emojiButton(t(lang, 'orders'), PREMIUM_EMOJI.orders)
    ]
  ];
  if (showReferrals) keyboard.push([{ text: lang === 'en' ? '🎁 Gifts & referrals' : '🎁 الهدايا والمشاركة' }]);
  if (showChannel) keyboard.push([{ text: lang === 'en' ? '📢 Our channel' : '📢 قناتنا' }]);
  keyboard.push([emojiButton('عربي / English', PREMIUM_EMOJI.language)]);
  return {
    keyboard,
    resize_keyboard: true,
    is_persistent: true
  };
}

async function getMainKeyboard(lang) {
  const [settings, channel] = await Promise.all([
    getReferralSettings(),
    getRequiredChannel()
  ]);
  return mainKeyboard(lang, settings.enabled, Boolean(channel));
}

async function automaticNotificationsEnabled() {
  return String(await getSetting('automatic_notifications_enabled', 'true')).toLowerCase() !== 'false';
}

function shopDisplayCurrency() {
  const currency = String(config.network.settlementCurrency || 'USD').toUpperCase();
  return ['USD', 'IQD', 'EGP'].includes(currency) ? currency : 'USD';
}

async function shopMoneyContext() {
  const currency = shopDisplayCurrency();
  let rate = 1;
  if (currency === 'IQD') rate = Number(await getIqdRate());
  if (currency === 'EGP') rate = Number(await getSetting('egp_rate_per_usd', String(config.network.egpRate || 50)));
  if (!Number.isFinite(rate) || rate <= 0) rate = currency === 'IQD' ? Number(config.iqdRate || 1500) : currency === 'EGP' ? Number(config.network.egpRate || 50) : 1;
  return { currency, rate };
}

function localMoneyNumber(amountUsd, context) {
  const amount = Number(amountUsd || 0) * Number(context?.rate || 1);
  if (context?.currency === 'IQD') return Math.round(amount).toLocaleString('en-US');
  return amount.toFixed(2);
}

function customerMoney(amountUsd, context, lang = 'ar') {
  const usd = moneyUsd(amountUsd);
  const currency = String(context?.currency || 'USD').toUpperCase();
  if (currency === 'USD') return usd;
  const label = paymentCurrencyLabel(currency, lang);
  return `${usd} • ${localMoneyNumber(amountUsd, context)} ${label}`;
}

function customerMoneyCompact(amountUsd, context) {
  const usd = moneyUsd(amountUsd);
  const currency = String(context?.currency || 'USD').toUpperCase();
  if (currency === 'USD') return usd;
  return `${usd}/${localMoneyNumber(amountUsd, context)} ${currency}`;
}

async function getHiddenPaymentTypes() {
  try {
    const parsed = JSON.parse(String(await getSetting('hidden_payment_types', '[]')));
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return new Set();
  }
}

async function setHiddenPaymentTypes(set) {
  await setSetting('hidden_payment_types', JSON.stringify([...set].sort()));
}

async function getActivePaymentMethods() {
  return PaymentMethod.findAll({
    where: { isActive: true },
    order: [['sortOrder', 'ASC'], ['id', 'ASC']]
  });
}

function localizedPaymentName(method, lang) {
  return lang === 'en' ? (method.nameEn || method.nameAr) : (method.nameAr || method.nameEn);
}

function paymentCurrencyLabel(currency, lang = 'ar') {
  const code = String(currency || 'USD').toUpperCase();
  if (code === 'IQD') return lang === 'en' ? 'IQD' : 'دينار عراقي';
  if (code === 'EGP') return lang === 'en' ? 'EGP' : 'جنيه مصري';
  return 'USD';
}

function paymentLocalAmount(amountUsd, method) {
  const currency = String(method?.settlementCurrency || 'USD').toUpperCase();
  const rate = Number(method?.ratePerUsd || (currency === 'IQD' ? config.iqdRate : currency === 'EGP' ? config.network.egpRate : 1));
  const amount = Number(amountUsd || 0) * (Number.isFinite(rate) && rate > 0 ? rate : 1);
  return { currency, rate, amount };
}

function normalizePaymentCurrency(currency) {
  const code = String(currency || 'USD').toUpperCase();
  return ['USD', 'IQD', 'EGP'].includes(code) ? code : 'USD';
}

function paymentCurrencyDecimals(currency) {
  return normalizePaymentCurrency(currency) === 'IQD' ? 0 : 2;
}

function formatPaymentCurrencyAmount(amount, currency, lang = 'ar') {
  const code = normalizePaymentCurrency(currency);
  const value = code === 'IQD'
    ? Math.round(Number(amount || 0)).toLocaleString('en-US')
    : Number(amount || 0).toFixed(2);
  return `${value} ${paymentCurrencyLabel(code, lang)}`;
}

function minimumTopupLocalAmount(ratePerUsd, currency, minimumUsd = 0.01) {
  const code = normalizePaymentCurrency(currency);
  const rate = Number(ratePerUsd || 1);
  const raw = Math.max(0.01, Number(minimumUsd || 0.01)) * (Number.isFinite(rate) && rate > 0 ? rate : 1);
  if (code === 'IQD') return Math.max(1, Math.ceil(raw));
  return Math.max(0.01, Math.ceil((raw - 1e-9) * 100) / 100);
}

async function resolveTopupInputContext(methodToken) {
  const token = String(methodToken || '');
  if (token === 'binance') {
    return { currency: 'USD', rate: 1, minimumUsd: Math.max(0.01, Number(config.binance.minAmount || 0.01)), methodType: 'binance' };
  }
  if (token === 'superqi') {
    const rate = Number(await getIqdRate());
    return { currency: 'IQD', rate: Number.isFinite(rate) && rate > 0 ? rate : Number(config.iqdRate || 1500), minimumUsd: 0.01, methodType: 'superqi' };
  }
  if (token.startsWith('custom:')) {
    const id = Number(token.split(':')[1]);
    const method = await PaymentMethod.findOne({ where: { id, isActive: true } });
    if (!method) return null;
    const local = paymentLocalAmount(1, method);
    return {
      currency: normalizePaymentCurrency(local.currency),
      rate: Number(local.rate || 1),
      minimumUsd: 0.01,
      methodType: token,
      paymentMethodId: method.id,
      methodNameAr: method.nameAr,
      methodNameEn: method.nameEn
    };
  }
  if (token.startsWith('network:')) {
    const inheritedType = token.slice('network:'.length);
    const options = await network.fallbackPayments();
    const method = (options.methods || []).find(row => String(row.type || '') === inheritedType);
    if (!method) return null;
    const local = paymentLocalAmount(1, method);
    return {
      currency: normalizePaymentCurrency(local.currency),
      rate: Number(local.rate || 1),
      minimumUsd: inheritedType === 'binance' ? Math.max(0.01, Number(config.binance.minAmount || 0.01)) : 0.01,
      methodType: token,
      inheritedType,
      methodNameAr: method.nameAr,
      methodNameEn: method.nameEn
    };
  }
  return null;
}

function topupAmountPrompt(context, lang = 'ar') {
  const currency = normalizePaymentCurrency(context?.currency);
  const rate = Number(context?.rate || 1);
  const minimum = minimumTopupLocalAmount(rate, currency, context?.minimumUsd || 0.01);
  const minimumText = formatPaymentCurrencyAmount(minimum, currency, lang);
  if (lang === 'en') {
    if (currency === 'EGP') return `Send the top-up amount in Egyptian pounds (minimum ${minimumText}). Current rate: $1 = ${formatPaymentCurrencyAmount(rate, currency, lang)}.`;
    if (currency === 'IQD') return `Send the top-up amount in Iraqi dinars (minimum ${minimumText}). Current rate: $1 = ${formatPaymentCurrencyAmount(rate, currency, lang)}.`;
    return `Send the top-up amount in USD (minimum $${Number(minimum).toFixed(2)}).`;
  }
  if (currency === 'EGP') return `أرسل مبلغ الشحن بالجنيه المصري (الحد الأدنى ${minimumText}).\nسعر الصرف الحالي: 1$ = ${formatPaymentCurrencyAmount(rate, currency, lang)}.`;
  if (currency === 'IQD') return `أرسل مبلغ الشحن بالدينار العراقي (الحد الأدنى ${minimumText}).\nسعر الصرف الحالي: 1$ = ${formatPaymentCurrencyAmount(rate, currency, lang)}.`;
  return `أرسل مبلغ الشحن بالدولار (يقبل أقل من $1، الحد الأدنى $${Number(minimum).toFixed(2)}):`;
}

async function binanceShopEquivalentLine(amountUsd, lang = 'ar') {
  const context = await shopMoneyContext();
  if (normalizePaymentCurrency(context.currency) === 'USD') return '';
  const local = formatPaymentCurrencyAmount(Number(amountUsd || 0) * Number(context.rate || 1), context.currency, lang);
  const oneDollar = formatPaymentCurrencyAmount(Number(context.rate || 1), context.currency, lang);
  return lang === 'en'
    ? `💱 Store currency: $1 = ${oneDollar} — ${moneyUsd(amountUsd)} equals ${local}. Binance payment itself remains in USDT.`
    : `💱 عملة المتجر: 1$ = ${oneDollar} — ${moneyUsd(amountUsd)} تعادل ${local}. الدفع عبر Binance يبقى USDT.`;
}

async function createConfiguredPaymentMethod(data) {
  const row = await PaymentMethod.create({
    nameAr: data.nameAr,
    nameEn: data.nameEn || data.nameAr,
    paymentNumber: data.paymentNumber,
    iconCustomEmojiId: data.iconCustomEmojiId || null,
    iconAlt: data.iconAlt || '💳',
    isActive: true,
    sortOrder: 0,
    settlementCurrency: data.settlementCurrency || 'USD',
    ratePerUsd: Number(data.ratePerUsd || 1)
  });
  if (network.enabledClient()) await setSetting('custom_payment_override', 'true');
  return row;
}

async function localSuperQiNumber() {
  if (network.enabledClient()) return String(await getSetting('superqi_number', '')).trim();
  return String(await getSuperQiNumber()).trim();
}

async function externalPaymentButtons(lang, mode = 'pay') {
  const rows = [];
  const hidden = await getHiddenPaymentTypes();
  const localBinanceReady = await binancePay.configured();
  const localSuperQi = await localSuperQiNumber();

  if (localBinanceReady && !hidden.has('binance')) {
    rows.push([emojiButton('Binance ID', PREMIUM_EMOJI.binance, {
      callback_data: `${mode}:binance`,
      style: 'primary'
    })]);
  }
  if (localSuperQi && !hidden.has('superqi')) {
    rows.push([emojiButton(lang === 'en' ? 'SuperQi' : 'سوبركي', PREMIUM_EMOJI.superqi, {
      callback_data: `${mode}:superqi`,
      style: 'primary'
    })]);
  }

  const customMethods = await getActivePaymentMethods();
  for (const method of customMethods) {
    rows.push([emojiButton(localizedPaymentName(method, lang), customPaymentEmoji(method), {
      callback_data: `${mode}:custom:${method.id}`,
      style: 'primary'
    })]);
  }

  if (network.enabledClient()) {
    try {
      const inherited = await network.fallbackPayments();
      const methods = Array.isArray(inherited?.methods) ? inherited.methods : [];
      for (const method of methods) {
        const type = String(method.type || '');
        if (hidden.has(type)) continue;
        if (type === 'binance' && localBinanceReady) continue;
        if (type === 'superqi' && localSuperQi) continue;
        const emoji = method.iconCustomEmojiId
          ? { id: String(method.iconCustomEmojiId), alt: method.iconAlt || '💳' }
          : (type === 'binance' ? PREMIUM_EMOJI.binance : type === 'superqi' ? PREMIUM_EMOJI.superqi : null);
        const label = lang === 'en' ? (method.nameEn || method.nameAr) : (method.nameAr || method.nameEn);
        rows.push([emojiButton(label, emoji, {
          callback_data: `${mode}:network:${type}`,
          style: 'primary'
        })]);
      }
    } catch (error) {
      console.error('Inherited payment methods:', error.message);
    }
  }
  return rows;
}

async function showWalletMenu(chatId, user) {
  const [fresh, moneyContext] = await Promise.all([User.findByPk(user.id), shopMoneyContext()]);
  const inline = await externalPaymentButtons(user.lang, 'topup');
  if (isAdmin(user.id)) {
    inline.push([{ text: '➕ إضافة طريقة دفع', callback_data: 'adm:add_payment_method', style: 'success' }]);
  }
  return bot.sendMessage(chatId, `${premiumEmojiHtml(PREMIUM_EMOJI.wallet)} <b>${t(user.lang, 'walletBalance')}:</b> ${customerMoney(fresh.balance, moneyContext, user.lang)}`, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: inline }
  });
}

async function adminDashboardText() {
  const [open, notificationsEnabled] = await Promise.all([
    isStoreOpen(),
    automaticNotificationsEnabled()
  ]);
  const role = network.isMaster()
    ? 'البوت الرئيسي — Master'
    : network.enabledClient()
      ? 'بوت شريك — Client'
      : 'بوت مستقل';
  const shopName = network.enabledClient()
    ? String(config.network.shopName || 'متجري')
    : network.isMaster()
      ? String(config.network.ownerName || 'المتجر الرئيسي')
      : 'متجري';
  const currency = shopDisplayCurrency();

  return [
    '👑 <b>لوحة الإدارة</b>',
    '',
    `🏪 المتجر: <b>${escapeHtml(shopName)}</b>`,
    `🔗 النوع: <b>${escapeHtml(role)}</b>`,
    `🟢 الحالة: <b>${open ? 'مفتوح' : 'مغلق'}</b>`,
    `${notificationsEnabled ? '🔔' : '🔕'} الإشعارات: <b>${notificationsEnabled ? 'تشغيل' : 'إيقاف'}</b>`,
    `💱 العملة المحلية: <b>${escapeHtml(currency)}</b>`,
    '',
    'اختَر القسم اللي تريد تديره:'
  ].join('\n');
}

async function adminMenu() {
  const rows = [
    [emojiButton('المنتجات والمخزون', PREMIUM_EMOJI.products, { callback_data: 'adm:menu:products', style: 'primary' })],
    [{ text: '🧾 الطلبات والتسليم', callback_data: 'adm:menu:orders', style: 'primary' }],
    [{ text: '💳 الدفع والمحفظة', callback_data: 'adm:menu:payments', style: 'primary' }],
    [{ text: '👥 العملاء والتواصل', callback_data: 'adm:menu:users', style: 'primary' }],
    [{ text: '🎁 التسويق والإشعارات', callback_data: 'adm:menu:marketing', style: 'primary' }]
  ];

  if (network.isMaster() || network.enabledClient()) {
    rows.push([{ text: network.isMaster() ? '🤝 الشبكة والشركاء والحسابات' : '🤝 الشبكة والحسابات', callback_data: 'adm:menu:network', style: 'primary' }]);
  }

  rows.push([{ text: '⚙️ إعدادات المتجر', callback_data: 'adm:menu:settings', style: 'primary' }]);
  return { inline_keyboard: rows };
}

async function adminSectionMenu(section) {
  const back = [{ text: '⬅️ رجوع للوحة الإدارة', callback_data: 'adm:home' }];

  if (section === 'products') {
    return {
      title: '🛍️ <b>المنتجات والمخزون</b>\nإضافة المنتجات، تعديلها، تعبئة المخزون واسترجاع أي تسليم.',
      keyboard: [
        [{ text: '➕ إضافة منتج جديد', callback_data: 'adm:add_product', style: 'success' }],
        [emojiButton('إدارة المنتجات', PREMIUM_EMOJI.products, { callback_data: 'adm:products:0', style: 'primary' })],
        [{ text: '📥 إضافة مخزون', callback_data: 'adm:stock', style: 'success' }],
        [{ text: '🔎 استرجاع منتج / طلب', callback_data: 'adm:delivery_lookup' }],
        back
      ]
    };
  }

  if (section === 'orders') {
    return {
      title: '🧾 <b>الطلبات والتسليم</b>\nمتابعة الطلبات والدفعات المعلقة واسترجاع محتوى أي عملية بيع.',
      keyboard: [
        [{ text: '🧾 آخر الطلبات', callback_data: 'adm:orders', style: 'primary' }],
        [{ text: '⏳ الدفعات المعلقة والمراجعة', callback_data: 'adm:proofs' }],
        [{ text: '🔎 البحث برقم الطلب أو DLV', callback_data: 'adm:delivery_lookup' }],
        back
      ]
    };
  }

  if (section === 'payments') {
    return {
      title: '💳 <b>الدفع والمحفظة</b>\nطرق الدفع المحلية، الطرق الموروثة وBinance.',
      keyboard: [
        [{ text: '💳 إدارة طرق الدفع', callback_data: 'adm:payment_methods', style: 'primary' }],
        [{ text: '➕ إضافة طريقة دفع', callback_data: 'adm:add_payment_method', style: 'success' }],
        [emojiButton(network.enabledClient() ? 'تغيير API Binance' : 'إعداد API Binance', PREMIUM_EMOJI.binance, { callback_data: 'adm:binance_setup', style: 'primary' })],
        [{ text: '🗑 حذف Binance المحلي', callback_data: 'adm:binance_clear', style: 'danger' }],
        back
      ]
    };
  }

  if (section === 'users') {
    return {
      title: '👥 <b>العملاء والتواصل</b>\nإدارة حسابات الزبائن، الرصيد، الدعم والإعلانات.',
      keyboard: [
        [{ text: '👤 البحث عن مستخدم', callback_data: 'adm:user_lookup' }, { text: '💰 شحن مستخدم', callback_data: 'adm:user_credit' }],
        [emojiButton('الدعم', PREMIUM_EMOJI.support, { callback_data: 'adm:support', style: 'primary' })],
        [{ text: '📣 إرسال إعلان', callback_data: 'adm:broadcast' }],
        back
      ]
    };
  }

  if (section === 'marketing') {
    const notificationsEnabled = await automaticNotificationsEnabled();
    return {
      title: '🎁 <b>التسويق والإشعارات</b>\nالإحالات، القناة والإشعارات التلقائية.',
      keyboard: [
        [{ text: '🎁 الإحالات والهدايا', callback_data: 'adm:referrals', style: 'primary' }],
        [{ text: '📢 القناة الإجبارية', callback_data: 'adm:channel' }],
        [{ text: notificationsEnabled ? '🔔 الإشعارات: تشغيل' : '🔕 الإشعارات: إيقاف', callback_data: 'adm:notifications_toggle', style: notificationsEnabled ? 'success' : 'danger' }],
        back
      ]
    };
  }

  if (section === 'network') {
    const keyboard = [];
    if (network.isMaster()) keyboard.push([{ text: '🔗 API والشركاء', callback_data: 'adm:network', style: 'primary' }]);
    keyboard.push([{ text: '🤝 الحسابات والديون', callback_data: 'adm:network_accounts', style: 'primary' }]);
    keyboard.push(back);
    return {
      title: network.isMaster()
        ? '🤝 <b>الشبكة والشركاء والحسابات</b>\nإدارة بوتات الأصدقاء، API والديون بين المتاجر.'
        : '🤝 <b>الشبكة والحسابات</b>\nحساباتك وديونك مع باقي المتاجر.',
      keyboard
    };
  }

  if (section === 'settings') {
    const open = await isStoreOpen();
    return {
      title: '⚙️ <b>إعدادات المتجر</b>\nالإعدادات العامة وحالة فتح المتجر.',
      keyboard: [
        [{ text: '⚙️ الإعدادات العامة', callback_data: 'adm:settings', style: 'primary' }],
        [{ text: open ? '🔒 إغلاق المتجر' : '🔓 فتح المتجر', callback_data: 'adm:store_toggle', style: open ? 'danger' : 'success' }],
        back
      ]
    };
  }

  return null;
}

function rateAllowed(userId) {
  const now = Date.now();
  const recent = (memoryRate.get(userId) || []).filter(timestamp => now - timestamp < 10000);
  if (recent.length >= 12) return false;
  recent.push(now);
  memoryRate.set(userId, recent);
  return true;
}

async function answerCallback(id, text = '', alert = false) {
  try { await bot.answerCallbackQuery(id, { text, show_alert: alert }); }
  catch {}
}

async function sendCaptcha(chatId, userId, lang) {
  const captcha = randomCaptcha();
  captchaAnswers.set(userId, captcha.answer);
  const buttons = [];
  for (let index = 0; index < captcha.options.length; index += 2) {
    buttons.push(captcha.options.slice(index, index + 2).map(value => ({
      text: String(value),
      callback_data: `cap:${value}`
    })));
  }
  await bot.sendMessage(chatId, `${t(lang, 'verify')}\n\n<b>${captcha.question} = ?</b>`, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons }
  });
}

async function showMain(chatId, user) {
  if (!isAdmin(user.id)) {
    const joined = await ensureRequiredChannel(chatId, user);
    if (!joined) return;
    const status = await currentCommerceStatus();
    if (status?.suspended) {
      await bot.sendMessage(chatId, suspendedStoreText(user.lang, status), {
        reply_markup: suspendedMainKeyboard(user.lang)
      });
      return;
    }
    const open = await isStoreOpen();
    if (!open) {
      await bot.sendMessage(chatId, user.lang === 'en'
        ? '🔒 The store is temporarily closed. Support is still available.'
        : '🔒 المتجر مغلق مؤقتاً. تكدر تراسل الدعم من داخل البوت.', {
        reply_markup: await getMainKeyboard(user.lang)
      });
      return;
    }
  }

  // The redesigned store opens directly on the products list.
  if (!user.verified) {
    user.verified = true;
    await user.save({ fields: ['verified'] });
  }
  await processReferralIfReady(user);
  await bot.sendMessage(chatId, t(user.lang, 'welcome'), { reply_markup: await getMainKeyboard(user.lang) });
  await showProducts(chatId, user);

  if (!isAdmin(user.id) && !user.referralOfferShown) {
    const referral = await getReferralSettings();
    if (referral.enabled && referral.giftEnabled) {
      await bot.sendMessage(chatId, user.lang === 'en'
        ? `🎁 New-user offer: invite ${referral.target} verified friends and receive the selected free gift.`
        : `🎁 عرض المستخدم الجديد: شارك البوت ويا ${referral.target} أشخاص حقيقيين واحصل على الهدية المجانية المحددة بالإدارة.`);
      user.referralOfferShown = true;
      await user.save({ fields: ['referralOfferShown'] });
    }
  }
}

function stripTelegramCustomEmojiHtml(value) {
  return String(value || '').replace(/<tg-emoji[^>]*>/g, '').replace(/<\/tg-emoji>/g, '');
}

function productCaption(product, stock, lang, moneyContext) {
  const descriptionData = parseDescription(product.description);
  const name = lang === 'en' ? (product.nameEn || product.nameAr) : (product.nameAr || product.nameEn);
  const description = lang === 'en'
    ? (descriptionData.en || descriptionData.ar || '')
    : (descriptionData.ar || descriptionData.en || '');
  const warranty = lang === 'en'
    ? (descriptionData.warrantyEn || descriptionData.warrantyAr || '—')
    : (descriptionData.warrantyAr || descriptionData.warrantyEn || '—');

  let richName = escapeHtml(name);
  if (lang === 'ar' && descriptionData.nameArHtml) richName = descriptionData.nameArHtml;
  else if (lang === 'en' && descriptionData.nameEmojiId) {
    const alt = escapeHtml(descriptionData.nameEmojiAlt || '✨');
    richName = `<tg-emoji emoji-id="${escapeHtml(descriptionData.nameEmojiId)}">${alt}</tg-emoji> ${escapeHtml(name)}`;
  }

  const richDescription = lang === 'ar' && descriptionData.descriptionArHtml
    ? descriptionData.descriptionArHtml
    : escapeHtml(description || '—');
  const richWarranty = lang === 'ar' && descriptionData.warrantyArHtml
    ? descriptionData.warrantyArHtml
    : escapeHtml(warranty);

  return [
    `<b>${richName}</b>`,
    `💵 <b>${t(lang, 'price')}:</b> ${moneyUsd(product.price)}`,
    `📦 <b>${t(lang, 'stock')}:</b> ${stock}`,
    `📈 <b>${t(lang, 'sold')}:</b> ${Number(descriptionData.sold || 0)}`,
    `🛡 <b>${t(lang, 'warranty')}:</b> ${richWarranty}`,
    '',
    `❝ <b>${t(lang, 'description')}:</b>`,
    richDescription
  ].join('\n');
}

function productButton(product, stock, lang, moneyContext) {
  const descriptionData = parseDescription(product.description);
  const name = lang === 'en' ? (product.nameEn || product.nameAr) : (product.nameAr || product.nameEn);
  const displayName = descriptionData.nameEmojiId && descriptionData.nameEmojiAlt
    ? String(name).replace(descriptionData.nameEmojiAlt, '').trim() || name
    : name;
  const button = {
    text: `${displayName} | ${moneyUsd(product.price)} | 📦 ${stock}`,
    callback_data: `prod:${product.id}`,
    style: stock > 0 ? 'success' : 'danger'
  };
  if (descriptionData.nameEmojiId) button.icon_custom_emoji_id = descriptionData.nameEmojiId;
  return button;
}

async function sendProductKeyboard(chatId, lang, rows) {
  const moneyContext = await shopMoneyContext();
  const keyboard = rows.map(({ product, stock }) => [productButton(product, stock, lang, moneyContext)]);
  try {
    return await bot.sendMessage(chatId, t(lang, 'chooseProduct'), { reply_markup: { inline_keyboard: keyboard } });
  } catch (error) {
    // If the bot owner does not have Telegram Premium, custom button icons can be rejected.
    if (/custom emoji|icon_custom_emoji|BUTTON/i.test(String(error.message || ''))) {
      for (const row of keyboard) { delete row[0].icon_custom_emoji_id; delete row[0].style; }
      return bot.sendMessage(chatId, t(lang, 'chooseProduct'), { reply_markup: { inline_keyboard: keyboard } });
    }
    throw error;
  }
}

async function showProducts(chatId, user) {
  const rows = await listActiveProducts();
  if (!rows.length) return bot.sendMessage(chatId, t(user.lang, 'noProducts'));

  // Show every added active product. Split only to keep Telegram keyboards comfortable on mobile.
  const chunkSize = 25;
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    await sendProductKeyboard(chatId, user.lang, rows.slice(offset, offset + chunkSize));
  }
}

async function showProduct(chatId, user, merchantId) {
  const product = await Merchant.findByPk(merchantId);
  if (!product || !product.isActive) return bot.sendMessage(chatId, t(user.lang, 'noProducts'));
  const [stock, moneyContext] = await Promise.all([getProductStock(product.id), shopMoneyContext()]);
  const caption = productCaption(product, stock, user.lang, moneyContext);
  const markup = { inline_keyboard: [[{ text: t(user.lang, 'buy'), callback_data: `buy:${product.id}`, style: stock > 0 ? 'success' : 'danger' }]] };
  if (product.image) {
    try {
      await bot.sendPhoto(chatId, product.image, { caption, parse_mode: 'HTML', reply_markup: markup });
      return;
    } catch (error) {
      console.error('Product image failed:', error.message);
      if (/custom emoji|tg-emoji/i.test(String(error.message || ''))) {
        const safeCaption = stripTelegramCustomEmojiHtml(caption);
        await bot.sendPhoto(chatId, product.image, { caption: safeCaption, parse_mode: 'HTML', reply_markup: markup });
        return;
      }
    }
  }
  try {
    await bot.sendMessage(chatId, caption, { parse_mode: 'HTML', reply_markup: markup });
  } catch (error) {
    if (/custom emoji|tg-emoji/i.test(String(error.message || ''))) {
      return bot.sendMessage(chatId, stripTelegramCustomEmojiHtml(caption), { parse_mode: 'HTML', reply_markup: markup });
    }
    throw error;
  }
}

async function notifyAdmins(text, options = {}) {
  for (const adminId of config.admins) {
    try {
      await bot.sendMessage(adminId, text, { parse_mode: 'HTML', ...options });
    } catch (error) {
      console.error('Admin notify:', error.message);
    }
  }
}


function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getBroadcastUsers() {
  return User.findAll({
    attributes: ['id', 'lang'],
    where: { blocked: false, verified: true },
    order: [['id', 'ASC']]
  });
}

async function sendLocalizedAdminMessage(targetId, msg, targetLang) {
  if (targetLang !== 'en') return bot.copyMessage(targetId, msg.chat.id, msg.message_id);

  const sourceText = String(msg.text || msg.caption || '').trim();
  const translated = sourceText ? await translateArToEn(sourceText) : '';

  if (msg.photo?.length) return bot.sendPhoto(targetId, msg.photo[msg.photo.length - 1].file_id, { caption: translated || undefined });
  if (msg.video) return bot.sendVideo(targetId, msg.video.file_id, { caption: translated || undefined });
  if (msg.animation) return bot.sendAnimation(targetId, msg.animation.file_id, { caption: translated || undefined });
  if (msg.document) return bot.sendDocument(targetId, msg.document.file_id, { caption: translated || undefined });
  if (msg.audio) return bot.sendAudio(targetId, msg.audio.file_id, { caption: translated || undefined });
  if (msg.voice) return bot.sendVoice(targetId, msg.voice.file_id, { caption: translated || undefined });
  if (msg.text) return bot.sendMessage(targetId, translated || msg.text);
  return bot.copyMessage(targetId, msg.chat.id, msg.message_id);
}

async function broadcastLocalizedMessage(msg) {
  const users = await getBroadcastUsers();
  let sent = 0;
  let failed = 0;
  for (let index = 0; index < users.length; index += 1) {
    const target = users[index];
    if (isAdmin(target.id)) continue;
    try {
      await sendLocalizedAdminMessage(target.id, msg, target.lang === 'en' ? 'en' : 'ar');
      sent += 1;
    } catch (error) {
      failed += 1;
      console.error(`Localized broadcast to ${target.id}:`, error.message);
    }
    if ((index + 1) % 20 === 0) await wait(1000);
    else await wait(45);
  }
  return { sent, failed };
}

async function broadcastCopiedMessage(sourceChatId, sourceMessageId) {
  const users = await getBroadcastUsers();
  let sent = 0;
  let failed = 0;

  for (let index = 0; index < users.length; index += 1) {
    const target = users[index];
    if (isAdmin(target.id)) continue;

    try {
      await bot.copyMessage(target.id, sourceChatId, sourceMessageId);
      sent += 1;
    } catch (error) {
      failed += 1;
      console.error(`Broadcast to ${target.id}:`, error.message);
    }

    // Keep well below Telegram's broadcast limits.
    if ((index + 1) % 20 === 0) await wait(1000);
    else await wait(45);
  }

  return { sent, failed };
}

async function broadcastStockNotification(product, added, actorName = '') {
  if (!(await automaticNotificationsEnabled())) return { sent: 0, failed: 0, disabled: true };
  if (!product?.isActive || !Number.isInteger(added) || added < 1) {
    return { sent: 0, failed: 0 };
  }

  const users = await getBroadcastUsers();
  let sent = 0;
  let failed = 0;

  for (let index = 0; index < users.length; index += 1) {
    const target = users[index];
    if (isAdmin(target.id)) continue;

    const lang = target.lang === 'en' ? 'en' : 'ar';
    const productName = lang === 'en'
      ? (product.nameEn || product.nameAr)
      : (product.nameAr || product.nameEn);
    const itemName = product.type === 'code'
      ? (lang === 'en' ? (added === 1 ? 'code' : 'codes') : (added === 1 ? 'كود' : 'أكواد'))
      : product.type === 'account'
        ? (lang === 'en' ? (added === 1 ? 'account' : 'accounts') : (added === 1 ? 'حساب' : 'حسابات'))
        : (lang === 'en' ? (added === 1 ? 'item' : 'items') : (added === 1 ? 'قطعة' : 'قطع'));
    const message = lang === 'en'
      ? `📦 <b>Stock update</b>\n\nAdded <b>${added}</b> ${itemName} for <b>${escapeHtml(productName)}</b>.`
      : `📦 <b>إشعار مخزون</b>\n\nتمت إضافة <b>${added}</b> ${itemName} إلى <b>${escapeHtml(productName)}</b>.`;

    try {
      await bot.sendMessage(target.id, message, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[emojiButton(lang === 'en' ? 'View product' : 'عرض المنتج', PREMIUM_EMOJI.products, {
            callback_data: `prod:${product.id}`,
            style: 'success'
          })]]
        }
      });
      sent += 1;
    } catch (error) {
      failed += 1;
      console.error(`Stock notification to ${target.id}:`, error.message);
    }

    if ((index + 1) % 20 === 0) await wait(1000);
    else await wait(45);
  }

  return { sent, failed };
}

async function broadcastNewProductNotification(product, actorName = '') {
  if (!(await automaticNotificationsEnabled())) return { sent: 0, failed: 0, disabled: true };
  if (!product?.isActive) return { sent: 0, failed: 0 };

  const users = await getBroadcastUsers();
  const stock = await getProductStock(product.id);
  let sent = 0;
  let failed = 0;

  for (let index = 0; index < users.length; index += 1) {
    const target = users[index];
    if (isAdmin(target.id)) continue;
    const lang = target.lang === 'en' ? 'en' : 'ar';
    const name = lang === 'en' ? (product.nameEn || product.nameAr) : (product.nameAr || product.nameEn);
    const actorLine = actorName ? (lang === 'en' ? `\nAdded by: <b>${escapeHtml(actorName)}</b>` : `\nأضافه: <b>${escapeHtml(actorName)}</b>`) : '';
    const message = lang === 'en'
      ? `🆕 <b>New product</b>

<b>${escapeHtml(name)}</b>
Price: <b>${moneyUsd(product.price)}</b>${actorLine}`
      : `🆕 <b>منتج جديد</b>

<b>${escapeHtml(name)}</b>
السعر: <b>${moneyUsd(product.price)}</b>${actorLine}`;
    try {
      await bot.sendMessage(target.id, message, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[emojiButton(lang === 'en' ? 'View product' : 'عرض المنتج', PREMIUM_EMOJI.products, {
            callback_data: `prod:${product.id}`,
            style: stock > 0 ? 'success' : 'danger'
          })]]
        }
      });
      sent += 1;
    } catch (error) {
      failed += 1;
      console.error(`New product notification to ${target.id}:`, error.message);
    }
    if ((index + 1) % 20 === 0) await wait(1000);
    else await wait(45);
  }
  return { sent, failed };
}

async function notifyNewUser(user) {
  if (!user?._createdNow || isAdmin(user.id)) return;
  const referredBy = user.referredBy ? `<code>${user.referredBy}</code>` : '—';
  await notifyAdmins([
    '🆕 <b>انضم مستخدم جديد للبوت</b>',
    `الاسم: ${escapeHtml(user.firstName || '—')}`,
    `المعرف: ${user.username ? `@${escapeHtml(user.username)}` : '—'}`,
    `الآيدي: <code>${user.id}</code>`,
    `دعاه المستخدم: ${referredBy}`
  ].join('\n'));
}

async function isStoreOpen() {
  return String(await getSetting('store_open', 'true')).toLowerCase() !== 'false';
}

async function getRequiredChannel() {
  return String(await getSetting('required_channel', '')).trim();
}

function normalizeRequiredChannelInput(value) {
  const text = String(value || '').trim();
  if (!text || text === '-') return '';
  if (/^@[A-Za-z0-9_]{5,}$/.test(text)) return text;

  const publicLink = text.match(/^https?:\/\/(?:www\.)?t\.me\/([A-Za-z0-9_]{5,})\/?$/i);
  if (publicLink) return `@${publicLink[1]}`;

  return null;
}

function channelJoinUrl(channel) {
  const value = String(channel || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('@')) return `https://t.me/${value.slice(1)}`;
  return '';
}

async function userIsChannelMember(userId, channel) {
  if (!channel || isAdmin(userId)) return true;
  try {
    const member = await bot.getChatMember(channel, userId);
    if (['creator', 'administrator', 'member'].includes(member.status)) return true;
    if (member.status === 'restricted') return Boolean(member.is_member);
    return false;
  } catch (error) {
    console.error('Channel membership check:', error.message);
    return false;
  }
}

async function ensureRequiredChannel(chatId, user) {
  const channel = await getRequiredChannel();
  if (!channel) return true;
  if (await userIsChannelMember(user.id, channel)) return true;

  const url = channelJoinUrl(channel);
  const buttons = [];
  if (url) buttons.push([{ text: '📢 الانضمام للقناة', url }]);
  buttons.push([{ text: '✅ تحقق من الاشتراك', callback_data: 'joincheck' }]);
  await bot.sendMessage(chatId, user.lang === 'en'
    ? 'You must join the required channel before using the store.'
    : 'لازم تنضم للقناة الإجبارية قبل استخدام المتجر.', {
    reply_markup: { inline_keyboard: buttons }
  });
  return false;
}

async function processReferralIfReady(user) {
  if (!user?.verified) return;
  const channel = await getRequiredChannel();
  if (channel && !(await userIsChannelMember(user.id, channel))) return;
  const result = await finalizeReferral(user.id);
  if (!result.processed) return;
  const reachedGift = result.settings.giftEnabled && result.settings.giftProductId && result.count >= result.settings.target;
  await bot.sendMessage(result.referrerId, [
    '🎉 <b>انضم شخص من رابطك</b>',
    `تمت إضافة <b>${moneyUsd(result.rewardAmount)}</b> إلى محفظتك.`,
    `عدد إحالاتك المقبولة: <b>${result.count}</b>`,
    `رصيدك الجديد: <b>${moneyUsd(result.newBalance)}</b>`,
    reachedGift ? '\n🎁 وصلت للعدد المطلوب! جاري تجهيز هديتك تلقائياً.' : ''
  ].filter(Boolean).join('\n'), { parse_mode: 'HTML' }).catch(() => {});
  await notifyAdmins(`🎁 إحالة جديدة\nالداعي: <code>${result.referrerId}</code>\nالمستخدم الجديد: <code>${result.referredId}</code>\nالمكافأة: ${moneyUsd(result.rewardAmount)}`);

  if (reachedGift) {
    try {
      const gift = await claimReferralGift(result.referrerId);
      if (!gift.alreadyClaimed && gift.fulfillment) {
        await sendDeliveryToUser(result.referrerId, gift.fulfillment);
        await notifyAdmins(`🎉 تم تسليم هدية الإحالة تلقائياً\nالمستخدم: <code>${result.referrerId}</code>\nالطلب: <code>#${gift.fulfillment.order.id}</code>`);
      }
    } catch (error) {
      const text = error.message === 'OUT_OF_STOCK'
        ? '🎁 وصلت للهدية، لكن مخزونها نفد مؤقتاً. راح يظهر لك زر الاستلام من قسم الهدايا بعد إضافة المخزون.'
        : '🎁 وصلت للهدية. افتح قسم الهدايا والمشاركة لاستلامها.';
      await bot.sendMessage(result.referrerId, text).catch(() => {});
      await notifyAdmins(`⚠️ تعذر التسليم التلقائي لهدية الإحالة\nالمستخدم: <code>${result.referrerId}</code>\nالسبب: ${escapeHtml(error.message)}`);
    }
  }
}

async function showReferralPanel(chatId, user) {
  const username = await getBotUsername();
  const stats = await getReferralStats(user.id);
  if (!stats.settings.enabled) {
    return bot.sendMessage(chatId, user.lang === 'en'
      ? 'The referral system is currently hidden.'
      : 'نظام الهدايا والمشاركة متوقف حالياً.');
  }
  const link = username ? `https://t.me/${username}?start=ref_${user.id}` : '';
  const giftName = stats.giftProduct
    ? (user.lang === 'en' ? (stats.giftProduct.nameEn || stats.giftProduct.nameAr) : stats.giftProduct.nameAr)
    : (user.lang === 'en' ? 'Not selected yet' : 'غير محددة بعد');

  const text = user.lang === 'en'
    ? [
        '🎁 <b>Gifts & referrals</b>',
        `Reward per verified friend: <b>${moneyUsd(stats.settings.rewardAmount)}</b>`,
        `Accepted referrals: <b>${stats.count}</b>`,
        `Total earned: <b>${moneyUsd(stats.totalEarned)}</b>`,
        `Gift target: <b>${stats.settings.target}</b>`,
        `Gift: <b>${escapeHtml(giftName)}</b>`,
        '',
        'Your referral link:',
        `<code>${escapeHtml(link)}</code>`
      ].join('\n')
    : [
        '🎁 <b>الهدايا والمشاركة</b>',
        `مكافأة كل شخص حقيقي: <b>${moneyUsd(stats.settings.rewardAmount)}</b>`,
        `الإحالات المقبولة: <b>${stats.count}</b>`,
        `إجمالي الأرباح: <b>${moneyUsd(stats.totalEarned)}</b>`,
        `عدد الإحالات المطلوبة للهدية: <b>${stats.settings.target}</b>`,
        `الهدية الحالية: <b>${escapeHtml(giftName)}</b>`,
        '',
        'رابط المشاركة الخاص بك:',
        `<code>${escapeHtml(link)}</code>`
      ].join('\n');

  const buttons = [];
  if (link) {
    const shareText = user.lang === 'en'
      ? 'Join this digital store through my link.'
      : 'ادخل لهذا المتجر الرقمي من رابط المشاركة مالتي.';
    buttons.push([{
      text: user.lang === 'en' ? '📤 Share link' : '📤 مشاركة الرابط',
      url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(shareText)}`
    }]);
  }
  if (stats.eligibleForGift) buttons.push([{ text: '🎁 استلام الهدية', callback_data: 'gift:claim' }]);
  buttons.push([{ text: '🔄 تحديث', callback_data: 'gift:status' }]);
  await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
}

async function getOrCreateSupportTicket(userId) {
  let ticket = await SupportTicket.findOne({
    where: { userId, status: 'open' },
    order: [['id', 'DESC']]
  });
  if (!ticket) {
    ticket = await SupportTicket.create({
      userId,
      status: 'open',
      lastMessageAt: new Date()
    });
  }
  return ticket;
}

async function sendSupportMessageToAdmins(msg, user, ticket) {
  ticket.lastMessageAt = new Date();
  await ticket.save({ fields: ['lastMessageAt'] });

  for (const adminId of config.admins) {
    try {
      const header = await bot.sendMessage(adminId, [
        `${premiumEmojiHtml(PREMIUM_EMOJI.support)} <b>رسالة دعم جديدة</b>`,
        `التذكرة: <code>#${ticket.id}</code>`,
        `المستخدم: ${escapeHtml(user.firstName || '—')} — <code>${user.id}</code>`,
        `المعرف: ${user.username ? `@${escapeHtml(user.username)}` : '—'}`
      ].join('\n'), {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[
          { text: '✍️ رد', callback_data: `support:reply:${ticket.id}` },
          { text: '✅ إغلاق', callback_data: `support:close:${ticket.id}` }
        ]] }
      });
      await bot.copyMessage(adminId, msg.chat.id, msg.message_id).catch(async () => {
        if (msg.text) await bot.sendMessage(adminId, escapeHtml(msg.text), { parse_mode: 'HTML' });
      });
      if (!ticket.assignedAdminId && header?.chat?.id) {
        ticket.assignedAdminId = adminId;
        await ticket.save({ fields: ['assignedAdminId'] });
      }
    } catch (error) {
      console.error('Support relay:', error.message);
    }
  }
}

async function showSupportTickets(chatId) {
  const tickets = await SupportTicket.findAll({
    where: { status: 'open' },
    order: [['lastMessageAt', 'DESC']],
    limit: 30,
    include: [User]
  });
  if (!tickets.length) return bot.sendMessage(chatId, 'ماكو محادثات دعم مفتوحة.');
  const keyboard = tickets.map(ticket => [{
    text: `#${ticket.id} | ${ticket.User?.firstName || ticket.userId}`,
    callback_data: `support:reply:${ticket.id}`
  }]);
  return bot.sendMessage(chatId, `${premiumEmojiHtml(PREMIUM_EMOJI.support)} <b>محادثات الدعم المفتوحة:</b>`, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
}

function adminSharedDetails(fulfillment) {
  const details = [];
  for (const delivery of fulfillment.deliveries || []) {
    if (delivery.sharedPosition) {
      details.push(`المخزون #${delivery.codeId}: الاستخدام ${delivery.sharedPosition.current}/${delivery.sharedPosition.max}`);
    }
  }
  return details.join('\n');
}

async function sendDeliveryToUser(userId, fulfillment) {
  const user = await User.findByPk(userId);
  const lang = user?.lang || 'ar';
  const order = fulfillment.order;
  await bot.sendMessage(userId, `${t(lang, 'delivered')} — <b>#${order.id}</b>`, { parse_mode: 'HTML' });
  for (const delivery of fulfillment.deliveries || []) {
    // Do not reveal shared-use position or limits to customers.
    const deliveryIdLine = delivery.deliveryId
      ? `${lang === 'en' ? 'Delivery ID' : 'معرف المنتج المستلم'}: <code>${escapeHtml(delivery.deliveryId)}</code>\n`
      : '';
    await bot.sendMessage(userId, `${deliveryIdLine}${renderDelivery(delivery.payload, lang)}`, { parse_mode: 'HTML' });
  }
  if ((fulfillment.deliveries || []).some(delivery => delivery.waitingCode)) {
    await bot.sendMessage(userId, t(lang, 'waitingCode'));
    await notifyAdmins(`🔐 الطلب #${order.id} ينتظر كود.\nأرسل: <code>/code_${order.id}_123456</code>`);
  }
  const shared = adminSharedDetails(fulfillment);
  const deliveryIds = (fulfillment.deliveries || []).map(item => item.deliveryId).filter(Boolean);
  const commissionEarned = (fulfillment.deliveries || []).reduce((sum, item) => sum + Number(item.sellerCommissionUsd || 0), 0);
  await notifyAdmins([
    `✅ تم تسليم الطلب <b>#${order.id}</b>`,
    `المستخدم: <code>${order.userId}</code>`,
    commissionEarned > 0 ? `💸 عمولة بيع مخزون الآخرين بهذا الطلب: <b>$${commissionEarned.toFixed(2)}</b>` : '',
    deliveryIds.length ? `معرفات المنتجات المستلمة: ${deliveryIds.map(id => `<code>${escapeHtml(id)}</code>`).join(' | ')}` : '',
    shared ? `\n🔒 تفاصيل المشاركة السرية:\n${shared}` : ''
  ].filter(Boolean).join('\n'));
}

function binanceFailureText(result, lang = 'ar') {
  const ar = lang !== 'en';
  const messages = {
    NOT_CONFIGURED: ar ? 'إعدادات Binance ناقصة. راجع الإدارة.' : 'Binance settings are incomplete.',
    INVALID_AMOUNT: ar ? 'المبلغ غير صحيح.' : 'Invalid amount.',
    INVALID_ORDER_ID: ar ? 'رقم الطلب غير صحيح.' : 'Invalid order ID.',
    DUPLICATE_TRANSACTION: ar ? 'هذه العملية مستخدمة مسبقاً.' : 'This transaction was already used.',
    NO_MATCH: ar ? 'ما حصلت عملية مطابقة بعد. تأكد من رقم الطلب وانتظر دقيقة ثم جرّب.' : 'No matching transaction was found yet.',
    AMOUNT_OR_RECEIVER_MISMATCH: ar ? 'العملية موجودة لكن المبلغ أو المستلم غير مطابق.' : 'The transaction exists, but amount or receiver does not match.',
    OUT_OF_STOCK: ar ? 'الدفع صحيح لكن المخزون غير كافي. راجع الدعم.' : 'Payment is valid, but stock is insufficient. Contact support.',
    BINANCE_API_PERMISSION: ar ? 'مفتاح Binance مرفوض. لازم يكون API عادي بصلاحية القراءة، وIP مسموح إذا مقيّد.' : 'Binance API key was rejected. It needs read permission and an allowed IP if restricted.',
    REGION_RESTRICTED: ar ? 'التحقق التلقائي من Binance غير متاح من موقع السيرفر الحالي، لذلك سيتم تحويل العملية لمراجعة الإدارة.' : 'Automatic Binance verification is unavailable from the current server location, so the payment will be sent for admin review.'
  };
  if (result?.detail && messages[result.detail]) return messages[result.detail];
  return messages[result?.reason] || (ar ? `تعذر التحقق: ${result?.detail || result?.reason || 'خطأ'}` : `Verification failed: ${result?.detail || result?.reason || 'error'}`);
}

async function notifyBinanceResult(result) {
  if (!result || result.alreadyProcessed) return;
  if (result.topup) {
    const user = await User.findByPk(result.userId);
    const lang = user?.lang || 'ar';
    const manual = Boolean(result.manual);
    const moneyContext = await shopMoneyContext();
    const text = lang === 'en'
      ? `✅ Wallet credited through Binance${manual ? ' after admin verification' : ''}.\nAmount: <b>${customerMoney(result.amount, moneyContext, lang)}</b>\nNew balance: <b>${customerMoney(result.newBalance, moneyContext, lang)}</b>`
      : `✅ تم شحن محفظتك عبر Binance${manual ? ' بعد تحقق الإدارة' : ' تلقائياً'}.\nالمبلغ: <b>${customerMoney(result.amount, moneyContext, lang)}</b>\nالرصيد الجديد: <b>${customerMoney(result.newBalance, moneyContext, lang)}</b>`;
    await bot.sendMessage(result.userId, text, { parse_mode: 'HTML' });
    await notifyAdmins(`✅ شحن Binance ${manual ? 'بعد تحقق يدوي' : 'تلقائي'}\nالمستخدم: <code>${result.userId}</code>\nالمبلغ: <b>${moneyUsd(result.amount)}</b>\nرقم العملية: <code>${escapeHtml(result.transactionId || '')}</code>`);
    return;
  }
  if (result.fulfillment) await sendDeliveryToUser(result.fulfillment.order.userId, result.fulfillment);
}


async function queueBinanceManualReview(user, transferId, submittedOrderId) {
  const queued = await binancePay.queueManualReview(transferId, submittedOrderId);
  if (!queued.success) return queued;
  if (queued.alreadyProcessed) return queued;

  const transfer = queued.transfer;
  await clearState(user.id);
  const userText = user.lang === 'en'
    ? '🕓 Binance automatic verification is unavailable from the current server location. Your Order ID was saved and sent to the admin for manual verification. Do not pay again. You will be notified when it is reviewed.'
    : '🕓 التحقق التلقائي من Binance غير متاح من موقع السيرفر الحالي. تم حفظ رقم الطلب وإرساله للإدارة للتحقق اليدوي. لا تدفع مرة ثانية، وراح توصلك النتيجة بعد المراجعة.';
  await bot.sendMessage(user.id, userText);

  const typeText = transfer.orderId
    ? `شراء من المتجر — الطلب <b>#${transfer.orderId}</b>`
    : `شحن محفظة — العملية <b>#${transfer.balanceTransactionId || transfer.id}</b>`;
  await notifyAdmins([
    `${premiumEmojiHtml(PREMIUM_EMOJI.binance)} <b>Binance يحتاج تحقق يدوي</b>`,
    '',
    `النوع: ${typeText}`,
    `المستخدم: <code>${transfer.userId}</code>`,
    `المبلغ: <b>${moneyUsd(transfer.expectedAmount)}</b>`,
    `Order ID: <code>${escapeHtml(transfer.submittedOrderId || '')}</code>`,
    '',
    'افتح Binance وتأكد من العملية والمبلغ والمستلم قبل الضغط على موافقة.'
  ].join('\n'), {
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ تحققت منه — موافقة', callback_data: `binmanual:approve:${transfer.id}` },
        { text: '❌ رقم غير صحيح', callback_data: `binmanual:reject:${transfer.id}` }
      ]]
    }
  });
  return queued;
}

bot.on('message', async msg => {
  try {
    if (!msg.from || !rateAllowed(msg.from.id)) return;
    const user = await getOrCreateUser(msg.from);

    const startMatch = String(msg.text || '').match(/^\/start(?:\s+ref_(\d+))?$/i);
    if (startMatch?.[1] && user._createdNow) {
      await setReferralCandidate(user.id, Number(startMatch[1]));
      await user.reload();
      user._createdNow = true;
    }

    await notifyNewUser(user);

    if (user.blocked && !isAdmin(user.id)) {
      if (startMatch) await bot.sendMessage(msg.chat.id, '⛔ حسابك محظور من استخدام المتجر. راسل الدعم من حساب آخر.');
      return;
    }

    if (startMatch) return showMain(msg.chat.id, user);

    if (msg.text === '/admin') {
      if (!isAdmin(user.id)) return bot.sendMessage(msg.chat.id, t(user.lang, 'adminOnly'));
      return bot.sendMessage(msg.chat.id, await adminDashboardText(), {
        parse_mode: 'HTML',
        reply_markup: await adminMenu()
      });
    }

    if (isCancelText(msg.text)) {
      const state = parseState(user);
      if (state?.action === 'support_chat' && state.ticketId) {
        await SupportTicket.update({ status: 'closed', closedAt: new Date() }, { where: { id: state.ticketId, userId: user.id } });
      }
      if (state?.orderId) await refundWalletReservation(state.orderId).catch(() => {});
      await clearState(user.id);
      return bot.sendMessage(msg.chat.id, t(user.lang, 'cancelled'), { reply_markup: await getMainKeyboard(user.lang) });
    }

    if (!user.verified) { user.verified = true; await user.save({ fields: ['verified'] }); }

    const freshBeforeGate = await User.findByPk(user.id);
    const preGateState = parseState(freshBeforeGate);
    const supportRequested = msg.text === t('ar', 'support') || msg.text === t('en', 'support');

    if (!isAdmin(user.id) && preGateState?.action !== 'support_chat' && !supportRequested) {
      const joined = await ensureRequiredChannel(msg.chat.id, user);
      if (!joined) return;
    }

    const state = preGateState;
    if (state) {
      // Menu buttons never become inventory, descriptions, or passwords by mistake.
      if (isMainMenuText(msg.text)) {
        await clearState(user.id);
      } else {
        const consumed = await handleStateMessage(msg, user, state);
        if (consumed) return;
      }
    }

    if (msg.text === t('ar', 'products') || msg.text === t('en', 'products')) {
      if (!isAdmin(user.id)) {
        const status = await currentCommerceStatus();
        if (status?.suspended) return bot.sendMessage(msg.chat.id, suspendedStoreText(user.lang, status), { reply_markup: suspendedMainKeyboard(user.lang) });
        if (!(await isStoreOpen())) return bot.sendMessage(msg.chat.id, '🔒 المتجر مغلق مؤقتاً.');
      }
      return showProducts(msg.chat.id, user, 0);
    }

    if (msg.text === t('ar', 'wallet') || msg.text === t('en', 'wallet')) {
      if (!isAdmin(user.id)) {
        const status = await currentCommerceStatus();
        if (status?.suspended) return bot.sendMessage(msg.chat.id, suspendedStoreText(user.lang, status), { reply_markup: suspendedMainKeyboard(user.lang) });
        if (!(await isStoreOpen())) return bot.sendMessage(msg.chat.id, '🔒 المتجر مغلق مؤقتاً.');
      }
      return showWalletMenu(msg.chat.id, user);
    }

    if (msg.text === t('ar', 'orders') || msg.text === t('en', 'orders')) return showOrders(msg.chat.id, user);

    if (msg.text === t('ar', 'support') || msg.text === t('en', 'support')) {
      const ticket = await getOrCreateSupportTicket(user.id);
      await setState(user.id, { action: 'support_chat', ticketId: ticket.id });
      return bot.sendMessage(msg.chat.id, user.lang === 'en'
        ? `${premiumEmojiHtml(PREMIUM_EMOJI.support)} Send your message, photo, or file here. Support will reply through this bot.\nSend /cancel to close.`
        : `${premiumEmojiHtml(PREMIUM_EMOJI.support)} أرسل رسالتك أو صورتك أو ملفك هنا، والدعم يرد عليك من نفس البوت.\nاكتب إغلاق أو /cancel لإنهاء المحادثة.`, {
        parse_mode: 'HTML',
        reply_markup: cancelInlineKeyboard()
      });
    }

    if (msg.text === '🎁 الهدايا والمشاركة' || msg.text === '🎁 Gifts & referrals') {
      return showReferralPanel(msg.chat.id, user);
    }

    if (msg.text === '📢 قناتنا' || msg.text === '📢 Our channel') {
      const channel = await getRequiredChannel();
      const url = channelJoinUrl(channel);
      if (!channel || !url) {
        return bot.sendMessage(msg.chat.id, user.lang === 'en'
          ? 'The channel has not been configured yet.'
          : 'القناة غير مضافة حالياً.');
      }
      return bot.sendMessage(msg.chat.id, user.lang === 'en'
        ? '📢 Join our official channel:'
        : '📢 اشترك بقناتنا الرسمية:', {
        reply_markup: {
          inline_keyboard: [[{
            text: user.lang === 'en' ? '📢 Join channel' : '📢 الاشتراك بالقناة',
            url
          }]]
        }
      });
    }

    if (msg.text === t('ar', 'language') || msg.text === t('en', 'language')) {
      user.lang = user.lang === 'ar' ? 'en' : 'ar';
      await user.save();
      return showMain(msg.chat.id, user);
    }
  } catch (error) {
    console.error('Message handler error:', error);
    if (msg.chat?.id) await bot.sendMessage(msg.chat.id, '❌ صار خطأ داخلي. جرّب مرة ثانية.').catch(() => {});
  }
});

bot.on('callback_query', async query => {
  if (!query.from || !rateAllowed(query.from.id)) return;
  const user = await getOrCreateUser(query.from);
  const data = String(query.data || '');

  if (user.blocked && !isAdmin(user.id)) return answerCallback(query.id, 'حسابك محظور.', true);
  if (data === 'noop') return answerCallback(query.id);

  if (data === 'flow:cancel') {
    const state = parseState(await User.findByPk(user.id));
    if (state?.action === 'support_chat' && state.ticketId) {
      await SupportTicket.update({ status: 'closed', closedAt: new Date() }, { where: { id: state.ticketId, userId: user.id } });
    }
    if (state?.orderId) await refundWalletReservation(state.orderId).catch(() => {});
    await clearState(user.id);
    await answerCallback(query.id, t(user.lang, 'cancelled'));
    return bot.sendMessage(user.id, t(user.lang, 'cancelled'), { reply_markup: await getMainKeyboard(user.lang) });
  }

  if (data.startsWith('cap:')) {
    const chosen = Number(data.split(':')[1]);
    if (chosen !== captchaAnswers.get(user.id)) {
      await answerCallback(query.id, t(user.lang, 'wrong'), true);
      return sendCaptcha(query.message.chat.id, user.id, user.lang);
    }
    captchaAnswers.delete(user.id);
    user.verified = true;
    await user.save();
    await answerCallback(query.id, t(user.lang, 'verified'));
    try {
      await bot.editMessageText(t(user.lang, 'verified'), {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id
      });
    } catch {}
    return showMain(query.message.chat.id, user);
  }

  if (data === 'joincheck') {
    if (!user.verified) return answerCallback(query.id, 'أكمل التحقق أولاً.', true);
    const channel = await getRequiredChannel();
    const joined = await userIsChannelMember(user.id, channel);
    if (!joined) return answerCallback(query.id, 'بعدك مو مشترك بالقناة.', true);
    await answerCallback(query.id, '✅ تم التحقق.');
    await processReferralIfReady(user);
    return showMain(query.message.chat.id, user);
  }

  if (!user.verified) return answerCallback(query.id, 'Verify first', true);

  if (!isAdmin(user.id)) {
    const channel = await getRequiredChannel();
    if (channel && !(await userIsChannelMember(user.id, channel))) {
      await answerCallback(query.id, 'اشترك بالقناة أولاً.', true);
      return ensureRequiredChannel(query.message.chat.id, user);
    }
  }

  try {
    if (data === 'gift:status') {
      await answerCallback(query.id);
      return showReferralPanel(query.message.chat.id, user);
    }

    if (data === 'gift:claim') {
      await answerCallback(query.id, 'جاري تجهيز الهدية...');
      try {
        const result = await claimReferralGift(user.id);
        if (result.alreadyClaimed) return bot.sendMessage(user.id, '✅ استلمت هدية هذا العرض سابقاً.');
        await sendDeliveryToUser(user.id, result.fulfillment);
        await notifyAdmins(`🎁 تم تسليم هدية الإحالة\nالمستخدم: <code>${user.id}</code>\nالطلب: <code>#${result.fulfillment.order.id}</code>`);
      } catch (error) {
        const text = {
          GIFT_DISABLED: 'نظام الهدايا متوقف حالياً.',
          GIFT_PRODUCT_NOT_SET: 'الإدارة ما محددة منتج الهدية بعد.',
          NOT_ENOUGH_REFERRALS: 'بعدك ما وصلت للعدد المطلوب.',
          OUT_OF_STOCK: 'مخزون الهدية نفد مؤقتاً، جرّب لاحقاً.',
          PRODUCT_NOT_FOUND: 'منتج الهدية غير موجود.',
          GIFT_IN_PROGRESS: 'جاري تجهيز هديتك بالفعل، انتظر قليلاً.'
        }[error.message] || `تعذر تسليم الهدية: ${error.message}`;
        await bot.sendMessage(user.id, `❌ ${text}`);
      }
      return;
    }

    if (data.startsWith('support:reply:')) {
      if (!isAdmin(user.id)) return answerCallback(query.id, t(user.lang, 'adminOnly'), true);
      const ticketId = Number(data.split(':')[2]);
      const ticket = await SupportTicket.findByPk(ticketId);
      if (!ticket || ticket.status !== 'open') return answerCallback(query.id, 'التذكرة مغلقة أو غير موجودة.', true);
      await setState(user.id, { action: 'admin_support_reply', ticketId, targetId: ticket.userId });
      await answerCallback(query.id);
      return bot.sendMessage(user.id, `أرسل ردك الآن للتذكرة #${ticketId}.\nتقدر ترسل نص أو صورة أو ملف، واكتب إغلاق للإلغاء.`, {
        reply_markup: cancelInlineKeyboard()
      });
    }

    if (data.startsWith('support:close:')) {
      if (!isAdmin(user.id)) return answerCallback(query.id, t(user.lang, 'adminOnly'), true);
      const ticketId = Number(data.split(':')[2]);
      const ticket = await SupportTicket.findByPk(ticketId);
      if (!ticket) return answerCallback(query.id, 'التذكرة غير موجودة.', true);
      ticket.status = 'closed';
      ticket.closedAt = new Date();
      await ticket.save();
      const targetUser = await User.findByPk(ticket.userId);
      const targetState = parseState(targetUser);
      if (targetState?.action === 'support_chat' && Number(targetState.ticketId) === ticket.id) {
        await clearState(ticket.userId);
      }
      await answerCallback(query.id, 'تم إغلاق التذكرة.');
      await bot.sendMessage(ticket.userId, '✅ تم إغلاق محادثة الدعم. تكدر تفتح محادثة جديدة من زر الدعم.').catch(() => {});
      return;
    }

    if (data.startsWith('products:')) {
      if (!isAdmin(user.id)) {
        const status = await currentCommerceStatus();
        if (status?.suspended) return answerCallback(query.id, user.lang === 'en' ? 'Store temporarily paused for account settlement.' : 'المتجر متوقف مؤقتاً لحين تسوية الحسابات.', true);
        if (!(await isStoreOpen())) return answerCallback(query.id, 'المتجر مغلق مؤقتاً.', true);
      }
      await answerCallback(query.id);
      return showProducts(query.message.chat.id, user, Number(data.split(':')[1]));
    }
    if (data.startsWith('prod:')) {
      if (!isAdmin(user.id)) {
        const status = await currentCommerceStatus();
        if (status?.suspended) return answerCallback(query.id, user.lang === 'en' ? 'Store temporarily paused for account settlement.' : 'المتجر متوقف مؤقتاً لحين تسوية الحسابات.', true);
        if (!(await isStoreOpen())) return answerCallback(query.id, 'المتجر مغلق مؤقتاً.', true);
      }
      await answerCallback(query.id);
      return showProduct(query.message.chat.id, user, Number(data.split(':')[1]));
    }
    if (data.startsWith('buy:')) {
      if (!isAdmin(user.id)) {
        const status = await currentCommerceStatus();
        if (status?.suspended) return answerCallback(query.id, user.lang === 'en' ? 'Store temporarily paused for account settlement.' : 'المتجر متوقف مؤقتاً لحين تسوية الحسابات.', true);
        if (!(await isStoreOpen())) return answerCallback(query.id, 'المتجر مغلق مؤقتاً.', true);
      }
      return handleBuy(query, user, Number(data.split(':')[1]));
    }
    if (data.startsWith('qty:')) {
      if (!isAdmin(user.id) && (await currentCommerceStatus())?.suspended) return answerCallback(query.id, user.lang === 'en' ? 'Store temporarily paused.' : 'المتجر متوقف مؤقتاً.', true);
      return handleQuantity(query, user, data);
    }
    if (data.startsWith('qtycustom:')) {
      if (!isAdmin(user.id) && (await currentCommerceStatus())?.suspended) return answerCallback(query.id, user.lang === 'en' ? 'Store temporarily paused.' : 'المتجر متوقف مؤقتاً.', true);
      const merchantId = Number(data.split(':')[1]);
      const product = await Merchant.findByPk(merchantId);
      if (!product) return answerCallback(query.id, t(user.lang, 'outOfStock'), true);
      const stock = await getProductStock(product.id);
      if (stock < 1) return answerCallback(query.id, t(user.lang, 'outOfStock'), true);
      await setState(user.id, { action: 'custom_quantity', merchantId: product.id });
      await answerCallback(query.id);
      return bot.sendMessage(user.id, user.lang === 'en' ? `Send quantity from 1 to ${Math.min(stock, 100)}:` : `أرسل الكمية من 1 إلى ${Math.min(stock, 100)}:`, { reply_markup: cancelInlineKeyboard() });
    }
    if (data.startsWith('pay:')) {
      if (!isAdmin(user.id) && (await currentCommerceStatus())?.suspended) return answerCallback(query.id, user.lang === 'en' ? 'Store temporarily paused.' : 'المتجر متوقف مؤقتاً.', true);
      return handlePayment(query, user, data);
    }
    if (data.startsWith('topup:')) {
      if (!isAdmin(user.id) && (await currentCommerceStatus())?.suspended) return answerCallback(query.id, user.lang === 'en' ? 'Store temporarily paused.' : 'المتجر متوقف مؤقتاً.', true);
      return handleTopupStart(query, user, data.slice('topup:'.length));
    }
    if (data.startsWith('order:')) return showOrder(query.message.chat.id, user, Number(data.split(':')[1]), query.id);

    if (data.startsWith('sq:approve:') || data.startsWith('sq:reject:')) return handleSuperQiAdmin(query, data);
    if (data.startsWith('sqtop:approve:') || data.startsWith('sqtop:reject:')) return handleSuperQiTopupAdmin(query, data);
    if (data.startsWith('cmtop:approve:') || data.startsWith('cmtop:reject:')) return handleCustomTopupAdmin(query, data);
    if (data.startsWith('cm:approve:') || data.startsWith('cm:reject:')) return handleCustomPaymentAdmin(query, data);
    if (data.startsWith('binmanual:approve:') || data.startsWith('binmanual:reject:')) return handleBinanceManualAdmin(query, data);
    if (data.startsWith('netord:approve:') || data.startsWith('netord:reject:')) return handleNetworkOrderAdmin(query, data);
    if (data.startsWith('nettop:approve:') || data.startsWith('nettop:reject:')) return handleNetworkTopupAdmin(query, data);

    if (data.startsWith('adm:')) {
      if (!isAdmin(user.id)) return answerCallback(query.id, t(user.lang, 'adminOnly'), true);
      return handleAdminCallback(query, user, data);
    }
  } catch (error) {
    console.error('Callback error:', error);
    await answerCallback(query.id, `خطأ: ${error.message}`, true);
  }
});

async function handleBuy(query, user, merchantId) {
  const product = await Merchant.findByPk(merchantId);
  const stock = product ? await getProductStock(product.id) : 0;
  if (!product || !product.isActive || stock < 1) return answerCallback(query.id, t(user.lang, 'outOfStock'), true);
  const max = Math.min(stock, 100);
  const presets = [...new Set([1, 2, 3, 5, 10, max].filter(q => q >= 1 && q <= max))].sort((a, b) => a - b);
  const rows = [];
  for (let i = 0; i < presets.length; i += 3) {
    rows.push(presets.slice(i, i + 3).map(quantity => ({
      text: quantity === max && max > 10 ? `${quantity} — ${user.lang === 'en' ? 'all' : 'الكل'}` : String(quantity),
      callback_data: `qty:${merchantId}:${quantity}`
    })));
  }
  if (max > 1) rows.push([{ text: user.lang === 'en' ? '✏️ Other quantity' : '✏️ كمية أخرى', callback_data: `qtycustom:${merchantId}` }]);
  await answerCallback(query.id);
  return bot.sendMessage(query.message.chat.id, `${t(user.lang, 'quantity')} 1-${max}\n${user.lang === 'en' ? 'Available network stock' : 'المخزون الكلي بالشبكة'}: ${stock}`, {
    reply_markup: { inline_keyboard: rows }
  });
}

async function sendCheckoutOptions(chatId, user, product, quantity) {
  const [freshUser, moneyContext] = await Promise.all([User.findByPk(user.id), shopMoneyContext()]);
  const total = Number(product.price) * Number(quantity);
  const balance = Number(freshUser?.balance || 0);
  const canUseWallet = balance + 1e-9 >= total;
  const missing = Math.max(0, total - balance);

  await setState(user.id, { action: 'checkout', merchantId: product.id, quantity: Number(quantity) });

  const buttons = [];
  if (canUseWallet) {
    buttons.push([emojiButton(t(user.lang, 'payWallet'), PREMIUM_EMOJI.wallet, {
      callback_data: 'pay:wallet',
      style: 'primary'
    })]);
  }
  buttons.push(...await externalPaymentButtons(user.lang, 'pay'));

  const lines = [];
  if (!canUseWallet) {
    lines.push(`${premiumEmojiHtml(PREMIUM_EMOJI.wallet)} <b>${t(user.lang, 'walletBalance')}:</b> ${customerMoney(balance, moneyContext, user.lang)}`);
    lines.push(`💰 <b>${user.lang === 'en' ? 'Product total' : 'سعر المنتج'}:</b> ${moneyUsd(total)}`);
    lines.push(`➕ <b>${user.lang === 'en' ? 'Amount needed to complete payment' : 'يجب إرسال لإكمال الدفع'}:</b> ${moneyUsd(missing)}`);
    lines.push('');
    lines.push(user.lang === 'en'
      ? 'Choose a payment method below. Your current wallet balance will be used automatically and you only pay the difference.'
      : 'اختَر طريقة الدفع أدناه. رصيد محفظتك الحالي ينحسب تلقائياً وتدفع الفرق فقط.');
  } else {
    lines.push(`${t(user.lang, 'payment')}`);
    lines.push(`💰 <b>${moneyUsd(total)}</b>`);
  }

  return bot.sendMessage(chatId, lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons }
  });
}

async function handleQuantity(query, user, data) {
  const [, merchantIdRaw, quantityRaw] = data.split(':');
  const merchantId = Number(merchantIdRaw);
  const quantity = Number(quantityRaw);
  const product = await Merchant.findByPk(merchantId);
  const stock = product ? await getProductStock(product.id) : 0;
  if (!product || stock < quantity) return answerCallback(query.id, t(user.lang, 'outOfStock'), true);
  await answerCallback(query.id);
  return sendCheckoutOptions(query.message.chat.id, user, product, quantity);
}

async function handlePayment(query, user, data) {
  const methodToken = data.slice('pay:'.length);
  const hiddenTypes = await getHiddenPaymentTypes();
  const visibilityType = methodToken.startsWith('network:')
    ? methodToken.slice('network:'.length)
    : (methodToken === 'binance' || methodToken === 'superqi' ? methodToken : null);
  if (visibilityType && hiddenTypes.has(visibilityType)) {
    return answerCallback(query.id, user.lang === 'en' ? 'This payment method is hidden in this store.' : 'طريقة الدفع مخفية في هذا المتجر.', true);
  }
  const freshUser = await User.findByPk(user.id);
  const state = parseState(freshUser);
  if (!state || state.action !== 'checkout') return answerCallback(query.id, t(user.lang, 'cancelled'), true);

  const product = await Merchant.findByPk(state.merchantId);
  if (!product) return answerCallback(query.id, t(user.lang, 'outOfStock'), true);
  const expectedTotal = Number(product.price) * Number(state.quantity);

  let method = methodToken;
  let customMethod = null;
  if (methodToken.startsWith('custom:')) {
    const customId = Number(methodToken.split(':')[1]);
    customMethod = await PaymentMethod.findOne({ where: { id: customId, isActive: true } });
    if (!customMethod) return answerCallback(query.id, user.lang === 'en' ? 'Payment method is unavailable.' : 'طريقة الدفع غير متاحة.', true);
    method = `custom:${customMethod.id}`;
  }

  if (method === 'wallet' && Number(freshUser.balance || 0) + 1e-9 < expectedTotal) {
    await answerCallback(query.id);
    return sendCheckoutOptions(query.message.chat.id, user, product, state.quantity);
  }

  const order = await createOrder({
    userId: user.id,
    merchantId: state.merchantId,
    quantity: state.quantity,
    paymentMethod: method
  });

  // If the wallet contains part of the price, reserve only that part and request
  // the exact remaining difference through the external payment method.
  if (method !== 'wallet') {
    const balance = Number(freshUser.balance || 0);
    if (balance > 0 && balance + 1e-9 < expectedTotal) {
      await reserveWalletForOrder(order.id);
      await order.reload();
    }
  }

  await clearState(user.id);
  await answerCallback(query.id);

  if (method === 'wallet') {
    try {
      const fulfillment = await payFromWallet(order.id);
      return sendDeliveryToUser(user.id, fulfillment);
    } catch (error) {
      if (error.message === 'INSUFFICIENT_BALANCE') {
        await order.update({ status: 'cancelled' }).catch(() => {});
        return sendCheckoutOptions(user.id, user, product, state.quantity);
      }
      if (error.message === 'OUT_OF_STOCK') return bot.sendMessage(user.id, t(user.lang, 'outOfStock'));
      throw error;
    }
  }

  const amountDue = Number(order.externalAmount || order.totalAmount);

  if (method === 'binance') {
    const created = await binancePay.createForOrder(order.id);
    if (!created.success) {
      await refundWalletReservation(order.id).catch(() => {});
      await order.update({ status: 'payment_error' }).catch(() => {});
      return bot.sendMessage(user.id, binanceFailureText(created, user.lang));
    }
    return sendBinanceInstructions(user, created.transfer, order.id);
  }

  if (method.startsWith('network:')) {
    const inheritedType = method.slice('network:'.length);
    const options = await network.fallbackPayments();
    const inherited = (options.methods || []).find(row => row.type === inheritedType);
    if (!inherited) {
      await refundWalletReservation(order.id).catch(() => {});
      return bot.sendMessage(user.id, user.lang === 'en' ? 'Payment method is unavailable.' : 'طريقة الدفع غير متاحة حالياً.');
    }
    order.paymentOrigin = 'network_fallback';
    await order.save({ fields: ['paymentOrigin'] });

    if (inheritedType === 'binance') {
      let intent;
      try {
        intent = await network.createFallbackBinanceIntent(amountDue, user.id, 'purchase', user.firstName || user.username || String(user.id));
      } catch (error) {
        await refundWalletReservation(order.id).catch(() => {});
        await order.update({ status: 'cancelled' }).catch(() => {});
        invalidateCommerceStatus();
        if (String(error.message || '').startsWith('SHOP_DEBT_SUSPENDED:')) {
          return bot.sendMessage(user.id, suspendedStoreText(user.lang), { reply_markup: suspendedMainKeyboard(user.lang) });
        }
        return bot.sendMessage(user.id, user.lang === 'en'
          ? '⛔ The main payment network is temporarily unavailable. No amount was taken from your wallet; try again later.'
          : '⛔ شبكة الدفع الرئيسية غير متاحة مؤقتاً. ما انخصم عليك شيء من المحفظة؛ جرّب لاحقاً.');
      }
      order.paymentRef = `network-binance:${intent.intentId}`;
      await order.save({ fields: ['paymentRef'] });
      await setState(user.id, { action: 'network_binance_verify_order', orderId: order.id, intentId: intent.intentId });
      const equivalentLine = await binanceShopEquivalentLine(amountDue, user.lang);
      return bot.sendMessage(user.id, [
        `✅ <b>${user.lang === 'en' ? 'Payment request created' : 'تم إنشاء طلب الدفع'}</b>`,
        '',
        `💰 ${user.lang === 'en' ? 'Send' : 'حوّل'}: <b>${Number(amountDue).toFixed(2)} USDT</b>`,
        equivalentLine,
        `🆔 ${user.lang === 'en' ? 'To Binance ID' : 'إلى Binance ID'}:`,
        `<code>${escapeHtml(intent.payId)}</code>`,
        '',
        user.lang === 'en' ? 'After sending, send the Binance Order ID here:' : 'بعد التحويل ارسل معرف الطلب هنا:'
      ].filter(Boolean).join('\n'), { parse_mode: 'HTML', reply_markup: cancelInlineKeyboard() });
    }

    const rate = await getIqdRate();
    const inheritedLocal = paymentLocalAmount(amountDue, inherited);
    await setState(user.id, {
      action: 'network_manual_order_proof',
      orderId: order.id,
      networkMethod: inheritedType,
      methodNameAr: inherited.nameAr,
      methodNameEn: inherited.nameEn
    });
    const methodName = user.lang === 'en' ? (inherited.nameEn || inherited.nameAr) : (inherited.nameAr || inherited.nameEn);
    return bot.sendMessage(user.id, [
      `💳 <b>${escapeHtml(methodName)}</b>`,
      '',
      `${user.lang === 'en' ? 'Amount' : 'المبلغ'}: <b>${moneyUsd(amountDue)}</b>`,
      `${user.lang === 'en' ? 'Payment currency amount' : 'المبلغ بعملة الدفع'}: <b>${inheritedLocal.amount.toFixed(inheritedLocal.currency === 'IQD' ? 0 : 2)} ${inheritedLocal.currency}</b>`,
      `${user.lang === 'en' ? 'Send to' : 'حوّل إلى'}: <code>${escapeHtml(inherited.paymentNumber)}</code>`,
      '',
      t(user.lang, 'proofPrompt')
    ].join('\n'), { parse_mode: 'HTML', reply_markup: cancelInlineKeyboard() });
  }

  const rate = await getIqdRate();
  const iqd = amountDue * rate;

  if (method === 'superqi') {
    const number = await localSuperQiNumber();
    await setState(user.id, { action: 'superqi_proof', orderId: order.id });
    const title = user.lang === 'en' ? 'Pay with SuperQi' : 'الدفع عبر سوبركي';
    return bot.sendMessage(user.id, [
      `${premiumEmojiHtml(PREMIUM_EMOJI.superqi)} <b>${title}</b>`,
      '',
      `${user.lang === 'en' ? 'Amount' : 'المبلغ'}: <b>${moneyUsd(amountDue)}</b>`,
      `${user.lang === 'en' ? 'IQD' : 'بالدينار'}: <b>${moneyIqd(iqd)}</b>`,
      `${user.lang === 'en' ? 'Send to' : 'حوّل إلى'}: <code>${escapeHtml(number)}</code>`,
      '',
      t(user.lang, 'proofPrompt'),
      user.lang === 'en' ? 'Send /cancel to cancel.' : 'اكتب إغلاق إذا تريد إلغاء العملية.'
    ].join('\n'), { parse_mode: 'HTML', reply_markup: cancelInlineKeyboard() });
  }

  if (customMethod) {
    await setState(user.id, { action: 'custom_payment_proof', orderId: order.id, paymentMethodId: customMethod.id });
    const methodName = localizedPaymentName(customMethod, user.lang);
    const icon = customPaymentEmoji(customMethod);
    const local = paymentLocalAmount(amountDue, customMethod);
    return bot.sendMessage(user.id, [
      `${icon ? premiumEmojiHtml(icon) : '💳'} <b>${escapeHtml(methodName)}</b>`,
      '',
      `${user.lang === 'en' ? 'Amount' : 'المبلغ'}: <b>${moneyUsd(amountDue)}</b>`,
      `${user.lang === 'en' ? 'Amount in payment currency' : 'المبلغ بعملة الدفع'}: <b>${local.amount.toFixed(local.currency === 'IQD' ? 0 : 2)} ${local.currency}</b>`,
      `${user.lang === 'en' ? 'Send to' : 'حوّل إلى'}: <code>${escapeHtml(customMethod.paymentNumber)}</code>`,
      '',
      t(user.lang, 'proofPrompt'),
      user.lang === 'en' ? 'Send /cancel to cancel.' : 'اكتب إغلاق إذا تريد إلغاء العملية.'
    ].join('\n'), { parse_mode: 'HTML', reply_markup: cancelInlineKeyboard() });
  }

  await refundWalletReservation(order.id).catch(() => {});
  return bot.sendMessage(user.id, user.lang === 'en' ? 'Payment method is unavailable.' : 'طريقة الدفع غير متاحة.');
}

async function sendBinanceInstructions(user, transfer, orderId = null) {
  await setState(user.id, { action: 'binance_verify', transferId: transfer.id, orderId });
  const base = await binancePay.instructions(transfer, user.lang);
  const equivalentLine = await binanceShopEquivalentLine(Number(transfer.expectedAmount || 0), user.lang);
  let text = base;
  if (equivalentLine) {
    const lines = String(base).split('\n');
    const insertAt = Math.max(0, lines.length - 1);
    lines.splice(insertAt, 0, equivalentLine, '');
    text = lines.join('\n');
  }
  return bot.sendMessage(user.id, text, {
    parse_mode: 'HTML',
    reply_markup: cancelInlineKeyboard()
  });
}

async function handleTopupStart(query, user, methodToken) {
  const hiddenTypes = await getHiddenPaymentTypes();
  const visibilityType = methodToken.startsWith('network:')
    ? methodToken.slice('network:'.length)
    : (methodToken === 'binance' || methodToken === 'superqi' ? methodToken : null);
  if (visibilityType && hiddenTypes.has(visibilityType)) {
    return answerCallback(query.id, user.lang === 'en' ? 'This payment method is hidden in this store.' : 'طريقة الدفع مخفية في هذا المتجر.', true);
  }
  if (methodToken === 'binance' && !(await binancePay.configured())) {
    return answerCallback(query.id, 'Binance غير مهيأ.', true);
  }

  let inputContext;
  try {
    inputContext = await resolveTopupInputContext(methodToken);
  } catch (error) {
    console.error('Resolve top-up input currency:', error.message);
    inputContext = null;
  }
  if (!inputContext) {
    return answerCallback(query.id, user.lang === 'en' ? 'Payment method is unavailable.' : 'طريقة الدفع غير متاحة.', true);
  }

  await setState(user.id, {
    action: 'wallet_topup_amount',
    method: methodToken,
    topupCurrency: inputContext.currency,
    topupRatePerUsd: inputContext.rate,
    topupMinimumUsd: inputContext.minimumUsd
  });
  await answerCallback(query.id);
  return bot.sendMessage(user.id, topupAmountPrompt(inputContext, user.lang), { reply_markup: cancelInlineKeyboard() });
}

async function handleStateMessage(msg, user, state) {
  if (state.action === 'support_chat') {
    const ticket = await SupportTicket.findByPk(state.ticketId);
    if (!ticket || ticket.status !== 'open' || String(ticket.userId) !== String(user.id)) {
      await clearState(user.id);
      return true;
    }
    await sendSupportMessageToAdmins(msg, user, ticket);
    await bot.sendMessage(user.id, '✅ وصلت رسالتك للدعم. تقدر ترسل رسالة ثانية أو تكتب إغلاق لإنهاء المحادثة.');
    return true;
  }

  if (state.action === 'admin_support_reply' && isAdmin(user.id)) {
    const ticket = await SupportTicket.findByPk(state.ticketId);
    if (!ticket || ticket.status !== 'open') {
      await clearState(user.id);
      await bot.sendMessage(user.id, '❌ التذكرة مغلقة أو غير موجودة.');
      return true;
    }
    const targetUser = await User.findByPk(ticket.userId);
    const targetLang = targetUser?.lang === 'en' ? 'en' : 'ar';
    await bot.sendMessage(ticket.userId, targetLang === 'en'
      ? `${premiumEmojiHtml(PREMIUM_EMOJI.support)} <b>Support reply — ticket #${ticket.id}</b>`
      : `${premiumEmojiHtml(PREMIUM_EMOJI.support)} <b>رد الدعم — التذكرة #${ticket.id}</b>`, { parse_mode: 'HTML' }).catch(() => {});
    await sendLocalizedAdminMessage(ticket.userId, msg, targetLang).catch(async () => {
      if (msg.text) await bot.sendMessage(ticket.userId, targetLang === 'en' ? await translateArToEn(msg.text) : msg.text);
    });
    ticket.assignedAdminId = user.id;
    ticket.lastMessageAt = new Date();
    await ticket.save();
    await clearState(user.id);
    await bot.sendMessage(user.id, '✅ تم إرسال الرد للمستخدم.');
    return true;
  }

  if (state.action === 'custom_quantity') {
    if (!isAdmin(user.id) && (await currentCommerceStatus())?.suspended) {
      await clearState(user.id);
      await bot.sendMessage(user.id, suspendedStoreText(user.lang), { reply_markup: suspendedMainKeyboard(user.lang) });
      return true;
    }
    const quantity = Number(String(msg.text || '').trim());
    const product = await Merchant.findByPk(state.merchantId);
    const stock = product ? await getProductStock(product.id) : 0;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > Math.min(stock, 100)) {
      await bot.sendMessage(user.id, user.lang === 'en' ? `❌ Send a whole number from 1 to ${Math.min(stock, 100)}.` : `❌ أرسل رقم صحيح من 1 إلى ${Math.min(stock, 100)}.`);
      return true;
    }
    await clearState(user.id);
    return sendCheckoutOptions(user.id, user, product, quantity).then(() => true);
  }

  if (state.action === 'wallet_topup_amount') {
    if (!isAdmin(user.id) && (await currentCommerceStatus())?.suspended) {
      await clearState(user.id);
      await bot.sendMessage(user.id, suspendedStoreText(user.lang), { reply_markup: suspendedMainKeyboard(user.lang) });
      return true;
    }

    const enteredAmount = Number(String(msg.text || '').trim().replace(/,/g, ''));
    const inputCurrency = normalizePaymentCurrency(state.topupCurrency || 'USD');
    const inputRate = Number(state.topupRatePerUsd || 1);
    const minimumUsd = Math.max(0.01, Number(state.topupMinimumUsd || (state.method === 'binance' ? config.binance.minAmount : 0.01)));
    const minimumLocal = minimumTopupLocalAmount(inputRate, inputCurrency, minimumUsd);
    const exactUsd = enteredAmount / (Number.isFinite(inputRate) && inputRate > 0 ? inputRate : 1);
    const amount = Number(exactUsd.toFixed(2));

    if (!Number.isFinite(enteredAmount) || enteredAmount < minimumLocal || !Number.isFinite(amount) || amount < minimumUsd || amount > 100000) {
      await bot.sendMessage(user.id, user.lang === 'en'
        ? `❌ Invalid amount. Minimum: ${formatPaymentCurrencyAmount(minimumLocal, inputCurrency, user.lang)}.`
        : `❌ المبلغ غير صحيح. الحد الأدنى: ${formatPaymentCurrencyAmount(minimumLocal, inputCurrency, user.lang)}.`);
      return true;
    }

    if (state.method === 'binance') {
      const created = await binancePay.createForTopup(user.id, amount);
      if (!created.success) {
        await clearState(user.id);
        await bot.sendMessage(user.id, binanceFailureText(created, user.lang));
        return true;
      }
      await clearState(user.id);
      await sendBinanceInstructions(user, created.transfer);
      return true;
    }

    if (String(state.method || '').startsWith('network:')) {
      const inheritedType = String(state.method).slice('network:'.length);
      const options = await network.fallbackPayments();
      const inherited = (options.methods || []).find(row => row.type === inheritedType);
      if (!inherited) {
        await clearState(user.id);
        await bot.sendMessage(user.id, user.lang === 'en' ? '❌ Payment method is unavailable.' : '❌ طريقة الدفع غير متاحة.');
        return true;
      }

      if (inheritedType === 'binance') {
        let intent;
        try {
          intent = await network.createFallbackBinanceIntent(amount, user.id, 'topup', user.firstName || user.username || String(user.id));
        } catch (error) {
          await clearState(user.id);
          invalidateCommerceStatus();
          if (String(error.message || '').startsWith('SHOP_DEBT_SUSPENDED:')) {
            await bot.sendMessage(user.id, suspendedStoreText(user.lang), { reply_markup: suspendedMainKeyboard(user.lang) });
            return true;
          }
          await bot.sendMessage(user.id, user.lang === 'en'
            ? '⛔ The main payment network is temporarily unavailable. Try again later.'
            : '⛔ شبكة الدفع الرئيسية غير متاحة مؤقتاً. جرّب لاحقاً.');
          return true;
        }
        const transaction = await BalanceTransaction.create({
          userId: user.id,
          amount,
          type: 'deposit',
          txid: `NETBIN-${intent.intentId}`,
          caption: `Inherited Binance wallet topup (${enteredAmount} ${inputCurrency})`,
          status: 'awaiting_binance_id',
          paymentOrigin: 'network_fallback',
          networkMethod: 'binance',
          lastReminderAt: new Date()
        });
        await setState(user.id, { action: 'network_binance_verify_topup', intentId: intent.intentId, transactionId: transaction.id });
        const equivalentLine = await binanceShopEquivalentLine(amount, user.lang);
        await bot.sendMessage(user.id, [
          `✅ <b>${user.lang === 'en' ? 'Top-up request created' : 'تم إنشاء طلب الشحن'}</b>`,
          '',
          `💰 ${user.lang === 'en' ? 'Send' : 'حوّل'}: <b>${Number(amount).toFixed(2)} USDT</b>`,
          equivalentLine,
          `🆔 ${user.lang === 'en' ? 'To Binance ID' : 'إلى Binance ID'}:`,
          `<code>${escapeHtml(intent.payId)}</code>`,
          '',
          user.lang === 'en' ? 'After sending, send the Binance Order ID here:' : 'بعد التحويل ارسل معرف الطلب هنا:'
        ].filter(Boolean).join('\n'), { parse_mode: 'HTML', reply_markup: cancelInlineKeyboard() });
        return true;
      }

      const methodName = user.lang === 'en' ? (inherited.nameEn || inherited.nameAr) : (inherited.nameAr || inherited.nameEn);
      const transaction = await BalanceTransaction.create({
        userId: user.id,
        amount,
        type: 'deposit',
        txid: `NETMAN-${Date.now()}-${user.id}`,
        caption: `${methodName} inherited manual wallet topup (${enteredAmount} ${inputCurrency})`,
        status: 'awaiting_proof',
        paymentOrigin: 'network_fallback',
        networkMethod: inheritedType,
        lastReminderAt: new Date()
      });
      await setState(user.id, {
        action: 'network_manual_topup_proof',
        transactionId: transaction.id,
        networkMethod: inheritedType,
        methodNameAr: inherited.nameAr,
        methodNameEn: inherited.nameEn
      });
      await bot.sendMessage(user.id, [
        `💳 <b>${escapeHtml(methodName)}</b>`,
        '',
        `${user.lang === 'en' ? 'Top-up amount' : 'مبلغ الشحن'}: <b>${formatPaymentCurrencyAmount(enteredAmount, inputCurrency, user.lang)}</b>`,
        `${user.lang === 'en' ? 'Wallet credit' : 'يضاف للمحفظة'}: <b>${moneyUsd(amount)}</b>`,
        `${user.lang === 'en' ? 'Send to' : 'حوّل إلى'}: <code>${escapeHtml(inherited.paymentNumber)}</code>`,
        '',
        t(user.lang, 'proofPrompt')
      ].join('\n'), { parse_mode: 'HTML', reply_markup: cancelInlineKeyboard() });
      return true;
    }

    let paymentMethod = null;
    let methodName = user.lang === 'en' ? 'SuperQi' : 'سوبركي';
    let number = await localSuperQiNumber();
    let icon = PREMIUM_EMOJI.superqi;
    let stateAction = 'superqi_topup_proof';
    let txPrefix = 'SUPERQI';
    let paymentMethodId = null;

    if (String(state.method || '').startsWith('custom:')) {
      const paymentMethodIdRaw = Number(String(state.method).split(':')[1]);
      paymentMethod = await PaymentMethod.findOne({ where: { id: paymentMethodIdRaw, isActive: true } });
      if (!paymentMethod) {
        await clearState(user.id);
        await bot.sendMessage(user.id, user.lang === 'en' ? '❌ Payment method is unavailable.' : '❌ طريقة الدفع غير متاحة.');
        return true;
      }
      methodName = localizedPaymentName(paymentMethod, user.lang);
      number = paymentMethod.paymentNumber;
      icon = customPaymentEmoji(paymentMethod);
      stateAction = 'custom_topup_proof';
      txPrefix = `CUSTOM-${paymentMethod.id}`;
      paymentMethodId = paymentMethod.id;
    }

    const transaction = await BalanceTransaction.create({
      userId: user.id,
      amount,
      type: 'deposit',
      paymentMethodId,
      txid: `${txPrefix}-${Date.now()}-${user.id}`,
      caption: `${methodName} manual wallet topup (${enteredAmount} ${inputCurrency})`,
      status: 'awaiting_proof',
      lastReminderAt: new Date(),
      paymentOrigin: 'local'
    });
    await setState(user.id, { action: stateAction, transactionId: transaction.id, paymentMethodId });
    await bot.sendMessage(user.id, [
      `${icon ? premiumEmojiHtml(icon) : '💳'} <b>${user.lang === 'en' ? `Top up via ${escapeHtml(methodName)}` : `شحن المحفظة عبر ${escapeHtml(methodName)}`}</b>`,
      '',
      `${user.lang === 'en' ? 'Top-up amount' : 'مبلغ الشحن'}: <b>${formatPaymentCurrencyAmount(enteredAmount, inputCurrency, user.lang)}</b>`,
      `${user.lang === 'en' ? 'Wallet credit' : 'يضاف للمحفظة'}: <b>${moneyUsd(amount)}</b>`,
      `${user.lang === 'en' ? 'Exchange rate' : 'سعر الصرف'}: <b>$1 = ${formatPaymentCurrencyAmount(inputRate, inputCurrency, user.lang)}</b>`,
      '',
      `${user.lang === 'en' ? 'Send to' : 'حوّل إلى الرقم'}:`,
      `<code>${escapeHtml(number)}</code>`,
      '',
      t(user.lang, 'proofPrompt')
    ].join('\n'), { parse_mode: 'HTML', reply_markup: cancelInlineKeyboard() });
    return true;
  }


  if (state.action === 'network_binance_verify_order') {
    const submittedOrderId = String(msg.text || '').trim();
    await bot.sendMessage(user.id, '🔄 جاري التحقق من Binance...');
    const result = await network.verifyFallbackBinanceIntent(state.intentId, submittedOrderId);
    if (!result.verified) {
      const reason = result.reason || 'NO_MATCH';
      await bot.sendMessage(user.id, user.lang === 'en'
        ? `❌ Could not verify this Order ID (${reason}). Send the correct Order ID or /cancel.`
        : `❌ تعذر التحقق من معرف الطلب (${reason}). أرسل المعرف الصحيح أو /cancel.`);
      return true;
    }
    const order = await PurchaseOrder.findByPk(state.orderId);
    if (!order || String(order.userId) !== String(user.id)) {
      await clearState(user.id);
      return true;
    }
    const fulfillment = await completeExternalPayment(order.id, `network-binance:${result.transactionId}`);
    await network.recordFallbackSettlement({
      amountUsd: Number(order.externalAmount || order.totalAmount),
      method: 'binance',
      sourceRef: result.transactionId,
      customerName: user.firstName || user.username || String(user.id),
      activity: 'purchase'
    }).catch(error => console.error('Settlement notify failed:', error.message));
    await clearState(user.id);
    await sendDeliveryToUser(user.id, fulfillment);
    return true;
  }

  if (state.action === 'network_binance_verify_topup') {
    const submittedOrderId = String(msg.text || '').trim();
    await bot.sendMessage(user.id, '🔄 جاري التحقق من Binance...');
    const result = await network.verifyFallbackBinanceIntent(state.intentId, submittedOrderId);
    if (!result.verified) {
      await bot.sendMessage(user.id, user.lang === 'en'
        ? `❌ Could not verify this Order ID (${result.reason || 'NO_MATCH'}). Try again or /cancel.`
        : `❌ تعذر التحقق من معرف الطلب (${result.reason || 'NO_MATCH'}). حاول مرة ثانية أو /cancel.`);
      return true;
    }
    const tx = await sequelize.transaction();
    let amount = 0;
    try {
      const ledger = await BalanceTransaction.findByPk(state.transactionId, { transaction: tx, lock: tx.LOCK.UPDATE });
      const lockedUser = await User.findByPk(user.id, { transaction: tx, lock: tx.LOCK.UPDATE });
      if (!ledger || ledger.status === 'completed') {
        await tx.commit();
        await clearState(user.id);
        return true;
      }
      amount = Number(ledger.amount || 0);
      lockedUser.balance = Number(lockedUser.balance || 0) + amount;
      await lockedUser.save({ transaction: tx });
      ledger.status = 'completed';
      ledger.txid = result.transactionId;
      await ledger.save({ transaction: tx });
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }
    await network.recordFallbackSettlement({
      amountUsd: amount,
      method: 'binance',
      sourceRef: result.transactionId,
      customerName: user.firstName || user.username || String(user.id),
      activity: 'topup'
    }).catch(error => console.error('Settlement notify failed:', error.message));
    await clearState(user.id);
    const [updated, moneyContext] = await Promise.all([User.findByPk(user.id), shopMoneyContext()]);
    await bot.sendMessage(user.id, `✅ ${user.lang === 'en' ? 'Balance credited' : 'تم شحن رصيدك'}: <b>${customerMoney(amount, moneyContext, user.lang)}</b>\n${t(user.lang, 'walletBalance')}: <b>${customerMoney(updated.balance, moneyContext, user.lang)}</b>`, { parse_mode: 'HTML' });
    return true;
  }

  if (state.action === 'network_manual_order_proof') {
    const fileId = msg.photo?.length ? msg.photo[msg.photo.length - 1].file_id : msg.document?.file_id;
    if (!fileId) {
      await bot.sendMessage(user.id, user.lang === 'en' ? 'Send the payment receipt as a photo or file.' : 'أرسل إيصال الدفع كصورة أو ملف.');
      return true;
    }
    const order = await PurchaseOrder.findByPk(state.orderId);
    if (!order || String(order.userId) !== String(user.id) || order.status !== 'pending_payment') {
      await clearState(user.id);
      return true;
    }
    order.proofFileId = fileId;
    order.status = 'proof_pending';
    await order.save();
    await clearState(user.id);
    const product = await Merchant.findByPk(order.merchantId);
    const caption = [
      '🌐 <b>إيصال عبر طريقة دفع مشتركة</b>',
      `الطريقة: <b>${escapeHtml(state.methodNameAr || state.networkMethod)}</b>`,
      `الطلب: <code>#${order.id}</code>`,
      `المنتج: <b>${escapeHtml(product?.nameAr || '')}</b>`,
      `المستخدم: <code>${user.id}</code>`,
      `المبلغ المطلوب: <b>${moneyUsd(order.externalAmount || order.totalAmount)}</b>`
    ].join('\n');
    for (const adminId of config.admins) {
      const options = {
        caption,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[
          { text: '✅ موافقة وتسليم', callback_data: `netord:approve:${order.id}`, style: 'success' },
          { text: '❌ رفض', callback_data: `netord:reject:${order.id}`, style: 'danger' }
        ]] }
      };
      if (msg.photo?.length) await bot.sendPhoto(adminId, fileId, options).catch(() => {});
      else await bot.sendDocument(adminId, fileId, options).catch(() => {});
    }
    await bot.sendMessage(user.id, user.lang === 'en' ? '✅ Receipt sent to the store owner for approval.' : '✅ تم إرسال الإيصال لصاحب البوت للموافقة.');
    return true;
  }

  if (state.action === 'network_manual_topup_proof') {
    const fileId = msg.photo?.length ? msg.photo[msg.photo.length - 1].file_id : msg.document?.file_id;
    if (!fileId) {
      await bot.sendMessage(user.id, user.lang === 'en' ? 'Send the payment receipt as a photo or file.' : 'أرسل إيصال الدفع كصورة أو ملف.');
      return true;
    }
    const ledger = await BalanceTransaction.findByPk(state.transactionId);
    if (!ledger || String(ledger.userId) !== String(user.id) || ledger.status !== 'awaiting_proof') {
      await clearState(user.id);
      return true;
    }
    ledger.imageFileId = fileId;
    ledger.status = 'proof_pending';
    await ledger.save();
    await clearState(user.id);
    const caption = [
      '🌐 <b>إيصال شحن عبر طريقة دفع مشتركة</b>',
      `الطريقة: <b>${escapeHtml(state.methodNameAr || state.networkMethod)}</b>`,
      `المستخدم: <code>${user.id}</code>`,
      `المبلغ: <b>${moneyUsd(ledger.amount)}</b>`
    ].join('\n');
    for (const adminId of config.admins) {
      const options = {
        caption,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[
          { text: '✅ موافقة وشحن', callback_data: `nettop:approve:${ledger.id}`, style: 'success' },
          { text: '❌ رفض', callback_data: `nettop:reject:${ledger.id}`, style: 'danger' }
        ]] }
      };
      if (msg.photo?.length) await bot.sendPhoto(adminId, fileId, options).catch(() => {});
      else await bot.sendDocument(adminId, fileId, options).catch(() => {});
    }
    await bot.sendMessage(user.id, user.lang === 'en' ? '✅ Receipt sent to the store owner for approval.' : '✅ تم إرسال الإيصال لصاحب البوت للموافقة.');
    return true;
  }

  if (state.action === 'binance_verify') {
    const submittedOrderId = String(msg.text || '').trim();
    await bot.sendMessage(user.id, '🔄 جاري التحقق من Binance...');
    const result = await binancePay.verify(state.transferId, submittedOrderId);
    if (!result.success) {
      if (result.reason === 'REGION_RESTRICTED' || result.detail === 'REGION_RESTRICTED') {
        const queued = await queueBinanceManualReview(user, state.transferId, submittedOrderId);
        if (queued.success) {
          if (queued.alreadyProcessed) {
            await clearState(user.id);
            await bot.sendMessage(user.id, '✅ هذه العملية متحققة ومضافة سابقاً.');
          }
          return true;
        }
        await bot.sendMessage(user.id, `❌ ${binanceFailureText(queued, user.lang)}\n\nتأكد من رقم الطلب وحاول مرة ثانية، أو /cancel للإلغاء.`);
        return true;
      }
      if (result.paymentConfirmed) {
        await clearState(user.id);
        const text = user.lang === 'en'
          ? '✅ Binance payment was confirmed, but automatic delivery is waiting for stock. Support has been notified; do not pay again.'
          : '✅ تم تأكيد دفع Binance، لكن التسليم التلقائي ينتظر توفر المخزون. تم إشعار الإدارة، لا تدفع مرة ثانية.';
        await bot.sendMessage(user.id, text);
        await notifyAdmins(`⚠️ دفع Binance مؤكد والتسليم متوقف\nالمستخدم: <code>${user.id}</code>\nالتحويل: <code>${state.transferId}</code>\nالسبب: ${escapeHtml(result.reason || 'خطأ بالتسليم')}`);
        return true;
      }
      await bot.sendMessage(user.id, `❌ ${binanceFailureText(result, user.lang)}\n\nأرسل رقم الطلب الصحيح للمحاولة مرة ثانية، أو /cancel للإلغاء.`);
      return true;
    }
    await clearState(user.id);
    if (result.alreadyProcessed) {
      await bot.sendMessage(user.id, '✅ هذه العملية متحققة ومضافة سابقاً.');
      return true;
    }
    await notifyBinanceResult(result);
    return true;
  }

  if (state.action === 'superqi_topup_proof') {
    if (!msg.photo?.length) {
      await bot.sendMessage(user.id, t(user.lang, 'proofPrompt'));
      return true;
    }
    const transaction = await BalanceTransaction.findByPk(state.transactionId);
    if (!transaction || String(transaction.userId) !== String(user.id) || transaction.status !== 'awaiting_proof') {
      await clearState(user.id);
      return true;
    }
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    await transaction.update({ imageFileId: fileId, status: 'proof_pending' });
    await clearState(user.id);
    const rate = await getIqdRate();
    for (const adminId of config.admins) {
      try {
        await bot.sendPhoto(adminId, fileId, {
          caption: [
            `${premiumEmojiHtml(PREMIUM_EMOJI.superqi)} <b>إيصال شحن سوبركي</b>`,
            `العملية: <code>#${transaction.id}</code>`,
            `المستخدم: ${escapeHtml(user.firstName || '')} — <code>${user.id}</code>`,
            `المبلغ: ${moneyUsd(transaction.amount)} = ${moneyIqd(Number(transaction.amount) * rate)}`
          ].join('\n'),
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[
            { text: '✅ موافقة وشحن', callback_data: `sqtop:approve:${transaction.id}` },
            { text: '❌ رفض', callback_data: `sqtop:reject:${transaction.id}` }
          ]] }
        });
      } catch (error) {
        console.error('SuperQi topup admin:', error.message);
      }
    }
    await bot.sendMessage(user.id, t(user.lang, 'proofSent'));
    return true;
  }

  if (state.action === 'superqi_proof') {
    if (!msg.photo?.length) {
      await bot.sendMessage(user.id, t(user.lang, 'proofPrompt'));
      return true;
    }
    const order = await PurchaseOrder.findByPk(state.orderId);
    if (!order || String(order.userId) !== String(user.id) || order.status !== 'pending_payment') {
      await clearState(user.id);
      return true;
    }
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    await order.update({ proofFileId: fileId, status: 'proof_pending' });
    await clearState(user.id);
    const product = await Merchant.findByPk(order.merchantId);
    const rate = await getIqdRate();
    for (const adminId of config.admins) {
      try {
        const sent = await bot.sendPhoto(adminId, fileId, {
          caption: [
            `${premiumEmojiHtml(PREMIUM_EMOJI.superqi)} <b>إيصال سوبركي</b>`,
            `الطلب: <code>#${order.id}</code>`,
            `الزبون: ${escapeHtml(user.firstName || '')} — <code>${user.id}</code>`,
            `المنتج: ${escapeHtml(product?.nameAr || '')}`,
            `الكمية: ${order.quantity}`,
            `المبلغ المطلوب: ${moneyUsd(order.externalAmount || order.totalAmount)} = ${moneyIqd(Number(order.externalAmount || order.totalAmount) * rate)}`
          ].join('\n'),
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[
            { text: '✅ موافقة وتسليم', callback_data: `sq:approve:${order.id}` },
            { text: '❌ رفض', callback_data: `sq:reject:${order.id}` }
          ]] }
        });
        if (!order.adminMessageId) await order.update({ adminMessageId: sent.message_id });
      } catch (error) {
        console.error('SuperQi admin photo:', error.message);
      }
    }
    await bot.sendMessage(user.id, t(user.lang, 'proofSent'));
    return true;
  }

  if (state.action === 'custom_topup_proof') {
    if (!msg.photo?.length) {
      await bot.sendMessage(user.id, t(user.lang, 'proofPrompt'));
      return true;
    }
    const transaction = await BalanceTransaction.findByPk(state.transactionId);
    const paymentMethod = await PaymentMethod.findByPk(state.paymentMethodId || transaction?.paymentMethodId);
    if (!transaction || !paymentMethod || String(transaction.userId) !== String(user.id) || transaction.status !== 'awaiting_proof') {
      await clearState(user.id);
      return true;
    }
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    await transaction.update({ imageFileId: fileId, status: 'proof_pending' });
    await clearState(user.id);
    const rate = await getIqdRate();
    const icon = customPaymentEmoji(paymentMethod);
    for (const adminId of config.admins) {
      try {
        await bot.sendPhoto(adminId, fileId, {
          caption: [
            `${icon ? premiumEmojiHtml(icon) : '💳'} <b>إيصال شحن ${escapeHtml(paymentMethod.nameAr)}</b>`,
            `العملية: <code>#${transaction.id}</code>`,
            `المستخدم: ${escapeHtml(user.firstName || '')} — <code>${user.id}</code>`,
            `المبلغ: ${moneyUsd(transaction.amount)} = ${moneyIqd(Number(transaction.amount) * rate)}`,
            `رقم الدفع: <code>${escapeHtml(paymentMethod.paymentNumber)}</code>`
          ].join('\n'),
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[
            { text: '✅ موافقة وشحن', callback_data: `cmtop:approve:${transaction.id}` },
            { text: '❌ رفض', callback_data: `cmtop:reject:${transaction.id}` }
          ]] }
        });
      } catch (error) {
        console.error('Custom topup admin:', error.message);
      }
    }
    await bot.sendMessage(user.id, t(user.lang, 'proofSent'));
    return true;
  }

  if (state.action === 'custom_payment_proof') {
    if (!msg.photo?.length) {
      await bot.sendMessage(user.id, t(user.lang, 'proofPrompt'));
      return true;
    }
    const order = await PurchaseOrder.findByPk(state.orderId);
    const paymentMethod = await PaymentMethod.findByPk(state.paymentMethodId);
    if (!order || !paymentMethod || String(order.userId) !== String(user.id) || order.status !== 'pending_payment') {
      await clearState(user.id);
      return true;
    }
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    await order.update({ proofFileId: fileId, status: 'proof_pending' });
    await clearState(user.id);
    const product = await Merchant.findByPk(order.merchantId);
    const rate = await getIqdRate();
    const icon = customPaymentEmoji(paymentMethod);
    for (const adminId of config.admins) {
      try {
        const sent = await bot.sendPhoto(adminId, fileId, {
          caption: [
            `${icon ? premiumEmojiHtml(icon) : '💳'} <b>إيصال ${escapeHtml(paymentMethod.nameAr)}</b>`,
            `الطلب: <code>#${order.id}</code>`,
            `الزبون: ${escapeHtml(user.firstName || '')} — <code>${user.id}</code>`,
            `المنتج: ${escapeHtml(product?.nameAr || '')}`,
            `الكمية: ${order.quantity}`,
            `المبلغ المطلوب: ${moneyUsd(order.externalAmount || order.totalAmount)} = ${moneyIqd(Number(order.externalAmount || order.totalAmount) * rate)}`,
            `رقم الدفع: <code>${escapeHtml(paymentMethod.paymentNumber)}</code>`
          ].join('\n'),
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[
            { text: '✅ موافقة وتسليم', callback_data: `cm:approve:${order.id}` },
            { text: '❌ رفض', callback_data: `cm:reject:${order.id}` }
          ]] }
        });
        if (!order.adminMessageId) await order.update({ adminMessageId: sent.message_id });
      } catch (error) {
        console.error('Custom payment admin:', error.message);
      }
    }
    await bot.sendMessage(user.id, t(user.lang, 'proofSent'));
    return true;
  }

  if (!isAdmin(user.id)) return false;

  if (state.action === 'admin_broadcast') {
    await clearState(user.id);
    await bot.sendMessage(user.id, '📣 جاري إرسال الإعلان للمشتركين...');
    const result = await broadcastLocalizedMessage(msg);
    await bot.sendMessage(user.id, [
      '✅ انتهى إرسال الإعلان.',
      `وصل إلى: ${result.sent}`,
      `تعذر الإرسال إلى: ${result.failed}`
    ].join('\n'));
    return true;
  }

  if (state.action === 'admin_network_add' && isAdmin(user.id) && network.isMaster()) {
    const text = String(msg.text || '').trim();
    const data = { ...(state.data || {}) };
    if (state.step === 'name') {
      if (!text || text.length > 120) {
        await bot.sendMessage(user.id, '❌ أرسل اسم واضح وقصير.');
        return true;
      }
      data.name = text;
      await setState(user.id, { action: 'admin_network_add', step: 'owner', data });
      await bot.sendMessage(user.id, '2/4 أرسل Telegram ID الرقمي لصاحب البوت.');
      return true;
    }
    if (state.step === 'owner') {
      if (!/^\d{5,20}$/.test(text)) {
        await bot.sendMessage(user.id, '❌ Telegram ID غير صحيح. أرسل أرقام فقط.');
        return true;
      }
      data.ownerTelegramId = text;
      await setState(user.id, { action: 'admin_network_add', step: 'bot_token', data });
      await bot.sendMessage(user.id, [
        '3/4 أرسل <b>BOT TOKEN</b> مالالبوت الجديد من BotFather.',
        '',
        '🔐 راح أحذف رسالتك مباشرة بعد قراءتها، وما أخزن التوكن بقاعدة البيانات.'
      ].join('\n'), { parse_mode: 'HTML' });
      return true;
    }
    if (state.step === 'bot_token') {
      if (!/^\d{6,15}:[A-Za-z0-9_-]{20,}$/.test(text)) {
        await bot.sendMessage(user.id, '❌ صيغة BOT TOKEN مو صحيحة. انسخ التوكن كامل من BotFather.');
        return true;
      }
      pendingPartnerBotTokens.set(Number(user.id), text);
      await bot.deleteMessage(user.id, msg.message_id).catch(() => {});
      await setState(user.id, { action: 'admin_network_add', step: 'currency', data });
      await bot.sendMessage(user.id, '4/4 اختَر عملة الحساب الرئيسية لهذا الشريك:', {
        reply_markup: { inline_keyboard: [[
          { text: '🇮🇶 دينار عراقي', callback_data: 'adm:network_currency:IQD' },
          { text: '🇪🇬 جنيه مصري', callback_data: 'adm:network_currency:EGP' }
        ], [{ text: '💵 دولار', callback_data: 'adm:network_currency:USD' }]] }
      });
      return true;
    }
  }

  if (state.action === 'admin_binance_setup' && isAdmin(user.id)) {
    const text = String(msg.text || '').trim();
    const data = { ...(state.data || {}) };
    if (state.step === 'apiKey') {
      if (text.length < 10) {
        await bot.sendMessage(user.id, '❌ API Key غير صحيح.');
        return true;
      }
      data.apiKey = text;
      await bot.deleteMessage(user.id, msg.message_id).catch(() => {});
      await setState(user.id, { action: 'admin_binance_setup', step: 'secret', data });
      await bot.sendMessage(user.id, '2/3 أرسل Binance Secret Key. الرسالة راح أحاول أحذفها مباشرة بعد القراءة.');
      return true;
    }
    if (state.step === 'secret') {
      if (text.length < 10) {
        await bot.sendMessage(user.id, '❌ Secret Key غير صحيح.');
        return true;
      }
      data.secret = text;
      await bot.deleteMessage(user.id, msg.message_id).catch(() => {});
      await setState(user.id, { action: 'admin_binance_setup', step: 'payId', data });
      await bot.sendMessage(user.id, '3/3 أرسل Binance ID الذي سيحوّل له الزبائن.');
      return true;
    }
    if (state.step === 'payId') {
      if (!text) return true;
      await setSecureSetting('binance_api_key', data.apiKey);
      await setSecureSetting('binance_api_secret', data.secret);
      await setSetting('binance_pay_id', text);
      await clearState(user.id);
      await bot.sendMessage(user.id, '✅ تم حفظ Binance الخاص بهذا البوت بشكل مشفر. إذا التحقق الرسمي متاح من موقع السيرفر راح يصير تلقائي.');
      return true;
    }
  }

  if (state.action === 'admin_delivery_lookup' && isAdmin(user.id)) {
    const rawLookup = String(msg.text || '').trim().toUpperCase();
    const isDeliveryId = /^DLV-[A-F0-9]{8,32}$/.test(rawLookup);
    const orderMatch = rawLookup.match(/^#?(\d+)$/);
    if (!isDeliveryId && !orderMatch) {
      await bot.sendMessage(user.id,
        '❌ المعرف غير صحيح. أرسل معرف التسليم مثل <code>DLV-12AB34CD...</code> أو رقم الطلب مثل <code>#123</code>.',
        { parse_mode: 'HTML' });
      return true;
    }

    let order = null;
    let product = null;
    let entries = [];

    if (isDeliveryId) {
      let row = await DeliveryRecord.findByPk(rawLookup);
      let remoteProduct = null;
      if (!row && network.enabledClient()) {
        try {
          const remote = await network.lookupRemoteDelivery(rawLookup);
          if (remote?.delivery) {
            row = remote.delivery;
            remoteProduct = remote.product || null;
          }
        } catch {}
      }
      if (!row) {
        await bot.sendMessage(user.id, '❌ ما لكيت تسليم بهذا المعرف.');
        return true;
      }
      if (row.orderId) order = await PurchaseOrder.findByPk(row.orderId);
      product = remoteProduct || (row.merchantId ? await Merchant.findByPk(row.merchantId) : null);
      const stored = Array.isArray(order?.delivery)
        ? order.delivery.find(item => String(item.deliveryId || item.id || '').toUpperCase() === rawLookup)
        : null;
      entries = [{ row, stored }];
    } else {
      const orderId = Number(orderMatch[1]);
      order = await PurchaseOrder.findByPk(orderId);
      if (!order) {
        await bot.sendMessage(user.id, `❌ ما لكيت طلب برقم <code>#${escapeHtml(String(orderId))}</code>.`, { parse_mode: 'HTML' });
        return true;
      }
      product = await Merchant.findByPk(order.merchantId);
      const rows = await DeliveryRecord.findAll({ where: { orderId: order.id }, order: [['id', 'ASC']] });
      const storedDeliveries = Array.isArray(order.delivery) ? order.delivery : [];
      if (rows.length) {
        entries = rows.map(row => ({
          row,
          stored: storedDeliveries.find(item => String(item.deliveryId || item.id || '') === String(row.id)) || null
        }));
      } else {
        entries = storedDeliveries.map(item => ({ row: item, stored: item }));
      }
      if (!entries.length) {
        await bot.sendMessage(user.id, '❌ الطلب موجود لكن ماكو بيانات تسليم محفوظة له بعد.');
        return true;
      }
    }

    await clearState(user.id);
    const lines = [
      '🔎 <b>تفاصيل المنتج المسلّم</b>',
      `الطلب: <code>#${escapeHtml(String(order?.id || entries[0]?.row?.orderId || ''))}</code>`,
      `المستخدم: <code>${escapeHtml(String(order?.userId || entries[0]?.row?.userId || ''))}</code>`,
      `المنتج: <b>${escapeHtml(product?.nameAr || '')}</b>`,
      `عدد القطع المسلّمة: <b>${entries.length}</b>`
    ];

    for (let i = 0; i < entries.length; i++) {
      const row = entries[i].row;
      const stored = entries[i].stored;
      const deliveryId = String(row?.id || row?.deliveryId || stored?.deliveryId || '');
      const owner = await resolveInventoryOwnerInfo(row, stored);
      const ownLabel = owner.isOwnStock ? ' — مخزون هذا البوت' : '';
      lines.push(
        '',
        `📦 <b>القطعة ${i + 1}</b>`,
        deliveryId ? `معرف التسليم: <code>${escapeHtml(deliveryId)}</code>` : '',
        `صاحب المخزون: <b>${escapeHtml(owner.ownerName)}</b>${ownLabel}`,
        `معرف متجر صاحب المخزون: <code>${escapeHtml(owner.ownerId)}</code>`,
        renderDelivery(row?.payload || stored?.payload || {}, 'ar')
      );
    }

    await bot.sendMessage(user.id, lines.filter(Boolean).join('\n'), { parse_mode: 'HTML' });
    return true;
  }

  if (state.action === 'admin_new_payment_method') {
    const data = state.data || {};
    const text = String(msg.text || '').trim();
    if (!text) return true;

    if (state.step === 'nameAr') {
      const rich = extractProductNameRichText(text, msg.entities);
      if (!rich.plain) {
        await bot.sendMessage(user.id, '❌ اكتب اسم طريقة الدفع أيضاً، مو فقط ID الإيموجي.');
        return true;
      }
      const cleanName = rich.firstCustomEmojiAlt ? rich.plain.replace(rich.firstCustomEmojiAlt, '').trim() : rich.plain;
      data.nameAr = cleanName || rich.plain;
      data.nameEn = await translateArToEn(data.nameAr);
      data.iconCustomEmojiId = rich.firstCustomEmojiId || '';
      data.iconAlt = rich.firstCustomEmojiAlt || '💳';
      await setState(user.id, { action: 'admin_new_payment_method', step: 'number', data });
      await bot.sendMessage(user.id, '2/4 أرسل رقم/معرّف الدفع الذي راح يظهر للزبون.\nمثال: 0770xxxxxxx أو Wallet-ID-123', { reply_markup: cancelInlineKeyboard() });
      return true;
    }

    if (state.step === 'number') {
      if (text.length < 2 || text.length > 255) {
        await bot.sendMessage(user.id, '❌ رقم/معرّف الدفع غير صحيح.');
        return true;
      }
      data.paymentNumber = text;
      await setState(user.id, { action: 'admin_new_payment_method', step: 'currency', data });
      const currencyButtons = [
        { text: '🇪🇬 جنيه مصري (EGP)', callback_data: 'adm:pmcurrency:EGP' },
        { text: '🇮🇶 دينار عراقي (IQD)', callback_data: 'adm:pmcurrency:IQD' },
        { text: '💵 دولار (USD)', callback_data: 'adm:pmcurrency:USD' }
      ];
      await bot.sendMessage(user.id, '3/4 اختَر عملة الاستلام لهذه الطريقة. الزبون راح يكتب مبلغ الشحن بهذه العملة نفسها:', {
        reply_markup: { inline_keyboard: currencyButtons.map(button => [button]) }
      });
      return true;
    }

    if (state.step === 'rate') {
      const rate = Number(text);
      if (!Number.isFinite(rate) || rate <= 0) {
        await bot.sendMessage(user.id, '❌ سعر الصرف غير صحيح. مثال للعراقي: 1500، وللمصري: 50.');
        return true;
      }
      data.ratePerUsd = rate;
      const method = await createConfiguredPaymentMethod(data);
      await clearState(user.id);
      const icon = customPaymentEmoji(method);
      await bot.sendMessage(user.id, [
        '✅ <b>تمت إضافة طريقة الدفع</b>',
        `${icon ? premiumEmojiHtml(icon) : '💳'} الاسم: <b>${escapeHtml(method.nameAr)}</b>`,
        `الرقم: <code>${escapeHtml(method.paymentNumber)}</code>`,
        `العملة: <b>${method.settlementCurrency}</b>`,
        `سعر 1$: <b>${Number(method.ratePerUsd)}</b> ${method.settlementCurrency}`,
        '',
        'ظهرت تلقائياً في شراء المنتجات وشحن المحفظة.'
      ].join('\n'), { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '💳 إدارة طرق الدفع', callback_data: 'adm:payment_methods' }]] } });
      return true;
    }
  }

  if (state.action === 'admin_edit_payment_method') {
    const method = await PaymentMethod.findByPk(state.paymentMethodId);
    if (!method) {
      await clearState(user.id);
      return true;
    }
    const text = String(msg.text || '').trim();
    if (!text) return true;

    if (state.field === 'name') {
      const rich = extractProductNameRichText(text, msg.entities);
      if (!rich.plain) {
        await bot.sendMessage(user.id, '❌ اكتب اسم طريقة الدفع أيضاً.');
        return true;
      }
      const cleanName = rich.firstCustomEmojiAlt ? rich.plain.replace(rich.firstCustomEmojiAlt, '').trim() : rich.plain;
      method.nameAr = cleanName || rich.plain;
      method.nameEn = await translateArToEn(method.nameAr);
      method.iconCustomEmojiId = rich.firstCustomEmojiId || null;
      method.iconAlt = rich.firstCustomEmojiAlt || '💳';
    } else if (state.field === 'number') {
      if (text.length < 2 || text.length > 255) {
        await bot.sendMessage(user.id, '❌ رقم/معرّف الدفع غير صحيح.');
        return true;
      }
      method.paymentNumber = text;
    }
    await method.save();
    await clearState(user.id);
    await bot.sendMessage(user.id, '✅ تم تحديث طريقة الدفع.', {
      reply_markup: { inline_keyboard: [[{ text: 'رجوع لطريقة الدفع', callback_data: `adm:pm:${method.id}` }]] }
    });
    return true;
  }

  if (state.action === 'admin_new_product') {
    const data = state.data || {};
    const text = String(msg.text || '').trim();
    const photoFileId = msg.photo?.length ? msg.photo[msg.photo.length - 1].file_id : '';

    if (state.step === 'type') {
      await bot.sendMessage(user.id, 'اختَر نوع المنتج من الأزرار أدناه.', { reply_markup: cancelInlineKeyboard() });
      return true;
    }

    if (state.step === 'nameAr') {
      if (!text) return true;
      const rich = extractProductNameRichText(text, msg.entities);
      if (!rich.plain) {
        await bot.sendMessage(user.id, '❌ اكتب اسم المنتج أيضاً، مو فقط ID الإيموجي.');
        return true;
      }
      data.nameAr = rich.plain;
      data.nameArHtml = rich.html;
      data.nameEmojiId = rich.firstCustomEmojiId;
      data.nameEmojiAlt = rich.firstCustomEmojiAlt;
      const translatableName = rich.firstCustomEmojiAlt ? rich.plain.replace(rich.firstCustomEmojiAlt, '').trim() : rich.plain;
      data.nameEn = await translateArToEn(translatableName || rich.plain);
      await setState(user.id, { action: 'admin_new_product', step: 'price', data });
      await bot.sendMessage(user.id, '2/5 أرسل السعر بالدولار، مثال: 5 أو 1.50', { reply_markup: cancelInlineKeyboard() });
      return true;
    }

    if (state.step === 'price') {
      const price = Number(text);
      if (!Number.isFinite(price) || price < 0) {
        await bot.sendMessage(user.id, '❌ السعر غير صحيح. مثال: 5 أو 1.50');
        return true;
      }
      data.price = price;
      await setState(user.id, { action: 'admin_new_product', step: 'descriptionAr', data });
      await bot.sendMessage(user.id, '3/5 أرسل وصف المنتج بالعربي، أو - إذا ما تريد وصف.', { reply_markup: cancelInlineKeyboard() });
      return true;
    }

    if (state.step === 'descriptionAr') {
      if (text === '-') {
        data.descriptionAr = '';
        data.descriptionArHtml = '';
        data.descriptionEn = '';
      } else {
        const rich = extractTelegramRichText(text, msg.entities);
        data.descriptionAr = rich.plain;
        data.descriptionArHtml = rich.html;
        data.descriptionEn = await translateArToEn(rich.plain);
      }
      await setState(user.id, { action: 'admin_new_product', step: 'warrantyAr', data });
      await bot.sendMessage(user.id, '4/5 أرسل الضمان بالعربي، مثال: شهر كامل، أو - بدون ضمان.', { reply_markup: cancelInlineKeyboard() });
      return true;
    }

    if (state.step === 'warrantyAr') {
      if (text === '-') {
        data.warrantyAr = '';
        data.warrantyArHtml = '';
        data.warrantyEn = '';
      } else {
        const rich = extractTelegramRichText(text, msg.entities);
        data.warrantyAr = rich.plain;
        data.warrantyArHtml = rich.html;
        data.warrantyEn = await translateArToEn(rich.plain);
      }
      await setState(user.id, { action: 'admin_new_product', step: 'image', data });
      await bot.sendMessage(user.id, '5/5 أرسل صورة المنتج، رابط صورة، أو - بدون صورة.', { reply_markup: cancelInlineKeyboard() });
      return true;
    }

    if (state.step === 'image') {
      const imageValue = photoFileId || text;
      if (!imageValue) {
        await bot.sendMessage(user.id, 'أرسل صورة أو رابط أو - بدون صورة.');
        return true;
      }

      const productPayload = {
        nameAr: data.nameAr,
        nameEn: data.nameEn || data.nameAr,
        price: data.price,
        category: 'عام',
        type: data.type || 'free',
        description: {
          ar: data.descriptionAr || '',
          en: data.descriptionEn || '',
          warrantyAr: data.warrantyAr || '',
          warrantyEn: data.warrantyEn || '',
          sold: 0,
          nameArHtml: data.nameArHtml || '',
          nameEmojiId: data.nameEmojiId || '',
          nameEmojiAlt: data.nameEmojiAlt || '',
          descriptionArHtml: data.descriptionArHtml || '',
          warrantyArHtml: data.warrantyArHtml || ''
        },
        // Telegram file_ids are scoped to a bot. URLs can be shared across the network safely.
        image: imageValue === '-' ? null : (/^https?:\/\//i.test(imageValue) ? imageValue : null),
        isActive: true,
        sharedLimit: 1,
        deliveryMode: 'instant'
      };

      let product;
      if (network.enabledClient()) {
        const remote = await network.createRemoteProduct(productPayload);
        const rp = remote.product;
        product = await Merchant.create({
          ...productPayload,
          image: productPayload.image || (imageValue === '-' ? null : imageValue),
          networkProductId: rp.networkProductId,
          networkManaged: true,
          networkOwnerShopId: rp.networkOwnerShopId || config.network.shopId,
          networkStock: Number(rp.stock || 0),
          ownerNote: 'Network product'
        });
      } else {
        product = await Merchant.create({
          ...productPayload,
          image: imageValue === '-' ? null : imageValue,
          networkProductId: crypto.randomUUID(),
          networkManaged: false,
          networkOwnerShopId: network.isMaster() ? 'master' : config.network.shopId,
          networkStock: 0,
          ownerNote: null
        });
      }

      if (network.isMaster()) {
        await network.publishNotificationEvent({
          eventType: 'new_product',
          networkProductId: product.networkProductId,
          actorShopId: 'master',
          actorName: config.network.ownerName || config.network.shopName || 'المالك الرئيسي',
          payload: { nameAr: product.nameAr, nameEn: product.nameEn, price: Number(product.price) }
        }).catch(error => console.error('Publish product notification:', error.message));
      }

      await setState(user.id, { action: 'admin_add_stock', productId: product.id, afterCreate: true });
      await bot.sendMessage(user.id, '✅ تم إنشاء المنتج ونشره. حالياً مخزونه صفر لذلك يظهر بالأحمر.\n\n' + stockPrompt(product), {
        parse_mode: 'HTML',
        reply_markup: cancelInlineKeyboard()
      });
      return true;
    }
  }

  if (state.action === 'admin_edit_product') {
    const product = await Merchant.findByPk(state.productId);
    if (!product) {
      await clearState(user.id);
      return true;
    }
    const field = state.field;
    let value = msg.text?.trim();
    if (field === 'image' && msg.photo?.length) value = msg.photo[msg.photo.length - 1].file_id;
    if (!value) return true;

    const description = parseDescription(product.description);
    if (field === 'nameAr') {
      const rich = extractProductNameRichText(value, msg.entities);
      if (!rich.plain) {
        await bot.sendMessage(user.id, '❌ اكتب اسم المنتج أيضاً، مو فقط ID الإيموجي.');
        return true;
      }
      product.nameAr = rich.plain;
      const translatableName = rich.firstCustomEmojiAlt ? rich.plain.replace(rich.firstCustomEmojiAlt, '').trim() : rich.plain;
      product.nameEn = await translateArToEn(translatableName || rich.plain);
      description.nameArHtml = rich.html;
      description.nameEmojiId = rich.firstCustomEmojiId;
      description.nameEmojiAlt = rich.firstCustomEmojiAlt;
    } else if (field === 'price') {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0) {
        await bot.sendMessage(user.id, '❌ سعر غير صحيح.');
        return true;
      }
      if (!network.enabledClient()) {
        const protection = await network.productStockProtection(product.id, product.networkOwnerShopId || 'master');
        if (number + 1e-9 < protection.maxContributionPriceUsd) {
          await bot.sendMessage(user.id, `❌ ما تگدر تنزل السعر إلى ${moneyUsd(number)} لأن أكو مخزون مساهمين حق الوحدة المسجل بيه يوصل إلى ${moneyUsd(protection.maxContributionPriceUsd)}. لازم ينفد/ينسحب هذا المخزون أولاً.`);
          return true;
        }
      }
      product.price = number;
    } else if (field === 'descriptionAr') {
      if (value === '-') {
        description.ar = '';
        description.en = '';
        description.descriptionArHtml = '';
      } else {
        const rich = extractTelegramRichText(value, msg.entities);
        description.ar = rich.plain;
        description.en = await translateArToEn(rich.plain);
        description.descriptionArHtml = rich.html;
      }
    } else if (field === 'warrantyAr') {
      if (value === '-') {
        description.warrantyAr = '';
        description.warrantyEn = '';
        description.warrantyArHtml = '';
      } else {
        const rich = extractTelegramRichText(value, msg.entities);
        description.warrantyAr = rich.plain;
        description.warrantyEn = await translateArToEn(rich.plain);
        description.warrantyArHtml = rich.html;
      }
    } else if (field === 'image') {
      product.image = value === '-' ? null : value;
    }

    product.set('description', { ...description });
    product.changed('description', true);
    if (!canManageNetworkProduct(product)) {
      await clearState(user.id);
      await bot.sendMessage(user.id, '⛔ هذا المنتج مضاف من متجر آخر بالشبكة، وتقدر تبيعه لكن ما تقدر تعدله.');
      return true;
    }
    if (product.networkManaged && network.enabledClient()) {
      try {
        await network.updateRemoteProduct(product.networkProductId, {
          nameAr: product.nameAr,
          nameEn: product.nameEn,
          price: Number(product.price),
          category: product.category,
          type: product.type,
          description: product.description,
          image: /^https?:\/\//i.test(String(product.image || '')) ? product.image : null,
          isActive: product.isActive,
          sharedLimit: product.sharedLimit,
          deliveryMode: product.deliveryMode,
          sortOrder: product.sortOrder
        });
      } catch (error) {
        await network.syncCatalogToLocal().catch(() => {});
        await clearState(user.id);
        const message = String(error.message || '');
        const friendly = message.startsWith('PRICE_BELOW_STOCK_VALUE:')
          ? `❌ السعر الجديد أقل من حق مخزون مساهم موجود. أقل سعر مسموح حالياً هو $${Number(message.split(':')[1] || 0).toFixed(2)}.`
          : message.startsWith('EXTERNAL_STOCK_EXISTS:')
            ? `❌ ما تگدر توقف المنتج لأن بيه ${Number(message.split(':')[1] || 0)} وحدات مخزون لأشخاص آخرين.`
            : `❌ تعذر حفظ التعديل بالشبكة: ${escapeHtml(message)}`;
        await bot.sendMessage(user.id, friendly, { parse_mode: 'HTML' });
        return true;
      }
    }
    await product.save();
    await clearState(user.id);
    await bot.sendMessage(user.id, '✅ تم الحفظ والترجمة الإنجليزية تحدثت تلقائياً.');
    await showAdminProductEditor(user.id, product.id);
    return true;
  }

  if (state.action === 'admin_add_stock') {
    let text = msg.text || '';
    if (msg.document) {
      const link = await bot.getFileLink(msg.document.file_id);
      const response = await axios.get(link, { responseType: 'text', timeout: 20000 });
      text = String(response.data || '');
    }

    const product = await Merchant.findByPk(state.productId);
    if (!product) {
      await clearState(user.id);
      return true;
    }

    const parsed = parseInventoryTextForProduct(text, product.type);
    if (parsed.errors.length) {
      const details = parsed.errors.slice(0, 8).map(row =>
        `السطر ${row.line}: ${escapeHtml(row.error)}\n<code>${escapeHtml(row.value)}</code>`
      ).join('\n\n');
      await bot.sendMessage(user.id, [
        '❌ <b>ما تم حفظ أي حساب</b>',
        'صحح الأسطر التالية وأرسل المخزون من جديد:',
        '',
        details,
        parsed.errors.length > 8 ? `\nويوجد ${parsed.errors.length - 8} أخطاء إضافية.` : ''
      ].join('\n'), { parse_mode: 'HTML', reply_markup: cancelInlineKeyboard() });
      return true;
    }

    if (!parsed.items.length) {
      await bot.sendMessage(user.id, '❌ ما حصلت بيانات صحيحة.');
      return true;
    }

    if (product.networkManaged && network.enabledClient()) {
      try {
        const remote = await network.addRemoteInventory(product.networkProductId, parsed.items, { suppressNotification: Boolean(state.afterCreate) });
        product.networkStock = Number(remote.stock || 0);
        await product.save({ fields: ['networkStock'] });
        await clearState(user.id);
        await bot.sendMessage(user.id, `✅ تمت إضافة ${remote.added} للمخزون المشترك.\nالمخزون العالمي الآن: ${remote.stock}`);
        if (Number(remote.added || 0) > 0 && product.isActive) {
          await bot.sendMessage(user.id, state.afterCreate
            ? '📢 تم نشر المنتج على شبكة البوتات، وكل بوت يطبق إعداد الإشعارات الخاص به.'
            : '📢 تم تحديث المخزون المشترك، وسيصل إشعاره لكل بوت مفعّل الإشعارات.').catch(() => {});
        }
        return true;
      } catch (error) {
        await bot.sendMessage(user.id, `❌ تعذر تحديث المخزون المشترك: ${escapeHtml(error.message)}`, { parse_mode: 'HTML' });
        return true;
      }
    }

    const maxUses = product.type === 'shared' ? Number(product.sharedLimit || 5) : 1;
    const transaction = await sequelize.transaction();
    try {
      const batchFingerprints = new Set();
      let added = 0;
      let duplicates = 0;

      for (const item of parsed.items) {
        const fingerprint = inventoryFingerprint(product.type, item);
        if (batchFingerprints.has(fingerprint)) {
          duplicates += 1;
          continue;
        }
        batchFingerprints.add(fingerprint);

        const existing = await Code.findOne({
          where: {
            merchantId: product.id,
            fingerprint
          },
          transaction,
          lock: transaction.LOCK.UPDATE
        });

        if (existing) {
          duplicates += 1;
          continue;
        }

        await Code.create({
          value: encryptPayload(item),
          extra: null,
          merchantId: product.id,
          maxUses,
          usedCount: 0,
          isUsed: false,
          buyers: [],
          fingerprint,
          stockOwnerShopId: network.enabledClient() ? config.network.shopId : 'master',
          contributionPriceUsd: Number(product.price || 0)
        }, { transaction });
        added += 1;
      }

      await transaction.commit();

      if (added > 0) await clearState(user.id);
      const privateDetails = product.type === 'shared'
        ? `\n🔒 عدد الاستخدامات لكل حساب: ${maxUses} — يظهر للإدارة فقط.`
        : '';
      await bot.sendMessage(user.id, [
        `✅ تمت إضافة: ${added}`,
        `♻️ المكرر الذي تم تجاهله: ${duplicates}`,
        privateDetails
      ].filter(Boolean).join('\n'));

      if (added > 0 && product.isActive && network.isMaster() && !state.afterCreate) {
        await network.publishNotificationEvent({
          eventType: 'stock_added',
          networkProductId: product.networkProductId,
          actorShopId: 'master',
          actorName: config.network.ownerName || config.network.shopName || 'المالك الرئيسي',
          amount: added,
          payload: { nameAr: product.nameAr, nameEn: product.nameEn, price: Number(product.price) }
        }).catch(error => console.error('Publish stock notification:', error.message));
      }

      if (added > 0 && product.isActive && !network.isMaster()) {
        try {
          const notification = state.afterCreate
            ? await broadcastNewProductNotification(product)
            : await broadcastStockNotification(product, added);
          if (notification.disabled) {
            await bot.sendMessage(user.id, '🔕 الإشعارات التلقائية متوقفة، لذلك ما تم إرسال إشعار للمستخدمين.');
          } else {
            await bot.sendMessage(user.id, [
              state.afterCreate ? '📢 تم إرسال إشعار المنتج الجديد للمشتركين.' : '📢 تم إرسال إشعار المخزون للمشتركين.',
              `وصل إلى: ${notification.sent}`,
              `تعذر الإرسال إلى: ${notification.failed}`
            ].join('\n'));
          }
        } catch (notificationError) {
          console.error('Automatic notification broadcast:', notificationError);
          await bot.sendMessage(user.id, '⚠️ انضاف المخزون بنجاح، لكن تعذر إرسال الإشعار التلقائي حالياً.').catch(() => {});
        }
      }

      if (added === 0) {
        await bot.sendMessage(user.id, 'كل البيانات المرسلة موجودة سابقاً. أرسل بيانات جديدة أو اكتب إغلاق.');
      } else {
        await showAdminProductEditor(user.id, product.id);
      }
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
    return true;
  }

  if (state.action === 'admin_setting') {
    let value = msg.text?.trim();
    if (!value) return true;

    if (state.key === 'superqi_number' && value === '-') {
      value = '';
    }

    if (state.key === 'iqd_rate') {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 1) {
        await bot.sendMessage(user.id, '❌ رقم غير صحيح.');
        return true;
      }
      value = String(number);
    }

    if (state.key === 'egp_rate_per_usd') {
      const number = Number(value);
      if (!Number.isFinite(number) || number <= 0) {
        await bot.sendMessage(user.id, '❌ رقم غير صحيح. مثال: 50');
        return true;
      }
      value = String(number);
    }

    if (state.key === 'referral_reward_amount') {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0 || number > 1000) {
        await bot.sendMessage(user.id, '❌ أرسل مبلغاً صحيحاً، مثال 0.05');
        return true;
      }
      value = String(number);
    }

    if (state.key === 'referral_gift_target') {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 1 || number > 10000) {
        await bot.sendMessage(user.id, '❌ العدد لازم يكون رقماً صحيحاً من 1 إلى 10000.');
        return true;
      }
      value = String(number);
    }

    if (state.key === 'required_channel') {
      const normalizedChannel = normalizeRequiredChannelInput(value);
      if (normalizedChannel === null) {
        await bot.sendMessage(user.id, '❌ أرسل @معرف_القناة أو رابطاً عاماً مثل https://t.me/mychannel، أو - للإيقاف.');
        return true;
      }
      value = normalizedChannel;
    }

    await setSetting(state.key, value);
    await clearState(user.id);
    await bot.sendMessage(user.id, '✅ تم تحديث الإعداد.');
    return true;
  }

  if (state.action === 'admin_user_lookup') {
    const targetId = Number(String(msg.text || '').trim());
    if (!Number.isFinite(targetId)) {
      await bot.sendMessage(user.id, '❌ أرسل آيدي رقمي صحيح.');
      return true;
    }
    await clearState(user.id);
    await showAdminUserCard(user.id, targetId);
    return true;
  }

  if (state.action === 'admin_user_credit_id') {
    const targetId = Number(String(msg.text || '').trim());
    if (!Number.isFinite(targetId)) {
      await bot.sendMessage(user.id, '❌ أرسل آيدي رقمي صحيح.');
      return true;
    }
    const target = await User.findByPk(targetId);
    if (!target) {
      await bot.sendMessage(user.id, '❌ المستخدم ما مستخدم البوت بعد.');
      return true;
    }
    await setState(user.id, { action: 'admin_user_credit_amount', targetId });
    await bot.sendMessage(user.id, `أرسل مبلغ الشحن بالدولار للمستخدم <code>${targetId}</code>:`, { parse_mode: 'HTML' });
    return true;
  }

  if (state.action === 'admin_user_credit_amount') {
    const amount = Number(String(msg.text || '').trim());
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
      await bot.sendMessage(user.id, '❌ مبلغ غير صحيح.');
      return true;
    }
    const result = await adminCreditUser(state.targetId, amount, user.id);
    await clearState(user.id);
    await bot.sendMessage(user.id, `✅ تم شحن ${moneyUsd(amount)} للمستخدم <code>${state.targetId}</code>.\nالرصيد الجديد: <b>${moneyUsd(result.balance)}</b>`, { parse_mode: 'HTML' });
    await bot.sendMessage(state.targetId, `✅ تم شحن محفظتك من الإدارة بمبلغ <b>${moneyUsd(amount)}</b>.\nرصيدك الجديد: <b>${moneyUsd(result.balance)}</b>`, { parse_mode: 'HTML' }).catch(() => {});
    return true;
  }

  return false;
}

async function adminCreditUser(targetId, amount, adminId) {
  const transaction = await sequelize.transaction();
  try {
    const target = await User.findByPk(targetId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!target) throw new Error('USER_NOT_FOUND');
    target.balance = Number(target.balance || 0) + Number(amount);
    await target.save({ transaction });
    await BalanceTransaction.create({
      userId: target.id,
      amount,
      type: 'admin_credit',
      txid: `ADMIN-${adminId}-${Date.now()}`,
      caption: `Manual credit by admin ${adminId}`,
      status: 'completed',
      lastReminderAt: new Date()
    }, { transaction });
    await transaction.commit();
    return { balance: Number(target.balance) };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function handleBinanceManualAdmin(query, data) {
  if (!isAdmin(query.from.id)) return answerCallback(query.id, 'Admins only', true);
  const [, action, transferIdRaw] = data.split(':');
  const transferId = Number(transferIdRaw);
  if (!Number.isInteger(transferId) || transferId < 1) return answerCallback(query.id, 'رقم العملية غير صحيح.', true);

  if (action === 'reject') {
    const result = await binancePay.rejectManualReview(transferId, query.from.id);
    if (!result.success) return answerCallback(query.id, binanceFailureText(result, 'ar'), true);
    await answerCallback(query.id, 'تم رفض الرقم وإرجاع العملية للمحاولة من جديد.');
    if (query.message) {
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id
      }).catch(() => {});
    }
    await setState(result.transfer.userId, { action: 'binance_verify', transferId: result.transfer.id });
    await bot.sendMessage(result.transfer.userId, [
      '❌ لم تتم الموافقة على معرف طلب Binance المرسل.',
      'تأكد من Order ID داخل تفاصيل التحويل وأرسله هنا مباشرة:'
    ].join('\n')).catch(() => {});
    return;
  }

  const result = await binancePay.approveManualReview(transferId, query.from.id);
  if (!result.success) {
    if (result.paymentConfirmed) {
      await answerCallback(query.id, 'الدفع تأكد، لكن التسليم متوقف حالياً.', true);
      const transfer = await BinanceTransfer.findByPk(transferId);
      if (transfer) {
        await bot.sendMessage(transfer.userId, '✅ تم تأكيد دفع Binance يدوياً، لكن التسليم ينتظر توفر المخزون. لا تدفع مرة ثانية.').catch(() => {});
      }
      return;
    }
    return answerCallback(query.id, binanceFailureText(result, 'ar'), true);
  }

  await answerCallback(query.id, result.alreadyProcessed ? 'تمت معالجة العملية سابقاً.' : 'تمت الموافقة والتحقق.');
  if (query.message) {
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id
    }).catch(() => {});
  }
  if (!result.alreadyProcessed) await notifyBinanceResult(result);
}

async function handleSuperQiTopupAdmin(query, data) {
  if (!isAdmin(query.from.id)) return answerCallback(query.id, 'Admins only', true);
  const [, action, transactionIdRaw] = data.split(':');
  const transactionId = Number(transactionIdRaw);
  const dbTransaction = await sequelize.transaction();
  try {
    const ledger = await BalanceTransaction.findByPk(transactionId, { transaction: dbTransaction, lock: dbTransaction.LOCK.UPDATE });
    if (!ledger || ledger.status !== 'proof_pending') {
      await dbTransaction.rollback();
      return answerCallback(query.id, 'تمت معالجة العملية سابقاً.', true);
    }
    if (action === 'reject') {
      ledger.status = 'rejected';
      await ledger.save({ transaction: dbTransaction });
      await dbTransaction.commit();
      await answerCallback(query.id, 'تم الرفض.');
      await bot.sendMessage(ledger.userId, `❌ تم رفض إيصال شحن SuperQi #${ledger.id}.`);
      return;
    }
    const targetUser = await User.findByPk(ledger.userId, { transaction: dbTransaction, lock: dbTransaction.LOCK.UPDATE });
    targetUser.balance = Number(targetUser.balance || 0) + Number(ledger.amount);
    await targetUser.save({ transaction: dbTransaction });
    ledger.status = 'completed';
    await ledger.save({ transaction: dbTransaction });
    await dbTransaction.commit();
    await answerCallback(query.id, 'تم الشحن.');
    const moneyContext = await shopMoneyContext();
    await bot.sendMessage(targetUser.id, `✅ ${premiumEmojiHtml(PREMIUM_EMOJI.superqi)} تم شحن محفظتك عبر سوبركي.\nالمبلغ: <b>${customerMoney(ledger.amount, moneyContext, targetUser.lang || 'ar')}</b>\nالرصيد الجديد: <b>${customerMoney(targetUser.balance, moneyContext, targetUser.lang || 'ar')}</b>`, { parse_mode: 'HTML' });
  } catch (error) {
    await dbTransaction.rollback();
    throw error;
  }
}

async function handleSuperQiAdmin(query, data) {
  if (!isAdmin(query.from.id)) return answerCallback(query.id, 'Admins only', true);
  const [, action, orderIdRaw] = data.split(':');
  const order = await PurchaseOrder.findByPk(Number(orderIdRaw));
  if (!order || order.status !== 'proof_pending') return answerCallback(query.id, 'تمت معالجة الطلب سابقاً.', true);
  if (action === 'reject') {
    await refundWalletReservation(order.id).catch(() => order.update({ status: 'rejected' }));
    await answerCallback(query.id, 'تم الرفض وإرجاع أي مبلغ محجوز من المحفظة.');
    await bot.sendMessage(order.userId, `❌ تم رفض إيصال الطلب #${order.id}. تم إرجاع أي مبلغ كان محجوزاً من محفظتك.`);
    return;
  }
  try {
    const fulfillment = await fulfillOrder(order.id, { paymentRef: `superqi:${order.id}` });
    await answerCallback(query.id, 'تمت الموافقة والتسليم.');
    await sendDeliveryToUser(order.userId, fulfillment);
  } catch (error) {
    await answerCallback(query.id, error.message === 'OUT_OF_STOCK' ? 'المخزون غير كافي.' : error.message, true);
  }
}

async function handleCustomTopupAdmin(query, data) {
  if (!isAdmin(query.from.id)) return answerCallback(query.id, 'Admins only', true);
  const [, action, transactionIdRaw] = data.split(':');
  const transactionId = Number(transactionIdRaw);
  const dbTransaction = await sequelize.transaction();
  try {
    const ledger = await BalanceTransaction.findByPk(transactionId, { transaction: dbTransaction, lock: dbTransaction.LOCK.UPDATE });
    if (!ledger || ledger.status !== 'proof_pending' || !ledger.paymentMethodId) {
      await dbTransaction.rollback();
      return answerCallback(query.id, 'تمت معالجة العملية سابقاً.', true);
    }
    const method = await PaymentMethod.findByPk(ledger.paymentMethodId, { transaction: dbTransaction });
    if (!method) {
      await dbTransaction.rollback();
      return answerCallback(query.id, 'طريقة الدفع غير موجودة.', true);
    }
    if (action === 'reject') {
      ledger.status = 'rejected';
      await ledger.save({ transaction: dbTransaction });
      await dbTransaction.commit();
      await answerCallback(query.id, 'تم الرفض.');
      await bot.sendMessage(ledger.userId, `❌ تم رفض إيصال شحن ${escapeHtml(method.nameAr)} #${ledger.id}.`, { parse_mode: 'HTML' });
      if (query.message) await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: query.message.chat.id, message_id: query.message.message_id }).catch(() => {});
      return;
    }
    const targetUser = await User.findByPk(ledger.userId, { transaction: dbTransaction, lock: dbTransaction.LOCK.UPDATE });
    targetUser.balance = Number(targetUser.balance || 0) + Number(ledger.amount);
    await targetUser.save({ transaction: dbTransaction });
    ledger.status = 'completed';
    await ledger.save({ transaction: dbTransaction });
    await dbTransaction.commit();
    await answerCallback(query.id, 'تم الشحن.');
    if (query.message) await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: query.message.chat.id, message_id: query.message.message_id }).catch(() => {});
    const targetLang = targetUser.lang === 'en' ? 'en' : 'ar';
    const methodName = localizedPaymentName(method, targetLang);
    const icon = customPaymentEmoji(method);
    const moneyContext = await shopMoneyContext();
    await bot.sendMessage(targetUser.id, [
      `✅ ${icon ? premiumEmojiHtml(icon) : '💳'} <b>${targetLang === 'en' ? `Wallet topped up via ${escapeHtml(methodName)}` : `تم شحن محفظتك عبر ${escapeHtml(methodName)}`}</b>`,
      `${targetLang === 'en' ? 'Amount' : 'المبلغ'}: <b>${customerMoney(ledger.amount, moneyContext, targetLang)}</b>`,
      `${targetLang === 'en' ? 'New balance' : 'الرصيد الجديد'}: <b>${customerMoney(targetUser.balance, moneyContext, targetLang)}</b>`
    ].join('\n'), { parse_mode: 'HTML' });
  } catch (error) {
    await dbTransaction.rollback();
    throw error;
  }
}

async function handleCustomPaymentAdmin(query, data) {
  if (!isAdmin(query.from.id)) return answerCallback(query.id, 'Admins only', true);
  const [, action, orderIdRaw] = data.split(':');
  const order = await PurchaseOrder.findByPk(Number(orderIdRaw));
  if (!order || order.status !== 'proof_pending' || !String(order.paymentMethod || '').startsWith('custom:')) {
    return answerCallback(query.id, 'تمت معالجة الطلب سابقاً.', true);
  }
  const methodId = Number(String(order.paymentMethod).split(':')[1]);
  const method = await PaymentMethod.findByPk(methodId);
  if (!method) return answerCallback(query.id, 'طريقة الدفع غير موجودة.', true);
  if (action === 'reject') {
    await refundWalletReservation(order.id).catch(() => order.update({ status: 'rejected' }));
    await answerCallback(query.id, 'تم الرفض وإرجاع أي مبلغ محجوز من المحفظة.');
    if (query.message) await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: query.message.chat.id, message_id: query.message.message_id }).catch(() => {});
    const targetUser = await User.findByPk(order.userId);
    const lang = targetUser?.lang === 'en' ? 'en' : 'ar';
    await bot.sendMessage(order.userId, lang === 'en'
      ? `❌ Payment receipt for order #${order.id} was rejected. Contact support if needed.`
      : `❌ تم رفض إيصال الطلب #${order.id}. راجع الدعم إذا تحتاج.`);
    return;
  }
  try {
    const fulfillment = await fulfillOrder(order.id, { paymentRef: `custom:${method.id}:${order.id}` });
    await answerCallback(query.id, 'تمت الموافقة والتسليم.');
    if (query.message) await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: query.message.chat.id, message_id: query.message.message_id }).catch(() => {});
    await sendDeliveryToUser(order.userId, fulfillment);
  } catch (error) {
    await answerCallback(query.id, error.message === 'OUT_OF_STOCK' ? 'المخزون غير كافي.' : error.message, true);
  }
}


async function handleNetworkOrderAdmin(query, data) {
  if (!isAdmin(query.from.id)) return answerCallback(query.id, 'Admins only', true);
  const [, action, orderIdRaw] = data.split(':');
  const order = await PurchaseOrder.findByPk(Number(orderIdRaw));
  if (!order || order.status !== 'proof_pending' || !String(order.paymentMethod || '').startsWith('network:')) {
    return answerCallback(query.id, 'تمت معالجة الطلب سابقاً.', true);
  }
  if (action === 'reject') {
    await refundWalletReservation(order.id).catch(() => order.update({ status: 'rejected' }));
    await answerCallback(query.id, 'تم الرفض وإرجاع المبلغ المحجوز.');
    if (query.message) await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: query.message.chat.id, message_id: query.message.message_id }).catch(() => {});
    await bot.sendMessage(order.userId, `❌ تم رفض إيصال الطلب #${order.id}. تم إرجاع أي مبلغ كان محجوزاً من محفظتك.`).catch(() => {});
    return;
  }
  try {
    const fulfillment = await completeExternalPayment(order.id, `${order.paymentMethod}:${order.id}`);
    const target = await User.findByPk(order.userId);
    await network.recordFallbackSettlement({
      amountUsd: Number(order.externalAmount || order.totalAmount),
      method: String(order.paymentMethod).slice('network:'.length),
      sourceRef: `order:${order.id}`,
      customerName: target?.firstName || target?.username || String(order.userId),
      activity: 'purchase'
    }).catch(error => console.error('Settlement notify failed:', error.message));
    await answerCallback(query.id, 'تمت الموافقة والتسليم وتسجيل الحساب مع مالك الشبكة.');
    if (query.message) await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: query.message.chat.id, message_id: query.message.message_id }).catch(() => {});
    await sendDeliveryToUser(order.userId, fulfillment);
  } catch (error) {
    await answerCallback(query.id, error.message === 'OUT_OF_STOCK' ? 'المخزون غير كافي.' : error.message, true);
  }
}

async function handleNetworkTopupAdmin(query, data) {
  if (!isAdmin(query.from.id)) return answerCallback(query.id, 'Admins only', true);
  const [, action, transactionIdRaw] = data.split(':');
  const transactionId = Number(transactionIdRaw);
  const dbTransaction = await sequelize.transaction();
  let ledger;
  let targetUser;
  try {
    ledger = await BalanceTransaction.findByPk(transactionId, { transaction: dbTransaction, lock: dbTransaction.LOCK.UPDATE });
    if (!ledger || ledger.status !== 'proof_pending' || ledger.paymentOrigin !== 'network_fallback') {
      await dbTransaction.rollback();
      return answerCallback(query.id, 'تمت معالجة العملية سابقاً.', true);
    }
    if (action === 'reject') {
      ledger.status = 'rejected';
      await ledger.save({ transaction: dbTransaction });
      await dbTransaction.commit();
      await answerCallback(query.id, 'تم الرفض.');
      await bot.sendMessage(ledger.userId, `❌ تم رفض إيصال الشحن #${ledger.id}.`).catch(() => {});
      return;
    }
    targetUser = await User.findByPk(ledger.userId, { transaction: dbTransaction, lock: dbTransaction.LOCK.UPDATE });
    targetUser.balance = Number(targetUser.balance || 0) + Number(ledger.amount || 0);
    await targetUser.save({ transaction: dbTransaction });
    ledger.status = 'completed';
    await ledger.save({ transaction: dbTransaction });
    await dbTransaction.commit();
  } catch (error) {
    await dbTransaction.rollback();
    throw error;
  }

  await network.recordFallbackSettlement({
    amountUsd: Number(ledger.amount || 0),
    method: ledger.networkMethod || 'shared_payment',
    sourceRef: `topup:${ledger.id}`,
    customerName: targetUser?.firstName || targetUser?.username || String(ledger.userId),
    activity: 'topup'
  }).catch(error => console.error('Settlement notify failed:', error.message));
  await answerCallback(query.id, 'تم الشحن وتسجيل الحساب مع مالك الشبكة.');
  if (query.message) await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: query.message.chat.id, message_id: query.message.message_id }).catch(() => {});
  const moneyContext = await shopMoneyContext();
  const targetLang = targetUser?.lang === 'en' ? 'en' : 'ar';
  await bot.sendMessage(targetUser.id, `✅ ${targetLang === 'en' ? 'Wallet credited' : 'تم شحن محفظتك'}: <b>${customerMoney(ledger.amount, moneyContext, targetLang)}</b>\n${targetLang === 'en' ? 'New balance' : 'الرصيد الجديد'}: <b>${customerMoney(targetUser.balance, moneyContext, targetLang)}</b>`, { parse_mode: 'HTML' }).catch(() => {});
}

async function showOrders(chatId, user) {
  const orders = await PurchaseOrder.findAll({
    where: { userId: user.id },
    order: [['id', 'DESC']],
    limit: 15,
    include: [Merchant]
  });
  if (!orders.length) return bot.sendMessage(chatId, t(user.lang, 'noOrders'));
  const keyboard = orders.map(order => [{
    text: `#${order.id} | ${user.lang === 'en' ? (order.Merchant?.nameEn || order.Merchant?.nameAr) : (order.Merchant?.nameAr || '')} | ${order.status}`,
    callback_data: `order:${order.id}`
  }]);
  return bot.sendMessage(chatId, `${premiumEmojiHtml(PREMIUM_EMOJI.orders)} <b>${escapeHtml(t(user.lang, 'orders'))}</b>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
}

async function showOrder(chatId, user, orderId, callbackId = null) {
  if (callbackId) await answerCallback(callbackId);
  const [order, moneyContext] = await Promise.all([PurchaseOrder.findByPk(orderId, { include: [Merchant] }), shopMoneyContext()]);
  if (!order || (String(order.userId) !== String(user.id) && !isAdmin(user.id))) return;
  const name = user.lang === 'en' ? (order.Merchant?.nameEn || order.Merchant?.nameAr) : order.Merchant?.nameAr;
  const deliveries = await DeliveryRecord.findAll({ where: { orderId: order.id }, order: [['createdAt', 'ASC']] });
  const isEn = user.lang === 'en';
  const lines = [
    `🧾 <b>${isEn ? 'Order' : 'الطلب'} #${order.id}</b>`,
    `${isEn ? 'Product' : 'المنتج'}: ${escapeHtml(name || '')}`,
    `${isEn ? 'Quantity' : 'الكمية'}: ${order.quantity}`,
    `${isEn ? 'Total' : 'السعر الكامل'}: ${customerMoney(order.totalAmount, moneyContext, user.lang)}`
  ];
  if (Number(order.walletApplied || 0) > 0) {
    lines.push(`${isEn ? 'From wallet' : 'من المحفظة'}: ${customerMoney(order.walletApplied, moneyContext, user.lang)}`);
  }
  if (Number(order.externalAmount || 0) > 0 && Number(order.externalAmount || 0) + 1e-9 < Number(order.totalAmount || 0)) {
    lines.push(`${isEn ? 'External payment' : 'الدفع الخارجي'}: ${customerMoney(order.externalAmount, moneyContext, user.lang)}`);
  }
  lines.push(`${isEn ? 'Payment' : 'طريقة الدفع'}: ${escapeHtml(order.paymentMethod)}`);
  lines.push(`${isEn ? 'Status' : 'الحالة'}: ${escapeHtml(order.status)}`);
  if (deliveries.length) {
    lines.push('', `<b>${isEn ? 'Delivery IDs' : 'معرفات المنتجات المستلمة'}:</b>`);
    for (const delivery of deliveries) lines.push(`<code>${escapeHtml(delivery.id)}</code>`);
  }
  await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
}

async function showAdminPaymentMethods(chatId) {
  const methods = await PaymentMethod.findAll({ order: [['sortOrder', 'ASC'], ['id', 'ASC']] });
  const rows = methods.map(method => [emojiButton(
    `${method.isActive ? '✅' : '⛔'} ${method.nameAr}`,
    customPaymentEmoji(method),
    { callback_data: `adm:pm:${method.id}`, style: method.isActive ? 'success' : 'danger' }
  )]);

  rows.push([{ text: '➕ إضافة طريقة دفع', callback_data: 'adm:add_payment_method', style: 'success' }]);

  let inheritedLines = [];
  if (network.enabledClient()) {
    const hidden = await getHiddenPaymentTypes();
    let inheritedMethods = [];
    try {
      const inherited = await network.fallbackPayments();
      inheritedMethods = Array.isArray(inherited?.methods) ? inherited.methods : [];
    } catch (error) {
      inheritedLines.push(`⚠️ تعذر قراءة طرق المالك: ${escapeHtml(error.message)}`);
    }

    const byType = new Map(inheritedMethods.map(method => [String(method.type || ''), method]));
    const [localBinanceReady, localSuperQi] = await Promise.all([binancePay.configured(), localSuperQiNumber()]);
    if (localBinanceReady && !byType.has('binance')) byType.set('binance', { type: 'binance', nameAr: 'Binance ID', nameEn: 'Binance ID' });
    if (localSuperQi && !byType.has('superqi')) byType.set('superqi', { type: 'superqi', nameAr: 'سوبركي', nameEn: 'SuperQi' });

    for (const [type, method] of byType) {
      if (!type) continue;
      const isHidden = hidden.has(type);
      const name = method.nameAr || method.nameEn || type;
      const emoji = method.iconCustomEmojiId
        ? { id: String(method.iconCustomEmojiId), alt: method.iconAlt || '💳' }
        : (type === 'binance' ? PREMIUM_EMOJI.binance : type === 'superqi' ? PREMIUM_EMOJI.superqi : null);
      rows.push([emojiButton(`${isHidden ? '🚫 مخفية' : '👁 ظاهرة'} — ${name}`, emoji, {
        callback_data: `adm:pmvis:${type}`,
        style: isHidden ? 'danger' : 'success'
      })]);
    }
    rows.push([{ text: '👁 إظهار كل طرق الدفع الرئيسية', callback_data: 'adm:payment_methods_inherit', style: 'primary' }]);
    inheritedLines.push('', 'تگدر تخفي Binance أو سوبركي أو أي طريقة دفع رئيسية في هذا البوت وحده. هذا ما يغيّر شي بباقي البوتات.');
  }

  rows.push([{ text: '⬅️ رجوع لقسم الدفع', callback_data: 'adm:menu:payments' }]);

  return bot.sendMessage(chatId, [
    '💳 <b>طرق الدفع</b>',
    '',
    'طرقك المحلية تقدر تعدلها وتشغلها أو توقفها.',
    ...inheritedLines
  ].join('\n'), {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows }
  });
}

async function showAdminPaymentMethod(chatId, id) {
  const method = await PaymentMethod.findByPk(id);
  if (!method) return bot.sendMessage(chatId, '❌ طريقة الدفع غير موجودة.');
  const icon = customPaymentEmoji(method);
  return bot.sendMessage(chatId, [
    `${icon ? premiumEmojiHtml(icon) : '💳'} <b>${escapeHtml(method.nameAr)}</b>`,
    `English: <b>${escapeHtml(method.nameEn)}</b>`,
    `رقم الدفع: <code>${escapeHtml(method.paymentNumber)}</code>`,
    `العملة: <b>${method.settlementCurrency || 'USD'}</b>`,
    `سعر 1$: <b>${Number(method.ratePerUsd || 1)}</b> ${method.settlementCurrency || 'USD'}`,
    `الحالة: <b>${method.isActive ? 'مفعلة' : 'متوقفة'}</b>`,
    `Custom Emoji ID: <code>${escapeHtml(method.iconCustomEmojiId || 'بدون')}</code>`
  ].join('\n'), {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [
      [
        { text: '✏️ تغيير الاسم', callback_data: `adm:pmfield:${method.id}:name` },
        { text: '🔢 تغيير الرقم', callback_data: `adm:pmfield:${method.id}:number` }
      ],
      [{ text: method.isActive ? '⛔ إيقاف الطريقة' : '✅ تشغيل الطريقة', callback_data: `adm:pmtoggle:${method.id}`, style: method.isActive ? 'danger' : 'success' }],
      [{ text: '⬅️ كل طرق الدفع', callback_data: 'adm:payment_methods' }]
    ] }
  });
}

async function localNetworkAccounts() {
  if (network.isMaster()) return networkLedger.accountsForShop('master');
  if (network.enabledClient()) {
    const remote = await network.getMyAccounts();
    return remote?.accounts || { accounts: [], pendingIncoming: [], pendingOutgoing: [] };
  }
  return { accounts: [], pendingIncoming: [], pendingOutgoing: [], shopId: 'standalone', shopName: 'متجري' };
}

async function showNetworkAccounts(chatId) {
  const data = await localNetworkAccounts();
  const lines = [
    '🤝 <b>الحسابات بين المتاجر</b>',
    '',
    'الحساب هنا صافي تلقائياً: إذا صار دين بالعكس بين نفس الطرفين، النظام يخصمه من الدين السابق بدل ما يحسب مبلغين متعاكسين.'
  ];
  const keyboard = [];
  lines.push('', `💸 عمولة البيع من مخزون الآخرين (${Number(data.sellerCommissionPercent ?? config.network.sellerCommissionPercent ?? 10).toFixed(0)}%): <b>$${Number(data.sellerCommissionEarnedUsd || 0).toFixed(2)}</b>`);
  const debtStatus = data.commerceStatus || await currentCommerceStatus(true);
  if (debtStatus?.suspended) {
    lines.push('', `⛔ <b>البيع متوقف مؤقتاً</b> لأن الالتزامات الحالية وصلت إلى <b>$${Number(debtStatus.liabilityUsd || 0).toFixed(2)}</b> (حد الإيقاف $${Number(debtStatus.thresholdUsd || 40).toFixed(2)}).`, 'يبقى الإيقاف إلى أن تسجل التسديد ويؤكد الطرف المقابل وصول المبلغ.');
  }

  if (!data.accounts?.length) lines.push('', '✅ ماكو ديون مفتوحة حالياً.');
  for (const account of data.accounts || []) {
    const usd = Number(account.amountUsd || account.values?.usd || 0);
    const iqd = Number(account.values?.iqd || 0);
    const egp = Number(account.values?.egp || 0);
    const localCurrency = shopDisplayCurrency();
    lines.push('', account.direction === 'owe'
      ? `🔴 عليك لـ <b>${escapeHtml(account.counterpartyName)}</b>: <b>$${usd.toFixed(2)}</b>`
      : `🟢 إلك على <b>${escapeHtml(account.counterpartyName)}</b>: <b>$${usd.toFixed(2)}</b>`);
    if (localCurrency === 'IQD') lines.push(`🇮🇶 ${Math.round(iqd).toLocaleString('en-US')} IQD`);
    else if (localCurrency === 'EGP') lines.push(`🇪🇬 ${egp.toFixed(2)} EGP`);
    if (account.direction === 'owe' && usd > 0) {
      keyboard.push([{
        text: `✅ تم تسديد الدين لـ ${String(account.counterpartyName).slice(0, 28)} — $${usd.toFixed(2)}`,
        callback_data: `adm:debt_paid:${account.counterpartyId}`,
        style: 'success'
      }]);
    }
  }

  for (const pending of data.pendingOutgoing || []) {
    lines.push('', `🕓 أنت سجلت تسديد <b>$${Number(pending.amountUsd || 0).toFixed(2)}</b> إلى <b>${escapeHtml(pending.creditorName || pending.creditorShopId)}</b> — ننتظر تأكيد الاستلام.`, `المبلغ المثبت للتسوية: <b>${Number(pending.values?.settlementAmount || pending.settlementAmount || pending.amountUsd || 0).toFixed((pending.values?.settlementCurrency || pending.settlementCurrency) === 'IQD' ? 0 : 2)} ${escapeHtml(pending.values?.settlementCurrency || pending.settlementCurrency || 'USD')}</b>`);
  }
  for (const pending of data.pendingIncoming || []) {
    lines.push('', `⚠️ <b>${escapeHtml(pending.debtorName || pending.debtorShopId)}</b> يقول إنه سدّد لك <b>$${Number(pending.amountUsd || 0).toFixed(2)}</b>.`, `المبلغ المثبت: <b>${Number(pending.values?.settlementAmount || pending.settlementAmount || pending.amountUsd || 0).toFixed((pending.values?.settlementCurrency || pending.settlementCurrency) === 'IQD' ? 0 : 2)} ${escapeHtml(pending.values?.settlementCurrency || pending.settlementCurrency || 'USD')}</b> — وافق فقط إذا وصل فعلاً.`);
    keyboard.push([
      { text: '✅ وصل المبلغ', callback_data: `adm:debt_resolve:1:${pending.id}`, style: 'success' },
      { text: '❌ ما وصل', callback_data: `adm:debt_resolve:0:${pending.id}`, style: 'danger' }
    ]);
  }
  keyboard.push([{ text: '🔄 تحديث الحسابات', callback_data: 'adm:network_accounts' }]);
  keyboard.push([{ text: '⬅️ رجوع لقسم الشبكة', callback_data: 'adm:menu:network' }]);
  return bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
}

async function showProductContributors(chatId, product) {
  if (!product) return bot.sendMessage(chatId, '❌ المنتج غير موجود.');
  let contributors = [];
  if (network.enabledClient() && product.networkManaged) {
    const remote = await network.getProductContributors(product.networkProductId);
    contributors = remote?.contributors || [];
  } else {
    contributors = await networkLedger.salesStatsForProduct(product);
  }
  const totalAdded = contributors.reduce((sum, row) => sum + Number(row.addedUnits || 0), 0);
  const totalSold = contributors.reduce((sum, row) => sum + Number(row.soldUnits || 0), 0);
  const totalAvailable = contributors.reduce((sum, row) => sum + Number(row.availableUnits || 0), 0);
  const lines = [
    `📊 <b>${escapeHtml(product.nameAr)}</b>`,
    `المخزون الكلي الظاهر للزبون: <b>${totalAvailable}</b>`,
    `إجمالي ما تم إدخاله: <b>${totalAdded}</b> • المباع: <b>${totalSold}</b>`,
    '',
    '<b>تفصيل كل مساهم:</b>'
  ];
  for (const row of contributors) {
    lines.push(
      '',
      `👤 <b>${escapeHtml(row.shopName || row.shopId)}</b>`,
      `أضاف: <b>${Number(row.addedUnits || 0)}</b> • انباع من مخزونه: <b>${Number(row.soldUnits || 0)}</b> • باقي: <b>${Number(row.availableUnits || 0)}</b>`,
      `حقه من القطع المباعة: <b>$${Number((row.supplierEarningsUsd ?? row.soldValueUsd) || 0).toFixed(2)}</b>`,
      `عمولة البيع التي كسبها من مخزون الآخرين: <b>$${Number(row.sellerCommissionUsd || 0).toFixed(2)}</b>`
    );
  }
  if (!contributors.length) lines.push('— ماكو مخزون بعد.');
  return bot.sendMessage(chatId, lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '📥 إضافة مخزون', callback_data: `adm:stockprod:${product.id}`, style: 'success' }]] }
  });
}

async function handleAdminCallback(query, user, data) {
  if (data === 'adm:home') {
    await answerCallback(query.id);
    return bot.sendMessage(query.message.chat.id, await adminDashboardText(), {
      parse_mode: 'HTML',
      reply_markup: await adminMenu()
    });
  }

  if (data.startsWith('adm:menu:')) {
    const section = data.slice('adm:menu:'.length);
    const menu = await adminSectionMenu(section);
    if (!menu) return answerCallback(query.id, 'القسم غير موجود.', true);
    await answerCallback(query.id);
    return bot.sendMessage(query.message.chat.id, menu.title, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: menu.keyboard }
    });
  }

  if (data === 'adm:delivery_lookup') {
    await setState(user.id, { action: 'admin_delivery_lookup' });
    await answerCallback(query.id);
    return bot.sendMessage(user.id, '🔎 أرسل <b>معرف التسليم</b> مثل <code>DLV-...</code> أو <b>رقم الطلب</b> مثل <code>#123</code>. راح أطلع لك المحتوى وصاحب المخزون الحقيقي لكل قطعة.', { parse_mode: 'HTML', reply_markup: cancelInlineKeyboard() });
  }

  if (data === 'adm:network_accounts' || data === 'adm:network_debt') {
    await answerCallback(query.id);
    try { return await showNetworkAccounts(query.message.chat.id); }
    catch (error) { return bot.sendMessage(query.message.chat.id, `❌ تعذر قراءة الحسابات: ${escapeHtml(error.message)}`, { parse_mode: 'HTML' }); }
  }

  if (data.startsWith('adm:debt_paid:')) {
    const counterpartyShopId = data.slice('adm:debt_paid:'.length);
    try {
      let request;
      if (network.isMaster()) request = await networkLedger.createDebtPaymentRequest('master', counterpartyShopId);
      else request = (await network.markDebtPaid(counterpartyShopId))?.request;
      invalidateCommerceStatus();
      await answerCallback(query.id, 'تم تسجيل التسديد. ننتظر تأكيد الطرف الثاني.');
      await bot.sendMessage(query.message.chat.id, `🕓 تم تسجيل أنك سددت <b>$${Number(request?.amountUsd || 0).toFixed(2)}</b>. الدين لن يعتبر منتهياً نهائياً إلا بعد موافقة الطرف المستلم.`, { parse_mode: 'HTML' });
      return showNetworkAccounts(query.message.chat.id);
    } catch (error) {
      return answerCallback(query.id, error.message === 'NO_DEBT_TO_PAY' ? 'ماكو دين مفتوح لهذا الطرف.' : error.message, true);
    }
  }

  if (data.startsWith('adm:debt_resolve:')) {
    const parts = data.split(':');
    const approve = parts[2] === '1';
    const requestId = parts.slice(3).join(':');
    try {
      if (network.isMaster()) await networkLedger.resolveDebtPaymentRequest(requestId, 'master', approve);
      else await network.resolveIncomingDebtPayment(requestId, approve);
      invalidateCommerceStatus();
      await answerCallback(query.id, approve ? 'تم تأكيد استلام المبلغ.' : 'تم الرفض ورجع الدين للحساب.');
      return showNetworkAccounts(query.message.chat.id);
    } catch (error) {
      return answerCallback(query.id, error.message, true);
    }
  }

  if (data.startsWith('adm:contributors:')) {
    const product = await Merchant.findByPk(Number(data.split(':')[2]));
    await answerCallback(query.id);
    try { return await showProductContributors(query.message.chat.id, product); }
    catch (error) { return bot.sendMessage(query.message.chat.id, `❌ تعذر قراءة مساهمات المخزون: ${escapeHtml(error.message)}`, { parse_mode: 'HTML' }); }
  }

  if (data === 'adm:network') {
    if (!network.isMaster()) return answerCallback(query.id, 'هذا الخيار للمالك الرئيسي فقط.', true);
    await answerCallback(query.id);
    const clients = await NetworkClient.findAll({ order: [['id', 'ASC']] });
    const apiEnabled = String(await getSetting('network_api_enabled', 'true')).toLowerCase() !== 'false';
    const keyboard = clients.map(client => [{
      text: `${client.isActive ? '✅' : '⛔'} ${client.name} | ${client.settlementCurrency}`,
      callback_data: `adm:network_client:${client.id}`
    }]);
    keyboard.push([{ text: '➕ تفعيل بوت صديق', callback_data: 'adm:network_add', style: 'success' }]);
    keyboard.push([{ text: apiEnabled ? '🔒 إغلاق API للجميع' : '🔓 فتح API للجميع', callback_data: 'adm:network_global_toggle', style: apiEnabled ? 'danger' : 'success' }]);
    keyboard.push([{ text: '⬅️ رجوع لقسم الشبكة', callback_data: 'adm:menu:network' }]);
    return bot.sendMessage(query.message.chat.id, [
      '🔗 <b>API والشركاء</b>',
      '',
      `الرابط الرئيسي: <code>${escapeHtml(config.network.publicUrl || 'ضع NETWORK_PUBLIC_URL في Railway')}</code>`,
      `عدد الشركاء: <b>${clients.length}</b>`,
      `حالة API: <b>${apiEnabled ? 'مفتوح' : 'مغلق'}</b>`,
      '',
      'كل مفتاح مستقل ويمكنك إيقافه وحده بدون إيقاف باقي البوتات.'
    ].join('\n'), { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
  }

  if (data === 'adm:network_global_toggle') {
    if (!network.isMaster()) return answerCallback(query.id, 'للمالك الرئيسي فقط.', true);
    const enabled = String(await getSetting('network_api_enabled', 'true')).toLowerCase() !== 'false';
    await setSetting('network_api_enabled', enabled ? 'false' : 'true');
    await answerCallback(query.id, enabled ? 'تم إغلاق API لجميع الشركاء.' : 'تم فتح API لجميع الشركاء.');
    return;
  }

  if (data === 'adm:network_add') {
    if (!network.isMaster()) return answerCallback(query.id, 'للمالك الرئيسي فقط.', true);
    await setState(user.id, { action: 'admin_network_add', step: 'name', data: {} });
    await answerCallback(query.id);
    return bot.sendMessage(user.id, '1/4 أرسل اسم صاحب البوت أو اسم المتجر، مثال: أحمد', { reply_markup: cancelInlineKeyboard() });
  }

  if (data.startsWith('adm:network_currency:')) {
    if (!network.isMaster()) return answerCallback(query.id, 'للمالك الرئيسي فقط.', true);
    const currency = data.split(':')[2];
    if (!['USD','IQD','EGP'].includes(currency)) return answerCallback(query.id, 'عملة غير صحيحة.', true);
    const fresh = await User.findByPk(user.id);
    const state = parseState(fresh);
    if (!state || state.action !== 'admin_network_add' || state.step !== 'currency') return answerCallback(query.id, 'انتهت العملية.', true);
    const partnerBotToken = pendingPartnerBotTokens.get(Number(user.id));
    if (!partnerBotToken) {
      await clearState(user.id);
      await answerCallback(query.id, 'انتهت جلسة الإعداد. أعد إضافة البوت حتى أحمي التوكن.', true);
      return;
    }
    const created = await network.createClient({
      name: state.data.name,
      ownerTelegramId: state.data.ownerTelegramId,
      settlementCurrency: currency
    });
    const rawVariablesPart1 = [
      `BOT_TOKEN=${partnerBotToken}`,
      `ADMIN_IDS=${state.data.ownerTelegramId}`,
      'DATABASE_URL=${{Postgres.DATABASE_URL}}',
      `DATABASE_SCHEMA=${created.databaseSchema}`,
      'NETWORK_ROLE=client'
    ].join('\n');
    const rawVariablesPart2 = [
      `NETWORK_API_URL=${config.network.publicUrl || 'https://YOUR-MASTER.up.railway.app'}`,
      `NETWORK_API_KEY=${created.apiKey}`,
      `NETWORK_SHOP_ID=${created.row.shopId}`,
      `NETWORK_SHOP_NAME=${created.row.name}`,
      `NETWORK_SETTLEMENT_CURRENCY=${currency}`
    ].join('\n');
    const rawVariables = `${rawVariablesPart1}\n${rawVariablesPart2}`;
    const copyChunks = [];
    let copyChunk = '';
    for (const line of rawVariables.split('\n')) {
      const candidate = copyChunk ? `${copyChunk}\n${line}` : line;
      if (candidate.length > 240 && copyChunk) {
        copyChunks.push(copyChunk);
        copyChunk = line;
      } else {
        copyChunk = candidate;
      }
    }
    if (copyChunk) copyChunks.push(copyChunk);
    await clearState(user.id);
    await answerCallback(query.id, 'جاهز للنسخ إلى Railway.');
    return bot.sendMessage(user.id, [
      '✅ <b>بوت الشريك صار جاهز</b>',
      `الاسم: <b>${escapeHtml(created.row.name)}</b>`,
      `Shop ID: <code>${escapeHtml(created.row.shopId)}</code>`,
      `قاعدة البيانات: <b>تتكوّن تلقائياً</b> داخل Schema منفصل <code>${escapeHtml(created.databaseSchema)}</code>`,
      '',
      '📌 <b>شنو تسوي هسه؟</b>',
      '1) داخل <b>نفس مشروع Railway</b> مالالبوت الرئيسي، أنشئ Service جديد وارفع نفس ملفات البوت.',
      '2) افتح <b>Variables → Raw Editor</b>.',
      '3) انسخ البلوك كله أدناه والصقه كما هو.',
      '4) Deploy. انتهى — لا تضيف PostgreSQL جديد ولا تنشئ جداول بيدك.',
      '',
      '⚠️ لازم خدمة قاعدة البيانات داخل المشروع اسمها <b>Postgres</b> حتى يعمل السطر التلقائي <code>${{Postgres.DATABASE_URL}}</code>.',
      '',
      '📋 <b>اضغط مطولاً وانسخ:</b>',
      `<pre>${escapeHtml(rawVariables)}</pre>`,
      '',
      '🔐 BOT TOKEN وAPI KEY أسرار. لا ترسل هذا البلوك لأي شخص غير صاحب البوت.'
    ].join('\n'), {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: copyChunks.map((chunk, index) => [{
        text: `📋 نسخ الإعدادات ${index + 1}/${copyChunks.length}`,
        copy_text: { text: chunk }
      }]) }
    });
  }

  if (data.startsWith('adm:network_client:')) {
    if (!network.isMaster()) return answerCallback(query.id, 'للمالك الرئيسي فقط.', true);
    const client = await NetworkClient.findByPk(Number(data.split(':')[2]));
    if (!client) return answerCallback(query.id, 'الشريك غير موجود.', true);
    const masterAccounts = await networkLedger.accountsForShop('master');
    const account = masterAccounts.accounts.find(row => row.counterpartyId === client.shopId);
    await answerCallback(query.id);
    const relation = !account ? '✅ الحساب مصفّر'
      : account.direction === 'owe'
        ? `🔴 عليك لـ ${escapeHtml(client.name)}: <b>$${Number(account.amountUsd).toFixed(2)}</b>`
        : `🟢 إلك على ${escapeHtml(client.name)}: <b>$${Number(account.amountUsd).toFixed(2)}</b>`;
    return bot.sendMessage(query.message.chat.id, [
      `🤝 <b>${escapeHtml(client.name)}</b>`,
      `Shop ID: <code>${escapeHtml(client.shopId)}</code>`,
      `Telegram: <code>${escapeHtml(String(client.ownerTelegramId || 'غير محدد'))}</code>`,
      `عملة العرض: <b>${client.settlementCurrency}</b>`,
      `الحالة: <b>${client.isActive ? 'مفعل' : 'متوقف'}</b>`,
      '',
      relation,
      '',
      'تفاصيل جميع الديون وطلبات تأكيد التسديد موجودة في زر «الحسابات والديون».'
    ].join('\n'), {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[
        { text: client.isActive ? '⛔ إيقاف API لهذا البوت' : '✅ إعادة تفعيل API', callback_data: `adm:network_toggle:${client.id}`, style: client.isActive ? 'danger' : 'success' }
      ], [
        { text: '🤝 الحسابات والديون', callback_data: 'adm:network_accounts', style: 'primary' }
      ], [{ text: '⬅️ الشركاء', callback_data: 'adm:network' }]] }
    });
  }

  if (data.startsWith('adm:network_settle:')) {
    await answerCallback(query.id, 'استخدم «الحسابات والديون» ثم «تم تسديد الدين». الطرف الثاني لازم يؤكد الاستلام.', true);
    return;
  }

  if (data.startsWith('adm:network_toggle:')) {
    if (!network.isMaster()) return answerCallback(query.id, 'للمالك الرئيسي فقط.', true);
    const client = await NetworkClient.findByPk(Number(data.split(':')[2]));
    if (!client) return answerCallback(query.id, 'الشريك غير موجود.', true);
    client.isActive = !client.isActive;
    await client.save({ fields: ['isActive'] });
    await answerCallback(query.id, client.isActive ? 'تم تفعيل API.' : 'تم إيقاف API لهذا البوت.');
    return;
  }



  if (data === 'adm:binance_setup') {
    await setState(user.id, { action: 'admin_binance_setup', step: 'apiKey', data: {} });
    await answerCallback(query.id);
    return bot.sendMessage(user.id, '1/3 أرسل Binance API Key.\nلن أعرض المفتاح بعد حفظه.', { reply_markup: cancelInlineKeyboard() });
  }

  if (data === 'adm:binance_clear') {
    await setSecureSetting('binance_api_key', '');
    await setSecureSetting('binance_api_secret', '');
    await setSetting('binance_pay_id', '');
    await answerCallback(query.id, network.enabledClient() ? 'تم حذف Binance المحلي. إذا عند المالك الرئيسي Binance راح يظهر تلقائياً كطريقة احتياطية.' : 'تم حذف إعداد Binance.');
    return;
  }

  if (data.startsWith('adm:pmcurrency:')) {
    const currency = data.split(':')[2];
    if (!['USD','IQD','EGP'].includes(currency)) return answerCallback(query.id, 'عملة غير صحيحة.', true);
    const fresh = await User.findByPk(user.id);
    const state = parseState(fresh);
    if (!state || state.action !== 'admin_new_payment_method' || state.step !== 'currency') return answerCallback(query.id, 'انتهت عملية الإضافة.', true);
    const dataState = { ...(state.data || {}), settlementCurrency: currency };
    await answerCallback(query.id, `تم اختيار ${currency}.`);
    if (currency === 'USD') {
      dataState.ratePerUsd = 1;
      const method = await createConfiguredPaymentMethod(dataState);
      await clearState(user.id);
      return bot.sendMessage(user.id, `✅ تمت إضافة <b>${escapeHtml(method.nameAr)}</b> بعملة USD.`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '💳 إدارة طرق الدفع', callback_data: 'adm:payment_methods' }]] } });
    }
    await setState(user.id, { action: 'admin_new_payment_method', step: 'rate', data: dataState });
    return bot.sendMessage(user.id, currency === 'IQD'
      ? '4/4 أرسل سعر 1$ بالدينار العراقي، مثال: 1500'
      : '4/4 أرسل سعر 1$ بالجنيه المصري، مثال: 50', { reply_markup: cancelInlineKeyboard() });
  }

  if (data === 'adm:add_payment_method') {
    await setState(user.id, { action: 'admin_new_payment_method', step: 'nameAr', data: {} });
    await answerCallback(query.id);
    return bot.sendMessage(user.id, [
      '➕ <b>إضافة طريقة دفع</b>',
      '',
      '1/4 أرسل اسم الخدمة بالعربي.',
      'تقدر ترسل Custom Emoji Premium ويا الاسم، أو ID بين [] مثل:',
      '<code>[5184203496831846429] سوبركي</code>'
    ].join('\n'), { parse_mode: 'HTML', reply_markup: cancelInlineKeyboard() });
  }

  if (data === 'adm:payment_methods_inherit') {
    if (!network.enabledClient()) return answerCallback(query.id, 'هذا الخيار للبوتات المرتبطة فقط.', true);
    await setHiddenPaymentTypes(new Set());
    await answerCallback(query.id, 'تم إظهار كل طرق الدفع الرئيسية في هذا البوت.');
    return showAdminPaymentMethods(query.message.chat.id);
  }

  if (data.startsWith('adm:pmvis:')) {
    if (!network.enabledClient()) return answerCallback(query.id, 'هذا الخيار للبوتات المرتبطة فقط.', true);
    const type = data.slice('adm:pmvis:'.length);
    if (!type) return answerCallback(query.id, 'طريقة دفع غير صحيحة.', true);
    const hidden = await getHiddenPaymentTypes();
    if (hidden.has(type)) hidden.delete(type);
    else hidden.add(type);
    await setHiddenPaymentTypes(hidden);
    await answerCallback(query.id, hidden.has(type) ? 'تم إخفاء الطريقة في هذا البوت فقط.' : 'تم إظهار الطريقة في هذا البوت.');
    return showAdminPaymentMethods(query.message.chat.id);
  }

  if (data === 'adm:payment_methods') {
    await answerCallback(query.id);
    return showAdminPaymentMethods(query.message.chat.id);
  }

  if (data.startsWith('adm:pmfield:')) {
    const [, , idRaw, field] = data.split(':');
    const id = Number(idRaw);
    if (!['name', 'number'].includes(field)) return answerCallback(query.id, 'حقل غير صحيح.', true);
    const method = await PaymentMethod.findByPk(id);
    if (!method) return answerCallback(query.id, 'طريقة الدفع غير موجودة.', true);
    if (network.enabledClient()) await setSetting('custom_payment_override', 'true');
    await setState(user.id, { action: 'admin_edit_payment_method', paymentMethodId: id, field });
    await answerCallback(query.id);
    return bot.sendMessage(user.id, field === 'name'
      ? 'أرسل الاسم الجديد بالعربي. تقدر تستخدم Premium Emoji أو [ID] قبل الاسم.'
      : 'أرسل رقم/معرّف الدفع الجديد.', { reply_markup: cancelInlineKeyboard() });
  }

  if (data.startsWith('adm:pmtoggle:')) {
    const id = Number(data.split(':')[2]);
    const method = await PaymentMethod.findByPk(id);
    if (!method) return answerCallback(query.id, 'طريقة الدفع غير موجودة.', true);
    if (network.enabledClient()) await setSetting('custom_payment_override', 'true');
    method.isActive = !method.isActive;
    await method.save({ fields: ['isActive'] });
    await answerCallback(query.id, method.isActive ? 'تم تشغيل طريقة الدفع.' : 'تم إيقاف طريقة الدفع.');
    return showAdminPaymentMethod(query.message.chat.id, method.id);
  }

  if (data.startsWith('adm:pm:')) {
    const id = Number(data.split(':')[2]);
    await answerCallback(query.id);
    return showAdminPaymentMethod(query.message.chat.id, id);
  }

  if (data === 'adm:stock') {
    await answerCallback(query.id);
    return showStockProductList(query.message.chat.id);
  }

  if (data === 'adm:support') {
    await answerCallback(query.id);
    return showSupportTickets(query.message.chat.id);
  }

  if (data === 'adm:broadcast') {
    await setState(user.id, { action: 'admin_broadcast' });
    await answerCallback(query.id);
    return bot.sendMessage(user.id, [
      '📣 أرسل الإعلان الآن.',
      '',
      'تقدر ترسل نص أو صورة أو فيديو أو ملف، وراح يوصل كما هو إلى جميع المستخدمين غير المحظورين.',
      'اكتب إغلاق للإلغاء.'
    ].join('\n'), { reply_markup: cancelInlineKeyboard() });
  }

  if (data === 'adm:channel') {
    await answerCallback(query.id);
    const channel = await getRequiredChannel();
    const url = channelJoinUrl(channel);
    return bot.sendMessage(query.message.chat.id, [
      '📢 <b>إدارة قناة البوت</b>',
      '',
      `القناة الحالية: <code>${escapeHtml(channel || 'غير مضافة')}</code>`,
      '',
      'عند إضافة القناة يظهر زرها للمستخدمين، ويصبح الاشتراك بها إجبارياً قبل استخدام المتجر.'
    ].join('\n'), {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '➕ إضافة/تغيير القناة', callback_data: 'adm:set:required_channel' }],
          ...(url ? [[{ text: '👁 فتح القناة', url }]] : []),
          [{ text: '❌ إيقاف القناة', callback_data: 'adm:channel_disable' }],
          [{ text: '⬅️ رجوع للتسويق والإشعارات', callback_data: 'adm:menu:marketing' }]
        ]
      }
    });
  }

  if (data === 'adm:notifications_toggle') {
    const enabled = await automaticNotificationsEnabled();
    await setSetting('automatic_notifications_enabled', enabled ? 'false' : 'true');
    const nowEnabled = !enabled;
    await answerCallback(query.id, nowEnabled ? 'تم تشغيل الإشعارات التلقائية.' : 'تم إيقاف الإشعارات التلقائية.');
    const menu = await adminSectionMenu('marketing');
    return bot.sendMessage(query.message.chat.id, nowEnabled ? '🔔 <b>الإشعارات التلقائية شغالة الآن.</b>' : '🔕 <b>الإشعارات التلقائية متوقفة الآن.</b>', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: menu.keyboard }
    });
  }

  if (data === 'adm:store_toggle') {
    const open = await isStoreOpen();
    await setSetting('store_open', open ? 'false' : 'true');
    await answerCallback(query.id, open ? 'تم إغلاق المتجر.' : 'تم فتح المتجر.');
    const menu = await adminSectionMenu('settings');
    return bot.sendMessage(query.message.chat.id, open
      ? '🔒 <b>المتجر مغلق الآن.</b> الدعم والطلبات القديمة تبقى متاحة.'
      : '✅ <b>المتجر مفتوح الآن للمستخدمين.</b>', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: menu.keyboard }
    });
  }

  if (data === 'adm:referrals') {
    await answerCallback(query.id);
    return showReferralAdmin(query.message.chat.id);
  }

  if (data === 'adm:ref_toggle') {
    const settings = await getReferralSettings();
    await setSetting('referral_enabled', settings.enabled ? 'false' : 'true');
    await answerCallback(query.id, settings.enabled ? 'تم إيقاف الإحالات.' : 'تم تشغيل الإحالات.');
    return showReferralAdmin(query.message.chat.id);
  }

  if (data === 'adm:gift_toggle') {
    const settings = await getReferralSettings();
    await setSetting('referral_gift_enabled', settings.giftEnabled ? 'false' : 'true');
    await answerCallback(query.id, settings.giftEnabled ? 'تم إخفاء الهدية.' : 'تم تشغيل الهدية.');
    return showReferralAdmin(query.message.chat.id);
  }

  if (data === 'adm:ref_product') {
    await answerCallback(query.id);
    const products = await Merchant.findAll({ order: [['id', 'ASC']] });
    const keyboard = products.map(product => [{
      text: `${product.nameAr} | ${moneyUsd(product.price)}`,
      callback_data: `adm:ref_product_set:${product.id}`
    }]);
    keyboard.push([{ text: '❌ بدون منتج هدية', callback_data: 'adm:ref_product_set:0' }]);
    return bot.sendMessage(query.message.chat.id, 'اختَر المنتج الذي يُسلَّم مجاناً عند اكتمال الدعوات:', {
      reply_markup: { inline_keyboard: keyboard }
    });
  }

  if (data.startsWith('adm:ref_product_set:')) {
    const productId = Number(data.split(':')[3]);
    await setSetting('referral_gift_product_id', productId > 0 ? String(productId) : '');
    await answerCallback(query.id, 'تم تحديث منتج الهدية.');
    return showReferralAdmin(query.message.chat.id);
  }

  if (data === 'adm:user_lookup') {
    await setState(user.id, { action: 'admin_user_lookup' });
    await answerCallback(query.id);
    return bot.sendMessage(user.id, 'أرسل آيدي المستخدم الرقمي لعرض حسابه، أو اكتب إغلاق:', {
      reply_markup: cancelInlineKeyboard()
    });
  }

  if (data === 'adm:user_credit') {
    await setState(user.id, { action: 'admin_user_credit_id' });
    await answerCallback(query.id);
    return bot.sendMessage(user.id, 'أرسل آيدي المستخدم الرقمي الذي تريد شحنه، أو اكتب إغلاق:', {
      reply_markup: cancelInlineKeyboard()
    });
  }

  if (data.startsWith('adm:usercard:')) {
    await answerCallback(query.id);
    return showAdminUserCard(query.message.chat.id, Number(data.split(':')[2]));
  }

  if (data.startsWith('adm:userblock:')) {
    const targetId = Number(data.split(':')[2]);
    const target = await User.findByPk(targetId);
    if (!target) return answerCallback(query.id, 'المستخدم غير موجود.', true);
    if (isAdmin(target.id)) return answerCallback(query.id, 'لا يمكن حظر المالك/الإدارة.', true);
    target.blocked = !target.blocked;
    await target.save();
    await answerCallback(query.id, target.blocked ? 'تم الحظر.' : 'تم فك الحظر.');
    await bot.sendMessage(target.id, target.blocked ? '⛔ تم حظر حسابك من المتجر.' : '✅ تم فك الحظر عن حسابك.').catch(() => {});
    return showAdminUserCard(query.message.chat.id, targetId);
  }

  if (data.startsWith('adm:usercredit:')) {
    const targetId = Number(data.split(':')[2]);
    await setState(user.id, { action: 'admin_user_credit_amount', targetId });
    await answerCallback(query.id);
    return bot.sendMessage(user.id, `أرسل مبلغ الشحن بالدولار للمستخدم <code>${targetId}</code>، أو اكتب إغلاق:`, {
      parse_mode: 'HTML',
      reply_markup: cancelInlineKeyboard()
    });
  }

  if (data === 'adm:proofs') {
    await answerCallback(query.id);
    const [rows, binanceRows] = await Promise.all([
      PurchaseOrder.findAll({
        where: { status: 'proof_pending' },
        order: [['id', 'DESC']],
        limit: 30,
        include: [Merchant]
      }),
      BinanceTransfer.findAll({
        where: { status: 'MANUAL_REVIEW' },
        order: [['id', 'DESC']],
        limit: 30
      })
    ]);
    const lines = [];
    if (rows.length) {
      lines.push(`${premiumEmojiHtml(PREMIUM_EMOJI.superqi)} <b>سوبركي</b>`);
      lines.push(...rows.map(order => `#${order.id} | ${escapeHtml(order.Merchant?.nameAr || '')} | ${moneyUsd(order.totalAmount)}`));
    }
    if (binanceRows.length) {
      if (lines.length) lines.push('');
      lines.push(`${premiumEmojiHtml(PREMIUM_EMOJI.binance)} <b>Binance — تحقق يدوي</b>`);
      lines.push(...binanceRows.map(row => `#${row.id} | مستخدم <code>${row.userId}</code> | ${moneyUsd(row.expectedAmount)} | <code>${escapeHtml(row.submittedOrderId || '')}</code>`));
    }
    return bot.sendMessage(query.message.chat.id, lines.length ? lines.join('\n') : 'ماكو دفعات معلقة.', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '⬅️ رجوع للطلبات والتسليم', callback_data: 'adm:menu:orders' }]] }
    });
  }

  if (data === 'adm:orders') {
    await answerCallback(query.id);
    const rows = await PurchaseOrder.findAll({ order: [['id', 'DESC']], limit: 30, include: [Merchant] });
    return bot.sendMessage(query.message.chat.id, rows.length
      ? rows.map(order => `#${order.id} | ${order.Merchant?.nameAr || ''} | ${order.status} | ${moneyUsd(order.totalAmount)}`).join('\n')
      : 'ماكو طلبات.', {
      reply_markup: { inline_keyboard: [[{ text: '⬅️ رجوع للطلبات والتسليم', callback_data: 'adm:menu:orders' }]] }
    });
  }

  if (data === 'adm:stats') {
    await answerCallback(query.id);
    const [users, blocked, products, orders, verifiedBinance, referrals, openTickets, giftClaims] = await Promise.all([
      User.count(),
      User.count({ where: { blocked: true } }),
      Merchant.count(),
      PurchaseOrder.count(),
      BinanceTransfer.count({ where: { status: 'VERIFIED' } }),
      Referral.count({ where: { status: 'rewarded' } }),
      SupportTicket.count({ where: { status: 'open' } }),
      GiftClaim.count({ where: { status: 'completed' } })
    ]);
    const stockRows = await listActiveProducts();
    const stock = stockRows.reduce((sum, row) => sum + row.stock, 0);
    return bot.sendMessage(query.message.chat.id, [
      `📊 المستخدمون: ${users}`,
      `⛔ المحظورون: ${blocked}`,
      `${premiumEmojiHtml(PREMIUM_EMOJI.products)} المنتجات: ${products}`,
      `🧾 الطلبات: ${orders}`,
      `${premiumEmojiHtml(PREMIUM_EMOJI.binance)} دفعات Binance المؤكدة: ${verifiedBinance}`,
      `🎁 الإحالات المقبولة: ${referrals}`,
      `🎉 الهدايا المسلّمة: ${giftClaims}`,
      `${premiumEmojiHtml(PREMIUM_EMOJI.support)} تذاكر الدعم المفتوحة: ${openTickets}`,
      `🔐 المخزون المتاح: ${stock}`
    ].join('\n'));
  }

  if (data === 'adm:settings') {
    await answerCallback(query.id);
    const [rate, egpRate, number, channel, open, binanceReady, binanceRuntime] = await Promise.all([
      getIqdRate(),
      getSetting('egp_rate_per_usd', String(config.network.egpRate || 50)),
      localSuperQiNumber(),
      getRequiredChannel(),
      isStoreOpen(),
      binancePay.configured(),
      binancePay.getRuntimeConfig()
    ]);
    const localCurrency = shopDisplayCurrency();
    const currencyLine = localCurrency === 'IQD'
      ? `عملة المتجر: <b>IQD</b> — سعر 1$: <b>${moneyIqd(rate)}</b>`
      : localCurrency === 'EGP'
        ? `عملة المتجر: <b>EGP</b> — سعر 1$: <b>${escapeHtml(String(egpRate))} EGP</b>`
        : 'عملة المتجر: <b>USD</b>';
    const currencyButtons = [];
    if (localCurrency === 'IQD') currencyButtons.push({ text: '🇮🇶 سعر الدولار IQD', callback_data: 'adm:set:iqd_rate' });
    if (localCurrency === 'EGP') currencyButtons.push({ text: '🇪🇬 سعر الدولار EGP', callback_data: 'adm:set:egp_rate_per_usd' });
    currencyButtons.push(emojiButton('رقم سوبركي', PREMIUM_EMOJI.superqi, { callback_data: 'adm:set:superqi_number' }));
    return bot.sendMessage(query.message.chat.id, [
      '⚙️ <b>الإعدادات</b>',
      '',
      `المتجر: <b>${open ? 'مفتوح' : 'مغلق'}</b>`,
      currencyLine,
      `رقم SuperQi المحلي: <code>${escapeHtml(number || (network.enabledClient() ? 'غير مضاف — يستخدم الرئيسي تلقائياً' : 'غير مضاف'))}</code>`,
      `القناة الإجبارية: <code>${escapeHtml(channel || 'متوقفة')}</code>`,
      `Binance ID المحلي: <code>${escapeHtml(binanceRuntime.payId || 'غير مضاف')}</code>`,
      `Binance API المحلي: <b>${binanceReady ? 'جاهز' : (network.enabledClient() ? 'غير مضاف — يستخدم الرئيسي إذا متوفر' : 'ناقص')}</b>`,
      network.enabledClient() ? `API الشبكة: <b>متصل — ${escapeHtml(config.network.shopName)}</b>` : ''
    ].filter(Boolean).join('\n'), {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        currencyButtons,
        [
          emojiButton(network.enabledClient() ? 'تغيير API Binance' : 'إعداد API Binance', PREMIUM_EMOJI.binance, { callback_data: 'adm:binance_setup', style: 'primary' }),
          { text: '🗑 حذف Binance المحلي', callback_data: 'adm:binance_clear', style: 'danger' }
        ],
        [
          { text: '📢 القناة الإجبارية', callback_data: 'adm:set:required_channel' },
          { text: '❌ إيقاف القناة', callback_data: 'adm:channel_disable' }
        ],
        [{ text: '⬅️ رجوع لإعدادات المتجر', callback_data: 'adm:menu:settings' }]
      ] }
    });
  }

  if (data === 'adm:channel_disable') {
    await setSetting('required_channel', '');
    await answerCallback(query.id, 'تم إيقاف الاشتراك الإجباري.');
    return;
  }

  if (data.startsWith('adm:set:')) {
    const key = data.split(':')[2];
    await setState(user.id, { action: 'admin_setting', key });
    await answerCallback(query.id);
    const prompts = {
      iqd_rate: 'أرسل سعر 1 دولار بالدينار:',
      egp_rate_per_usd: 'أرسل سعر 1 دولار بالجنيه المصري، مثال 50:',
      superqi_number: 'أرسل رقم SuperQi الجديد، أو - للحذف. إذا هذا بوت شريك راح يستخدم سوبركي الرئيسي تلقائياً عند الحذف:',
      required_channel: 'أرسل @معرف_القناة أو رابطها العام مثل https://t.me/mychannel. لازم تضيف البوت مشرف بالقناة حتى يقدر يتحقق من الاشتراك. أرسل - للإيقاف.',
      referral_reward_amount: 'أرسل مكافأة كل إحالة بالدولار، مثال 0.05:',
      referral_gift_target: 'أرسل عدد الأشخاص المطلوب للهدية، مثال 10:'
    };
    return bot.sendMessage(user.id, `${prompts[key] || 'أرسل القيمة الجديدة:'}\nاكتب إغلاق للإلغاء.`, {
      reply_markup: cancelInlineKeyboard()
    });
  }

  if (data.startsWith('adm:products:')) {
    await answerCallback(query.id);
    return showAdminProducts(query.message.chat.id, Number(data.split(':')[2]));
  }

  if (data === 'adm:add_product') {
    await setState(user.id, { action: 'admin_new_product', step: 'type', data: {} });
    await answerCallback(query.id);
    return bot.sendMessage(user.id, '➕ <b>إضافة منتج جديد</b>\n\nما نوع المنتج؟', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [{ text: '🔑 كود', callback_data: 'adm:newtype:code', style: 'primary' }],
        [{ text: '📧 إيميل وباسورد', callback_data: 'adm:newtype:account', style: 'primary' }],
        [{ text: '📝 منتج حر', callback_data: 'adm:newtype:free', style: 'primary' }],
        [{ text: '❌ إغلاق', callback_data: 'flow:cancel', style: 'danger' }]
      ] }
    });
  }

  if (data.startsWith('adm:newtype:')) {
    const type = data.split(':')[2];
    if (!['code', 'account', 'free'].includes(type)) return answerCallback(query.id, 'نوع غير صحيح.', true);
    const fresh = await User.findByPk(user.id);
    const state = parseState(fresh);
    if (!state || state.action !== 'admin_new_product' || state.step !== 'type') {
      return answerCallback(query.id, 'عملية إضافة المنتج غير فعالة.', true);
    }
    state.data.type = type;
    await setState(user.id, { action: 'admin_new_product', step: 'nameAr', data: state.data });
    await answerCallback(query.id, `تم اختيار: ${productTypeLabel(type)}`);
    return bot.sendMessage(user.id, '1/5 أرسل اسم المنتج بالعربي.\nتقدر تستخدم Custom Emoji Premium مباشرة، أو تكتب ID الإيموجي بين أقواس مربعة مثل: [5221980268230882832] اسم المنتج.', {
      reply_markup: cancelInlineKeyboard()
    });
  }

  if (data.startsWith('adm:edit:')) {
    await answerCallback(query.id);
    return showAdminProductEditor(query.message.chat.id, Number(data.split(':')[2]));
  }

  if (data.startsWith('adm:field:')) {
    const [, , idRaw, field] = data.split(':');
    const managedProduct = await Merchant.findByPk(Number(idRaw));
    if (!canManageNetworkProduct(managedProduct)) return answerCallback(query.id, 'هذا المنتج تابع لمتجر آخر بالشبكة ولا يمكن تعديله من هنا.', true);
    if (!['nameAr', 'price', 'descriptionAr', 'warrantyAr', 'image'].includes(field)) {
      return answerCallback(query.id, 'هذا الحقل لم يعد مستخدماً.', true);
    }
    await setState(user.id, { action: 'admin_edit_product', productId: Number(idRaw), field });
    await answerCallback(query.id);
    const prompts = {
      nameAr: 'أرسل اسم المنتج بالعربي. تقدر تستخدم Custom Emoji Premium مباشرة أو ID بين [] مثل [5221980268230882832] اسم المنتج.',
      price: 'أرسل السعر الجديد بالدولار.',
      descriptionAr: 'أرسل الوصف بالعربي، أو - للحذف. الترجمة الإنجليزية تلقائية.',
      warrantyAr: 'أرسل الضمان بالعربي، أو - للحذف. الترجمة الإنجليزية تلقائية.',
      image: 'أرسل صورة مباشرة، رابط صورة، أو - لحذف الصورة.'
    };
    return bot.sendMessage(user.id, `${prompts[field]}\nاكتب إغلاق للإلغاء.`, { reply_markup: cancelInlineKeyboard() });
  }

  if (data.startsWith('adm:type:')) {
    const [, , idRaw, type] = data.split(':');
    if (!['code', 'account', 'free'].includes(type)) return answerCallback(query.id, 'نوع غير صحيح.', true);
    const product = await Merchant.findByPk(Number(idRaw));
    if (!product) return;
    if (!canManageNetworkProduct(product)) return answerCallback(query.id, 'هذا المنتج تابع لمتجر آخر بالشبكة.', true);
    if (!network.enabledClient()) {
      const protection = await network.productStockProtection(product.id, product.networkOwnerShopId || 'master');
      if (protection.externalAvailable > 0) return answerCallback(query.id, `ما تگدر تغيّر نوع المنتج لأن بيه ${protection.externalAvailable} وحدات مخزون لأشخاص آخرين.`, true);
    }
    if (product.networkManaged && network.enabledClient()) {
      try { await network.updateRemoteProduct(product.networkProductId, { type, sharedLimit: 1, deliveryMode: 'instant' }); }
      catch (error) { return answerCallback(query.id, error.message.startsWith('STRUCTURE_LOCKED_BY_EXTERNAL_STOCK:') ? 'ما تگدر تغيّر نوع المنتج لأن بيه مخزون لأشخاص آخرين.' : error.message, true); }
    }
    product.type = type;
    product.sharedLimit = 1;
    product.deliveryMode = 'instant';
    await product.save();
    await Code.update({ maxUses: 1 }, { where: { merchantId: product.id, usedCount: 0, isUsed: false } });
    await answerCallback(query.id, `تم التحويل إلى ${productTypeLabel(type)}.`);
    return showAdminProductEditor(query.message.chat.id, product.id);
  }

  if (data.startsWith('adm:toggle:')) {
    const product = await Merchant.findByPk(Number(data.split(':')[2]));
    if (!product) return;
    if (!canManageNetworkProduct(product)) return answerCallback(query.id, 'هذا المنتج تابع لمتجر آخر بالشبكة.', true);
    const nextActive = !product.isActive;
    if (!nextActive && !network.enabledClient()) {
      const protection = await network.productStockProtection(product.id, product.networkOwnerShopId || 'master');
      if (protection.externalAvailable > 0) return answerCallback(query.id, `ما تگدر تخفي المنتج؛ بيه ${protection.externalAvailable} وحدات مخزون لأشخاص آخرين.`, true);
    }
    product.isActive = nextActive;
    if (product.networkManaged && network.enabledClient()) {
      try { await network.updateRemoteProduct(product.networkProductId, { isActive: product.isActive }); }
      catch (error) { product.isActive = !nextActive; return answerCallback(query.id, error.message.startsWith('EXTERNAL_STOCK_EXISTS:') ? 'ما تگدر تخفي المنتج لأن بيه مخزون لأشخاص آخرين.' : error.message, true); }
    }
    await product.save();
    await answerCallback(query.id, product.isActive ? 'تم النشر.' : 'تم الإخفاء.');
    return showAdminProductEditor(query.message.chat.id, product.id);
  }

  if (data.startsWith('adm:delete:')) {
    const product = await Merchant.findByPk(Number(data.split(':')[2]));
    if (!product) return;
    if (!canManageNetworkProduct(product)) return answerCallback(query.id, 'هذا المنتج تابع لمتجر آخر بالشبكة.', true);
    if (!network.enabledClient()) {
      const protection = await network.productStockProtection(product.id, product.networkOwnerShopId || 'master');
      if (protection.externalAvailable > 0) return answerCallback(query.id, `ما تگدر تحذف المنتج؛ بيه ${protection.externalAvailable} وحدات مخزون لأشخاص آخرين.`, true);
    }
    if (product.networkManaged && network.enabledClient()) {
      try { await network.deleteRemoteProduct(product.networkProductId); }
      catch (error) { return answerCallback(query.id, error.message.startsWith('EXTERNAL_STOCK_EXISTS:') ? 'ما تگدر تحذف المنتج لأن بيه مخزون لأشخاص آخرين.' : error.message, true); }
    }
    await Code.destroy({ where: { merchantId: product.id } });
    await product.destroy();
    await answerCallback(query.id, 'تم الحذف.');
    return showAdminProducts(query.message.chat.id, 0);
  }

  if (data.startsWith('adm:stockprod:')) {
    const productId = Number(data.split(':')[2]);
    const product = await Merchant.findByPk(productId);
    if (!product) return answerCallback(query.id, 'المنتج غير موجود.', true);
    if (!canContributeStock(product)) return answerCallback(query.id, 'لا يمكن إضافة مخزون لهذا المنتج.', true);
    await setState(user.id, { action: 'admin_add_stock', productId });
    await answerCallback(query.id);
    return bot.sendMessage(user.id, [
      `📦 <b>${escapeHtml(product.nameAr)}</b> — ${productTypeLabel(product.type)}`,
      '',
      stockPrompt(product),
      '',
      'المكرر ينحذف تلقائياً. اكتب إغلاق للإلغاء.'
    ].join('\n'), { parse_mode: 'HTML', reply_markup: cancelInlineKeyboard() });
  }
}

async function showReferralAdmin(chatId) {
  const settings = await getReferralSettings();
  const product = settings.giftProductId ? await Merchant.findByPk(settings.giftProductId) : null;
  const [referrals, gifts] = await Promise.all([
    Referral.count({ where: { status: 'rewarded' } }),
    GiftClaim.count({ where: { status: 'completed' } })
  ]);

  const text = [
    '🎁 <b>إدارة الهدايا والإحالة</b>',
    '',
    `نظام الإحالة: <b>${settings.enabled ? 'شغال' : 'متوقف'}</b>`,
    `مكافأة كل شخص: <b>${moneyUsd(settings.rewardAmount)}</b>`,
    `نظام الهدية: <b>${settings.giftEnabled ? 'ظاهر وشغال' : 'مخفي/متوقف'}</b>`,
    `العدد المطلوب: <b>${settings.target}</b>`,
    `منتج الهدية: <b>${escapeHtml(product?.nameAr || 'غير محدد')}</b>`,
    `إجمالي الإحالات المقبولة: <b>${referrals}</b>`,
    `الهدايا المسلّمة: <b>${gifts}</b>`,
    '',
    '🔒 هذه الإعدادات تظهر للإدارة فقط.'
  ].join('\n');

  const keyboard = [
    [
      { text: settings.enabled ? '⛔ إيقاف الإحالة' : '✅ تشغيل الإحالة', callback_data: 'adm:ref_toggle' },
      { text: settings.giftEnabled ? '🙈 إخفاء الهدية' : '👁 إظهار الهدية', callback_data: 'adm:gift_toggle' }
    ],
    [
      { text: '💵 تغيير مكافأة الشخص', callback_data: 'adm:set:referral_reward_amount' },
      { text: '🔢 تغيير العدد المطلوب', callback_data: 'adm:set:referral_gift_target' }
    ],
    [{ text: '🎁 اختيار منتج الهدية', callback_data: 'adm:ref_product' }],
    [{ text: '⬅️ رجوع للتسويق والإشعارات', callback_data: 'adm:menu:marketing' }]
  ];

  return bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function showAdminUserCard(chatId, targetId) {
  const target = await User.findByPk(targetId);
  if (!target) return bot.sendMessage(chatId, '❌ المستخدم ما فتح البوت بعد.');
  const [orders, referrals] = await Promise.all([
    PurchaseOrder.count({ where: { userId: target.id } }),
    Referral.count({ where: { referrerId: target.id, status: 'rewarded' } })
  ]);
  const text = [
    '👤 <b>إدارة المستخدم</b>',
    '',
    `الآيدي: <code>${target.id}</code>`,
    `الاسم: ${escapeHtml(target.firstName || '—')}`,
    `المعرف: ${target.username ? `@${escapeHtml(target.username)}` : '—'}`,
    `الرصيد: <b>${moneyUsd(target.balance)}</b>`,
    `الطلبات: <b>${orders}</b>`,
    `الإحالات المقبولة: <b>${referrals}</b>`,
    `التحقق: <b>${target.verified ? 'نعم' : 'لا'}</b>`,
    `الحظر: <b>${target.blocked ? 'محظور' : 'غير محظور'}</b>`
  ].join('\n');
  const keyboard = [
    [{ text: '💰 شحن الرصيد', callback_data: `adm:usercredit:${target.id}` }],
    [{ text: target.blocked ? '✅ فك الحظر' : '⛔ حظر المستخدم', callback_data: `adm:userblock:${target.id}` }],
    [{ text: '🔄 تحديث', callback_data: `adm:usercard:${target.id}` }]
  ];
  return bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
}

function productTypeLabel(type) {
  if (type === 'code') return 'كود';
  if (type === 'account') return 'إيميل وباسورد';
  if (type === 'free') return 'منتج حر';
  return String(type || 'منتج حر');
}

function stockPrompt(product) {
  if (product.type === 'code') {
    return `📥 أرسل الأكواد الآن، كل كود بسطر.\nمثال:\n<code>ABC-123\nXYZ-456</code>\n\nتقدر ترسل TXT/CSV أيضاً.`;
  }
  if (product.type === 'account') {
    return `📥 أرسل الحسابات الآن، كل حساب بسطر بصيغة:\n<code>email@example.com|password</code>\n\nتقدر ترسل TXT/CSV أيضاً.`;
  }
  return `📥 أرسل محتوى المنتج الحر، كل سطر يعتبر قطعة مستقلة تُسلّم لزبون واحد.\nيقبل كتابة، رابط، كود، بيانات أو أي نص.\nمثال:\n<code>أي محتوى تريد تسليمه</code>`;
}

async function showAdminProducts(chatId, page = 0) {
  if (network.enabledClient()) await network.syncCatalogToLocal().catch(() => {});
  const products = await Merchant.findAll({ order: [['id', 'ASC']] });
  const perPage = 8;
  const pages = Math.max(1, Math.ceil(products.length / perPage));
  const safePage = Math.max(0, Math.min(page, pages - 1));
  const keyboard = [];

  for (const product of products.slice(safePage * perPage, safePage * perPage + perPage)) {
    const stock = await getProductStock(product.id);
    keyboard.push([{
      text: `${product.nameAr} | 📦 ${stock} | ${moneyUsd(product.price)}`,
      callback_data: `adm:edit:${product.id}`,
      style: !product.isActive || stock < 1 ? 'danger' : 'success'
    }]);
  }

  keyboard.push([{ text: '➕ إضافة منتج', callback_data: 'adm:add_product', style: 'success' }]);
  const navigation = [];
  if (safePage > 0) navigation.push({ text: '⬅️', callback_data: `adm:products:${safePage - 1}` });
  navigation.push({ text: `${safePage + 1}/${pages}`, callback_data: 'noop' });
  if (safePage < pages - 1) navigation.push({ text: '➡️', callback_data: `adm:products:${safePage + 1}` });
  keyboard.push(navigation);
  keyboard.push([{ text: '⬅️ رجوع للمنتجات والمخزون', callback_data: 'adm:menu:products' }]);

  await bot.sendMessage(chatId, '📦 <b>إدارة المنتجات</b>\n🟢 متوفر  •  🔴 فارغ/مخفي', {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function showAdminProductEditor(chatId, productId) {
  const product = await Merchant.findByPk(productId);
  if (!product) return;
  const description = parseDescription(product.description);
  const stock = await getProductStock(product.id);
  const manageable = canManageNetworkProduct(product);
  const text = [
    `📝 <b>${escapeHtml(product.nameAr)}</b>`,
    '',
    `النوع: <b>${productTypeLabel(product.type)}</b>`,
    `السعر: <b>${moneyUsd(product.price)}</b>`,
    `المخزون: <b>${stock}</b>`,
    `ظهور المنتج: <b>${product.isActive ? 'ظاهر' : 'مخفي'}</b>`,
    `الترجمة الإنجليزية: <b>تلقائية</b>`,
    product.networkManaged ? `الشبكة: <b>منتج مشترك</b> — المالك: <code>${escapeHtml(product.networkOwnerShopId || 'master')}</code>` : '',
    product.networkManaged && !manageable ? '🔒 <b>قراءة فقط:</b> المنتج مضاف من متجر آخر.' : '',
    '',
    `الوصف: ${escapeHtml(description.ar || '—')}`,
    `الضمان: ${escapeHtml(description.warrantyAr || '—')}`,
    `الصورة: ${product.image ? 'موجودة' : 'بدون'}`,
    description.nameEmojiId ? '✨ Custom Emoji: محفوظة تلقائياً' : '✨ Custom Emoji: لا توجد'
  ].filter(Boolean).join('\n');

  const commonRows = [
    [{ text: '📥 إضافة مخزون لهذا المنتج', callback_data: `adm:stockprod:${product.id}`, style: 'success' }],
    [{ text: '📊 مساهمو المخزون والمبيعات', callback_data: `adm:contributors:${product.id}`, style: 'primary' }]
  ];
  const keyboard = manageable ? [
    [{ text: '✏️ الاسم', callback_data: `adm:field:${product.id}:nameAr` }, { text: '💵 السعر', callback_data: `adm:field:${product.id}:price` }],
    [{ text: '📝 الوصف', callback_data: `adm:field:${product.id}:descriptionAr` }, { text: '🛡 الضمان', callback_data: `adm:field:${product.id}:warrantyAr` }],
    [{ text: '🖼 الصورة', callback_data: `adm:field:${product.id}:image` }],
    ...commonRows,
    [{ text: product.isActive ? '🙈 إخفاء المنتج' : '👁 إظهار المنتج', callback_data: `adm:toggle:${product.id}`, style: product.isActive ? 'danger' : 'success' }],
    [{ text: '🗑 حذف المنتج', callback_data: `adm:delete:${product.id}`, style: 'danger' }],
    [{ text: '⬅️ كل المنتجات', callback_data: 'adm:products:0' }]
  ] : [
    ...commonRows,
    [{ text: '⬅️ كل المنتجات', callback_data: 'adm:products:0' }]
  ];
  await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
}

async function showStockProductList(chatId) {
  if (network.enabledClient()) await network.syncCatalogToLocal().catch(() => null);
  const products = await Merchant.findAll({ where: { isActive: true }, order: [['id', 'ASC']] });
  const keyboard = [];
  for (const product of products) {
    const stock = await getProductStock(product.id);
    keyboard.push([{
      text: `${product.nameAr} | 📦 ${stock}`,
      callback_data: `adm:stockprod:${product.id}`,
      style: stock > 0 ? 'success' : 'danger'
    }]);
  }
  if (!keyboard.length) keyboard.push([{ text: 'ماكو منتجات متاحة لإضافة مخزون', callback_data: 'adm:products:0' }]);
  keyboard.push([{ text: '⬅️ رجوع للمنتجات والمخزون', callback_data: 'adm:menu:products' }]);
  await bot.sendMessage(chatId, 'اختَر المنتج لإضافة المخزون:', { reply_markup: { inline_keyboard: keyboard } });
}

bot.onText(/^\/code_(\d+)_(.+)$/s, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  try {
    const result = await addWaitingCode(Number(match[1]), String(match[2]).trim());
    const user = await User.findByPk(result.order.userId);
    const lang = user?.lang || 'ar';
    const deliveryIdLine = result.delivery?.deliveryId
      ? `${lang === 'en' ? 'Delivery ID' : 'معرف المنتج المستلم'}: <code>${escapeHtml(result.delivery.deliveryId)}</code>\n`
      : '';
    await bot.sendMessage(result.order.userId, `${t(lang, 'delivered')} — <b>#${result.order.id}</b>\n${deliveryIdLine}${renderDelivery(result.delivery.payload, lang)}`, { parse_mode: 'HTML' });
    await bot.sendMessage(msg.chat.id, result.delivery?.deliveryId
      ? `✅ تم إرسال الكود. المعرف: <code>${escapeHtml(result.delivery.deliveryId)}</code>`
      : '✅ تم إرسال الكود.', { parse_mode: 'HTML' });
  } catch (error) {
    await bot.sendMessage(msg.chat.id, `❌ ${error.message}`);
  }
});

let networkAccountWatcherStarted = false;

async function fetchLocalNetworkAccountData() {
  if (network.isMaster()) return networkLedger.accountsForShop('master');
  if (network.enabledClient()) {
    const remote = await network.getMyAccounts();
    return remote?.accounts || { accounts: [], pendingIncoming: [], pendingOutgoing: [] };
  }
  return { accounts: [], pendingIncoming: [], pendingOutgoing: [], commerceStatus: { suspended: false, liabilityUsd: 0, thresholdUsd: Number(config.network.debtSuspendThresholdUsd || 40) } };
}

async function processNetworkNotificationEvents() {
  if (!network.isMaster() && !network.enabledClient()) return;
  const rawCursor = await getSetting('network_notification_cursor_v11', '');
  if (!rawCursor) {
    let latestId = 0;
    if (network.isMaster()) latestId = await network.latestLocalNotificationEventId();
    else latestId = Number((await network.getNotificationEvents(null))?.latestId || 0);
    await setSetting('network_notification_cursor_v11', String(latestId));
    return;
  }

  let cursor = Math.max(0, Number(rawCursor || 0));
  let events = [];
  if (network.isMaster()) events = await network.localNotificationEventsAfter(cursor);
  else events = (await network.getNotificationEvents(cursor))?.events || [];
  if (!events.length) return;

  if (network.enabledClient()) await network.syncCatalogToLocal().catch(() => null);
  const enabled = await automaticNotificationsEnabled();

  for (const event of events) {
    const eventId = Number(event.id || 0);
    try {
      const product = event.networkProductId
        ? await Merchant.findOne({ where: { networkProductId: String(event.networkProductId) } })
        : null;
      if (enabled && product?.isActive) {
        if (event.eventType === 'new_product') {
          await broadcastNewProductNotification(product, event.actorName || '');
        } else if (event.eventType === 'stock_added' && Number(event.amount || 0) > 0) {
          await broadcastStockNotification(product, Number(event.amount), event.actorName || '');
        }
      }
    } catch (error) {
      console.error(`Network notification event ${eventId}:`, error.message);
    }
    if (eventId > cursor) cursor = eventId;
  }
  await setSetting('network_notification_cursor_v11', String(cursor));
}

async function processDebtRemindersAndStatus(data) {
  const now = Date.now();
  const reminderMs = Math.max(5, Number(config.network.debtReminderMinutes || 30)) * 60 * 1000;
  const reminderThresholdUsd = Math.max(0, Number(config.network.debtReminderThresholdUsd || 15));
  let reminderTimes = {};
  try { reminderTimes = JSON.parse(await getSetting('network_debt_reminder_times_v11', '{}')); } catch { reminderTimes = {}; }
  if (!reminderTimes || typeof reminderTimes !== 'object' || Array.isArray(reminderTimes)) reminderTimes = {};

  const pendingCounterparties = new Set((data.pendingOutgoing || []).map(row => String(row.creditorShopId || '')));
  const activeKeys = new Set();
  for (const account of data.accounts || []) {
    if (account.direction !== 'owe' || Number(account.amountUsd || 0) <= 0) continue;
    const amount = Number(account.amountUsd || 0);
    // Do not bother admins with tiny balances. Debt reminders start only when
    // the open amount reaches the configured threshold (default: $15).
    if (amount + 1e-9 < reminderThresholdUsd) continue;
    const counterpartyId = String(account.counterpartyId || '');
    const key = `owe:${counterpartyId}`;
    activeKeys.add(key);
    // Once the debtor pressed "paid", reminders stop until the creditor accepts
    // or rejects. A rejection restores the balance and reminders resume.
    if (pendingCounterparties.has(counterpartyId)) continue;
    const last = Number(reminderTimes[key] || 0);
    if (now - last < reminderMs) continue;

    const text = [
      '⚠️ <b>تذكير تسوية دين</b>',
      '',
      `<b>${escapeHtml(account.counterpartyName || counterpartyId)}</b> يطلبك <b>$${amount.toFixed(2)}</b>.`,
      'يرجى تسديد الدين، وبعدها اضغط «تم التسديد». الدين ما ينغلق إلا بعد موافقة الطرف الثاني.'
    ].join('\n');
    for (const adminId of config.admins) {
      await bot.sendMessage(adminId, text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{
          text: `✅ تم التسديد — $${amount.toFixed(2)}`,
          callback_data: `adm:debt_paid:${counterpartyId}`,
          style: 'success'
        }]] }
      }).catch(() => {});
    }
    reminderTimes[key] = now;
  }
  for (const key of Object.keys(reminderTimes)) {
    if (key.startsWith('owe:') && !activeKeys.has(key)) delete reminderTimes[key];
  }
  await setSetting('network_debt_reminder_times_v11', JSON.stringify(reminderTimes));

  const status = data.commerceStatus || await currentCommerceStatus(true);
  commerceStatusCache = { at: Date.now(), value: status };
  const previous = String(await getSetting('network_debt_suspended_v11', 'false')).toLowerCase() === 'true';
  if (Boolean(status?.suspended) !== previous) {
    await setSetting('network_debt_suspended_v11', status?.suspended ? 'true' : 'false');
    const text = status?.suspended
      ? `⛔ <b>تم إيقاف البيع مؤقتاً</b>\nالالتزامات الحالية: <b>$${Number(status.liabilityUsd || 0).toFixed(2)}</b>\nحد الإيقاف: <b>$${Number(status.thresholdUsd || 40).toFixed(2)}</b>\n\nيبقى البوت متوقف عن المبيعات إلى أن يتم تسجيل التسديد ويؤكد الطرف المقابل وصول المبلغ.`
      : '✅ <b>تم فتح البيع تلقائياً</b> بعد تأكيد تسوية الدين. البوت رجع يشتغل بدون تدخل يدوي.';
    for (const adminId of config.admins) await bot.sendMessage(adminId, text, { parse_mode: 'HTML' }).catch(() => {});
  }
}

async function processIncomingDebtConfirmations(data) {
  const incoming = Array.isArray(data?.pendingIncoming) ? data.pendingIncoming : [];
  let seen = [];
  try { seen = JSON.parse(await getSetting('network_notified_debt_payment_ids', '[]')); } catch { seen = []; }
  const seenSet = new Set(Array.isArray(seen) ? seen.map(String) : []);
  let changed = false;
  for (const request of incoming) {
    if (seenSet.has(String(request.id))) continue;
    changed = true;
    seenSet.add(String(request.id));
    const text = [
      '🤝 <b>طلب تأكيد تسديد دين</b>',
      '',
      `<b>${escapeHtml(request.debtorName || request.debtorShopId)}</b> سجّل أنه سدّد لك <b>$${Number(request.amountUsd || 0).toFixed(2)}</b>.`,
      `المبلغ المثبت: <b>${Number(request.values?.settlementAmount || request.settlementAmount || request.amountUsd || 0).toFixed((request.values?.settlementCurrency || request.settlementCurrency) === 'IQD' ? 0 : 2)} ${escapeHtml(request.values?.settlementCurrency || request.settlementCurrency || 'USD')}</b>`,
      'وافق فقط إذا المبلغ وصل فعلاً.'
    ].join('\n');
    for (const adminId of config.admins) {
      await bot.sendMessage(adminId, text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[
          { text: '✅ وصل المبلغ', callback_data: `adm:debt_resolve:1:${request.id}`, style: 'success' },
          { text: '❌ ما وصل', callback_data: `adm:debt_resolve:0:${request.id}`, style: 'danger' }
        ]] }
      }).catch(() => {});
    }
  }
  if (changed) await setSetting('network_notified_debt_payment_ids', JSON.stringify([...seenSet].slice(-300)));
}

function startNetworkAccountWatcher() {
  if (networkAccountWatcherStarted || (!network.isMaster() && !network.enabledClient())) return;
  networkAccountWatcherStarted = true;
  const poll = async () => {
    try {
      await processNetworkNotificationEvents();
      const data = await fetchLocalNetworkAccountData();
      await processIncomingDebtConfirmations(data);
      await processDebtRemindersAndStatus(data);
    } catch (error) {
      console.error('Network watcher:', error.message);
    }
  };
  poll().catch(error => console.error('Initial network watcher:', error.message));
  setInterval(poll, 30000).unref?.();
}

bot.on('polling_error', error => console.error('Telegram polling error:', error.message));

module.exports = { bot, notifyBinanceResult, sendDeliveryToUser, startNetworkAccountWatcher };
