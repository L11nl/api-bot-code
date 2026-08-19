const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const config = require('./config');
const {
  sequelize,
  Op,
  User,
  Merchant,
  Code,
  PurchaseOrder,
  BalanceTransaction,
  BinanceTransfer,
  SupportTicket,
  Referral,
  GiftClaim,
  getIqdRate,
  getSuperQiNumber,
  getSetting,
  setSetting
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
const virtualNumbers = require('./services/virtualNumbers');

const bot = new TelegramBot(config.token, { polling: false });
const captchaAnswers = new Map();
const memoryRate = new Map();
let cachedBotUsername = '';

function isAdmin(id) {
  return config.admins.has(Number(id));
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
    '📢 قناتنا', '📢 Our channel',
    '📱 شراء رقم افتراضي', '📱 Buy virtual number'
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

function mainKeyboard(lang, showReferrals = true, showChannel = false, showVirtualNumbers = false) {
  const keyboard = [
    [{ text: t(lang, 'products') }, { text: t(lang, 'support') }],
    [{ text: t(lang, 'wallet'), style: 'primary' }, { text: t(lang, 'orders') }]
  ];
  if (showVirtualNumbers) keyboard.push([{ text: lang === 'en' ? '📱 Buy virtual number' : '📱 شراء رقم افتراضي' }]);
  if (showReferrals) keyboard.push([{ text: lang === 'en' ? '🎁 Gifts & referrals' : '🎁 الهدايا والمشاركة' }]);
  if (showChannel) keyboard.push([{ text: lang === 'en' ? '📢 Our channel' : '📢 قناتنا' }]);
  keyboard.push([{ text: t(lang, 'language') }]);
  return {
    keyboard,
    resize_keyboard: true,
    is_persistent: true
  };
}

async function getMainKeyboard(lang) {
  const [settings, channel, showVirtualNumbers] = await Promise.all([
    getReferralSettings(),
    getRequiredChannel(),
    virtualNumbers.hasAnyConfiguredProvider()
  ]);
  return mainKeyboard(lang, settings.enabled, Boolean(channel), showVirtualNumbers);
}

async function automaticNotificationsEnabled() {
  return String(await getSetting('automatic_notifications_enabled', 'true')).toLowerCase() !== 'false';
}

async function adminMenu() {
  const notificationsEnabled = await automaticNotificationsEnabled();
  return {
    inline_keyboard: [
      [{ text: '➕ إضافة منتج', callback_data: 'adm:add_product', style: 'success' }],
      [{ text: '📦 المنتجات وإدارتها', callback_data: 'adm:products:0', style: 'primary' }],
      [{ text: '🧾 الطلبات', callback_data: 'adm:orders' }, { text: '💳 دفعات SuperQi', callback_data: 'adm:proofs' }],
      [{ text: '👤 إدارة مستخدم', callback_data: 'adm:user_lookup' }, { text: '💰 شحن مستخدم', callback_data: 'adm:user_credit' }],
      [{ text: '💬 الدعم', callback_data: 'adm:support' }, { text: '📣 إرسال إعلان', callback_data: 'adm:broadcast' }],
      [{ text: notificationsEnabled ? '🔔 الإشعارات: تشغيل' : '🔕 الإشعارات: إيقاف', callback_data: 'adm:notifications_toggle', style: notificationsEnabled ? 'success' : 'danger' }],
      [{ text: '📱 مواقع الأرقام', callback_data: 'adm:vnum', style: 'primary' }],
      [{ text: '🎁 الإحالات والهدايا', callback_data: 'adm:referrals' }, { text: '📢 القناة', callback_data: 'adm:channel' }],
      [{ text: '⚙️ إعدادات المتجر', callback_data: 'adm:settings', style: 'primary' }, { text: '🔐 فتح/إغلاق', callback_data: 'adm:store_toggle' }]
    ]
  };
}


function virtualText(lang, ar, en) {
  return lang === 'en' ? en : ar;
}

const VIRTUAL_SERVICE_NAMES_AR = new Map([
  ['wa', 'واتساب'], ['whatsapp', 'واتساب'],
  ['tg', 'تيليجرام'], ['telegram', 'تيليجرام'],
  ['ig', 'إنستغرام'], ['instagram', 'إنستغرام'],
  ['fb', 'فيسبوك'], ['facebook', 'فيسبوك'],
  ['go', 'Google'], ['google', 'Google'],
  ['tt', 'تيك توك'], ['tiktok', 'تيك توك'],
  ['ds', 'ديسكورد'], ['discord', 'ديسكورد'],
  ['tw', 'X / تويتر'], ['twitter', 'X / تويتر'],
  ['tk', 'تيك توك'], ['vi', 'فايبر'], ['vb', 'فايبر'],
  ['ub', 'أوبر'], ['uber', 'أوبر'], ['am', 'أمازون'], ['amazon', 'أمازون']
]);

const VIRTUAL_POPULAR = ['wa', 'tg', 'ig', 'fb', 'go', 'tt', 'tk', 'ds', 'tw', 'ub', 'am'];

function normalizeVirtualSearch(value) {
  return String(value || '')
    .trim().toLowerCase().normalize('NFKD')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function virtualServiceDisplayName(service, lang = 'ar') {
  const code = String(service?.code || '').trim().toLowerCase();
  const raw = String(service?.name || service?.code || '').trim();
  if (lang === 'en') return raw.length > 44 ? `${raw.slice(0, 41)}…` : raw;
  const byCode = VIRTUAL_SERVICE_NAMES_AR.get(code);
  if (byCode) return byCode;
  const normalized = normalizeVirtualSearch(raw);
  for (const [key, value] of VIRTUAL_SERVICE_NAMES_AR) {
    if (normalized === normalizeVirtualSearch(key) || normalized.includes(normalizeVirtualSearch(key))) return value;
  }
  return raw.length > 44 ? `${raw.slice(0, 41)}…` : raw;
}

function sortVirtualServices(rows) {
  const rank = new Map(VIRTUAL_POPULAR.map((code, index) => [code, index]));
  return [...rows].sort((a, b) => {
    const aa = rank.has(String(a.code).toLowerCase()) ? rank.get(String(a.code).toLowerCase()) : 999;
    const bb = rank.has(String(b.code).toLowerCase()) ? rank.get(String(b.code).toLowerCase()) : 999;
    return aa - bb || String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' });
  });
}

async function showVirtualProviderMenu(chatId, user) {
  const providers = await virtualNumbers.getConfiguredProviders();
  if (!providers.length) {
    return bot.sendMessage(chatId, virtualText(user.lang,
      '❌ خدمة الأرقام غير متوفرة حالياً.',
      '❌ Virtual numbers are not available right now.'), { reply_markup: await getMainKeyboard(user.lang) });
  }
  return bot.sendMessage(chatId, virtualText(user.lang, '📱 <b>اختر الخدمة</b>', '📱 <b>Choose a service</b>'), {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: providers.map((provider, index) => [{
        text: user.lang === 'en' ? provider.publicLabelEn : provider.publicLabelAr,
        callback_data: `vn:p:${provider.id}`,
        style: index === 0 ? 'success' : 'primary'
      }])
    }
  });
}

async function showVirtualServices(chatId, user, providerId, page = 0, filteredServices = null) {
  const publicProvider = await virtualNumbers.getPublicProvider(providerId);
  if (!publicProvider) return showVirtualProviderMenu(chatId, user);
  const [allServices, summary] = await Promise.all([
    virtualNumbers.listServices(providerId),
    virtualNumbers.availableServicesSummary(providerId, true)
  ]);
  const available = new Set(summary.filter(row => Number(row.count) > 0).map(row => String(row.serviceCode)));
  let services = (filteredServices || allServices).filter(row => available.has(String(row.code)));
  services = sortVirtualServices(services);
  if (!services.length) {
    return bot.sendMessage(chatId, virtualText(user.lang,
      'حالياً ماكو خدمات بيها أرقام متوفرة بهذا الموقع.',
      'There are no services with available numbers on this provider right now.'), {
      reply_markup: { inline_keyboard: [[{ text: virtualText(user.lang, '⬅️ الخدمات', '⬅️ Services'), callback_data: 'vn:home' }]] }
    });
  }
  const perPage = 10;
  const maxPage = Math.max(0, Math.ceil(services.length / perPage) - 1);
  const safePage = Math.max(0, Math.min(maxPage, Number(page) || 0));
  const pageRows = services.slice(safePage * perPage, safePage * perPage + perPage);
  const keyboard = pageRows.map(service => [{
    text: virtualServiceDisplayName(service, user.lang),
    callback_data: `vn:s:${providerId}:${service.code}`,
    style: 'primary'
  }]);
  const nav = [];
  if (safePage > 0) nav.push({ text: '⬅️', callback_data: `vn:sp:${providerId}:${safePage - 1}` });
  if (safePage < maxPage) nav.push({ text: '➡️', callback_data: `vn:sp:${providerId}:${safePage + 1}` });
  if (nav.length) keyboard.push(nav);
  keyboard.push([{ text: virtualText(user.lang, '🔎 بحث عن خدمة', '🔎 Search service'), callback_data: `vn:search:${providerId}` }]);
  keyboard.push([{ text: virtualText(user.lang, '⬅️ تغيير الخدمة', '⬅️ Change provider'), callback_data: 'vn:home' }]);
  return bot.sendMessage(chatId, virtualText(user.lang,
    `📱 <b>${publicProvider.publicLabelAr}</b>\n\nاختر التطبيق المطلوب. تظهر فقط التطبيقات اللي بيها أرقام متوفرة حالياً.`,
    `📱 <b>${publicProvider.publicLabelEn}</b>\n\nChoose the app. Only apps with live number availability are shown.`), {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard }
  });
}

async function showVirtualCountries(chatId, user, providerId, serviceCode, page = 0) {
  const publicProvider = await virtualNumbers.getPublicProvider(providerId);
  if (!publicProvider) return showVirtualProviderMenu(chatId, user);
  const services = await virtualNumbers.listServices(providerId);
  const service = services.find(row => String(row.code) === String(serviceCode));
  if (!service) return showVirtualServices(chatId, user, providerId, 0);
  const availability = await virtualNumbers.availabilityForService(providerId, serviceCode, true);
  if (!availability.length) return showVirtualServices(chatId, user, providerId, 0);
  const perPage = 10;
  const maxPage = Math.max(0, Math.ceil(availability.length / perPage) - 1);
  const safePage = Math.max(0, Math.min(maxPage, Number(page) || 0));
  const rows = availability.slice(safePage * perPage, safePage * perPage + perPage);
  const keyboard = rows.map(row => [{
    text: `${row.countryName} • ${moneyUsd(row.retailPrice)}`,
    callback_data: `vn:q:${providerId}:${serviceCode}:${row.countryId}`,
    style: 'success'
  }]);
  const nav = [];
  if (safePage > 0) nav.push({ text: '⬅️', callback_data: `vn:cp:${providerId}:${serviceCode}:${safePage - 1}` });
  if (safePage < maxPage) nav.push({ text: '➡️', callback_data: `vn:cp:${providerId}:${serviceCode}:${safePage + 1}` });
  if (nav.length) keyboard.push(nav);
  keyboard.push([{ text: virtualText(user.lang, '⬅️ التطبيقات', '⬅️ Apps'), callback_data: `vn:p:${providerId}` }]);
  return bot.sendMessage(chatId, virtualText(user.lang,
    `📲 التطبيق: <b>${escapeHtml(virtualServiceDisplayName(service, user.lang))}</b>\nاختر الدولة والسعر المناسب:`,
    `📲 App: <b>${escapeHtml(virtualServiceDisplayName(service, user.lang))}</b>\nChoose a country and price:`), {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard }
  });
}

async function showVirtualQuote(chatId, user, providerId, serviceCode, countryId) {
  const [publicProvider, services, quote, freshUser] = await Promise.all([
    virtualNumbers.getPublicProvider(providerId),
    virtualNumbers.listServices(providerId),
    virtualNumbers.quote(providerId, serviceCode, countryId, true),
    User.findByPk(user.id)
  ]);
  if (!publicProvider) return showVirtualProviderMenu(chatId, user);
  const service = services.find(row => String(row.code) === String(serviceCode));
  if (!service || !quote || quote.count < 1) return showVirtualCountries(chatId, user, providerId, serviceCode, 0);
  const cents = Math.round(Number(quote.retailPrice) * 100);
  return bot.sendMessage(chatId, virtualText(user.lang,
    [
      '📱 <b>تأكيد شراء الرقم</b>',
      `الخدمة: <b>${escapeHtml(publicProvider.publicLabelAr)}</b>`,
      `التطبيق: <b>${escapeHtml(virtualServiceDisplayName(service, 'ar'))}</b>`,
      `الدولة: <b>${escapeHtml(quote.countryName)}</b>`,
      `السعر: <b>${moneyUsd(quote.retailPrice)}</b>`,
      `رصيدك: <b>${moneyUsd(freshUser?.balance || 0)}</b>`,
      '',
      '⏱ الرقم يبقى فعال لمدة 10 دقائق بانتظار الكود.'
    ].join('\n'),
    [
      '📱 <b>Confirm number purchase</b>',
      `Service: <b>${escapeHtml(publicProvider.publicLabelEn)}</b>`,
      `App: <b>${escapeHtml(virtualServiceDisplayName(service, 'en'))}</b>`,
      `Country: <b>${escapeHtml(quote.countryName)}</b>`,
      `Price: <b>${moneyUsd(quote.retailPrice)}</b>`,
      `Balance: <b>${moneyUsd(freshUser?.balance || 0)}</b>`,
      '',
      '⏱ The number stays active for 10 minutes while waiting for the code.'
    ].join('\n')), {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [
      [{ text: virtualText(user.lang, '✅ شراء الآن', '✅ Buy now'), callback_data: `vn:b:${providerId}:${serviceCode}:${countryId}:${cents}`, style: 'success' }],
      [{ text: virtualText(user.lang, '⬅️ رجوع', '⬅️ Back'), callback_data: `vn:s:${providerId}:${serviceCode}` }]
    ] }
  });
}

function virtualNumberStatusLabel(status, lang) {
  const ar = { reserving: 'جاري الحجز', waiting_sms: 'بانتظار الكود', completed: 'مكتمل', cancelled: 'ملغي', auto_cancelled: 'انتهت المهلة', provider_cancelled: 'ألغاه الموقع', failed: 'فشل' };
  const en = { reserving: 'Reserving', waiting_sms: 'Waiting for code', completed: 'Completed', cancelled: 'Cancelled', auto_cancelled: 'Timed out', provider_cancelled: 'Provider cancelled', failed: 'Failed' };
  return (lang === 'en' ? en : ar)[status] || status;
}

async function showVirtualOrders(chatId, user) {
  const orders = await virtualNumbers.listUserOrders(user.id, 10);
  if (!orders.length) return bot.sendMessage(chatId, virtualText(user.lang, '🧾 ما عندك طلبات أرقام بعد.', '🧾 You have no virtual-number orders yet.'));
  const lines = [virtualText(user.lang, '🧾 <b>آخر طلبات الأرقام</b>', '🧾 <b>Latest virtual-number orders</b>'), ''];
  for (const order of orders) {
    lines.push(`#${order.id} • ${escapeHtml(order.serviceName)} • ${escapeHtml(order.countryName)}`);
    lines.push(`📞 <code>${escapeHtml(order.phoneNumber || '—')}</code> • ${escapeHtml(virtualNumberStatusLabel(order.status, user.lang))} • ${moneyUsd(order.salePriceUsd)}`);
    if (order.smsCode) lines.push(`🔐 <code>${escapeHtml(order.smsCode)}</code>`);
    lines.push('');
  }
  return bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
}

function virtualNumberErrorText(error, lang = 'ar') {
  const code = String(error?.code || error?.message || 'UNKNOWN');
  const ar = {
    PROVIDER_NOT_CONFIGURED: 'هذه الخدمة غير مفعلة حالياً.',
    BAD_KEY: 'مفتاح API غير صحيح.',
    PROVIDER_UNAVAILABLE: 'الموقع غير متاح مؤقتاً، جرّب بعد قليل.',
    NO_SERVICES_AVAILABLE: 'ماكو تطبيقات متوفرة حالياً.',
    NO_COUNTRIES_AVAILABLE: 'ماكو دول متوفرة حالياً.',
    NO_NUMBERS: 'نفد هذا الخيار للتو. تم تحديث القائمة.',
    NO_NUMBER: 'نفد هذا الخيار للتو. تم تحديث القائمة.',
    NO_BALANCE: 'رصيد موقع الأرقام غير كافي.',
    INSUFFICIENT_BALANCE: 'رصيد محفظتك غير كافي.',
    PRICE_CHANGED: 'السعر تغير، تم تحديث السعر قبل الشراء.',
    PURCHASE_IN_PROGRESS: 'عندك عملية شراء جارية، انتظر لحظة.',
    EARLY_CANCEL_DENIED: 'الموقع يسمح بالإلغاء بعد مرور دقيقتين من شراء الرقم.',
    CANCEL_NOT_CONFIRMED: 'الموقع ما أكد الإلغاء بعد. جرّب مرة ثانية.',
    ORDER_ALREADY_COMPLETED: 'الكود وصل لهذا الرقم بالفعل وما يگدر ينلغي.',
    ORDER_NOT_FOUND: 'الطلب غير موجود.',
    ACTIVE_ORDERS: 'ما تگدر تحذف API حالياً لأن أكو أرقام فعالة بانتظار الكود.',
    INVALID_PROFIT: 'قيمة الربح غير صحيحة.',
    UNKNOWN_PROVIDER: 'الموقع غير معروف.'
  };
  const en = {
    PROVIDER_NOT_CONFIGURED: 'This service is not enabled right now.', BAD_KEY: 'Invalid API key.', PROVIDER_UNAVAILABLE: 'Provider is temporarily unavailable.',
    NO_SERVICES_AVAILABLE: 'No apps are available right now.', NO_COUNTRIES_AVAILABLE: 'No countries are available right now.',
    NO_NUMBERS: 'That option just sold out. The list was refreshed.', NO_NUMBER: 'That option just sold out. The list was refreshed.',
    NO_BALANCE: 'The provider account balance is too low.', INSUFFICIENT_BALANCE: 'Your wallet balance is too low.', PRICE_CHANGED: 'The price changed and was refreshed before purchase.',
    PURCHASE_IN_PROGRESS: 'You already have a purchase in progress.', EARLY_CANCEL_DENIED: 'The provider allows cancellation after two minutes.',
    CANCEL_NOT_CONFIRMED: 'The provider has not confirmed cancellation yet.', ORDER_ALREADY_COMPLETED: 'The code already arrived, so this number cannot be cancelled.', ORDER_NOT_FOUND: 'Order not found.', ACTIVE_ORDERS: 'This API cannot be removed while there are active numbers waiting for SMS.', INVALID_PROFIT: 'Invalid profit value.', UNKNOWN_PROVIDER: 'Unknown provider.'
  };
  return (lang === 'en' ? en[code] : ar[code]) || virtualText(lang, `خطأ بخدمة الأرقام: ${code}`, `Virtual-number error: ${code}`);
}

async function showVirtualNumberAdmin(chatId) {
  const rows = await virtualNumbers.getAllProviderAdminRows();
  const lines = ['📱 <b>إدارة مواقع الأرقام</b>', '', 'كل موقع مستقل: API وربح وطلبات خاصة بيه.', 'الربح الافتراضي لكل موقع: <b>$0.15</b>.', ''];
  for (const row of rows) {
    lines.push(`<b>${escapeHtml(row.adminName)}</b>`);
    lines.push(`API: <b>${row.configured ? '✅ مضاف' : '❌ غير مضاف'}</b>`);
    lines.push(`الربح لكل رقم: <b>${moneyUsd(row.profit)}</b>`);
    lines.push(`الشراء: <b>${row.purchased}</b> | المكتمل: <b>${row.completed}</b> | النشط: <b>${row.active}</b>`);
    if (row.rank) lines.push(`ترتيبه للزبون: <b>${escapeHtml(row.publicLabelAr)}</b>`);
    lines.push('');
  }
  lines.push('إذا ماكو API مضاف بأي موقع، زر «📱 شراء رقم افتراضي» يختفي من المستخدمين تلقائياً.');
  return bot.sendMessage(chatId, lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [
      [{ text: '🔑 API — SMSBower', callback_data: 'adm:vnum_api:smsbower' }, { text: '💰 الربح', callback_data: 'adm:vnum_profit:smsbower' }],
      [{ text: '🔑 API — SMS-MAN', callback_data: 'adm:vnum_api:smsman' }, { text: '💰 الربح', callback_data: 'adm:vnum_profit:smsman' }],
      [{ text: '🧪 فحص SMSBower', callback_data: 'adm:vnum_test:smsbower' }, { text: '🧪 فحص SMS-MAN', callback_data: 'adm:vnum_test:smsman' }],
      [{ text: '⬅️ لوحة الأدمن', callback_data: 'adm:home' }]
    ] }
  });
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

function productCaption(product, stock, lang) {
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

function productButton(product, stock, lang) {
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
  const keyboard = rows.map(({ product, stock }) => [productButton(product, stock, lang)]);
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
  const stock = await getProductStock(product.id);
  const caption = productCaption(product, stock, user.lang);
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

async function broadcastStockNotification(product, added) {
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
          inline_keyboard: [[{
            text: lang === 'en' ? '🛍️ View product' : '🛍️ عرض المنتج',
            callback_data: `prod:${product.id}`,
            style: 'success'
          }]]
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

async function broadcastNewProductNotification(product) {
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
    const message = lang === 'en'
      ? `🆕 <b>New product</b>

<b>${escapeHtml(name)}</b>
Price: <b>${moneyUsd(product.price)}</b>`
      : `🆕 <b>منتج جديد</b>

<b>${escapeHtml(name)}</b>
السعر: <b>${moneyUsd(product.price)}</b>`;
    try {
      await bot.sendMessage(target.id, message, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{
            text: lang === 'en' ? '🛍️ View product' : '🛍️ عرض المنتج',
            callback_data: `prod:${product.id}`,
            style: stock > 0 ? 'success' : 'danger'
          }]]
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
        '💬 <b>رسالة دعم جديدة</b>',
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
  return bot.sendMessage(chatId, '💬 محادثات الدعم المفتوحة:', {
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
    await bot.sendMessage(userId, renderDelivery(delivery.payload, lang), { parse_mode: 'HTML' });
  }
  if ((fulfillment.deliveries || []).some(delivery => delivery.waitingCode)) {
    await bot.sendMessage(userId, t(lang, 'waitingCode'));
    await notifyAdmins(`🔐 الطلب #${order.id} ينتظر كود.\nأرسل: <code>/code_${order.id}_123456</code>`);
  }
  const shared = adminSharedDetails(fulfillment);
  await notifyAdmins([
    `✅ تم تسليم الطلب <b>#${order.id}</b>`,
    `المستخدم: <code>${order.userId}</code>`,
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
    const text = lang === 'en'
      ? `✅ Wallet credited through Binance${manual ? ' after admin verification' : ''}.\nAmount: <b>${moneyUsd(result.amount)}</b>\nNew balance: <b>${moneyUsd(result.newBalance)}</b>`
      : `✅ تم شحن محفظتك عبر Binance${manual ? ' بعد تحقق الإدارة' : ' تلقائياً'}.\nالمبلغ: <b>${moneyUsd(result.amount)}</b>\nالرصيد الجديد: <b>${moneyUsd(result.newBalance)}</b>`;
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
    '🟡 <b>Binance يحتاج تحقق يدوي</b>',
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
      return bot.sendMessage(msg.chat.id, '👑 <b>لوحة إدارة المالك</b>\nهذه اللوحة لا تظهر للمستخدمين.', {
        parse_mode: 'HTML',
        reply_markup: await adminMenu()
      });
    }

    if (isCancelText(msg.text)) {
      const state = parseState(user);
      if (state?.action === 'support_chat' && state.ticketId) {
        await SupportTicket.update({ status: 'closed', closedAt: new Date() }, { where: { id: state.ticketId, userId: user.id } });
      }
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
      if (!isAdmin(user.id) && !(await isStoreOpen())) return bot.sendMessage(msg.chat.id, '🔒 المتجر مغلق مؤقتاً.');
      return showProducts(msg.chat.id, user, 0);
    }

    if (msg.text === '📱 شراء رقم افتراضي' || msg.text === '📱 Buy virtual number') {
      if (!isAdmin(user.id) && !(await isStoreOpen())) return bot.sendMessage(msg.chat.id, '🔒 المتجر مغلق مؤقتاً.');
      if (!(await virtualNumbers.hasAnyConfiguredProvider())) return showMain(msg.chat.id, user);
      return showVirtualProviderMenu(msg.chat.id, user);
    }

    if (msg.text === t('ar', 'wallet') || msg.text === t('en', 'wallet')) {
      if (!isAdmin(user.id) && !(await isStoreOpen())) return bot.sendMessage(msg.chat.id, '🔒 المتجر مغلق مؤقتاً.');
      const fresh = await User.findByPk(user.id);
      const inline = [];
      if (binancePay.configured()) inline.push([{ text: '🟡 شحن Binance ID', callback_data: 'topup:binance', style: 'primary' }]);
      inline.push([{ text: '🔵 شحن SuperQi', callback_data: 'topup:superqi', style: 'primary' }]);
      return bot.sendMessage(msg.chat.id, `${t(user.lang, 'walletBalance')}: <b>${moneyUsd(fresh.balance)}</b>`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: inline }
      });
    }

    if (msg.text === t('ar', 'orders') || msg.text === t('en', 'orders')) return showOrders(msg.chat.id, user);

    if (msg.text === t('ar', 'support') || msg.text === t('en', 'support')) {
      const ticket = await getOrCreateSupportTicket(user.id);
      await setState(user.id, { action: 'support_chat', ticketId: ticket.id });
      return bot.sendMessage(msg.chat.id, user.lang === 'en'
        ? '💬 Send your message, photo, or file here. Support will reply through this bot.\nSend /cancel to close.'
        : '💬 أرسل رسالتك أو صورتك أو ملفك هنا، والدعم يرد عليك من نفس البوت.\nاكتب إغلاق أو /cancel لإنهاء المحادثة.', {
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
      if (!isAdmin(user.id) && !(await isStoreOpen())) return answerCallback(query.id, 'المتجر مغلق مؤقتاً.', true);
      await answerCallback(query.id);
      return showProducts(query.message.chat.id, user, Number(data.split(':')[1]));
    }
    if (data.startsWith('prod:')) {
      if (!isAdmin(user.id) && !(await isStoreOpen())) return answerCallback(query.id, 'المتجر مغلق مؤقتاً.', true);
      await answerCallback(query.id);
      return showProduct(query.message.chat.id, user, Number(data.split(':')[1]));
    }
    if (data.startsWith('buy:')) {
      if (!isAdmin(user.id) && !(await isStoreOpen())) return answerCallback(query.id, 'المتجر مغلق مؤقتاً.', true);
      return handleBuy(query, user, Number(data.split(':')[1]));
    }
    if (data.startsWith('qty:')) return handleQuantity(query, user, data);
    if (data.startsWith('pay:')) return handlePayment(query, user, data);
    if (data.startsWith('topup:')) return handleTopupStart(query, user, data.split(':')[1]);
    if (data.startsWith('order:')) return showOrder(query.message.chat.id, user, Number(data.split(':')[1]), query.id);

    if (data.startsWith('sq:approve:') || data.startsWith('sq:reject:')) return handleSuperQiAdmin(query, data);
    if (data.startsWith('sqtop:approve:') || data.startsWith('sqtop:reject:')) return handleSuperQiTopupAdmin(query, data);
    if (data.startsWith('binmanual:approve:') || data.startsWith('binmanual:reject:')) return handleBinanceManualAdmin(query, data);
    if (data.startsWith('vn:')) return handleVirtualNumberCallback(query, user, data);

    if (data.startsWith('adm:')) {
      if (!isAdmin(user.id)) return answerCallback(query.id, t(user.lang, 'adminOnly'), true);
      return handleAdminCallback(query, user, data);
    }
  } catch (error) {
    console.error('Callback error:', error);
    await answerCallback(query.id, `خطأ: ${error.message}`, true);
  }
});


async function handleVirtualNumberCallback(query, user, data) {
  if (data === 'vn:home') {
    await answerCallback(query.id);
    return showVirtualProviderMenu(query.message.chat.id, user);
  }

  if (data.startsWith('vn:p:')) {
    const providerId = String(data.split(':')[2] || '');
    await answerCallback(query.id, virtualText(user.lang, 'جاري تحميل التطبيقات…', 'Loading apps…'));
    try { return await showVirtualServices(query.message.chat.id, user, providerId, 0); }
    catch (error) { return bot.sendMessage(user.id, `❌ ${virtualNumberErrorText(error, user.lang)}`); }
  }

  if (data.startsWith('vn:sp:')) {
    const [, , providerId, pageRaw] = data.split(':');
    await answerCallback(query.id);
    return showVirtualServices(query.message.chat.id, user, providerId, Number(pageRaw || 0));
  }

  if (data.startsWith('vn:search:')) {
    const providerId = String(data.split(':')[2] || '');
    if (!(await virtualNumbers.getPublicProvider(providerId))) return answerCallback(query.id, virtualText(user.lang, 'الخدمة مو مفعلة.', 'Service is not enabled.'), true);
    await setState(user.id, { action: 'virtual_number_search', providerId });
    await answerCallback(query.id);
    return bot.sendMessage(user.id, virtualText(user.lang,
      '🔎 أرسل اسم التطبيق بالعربي أو بالإنجليزي، أو رمز الخدمة. مثال: واتساب، WhatsApp، Telegram، tg.',
      '🔎 Send the app name in Arabic or English, or its service code. Example: WhatsApp, Telegram, tg.'), { reply_markup: cancelInlineKeyboard() });
  }

  if (data.startsWith('vn:s:')) {
    const [, , providerId, serviceCode] = data.split(':');
    await answerCallback(query.id, virtualText(user.lang, 'جاري تحديث الدول…', 'Refreshing countries…'));
    try { return await showVirtualCountries(query.message.chat.id, user, providerId, serviceCode, 0); }
    catch (error) { return bot.sendMessage(user.id, `❌ ${virtualNumberErrorText(error, user.lang)}`); }
  }

  if (data.startsWith('vn:cp:')) {
    const [, , providerId, serviceCode, pageRaw] = data.split(':');
    await answerCallback(query.id);
    try { return await showVirtualCountries(query.message.chat.id, user, providerId, serviceCode, Number(pageRaw || 0)); }
    catch (error) { return bot.sendMessage(user.id, `❌ ${virtualNumberErrorText(error, user.lang)}`); }
  }

  if (data.startsWith('vn:q:')) {
    const [, , providerId, serviceCode, countryId] = data.split(':');
    await answerCallback(query.id, virtualText(user.lang, 'جاري فحص السعر…', 'Checking price…'));
    try { return await showVirtualQuote(query.message.chat.id, user, providerId, serviceCode, countryId); }
    catch (error) { return bot.sendMessage(user.id, `❌ ${virtualNumberErrorText(error, user.lang)}`); }
  }

  if (data.startsWith('vn:b:')) {
    if (!isAdmin(user.id) && !(await isStoreOpen())) return answerCallback(query.id, 'المتجر مغلق مؤقتاً.', true);
    const [, , providerId, serviceCode, countryId, centsRaw] = data.split(':');
    const expectedRetailCents = Number(centsRaw || 0);
    await answerCallback(query.id, virtualText(user.lang, 'جاري شراء الرقم…', 'Purchasing number…'));
    try {
      const [services, currentQuote, publicProvider] = await Promise.all([
        virtualNumbers.listServices(providerId),
        virtualNumbers.quote(providerId, serviceCode, countryId, true),
        virtualNumbers.getPublicProvider(providerId)
      ]);
      const service = services.find(row => String(row.code) === String(serviceCode));
      if (!service || !currentQuote || !publicProvider) throw Object.assign(new Error('NO_NUMBERS'), { code: 'NO_NUMBERS' });
      const order = await virtualNumbers.purchase({
        providerId,
        userId: user.id,
        serviceCode,
        serviceName: service.name,
        countryId,
        countryName: currentQuote.countryName,
        expectedRetailCents
      });
      return bot.sendMessage(user.id, virtualText(user.lang,
        [
          '✅ <b>تم شراء الرقم بنجاح</b>',
          `📱 الخدمة: <b>${escapeHtml(publicProvider.publicLabelAr)}</b>`,
          `📲 التطبيق: <b>${escapeHtml(virtualServiceDisplayName(service, 'ar'))}</b>`,
          `🌍 الدولة: <b>${escapeHtml(currentQuote.countryName)}</b>`,
          `💵 تم خصم: <b>${moneyUsd(order.salePriceUsd)}</b>`,
          `📞 الرقم: <code>${escapeHtml(order.phoneNumber)}</code>`,
          `🆔 الطلب: <code>#${order.id}</code>`,
          '',
          '⏳ جاري انتظار كود SMS…',
          '⏱ إذا ما وصل الكود خلال 10 دقائق، ينلغي الرقم تلقائياً ويرجع المبلغ لمحفظتك.'
        ].join('\n'),
        [
          '✅ <b>Number purchased successfully</b>',
          `📱 Service: <b>${escapeHtml(publicProvider.publicLabelEn)}</b>`,
          `📲 App: <b>${escapeHtml(virtualServiceDisplayName(service, 'en'))}</b>`,
          `🌍 Country: <b>${escapeHtml(currentQuote.countryName)}</b>`,
          `💵 Charged: <b>${moneyUsd(order.salePriceUsd)}</b>`,
          `📞 Number: <code>${escapeHtml(order.phoneNumber)}</code>`,
          `🆔 Order: <code>#${order.id}</code>`,
          '',
          '⏳ Waiting for the SMS code…',
          '⏱ If no code arrives within 10 minutes, the number is cancelled automatically and the amount is returned to your wallet.'
        ].join('\n')), {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: virtualText(user.lang, '❌ إلغاء الرقم واسترداد الرصيد', '❌ Cancel & refund'), callback_data: `vn:cancel:${order.id}`, style: 'danger' }],
          [{ text: virtualText(user.lang, '🧾 طلباتي', '🧾 My orders'), callback_data: 'vn:orders' }]
        ] }
      });
    } catch (error) {
      if (['NO_NUMBERS', 'NO_NUMBER'].includes(String(error.code || ''))) {
        return showVirtualCountries(user.id, user, providerId, serviceCode, 0);
      }
      if (error.code === 'PRICE_CHANGED' && error.quote) {
        await bot.sendMessage(user.id, `ℹ️ ${virtualNumberErrorText(error, user.lang)}`);
        return showVirtualQuote(user.id, user, providerId, serviceCode, countryId);
      }
      if (error.code === 'INSUFFICIENT_BALANCE') {
        return bot.sendMessage(user.id, virtualText(user.lang,
          `❌ رصيدك غير كافي.\nالمطلوب: <b>${moneyUsd(error.required || 0)}</b>\nرصيدك: <b>${moneyUsd(error.balance || 0)}</b>`,
          `❌ Your balance is insufficient.\nRequired: <b>${moneyUsd(error.required || 0)}</b>\nBalance: <b>${moneyUsd(error.balance || 0)}</b>`), {
          parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: virtualText(user.lang, '💳 افتح المحفظة', '💳 Open wallet'), callback_data: 'vn:wallet', style: 'primary' }]] }
        });
      }
      return bot.sendMessage(user.id, `❌ ${virtualNumberErrorText(error, user.lang)}`);
    }
  }

  if (data.startsWith('vn:cancel:')) {
    const orderId = Number(data.split(':')[2]);
    await answerCallback(query.id, virtualText(user.lang, 'جاري طلب الإلغاء…', 'Requesting cancellation…'));
    try {
      const result = await virtualNumbers.cancelCustomerOrder(user.id, orderId);
      return bot.sendMessage(user.id, result.alreadyDone
        ? virtualText(user.lang, 'ℹ️ هذا الطلب منتهي أصلاً.', 'ℹ️ This order is already closed.')
        : virtualText(user.lang, `↩️ تم إلغاء الرقم وإرجاع ${moneyUsd(result.refunded || 0)} لمحفظتك.`, `↩️ Number cancelled and ${moneyUsd(result.refunded || 0)} was returned to your wallet.`));
    } catch (error) {
      return bot.sendMessage(user.id, `❌ ${virtualNumberErrorText(error, user.lang)}`);
    }
  }

  if (data === 'vn:orders') {
    await answerCallback(query.id);
    return showVirtualOrders(query.message.chat.id, user);
  }

  if (data === 'vn:wallet') {
    await answerCallback(query.id);
    const fresh = await User.findByPk(user.id);
    const inline = [];
    if (binancePay.configured()) inline.push([{ text: '🟡 شحن Binance ID', callback_data: 'topup:binance', style: 'primary' }]);
    inline.push([{ text: '🔵 شحن SuperQi', callback_data: 'topup:superqi', style: 'primary' }]);
    return bot.sendMessage(user.id, `${t(user.lang, 'walletBalance')}: <b>${moneyUsd(fresh.balance)}</b>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: inline } });
  }

  return answerCallback(query.id, virtualText(user.lang, 'زر غير معروف.', 'Unknown action.'), true);
}

async function handleBuy(query, user, merchantId) {
  const product = await Merchant.findByPk(merchantId);
  const stock = product ? await getProductStock(product.id) : 0;
  if (!product || !product.isActive || stock < 1) return answerCallback(query.id, t(user.lang, 'outOfStock'), true);
  const max = Math.min(stock, 10);
  const first = [];
  const second = [];
  for (let quantity = 1; quantity <= max; quantity += 1) {
    (quantity <= 5 ? first : second).push({ text: String(quantity), callback_data: `qty:${merchantId}:${quantity}` });
  }
  const rows = [first];
  if (second.length) rows.push(second);
  await answerCallback(query.id);
  return bot.sendMessage(query.message.chat.id, `${t(user.lang, 'quantity')} 1-${max}`, {
    reply_markup: { inline_keyboard: rows }
  });
}

async function handleQuantity(query, user, data) {
  const [, merchantIdRaw, quantityRaw] = data.split(':');
  const merchantId = Number(merchantIdRaw);
  const quantity = Number(quantityRaw);
  const product = await Merchant.findByPk(merchantId);
  const stock = product ? await getProductStock(product.id) : 0;
  if (!product || stock < quantity) return answerCallback(query.id, t(user.lang, 'outOfStock'), true);
  await setState(user.id, { action: 'checkout', merchantId, quantity });
  const total = Number(product.price) * quantity;
  const buttons = [[{ text: t(user.lang, 'payWallet'), callback_data: 'pay:wallet', style: 'primary' }]];
  if (binancePay.configured()) buttons.push([{ text: '🟡 Binance ID', callback_data: 'pay:binance', style: 'primary' }]);
  buttons.push([{ text: t(user.lang, 'paySuperQi'), callback_data: 'pay:superqi', style: 'primary' }]);
  await answerCallback(query.id);
  return bot.sendMessage(query.message.chat.id, `${t(user.lang, 'payment')}\n💰 <b>${moneyUsd(total)}</b>`, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons }
  });
}

async function handlePayment(query, user, data) {
  const method = data.split(':')[1];
  const freshUser = await User.findByPk(user.id);
  const state = parseState(freshUser);
  if (!state || state.action !== 'checkout') return answerCallback(query.id, t(user.lang, 'cancelled'), true);

  const order = await createOrder({
    userId: user.id,
    merchantId: state.merchantId,
    quantity: state.quantity,
    paymentMethod: method
  });
  await clearState(user.id);
  await answerCallback(query.id);

  if (method === 'wallet') {
    try {
      const fulfillment = await payFromWallet(order.id);
      return sendDeliveryToUser(user.id, fulfillment);
    } catch (error) {
      if (error.message === 'INSUFFICIENT_BALANCE') return bot.sendMessage(user.id, t(user.lang, 'insufficient'));
      if (error.message === 'OUT_OF_STOCK') return bot.sendMessage(user.id, t(user.lang, 'outOfStock'));
      throw error;
    }
  }

  if (method === 'binance') {
    const created = await binancePay.createForOrder(order.id);
    if (!created.success) {
      await order.update({ status: 'payment_error' });
      return bot.sendMessage(user.id, binanceFailureText(created, user.lang));
    }
    return sendBinanceInstructions(user, created.transfer);
  }

  const rate = await getIqdRate();
  const number = await getSuperQiNumber();
  const iqd = Number(order.totalAmount) * rate;
  await setState(user.id, { action: 'superqi_proof', orderId: order.id });
  return bot.sendMessage(user.id, [
    '🔵 <b>دفع SuperQi</b>',
    '',
    `المبلغ: <b>${moneyUsd(order.totalAmount)}</b>`,
    `بالدينار: <b>${moneyIqd(iqd)}</b>`,
    `حوّل إلى: <code>${escapeHtml(number)}</code>`,
    '',
    t(user.lang, 'proofPrompt'),
    '',
    'اكتب إغلاق إذا تريد إلغاء العملية.'
  ].join('\n'), { parse_mode: 'HTML', reply_markup: cancelInlineKeyboard() });
}

async function sendBinanceInstructions(user, transfer) {
  await setState(user.id, { action: 'binance_verify', transferId: transfer.id });
  return bot.sendMessage(user.id, binancePay.instructions(transfer, user.lang), {
    parse_mode: 'HTML'
  });
}

async function handleTopupStart(query, user, method) {
  if (method === 'binance' && !binancePay.configured()) {
    return answerCallback(query.id, 'Binance غير مهيأ.', true);
  }
  await setState(user.id, { action: 'wallet_topup_amount', method });
  await answerCallback(query.id);
  const minimum = method === 'binance' ? config.binance.minAmount : 0.01;
  return bot.sendMessage(user.id, `أرسل مبلغ الشحن بالدولار (يقبل أقل من $1، الحد الأدنى $${minimum}):`, { reply_markup: cancelInlineKeyboard() });
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
      ? `💬 <b>Support reply — ticket #${ticket.id}</b>`
      : `💬 <b>رد الدعم — التذكرة #${ticket.id}</b>`, { parse_mode: 'HTML' }).catch(() => {});
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

  if (state.action === 'wallet_topup_amount') {
    const amount = Number(String(msg.text || '').trim());
    const minimumAmount = state.method === 'binance' ? config.binance.minAmount : 0.01;
    if (!Number.isFinite(amount) || amount < minimumAmount || amount > 100000) {
      await bot.sendMessage(user.id, '❌ المبلغ غير صحيح.');
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

    const rate = await getIqdRate();
    const number = await getSuperQiNumber();
    const transaction = await BalanceTransaction.create({
      userId: user.id,
      amount,
      type: 'deposit',
      txid: `SUPERQI-${Date.now()}-${user.id}`,
      caption: 'SuperQi manual wallet topup',
      status: 'awaiting_proof',
      lastReminderAt: new Date()
    });
    await setState(user.id, { action: 'superqi_topup_proof', transactionId: transaction.id });
    await bot.sendMessage(user.id, [
      '🔵 <b>شحن المحفظة عبر SuperQi</b>',
      '',
      `المبلغ بالدولار: <b>${moneyUsd(amount)}</b>`,
      `سعر الصرف: <b>${moneyIqd(rate)} لكل 1$</b>`,
      `المبلغ المطلوب: <b>${moneyIqd(amount * rate)}</b>`,
      '',
      'حوّل إلى الرقم:',
      `<code>${escapeHtml(number)}</code>`,
      '',
      t(user.lang, 'proofPrompt'),
      '',
      'اكتب إغلاق إذا تريد إلغاء العملية.'
    ].join('\n'), { parse_mode: 'HTML', reply_markup: cancelInlineKeyboard() });
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
            '🔵 <b>إيصال شحن SuperQi</b>',
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
            '🔵 <b>إيصال SuperQi</b>',
            `الطلب: <code>#${order.id}</code>`,
            `الزبون: ${escapeHtml(user.firstName || '')} — <code>${user.id}</code>`,
            `المنتج: ${escapeHtml(product?.nameAr || '')}`,
            `الكمية: ${order.quantity}`,
            `المبلغ: ${moneyUsd(order.totalAmount)} = ${moneyIqd(Number(order.totalAmount) * rate)}`
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

  if (state.action === 'virtual_number_search') {
    const queryText = String(msg.text || '').trim();
    if (!queryText) return true;
    try {
      const providerId = String(state.providerId || '');
      const services = await virtualNumbers.listServices(providerId);
      const needle = normalizeVirtualSearch(queryText);
      const matches = services.filter(service => {
        const values = [service.code, service.name, virtualServiceDisplayName(service, 'ar'), virtualServiceDisplayName(service, 'en')];
        return values.some(value => normalizeVirtualSearch(value).includes(needle));
      }).slice(0, 40);
      await clearState(user.id);
      if (!matches.length) {
        await bot.sendMessage(user.id, virtualText(user.lang, '❌ ما لقيت تطبيق بهذا الاسم.', '❌ No app matched that search.'));
        return showVirtualServices(user.id, user, providerId, 0);
      }
      return showVirtualServices(user.id, user, providerId, 0, matches);
    } catch (error) {
      await clearState(user.id);
      await bot.sendMessage(user.id, `❌ ${virtualNumberErrorText(error, user.lang)}`);
      return true;
    }
  }

  if (!isAdmin(user.id)) return false;

  if (state.action === 'admin_vnum_api') {
    const providerId = String(state.providerId || '');
    const value = String(msg.text || '').trim();
    if (!value) return true;
    try {
      if (value === '-') {
        await virtualNumbers.removeProviderApiKey(providerId);
        await clearState(user.id);
        await bot.sendMessage(user.id, '✅ تم حذف/إيقاف API لهذا الموقع.');
        await showVirtualNumberAdmin(user.id);
        return true;
      }
      await bot.sendMessage(user.id, '🧪 جاري فحص API قبل الحفظ...');
      const result = await virtualNumbers.setProviderApiKey(providerId, value);
      await clearState(user.id);
      await bot.sendMessage(user.id, `✅ API صحيح وتم حفظه بأمان.\nرصيد الموقع: <b>${Number(result.balance || 0).toFixed(4)}</b>`, { parse_mode: 'HTML' });
      await showVirtualNumberAdmin(user.id);
      return true;
    } catch (error) {
      await bot.sendMessage(user.id, `❌ ما تم حفظ API. ${virtualNumberErrorText(error, 'ar')}\nأرسل API صحيح، أو - للحذف، أو إغلاق للإلغاء.`, { reply_markup: cancelInlineKeyboard() });
      return true;
    }
  }

  if (state.action === 'admin_vnum_profit') {
    const providerId = String(state.providerId || '');
    const value = Number(String(msg.text || '').trim());
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      await bot.sendMessage(user.id, '❌ أرسل الربح بالدولار فقط، مثال: 0.15 أو 0.20 أو 0.30');
      return true;
    }
    try {
      const profit = await virtualNumbers.setProviderProfit(providerId, value);
      await clearState(user.id);
      await bot.sendMessage(user.id, `✅ تم تحديد الربح لكل رقم إلى <b>${moneyUsd(profit)}</b>.`, { parse_mode: 'HTML' });
      await showVirtualNumberAdmin(user.id);
      return true;
    } catch (error) {
      await bot.sendMessage(user.id, `❌ ${virtualNumberErrorText(error, 'ar')}`);
      return true;
    }
  }

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

      const product = await Merchant.create({
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
        image: imageValue === '-' ? null : imageValue,
        isActive: true,
        sharedLimit: 1,
        deliveryMode: 'instant',
        ownerNote: null
      });

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
          fingerprint
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

      if (added > 0 && product.isActive) {
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

    if (state.key === 'iqd_rate') {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 1) {
        await bot.sendMessage(user.id, '❌ رقم غير صحيح.');
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
    await bot.sendMessage(targetUser.id, `✅ تم شحن محفظتك عبر SuperQi.\nالمبلغ: <b>${moneyUsd(ledger.amount)}</b>\nالرصيد الجديد: <b>${moneyUsd(targetUser.balance)}</b>`, { parse_mode: 'HTML' });
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
    await order.update({ status: 'rejected' });
    await answerCallback(query.id, 'تم الرفض.');
    await bot.sendMessage(order.userId, `❌ تم رفض إيصال الطلب #${order.id}. راجع الدعم.`);
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
  return bot.sendMessage(chatId, t(user.lang, 'orders'), { reply_markup: { inline_keyboard: keyboard } });
}

async function showOrder(chatId, user, orderId, callbackId = null) {
  if (callbackId) await answerCallback(callbackId);
  const order = await PurchaseOrder.findByPk(orderId, { include: [Merchant] });
  if (!order || (String(order.userId) !== String(user.id) && !isAdmin(user.id))) return;
  const name = user.lang === 'en' ? (order.Merchant?.nameEn || order.Merchant?.nameAr) : order.Merchant?.nameAr;
  const text = [
    `🧾 <b>الطلب #${order.id}</b>`,
    `المنتج: ${escapeHtml(name || '')}`,
    `الكمية: ${order.quantity}`,
    `المبلغ: ${moneyUsd(order.totalAmount)}`,
    `الدفع: ${escapeHtml(order.paymentMethod)}`,
    `الحالة: ${escapeHtml(order.status)}`
  ].join('\n');
  await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
}

async function handleAdminCallback(query, user, data) {
  if (data === 'adm:home') {
    await answerCallback(query.id);
    return bot.sendMessage(query.message.chat.id, '🔧 <b>لوحة الإدارة</b>', {
      parse_mode: 'HTML',
      reply_markup: await adminMenu()
    });
  }

  if (data === 'adm:vnum') {
    await answerCallback(query.id);
    return showVirtualNumberAdmin(query.message.chat.id);
  }

  if (data.startsWith('adm:vnum_api:')) {
    const providerId = String(data.split(':')[2] || '');
    let provider;
    try { provider = virtualNumbers.providerRecord(providerId); }
    catch { return answerCallback(query.id, 'الموقع غير معروف.', true); }
    await setState(user.id, { action: 'admin_vnum_api', providerId });
    await answerCallback(query.id);
    return bot.sendMessage(user.id, [
      `🔑 <b>${escapeHtml(provider.adminName)}</b>`,
      '',
      'أرسل API Key الخاص بالموقع.',
      'راح أفحصه أولاً، وإذا صحيح ينحفظ مشفراً.',
      '',
      'أرسل <code>-</code> لحذف/إيقاف API لهذا الموقع.',
      'اكتب إغلاق للإلغاء.'
    ].join('\n'), { parse_mode: 'HTML', reply_markup: cancelInlineKeyboard() });
  }

  if (data.startsWith('adm:vnum_profit:')) {
    const providerId = String(data.split(':')[2] || '');
    let provider;
    try { provider = virtualNumbers.providerRecord(providerId); }
    catch { return answerCallback(query.id, 'الموقع غير معروف.', true); }
    const current = await virtualNumbers.getProviderProfit(providerId);
    await setState(user.id, { action: 'admin_vnum_profit', providerId });
    await answerCallback(query.id);
    return bot.sendMessage(user.id, [
      `💰 <b>ربح ${escapeHtml(provider.adminName)}</b>`,
      '',
      `الربح الحالي لكل رقم: <b>${moneyUsd(current)}</b>`,
      'أرسل الربح الجديد بالدولار.',
      'مثال: <code>0.15</code> أو <code>0.20</code> أو <code>0.30</code>',
      '',
      'اكتب إغلاق للإلغاء.'
    ].join('\n'), { parse_mode: 'HTML', reply_markup: cancelInlineKeyboard() });
  }

  if (data.startsWith('adm:vnum_test:')) {
    const providerId = String(data.split(':')[2] || '');
    let provider;
    try { provider = virtualNumbers.providerRecord(providerId); }
    catch { return answerCallback(query.id, 'الموقع غير معروف.', true); }
    await answerCallback(query.id, 'جاري الفحص...');
    try {
      const result = await virtualNumbers.testProviderApi(providerId);
      return bot.sendMessage(query.message.chat.id, `✅ <b>${escapeHtml(provider.adminName)}</b> متصل ويعمل.\nرصيد حساب الموقع: <b>${Number(result.balance || 0).toFixed(4)}</b>`, { parse_mode: 'HTML' });
    } catch (error) {
      return bot.sendMessage(query.message.chat.id, `❌ فشل فحص <b>${escapeHtml(provider.adminName)}</b>.\n${escapeHtml(virtualNumberErrorText(error, 'ar'))}`, { parse_mode: 'HTML' });
    }
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
          [{ text: '❌ إيقاف القناة', callback_data: 'adm:channel_disable' }]
        ]
      }
    });
  }

  if (data === 'adm:notifications_toggle') {
    const enabled = await automaticNotificationsEnabled();
    await setSetting('automatic_notifications_enabled', enabled ? 'false' : 'true');
    const nowEnabled = !enabled;
    await answerCallback(query.id, nowEnabled ? 'تم تشغيل الإشعارات التلقائية.' : 'تم إيقاف الإشعارات التلقائية.');
    try {
      await bot.editMessageReplyMarkup(await adminMenu(), {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id
      });
    } catch {
      await bot.sendMessage(query.message.chat.id, nowEnabled ? '🔔 الإشعارات التلقائية شغالة.' : '🔕 الإشعارات التلقائية متوقفة.', {
        reply_markup: await adminMenu()
      });
    }
    return;
  }

  if (data === 'adm:store_toggle') {
    const open = await isStoreOpen();
    await setSetting('store_open', open ? 'false' : 'true');
    await answerCallback(query.id, open ? 'تم إغلاق المتجر.' : 'تم فتح المتجر.');
    return bot.sendMessage(query.message.chat.id, open
      ? '🔒 المتجر مغلق الآن. الدعم يبقى شغال.'
      : '✅ المتجر مفتوح الآن للمستخدمين.');
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
      lines.push('🔵 <b>SuperQi</b>');
      lines.push(...rows.map(order => `#${order.id} | ${escapeHtml(order.Merchant?.nameAr || '')} | ${moneyUsd(order.totalAmount)}`));
    }
    if (binanceRows.length) {
      if (lines.length) lines.push('');
      lines.push('🟡 <b>Binance — تحقق يدوي</b>');
      lines.push(...binanceRows.map(row => `#${row.id} | مستخدم <code>${row.userId}</code> | ${moneyUsd(row.expectedAmount)} | <code>${escapeHtml(row.submittedOrderId || '')}</code>`));
    }
    return bot.sendMessage(query.message.chat.id, lines.length ? lines.join('\n') : 'ماكو دفعات معلقة.', { parse_mode: 'HTML' });
  }

  if (data === 'adm:orders') {
    await answerCallback(query.id);
    const rows = await PurchaseOrder.findAll({ order: [['id', 'DESC']], limit: 30, include: [Merchant] });
    return bot.sendMessage(query.message.chat.id, rows.length
      ? rows.map(order => `#${order.id} | ${order.Merchant?.nameAr || ''} | ${order.status} | ${moneyUsd(order.totalAmount)}`).join('\n')
      : 'ماكو طلبات.');
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
      `📦 المنتجات: ${products}`,
      `🧾 الطلبات: ${orders}`,
      `🟡 دفعات Binance المؤكدة: ${verifiedBinance}`,
      `🎁 الإحالات المقبولة: ${referrals}`,
      `🎉 الهدايا المسلّمة: ${giftClaims}`,
      `💬 تذاكر الدعم المفتوحة: ${openTickets}`,
      `🔐 المخزون المتاح: ${stock}`
    ].join('\n'));
  }

  if (data === 'adm:settings') {
    await answerCallback(query.id);
    const [rate, number, channel, open] = await Promise.all([
      getIqdRate(),
      getSuperQiNumber(),
      getRequiredChannel(),
      isStoreOpen()
    ]);
    return bot.sendMessage(query.message.chat.id, [
      '⚙️ <b>الإعدادات</b>',
      '',
      `المتجر: <b>${open ? 'مفتوح' : 'مغلق'}</b>`,
      `سعر الدولار: ${moneyIqd(rate)}`,
      `رقم SuperQi: <code>${escapeHtml(number)}</code>`,
      `القناة الإجبارية: <code>${escapeHtml(channel || 'متوقفة')}</code>`,
      `Binance ID: <code>${escapeHtml(config.binance.payId || 'غير مضاف')}</code>`,
      `Binance API: <b>${binancePay.configured() ? 'جاهز' : 'ناقص'}</b>`
    ].join('\n'), {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [
          { text: '💱 سعر الدولار', callback_data: 'adm:set:iqd_rate' },
          { text: '🔵 رقم SuperQi', callback_data: 'adm:set:superqi_number' }
        ],
        [
          { text: '📢 القناة الإجبارية', callback_data: 'adm:set:required_channel' },
          { text: '❌ إيقاف القناة', callback_data: 'adm:channel_disable' }
        ]
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
      superqi_number: 'أرسل رقم SuperQi الجديد:',
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
    product.isActive = !product.isActive;
    await product.save();
    await answerCallback(query.id, product.isActive ? 'تم النشر.' : 'تم الإخفاء.');
    return showAdminProductEditor(query.message.chat.id, product.id);
  }

  if (data.startsWith('adm:delete:')) {
    const product = await Merchant.findByPk(Number(data.split(':')[2]));
    if (!product) return;
    await Code.destroy({ where: { merchantId: product.id } });
    await product.destroy();
    await answerCallback(query.id, 'تم الحذف.');
    return showAdminProducts(query.message.chat.id, 0);
  }

  if (data.startsWith('adm:stockprod:')) {
    const productId = Number(data.split(':')[2]);
    const product = await Merchant.findByPk(productId);
    if (!product) return answerCallback(query.id, 'المنتج غير موجود.', true);
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
    [{ text: '🎁 اختيار منتج الهدية', callback_data: 'adm:ref_product' }]
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
  const text = [
    `📝 <b>${escapeHtml(product.nameAr)}</b>`,
    '',
    `النوع: <b>${productTypeLabel(product.type)}</b>`,
    `السعر: <b>${moneyUsd(product.price)}</b>`,
    `المخزون: <b>${stock}</b>`,
    `ظهور المنتج: <b>${product.isActive ? 'ظاهر' : 'مخفي'}</b>`,
    `الترجمة الإنجليزية: <b>تلقائية</b>`,
    '',
    `الوصف: ${escapeHtml(description.ar || '—')}`,
    `الضمان: ${escapeHtml(description.warrantyAr || '—')}`,
    `الصورة: ${product.image ? 'موجودة' : 'بدون'}`,
    description.nameEmojiId ? '✨ Custom Emoji: محفوظة تلقائياً' : '✨ Custom Emoji: لا توجد'
  ].join('\n');

  const keyboard = [
    [{ text: '✏️ الاسم', callback_data: `adm:field:${product.id}:nameAr` }, { text: '💵 السعر', callback_data: `adm:field:${product.id}:price` }],
    [{ text: '📝 الوصف', callback_data: `adm:field:${product.id}:descriptionAr` }, { text: '🛡 الضمان', callback_data: `adm:field:${product.id}:warrantyAr` }],
    [{ text: '🖼 الصورة', callback_data: `adm:field:${product.id}:image` }, { text: '📥 إضافة مخزون', callback_data: `adm:stockprod:${product.id}`, style: 'success' }],
    [{ text: product.isActive ? '🙈 إخفاء المنتج' : '👁 إظهار المنتج', callback_data: `adm:toggle:${product.id}`, style: product.isActive ? 'danger' : 'success' }],
    [{ text: '🗑 حذف المنتج', callback_data: `adm:delete:${product.id}`, style: 'danger' }]
  ];
  await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
}

async function showStockProductList(chatId) {
  const products = await Merchant.findAll({ order: [['id', 'ASC']] });
  const keyboard = [];
  for (const product of products) {
    const stock = await getProductStock(product.id);
    keyboard.push([{
      text: `${product.nameAr} | 📦 ${stock}`,
      callback_data: `adm:stockprod:${product.id}`,
      style: stock > 0 ? 'success' : 'danger'
    }]);
  }
  await bot.sendMessage(chatId, 'اختَر المنتج لإضافة المخزون:', { reply_markup: { inline_keyboard: keyboard } });
}

bot.onText(/^\/code_(\d+)_(.+)$/s, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  try {
    const result = await addWaitingCode(Number(match[1]), String(match[2]).trim());
    const user = await User.findByPk(result.order.userId);
    const lang = user?.lang || 'ar';
    await bot.sendMessage(result.order.userId, `${t(lang, 'delivered')} — <b>#${result.order.id}</b>\n${renderDelivery(result.delivery.payload, lang)}`, { parse_mode: 'HTML' });
    await bot.sendMessage(msg.chat.id, '✅ تم إرسال الكود.');
  } catch (error) {
    await bot.sendMessage(msg.chat.id, `❌ ${error.message}`);
  }
});

let virtualNumbersWatcherStarted = false;
let virtualNumbersWatcherRunning = false;
let virtualNumbersWatcherTimer = null;

function startVirtualNumbersWatcher() {
  if (virtualNumbersWatcherStarted) return;
  virtualNumbersWatcherStarted = true;
  const intervalMs = Math.max(5000, Math.min(60000, Number(process.env.VIRTUAL_NUMBERS_POLL_INTERVAL_MS || 7000)));

  const poll = async () => {
    if (virtualNumbersWatcherRunning) return;
    virtualNumbersWatcherRunning = true;
    try {
      const events = await virtualNumbers.pollPendingOrders();
      for (const event of events) {
        const order = event?.order;
        if (!order?.userId) continue;
        const customer = await User.findByPk(order.userId);
        const lang = customer?.lang || 'ar';
        try {
          if (event.type === 'sms') {
            await bot.sendMessage(order.userId, virtualText(lang,
              `✅ وصل الكود للرقم <code>${escapeHtml(order.phoneNumber || '')}</code>\n\n🔐 الكود: <code>${escapeHtml(event.code || order.smsCode || '')}</code>\n🧾 الطلب: <code>#${order.id}</code>`,
              `✅ The SMS code arrived for <code>${escapeHtml(order.phoneNumber || '')}</code>\n\n🔐 Code: <code>${escapeHtml(event.code || order.smsCode || '')}</code>\n🧾 Order: <code>#${order.id}</code>`),
            { parse_mode: 'HTML' });
          } else if (event.type === 'expired_refund') {
            await bot.sendMessage(order.userId, virtualText(lang,
              `⏱ انتهت مهلة 10 دقائق بدون وصول كود.\nتم إلغاء الرقم وإرجاع <b>${moneyUsd(event.refunded || order.salePriceUsd)}</b> إلى محفظتك.`,
              `⏱ The 10-minute waiting period ended without an SMS.\nThe number was cancelled and <b>${moneyUsd(event.refunded || order.salePriceUsd)}</b> was refunded to your wallet.`),
            { parse_mode: 'HTML' });
          } else if (event.type === 'provider_cancelled') {
            await bot.sendMessage(order.userId, virtualText(lang,
              `❌ الموقع ألغى الرقم قبل وصول الكود.\nتم إرجاع <b>${moneyUsd(event.refunded || order.salePriceUsd)}</b> إلى محفظتك.`,
              `❌ The provider cancelled the number before an SMS arrived.\n<b>${moneyUsd(event.refunded || order.salePriceUsd)}</b> was refunded to your wallet.`),
            { parse_mode: 'HTML' });
          }
        } catch (error) {
          console.error('Virtual number user notification:', order.id, error.message);
        }
      }
    } catch (error) {
      console.error('Virtual numbers watcher:', error.message);
    } finally {
      virtualNumbersWatcherRunning = false;
    }
  };

  poll().catch(() => {});
  virtualNumbersWatcherTimer = setInterval(() => poll().catch(() => {}), intervalMs);
  virtualNumbersWatcherTimer.unref?.();
}

bot.on('polling_error', error => console.error('Telegram polling error:', error.message));

module.exports = { bot, notifyBinanceResult, sendDeliveryToUser, startVirtualNumbersWatcher };
