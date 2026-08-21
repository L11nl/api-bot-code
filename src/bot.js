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
  getProductStocksMap,
  productAccessibleInCurrentShop,
  productVisibleInCurrentShop,
  effectiveProductPrice,
  sortProductStockRows,
  listActiveProducts,
  createOrder,
  fulfillOrder,
  reserveWalletForOrder,
  refundWalletReservation,
  completeExternalPayment,
  payFromWallet,
  refundServiceOrderToWallet,
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
const { encryptPayload, decryptPayload } = require('./cryptoStore');
const { translateArToEn, translateEnToAr, looksArabic } = require('./translator');
const network = require('./network');
const networkLedger = require('./services/networkLedger');
const virtualNumbers = require('./services/virtualNumbers');
const premiumEmojis = require('./services/premiumEmojis');
const uiTextOverrides = require('./services/uiTextOverrides');
const adminAccess = require('./services/adminAccess');

const bot = new TelegramBot(config.token, { polling: false });
const captchaAnswers = new Map();
const memoryRate = new Map();
let cachedBotUsername = '';
let commerceStatusCache = { at: 0, value: null };
const channelMembershipCache = new Map();
let activePaymentMethodsCache = { at: 0, rows: null };
function invalidatePaymentMethodsCache() { activePaymentMethodsCache = { at: 0, rows: null }; }
const CHANNEL_MEMBER_OK_TTL_MS = Math.max(30000, Number(process.env.CHANNEL_MEMBER_OK_TTL_MS || 300000));
const CHANNEL_MEMBER_FAIL_TTL_MS = Math.max(5000, Number(process.env.CHANNEL_MEMBER_FAIL_TTL_MS || 20000));
const PAYMENT_METHOD_CACHE_TTL_MS = Math.max(1000, Number(process.env.PAYMENT_METHOD_CACHE_TTL_MS || 5000));

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

const PREMIUM_EMOJI = {
  binance: premiumEmojis.getByKey('binance'),
  superqi: premiumEmojis.getByKey('superqi'),
  support: premiumEmojis.getByKey('support'),
  wallet: premiumEmojis.getByKey('wallet'),
  orders: premiumEmojis.getByKey('orders'),
  products: premiumEmojis.getByKey('products'),
  language: premiumEmojis.getByKey('language'),
  settings: premiumEmojis.getByKey('settings'),
  api: premiumEmojis.getByKey('api'),
  phone: premiumEmojis.getByKey('phone'),
  search: premiumEmojis.getByKey('search'),
  delete: premiumEmojis.getByKey('delete'),
  edit: premiumEmojis.getByKey('edit'),
  save: premiumEmojis.getByKey('save'),
  add: premiumEmojis.getByKey('add'),
  copy: premiumEmojis.getByKey('copy'),
  image: premiumEmojis.getByKey('image'),
  gift: premiumEmojis.getByKey('gift'),
  money: premiumEmojis.getByKey('money'),
  box: premiumEmojis.getByKey('box'),
  success: premiumEmojis.getByKey('success'),
  error: premiumEmojis.getByKey('error')
};

const OWNER_EMOJI_DICTIONARY_VERSION = '2026-08-20-final-2';
const OWNER_CANONICAL_UI_EMOJI_IDS = Object.freeze({
  binance: '5875443023873053217',
  superqi: '5184203496831846429',
  language: '5798420477705719523',
  settings: '5801152386143620268',
  api: '5881713916643382055',
  phone: '6325330308279308485',
  support: '5908808657700655253',
  search: '5874960879434338403',
  delete: '5841541824803509441',
  edit: '5879841310902324730',
  save: '5366201992970518798',
  add: '6325454162251223334',
  copy: '5877301185639091664',
  image: '5775949822993371030',
  gift: '5470041305616759456',
  money: '5361656830944624968',
  box: '5366201992970518798',
  success: '5273806972871787310',
  error: '5271934564699226262'
});
let sharedPremiumEmojiRevision = '';

async function syncNetworkPremiumEmojiMappings({ repairProducts = false } = {}) {
  if (!network.enabledClient()) return { changed: false, count: premiumEmojis.listCustom().length };
  const shared = await network.getSharedPremiumEmojiMappings();
  const revision = String(shared?.revision || '');
  if (revision && revision === sharedPremiumEmojiRevision && premiumEmojis.loaded()) {
    return { changed: false, count: premiumEmojis.listCustom().length };
  }
  const result = await premiumEmojis.replaceCustom(shared?.mappings || []);
  sharedPremiumEmojiRevision = revision;
  if (result.changed && repairProducts) await repairKnownProductEmojiMappings();
  return result;
}

async function loadPersistentRuntimeConfig() {
  await adminAccess.loadAdmins();
  // One-time repair for IDs that an older release persisted before the owner
  // supplied the final dictionary. This changes only emoji settings and does
  // not touch users, balances, products, stock, orders, or deliveries.
  const dictionaryVersion = await getSetting('premium_emoji_dictionary_version', '');
  const upgradeOwnerEmojiDictionary = dictionaryVersion !== OWNER_EMOJI_DICTIONARY_VERSION;
  if (upgradeOwnerEmojiDictionary) {
    for (const [name, emojiId] of Object.entries(OWNER_CANONICAL_UI_EMOJI_IDS)) {
      await setSetting(`premium_emoji:${name}:id`, emojiId);
    }
  }

  // Store UI Premium Emoji IDs in PostgreSQL the first time we see them.
  // Future code deployments load the database value instead of replacing it
  // with whatever happens to be hard-coded in a newer source file.
  for (const [name, emoji] of Object.entries(PREMIUM_EMOJI)) {
    const key = `premium_emoji:${name}:id`;
    const missingToken = '__CD_MISSING_SETTING__';
    const stored = await getSetting(key, missingToken);
    if (stored === missingToken || (!String(stored || '').trim() && emoji.id)) {
      await setSetting(key, String(emoji.id || ''));
    } else {
      emoji.id = String(stored || '');
    }
    premiumEmojis.setBuiltInOverride(name, emoji.id);
  }
  let sharedDictionaryLoaded = false;
  if (network.enabledClient()) {
    try {
      await syncNetworkPremiumEmojiMappings();
      sharedDictionaryLoaded = true;
    } catch (error) {
      console.error('Shared Premium emoji startup sync:', error.message);
    }
  }
  if (!sharedDictionaryLoaded) await premiumEmojis.load();
  if (upgradeOwnerEmojiDictionary && !network.enabledClient()) {
    await premiumEmojis.migrateConfirmedPlatformIds({
      canva: '6275971058054995473',
      youtube: '5805401092346875873',
      x: '5794261081052418411',
      whatsapp: '5794261081052418411'
    });
  }
  if (upgradeOwnerEmojiDictionary) {
    await setSetting('premium_emoji_dictionary_version', OWNER_EMOJI_DICTIONARY_VERSION);
  }
  for (const [name, emoji] of Object.entries(PREMIUM_EMOJI)) {
    const latest = premiumEmojis.getByKey(name);
    if (latest?.id) Object.assign(emoji, latest);
  }
  await uiTextOverrides.load();
  await repairKnownProductEmojiMappings().catch(error => {
    console.error('Premium emoji product repair:', error.message);
  });
}

function emojiButton(text, emoji, extra = {}) {
  const button = { text, ...extra };
  const resolved = premiumEmojis.resolveProduct(text) || premiumEmojis.resolve(text);
  const selected = resolved?.source === 'custom' && resolved.exactMatch
    ? resolved
    : (emoji?.id ? emoji : resolved);
  if (selected?.id) button.icon_custom_emoji_id = String(selected.id);
  return button;
}

function premiumEmojiHtml(emoji) {
  if (!emoji?.id) return escapeHtml(emoji?.alt || '');
  return `<tg-emoji emoji-id="${escapeHtml(String(emoji.id))}">${escapeHtml(emoji.alt || '✨')}</tg-emoji>`;
}

const ESSENTIAL_PLAIN_EMOJI_RE = /(?:⚠\uFE0F?|⛔\uFE0F?|🚨|🛑|❗\uFE0F?|❕\uFE0F?|‼\uFE0F?|⁉\uFE0F?|⬅\uFE0F?|➡\uFE0F?|↩\uFE0F?|↪\uFE0F?|🔄)/gu;
const ORDINARY_EMOJI_RE = /(?:[\p{Regional_Indicator}]{2}|[\p{Extended_Pictographic}](?:\uFE0F|\uFE0E)?(?:\p{Emoji_Modifier})?(?:\u200D[\p{Extended_Pictographic}](?:\uFE0F|\uFE0E)?(?:\p{Emoji_Modifier})?)*)/gu;

function stripOrdinaryEmojiText(value, preserveEssential = true) {
  const protectedSymbols = [];
  let text = String(value || '').replace(/([#*0-9])\uFE0F?\u20E3/gu, '$1');
  if (preserveEssential) {
    text = text.replace(ESSENTIAL_PLAIN_EMOJI_RE, symbol => {
      const token = `\uE000${protectedSymbols.length}\uE001`;
      protectedSymbols.push(symbol);
      return token;
    });
  }
  text = text
    .replace(ORDINARY_EMOJI_RE, '')
    .replace(/\uFE0F/gu, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ');
  protectedSymbols.forEach((symbol, index) => {
    text = text.replace(`\uE000${index}\uE001`, symbol);
  });
  return text;
}

function cleanProductNameForEmoji(value, oldAlt = '') {
  let name = String(value || '').trim();
  const alt = String(oldAlt || '').trim();
  if (alt && name.startsWith(alt)) name = name.slice(alt.length).trim();
  // Old product names sometimes retained these decorative symbols after the
  // Custom Emoji entity had already been stored separately. Hide only the
  // unwanted decoration; never rewrite the product name or inventory record.
  return name
    .replace(/(?:🌹|📱|📞|📲|☎️?)/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolvedProductNameEmoji(product) {
  return premiumEmojis.resolveProduct(`${productDisplayName(product, 'ar')} ${productDisplayName(product, 'en')}`);
}

function productDisplayName(product, lang = 'ar') {
  if (!product) return '';
  if (lang === 'en') {
    return String(product.localNameEnOverride || product.localNameArOverride || product.nameEn || product.nameAr || '').trim();
  }
  return String(product.localNameArOverride || product.nameAr || product.localNameEnOverride || product.nameEn || '').trim();
}

function parseLocalContentOverride(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return { ...value };
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...parsed } : {};
  } catch {
    return {};
  }
}

function productPresentationDescription(product) {
  const description = { ...parseDescription(product?.description) };
  const local = parseLocalContentOverride(product?.localContentOverride);
  const keys = ['ar', 'en', 'descriptionArHtml', 'warrantyAr', 'warrantyEn', 'warrantyArHtml'];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(local, key)) description[key] = local[key] ?? '';
  }
  return description;
}

function productDisplayImage(product) {
  const local = parseLocalContentOverride(product?.localContentOverride);
  if (Object.prototype.hasOwnProperty.call(local, 'image')) return local.image || null;
  return product?.image || null;
}

function productDisplayEmoji(product, descriptionData = null) {
  if (product?.localNameEmojiId) {
    return { id: String(product.localNameEmojiId), alt: String(product.localNameEmojiAlt || '✨') };
  }
  const description = descriptionData || parseDescription(product?.description);
  return description?.nameEmojiId
    ? { id: String(description.nameEmojiId), alt: String(description.nameEmojiAlt || '✨') }
    : null;
}

function usableProductNameEmoji(...candidates) {
  const blockedIds = new Set([
    // Quarantine the obsolete phone assignment that was accidentally stored
    // on unrelated products by older releases. The new phone ID is allowed
    // when the product text actually says phone/virtual number.
    '5897488197650223178'
  ].filter(Boolean));
  return candidates.find(candidate => (
    candidate?.id &&
    !blockedIds.has(String(candidate.id)) &&
    !/(?:🌹)/u.test(String(candidate.alt || ''))
  )) || null;
}

async function auditProductEmojiMappings({ repair = false } = {}) {
  const products = await Merchant.findAll({ attributes: ['id', 'nameAr', 'nameEn', 'description'] });
  const report = {
    total: products.length,
    recognized: 0,
    correct: 0,
    mismatched: 0,
    repaired: 0,
    unknownNames: []
  };
  for (const product of products) {
    const canonical = resolvedProductNameEmoji(product);
    if (!canonical?.id || !premiumEmojis.isCanonicalPlatformKey(canonical.key)) {
      if (report.unknownNames.length < 12) report.unknownNames.push(String(product.nameAr || product.nameEn || `#${product.id}`));
      continue;
    }
    report.recognized += 1;

    const original = product.description;
    const base = original && typeof original === 'object' && !Array.isArray(original)
      ? { ...original }
      : { ...parseDescription(original) };
    const oldAlt = String(base.nameEmojiAlt || '');
    const cleanArabicName = cleanProductNameForEmoji(product.nameAr || product.nameEn, oldAlt);
    const expectedHtml = `${premiumEmojiHtml(canonical)} ${escapeHtml(cleanArabicName)}`;
    if (
      String(base.nameEmojiId || '') === String(canonical.id) &&
      String(base.nameEmojiAlt || '') === String(canonical.alt || '✨') &&
      String(base.nameArHtml || '') === expectedHtml
    ) {
      report.correct += 1;
      continue;
    }
    report.mismatched += 1;
    if (!repair) continue;

    product.set('description', {
      ...base,
      nameEmojiId: String(canonical.id),
      nameEmojiAlt: String(canonical.alt || '✨'),
      nameArHtml: expectedHtml
    });
    product.changed('description', true);
    await product.save({ fields: ['description'] });
    report.repaired += 1;
  }
  return report;
}

async function repairKnownProductEmojiMappings() {
  const report = await auditProductEmojiMappings({ repair: true });
  if (report.repaired) console.log(`Premium emoji mappings repaired for ${report.repaired} product(s).`);
  return report.repaired;
}

function premiumLabelHtml(value, fallbackEmoji = null) {
  const text = String(value || '').trim();
  const emoji = fallbackEmoji?.id ? fallbackEmoji : (premiumEmojis.resolveProduct(text) || premiumEmojis.resolve(text));
  return emoji?.id ? `${premiumEmojiHtml(emoji)} ${escapeHtml(text)}` : escapeHtml(text);
}

function mapKeyboardButtons(rows, mapper) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(row => Array.isArray(row)
    ? row.map(button => (button && typeof button === 'object' ? mapper({ ...button }) : button))
    : row);
}

function replyMarkupWithPremiumIcons(replyMarkup) {
  if (!replyMarkup || typeof replyMarkup !== 'object') return replyMarkup;
  const decorate = (button, replyKeyboard = false) => {
    const sourceText = typeof button.text === 'string' ? button.text : '';
    const lockedPremiumEmoji = button.__lockPremiumEmoji === true;
    delete button.__lockPremiumEmoji;
    if (sourceText) {
      uiTextOverrides.record({
        kind: 'button',
        text: sourceText,
        callbackData: button.callback_data || '',
        replyKeyboard
      });
      const override = uiTextOverrides.get('button', sourceText);
      if (override) {
        button.text = override.replacementText;
        if (!lockedPremiumEmoji) {
          delete button.icon_custom_emoji_id;
          if (override.emojiId) button.icon_custom_emoji_id = String(override.emojiId);
        }
      }
    }
    const skipAutomaticIcon = button.__skipPremiumEmoji === true;
    delete button.__skipPremiumEmoji;
    if (!skipAutomaticIcon && !button.icon_custom_emoji_id && typeof button.text === 'string') {
      const emoji = premiumEmojis.resolveProduct(button.text) || premiumEmojis.resolve(button.text);
      if (emoji?.id) button.icon_custom_emoji_id = String(emoji.id);
    }
    if (typeof button.text === 'string') {
      const originalText = button.text;
      button.text = stripOrdinaryEmojiText(originalText, !button.icon_custom_emoji_id).trim();
      if (!button.text) button.text = button.icon_custom_emoji_id ? '\u2060' : originalText;
    }
    if (replyKeyboard && sourceText && typeof button.text === 'string') {
      uiTextOverrides.registerReplyButtonAlias(button.text, sourceText);
    }
    return button;
  };
  return {
    ...replyMarkup,
    inline_keyboard: mapKeyboardButtons(replyMarkup.inline_keyboard, button => decorate(button, false)),
    keyboard: mapKeyboardButtons(replyMarkup.keyboard, button => decorate(button, true))
  };
}

function replyMarkupWithoutPremiumIcons(replyMarkup) {
  if (!replyMarkup || typeof replyMarkup !== 'object') return replyMarkup;
  const strip = button => {
    delete button.icon_custom_emoji_id;
    return button;
  };
  return {
    ...replyMarkup,
    inline_keyboard: mapKeyboardButtons(replyMarkup.inline_keyboard, strip),
    keyboard: mapKeyboardButtons(replyMarkup.keyboard, strip)
  };
}

function decoratePremiumHtmlSymbols(value) {
  const replacements = [
    ['🇮🇶', 'iraq'], ['🇬🇧', 'english'], ['🇸🇦', 'arabic'],
    ['🗑️', 'delete'], ['🗑', 'delete'], ['✏️', 'edit'], ['✏', 'edit'],
    ['⚙️', 'settings'], ['⚙', 'settings'], ['✅', 'success'], ['❌', 'error'],
    ['🔎', 'search'], ['🔍', 'search'], ['📌', 'pin'], ['🔒', 'lock'],
    ['📱', 'phone'], ['🔔', 'notifications_on'], ['🔕', 'notifications_off'],
    ['⏳', 'loading'], ['🌐', 'language'], ['💾', 'save'],
    ['💰', 'money'], ['📦', 'box'],
    ['🔥', 'trending'], ['📋', 'copy'], ['🔑', 'key'],
    ['🖼️', 'image'], ['🖼', 'image'], ['🔧', 'fix'], ['💻', 'laptop'],
    ['➕', 'add'], ['🔳', 'qr'], ['⭐', 'star'], ['🍎', 'ios'],
    ['👉🏼', 'direction_right'], ['👉', 'direction_right'],
    ['👈🏼', 'direction_left'], ['👈', 'direction_left'],
    ['1️⃣', 'digit_1'], ['2️⃣', 'digit_2'], ['3️⃣', 'digit_3'],
    ['4️⃣', 'digit_4'], ['5️⃣', 'digit_5'], ['6️⃣', 'digit_6'],
    ['7️⃣', 'digit_7'], ['8️⃣', 'digit_8'], ['9️⃣', 'digit_9']
  ];
  // Never recurse into a Custom Emoji tag that was already rendered by a
  // product, service, payment method, or explicit UI helper.
  const decorated = String(value || '').split(/(<tg-emoji\b[^>]*>[\s\S]*?<\/tg-emoji>|<code\b[^>]*>[\s\S]*?<\/code>|<pre\b[^>]*>[\s\S]*?<\/pre>)/gi).map(part => {
    if (/^<(?:tg-emoji|code|pre)\b/i.test(part)) return part;
    let out = part;
    for (const [symbol, key] of replacements) {
      if (!out.includes(symbol)) continue;
      const emoji = premiumEmojis.getByKey(key);
      if (emoji?.id) out = out.split(symbol).join(premiumEmojiHtml(emoji));
    }
    return out.split(/(<tg-emoji\b[^>]*>[\s\S]*?<\/tg-emoji>)/gi).map(fragment => (
      /^<tg-emoji\b/i.test(fragment) ? fragment : stripOrdinaryEmojiText(fragment, true)
    )).join('');
  }).join('');
  return decorated.split('\n').map(line => {
    if (!line.trim() || /<(?:tg-emoji|code|pre|blockquote)\b/i.test(line)) return line;
    const visibleText = uiTextOverrides.plainText(line);
    if (!visibleText) return line;
    const emoji = premiumEmojis.resolveProduct(visibleText) || premiumEmojis.resolve(visibleText);
    return emoji?.id ? `${premiumEmojiHtml(emoji)} ${line}` : line;
  }).join('\n');
}

function premiumPlainTextAsHtml(value) {
  const html = decoratePremiumHtmlSymbols(escapeHtml(String(value || '')));
  return /<tg-emoji\b/i.test(html) ? html : '';
}

function uiTextOverrideHtml(override) {
  const label = escapeHtml(String(override?.replacementText || '').trim());
  if (!override?.emojiId) return label;
  return `${premiumEmojiHtml({ id: override.emojiId, alt: override.emojiAlt || '✨' })} ${label}`.trim();
}

function applyMessageTextOverride(value, options = {}, entitiesKey = 'entities', recordText = true) {
  if (typeof value !== 'string') return { value, options };
  if (recordText) uiTextOverrides.record({ kind: 'message', text: value });
  const override = uiTextOverrides.get('message', value);
  if (!override) return { value, options };
  const nextOptions = { ...(options || {}), parse_mode: 'HTML' };
  delete nextOptions[entitiesKey];
  return { value: uiTextOverrideHtml(override), options: nextOptions };
}

function optionsWithPremiumIcons(options, recordMessageText = true) {
  if (!options || typeof options !== 'object') return options;
  let decorated = { ...options };
  if (typeof decorated.caption === 'string') {
    const applied = applyMessageTextOverride(decorated.caption, decorated, 'caption_entities', recordMessageText);
    decorated = applied.options;
    decorated.caption = applied.value;
  }
  if (options.reply_markup) decorated.reply_markup = replyMarkupWithPremiumIcons(options.reply_markup);
  if (decorated.parse_mode === 'HTML' && typeof decorated.caption === 'string' && !decorated.caption_entities) {
    decorated.caption = decoratePremiumHtmlSymbols(decorated.caption);
  } else if (typeof decorated.caption === 'string' && !decorated.caption_entities) {
    const premiumHtml = premiumPlainTextAsHtml(decorated.caption);
    if (premiumHtml) {
      decorated.caption = premiumHtml;
      decorated.parse_mode = 'HTML';
    } else {
      decorated.caption = stripOrdinaryEmojiText(decorated.caption, true);
    }
  }
  return decorated;
}

function hasPremiumButtons(options) {
  const markup = options?.reply_markup;
  return [markup?.inline_keyboard, markup?.keyboard].some(rows => Array.isArray(rows) && rows.some(row =>
    Array.isArray(row) && row.some(button => Boolean(button?.icon_custom_emoji_id))));
}

function isPremiumButtonApiError(error) {
  const detail = [error?.message, error?.response?.body?.description, error?.response?.data?.description]
    .filter(Boolean)
    .join(' ');
  return /icon_custom_emoji_id|custom emoji|tg-emoji/i.test(detail);
}

function installPremiumEmojiButtonDecorator() {
  const methods = [
    ['sendMessage', 2, 1], ['editMessageText', 1, 0], ['sendPhoto', 2, null],
    ['editMessageCaption', 1, 0],
    ['sendVideo', 2, null], ['sendAnimation', 2, null], ['sendDocument', 2, null],
    ['sendAudio', 2, null], ['sendVoice', 2, null]
  ];
  for (const [method, optionsIndex, textIndex] of methods) {
    if (typeof bot[method] !== 'function') continue;
    const original = bot[method].bind(bot);
    bot[method] = (...originalArgs) => {
      const args = [...originalArgs];
      const destinationChatId = method.startsWith('edit')
        ? args[optionsIndex]?.chat_id
        : args[0];
      const recordMessageText = isAdmin(destinationChatId);
      if (textIndex !== null && typeof args[textIndex] === 'string') {
        const applied = applyMessageTextOverride(args[textIndex], args[optionsIndex] || {}, 'entities', recordMessageText);
        args[textIndex] = applied.value;
        args[optionsIndex] = applied.options;
      }
      args[optionsIndex] = optionsWithPremiumIcons(args[optionsIndex], recordMessageText);
      if (textIndex !== null && typeof args[textIndex] === 'string' && !args[optionsIndex]?.entities) {
        if (args[optionsIndex]?.parse_mode === 'HTML') {
          args[textIndex] = decoratePremiumHtmlSymbols(args[textIndex]);
        } else {
          const premiumHtml = premiumPlainTextAsHtml(args[textIndex]);
          if (premiumHtml) {
            args[textIndex] = premiumHtml;
            args[optionsIndex] = { ...(args[optionsIndex] || {}), parse_mode: 'HTML' };
          } else {
            args[textIndex] = stripOrdinaryEmojiText(args[textIndex], true);
          }
        }
      }
      return original(...args).catch(error => {
        const textHasPremium = textIndex !== null && /<tg-emoji\b/i.test(String(args[textIndex] || ''));
        const captionHasPremium = /<tg-emoji\b/i.test(String(args[optionsIndex]?.caption || ''));
        if ((!hasPremiumButtons(args[optionsIndex]) && !textHasPremium && !captionHasPremium) || !isPremiumButtonApiError(error)) throw error;
        const retryArgs = [...args];
        retryArgs[optionsIndex] = {
          ...(args[optionsIndex] || {}),
          caption: stripTelegramCustomEmojiHtml(args[optionsIndex]?.caption),
          reply_markup: replyMarkupWithoutPremiumIcons(args[optionsIndex]?.reply_markup)
        };
        if (textIndex !== null) retryArgs[textIndex] = stripTelegramCustomEmojiHtml(args[textIndex]);
        return original(...retryArgs);
      });
    };
  }
  if (typeof bot.answerCallbackQuery === 'function') {
    const originalAnswerCallbackQuery = bot.answerCallbackQuery.bind(bot);
    bot.answerCallbackQuery = (callbackQueryId, options = {}) => originalAnswerCallbackQuery(callbackQueryId, {
      ...options,
      text: typeof options?.text === 'string' ? stripOrdinaryEmojiText(options.text, true).trim() : options?.text
    });
  }
}

installPremiumEmojiButtonDecorator();

function customPaymentEmoji(method) {
  return method?.iconCustomEmojiId
    ? { id: String(method.iconCustomEmojiId), alt: method.iconAlt || '💳' }
    : null;
}

function isAdmin(id) {
  return adminAccess.isAdmin(id);
}

function getAdminIds() {
  return adminAccess.getAdminIds();
}

function currentProductShopId() {
  return network.enabledClient() ? String(config.network.shopId || '') : 'master';
}

function isForeignPublicProduct(product) {
  if (!product) return false;
  const scope = String(product.visibilityScope || (product.type === 'service' ? 'private' : 'public')).toLowerCase();
  if (scope !== 'public' || !product.networkProductId) return false;
  const ownerShopId = String(product.networkOwnerShopId || '').trim();
  if (!ownerShopId) return Boolean(product.networkManaged);
  return ownerShopId !== currentProductShopId();
}

function isPublicProduct(product) {
  return Boolean(product) && String(product.visibilityScope || (product.type === 'service' ? 'private' : 'public')).toLowerCase() === 'public';
}

function canManageNetworkProduct(product) {
  if (!product) return false;
  return !isForeignPublicProduct(product);
}

function networkProductBasePrice(product) {
  const base = Number(product?.networkBasePriceUsd);
  if (Number.isFinite(base) && base >= 0) return base;
  return Number(product?.price || 0);
}

function hasLocalNetworkPriceOverride(product) {
  if (!isPublicProduct(product)) return false;
  const override = Number(product.localPriceOverrideUsd);
  const base = networkProductBasePrice(product);
  return Number.isFinite(override) && override > base + 1e-9;
}

function canEditProductField(product, field) {
  if (['localNameAr', 'localPrice', 'localDescriptionAr', 'localWarrantyAr', 'localImage'].includes(field)) {
    return isPublicProduct(product) && productAccessibleInCurrentShop(product);
  }
  if (canManageNetworkProduct(product)) return true;
  return ['nameAr', 'price'].includes(field) && isForeignPublicProduct(product) && String(product?.type || '') !== 'service';
}

function canContributeStock(product) {
  return Boolean(product && product.isActive !== false && String(product.type || '') !== 'service');
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
  let cleanPlain = manual ? rich.plain.replace(manual[0], '').replace(/\s{2,}/g, ' ').trim() : rich.plain.trim();
  const detected = premiumEmojis.resolveProduct(cleanPlain);
  const canonical = detected?.id && premiumEmojis.isCanonicalPlatformKey(detected.key) ? detected : null;
  if (canonical && rich.firstCustomEmojiAlt) {
    cleanPlain = cleanPlain.replace(rich.firstCustomEmojiAlt, '').replace(/\s{2,}/g, ' ').trim();
  }
  const automatic = !rich.firstCustomEmojiId && !manualId ? detected : null;
  const explicitEmojiId = rich.firstCustomEmojiId || manualId;
  const selectedCanonical = explicitEmojiId ? null : canonical;
  const emojiId = explicitEmojiId || selectedCanonical?.id || automatic?.id || '';
  const emojiAlt = rich.firstCustomEmojiAlt || (manualId ? '✨' : (selectedCanonical?.alt || automatic?.alt || ''));
  let html = rich.html;
  if (selectedCanonical?.id) {
    html = `${premiumEmojiHtml(selectedCanonical)} ${escapeHtml(cleanPlain)}`;
  } else if (manualId && !rich.firstCustomEmojiId) {
    html = `<tg-emoji emoji-id="${escapeHtml(manualId)}">✨</tg-emoji> ${escapeHtml(cleanPlain)}`;
  } else if (automatic?.id) {
    html = `${premiumEmojiHtml(automatic)} ${escapeHtml(cleanPlain)}`;
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
    '💱 العملة', '💱 Currency',
    '🎁 الهدايا والمشاركة', '🎁 Gifts & referrals',
    '📢 قناتنا', '📢 Our channel',
    'شراء رقم افتراضي', 'Buy virtual number',
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

async function cancelActiveState(user, state) {
  if (!state) {
    await clearState(user.id);
    return { serviceRefund: null };
  }
  if (state.action === 'support_chat' && state.ticketId) {
    await SupportTicket.update({ status: 'closed', closedAt: new Date() }, { where: { id: state.ticketId, userId: user.id } });
  }
  let serviceRefund = null;
  if (state.action === 'service_input' && state.orderId) {
    try {
      serviceRefund = await refundServiceOrderToWallet(state.orderId, 'customer_cancelled_service');
    } catch (error) {
      if (!['SERVICE_ORDER_ALREADY_FINALIZED', 'ORDER_NOT_FOUND'].includes(String(error.message || ''))) throw error;
    }
  } else if (state.orderId) {
    await refundWalletReservation(state.orderId).catch(() => {});
  }
  await clearState(user.id);
  return { serviceRefund };
}

async function getOrCreateUser(from) {
  // findOrCreate opens extra transactional work in Sequelize. Existing users are
  // the common path, so a direct primary-key lookup is much faster.
  let user = await User.findByPk(from.id);
  let created = false;
  if (!user) {
    try {
      user = await User.create({
        id: from.id,
        lang: config.defaultLanguage,
        balance: 0,
        verified: true,
        username: from.username || null,
        firstName: from.first_name || '',
        paymentCurrency: null,
        referralProcessed: false
      });
      created = true;
    } catch (error) {
      // Two Telegram updates for a brand-new user can race. The winner creates
      // the row; the other request simply reloads it.
      user = await User.findByPk(from.id);
      if (!user) throw error;
    }
  }
  const changes = {};
  if (user.username !== (from.username || null)) changes.username = from.username || null;
  if (user.firstName !== (from.first_name || '')) changes.firstName = from.first_name || '';
  if (Object.keys(changes).length) await user.update(changes);
  user._createdNow = created;
  return user;
}

function normalizeCustomerPaymentCurrency(value) {
  const code = String(value || '').toUpperCase();
  return ['USD', 'IQD', 'EGP'].includes(code) ? code : '';
}

function customerPaymentCurrencyLabel(currency, lang = 'ar') {
  const code = normalizeCustomerPaymentCurrency(currency);
  if (code === 'USD') return lang === 'en' ? 'US dollar' : 'الدولار';
  if (code === 'EGP') return lang === 'en' ? 'Egyptian pound' : 'الجنيه المصري';
  if (code === 'IQD') return lang === 'en' ? 'Iraqi dinar' : 'الدينار العراقي';
  return lang === 'en' ? 'Not selected' : 'غير محددة';
}

async function showLanguageSelector(chatId) {
  return bot.sendMessage(chatId, [
    '🌐 <b>اختر لغتك</b>',
    '<b>Choose your language</b>'
  ].join('\n'), {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🇮🇶 العربية', callback_data: 'onboard:lang:ar', style: 'primary' }],
        [{ text: '🇬🇧 English', callback_data: 'onboard:lang:en', style: 'primary' }]
      ]
    }
  });
}

async function showCustomerCurrencySelector(chatId, user, after = 'main') {
  const current = normalizeCustomerPaymentCurrency(user?.paymentCurrency);
  const text = user.lang === 'en'
    ? [
        '💱 <b>Choose your account currency</b>',
        '',
        'Product prices and your wallet balance will be shown in the currency you choose.',
        'When paying, all available wallets are shown. Each payment method uses its own currency, while Binance remains USDT/USD.',
        current ? `Current currency: <b>${customerPaymentCurrencyLabel(current, 'en')}</b>` : ''
      ].filter(Boolean).join('\n')
    : [
        '💱 <b>اختَر عملة حسابك</b>',
        '',
        'أسعار المنتجات ورصيد المحفظة راح تظهر بالعملة اللي تختارها.',
        'وقت الدفع تظهر لك كل المحافظ المتاحة، وكل طريقة دفع تستخدم عملتها الخاصة، وBinance يبقى USDT/دولار.',
        current ? `عملتك الحالية: <b>${customerPaymentCurrencyLabel(current, 'ar')}</b>` : ''
      ].filter(Boolean).join('\n');

  return bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: user.lang === 'en' ? '💵 US dollar' : '💵 دولار', callback_data: `currency:set:USD:${after}`, style: current === 'USD' ? 'success' : 'primary' }],
        [{ text: user.lang === 'en' ? '🇮🇶 Iraqi dinar' : '🇮🇶 دينار عراقي', callback_data: `currency:set:IQD:${after}`, style: current === 'IQD' ? 'success' : 'primary' }],
        [{ text: user.lang === 'en' ? '🇪🇬 Egyptian pound' : '🇪🇬 جنيه مصري', callback_data: `currency:set:EGP:${after}`, style: current === 'EGP' ? 'success' : 'primary' }]
      ]
    }
  });
}

function mainKeyboard(lang, showReferrals = true, showChannel = false, showVirtualNumbers = false) {
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
  if (showVirtualNumbers) keyboard.push([
    emojiButton(lang === 'en' ? 'Buy virtual number' : 'شراء رقم افتراضي', PREMIUM_EMOJI.phone)
  ]);
  if (showReferrals) keyboard.push([{ text: lang === 'en' ? '🎁 Gifts & referrals' : '🎁 الهدايا والمشاركة' }]);
  if (showChannel) keyboard.push([{ text: lang === 'en' ? '📢 Our channel' : '📢 قناتنا' }]);
  keyboard.push([
    { text: lang === 'en' ? '💱 Currency' : '💱 العملة' },
    emojiButton('عربي / English', PREMIUM_EMOJI.language)
  ]);
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
    virtualNumbers.enabled() ? virtualNumbers.hasAnyConfiguredProvider().catch(() => false) : false
  ]);
  return mainKeyboard(lang, settings.enabled, Boolean(channel), showVirtualNumbers);
}

function virtualNumberText(lang, ar, en) {
  return lang === 'en' ? en : ar;
}

function virtualNumberStatusLabel(status, lang = 'ar') {
  const labels = {
    reserving: ['جاري الحجز', 'Reserving'],
    waiting_sms: ['بانتظار SMS', 'Waiting for SMS'],
    completed: ['مكتمل', 'Completed'],
    cancelled: ['ملغي', 'Cancelled'],
    auto_cancelled: ['ملغي تلقائياً', 'Auto-cancelled'],
    provider_cancelled: ['ألغاه المزود', 'Cancelled by provider'],
    failed: ['فشل', 'Failed']
  };
  const pair = labels[String(status || '')] || [String(status || '—'), String(status || '—')];
  return lang === 'en' ? pair[1] : pair[0];
}

function canSeeVirtualProviderCost(user) {
  return Boolean(user?.id && isAdmin(user.id));
}

function canManageVirtualProviders(user) {
  // Every admin added to this bot has full local administration rights,
  // including encrypted virtual-number provider API configuration.
  return Boolean(user?.id && isAdmin(user.id));
}

function canManagePremiumEmojis(user) {
  // Use the same single-owner gate as provider secrets. Other admins can use
  // the resulting icons but cannot rewrite the global keyword dictionary.
  return canSeeVirtualProviderCost(user);
}

function providerAdminStatusIcon(status) {
  if (!status?.configured) return '⚠️';
  if (status?.keyValid) return '✅';
  return '❌';
}

function providerBalanceAdminText(status) {
  return Number.isFinite(Number(status?.balance)) ? `$${Number(status.balance).toFixed(2)}` : 'غير معروف';
}

const VIRTUAL_PROVIDER_NAMES = Object.freeze({
  smsbower: 'SMSBower',
  smsman: 'SMS-MAN',
  grizzly: 'GrizzlySMS'
});
const VIRTUAL_PROVIDER_IDS = new Set(Object.keys(VIRTUAL_PROVIDER_NAMES));

function virtualProviderName(providerId) {
  return VIRTUAL_PROVIDER_NAMES[String(providerId || '').toLowerCase()] || 'مزود الأرقام';
}

async function showVirtualProviderAdmin(chatId, user) {
  if (!canManageVirtualProviders(user)) {
    return bot.sendMessage(chatId, '⛔ إعدادات مزودي الأرقام متاحة لأدمنات هذا البوت فقط.');
  }

  let statuses = [];
  let adminRows = [];
  try { [statuses, adminRows] = await Promise.all([
    virtualNumbers.providerStatuses(),
    virtualNumbers.getAllProviderAdminRows()
  ]); }
  catch (error) { console.error('Virtual provider admin statuses:', error.message); }
  const byId = new Map(statuses.map(row => [String(row.id), row]));
  const adminById = new Map(adminRows.map(row => [String(row.id), row]));
  const providers = [...VIRTUAL_PROVIDER_IDS].map(id => ({
    ...(byId.get(id) || { id, name: virtualProviderName(id), configured: false, keyValid: false }),
    ...(adminById.get(id) || {})
  }));

  const serviceLine = status => {
    if (!status?.configured) return 'قائمة الخدمات: ⚪ لم تُفحص';
    if (status?.servicesOk) return `قائمة الخدمات: ✅ تعمل (${Number(status.serviceCount || 0)} خدمة)`;
    if (status?.keyValid) return 'قائمة الخدمات: ⚠️ المفتاح يعمل لكن فحص القائمة غير متاح حالياً';
    return 'قائمة الخدمات: ❌ لم تعمل';
  };

  const lines = [
    '📱 <b>إعدادات مزود الأرقام الافتراضية</b>',
    '',
    `الحالة العامة: ${providers.some(row => row.keyValid) ? '✅ يوجد مزود جاهز للبيع' : '⚠️ يحتاج إعداد API لأحد المزودات'}`
  ];
  const numberLabels = ['1️⃣', '2️⃣', '3️⃣'];
  providers.forEach((status, index) => {
    lines.push(
      '',
      `${numberLabels[index] || `${index + 1}.`} <b>${escapeHtml(virtualProviderName(status.id))}</b>`,
      `• مفتاح الدخول: ${status.configured ? (status.keyValid ? '✅ موجود وصالح' : '❌ موجود لكن الفحص فشل') : '⚠️ غير مضاف'}`,
      `• رابط الـAPI: ${status.baseUrl ? '✅ مضبوط' : '❌ غير مضبوط'}`,
      `• الرصيد بالموقع: <b>${escapeHtml(providerBalanceAdminText(status))}</b>`,
      `• ${serviceLine(status)}`,
      `• الربح لكل رقم: <b>${virtualRetailPriceText(status.profit ?? 0.15)}</b>`,
      `• الطلبات: شراء ${Number(status.purchased || 0)} | مكتمل ${Number(status.completed || 0)} | نشط ${Number(status.active || 0)}`
    );
  });
  lines.push('', 'مفاتيح API لا تُعرض هنا نهائياً، والزر يحفظ المفتاح مشفراً ويحذف رسالتك بعد قراءتها.');

  const providerButtons = providers.map(status => [
    { text: status.configured ? `تغيير API ${virtualProviderName(status.id)}` : `إضافة API ${virtualProviderName(status.id)}`, callback_data: `adm:vnprovider:key:${status.id}`, style: 'primary' },
    { text: `ربح ${virtualProviderName(status.id)}`, callback_data: `adm:vnprovider:profit:${status.id}`, style: 'success' }
  ]);
  const deleteButtons = providers.map(status => [
    { text: `حذف API ${virtualProviderName(status.id)}`, callback_data: `adm:vnprovider:clear:${status.id}`, style: 'danger' }
  ]);

  return bot.sendMessage(chatId, lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [
      ...providerButtons,
      [{ text: '💰 شحن SMSBower', callback_data: 'adm:vnprovider:topup:smsbower', style: 'success' }],
      [{ text: 'فحص المزودات', callback_data: 'adm:vnprovider:test', style: 'primary' }],
      ...deleteButtons,
      [{ text: '⬅️ رجوع لإعدادات المتجر', callback_data: 'adm:menu:settings' }]
    ] }
  });
}

function customEmojiFromMessage(msg) {
  const text = String(msg?.text || '').trim();
  const rich = extractTelegramRichText(text, msg?.entities || []);
  const manual = text.match(/(?:\[\s*)?(\d{5,24})(?:\s*\])?/);
  const emojiId = String(rich.firstCustomEmojiId || manual?.[1] || '');
  return {
    emojiId: premiumEmojis.validEmojiId(emojiId) ? emojiId : '',
    alt: String(rich.firstCustomEmojiAlt || '✨').slice(0, 16) || '✨'
  };
}

async function showPremiumEmojiAdmin(chatId, user, page = 0) {
  if (!canManagePremiumEmojis(user)) {
    return bot.sendMessage(chatId, '⛔ إعدادات الإيموجيات المميزة متاحة لأدمنات هذا البوت فقط.');
  }
  const custom = premiumEmojis.listCustom();
  const textOverrides = uiTextOverrides.list();
  const pageSize = 10;
  const pages = Math.max(1, Math.ceil(custom.length / pageSize));
  const safePage = Math.max(0, Math.min(pages - 1, Number(page) || 0));
  const visible = custom.slice(safePage * pageSize, safePage * pageSize + pageSize);
  const lines = [
    `${premiumEmojiHtml(PREMIUM_EMOJI.settings)} <b>الإيموجيات المميزة — للمالك فقط</b>`,
    '',
    `القاموس الأساسي: <b>${premiumEmojis.builtInCount()}</b> ربطاً ثنائياً جاهزاً.`,
    `الروابط التي أضفتها: <b>${custom.length}</b>.`,
    `النصوص والأزرار التي عدّلتها: <b>${textOverrides.length}</b>.`,
    '',
    'عند إضافة منتج أو خدمة، أو عند ظهور اسم معروف في زر، يختار البوت الإيموجي تلقائياً بالعربي والإنجليزي.',
    'أرسل الاسم العربي فقط؛ الترجمة الإنجليزية تُنشأ وتحفظ تلقائياً. إذا كان الاسم موجوداً مسبقاً فسيُحدَّث ربطه بالإيموجي الجديد.',
    'أي ربط تحفظه هنا يتزامن تلقائياً مع جميع بوتات الشبكة خلال 30 ثانية.'
  ];
  if (visible.length) {
    lines.push('', '<b>روابطك المخصصة:</b>');
    for (const entry of visible) {
      lines.push(`${premiumEmojiHtml({ id: entry.emojiId, alt: entry.alt })} ${escapeHtml(entry.keywordAr)} ↔ ${escapeHtml(entry.keywordEn || '—')}`);
    }
  }

  const keyboard = [
    [emojiButton('إضافة أو تغيير ربط', PREMIUM_EMOJI.add, { callback_data: 'adm:emoji:add', style: 'success' })],
    [emojiButton('مراجعة إيموجيات المنتجات', PREMIUM_EMOJI.search, { callback_data: 'adm:emoji:repairproducts', style: 'primary' })],
    [emojiButton('البحث عن نص أو زر', PREMIUM_EMOJI.search, { callback_data: 'adm:uitext:search', style: 'primary' })],
    [emojiButton('النصوص والأزرار المعدلة', PREMIUM_EMOJI.edit, { callback_data: 'adm:uitext:list:0', style: 'primary' })]
  ];
  for (const entry of visible) {
    keyboard.push([emojiButton(`حذف ${entry.keywordAr}`.slice(0, 48), PREMIUM_EMOJI.delete, {
      callback_data: `adm:emoji:askdel:${entry.id}:${safePage}`,
      style: 'danger'
    })]);
  }
  if (pages > 1) {
    const nav = [];
    if (safePage > 0) nav.push({ text: '⬅️', callback_data: `adm:emoji:page:${safePage - 1}` });
    nav.push({ text: `${safePage + 1}/${pages}`, callback_data: 'noop:emojipage' });
    if (safePage < pages - 1) nav.push({ text: '➡️', callback_data: `adm:emoji:page:${safePage + 1}` });
    keyboard.push(nav);
  }
  keyboard.push([{ text: '⬅️ رجوع لإعدادات المتجر', callback_data: 'adm:menu:settings' }]);
  return bot.sendMessage(chatId, lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
}

function uiTextKindLabel(kind) {
  return kind === 'button' ? 'زر' : 'نص رسالة';
}

function uiTextPreview(value, limit = 150) {
  const text = String(value || '').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function currentUiTextCandidate(state) {
  const ids = Array.isArray(state?.data?.candidateIds) ? state.data.candidateIds : [];
  const index = Math.max(0, Number(state?.data?.candidateIndex || 0));
  return uiTextOverrides.findCandidate(ids[index]);
}

async function showUiTextCandidate(chatId, state) {
  const candidate = currentUiTextCandidate(state);
  if (!candidate) {
    await setState(chatId, { action: 'admin_ui_text_edit', step: 'query', data: {} });
    return bot.sendMessage(chatId, 'انتهت النتائج المتاحة. أرسل كلمة أخرى للبحث، أو اكتب إغلاق للإلغاء.', {
      reply_markup: cancelInlineKeyboard()
    });
  }
  const total = Array.isArray(state?.data?.candidateIds) ? state.data.candidateIds.length : 1;
  const index = Math.max(0, Number(state?.data?.candidateIndex || 0));
  const lines = [
    `${premiumEmojiHtml(PREMIUM_EMOJI.search)} <b>هل أنت تبحث عن هذا؟</b>`,
    '',
    `النوع: <b>${uiTextKindLabel(candidate.kind)}</b> — النتيجة ${index + 1}/${total}`,
    `<blockquote>${escapeHtml(candidate.plainText)}</blockquote>`
  ];
  if (candidate.override) {
    lines.push('', '<b>شكله المعدل حالياً:</b>', `<blockquote>${escapeHtml(candidate.override.replacementText)}</blockquote>`);
  }
  lines.push('', 'اكتب <b>نعم</b> لاختياره، أو اكتب <b>التالي</b> لرؤية النتيجة التالية.');
  return bot.sendMessage(chatId, lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[
      emojiButton('نعم، هذا هو', PREMIUM_EMOJI.success, { callback_data: 'adm:uitext:yes', style: 'success' }),
      emojiButton('التالي', PREMIUM_EMOJI.search, { callback_data: 'adm:uitext:next', style: 'primary' })
    ], [{ text: 'إغلاق', callback_data: 'flow:cancel', style: 'danger' }]] }
  });
}

async function selectCurrentUiTextCandidate(user, state) {
  const candidate = currentUiTextCandidate(state);
  if (!candidate) {
    await setState(user.id, { action: 'admin_ui_text_edit', step: 'query', data: {} });
    return bot.sendMessage(user.id, 'هذه النتيجة لم تعد متاحة. أرسل كلمة أخرى للبحث.', {
      reply_markup: cancelInlineKeyboard()
    });
  }
  await setState(user.id, {
    action: 'admin_ui_text_edit',
    step: 'replacement',
    data: { selectedId: candidate.id }
  });
  return bot.sendMessage(user.id, [
    `${premiumEmojiHtml(PREMIUM_EMOJI.edit)} <b>تعديل ${uiTextKindLabel(candidate.kind)}</b>`,
    '',
    '<b>النص الكامل الحالي:</b>',
    `<blockquote>${escapeHtml(candidate.plainText)}</blockquote>`,
    '',
    'أرسل الآن النص أو الاسم الجديد كاملاً.',
    'تستطيع وضع Custom Emoji مميز مع النص، أو كتابة معرّفه هكذا: <code>[5796637619601283518] النص الجديد</code>.',
    'إذا أرسلت الإيموجي وحده، سيبقى النص الحالي كما هو ويتغير الإيموجي فقط.',
    'اكتب إغلاق للإلغاء.'
  ].join('\n'), { parse_mode: 'HTML', reply_markup: cancelInlineKeyboard() });
}

async function nextUiTextCandidate(user, state) {
  const ids = Array.isArray(state?.data?.candidateIds) ? state.data.candidateIds : [];
  const nextIndex = Number(state?.data?.candidateIndex || 0) + 1;
  if (nextIndex >= ids.length) {
    await setState(user.id, { action: 'admin_ui_text_edit', step: 'query', data: {} });
    return bot.sendMessage(user.id, 'لا توجد نتيجة أخرى. أرسل كلمة مختلفة أو جزءاً آخر من النص للبحث من جديد.', {
      reply_markup: cancelInlineKeyboard()
    });
  }
  const nextState = {
    action: 'admin_ui_text_edit',
    step: 'confirm',
    data: { ...state.data, candidateIndex: nextIndex }
  };
  await setState(user.id, nextState);
  return showUiTextCandidate(user.id, nextState);
}

async function showUiTextOverridesAdmin(chatId, user, page = 0) {
  if (!canManagePremiumEmojis(user)) {
    return bot.sendMessage(chatId, 'إعدادات النصوص والأزرار متاحة لأدمنات هذا البوت فقط.');
  }
  const rows = uiTextOverrides.list();
  const pageSize = 7;
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.max(0, Math.min(pages - 1, Number(page) || 0));
  const visible = rows.slice(safePage * pageSize, safePage * pageSize + pageSize);
  const lines = [
    `${premiumEmojiHtml(PREMIUM_EMOJI.edit)} <b>النصوص والأزرار المعدلة</b>`,
    '',
    `عدد التعديلات: <b>${rows.length}</b>.`,
    'حذف تعديل يعيد النص الأصلي فقط، ولا يحذف منتجاً أو طلباً أو مخزوناً.'
  ];
  if (!visible.length) lines.push('', 'لا توجد تعديلات محفوظة بعد.');
  for (const row of visible) {
    const icon = row.emojiId ? `${premiumEmojiHtml({ id: row.emojiId, alt: row.emojiAlt })} ` : '';
    lines.push(
      '',
      `<b>${uiTextKindLabel(row.kind)}:</b> ${escapeHtml(uiTextPreview(row.originalPlainText))}`,
      `← ${icon}${escapeHtml(uiTextPreview(row.replacementText))}`
    );
  }
  const keyboard = visible.map(row => [emojiButton(
    `إلغاء تعديل ${row.replacementText}`.slice(0, 52),
    PREMIUM_EMOJI.delete,
    { callback_data: `adm:uitext:askdel:${row.id}:${safePage}`, style: 'danger' }
  )]);
  if (pages > 1) {
    const nav = [];
    if (safePage > 0) nav.push({ text: 'السابق', callback_data: `adm:uitext:list:${safePage - 1}` });
    nav.push({ text: `${safePage + 1}/${pages}`, callback_data: 'noop:uitextpage' });
    if (safePage < pages - 1) nav.push({ text: 'التالي', callback_data: `adm:uitext:list:${safePage + 1}` });
    keyboard.push(nav);
  }
  keyboard.push([emojiButton('بحث جديد', PREMIUM_EMOJI.search, { callback_data: 'adm:uitext:search', style: 'primary' })]);
  keyboard.push([{ text: 'رجوع إلى الإيموجيات المميزة', callback_data: 'adm:emoji:0' }]);
  return bot.sendMessage(chatId, lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
}

function virtualRetailPriceText(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount) || amount < 0) return '$0.0000';
  const needsFourDecimals = amount < 1 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-9;
  return `$${amount.toFixed(needsFourDecimals ? 4 : 2)}`;
}

function virtualProviderCostText(providerCost, retail) {
  const provider = Number(providerCost || 0);
  const providerText = Number.isFinite(provider) && provider >= 0 ? provider.toFixed(4) : '0.0000';
  return `$${providerText} 👈🏻 ${virtualRetailPriceText(retail)}`;
}

const VIRTUAL_SERVICE_AR_NAMES = new Map([
  ['whatsapp', 'واتساب'], ['telegram', 'تيليجرام'], ['facebook', 'فيسبوك'],
  ['instagram', 'إنستغرام'], ['google', 'جوجل'], ['gmail', 'جيميل'],
  ['tiktok', 'تيك توك'], ['twitter', 'تويتر'], ['x.com', 'إكس'],
  ['microsoft', 'مايكروسوفت'], ['apple', 'آبل'], ['amazon', 'أمازون'],
  ['netflix', 'نتفلكس'], ['discord', 'ديسكورد'], ['steam', 'ستيم'],
  ['uber', 'أوبر'], ['openai', 'أوبن أي آي'], ['chatgpt', 'شات جي بي تي'],
  ['snapchat', 'سناب شات'], ['linkedin', 'لينكدإن'], ['yahoo', 'ياهو'],
  ['viber', 'فايبر'], ['wechat', 'وي تشات'], ['kakaotalk', 'كاكاو توك'],
  ['line', 'لاين'], ['paypal', 'باي بال'], ['binance', 'بايننس'],
  ['coinbase', 'كوين بيس'], ['tinder', 'تندر'], ['bumble', 'بامبل'],
  ['airbnb', 'إير بي إن بي'], ['booking', 'بوكينغ'], ['glovo', 'غلوفو'],
  ['bolt', 'بولت'], ['foodpanda', 'فود باندا'], ['aliexpress', 'علي إكسبريس'],
  ['temu', 'تيمو'], ['shein', 'شي إن'], ['canva', 'كانفا'],
  ['capcut', 'كاب كات'], ['gemini', 'جيميني'], ['signal', 'سيغنال'],
  ['protonmail', 'بروتون ميل'], ['proton', 'بروتون'], ['outlook', 'أوتلوك'],
  ['ebay', 'إيباي'], ['pinterest', 'بنترست'], ['reddit', 'ريديت'],
  ['spotify', 'سبوتيفاي'], ['twitch', 'تويتش'], ['imo', 'إيمو'],
  ['any other', 'أي رقم']
]);

const VIRTUAL_SERVICE_CODE_AR = new Map([
  ['wa', 'واتساب'], ['tg', 'تيليجرام'], ['fb', 'فيسبوك'], ['ig', 'إنستغرام'],
  ['go', 'جوجل'], ['gm', 'جيميل'], ['tw', 'تويتر'], ['ds', 'ديسكورد']
]);

const VIRTUAL_POPULAR_SERVICE_GROUPS = [
  ['google', 'gmail', 'youtube'],
  ['telegram'],
  ['whatsapp'],
  ['netflix'],
  ['instagram'],
  ['facebook'],
  ['tiktok'],
  ['openai', 'chatgpt'],
  ['apple'],
  ['amazon'],
  ['microsoft'],
  ['snapchat'],
  ['discord'],
  ['paypal'],
  ['twitter', 'x.com'],
  ['uber']
];

function isAnyOtherVirtualService(service) {
  const name = normalizeVirtualSearch(service?.name || '');
  const code = String(service?.code || '').trim().toLowerCase();
  return name === 'any other' || name.includes('any other') || code === 'ot';
}

function findAnyOtherVirtualService(services = []) {
  return services.find(isAnyOtherVirtualService) || null;
}

function virtualServiceMatchesTokens(service, tokens = []) {
  const name = normalizeVirtualSearch(service?.name || '');
  const code = normalizeVirtualSearch(service?.code || '');
  return tokens.some(token => {
    const normalized = normalizeVirtualSearch(token);
    return name === normalized || name.includes(normalized) || code === normalized;
  });
}

function selectPopularVirtualServices(services = [], summary = []) {
  const available = new Map(summary.map(row => [String(row.serviceCode), row]));
  const used = new Set();
  const out = [];
  for (const tokens of VIRTUAL_POPULAR_SERVICE_GROUPS) {
    const candidates = services.filter(service => !used.has(service.code) && available.has(String(service.code)) && virtualServiceMatchesTokens(service, tokens));
    if (!candidates.length) continue;
    candidates.sort((a, b) => {
      const aa = available.get(String(a.code));
      const bb = available.get(String(b.code));
      return Number(aa?.retailPrice || Infinity) - Number(bb?.retailPrice || Infinity) || String(a.name).localeCompare(String(b.name), 'en');
    });
    const picked = candidates[0];
    used.add(picked.code);
    out.push({ ...picked, availabilitySummary: available.get(String(picked.code)) });
  }
  return out;
}

const virtualServiceArabicCache = new Map();
let countryIsoLookupCache = null;
let countryDisplayEn = null;
let countryDisplayAr = null;

function normalizeVirtualSearch(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function knownVirtualServiceArabic(service) {
  const code = String(service?.code || '').trim().toLowerCase();
  if (VIRTUAL_SERVICE_CODE_AR.has(code)) return VIRTUAL_SERVICE_CODE_AR.get(code);
  const normalizedName = normalizeVirtualSearch(service?.name || '');
  for (const [needle, ar] of VIRTUAL_SERVICE_AR_NAMES.entries()) {
    if (normalizedName === needle || normalizedName.includes(needle)) return ar;
  }
  return '';
}

function trimVirtualLabel(value, max = 44) {
  const name = String(value || '').trim();
  return name.length > max ? `${name.slice(0, max - 3)}…` : name;
}

async function virtualServiceDisplayName(service, lang = 'en') {
  const english = String(service?.name || service?.code || '').trim();
  if (isAnyOtherVirtualService(service)) return lang === 'en' ? 'Any number' : 'أي رقم';
  if (lang === 'en' || looksArabic(english)) return trimVirtualLabel(english);
  const known = knownVirtualServiceArabic(service);
  if (known) return trimVirtualLabel(known);
  const cacheKey = `${service?.code || ''}:${english}`;
  if (virtualServiceArabicCache.has(cacheKey)) return trimVirtualLabel(virtualServiceArabicCache.get(cacheKey));
  let translated = english;
  try { translated = await translateEnToAr(english); } catch {}
  if (!translated || !looksArabic(translated)) translated = english;
  virtualServiceArabicCache.set(cacheKey, translated);
  if (virtualServiceArabicCache.size > 500) virtualServiceArabicCache.delete(virtualServiceArabicCache.keys().next().value);
  return trimVirtualLabel(translated);
}

function buildCountryIsoLookup() {
  if (countryIsoLookupCache) return countryIsoLookupCache;
  countryDisplayEn = new Intl.DisplayNames(['en'], { type: 'region' });
  countryDisplayAr = new Intl.DisplayNames(['ar'], { type: 'region' });
  const map = new Map();
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const iso = String.fromCharCode(a, b);
      const name = countryDisplayEn.of(iso);
      if (name && name !== iso && !/^unknown region/i.test(name)) map.set(normalizeVirtualSearch(name), iso);
    }
  }
  const aliases = {
    'usa': 'US', 'u s a': 'US', 'united states of america': 'US',
    'uk': 'GB', 'u k': 'GB', 'england': 'GB', 'great britain': 'GB',
    'uae': 'AE', 'u a e': 'AE', 'emirates': 'AE',
    'russia': 'RU', 'south korea': 'KR', 'republic of korea': 'KR', 'north korea': 'KP',
    'czech republic': 'CZ', 'ivory coast': 'CI', 'cote d ivoire': 'CI',
    'cape verde': 'CV', 'swaziland': 'SZ', 'moldova': 'MD',
    'bolivia': 'BO', 'tanzania': 'TZ', 'venezuela': 'VE', 'syria': 'SY',
    'laos': 'LA', 'vietnam': 'VN', 'brunei': 'BN', 'macao': 'MO', 'macau': 'MO',
    'palestine': 'PS', 'taiwan': 'TW', 'hong kong': 'HK',
    'dr congo': 'CD', 'd r congo': 'CD', 'democratic republic of congo': 'CD',
    'congo drc': 'CD', 'congo': 'CG', 'iran': 'IR', 'turkey': 'TR',
    'east timor': 'TL', 'timor leste': 'TL', 'reunion': 'RE'
  };
  for (const [name, iso] of Object.entries(aliases)) map.set(normalizeVirtualSearch(name), iso);
  countryIsoLookupCache = map;
  return map;
}

function virtualCountryIso(countryName) {
  return buildCountryIsoLookup().get(normalizeVirtualSearch(countryName)) || '';
}

function countryFlagFromIso(iso) {
  const code = String(iso || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return '🌍';
  return [...code].map(char => String.fromCodePoint(127397 + char.charCodeAt(0))).join('');
}

function localizedVirtualCountry(countryName, lang = 'en') {
  const english = String(countryName || '').trim();
  const iso = virtualCountryIso(english);
  const flag = countryFlagFromIso(iso);
  if (lang === 'en' || !iso) return { name: english, flag, iso };
  const arabic = countryDisplayAr?.of(iso) || english;
  return { name: arabic, flag, iso };
}

async function searchVirtualServices(services, rawQuery) {
  const original = normalizeVirtualSearch(rawQuery);
  const anyAliases = new Set(['any number', 'any other', 'اي رقم', 'أي رقم', 'اي خدمه', 'أي خدمة'].map(normalizeVirtualSearch));
  if (anyAliases.has(original)) return services.filter(isAnyOtherVirtualService);
  let translated = original;
  if (looksArabic(rawQuery)) {
    try { translated = normalizeVirtualSearch(await translateArToEn(rawQuery)); } catch {}
  }
  return services.filter(service => {
    const english = normalizeVirtualSearch(service.name || '');
    const code = normalizeVirtualSearch(service.code || '');
    const knownAr = normalizeVirtualSearch(knownVirtualServiceArabic(service));
    return [english, code, knownAr].some(value => value && (value.includes(original) || (translated && value.includes(translated))));
  });
}

function searchVirtualCountries(rows, rawQuery) {
  const needle = normalizeVirtualSearch(rawQuery);
  return rows.filter(row => {
    const localized = localizedVirtualCountry(row.countryName, 'ar');
    const english = normalizeVirtualSearch(row.countryName);
    const arabic = normalizeVirtualSearch(localized.name);
    const iso = normalizeVirtualSearch(localized.iso);
    return [english, arabic, iso].some(value => value && value.includes(needle));
  });
}

async function showVirtualNumbersHome(chatId, user) {
  if (!virtualNumbers.enabled()) {
    return bot.sendMessage(chatId, virtualNumberText(user.lang,
      '❌ خدمة الأرقام الافتراضية غير مفعلة حالياً.',
      '❌ Virtual numbers are not enabled right now.'));
  }
  const [providers, fresh] = await Promise.all([
    virtualNumbers.getConfiguredProviders(),
    User.findByPk(user.id)
  ]);
  if (!providers.length) {
    return bot.sendMessage(chatId, virtualNumberText(user.lang,
      '❌ خدمة الأرقام غير متوفرة حالياً. لم تتم تهيئة أي موقع مزود بعد.',
      '❌ Virtual numbers are unavailable right now. No provider is configured yet.'));
  }
  const keyboard = providers.map((provider, index) => [{
    text: user.lang === 'en' ? provider.publicLabelEn : provider.publicLabelAr,
    callback_data: `vn:p:${provider.id}`,
    style: index === 0 ? 'success' : 'primary'
  }]);
  keyboard.push([
    { text: user.lang === 'en' ? '🧾 My orders' : '🧾 طلباتي', callback_data: 'vn:orders' },
    { text: user.lang === 'en' ? '💳 Wallet' : '💳 المحفظة', callback_data: 'vn:wallet' }
  ]);
  return bot.sendMessage(chatId, user.lang === 'en'
    ? `📱 <b>Buy a virtual number</b>\n💰 Wallet balance: <b>${moneyUsd(Number(fresh?.balance || 0))}</b>\n\nChoose a service:`
    : `📱 <b>شراء رقم افتراضي</b>\n💰 رصيد محفظتك: <b>${moneyUsd(Number(fresh?.balance || 0))}</b>\n\nاختر الخدمة:`, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function showVirtualServices(chatId, user, providerId, page = 0, filtered = null, options = {}) {
  const publicProvider = await virtualNumbers.getPublicProvider(providerId);
  if (!publicProvider) return showVirtualNumbersHome(chatId, user);
  const [allServices, summary] = await Promise.all([
    virtualNumbers.listServices(providerId),
    virtualNumbers.availableServicesSummary(providerId).catch(() => [])
  ]);

  // The front page intentionally shows only well-known services. Everything
  // else remains reachable through bilingual search.
  let services;
  if (Array.isArray(filtered)) {
    const availableCodes = new Set(summary.map(row => String(row.serviceCode)));
    services = filtered.filter(service => availableCodes.has(String(service.code)));
  } else {
    services = selectPopularVirtualServices(allServices, summary);
  }

  const pageSize = 12;
  const pages = Math.max(1, Math.ceil(services.length / pageSize));
  const safePage = Math.max(0, Math.min(pages - 1, Number(page) || 0));
  const rows = services.slice(safePage * pageSize, safePage * pageSize + pageSize);
  const labels = await Promise.all(rows.map(service => virtualServiceDisplayName(service, user.lang)));
  const summaryByCode = new Map(summary.map(row => [String(row.serviceCode), row]));
  const keyboard = rows.map((service, index) => [{
    text: `📲 ${labels[index]}${summaryByCode.has(String(service.code)) ? ` • ${virtualRetailPriceText(summaryByCode.get(String(service.code)).retailPrice)}` : ''}`,
    callback_data: `vn:svc:${providerId}:${service.code}`,
    style: 'primary'
  }]);

  if (pages > 1) {
    const nav = [];
    if (safePage > 0) nav.push({ text: '⬅️', callback_data: `vn:services:${providerId}:${safePage - 1}` });
    nav.push({ text: `${safePage + 1}/${pages}`, callback_data: 'noop:vnpage' });
    if (safePage < pages - 1) nav.push({ text: '➡️', callback_data: `vn:services:${providerId}:${safePage + 1}` });
    keyboard.push(nav);
  }
  keyboard.push([{ text: user.lang === 'en' ? '💸 Cheapest numbers now' : '💸 أرخص الأرقام الآن', callback_data: `vn:cheap:${providerId}:0`, style: 'success' }]);
  keyboard.push([{ text: user.lang === 'en' ? '🔎 Search all services' : '🔎 البحث في كل الخدمات', callback_data: `vn:search:${providerId}` }]);
  keyboard.push([
    { text: user.lang === 'en' ? '🧾 My orders' : '🧾 طلباتي', callback_data: 'vn:orders' },
    { text: user.lang === 'en' ? '💳 Wallet' : '💳 المحفظة', callback_data: 'vn:wallet' }
  ]);
  keyboard.push([{ text: user.lang === 'en' ? '⬅️ Change service' : '⬅️ تغيير الخدمة', callback_data: 'vn:home' }]);

  const title = user.lang === 'en'
    ? [
        `📱 <b>${escapeHtml(publicProvider.publicLabelEn)}</b>`,
        '',
        '<b>Popular services</b>',
        'Only popular services are shown here. Use search for every other service; search accepts English and Arabic.'
      ].filter(Boolean).join('\n')
    : [
        `📱 <b>${escapeHtml(publicProvider.publicLabelAr)}</b>`,
        '',
        '<b>الخدمات المشهورة</b>',
        'هنا تظهر الخدمات الدارجة فقط. باقي الخدمات موجودة بالبحث، والبحث يقبل العربي والإنجليزي.'
      ].filter(Boolean).join('\n');
  return bot.sendMessage(chatId, title, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function showCheapestVirtualServices(chatId, user, providerId, page = 0) {
  const publicProvider = await virtualNumbers.getPublicProvider(providerId);
  if (!publicProvider) return showVirtualNumbersHome(chatId, user);
  const [services, summary] = await Promise.all([
    virtualNumbers.listServices(providerId),
    virtualNumbers.availableServicesSummary(providerId, true)
  ]);
  const serviceByCode = new Map(services.map(service => [String(service.code), service]));
  const available = summary
    .map(quote => ({ service: serviceByCode.get(String(quote.serviceCode)), quote }))
    .filter(row => row.service && Number(row.quote.count) > 0 && Number.isFinite(Number(row.quote.retailPrice)))
    .sort((a, b) => Number(a.quote.retailPrice) - Number(b.quote.retailPrice)
      || Number(a.quote.providerCost) - Number(b.quote.providerCost)
      || String(a.service.name).localeCompare(String(b.service.name), 'en'));

  if (!available.length) {
    return bot.sendMessage(chatId, virtualNumberText(user.lang,
      'لا توجد أرقام متوفرة من هذه الخدمة في هذه اللحظة. جرّب التحديث بعد قليل.',
      'No numbers are available from this service at this moment. Try refreshing shortly.'), {
      reply_markup: { inline_keyboard: [[{ text: user.lang === 'en' ? '⬅️ Popular services' : '⬅️ الخدمات المشهورة', callback_data: `vn:p:${providerId}` }]] }
    });
  }

  const pageSize = 10;
  const pages = Math.max(1, Math.ceil(available.length / pageSize));
  const safePage = Math.max(0, Math.min(pages - 1, Number(page) || 0));
  const slice = available.slice(safePage * pageSize, safePage * pageSize + pageSize);
  const labels = await Promise.all(slice.map(row => virtualServiceDisplayName(row.service, user.lang)));
  const keyboard = slice.map((row, index) => [{
    text: `📲 ${labels[index]} • ${virtualRetailPriceText(row.quote.retailPrice)} • ${row.quote.count}`,
    callback_data: `vn:svc:${providerId}:${row.service.code}`,
    style: 'success'
  }]);
  if (pages > 1) {
    const nav = [];
    if (safePage > 0) nav.push({ text: '⬅️', callback_data: `vn:cheap:${providerId}:${safePage - 1}` });
    nav.push({ text: `${safePage + 1}/${pages}`, callback_data: 'noop:vncheap' });
    if (safePage < pages - 1) nav.push({ text: '➡️', callback_data: `vn:cheap:${providerId}:${safePage + 1}` });
    keyboard.push(nav);
  }
  keyboard.push([{ text: user.lang === 'en' ? '🔄 Refresh prices' : '🔄 تحديث الأسعار', callback_data: `vn:cheap:${providerId}:${safePage}` }]);
  keyboard.push([{ text: user.lang === 'en' ? '🔎 Search all services' : '🔎 البحث في كل الخدمات', callback_data: `vn:search:${providerId}` }]);
  keyboard.push([{ text: user.lang === 'en' ? '⬅️ Popular services' : '⬅️ الخدمات المشهورة', callback_data: `vn:p:${providerId}` }]);

  return bot.sendMessage(chatId, user.lang === 'en'
    ? `💸 <b>Cheapest available numbers</b>\nPrices are ordered live from cheapest to highest. The shown sale price includes your configured margin.`
    : `💸 <b>أرخص الأرقام المتوفرة</b>\nالأسعار مرتبة مباشرة من الأرخص إلى الأغلى. سعر البيع الظاهر يتضمن هامش الربح الذي ضبطته.`, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function showVirtualCountries(chatId, user, providerId, serviceCode, page = 0, options = {}) {
  const publicProvider = await virtualNumbers.getPublicProvider(providerId);
  if (!publicProvider) return showVirtualNumbersHome(chatId, user);
  const services = await virtualNumbers.listServices(providerId);
  let service = services.find(row => row.code === String(serviceCode));
  if (!service) {
    const anyService = findAnyOtherVirtualService(services);
    if (anyService && !options.noFallback) {
      await bot.sendMessage(chatId, virtualNumberText(user.lang,
        '🔄 الخدمة المطلوبة غير موجودة حالياً، لذلك عرضت لك خيار <b>أي رقم</b> المتوفر.',
        '🔄 The requested service is not available, so here is the available <b>Any number</b> option.'), { parse_mode: 'HTML' });
      return showVirtualCountries(chatId, user, providerId, anyService.code, 0, { noFallback: true });
    }
    return bot.sendMessage(chatId, virtualNumberText(user.lang, 'الخدمة غير متاحة حالياً. جرّب البحث عن خدمة ثانية.', 'This service is unavailable right now. Try another search.'));
  }

  const serviceName = await virtualServiceDisplayName(service, user.lang);
  const availability = await virtualNumbers.availabilityForService(providerId, service.code, true);
  if (!availability.length) {
    const anyService = findAnyOtherVirtualService(services);
    if (anyService && String(anyService.code) !== String(service.code) && !options.noFallback) {
      await bot.sendMessage(chatId, virtualNumberText(user.lang,
        `🔄 ما ظهر خيار جاهز لـ <b>${premiumLabelHtml(serviceName)}</b>، لذلك حولتك إلى <b>أي رقم</b> مع الأسعار المتوفرة.`,
        `🔄 No ready option is available for <b>${premiumLabelHtml(serviceName)}</b>, so here is <b>Any number</b> with current prices.`), { parse_mode: 'HTML' });
      return showVirtualCountries(chatId, user, providerId, anyService.code, 0, { noFallback: true });
    }
    return bot.sendMessage(chatId, virtualNumberText(user.lang,
      '🔄 التوفر تغير للتو. ارجع للبحث واختر خياراً آخر من القائمة المحدثة.',
      '🔄 Availability just changed. Go back to search and choose another current option.'), {
      reply_markup: { inline_keyboard: [[{ text: user.lang === 'en' ? '🔎 Search services' : '🔎 بحث الخدمات', callback_data: `vn:search:${providerId}` }]] }
    });
  }

  const pageSize = 8;
  const pages = Math.max(1, Math.ceil(availability.length / pageSize));
  const safePage = Math.max(0, Math.min(pages - 1, Number(page) || 0));
  const slice = availability.slice(safePage * pageSize, safePage * pageSize + pageSize);
  const showProviderCost = canSeeVirtualProviderCost(user);
  const keyboard = slice.map(row => {
    const country = localizedVirtualCountry(row.countryName, user.lang);
    const priceText = showProviderCost
      ? virtualProviderCostText(row.providerCost, row.retailPrice)
      : virtualRetailPriceText(row.retailPrice);
    return [{
      text: `${country.flag} ${country.name} • ${priceText} • ${row.count}`,
      callback_data: `vn:quote:${providerId}:${service.code}:${row.countryId}`,
      style: 'primary'
    }];
  });
  const nav = [];
  if (safePage > 0) nav.push({ text: '⬅️', callback_data: `vn:countries:${providerId}:${service.code}:${safePage - 1}` });
  nav.push({ text: `${safePage + 1}/${pages}`, callback_data: 'noop:vncountry' });
  if (safePage < pages - 1) nav.push({ text: '➡️', callback_data: `vn:countries:${providerId}:${service.code}:${safePage + 1}` });
  keyboard.push(nav);
  keyboard.push([{ text: user.lang === 'en' ? '🔎 Search country' : '🔎 بحث عن دولة', callback_data: `vn:countrysearch:${providerId}:${service.code}` }]);
  keyboard.push([{ text: user.lang === 'en' ? '🔄 Refresh' : '🔄 تحديث', callback_data: `vn:countries:${providerId}:${service.code}:${safePage}` }]);
  keyboard.push([{ text: user.lang === 'en' ? '⬅️ Popular services' : '⬅️ الخدمات المشهورة', callback_data: `vn:p:${providerId}` }]);
  return bot.sendMessage(chatId, user.lang === 'en'
    ? `📲 <b>${premiumLabelHtml(serviceName)}</b>
Available options are already filtered and ordered from cheapest to most expensive.`
    : `📲 <b>${premiumLabelHtml(serviceName)}</b>
الخيارات هنا مفلترة مسبقاً حسب المتوفر ومرتبة من الأرخص إلى الأغلى.`, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function showVirtualQuote(chatId, user, providerId, serviceCode, countryId) {
  const [publicProvider, services, quote] = await Promise.all([
    virtualNumbers.getPublicProvider(providerId),
    virtualNumbers.listServices(providerId),
    virtualNumbers.quote(providerId, serviceCode, countryId, true)
  ]);
  if (!publicProvider) return showVirtualNumbersHome(chatId, user);
  const service = services.find(row => row.code === String(serviceCode));
  if (!service || !quote) {
    await bot.sendMessage(chatId, virtualNumberText(user.lang,
      '🔄 التوفر تغير للتو؛ حدثت لك الخيارات المتاحة تلقائياً.',
      '🔄 Availability changed just now; I refreshed the current options automatically.'));
    return showVirtualCountries(chatId, user, providerId, serviceCode, 0);
  }
  const [fresh, serviceName] = await Promise.all([
    User.findByPk(user.id),
    virtualServiceDisplayName(service, user.lang)
  ]);
  const balance = Number(fresh?.balance || 0);
  const country = localizedVirtualCountry(quote.countryName, user.lang);
  const priceUnits = Math.round(Number(quote.retailPrice) * 10_000);
  const showProviderCost = canSeeVirtualProviderCost(user);
  const priceLineEn = showProviderCost
    ? `💵 Provider → sale: <b>${virtualProviderCostText(quote.providerCost, quote.retailPrice)}</b>`
    : `💵 Price: <b>${virtualRetailPriceText(quote.retailPrice)}</b>`;
  const priceLineAr = showProviderCost
    ? `💵 سعر الموقع ← سعر البيع: <b>${virtualProviderCostText(quote.providerCost, quote.retailPrice)}</b>`
    : `💵 السعر: <b>${virtualRetailPriceText(quote.retailPrice)}</b>`;
  const text = user.lang === 'en'
    ? [
        `📲 Service: <b>${premiumLabelHtml(serviceName)}</b>`,
        `${country.flag} Country: <b>${escapeHtml(country.name)}</b>`,
        priceLineEn,
        `📦 Available now: <b>${quote.count}</b>`,
        `💰 Your wallet: <b>${moneyUsd(balance)}</b>`,
        '',
        'The amount is charged from your wallet only after you confirm the purchase.',
        `⏱ The number stays active for ${virtualNumbers.ACTIVATION_TIMEOUT_MINUTES} minutes while waiting for the code.`
      ].join('\n')
    : [
        `📲 الخدمة: <b>${premiumLabelHtml(serviceName)}</b>`,
        `${country.flag} الدولة: <b>${escapeHtml(country.name)}</b>`,
        priceLineAr,
        `📦 المتوفر حالياً: <b>${quote.count}</b>`,
        `💰 رصيدك: <b>${moneyUsd(balance)}</b>`,
        '',
        'المبلغ ينخصم من محفظتك فقط بعد تأكيد الشراء.',
        `⏱ يبقى الرقم فعالاً ${virtualNumbers.ACTIVATION_TIMEOUT_MINUTES} دقائق بانتظار الكود.`
      ].join('\n');
  return bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [
      [{ text: user.lang === 'en' ? `✅ Buy for ${virtualRetailPriceText(quote.retailPrice)}` : `✅ شراء بـ ${virtualRetailPriceText(quote.retailPrice)}`, callback_data: `vn:buy:${providerId}:${service.code}:${quote.countryId}:u${priceUnits}`, style: 'success' }],
      [{ text: user.lang === 'en' ? '⬅️ Countries' : '⬅️ الدول', callback_data: `vn:countries:${providerId}:${service.code}:0` }]
    ] }
  });
}

async function showVirtualOrders(chatId, user) {
  const orders = await virtualNumbers.listUserOrders(user.id, 10);
  if (!orders.length) return bot.sendMessage(chatId, virtualNumberText(user.lang,
    '🧾 ما عندك طلبات أرقام افتراضية بعد.',
    '🧾 You do not have any virtual-number orders yet.'), {
    reply_markup: { inline_keyboard: [[{ text: '⬅️', callback_data: 'vn:home' }]] }
  });
  const lines = [user.lang === 'en' ? '🧾 <b>Your latest virtual-number orders</b>' : '🧾 <b>آخر طلبات الأرقام الافتراضية</b>', ''];
  const keyboard = [];
  for (const order of orders) {
    const service = { code: order.serviceCode, name: order.serviceName };
    const serviceName = await virtualServiceDisplayName(service, user.lang);
    const country = localizedVirtualCountry(order.countryName, user.lang);
    lines.push(`#${order.id} • ${premiumLabelHtml(serviceName)} • ${country.flag} ${escapeHtml(country.name)} • <b>${virtualRetailPriceText(order.salePriceUsd)}</b>`);
    lines.push(`📞 <code>${escapeHtml(order.phoneNumber || '—')}</code> • ${escapeHtml(virtualNumberStatusLabel(order.status, user.lang))}`);
    if (order.smsCode) lines.push(`🔑 <code>${escapeHtml(order.smsCode)}</code>`);
    lines.push('');
    if (order.status === 'waiting_sms') keyboard.push([{ text: `${user.lang === 'en' ? '❌ Cancel' : '❌ إلغاء'} #${order.id}`, callback_data: `vn:cancel:${order.id}`, style: 'danger' }]);
  }
  keyboard.push([{ text: user.lang === 'en' ? '⬅️ Back' : '⬅️ رجوع', callback_data: 'vn:home' }]);
  return bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
}

function virtualNumberErrorText(error, lang = 'ar') {
  const code = String(error?.code || error?.message || 'ERROR');
  const ar = {
    VIRTUAL_NUMBERS_NOT_CONFIGURED: 'خدمة الأرقام غير مهيأة.',
    PROVIDER_NOT_CONFIGURED: 'هذه الخدمة غير مفعلة حالياً.',
    PROVIDER_UNAVAILABLE: 'تعذر الاتصال بمزود الأرقام حالياً. حاول بعد قليل.',
    SERVICE_UNAVAILABLE_REGION: 'مزود الأرقام يمنع الاتصال من منطقة السيرفر الحالية.',
    BAD_PROVIDER_RESPONSE: 'مزود الأرقام أعاد استجابة غير متوقعة. حاول بعد قليل.',
    BAD_KEY: 'مفتاح API الخاص بمزود الأرقام غير صحيح.',
    BAD_SERVICE: 'الخدمة غير صحيحة أو لم تعد متوفرة.',
    BAD_COUNTRY: 'الدولة غير صحيحة أو لم تعد متوفرة.',
    NO_SERVICES_AVAILABLE: 'ماكو خدمات متوفرة حالياً.',
    NO_COUNTRIES_AVAILABLE: 'ماكو دول متوفرة حالياً.',
    NO_NUMBERS: 'التوفر تغير للتو وتم تحديث الخيارات المتاحة.',
    NO_NUMBER: 'التوفر تغير للتو وتم تحديث الخيارات المتاحة.',
    NO_BALANCE: 'رصيد مزود الأرقام غير كافي. تم إرجاع مبلغك تلقائياً.',
    NO_MONEY: 'رصيد مزود الأرقام غير كافي. تم إرجاع مبلغك تلقائياً.',
    INSUFFICIENT_BALANCE: 'رصيد محفظتك غير كافي لإتمام الشراء.',
    PURCHASE_IN_PROGRESS: 'عندك عملية شراء قيد التنفيذ. انتظر لحظات.',
    PRICE_CHANGED: 'السعر تغير قبل الشراء. راجع السعر الجديد وأكد مرة ثانية.',
    EARLY_CANCEL_DENIED: 'المزود ما يسمح بإلغاء الرقم الآن. انتظر قليلاً ثم جرّب الإلغاء مرة ثانية.',
    ORDER_ALREADY_COMPLETED: 'وصل الكود وانتهى الطلب، لذلك ما يگدر ينلغي.',
    ORDER_NOT_FOUND: 'الطلب غير موجود.',
    CANCEL_NOT_CONFIRMED: 'المزود ما أكد الإلغاء، لذلك ما رجعنا الرصيد حتى لا يصير خطأ مالي.',
    ACTIVE_ORDERS: 'لا يمكن حذف API حالياً لوجود أرقام فعالة بانتظار الكود.',
    INVALID_PROFIT: 'قيمة الربح غير صحيحة.',
    WALLET_NOT_AVAILABLE: 'محفظة الشحن غير متاحة لهذا الموقع.',
    UNKNOWN_PROVIDER: 'موقع الأرقام غير معروف.'
  };
  const en = {
    VIRTUAL_NUMBERS_NOT_CONFIGURED: 'Virtual numbers are not configured.',
    PROVIDER_NOT_CONFIGURED: 'This service is not enabled right now.',
    PROVIDER_UNAVAILABLE: 'The number provider is temporarily unavailable. Try again shortly.',
    SERVICE_UNAVAILABLE_REGION: 'The number provider blocks requests from the server region.',
    BAD_PROVIDER_RESPONSE: 'The number provider returned an unexpected response. Try again shortly.',
    BAD_KEY: 'The provider API key is invalid.',
    BAD_SERVICE: 'The service is invalid or no longer available.',
    BAD_COUNTRY: 'The country is invalid or no longer available.',
    NO_SERVICES_AVAILABLE: 'No services are available right now.',
    NO_COUNTRIES_AVAILABLE: 'No countries are available right now.',
    NO_NUMBERS: 'Availability changed just now; the available options were refreshed.',
    NO_NUMBER: 'Availability changed just now; the available options were refreshed.',
    NO_BALANCE: 'The provider balance is insufficient. Your wallet was refunded automatically.',
    NO_MONEY: 'The provider balance is insufficient. Your wallet was refunded automatically.',
    INSUFFICIENT_BALANCE: 'Your wallet balance is insufficient for this purchase.',
    PURCHASE_IN_PROGRESS: 'A purchase is already in progress. Wait a moment.',
    PRICE_CHANGED: 'The price changed before purchase. Review the new price and confirm again.',
    EARLY_CANCEL_DENIED: 'The provider does not allow cancellation yet. Wait a little and try again.',
    ORDER_ALREADY_COMPLETED: 'The SMS code already arrived, so this order cannot be cancelled.',
    ORDER_NOT_FOUND: 'Order not found.',
    CANCEL_NOT_CONFIRMED: 'The provider did not confirm cancellation, so no refund was issued to avoid an accounting error.',
    ACTIVE_ORDERS: 'This API cannot be removed while numbers are waiting for SMS.',
    INVALID_PROFIT: 'Invalid profit value.',
    WALLET_NOT_AVAILABLE: 'A top-up wallet is not available for this provider.',
    UNKNOWN_PROVIDER: 'Unknown virtual-number provider.'
  };
  return (lang === 'en' ? en[code] : ar[code]) || (lang === 'en' ? `Virtual-number error: ${code}` : `خطأ بخدمة الأرقام: ${code}`);
}

async function handleVirtualNumberCallback(query, user, data) {
  if (!virtualNumbers.enabled()) return answerCallback(query.id, virtualNumberErrorText({ code: 'VIRTUAL_NUMBERS_NOT_CONFIGURED' }, user.lang), true);
  if (data === 'vn:home') {
    await answerCallback(query.id);
    return showVirtualNumbersHome(query.message.chat.id, user);
  }
  if (data.startsWith('vn:p:')) {
    const providerId = String(data.split(':')[2] || '');
    await answerCallback(query.id, user.lang === 'en' ? 'Loading services…' : 'جاري تحميل الخدمات…');
    return showVirtualServices(query.message.chat.id, user, providerId, 0, null, { home: true });
  }
  if (data.startsWith('vn:services:')) {
    const parts = data.split(':');
    const providerId = String(parts[2] || '');
    const page = Number(parts[3] || 0);
    await answerCallback(query.id, user.lang === 'en' ? 'Loading services…' : 'جاري تحميل الخدمات…');
    return showVirtualServices(query.message.chat.id, user, providerId, page);
  }
  if (data.startsWith('vn:cheap:')) {
    const parts = data.split(':');
    const providerId = String(parts[2] || '');
    const page = Number(parts[3] || 0);
    await answerCallback(query.id, user.lang === 'en' ? 'Loading cheapest numbers…' : 'جاري تحميل أرخص الأرقام…');
    return showCheapestVirtualServices(query.message.chat.id, user, providerId, page);
  }
  if (data.startsWith('vn:search:')) {
    const providerId = String(data.split(':')[2] || '');
    if (!(await virtualNumbers.getPublicProvider(providerId))) {
      return answerCallback(query.id, virtualNumberText(user.lang, 'الخدمة غير مفعلة.', 'Service is not enabled.'), true);
    }
    await setState(user.id, { action: 'virtual_number_search', providerId });
    await answerCallback(query.id);
    return bot.sendMessage(user.id, user.lang === 'en'
      ? '🔎 Send the service name in English or Arabic, or send its code. Example: WhatsApp, واتساب, Telegram, تيليجرام, wa, tg.'
      : '🔎 أرسل اسم الخدمة بالعربي أو بالإنجليزي، أو أرسل رمزها. مثال: واتساب، WhatsApp، تيليجرام، Telegram، wa، tg.', { reply_markup: cancelInlineKeyboard() });
  }
  if (data.startsWith('vn:svc:')) {
    const parts = data.split(':');
    const providerId = String(parts[2] || '');
    const serviceCode = String(parts[3] || '');
    await answerCallback(query.id, user.lang === 'en' ? 'Loading countries…' : 'جاري تحميل الدول…');
    return showVirtualCountries(query.message.chat.id, user, providerId, serviceCode, 0);
  }
  if (data.startsWith('vn:countrysearch:')) {
    const parts = data.split(':');
    const providerId = String(parts[2] || '');
    const serviceCode = String(parts[3] || '');
    await setState(user.id, { action: 'virtual_number_country_search', providerId, serviceCode });
    await answerCallback(query.id);
    return bot.sendMessage(user.id, user.lang === 'en'
      ? '🔎 Send the country name in English or Arabic. Example: Iraq, العراق, Egypt, مصر.'
      : '🔎 أرسل اسم الدولة بالعربي أو بالإنجليزي. مثال: العراق، Iraq، مصر، Egypt.', { reply_markup: cancelInlineKeyboard() });
  }
  if (data.startsWith('vn:countries:')) {
    const parts = data.split(':');
    const providerId = String(parts[2] || '');
    const serviceCode = String(parts[3] || '');
    const page = Number(parts[4] || 0);
    await answerCallback(query.id, user.lang === 'en' ? 'Refreshing availability…' : 'جاري تحديث التوفر…');
    return showVirtualCountries(query.message.chat.id, user, providerId, serviceCode, page);
  }
  if (data.startsWith('vn:quote:')) {
    const parts = data.split(':');
    const providerId = String(parts[2] || '');
    const serviceCode = String(parts[3] || '');
    const countryId = String(parts[4] || '');
    await answerCallback(query.id, user.lang === 'en' ? 'Checking current price…' : 'جاري فحص السعر الحالي…');
    return showVirtualQuote(query.message.chat.id, user, providerId, serviceCode, countryId);
  }
  if (data.startsWith('vn:buy:')) {
    if (!isAdmin(user.id)) {
      const status = await currentCommerceStatus();
      if (status?.suspended) return answerCallback(query.id, virtualNumberText(user.lang, 'المتجر متوقف مؤقتاً لحين تسوية الحسابات.', 'Store temporarily paused for account settlement.'), true);
      if (!(await isStoreOpen())) return answerCallback(query.id, virtualNumberText(user.lang, 'المتجر مغلق مؤقتاً.', 'The store is temporarily closed.'), true);
    }
    const parts = data.split(':');
    const providerId = String(parts[2] || '');
    const serviceCode = String(parts[3] || '');
    const countryId = String(parts[4] || '');
    const priceToken = String(parts[5] || '');
    const expectedRetailUnits = /^u\d+$/.test(priceToken)
      ? Number(priceToken.slice(1))
      : Math.round(Number(priceToken || 0) * 100);
    await answerCallback(query.id, user.lang === 'en' ? 'Purchasing number…' : 'جاري شراء الرقم…');
    try {
      const services = await virtualNumbers.listServices(providerId);
      const service = services.find(row => row.code === serviceCode);
      const currentQuote = await virtualNumbers.quote(providerId, serviceCode, countryId);
      if (!service || !currentQuote) throw Object.assign(new Error('NO_NUMBERS'), { code: 'NO_NUMBERS' });
      const order = await virtualNumbers.purchase({
        providerId,
        userId: user.id,
        serviceCode,
        serviceName: service.name,
        countryId,
        countryName: currentQuote.countryName,
        expectedRetailUnits
      });
      const displayServiceName = await virtualServiceDisplayName(service, user.lang);
      const displayCountry = localizedVirtualCountry(currentQuote.countryName, user.lang);
      return bot.sendMessage(user.id, user.lang === 'en'
        ? [
            '✅ <b>Number purchased successfully</b>',
            `📲 Service: <b>${premiumLabelHtml(displayServiceName)}</b>`,
            `${displayCountry.flag} Country: <b>${escapeHtml(displayCountry.name)}</b>`,
            `💵 Paid: <b>${virtualRetailPriceText(order.salePriceUsd)}</b>`,
            `📞 Number: <code>${escapeHtml(order.phoneNumber)}</code>`,
            `🆔 Order: <code>#${order.id}</code>`,
            '',
            '⏳ Waiting for the SMS code…',
            `⏱ If no code arrives within ${virtualNumbers.ACTIVATION_TIMEOUT_MINUTES} minutes, the number will be cancelled automatically and the amount will be returned to your wallet.`
          ].join('\n')
        : [
            '✅ <b>تم شراء الرقم بنجاح</b>',
            `📲 الخدمة: <b>${premiumLabelHtml(displayServiceName)}</b>`,
            `${displayCountry.flag} الدولة: <b>${escapeHtml(displayCountry.name)}</b>`,
            `💵 تم خصم: <b>${virtualRetailPriceText(order.salePriceUsd)}</b>`,
            `📞 الرقم: <code>${escapeHtml(order.phoneNumber)}</code>`,
            `🆔 الطلب: <code>#${order.id}</code>`,
            '',
            '⏳ جاري انتظار وصول كود SMS…',
            `⏱ إذا ما وصل الكود خلال ${virtualNumbers.ACTIVATION_TIMEOUT_MINUTES} دقائق، راح ينلغي الرقم تلقائياً وينرجع المبلغ إلى محفظتك.`
          ].join('\n'), {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: user.lang === 'en' ? '❌ Cancel number & refund' : '❌ إلغاء الرقم واسترداد الرصيد', callback_data: `vn:cancel:${order.id}`, style: 'danger' }]] }
      });
    } catch (error) {
      if (['NO_NUMBERS', 'NO_NUMBER'].includes(String(error.code || ''))) {
        await bot.sendMessage(user.id, virtualNumberText(user.lang,
          '🔄 التوفر تغير أثناء تنفيذ الطلب؛ حدثت لك الخيارات المتاحة تلقائياً بدون عرض خيار فارغ.',
          '🔄 Availability changed during purchase; the current options were refreshed automatically.'));
        return showVirtualCountries(user.id, user, providerId, serviceCode, 0);
      }
      if (error.code === 'PRICE_CHANGED' && error.quote) {
        await bot.sendMessage(user.id, virtualNumberErrorText(error, user.lang));
        return showVirtualQuote(user.id, user, providerId, serviceCode, countryId);
      }
      if (error.code === 'INSUFFICIENT_BALANCE') {
        return bot.sendMessage(user.id, `${virtualNumberErrorText(error, user.lang)}\n${virtualNumberText(user.lang, 'المطلوب', 'Required')}: <b>${virtualRetailPriceText(error.required || 0)}</b>\n${virtualNumberText(user.lang, 'رصيدك', 'Your balance')}: <b>${virtualRetailPriceText(error.balance || 0)}</b>`, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: user.lang === 'en' ? '💳 Open wallet' : '💳 فتح المحفظة', callback_data: 'vn:wallet' }]] }
        });
      }
      return bot.sendMessage(user.id, `❌ ${virtualNumberErrorText(error, user.lang)}`);
    }
  }
  if (data.startsWith('vn:cancel:')) {
    const orderId = Number(data.split(':')[2]);
    await answerCallback(query.id, user.lang === 'en' ? 'Requesting cancellation…' : 'جاري طلب الإلغاء…');
    try {
      const result = await virtualNumbers.cancelCustomerOrder(user.id, orderId);
      return bot.sendMessage(user.id, result.alreadyDone
        ? virtualNumberText(user.lang, 'ℹ️ هذا الطلب منتهي أصلاً.', 'ℹ️ This order is already closed.')
        : virtualNumberText(user.lang,
          `↩️ تم إلغاء الرقم وإرجاع ${virtualRetailPriceText(result.refunded || 0)} إلى محفظتك.`,
          `↩️ Number cancelled and ${virtualRetailPriceText(result.refunded || 0)} was returned to your wallet.`));
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
    return showWalletMenu(query.message.chat.id, user);
  }
  return answerCallback(query.id, virtualNumberText(user.lang, 'زر الأرقام غير معروف.', 'Unknown virtual-number action.'), true);
}

async function automaticNotificationsEnabled() {
  return String(await getSetting('automatic_notifications_enabled', 'true')).toLowerCase() !== 'false';
}

function shopDisplayCurrency() {
  const currency = String(config.network.settlementCurrency || 'USD').toUpperCase();
  return ['USD', 'IQD', 'EGP'].includes(currency) ? currency : 'USD';
}

async function moneyContextForCurrency(currencyValue) {
  const currency = normalizePaymentCurrency(currencyValue || 'USD');
  let rate = 1;
  if (currency === 'IQD') rate = Number(await getIqdRate());
  if (currency === 'EGP') rate = Number(await getSetting('egp_rate_per_usd', String(config.network.egpRate || 50)));
  if (!Number.isFinite(rate) || rate <= 0) {
    rate = currency === 'IQD'
      ? Number(config.iqdRate || 1500)
      : currency === 'EGP'
        ? Number(config.network.egpRate || 50)
        : 1;
  }
  return { currency, rate };
}

async function shopMoneyContext() {
  return moneyContextForCurrency(shopDisplayCurrency());
}

async function customerMoneyContext(user) {
  const selected = normalizeCustomerPaymentCurrency(user?.paymentCurrency) || 'USD';
  return moneyContextForCurrency(selected);
}

function localMoneyNumber(amountUsd, context) {
  const amount = Number(amountUsd || 0) * Number(context?.rate || 1);
  if (context?.currency === 'IQD') return Math.round(amount).toLocaleString('en-US');
  return amount.toFixed(2);
}

function customerMoney(amountUsd, context, lang = 'ar') {
  const currency = normalizePaymentCurrency(context?.currency || 'USD');
  if (currency === 'USD') return moneyUsd(amountUsd);
  return `${localMoneyNumber(amountUsd, context)} ${paymentCurrencyLabel(currency, lang)}`;
}

function customerMoneyCompact(amountUsd, context) {
  const currency = normalizePaymentCurrency(context?.currency || 'USD');
  if (currency === 'USD') return moneyUsd(amountUsd);
  return `${localMoneyNumber(amountUsd, context)} ${currency}`;
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
  if (activePaymentMethodsCache.rows && Date.now() - activePaymentMethodsCache.at < PAYMENT_METHOD_CACHE_TTL_MS) {
    return activePaymentMethodsCache.rows;
  }
  const rows = await PaymentMethod.findAll({
    where: { isActive: true },
    order: [['sortOrder', 'ASC'], ['id', 'ASC']]
  });
  activePaymentMethodsCache = { at: Date.now(), rows };
  return rows;
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

function currencyFlag(code) {
  const normalized = String(code || 'USD').toUpperCase();
  if (normalized === 'IQD') return '🇮🇶';
  if (normalized === 'EGP') return '🇪🇬';
  return '💵';
}

function isZainCashName(value) {
  const text = String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return text.includes('zain cash') || text.includes('zaincash') || text.includes('زين كاش') || text.includes('زينكاش');
}

function serviceInputModeLabel(mode, lang = 'ar') {
  const value = String(mode || 'text');
  if (value === 'email') return lang === 'en' ? 'Email' : 'إيميل';
  if (value === 'phone') return lang === 'en' ? 'Phone number' : 'رقم';
  return lang === 'en' ? 'Text' : 'نص';
}

function servicePromptMeta(product) {
  const description = parseDescription(product?.description);
  const inputMode = String(description.serviceInputMode || 'text');
  return {
    inputMode,
    promptAr: String(description.servicePromptAr || 'أرسل البيانات المطلوبة حتى نباشر تنفيذ الخدمة.'),
    promptEn: String(description.servicePromptEn || 'Send the required details so we can start the service.'),
    inputLabelAr: inputMode === 'email' ? 'الإيميل' : inputMode === 'phone' ? 'الرقم' : 'النص',
    inputLabelEn: inputMode === 'email' ? 'Email' : inputMode === 'phone' ? 'Phone number' : 'Text'
  };
}

async function askServiceOrderInput(userId, order, product = null) {
  const user = await User.findByPk(userId);
  if (!user || !order) return;
  const merch = product || await Merchant.findByPk(order.merchantId);
  const meta = servicePromptMeta(merch);
  await setState(userId, { action: 'service_input', orderId: order.id, inputMode: meta.inputMode });
  const intro = user.lang === 'en'
    ? `✅ Payment confirmed for order #${order.id}.`
    : `✅ تم تأكيد الدفع للطلب #${order.id}.`;
  const ask = user.lang === 'en'
    ? `${meta.promptEn}\n\nRequired field: <b>${escapeHtml(meta.inputLabelEn)}</b>`
    : `${meta.promptAr}\n\nالحقل المطلوب: <b>${escapeHtml(meta.inputLabelAr)}</b>`;
  return bot.sendMessage(userId, [intro, ask].join('\n\n'), { parse_mode: 'HTML', reply_markup: cancelInlineKeyboard() });
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

function minimumTopupLocalAmount(ratePerUsd, currency, minimumUsd = 0.01, explicitMinimumLocal = null) {
  const code = normalizePaymentCurrency(currency);
  const rate = Number(ratePerUsd || 1);
  const safeRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
  const usdFloorLocal = Math.max(0.01, Number(minimumUsd || 0.01)) * safeRate;
  const explicit = Number(explicitMinimumLocal);
  const requestedLocal = Number.isFinite(explicit) && explicit > 0
    ? Math.max(usdFloorLocal, explicit)
    : usdFloorLocal;
  if (code === 'IQD') return Math.max(1, Math.ceil(requestedLocal));
  return Math.max(0.01, Math.ceil((requestedLocal - 1e-9) * 100) / 100);
}

function minimumTransferForMethod(method) {
  const currency = normalizePaymentCurrency(method?.settlementCurrency || 'USD');
  const fallback = currency === 'IQD' ? 1 : 0.01;
  const value = Number(method?.minimumTransferAmount || fallback);
  const normalized = Number.isFinite(value) && value > 0 ? value : fallback;
  if (currency === 'IQD') return Math.max(1, Math.ceil(normalized));
  return Math.max(0.01, Math.ceil((normalized - 1e-9) * 100) / 100);
}

function minimumTransferUsdForMethod(method) {
  const local = paymentLocalAmount(1, method);
  const minimumLocal = minimumTransferForMethod(method);
  const rate = Number(local.rate || 1);
  return Number((minimumLocal / (Number.isFinite(rate) && rate > 0 ? rate : 1)).toFixed(8));
}

async function resolveTopupInputContext(methodToken) {
  const token = String(methodToken || '');
  if (token === 'binance') {
    return { currency: 'USD', rate: 1, minimumUsd: Math.max(0.01, Number(config.binance.minAmount || 0.01)), methodType: 'binance' };
  }
  if (token === 'superqi') {
    const rate = Number(await getIqdRate());
    return { currency: 'IQD', rate: Number.isFinite(rate) && rate > 0 ? rate : Number(config.iqdRate || 1500), minimumUsd: 1, methodType: 'superqi' };
  }
  if (token.startsWith('custom:')) {
    const id = Number(token.split(':')[1]);
    const method = await PaymentMethod.findOne({ where: { id, isActive: true } });
    if (!method) return null;
    const local = paymentLocalAmount(1, method);
    return {
      currency: normalizePaymentCurrency(local.currency),
      rate: Number(local.rate || 1),
      minimumUsd: Math.max(1, minimumTransferUsdForMethod(method)),
      minimumLocal: minimumTransferForMethod(method),
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
      minimumUsd: inheritedType === 'binance' ? Math.max(0.01, Number(config.binance.minAmount || 0.01)) : Math.max(1, minimumTransferUsdForMethod(method)),
      minimumLocal: inheritedType === 'binance' ? Math.max(0.01, Number(config.binance.minAmount || 0.01)) : null,
      methodType: token,
      inheritedType,
      methodNameAr: method.nameAr,
      methodNameEn: method.nameEn
    };
  }
  if (token.startsWith('shared:')) {
    const methodId = token.slice('shared:'.length);
    const shared = await network.listSharedPaymentMethods();
    const method = (shared.methods || []).find(row => String(row.id || '') === methodId && row.isActive !== false);
    if (!method) return null;
    const local = paymentLocalAmount(1, method);
    return {
      currency: normalizePaymentCurrency(local.currency),
      rate: Number(local.rate || 1),
      minimumUsd: Math.max(1, minimumTransferUsdForMethod(method)),
      minimumLocal: minimumTransferForMethod(method),
      methodType: token,
      sharedPaymentMethodId: method.id,
      methodNameAr: method.nameAr,
      methodNameEn: method.nameEn,
      paymentNumber: method.paymentNumber,
      ownerShopId: method.ownerShopId,
      ownerShopName: method.ownerShopName
    };
  }
  return null;
}

function topupAmountPrompt(context, lang = 'ar') {
  const currency = normalizePaymentCurrency(context?.currency);
  const rate = Number(context?.rate || 1);
  const minimum = minimumTopupLocalAmount(rate, currency, context?.minimumUsd || 0.01, context?.minimumLocal);
  const minimumText = formatPaymentCurrencyAmount(minimum, currency, lang);
  const methodType = String(context?.methodType || '');
  const isBinance = methodType === 'binance' || methodType === 'network:binance';

  if (lang === 'en') {
    if (currency === 'EGP') return `Send the top-up amount in Egyptian pounds (minimum: ${minimumText}).`;
    if (currency === 'IQD') return `Send the top-up amount in Iraqi dinars (minimum: ${minimumText}).`;
    if (isBinance) return `Send the Binance top-up amount (minimum: $${Number(minimum).toFixed(2)} USDT).`;
    return `Send the top-up amount in USD (minimum: $${Number(minimum).toFixed(2)}).`;
  }

  if (currency === 'EGP') return `أرسل مبلغ الشحن بالجنيه المصري (الحد الأدنى: ${minimumText}):`;
  if (currency === 'IQD') return `أرسل مبلغ الشحن بالدينار العراقي (الحد الأدنى: ${minimumText}):`;
  if (isBinance) return `أرسل مبلغ الشحن عبر Binance (الحد الأدنى: $${Number(minimum).toFixed(2)} USDT):`;
  return `أرسل مبلغ الشحن بالدولار (الحد الأدنى: $${Number(minimum).toFixed(2)}):`;
}

async function syncPaymentMethodToNetwork(method) {
  if (!method || (!network.isMaster() && !network.enabledClient())) return null;
  return network.upsertSharedPaymentMethod({
    localMethodId: method.id,
    nameAr: method.nameAr,
    nameEn: method.nameEn,
    paymentNumber: method.paymentNumber,
    iconCustomEmojiId: method.iconCustomEmojiId,
    iconAlt: method.iconAlt,
    settlementCurrency: method.settlementCurrency,
    ratePerUsd: Number(method.ratePerUsd || 1),
    minimumTransferAmount: minimumTransferForMethod(method),
    isActive: Boolean(method.isActive)
  });
}

async function createConfiguredPaymentMethod(data) {
  const maxSort = Number(await PaymentMethod.max('sortOrder').catch(() => 0));
  const row = await PaymentMethod.create({
    nameAr: data.nameAr,
    nameEn: data.nameEn || data.nameAr,
    paymentNumber: data.paymentNumber,
    iconCustomEmojiId: data.iconCustomEmojiId || null,
    iconAlt: data.iconAlt || '💳',
    isActive: true,
    sortOrder: Number.isFinite(maxSort) ? maxSort + 10 : 10,
    settlementCurrency: data.settlementCurrency || 'USD',
    ratePerUsd: Number(data.ratePerUsd || 1),
    minimumTransferAmount: Math.max(0.0001, Number(data.minimumTransferAmount || ((data.settlementCurrency || 'USD') === 'IQD' ? 1 : 0.01)))
  });
  invalidatePaymentMethodsCache();
  if (network.enabledClient()) await setSetting('custom_payment_override', 'true');
  try { await syncPaymentMethodToNetwork(row); } catch (error) { console.error('Shared payment sync:', error.message); }
  return row;
}

async function localSuperQiNumber() {
  if (network.enabledClient()) return String(await getSetting('superqi_number', '')).trim();
  return String(await getSuperQiNumber()).trim();
}

async function externalPaymentButtons(user, mode = 'pay', amountUsd = null) {
  const lang = user?.lang === 'en' ? 'en' : 'ar';
  const hidden = await getHiddenPaymentTypes();
  const localBinanceReady = await binancePay.configured();
  const localSuperQi = await localSuperQiNumber();
  const entries = [];
  const currentShopId = network.isMaster()
    ? 'master'
    : (network.enabledClient() ? String(config.network.shopId) : 'standalone');

  const pushEntry = (currency, button, minimumLocal = null, rate = 1, kind = 'local', special = '') => {
    const normalizedCurrency = normalizePaymentCurrency(currency);
    // Always show every configured payment method. Minimums are validated only
    // after the customer chooses the method, so no wallet disappears from the list.
    entries.push({ currency: normalizedCurrency, button, kind, special, minimumLocal, rate });
  };

  let inheritedMethods = [];
  if (network.enabledClient()) {
    try {
      const inherited = await network.fallbackPayments();
      inheritedMethods = Array.isArray(inherited?.methods) ? inherited.methods : [];
    } catch (error) {
      console.error('Inherited payment methods:', error.message);
    }
  }

  // 1) Binance is always shown first when available, independent of account currency.
  if (localBinanceReady && !hidden.has('binance')) {
    pushEntry('USD', emojiButton('Binance', PREMIUM_EMOJI.binance, {
      callback_data: `${mode}:binance`,
      style: 'primary'
    }), Math.max(0.01, Number(config.binance.minAmount || 0.01)), 1, 'binance', 'binance');
  } else if (network.enabledClient() && !hidden.has('binance')) {
    const inheritedBinance = inheritedMethods.find(method => String(method.type || '') === 'binance');
    if (inheritedBinance) {
      const emoji = inheritedBinance.iconCustomEmojiId
        ? { id: String(inheritedBinance.iconCustomEmojiId), alt: inheritedBinance.iconAlt || '💳' }
        : PREMIUM_EMOJI.binance;
      pushEntry('USD', emojiButton('Binance', emoji, {
        callback_data: `${mode}:network:binance`,
        style: 'primary'
      }), Math.max(0.01, Number(config.binance.minAmount || 0.01)), 1, 'binance', 'binance');
    }
  }

  // 2) SuperQi is always visible when configured. It will be placed beside ZainCash.
  if (localSuperQi && !hidden.has('superqi')) {
    const iqdRate = Number(await getIqdRate());
    pushEntry('IQD', emojiButton(lang === 'en' ? 'SuperQi' : 'سوبركي', PREMIUM_EMOJI.superqi, {
      callback_data: `${mode}:superqi`,
      style: 'primary'
    }), null, iqdRate, 'superqi', 'superqi');
  } else if (network.enabledClient() && !hidden.has('superqi') && !localSuperQi) {
    const inheritedSuperQi = inheritedMethods.find(method => String(method.type || '') === 'superqi');
    if (inheritedSuperQi) {
      const emoji = inheritedSuperQi.iconCustomEmojiId
        ? { id: String(inheritedSuperQi.iconCustomEmojiId), alt: inheritedSuperQi.iconAlt || '💳' }
        : PREMIUM_EMOJI.superqi;
      const local = paymentLocalAmount(1, inheritedSuperQi);
      pushEntry('IQD', emojiButton(lang === 'en' ? 'SuperQi' : 'سوبركي', emoji, {
        callback_data: `${mode}:network:superqi`,
        style: 'primary'
      }), null, local.rate, 'superqi', 'superqi');
    }
  }

  // 3) Show every ordinary wallet from this shop, no matter which currency the customer chose.
  const customMethods = await getActivePaymentMethods();
  for (const method of customMethods) {
    const local = paymentLocalAmount(1, method);
    const displayName = localizedPaymentName(method, lang);
    const label = `${currencyFlag(local.currency)} ${displayName}`.trim();
    pushEntry(local.currency, emojiButton(label, customPaymentEmoji(method), {
      callback_data: `${mode}:custom:${method.id}`,
      style: 'primary'
    }), minimumTransferForMethod(method), local.rate, 'local', isZainCashName(displayName) ? 'zaincash' : '');
  }

  // 4) Show every shared wallet from the other admins/shops, also without currency filtering.
  try {
    const shared = await network.listSharedPaymentMethods();
    const candidates = (shared.methods || []).filter(method =>
      method.isActive !== false &&
      String(method.ownerShopId || '') !== currentShopId
    );

    for (const method of candidates) {
      const labelBase = lang === 'en'
        ? (method.nameEn || method.nameAr)
        : (method.nameAr || method.nameEn);
      const local = paymentLocalAmount(1, method);
      const label = `${currencyFlag(local.currency)} ${labelBase}`.trim();
      const emoji = method.iconCustomEmojiId
        ? { id: String(method.iconCustomEmojiId), alt: method.iconAlt || '💳' }
        : null;
      pushEntry(local.currency, emojiButton(label, emoji, {
        callback_data: `${mode}:shared:${method.id}`,
        style: 'primary'
      }), minimumTransferForMethod(method), local.rate, 'shared', isZainCashName(labelBase) ? 'zaincash' : '');
    }
  } catch (error) {
    console.error('Shared payment methods:', error.message);
  }

  // Layout requested by the store owner:
  // Binance on its own row, then ZainCash + SuperQi side by side, then all remaining wallets.
  const rows = [];
  const used = new Set();
  const binanceEntry = entries.find(entry => entry.special === 'binance');
  if (binanceEntry) {
    rows.push([binanceEntry.button]);
    used.add(binanceEntry);
  }

  const zainEntry = entries.find(entry => entry.special === 'zaincash' && !used.has(entry));
  const superQiEntry = entries.find(entry => entry.special === 'superqi' && !used.has(entry));
  const secondRow = [];
  if (zainEntry) { secondRow.push(zainEntry.button); used.add(zainEntry); }
  if (superQiEntry) { secondRow.push(superQiEntry.button); used.add(superQiEntry); }
  if (secondRow.length) rows.push(secondRow);

  for (const entry of entries) {
    if (used.has(entry)) continue;
    rows.push([entry.button]);
  }
  return rows;
}

async function showWalletMenu(chatId, user) {
  const fresh = await User.findByPk(user.id);
  const selectedCurrency = normalizeCustomerPaymentCurrency(fresh?.paymentCurrency);
  if (!selectedCurrency) return showCustomerCurrencySelector(chatId, fresh || user, 'wallet');

  const [inline, moneyContext] = await Promise.all([
    externalPaymentButtons(fresh, 'topup'),
    customerMoneyContext(fresh)
  ]);

  inline.push([{
    text: fresh.lang === 'en' ? '💱 Change account currency' : '💱 تغيير عملة الحساب',
    callback_data: 'currency:choose:wallet'
  }]);

  if (isAdmin(user.id)) {
    inline.push([{ text: '➕ إضافة طريقة دفع', callback_data: 'adm:add_payment_method', style: 'success' }]);
  }

  const currencyLine = fresh.lang === 'en'
    ? `Account currency: <b>${customerPaymentCurrencyLabel(selectedCurrency, 'en')}</b>`
    : `عملة الحساب: <b>${customerPaymentCurrencyLabel(selectedCurrency, 'ar')}</b>`;

  return bot.sendMessage(chatId, [
    `${premiumEmojiHtml(PREMIUM_EMOJI.wallet)} <b>${t(fresh.lang, 'walletBalance')}:</b> ${customerMoney(fresh.balance, moneyContext, fresh.lang)}`,
    currencyLine
  ].join('\n'), {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: inline }
  });
}

async function showAdminAccessManager(chatId) {
  const admins = await adminAccess.listAdmins();
  const active = admins.filter(row => row.isActive);
  const lines = [
    '👑 <b>إدارة الأدمنات</b>',
    '',
    'كل أدمن مفعّل هنا يمتلك صلاحيات كاملة داخل هذا البوت: تعديل وحذف المنتجات، إدارة المخزون والعملاء، طرق الدفع، إعدادات المتجر وربط API مزودي الأرقام الافتراضية.',
    '',
    `عدد الأدمنات المفعّلين: <b>${active.length}</b>`,
    'الأدمن الأساسي محمي حتى لا ينغلق البوت بدون أي إدارة.'
  ];
  const keyboard = [];
  for (const row of active) {
    const id = Number(row.telegramId);
    const label = String(row.displayName || '').trim();
    lines.push(`• <code>${id}</code>${label ? ` — ${escapeHtml(label)}` : ''}${row.isProtected ? ' — محمي' : ''}`);
    if (!row.isProtected) {
      keyboard.push([{ text: `🗑 إزالة الأدمن ${id}`, callback_data: `adm:admin_remove_confirm:${id}`, style: 'danger' }]);
    }
  }
  keyboard.unshift([{ text: '➕ إضافة أدمن بالـ Telegram ID', callback_data: 'adm:admin_add', style: 'success' }]);
  keyboard.push([{ text: '🔄 تحديث القائمة', callback_data: 'adm:admins' }]);
  keyboard.push([{ text: '⬅️ رجوع لإعدادات المتجر', callback_data: 'adm:menu:settings' }]);
  return bot.sendMessage(chatId, lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function grantAdminByTelegramId(user, rawId) {
  const id = adminAccess.normalizeTelegramId(rawId);
  if (id === null) throw new Error('INVALID_TELEGRAM_ID');
  let displayName = '';
  try {
    const chat = await bot.getChat(id);
    displayName = [chat.first_name, chat.last_name].filter(Boolean).join(' ').trim() || chat.username || '';
  } catch {}
  const row = await adminAccess.addAdmin(id, user, displayName);
  try {
    await bot.setMyCommands([
      { command: 'start', description: 'فتح المتجر' },
      { command: 'admin', description: 'لوحة الإدارة' },
      { command: 'cancel', description: 'إلغاء العملية الحالية' }
    ], { scope: { type: 'chat', chat_id: id } });
  } catch {}
  return row;
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

async function adminSectionMenu(section, user = null) {
  const back = [{ text: '⬅️ رجوع للوحة الإدارة', callback_data: 'adm:home' }];

  if (section === 'products') {
    return {
      title: '🛍️ <b>المنتجات والمخزون</b>\nإضافة المنتجات، إضافة خدمة محلية، تعديل المخزون واسترجاع أي تسليم.',
      keyboard: [
        [{ text: '➕ إضافة منتج جديد', callback_data: 'adm:add_product', style: 'success' }],
        [{ text: '🛠 إضافة خدمة محلية', callback_data: 'adm:add_service_local', style: 'success' }],
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
    const keyboard = [
      [{ text: '⚙️ الإعدادات العامة', callback_data: 'adm:settings', style: 'primary' }],
      [{ text: '👑 إدارة الأدمنات', callback_data: 'adm:admins', style: 'primary' }]
    ];
    if (canManageVirtualProviders(user)) {
      keyboard.push([{ text: '📱 مزودات الأرقام الافتراضية', callback_data: 'adm:vnproviders', style: 'primary' }]);
    }
    if (canManagePremiumEmojis(user)) {
      keyboard.push([emojiButton('الإيموجيات المميزة', PREMIUM_EMOJI.settings, { callback_data: 'adm:emoji:0', style: 'primary' })]);
    }
    keyboard.push(
      [{ text: open ? '🔒 إغلاق المتجر' : '🔓 فتح المتجر', callback_data: 'adm:store_toggle', style: open ? 'danger' : 'success' }],
      back
    );
    return {
      title: '⚙️ <b>إعدادات المتجر</b>\nالإعدادات العامة وحالة فتح المتجر.',
      keyboard
    };
  }

  return null;
}

function rateAllowed(userId) {
  const now = Date.now();
  const recent = (memoryRate.get(userId) || []).filter(timestamp => now - timestamp < 10000);
  // The old 12/10s ceiling was low enough to make normal admin navigation look
  // like dead buttons. Keep abuse protection, but allow realistic Telegram use.
  const limit = isAdmin(userId) ? 60 : 30;
  if (recent.length >= limit) return false;
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
  if (!normalizeCustomerPaymentCurrency(user.paymentCurrency)) {
    return showCustomerCurrencySelector(chatId, user, 'main');
  }
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
  return String(value || '').replace(/<tg-emoji\b[^>]*>[\s\S]*?<\/tg-emoji>/gi, '');
}

function productCaption(product, stock, lang, moneyContext) {
  const descriptionData = productPresentationDescription(product);
  const name = productDisplayName(product, lang);
  const automaticNameEmoji = resolvedProductNameEmoji(product);
  const storedNameEmoji = productDisplayEmoji(product, descriptionData);
  const nameEmoji = product.localNameEmojiId
    ? usableProductNameEmoji(storedNameEmoji, automaticNameEmoji)
    : usableProductNameEmoji(automaticNameEmoji, storedNameEmoji);
  const description = lang === 'en'
    ? (descriptionData.en || descriptionData.ar || '')
    : (descriptionData.ar || descriptionData.en || '');
  const warranty = lang === 'en'
    ? (descriptionData.warrantyEn || descriptionData.warrantyAr || '—')
    : (descriptionData.warrantyAr || descriptionData.warrantyEn || '—');

  const cleanName = cleanProductNameForEmoji(name, descriptionData.nameEmojiAlt) || name;
  const richName = nameEmoji?.id
    ? `${premiumEmojiHtml(nameEmoji)} ${escapeHtml(cleanName)}`
    : escapeHtml(cleanName);

  const richDescription = lang === 'ar' && descriptionData.descriptionArHtml
    ? descriptionData.descriptionArHtml
    : escapeHtml(description || '—');
  const richWarranty = lang === 'ar' && descriptionData.warrantyArHtml
    ? descriptionData.warrantyArHtml
    : escapeHtml(warranty);

  const stockText = product.type === 'service'
    ? (lang === 'en' ? 'On demand' : 'حسب الطلب')
    : String(stock);
  return [
    `<b>${richName}</b>`,
    `💰 <b>${t(lang, 'price')}:</b> ${customerMoney(effectiveProductPrice(product), moneyContext, lang)}`,
    `📦 <b>${t(lang, 'stock')}:</b> ${stockText}`,
    `📈 <b>${t(lang, 'sold')}:</b> ${Number(descriptionData.sold || 0)}`,
    `🛡 <b>${t(lang, 'warranty')}:</b> ${richWarranty}`,
    '',
    `❝ <b>${t(lang, 'description')}:</b>`,
    richDescription
  ].join('\n');
}

function productButtonRow(product, stock, lang, moneyContext) {
  const descriptionData = parseDescription(product.description);
  const name = productDisplayName(product, lang);
  const automaticNameEmoji = resolvedProductNameEmoji(product);
  const storedNameEmoji = productDisplayEmoji(product, descriptionData);
  const nameEmoji = product.localNameEmojiId
    ? usableProductNameEmoji(storedNameEmoji, automaticNameEmoji)
    : usableProductNameEmoji(automaticNameEmoji, storedNameEmoji);
  let displayName = cleanProductNameForEmoji(name, descriptionData.nameEmojiAlt);
  if (nameEmoji?.id && nameEmoji.alt) displayName = cleanProductNameForEmoji(displayName, nameEmoji.alt);
  if (!displayName) displayName = name;
  // Telegram supports one Custom Emoji per inline button. Keep each product
  // as one wide button and reserve that icon slot for the product/service
  // identity. Money and stock Custom Emoji remain available in the product
  // details message, where Telegram supports multiple entities.
  const ltrIsolate = value => `⁦${String(value)}⁩`;
  const style = product.type === 'service' ? 'success' : (stock > 0 ? 'success' : 'danger');
  const priceText = ltrIsolate(customerMoneyCompact(effectiveProductPrice(product), moneyContext));
  const availabilityText = product.type === 'service'
    ? (lang === 'en' ? 'service' : 'خدمة')
    : ltrIsolate(stock);
  const button = {
    text: `${displayName} | ${priceText} | ${availabilityText}`,
    callback_data: `prod:${product.id}`,
    style,
    // Product identity is derived from the product record. A historical UI
    // text override may rename the label, but must never swap Canva for
    // YouTube or CapCut for a save/bookmark icon.
    __lockPremiumEmoji: true
  };
  const buttonEmoji = nameEmoji?.id
    ? nameEmoji
    : (product.type === 'service' ? null : PREMIUM_EMOJI.box);
  if (buttonEmoji?.id) button.icon_custom_emoji_id = String(buttonEmoji.id);
  else button.__skipPremiumEmoji = true;
  return [button];
}

async function sendProductKeyboard(chatId, user, rows) {
  const moneyContext = await customerMoneyContext(user);
  const keyboard = rows.map(({ product, stock }) => productButtonRow(product, stock, user.lang, moneyContext));
  try {
    return await bot.sendMessage(chatId, t(user.lang, 'chooseProduct'), { reply_markup: { inline_keyboard: keyboard } });
  } catch (error) {
    // If the bot owner does not have Telegram Premium, custom button icons can be rejected.
    if (/custom emoji|icon_custom_emoji|BUTTON/i.test(String(error.message || ''))) {
      for (const row of keyboard) {
        for (const button of row) {
          delete button.icon_custom_emoji_id;
          delete button.__skipPremiumEmoji;
          delete button.style;
        }
      }
      return bot.sendMessage(chatId, t(user.lang, 'chooseProduct'), { reply_markup: { inline_keyboard: keyboard } });
    }
    throw error;
  }
}

async function showProducts(chatId, user) {
  const fresh = await User.findByPk(user.id);
  if (!normalizeCustomerPaymentCurrency(fresh?.paymentCurrency)) {
    return showCustomerCurrencySelector(chatId, fresh || user, 'main');
  }
  const rows = await listActiveProducts();
  if (!rows.length) return bot.sendMessage(chatId, t(user.lang, 'noProducts'));

  // Show every added active product. Split only to keep Telegram keyboards comfortable on mobile.
  const chunkSize = 25;
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    await sendProductKeyboard(chatId, fresh || user, rows.slice(offset, offset + chunkSize));
  }
}

async function showProduct(chatId, user, merchantId) {
  const product = await Merchant.findByPk(merchantId);
  if (!product || !product.isActive || !productVisibleInCurrentShop(product)) return bot.sendMessage(chatId, t(user.lang, 'noProducts'));
  const [stock, moneyContext] = await Promise.all([getProductStock(product.id), customerMoneyContext(user)]);
  const caption = productCaption(product, stock, user.lang, moneyContext);
  const canBuy = product.type === 'service' ? true : stock > 0;
  const markup = { inline_keyboard: [[{ text: t(user.lang, 'buy'), callback_data: `buy:${product.id}`, style: canBuy ? 'success' : 'danger' }]] };
  const displayImage = productDisplayImage(product);
  if (displayImage) {
    try {
      await bot.sendPhoto(chatId, displayImage, { caption, parse_mode: 'HTML', reply_markup: markup });
      return;
    } catch (error) {
      console.error('Product image failed:', error.message);
      if (/custom emoji|tg-emoji/i.test(String(error.message || ''))) {
        const safeCaption = stripTelegramCustomEmojiHtml(caption);
        await bot.sendPhoto(chatId, displayImage, { caption: safeCaption, parse_mode: 'HTML', reply_markup: markup });
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
  for (const adminId of getAdminIds()) {
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
    attributes: ['id', 'lang', 'paymentCurrency'],
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
  if (!product?.isActive || !productVisibleInCurrentShop(product) || !Number.isInteger(added) || added < 1) {
    return { sent: 0, failed: 0 };
  }

  const users = await getBroadcastUsers();
  let sent = 0;
  let failed = 0;

  for (let index = 0; index < users.length; index += 1) {
    const target = users[index];
    if (isAdmin(target.id)) continue;

    const lang = target.lang === 'en' ? 'en' : 'ar';
    const productName = productDisplayName(product, lang);
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
  if (!product?.isActive || !productVisibleInCurrentShop(product)) return { sent: 0, failed: 0 };

  const users = await getBroadcastUsers();
  const stock = await getProductStock(product.id);
  let sent = 0;
  let failed = 0;

  for (let index = 0; index < users.length; index += 1) {
    const target = users[index];
    if (isAdmin(target.id)) continue;
    const lang = target.lang === 'en' ? 'en' : 'ar';
    const name = productDisplayName(product, lang);
    const moneyContext = await customerMoneyContext(target);
    const message = lang === 'en'
      ? `🆕 <b>New product</b>

<b>${escapeHtml(name)}</b>
Price: <b>${customerMoney(effectiveProductPrice(product), moneyContext, lang)}</b>`
      : `🆕 <b>منتج جديد</b>

<b>${escapeHtml(name)}</b>
السعر: <b>${customerMoney(effectiveProductPrice(product), moneyContext, lang)}</b>`;
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

async function notifyAdminsForNetworkProductReview(product, actorName = '') {
  if (!product?.isActive || !isForeignPublicProduct(product)) return { sent: 0, failed: 0 };
  if (String(product.localPublicationStatus || '').toLowerCase() !== 'pending') return { sent: 0, failed: 0 };
  if (product.localReviewNotifiedAt) return { sent: 0, failed: 0, alreadyNotified: true };

  const description = parseDescription(product.description);
  const creator = String(actorName || product.createdByDisplayName || product.networkOwnerShopId || 'إدارة متجر آخر').trim();
  const basePrice = networkProductBasePrice(product);
  const message = [
    '🌐 <b>منتج عام جديد ينتظر قرارك</b>',
    '',
    `أضاف <b>${escapeHtml(creator)}</b> منتجاً جديداً.`,
    `الاسم: <b>${escapeHtml(productDisplayName(product, 'ar') || '—')}</b>`,
    `النوع: <b>${escapeHtml(productTypeLabel(product.type))}</b>`,
    `سعر صاحب المنتج: <b>${moneyUsd(basePrice)}</b>`,
    `الوصف: ${escapeHtml(description.ar || '—')}`,
    `الضمان: ${escapeHtml(description.warrantyAr || '—')}`,
    '',
    'اختَر تسعير المنتج ونشره داخل بوتك، أو ارفضه في هذا البوت فقط.'
  ].join('\n');
  let sent = 0;
  let failed = 0;
  for (const adminId of getAdminIds()) {
    try {
      await bot.sendMessage(adminId, message, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: '💵 تسعير المنتج ونشره', callback_data: `adm:netprod:price:${product.id}`, style: 'success' }],
          [{ text: '❌ رفض في هذا البوت فقط', callback_data: `adm:netprod:reject:${product.id}`, style: 'danger' }]
        ] }
      });
      sent += 1;
    } catch (error) {
      failed += 1;
      console.error(`Network product review notify ${adminId}:`, error.message);
    }
  }
  if (sent > 0) {
    product.localReviewNotifiedAt = new Date();
    await product.save({ fields: ['localReviewNotifiedAt'] });
  }
  return { sent, failed };
}

async function notifyPendingNetworkProductReviews() {
  const pending = await Merchant.findAll({
    where: { isActive: true, visibilityScope: 'public', localPublicationStatus: 'pending' },
    order: [['createdAt', 'ASC']],
    limit: 100
  });
  for (const product of pending) {
    if (!isForeignPublicProduct(product) || product.localReviewNotifiedAt) continue;
    await notifyAdminsForNetworkProductReview(product).catch(error => {
      console.error(`Pending product review ${product.id}:`, error.message);
    });
  }
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

async function userIsChannelMember(userId, channel, options = {}) {
  if (!channel || isAdmin(userId)) return true;
  const cacheKey = `${String(channel)}:${String(userId)}`;
  const cached = channelMembershipCache.get(cacheKey);
  const force = options === true || Boolean(options?.force);
  if (!force && cached) {
    const ttl = cached.value ? CHANNEL_MEMBER_OK_TTL_MS : CHANNEL_MEMBER_FAIL_TTL_MS;
    if (Date.now() - cached.at < ttl) return cached.value;
  }
  try {
    const member = await bot.getChatMember(channel, userId);
    const value = ['creator', 'administrator', 'member'].includes(member.status)
      || (member.status === 'restricted' && Boolean(member.is_member));
    channelMembershipCache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch (error) {
    console.error('Channel membership check:', error.message);
    // A temporary Telegram failure must not create a long cache lockout.
    channelMembershipCache.set(cacheKey, { at: Date.now(), value: false });
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
  const referrer = await User.findByPk(result.referrerId);
  const referrerMoneyContext = await customerMoneyContext(referrer || { paymentCurrency: 'USD' });
  await bot.sendMessage(result.referrerId, [
    '🎉 <b>انضم شخص من رابطك</b>',
    `تمت إضافة <b>${customerMoney(result.rewardAmount, referrerMoneyContext, referrer?.lang || 'ar')}</b> إلى محفظتك.`,
    `عدد إحالاتك المقبولة: <b>${result.count}</b>`,
    `رصيدك الجديد: <b>${customerMoney(result.newBalance, referrerMoneyContext, referrer?.lang || 'ar')}</b>`,
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
  const moneyContext = await customerMoneyContext(user);
  const giftName = stats.giftProduct
    ? (user.lang === 'en' ? (stats.giftProduct.nameEn || stats.giftProduct.nameAr) : stats.giftProduct.nameAr)
    : (user.lang === 'en' ? 'Not selected yet' : 'غير محددة بعد');

  const text = user.lang === 'en'
    ? [
        '🎁 <b>Gifts & referrals</b>',
        `Reward per verified friend: <b>${customerMoney(stats.settings.rewardAmount, moneyContext, user.lang)}</b>`,
        `Accepted referrals: <b>${stats.count}</b>`,
        `Total earned: <b>${customerMoney(stats.totalEarned, moneyContext, user.lang)}</b>`,
        `Gift target: <b>${stats.settings.target}</b>`,
        `Gift: <b>${escapeHtml(giftName)}</b>`,
        '',
        'Your referral link:',
        `<code>${escapeHtml(link)}</code>`
      ].join('\n')
    : [
        '🎁 <b>الهدايا والمشاركة</b>',
        `مكافأة كل شخص حقيقي: <b>${customerMoney(stats.settings.rewardAmount, moneyContext, user.lang)}</b>`,
        `الإحالات المقبولة: <b>${stats.count}</b>`,
        `إجمالي الأرباح: <b>${customerMoney(stats.totalEarned, moneyContext, user.lang)}</b>`,
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

  for (const adminId of getAdminIds()) {
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

async function handleServiceAdminAction(query, user, data) {
  if (!isAdmin(user.id)) return answerCallback(query.id, t(user.lang, 'adminOnly'), true);
  const [, action, orderIdRaw] = data.split(':');
  const orderId = Number(orderIdRaw);
  if (!Number.isInteger(orderId) || orderId < 1) return answerCallback(query.id, 'رقم الطلب غير صحيح.', true);
  const order = await PurchaseOrder.findByPk(orderId, { include: [Merchant] });
  if (!order || String(order.Merchant?.type || '') !== 'service') return answerCallback(query.id, 'طلب الخدمة غير موجود.', true);
  const customer = await User.findByPk(order.userId);
  const status = String(order.status || '');

  if (!['done', 'delay', 'refund', 'chat'].includes(action)) {
    return answerCallback(query.id, 'زر خدمة غير معروف.', true);
  }
  if (status !== 'service_pending_admin') {
    const message = status === 'completed'
      ? 'تم إنهاء هذه الخدمة سابقاً.'
      : status === 'refunded_service'
        ? 'تم إلغاء هذه الخدمة وإرجاع الأموال سابقاً.'
        : 'هذا الطلب لم يعد بانتظار إجراء الإدارة.';
    return answerCallback(query.id, message, true);
  }

  if (action === 'done') {
    order.status = 'completed';
    order.completedAt = new Date();
    await order.save({ fields: ['status', 'completedAt'] });
    await answerCallback(query.id, 'تمت العملية.');
    if (query.message) {
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id
      }).catch(() => {});
    }
    await bot.sendMessage(order.userId, customer?.lang === 'en'
      ? `✅ Your service order #${order.id} has been activated successfully.`
      : `✅ تم تفعيل طلب الخدمة #${order.id} بنجاح.`).catch(() => {});
    return bot.sendMessage(query.message.chat.id, `✅ تم إنهاء طلب الخدمة #${order.id}.`);
  }

  if (action === 'delay') {
    await answerCallback(query.id, 'تم إرسال التأجيل.');
    await bot.sendMessage(order.userId, customer?.lang === 'en'
      ? '⏳ Your service activation was postponed for 30 minutes.'
      : '⏳ تم تأجيل التفعيل لمدة 30 دقيقة.').catch(() => {});
    return bot.sendMessage(query.message.chat.id, `⏳ تم إبلاغ الزبون بتأجيل الطلب #${order.id} لمدة 30 دقيقة.`);
  }

  if (action === 'refund') {
    let result;
    try {
      result = await refundServiceOrderToWallet(order.id, 'admin_service_refund');
    } catch (error) {
      if (error.message === 'SERVICE_ORDER_ALREADY_FINALIZED') return answerCallback(query.id, 'الطلب منتهي ولا يمكن استرداده من هذا الزر.', true);
      throw error;
    }
    await answerCallback(query.id, result.alreadyRefunded ? 'تم رد الأموال سابقاً.' : 'تم رد الأموال.');
    if (query.message) {
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id
      }).catch(() => {});
    }
    if (!result.alreadyRefunded) {
      const moneyContext = await customerMoneyContext(customer || { paymentCurrency: 'USD' });
      const lang = customer?.lang === 'en' ? 'en' : 'ar';
      await bot.sendMessage(order.userId, lang === 'en'
        ? `↩️ Your service order #${order.id} was cancelled and ${customerMoney(result.refunded, moneyContext, lang)} was returned to your wallet.`
        : `↩️ تم إلغاء طلب الخدمة #${order.id} وإرجاع ${customerMoney(result.refunded, moneyContext, lang)} إلى محفظتك.`).catch(() => {});
    }
    return bot.sendMessage(query.message.chat.id, `↩️ تم إلغاء الطلب #${order.id} وإرجاع الرصيد للمستخدم.`);
  }

  let ticket = await SupportTicket.findOne({ where: { userId: order.userId, status: 'open' }, order: [['id', 'DESC']] });
  if (!ticket) ticket = await getOrCreateSupportTicket(order.userId);
  await setState(order.userId, { action: 'support_chat', ticketId: ticket.id, serviceOrderId: order.id });
  await setState(user.id, { action: 'admin_support_reply', ticketId: ticket.id, targetId: order.userId, keepOpen: true, serviceOrderId: order.id });
  await answerCallback(query.id, 'تم فتح المحادثة.');
  await bot.sendMessage(order.userId, customer?.lang === 'en'
    ? '💬 A service chat has been opened. Send your message here.'
    : '💬 تم فتح محادثة بخصوص الخدمة. أرسل رسالتك هنا.', {
    reply_markup: { inline_keyboard: [[{
      text: customer?.lang === 'en' ? '❌ Close chat' : '❌ إغلاق الدردشة',
      callback_data: `support:userclose:${ticket.id}`,
      style: 'danger'
    }]] }
  }).catch(() => {});
  return bot.sendMessage(query.message.chat.id, '💬 ارسل رسالتك الآن. تبقى المحادثة مفتوحة إلى أن تضغط «إغلاق الدردشة».', {
    reply_markup: { inline_keyboard: [[
      { text: '❌ إغلاق الدردشة', callback_data: `support:close:${ticket.id}`, style: 'danger' }
    ]] }
  });
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
  if (fulfillment?.servicePendingInput || String(order?.status || '') === 'service_pending_input') {
    return askServiceOrderInput(userId, order, fulfillment.product);
  }
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
  const markupEarned = (fulfillment.deliveries || []).reduce((sum, item) => sum + Number(item.sellerMarkupUsd || 0), 0);
  await notifyAdmins([
    `✅ تم تسليم الطلب <b>#${order.id}</b>`,
    `المستخدم: <code>${order.userId}</code>`,
    markupEarned > 0 ? `📈 ربح فرق السعر من مخزون الآخرين بهذا الطلب: <b>$${markupEarned.toFixed(2)}</b>` : '',
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
    const moneyContext = await customerMoneyContext(user || { paymentCurrency: 'USD' });
    const text = lang === 'en'
      ? `✅ Wallet credited through Binance${manual ? ' after admin verification' : ''}.\nCredited: <b>${customerMoney(result.amount, moneyContext, lang)}</b>\nNew balance: <b>${customerMoney(result.newBalance, moneyContext, lang)}</b>`
      : `✅ تم شحن محفظتك عبر Binance${manual ? ' بعد تحقق الإدارة' : ' تلقائياً'}.\nتمت إضافة: <b>${customerMoney(result.amount, moneyContext, lang)}</b>\nالرصيد الجديد: <b>${customerMoney(result.newBalance, moneyContext, lang)}</b>`;
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

    if (startMatch) {
      if (!normalizeCustomerPaymentCurrency(user.paymentCurrency)) return showLanguageSelector(msg.chat.id);
      return showMain(msg.chat.id, user);
    }

    if (msg.text === '/admin') {
      if (!isAdmin(user.id)) return bot.sendMessage(msg.chat.id, t(user.lang, 'adminOnly'));
      return bot.sendMessage(msg.chat.id, await adminDashboardText(), {
        parse_mode: 'HTML',
        reply_markup: await adminMenu()
      });
    }

    if (isCancelText(msg.text)) {
      const state = parseState(user);
      const cancelled = await cancelActiveState(user, state);
      const text = cancelled.serviceRefund && !cancelled.serviceRefund.alreadyRefunded
        ? (user.lang === 'en'
          ? `↩️ Service cancelled. ${moneyUsd(cancelled.serviceRefund.refunded)} was returned to your wallet.`
          : `↩️ تم إلغاء الخدمة وإرجاع ${moneyUsd(cancelled.serviceRefund.refunded)} إلى محفظتك.`)
        : t(user.lang, 'cancelled');
      return bot.sendMessage(msg.chat.id, text, { reply_markup: await getMainKeyboard(user.lang) });
    }

    if (!user.verified) { user.verified = true; await user.save({ fields: ['verified'] }); }

    const freshBeforeGate = await User.findByPk(user.id);
    const preGateState = parseState(freshBeforeGate);
    if (preGateState?.action !== 'admin_ui_text_edit') {
      const originalButtonText = uiTextOverrides.originalButtonText(msg.text);
      if (originalButtonText) msg.text = originalButtonText;
    }
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

    if (['شراء رقم افتراضي', 'Buy virtual number', '📱 شراء رقم افتراضي', '📱 Buy virtual number'].includes(msg.text)) {
      if (!virtualNumbers.enabled()) return bot.sendMessage(msg.chat.id, virtualNumberErrorText({ code: 'VIRTUAL_NUMBERS_NOT_CONFIGURED' }, user.lang));
      if (!isAdmin(user.id)) {
        const status = await currentCommerceStatus();
        if (status?.suspended) return bot.sendMessage(msg.chat.id, suspendedStoreText(user.lang, status), { reply_markup: suspendedMainKeyboard(user.lang) });
        if (!(await isStoreOpen())) return bot.sendMessage(msg.chat.id, user.lang === 'en' ? '🔒 The store is temporarily closed.' : '🔒 المتجر مغلق مؤقتاً.');
      }
      return showVirtualNumbersHome(msg.chat.id, user);
    }

    if (msg.text === t('ar', 'wallet') || msg.text === t('en', 'wallet')) {
      if (!normalizeCustomerPaymentCurrency(user.paymentCurrency)) return showCustomerCurrencySelector(msg.chat.id, user, 'wallet');
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

    if (msg.text === '💱 العملة' || msg.text === '💱 Currency') {
      return showCustomerCurrencySelector(msg.chat.id, user, 'main');
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
  if (!query.from) return;
  if (!rateAllowed(query.from.id)) {
    return answerCallback(query.id, 'انتظر لحظة قبل الضغط مرة ثانية.');
  }
  const user = await getOrCreateUser(query.from);
  const data = String(query.data || '');
  if (data.startsWith('noop:')) return answerCallback(query.id);

  if (user.blocked && !isAdmin(user.id)) return answerCallback(query.id, 'حسابك محظور.', true);
  if (data === 'noop') return answerCallback(query.id);

  if (data.startsWith('onboard:lang:')) {
    const chosen = String(data.split(':')[2] || '');
    if (!['ar', 'en'].includes(chosen)) return answerCallback(query.id, 'Invalid language.', true);
    user.lang = chosen;
    await user.save({ fields: ['lang'] });
    await answerCallback(query.id, chosen === 'en' ? 'English selected.' : 'تم اختيار العربية.');
    return showCustomerCurrencySelector(query.message.chat.id, user, 'main');
  }

  if (data.startsWith('currency:choose:')) {
    const after = String(data.split(':')[2] || 'main');
    await answerCallback(query.id);
    return showCustomerCurrencySelector(query.message.chat.id, user, after);
  }

  if (data.startsWith('currency:set:')) {
    const parts = data.split(':');
    const currency = normalizeCustomerPaymentCurrency(parts[2]);
    const after = String(parts[3] || 'main');
    if (!currency) return answerCallback(query.id, user.lang === 'en' ? 'Invalid currency.' : 'عملة غير صحيحة.', true);
    user.paymentCurrency = currency;
    await user.save({ fields: ['paymentCurrency'] });
    await answerCallback(query.id, user.lang === 'en' ? 'Currency saved.' : 'تم حفظ العملة.');
    if (after === 'wallet') return showWalletMenu(query.message.chat.id, user);
    return showMain(query.message.chat.id, user);
  }

  if (data === 'flow:cancel') {
    const state = parseState(await User.findByPk(user.id));
    const cancelled = await cancelActiveState(user, state);
    const text = cancelled.serviceRefund && !cancelled.serviceRefund.alreadyRefunded
      ? (user.lang === 'en'
        ? `↩️ Service cancelled. ${moneyUsd(cancelled.serviceRefund.refunded)} was returned to your wallet.`
        : `↩️ تم إلغاء الخدمة وإرجاع ${moneyUsd(cancelled.serviceRefund.refunded)} إلى محفظتك.`)
      : t(user.lang, 'cancelled');
    await answerCallback(query.id, text);
    return bot.sendMessage(user.id, text, { reply_markup: await getMainKeyboard(user.lang) });
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
    const joined = await userIsChannelMember(user.id, channel, { force: true });
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
    if (data.startsWith('vn:')) return handleVirtualNumberCallback(query, user, data);

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
          GIFT_PRODUCT_INVALID: 'منتج الهدية الحالي غير صالح أو صار غير متاح. راجع الإدارة.',
          PRODUCT_NOT_GIFT_ELIGIBLE: 'هذا النوع من المنتجات ما يصلح كهدية تلقائية.',
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

    if (data.startsWith('support:userclose:')) {
      const ticketId = Number(data.split(':')[2]);
      const ticket = await SupportTicket.findByPk(ticketId);
      if (!ticket || ticket.status !== 'open' || String(ticket.userId) !== String(user.id)) {
        return answerCallback(query.id, user.lang === 'en' ? 'Chat is already closed.' : 'الدردشة مغلقة أصلاً.', true);
      }
      ticket.status = 'closed';
      ticket.closedAt = new Date();
      await ticket.save({ fields: ['status', 'closedAt'] });
      await clearState(user.id);
      await answerCallback(query.id, user.lang === 'en' ? 'Chat closed.' : 'تم إغلاق الدردشة.');
      await notifyAdmins(`❌ المستخدم <code>${user.id}</code> أغلق محادثة الدعم #${ticket.id}.`).catch(() => {});
      return bot.sendMessage(user.id, user.lang === 'en' ? '✅ Chat closed.' : '✅ تم إغلاق الدردشة.', { reply_markup: await getMainKeyboard(user.lang) });
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
      const adminState = parseState(await User.findByPk(user.id));
      if (adminState?.action === 'admin_support_reply' && Number(adminState.ticketId) === ticket.id) {
        await clearState(user.id);
      }
      await answerCallback(query.id, 'تم إغلاق التذكرة.');
      await bot.sendMessage(ticket.userId, targetUser?.lang === 'en'
        ? '✅ Support chat was closed. You can open a new chat from Support.'
        : '✅ تم إغلاق محادثة الدعم. تكدر تفتح محادثة جديدة من زر الدعم.').catch(() => {});
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
    if (data.startsWith('shpay:approve:') || data.startsWith('shpay:reject:')) return handleSharedPaymentOwnerAdmin(query, data);
    if (data.startsWith('service:')) return handleServiceAdminAction(query, user, data);

    if (data.startsWith('adm:')) {
      if (!isAdmin(user.id)) return answerCallback(query.id, t(user.lang, 'adminOnly'), true);
      return handleAdminCallback(query, user, data);
    }

    console.warn('Unhandled callback_data:', data, 'from user', user.id);
    return answerCallback(query.id, user.lang === 'en'
      ? 'This button is old or no longer valid. Reopen the menu and try again.'
      : 'هذا الزر قديم أو لم يعد صالحاً. افتح القائمة من جديد وحاول مرة ثانية.', true);
  } catch (error) {
    console.error('Callback error:', error);
    await answerCallback(query.id, `خطأ: ${error.message}`, true);
  }
});

async function handleBuy(query, user, merchantId) {
  const product = await Merchant.findByPk(merchantId);
  const stock = product ? await getProductStock(product.id) : 0;
  if (!product || !product.isActive || !productVisibleInCurrentShop(product) || (product.type !== 'service' && stock < 1)) return answerCallback(query.id, t(user.lang, 'outOfStock'), true);
  const max = ['service', 'shared'].includes(String(product?.type || '')) ? 1 : Math.min(stock, 100);
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
  const freshUser = await User.findByPk(user.id);
  if (!normalizeCustomerPaymentCurrency(freshUser?.paymentCurrency)) {
    return showCustomerCurrencySelector(chatId, freshUser || user, 'main');
  }

  const moneyContext = await customerMoneyContext(freshUser || user);
  const total = effectiveProductPrice(product) * Number(quantity);
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

  buttons.push(...await externalPaymentButtons(freshUser, 'pay', missing > 0 ? missing : total));

  const lines = [];
  if (!canUseWallet) {
    lines.push(`${premiumEmojiHtml(PREMIUM_EMOJI.wallet)} <b>${t(user.lang, 'walletBalance')}:</b> ${customerMoney(balance, moneyContext, user.lang)}`);
    lines.push(`💰 <b>${user.lang === 'en' ? 'Product total' : 'سعر المنتج'}:</b> ${customerMoney(total, moneyContext, user.lang)}`);
    lines.push(`➕ <b>${user.lang === 'en' ? 'Amount needed to complete payment' : 'المبلغ المطلوب لإكمال الدفع'}:</b> ${customerMoney(missing, moneyContext, user.lang)}`);
    lines.push('');
    lines.push(user.lang === 'en'
      ? 'Choose a payment method below. Your wallet balance is used automatically and you only pay the remaining difference.'
      : 'اختَر طريقة الدفع أدناه. رصيد محفظتك ينحسب تلقائياً وتدفع الفرق المتبقي فقط.');
  } else {
    lines.push(`${t(user.lang, 'payment')}`);
    lines.push(`💰 <b>${customerMoney(total, moneyContext, user.lang)}</b>`);
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
  if (!product || !productVisibleInCurrentShop(product) || (product.type !== 'service' && stock < quantity)) return answerCallback(query.id, t(user.lang, 'outOfStock'), true);
  await answerCallback(query.id);
  return sendCheckoutOptions(query.message.chat.id, user, product, quantity);
}

async function paymentTokenMatchesCustomerCurrency(user, methodToken) {
  const token = String(methodToken || '');
  if (token === 'wallet') return true;
  if (token === 'binance') return Boolean(await binancePay.configured());
  if (token === 'network:binance' || token === 'network:superqi') return network.enabledClient();
  if (token === 'superqi') return Boolean(await localSuperQiNumber());
  try {
    if (token.startsWith('custom:')) {
      const id = Number(token.split(':')[1]);
      const method = await PaymentMethod.findOne({ where: { id, isActive: true } });
      return Boolean(method);
    }
    if (token.startsWith('shared:')) {
      const id = token.slice('shared:'.length);
      const shared = await network.listSharedPaymentMethods();
      return Boolean((shared.methods || []).find(row => String(row.id || '') === id && row.isActive !== false));
    }
  } catch (error) {
    console.error('Payment method validation:', error.message);
    return false;
  }
  return false;
}

async function handlePayment(query, user, data) {
  const methodToken = data.slice('pay:'.length);
  const currencyUser = await User.findByPk(user.id);
  if (!(await paymentTokenMatchesCustomerCurrency(currencyUser || user, methodToken))) {
    return answerCallback(query.id, user.lang === 'en' ? 'This payment method is unavailable.' : 'طريقة الدفع غير متاحة حالياً.', true);
  }
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
  const expectedTotal = effectiveProductPrice(product) * Number(state.quantity);

  let method = methodToken;
  let customMethod = null;
  let sharedMethod = null;
  if (methodToken.startsWith('custom:')) {
    const customId = Number(methodToken.split(':')[1]);
    customMethod = await PaymentMethod.findOne({ where: { id: customId, isActive: true } });
    if (!customMethod) return answerCallback(query.id, user.lang === 'en' ? 'Payment method is unavailable.' : 'طريقة الدفع غير متاحة.', true);
    method = `custom:${customMethod.id}`;
    const walletPart = Math.min(Number(freshUser.balance || 0), expectedTotal);
    const expectedExternal = Math.max(0, expectedTotal - walletPart) || expectedTotal;
    const local = paymentLocalAmount(expectedExternal, customMethod);
    const minimumLocal = minimumTransferForMethod(customMethod);
    if (local.amount + 1e-9 < minimumLocal) {
      return answerCallback(query.id, user.lang === 'en'
        ? `Minimum for this method is ${formatPaymentCurrencyAmount(minimumLocal, local.currency, user.lang)}.`
        : `الحد الأدنى لهذه الطريقة هو ${formatPaymentCurrencyAmount(minimumLocal, local.currency, user.lang)}.`, true);
    }
  } else if (methodToken.startsWith('shared:')) {
    const sharedId = methodToken.slice('shared:'.length);
    try {
      const shared = await network.listSharedPaymentMethods();
      sharedMethod = (shared.methods || []).find(row => String(row.id || '') === sharedId && row.isActive !== false) || null;
    } catch (error) {
      console.error('Resolve shared payment:', error.message);
    }
    if (!sharedMethod) return answerCallback(query.id, user.lang === 'en' ? 'Shared payment method is unavailable.' : 'طريقة الدفع المشتركة غير متاحة.', true);
    method = `shared:${sharedMethod.id}`;
    const walletPart = Math.min(Number(freshUser.balance || 0), expectedTotal);
    const expectedExternal = Math.max(0, expectedTotal - walletPart);
    const local = paymentLocalAmount(expectedExternal, sharedMethod);
    const minimumLocal = minimumTransferForMethod(sharedMethod);
    if (local.amount + 1e-9 < minimumLocal) {
      return answerCallback(query.id, user.lang === 'en'
        ? `Minimum for this method is ${formatPaymentCurrencyAmount(minimumLocal, local.currency, user.lang)}.`
        : `الحد الأدنى لهذه الطريقة هو ${formatPaymentCurrencyAmount(minimumLocal, local.currency, user.lang)}.`, true);
    }
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

  if (sharedMethod) {
    order.paymentOrigin = 'network_shared';
    await order.save({ fields: ['paymentOrigin'] });
    const local = paymentLocalAmount(amountDue, sharedMethod);
    const minimumLocal = minimumTransferForMethod(sharedMethod);
    if (local.amount + 1e-9 < minimumLocal) {
      await refundWalletReservation(order.id).catch(() => {});
      await order.update({ status: 'cancelled' }).catch(() => {});
      return bot.sendMessage(user.id, user.lang === 'en'
        ? `❌ Minimum for this method is ${formatPaymentCurrencyAmount(minimumLocal, local.currency, user.lang)}.`
        : `❌ الحد الأدنى لهذه الطريقة هو ${formatPaymentCurrencyAmount(minimumLocal, local.currency, user.lang)}.`);
    }
    await setState(user.id, {
      action: 'shared_payment_proof',
      orderId: order.id,
      sharedPaymentMethodId: sharedMethod.id,
      methodNameAr: sharedMethod.nameAr,
      methodNameEn: sharedMethod.nameEn,
      paymentAmount: local.amount
    });
    const methodName = user.lang === 'en' ? (sharedMethod.nameEn || sharedMethod.nameAr) : (sharedMethod.nameAr || sharedMethod.nameEn);
    return bot.sendMessage(user.id, [
      `💳 <b>${escapeHtml(methodName)}</b>`,
      sharedMethod.ownerShopName ? `${user.lang === 'en' ? 'Payment owner' : 'صاحب طريقة الدفع'}: <b>${escapeHtml(sharedMethod.ownerShopName)}</b>` : '',
      '',
      `${user.lang === 'en' ? 'Amount to send' : 'المبلغ المطلوب'}: <b>${formatPaymentCurrencyAmount(local.amount, local.currency, user.lang)}</b>`,
      `${user.lang === 'en' ? 'Send to' : 'حوّل إلى'}: <code>${escapeHtml(sharedMethod.paymentNumber)}</code>`,
      `${user.lang === 'en' ? 'Minimum transfer' : 'الحد الأدنى للتحويل'}: <b>${formatPaymentCurrencyAmount(minimumLocal, local.currency, user.lang)}</b>`,
      '',
      t(user.lang, 'proofPrompt'),
      user.lang === 'en' ? 'The payment-method owner will confirm receipt.' : 'صاحب طريقة الدفع راح يؤكد وصول المبلغ.'
    ].filter(Boolean).join('\n'), { parse_mode: 'HTML', reply_markup: cancelInlineKeyboard() });
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
      return bot.sendMessage(user.id, [
        `✅ <b>${user.lang === 'en' ? 'Payment request created' : 'تم إنشاء طلب الدفع'}</b>`,
        '',
        `💰 ${user.lang === 'en' ? 'Send' : 'حوّل'}: <b>${Number(amountDue).toFixed(2)} USDT</b>`,
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
      `${user.lang === 'en' ? 'Amount to send' : 'المبلغ المطلوب'}: <b>${formatPaymentCurrencyAmount(inheritedLocal.amount, inheritedLocal.currency, user.lang)}</b>`,
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
      `${user.lang === 'en' ? 'Amount to send' : 'المبلغ المطلوب'}: <b>${moneyIqd(iqd)}</b>`,
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
      `${user.lang === 'en' ? 'Amount to send' : 'المبلغ المطلوب'}: <b>${formatPaymentCurrencyAmount(local.amount, local.currency, user.lang)}</b>`,
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
  const text = await binancePay.instructions(transfer, user.lang);
  return bot.sendMessage(user.id, text, {
    parse_mode: 'HTML',
    reply_markup: cancelInlineKeyboard()
  });
}

async function handleTopupStart(query, user, methodToken) {
  const currencyUser = await User.findByPk(user.id);
  if (!(await paymentTokenMatchesCustomerCurrency(currencyUser || user, methodToken))) {
    return answerCallback(query.id, user.lang === 'en' ? 'This payment method is unavailable.' : 'طريقة الدفع غير متاحة حالياً.', true);
  }
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
    topupMinimumUsd: inputContext.minimumUsd,
    topupMinimumLocal: inputContext.minimumLocal || null
  });
  await answerCallback(query.id);
  return bot.sendMessage(user.id, topupAmountPrompt(inputContext, user.lang), { reply_markup: cancelInlineKeyboard() });
}

async function repairLegacyFreeFragmentsLocal(product, rawText, transaction) {
  if (String(product?.type || '').toLowerCase() !== 'free') return 0;
  const fragments = String(rawText || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => String(line || '').trim())
    .filter(Boolean);
  if (fragments.length < 2) return 0;

  const ownerShopId = network.enabledClient() ? String(config.network.shopId || '') : 'master';
  const candidates = await Code.findAll({
    where: { merchantId: product.id, isUsed: false, usedCount: 0, maxUses: 1, stockOwnerShopId: ownerShopId },
    order: [['id', 'ASC']],
    transaction,
    lock: transaction?.LOCK?.UPDATE
  });
  const buckets = new Map();
  for (const row of candidates) {
    let payload;
    try { payload = decryptPayload(row.value, row.extra); } catch { continue; }
    const legacyRaw = String(payload?.raw || payload?.extra || '').replace(/\r\n/g, '\n').trim();
    if (!legacyRaw || legacyRaw.includes('\n')) continue;
    if (!buckets.has(legacyRaw)) buckets.set(legacyRaw, []);
    buckets.get(legacyRaw).push(row.id);
  }
  const ids = [];
  const usedPerFragment = new Map();
  for (const fragment of fragments) {
    const rows = buckets.get(fragment) || [];
    const used = usedPerFragment.get(fragment) || 0;
    if (used >= rows.length) return 0;
    ids.push(rows[used]);
    usedPerFragment.set(fragment, used + 1);
  }
  if (ids.length < 2) return 0;
  await Code.destroy({ where: { id: { [Op.in]: ids } }, transaction });
  return ids.length;
}

async function finalizeNewProduct(user, data) {
  const imageValue = data.imageValue || '-';
  const requestedScope = String(data.scope || (data.localOnly ? 'local' : 'public')).toLowerCase();
  const visibilityScope = requestedScope === 'local' ? 'private' : 'public';
  const creatorDisplayName = String(user.firstName || user.username || config.network.shopName || config.network.ownerName || user.id).trim();
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
      warrantyArHtml: data.warrantyArHtml || '',
      serviceInputMode: data.serviceInputMode || '',
      servicePromptAr: data.servicePromptAr || '',
      servicePromptEn: data.servicePromptEn || ''
    },
    image: imageValue === '-' ? null : (/^https?:\/\//i.test(imageValue) ? imageValue : null),
    isActive: true,
    visibilityScope,
    createdByAdminId: Number(user.id),
    createdByDisplayName: creatorDisplayName,
    sharedLimit: (data.type || 'free') === 'shared' ? 5 : 1,
    deliveryMode: (data.type || 'free') === 'service' ? 'service_request' : 'instant'
  };

  const isService = productPayload.type === 'service';
  const isLocalOnly = isService || visibilityScope === 'private';
  let product;
  if (isLocalOnly) {
    // Local products and all service products belong only to the bot/shop that
    // created them and never enter the shared catalog.
    product = await Merchant.create({
      ...productPayload,
      image: imageValue === '-' ? null : imageValue,
      networkProductId: crypto.randomUUID(),
      networkManaged: false,
      networkOwnerShopId: network.enabledClient() ? String(config.network.shopId || '') : (network.isMaster() ? 'master' : String(config.network.shopId || 'master')),
      networkStock: 0,
      visibilityScope: 'private',
      localPublicationStatus: 'published',
      createdByAdminId: Number(user.id),
      createdByDisplayName: creatorDisplayName,
      ownerNote: isService ? 'Local service' : 'Local product'
    });
  } else if (network.enabledClient()) {
    const remote = await network.createRemoteProduct(productPayload);
    const rp = remote.product;
    const localValues = {
      ...productPayload,
      image: productPayload.image || (imageValue === '-' ? null : imageValue),
      networkProductId: rp.networkProductId,
      networkManaged: true,
      networkOwnerShopId: rp.networkOwnerShopId || config.network.shopId,
      networkStock: Number(rp.stock || 0),
      networkBasePriceUsd: Number(rp.price ?? productPayload.price),
      localPriceOverrideUsd: null,
      visibilityScope: 'public',
      localPublicationStatus: 'published',
      createdByAdminId: Number(user.id),
      createdByDisplayName: creatorDisplayName,
      ownerNote: 'Network product'
    };
    // The 30-second catalog watcher can observe the remote product between the
    // API response and this local write. Reuse that row if it won the race, then
    // mark the creator's own copy published instead of failing on the UUID.
    const [localProduct, created] = await Merchant.findOrCreate({
      where: { networkProductId: rp.networkProductId },
      defaults: localValues
    });
    if (!created) await localProduct.update(localValues);
    product = localProduct;
  } else {
    product = await Merchant.create({
      ...productPayload,
      image: imageValue === '-' ? null : imageValue,
      networkProductId: crypto.randomUUID(),
      networkManaged: false,
      networkOwnerShopId: network.isMaster() ? 'master' : config.network.shopId,
      networkStock: 0,
      visibilityScope: 'public',
      localPublicationStatus: 'published',
      createdByAdminId: Number(user.id),
      createdByDisplayName: creatorDisplayName,
      ownerNote: null
    });
  }

  if (network.isMaster() && !isLocalOnly) {
    await network.publishNotificationEvent({
      eventType: 'new_product',
      networkProductId: product.networkProductId,
      actorShopId: 'master',
      actorName: creatorDisplayName,
      payload: {
        nameAr: product.nameAr,
        nameEn: product.nameEn,
        price: Number(product.price),
        type: product.type,
        description: product.description || {},
        createdByAdminId: Number(user.id),
        createdByDisplayName: creatorDisplayName
      }
    }).catch(error => console.error('Publish product notification:', error.message));
  }

  if (product.type === 'service') {
    await clearState(user.id);
    await bot.sendMessage(user.id, '✅ تم إنشاء خدمة محلية داخل هذا البوت فقط. لن تُرسل إلى البوت الرئيسي أو بقية بوتات الشبكة. هذا النوع يطلب بيانات من الزبون ويعطيك أزرار: تم التفعيل / تأجيل / استرداد / فتح محادثة.', {
      reply_markup: { inline_keyboard: [[{ text: 'فتح المنتج', callback_data: `adm:edit:${product.id}` }]] }
    });
    return true;
  }

  await setState(user.id, { action: 'admin_add_stock', productId: product.id, afterCreate: true });
  const publicationText = isLocalOnly
    ? '✅ تم إنشاء المنتج محلياً داخل هذا البوت فقط.'
    : '✅ تم إنشاء المنتج العام داخل هذا البوت، وسيصل لبقية إدارات البوتات حتى يقرر كل أدمن تسعيره ونشره أو رفضه.';
  await bot.sendMessage(user.id, `${publicationText}\nحالياً مخزونه صفر لذلك يظهر بالأحمر.\n\n${stockPrompt(product)}`, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [
      [
        { text: '✏️ تعديل المنتج', callback_data: `adm:edit:${product.id}`, style: 'primary' },
        { text: '🗑 حذف المنتج', callback_data: `adm:delete:${product.id}`, style: 'danger' }
      ],
      [{ text: '❌ إغلاق إضافة المخزون', callback_data: 'flow:cancel', style: 'danger' }]
    ] }
  });
  return true;
}

async function promoteLocalProductToNetwork(product, admin) {
  if (!product || !canManageNetworkProduct(product)) throw new Error('PRODUCT_NOT_OWNED');
  if (String(product.visibilityScope || '').toLowerCase() !== 'private') throw new Error('PRODUCT_ALREADY_PUBLIC');
  if (String(product.type || '') === 'service') throw new Error('SERVICE_PRODUCTS_MUST_BE_LOCAL');
  if (network.isClient() && !network.enabledClient()) throw new Error('NETWORK_API_NOT_CONFIGURED');

  const partialShared = String(product.type || '') === 'shared'
    ? await Code.count({ where: { merchantId: product.id, isUsed: false, usedCount: { [Op.gt]: 0 } } })
    : 0;
  if (partialShared > 0) throw new Error(`PARTIAL_SHARED_INVENTORY:${partialShared}`);

  const transferableRows = await Code.findAll({
    where: {
      merchantId: product.id,
      isUsed: false,
      usedCount: 0,
      [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date() } }]
    },
    order: [['id', 'ASC']]
  });
  const inventoryItems = transferableRows.map(row => decryptPayload(row.value, row.extra));
  const creatorDisplayName = String(product.createdByDisplayName || admin?.firstName || admin?.username || config.network.shopName || admin?.id || '').trim();
  const payload = {
    nameAr: product.nameAr,
    nameEn: product.nameEn || product.nameAr,
    price: Number(product.price || 0),
    category: product.category || 'عام',
    type: product.type || 'free',
    description: product.description || {},
    image: /^https?:\/\//i.test(String(product.image || '')) ? product.image : null,
    isActive: product.isActive !== false,
    visibilityScope: 'public',
    createdByAdminId: product.createdByAdminId || Number(admin?.id || 0) || null,
    createdByDisplayName: creatorDisplayName,
    sharedLimit: Number(product.sharedLimit || 1),
    deliveryMode: product.deliveryMode || 'instant',
    sortOrder: Number(product.sortOrder || 0)
  };

  if (network.enabledClient()) {
    let remoteProduct = null;
    let remoteStock = 0;
    try {
      const created = await network.createRemoteProduct(payload, { suppressNotification: true });
      remoteProduct = created?.product;
      if (!remoteProduct?.networkProductId) throw new Error('REMOTE_PRODUCT_CREATE_FAILED');
      if (String(product.type || '') === 'free') {
        for (const item of inventoryItems) {
          const result = await network.addRemoteInventory(remoteProduct.networkProductId, [item], { suppressNotification: true });
          remoteStock = Number(result.stock || remoteStock);
        }
      } else {
        for (let index = 0; index < inventoryItems.length; index += 500) {
          const result = await network.addRemoteInventory(remoteProduct.networkProductId, inventoryItems.slice(index, index + 500), { suppressNotification: true });
          remoteStock = Number(result.stock || remoteStock);
        }
      }

      const transaction = await sequelize.transaction();
      try {
        // The 30-second catalog watcher may have inserted the just-created
        // remote row while a large local inventory was uploading. Keep the
        // original local product ID/editor links and remove only that empty
        // synchronized duplicate before attaching the remote ID.
        await Merchant.destroy({
          where: {
            networkProductId: remoteProduct.networkProductId,
            id: { [Op.ne]: product.id },
            networkManaged: true
          },
          transaction
        });
        product.networkProductId = remoteProduct.networkProductId;
        product.networkManaged = true;
        product.networkOwnerShopId = remoteProduct.networkOwnerShopId || String(config.network.shopId || '');
        product.networkStock = inventoryItems.length ? remoteStock : Number(remoteProduct.stock || 0);
        product.networkBasePriceUsd = Number(remoteProduct.price ?? product.price ?? 0);
        product.visibilityScope = 'public';
        product.localPublicationStatus = 'published';
        product.localReviewNotifiedAt = new Date();
        await product.save({ transaction, fields: [
          'networkProductId', 'networkManaged', 'networkOwnerShopId', 'networkStock',
          'networkBasePriceUsd', 'visibilityScope', 'localPublicationStatus', 'localReviewNotifiedAt'
        ] });
        if (transferableRows.length) {
          await Code.destroy({ where: { id: { [Op.in]: transferableRows.map(row => row.id) } }, transaction });
        }
        await transaction.commit();
      } catch (error) {
        await transaction.rollback();
        throw error;
      }
      await network.publishRemoteProduct(remoteProduct.networkProductId).catch(error => {
        console.error('Publish promoted product event:', error.message);
      });
      return { product, transferred: inventoryItems.length, stock: Number(product.networkStock || 0) };
    } catch (error) {
      if (remoteProduct?.networkProductId && String(product.visibilityScope || '').toLowerCase() === 'private') {
        await network.deleteRemoteProduct(remoteProduct.networkProductId).catch(() => {});
      }
      throw error;
    }
  }

  product.visibilityScope = 'public';
  product.localPublicationStatus = 'published';
  product.networkOwnerShopId = 'master';
  product.networkBasePriceUsd = Number(product.price || 0);
  product.localReviewNotifiedAt = new Date();
  await product.save({ fields: [
    'visibilityScope', 'localPublicationStatus', 'networkOwnerShopId',
    'networkBasePriceUsd', 'localReviewNotifiedAt'
  ] });
  if (network.isMaster()) {
    await network.publishNotificationEvent({
      eventType: 'new_product',
      networkProductId: product.networkProductId,
      actorShopId: 'master',
      actorName: creatorDisplayName,
      payload: { nameAr: product.nameAr, nameEn: product.nameEn, price: Number(product.price), type: product.type, description: product.description || {} }
    });
  }
  return { product, transferred: 0, stock: await getProductStock(product.id) };
}

function railwayServiceVariableReference(serviceName, variableName) {
  let name = String(serviceName || '').trim();
  if (!name || /[\r\n{}]/.test(name)) name = 'Postgres قاعدة البيانات';
  const referenceName = /^[A-Za-z0-9_-]+$/.test(name)
    ? name
    : `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return '${{' + referenceName + '.' + String(variableName || '').trim() + '}}';
}

function railwayEnvironmentValue(value) {
  const text = String(value ?? '');
  return /^[A-Za-z0-9_./:@?&=+%-]+$/.test(text) ? text : JSON.stringify(text);
}

function splitRailwayCopyChunks(rawVariables, maxLength = 230) {
  const chunks = [];
  let current = '';
  for (const line of String(rawVariables || '').split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxLength && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function verifyPartnerBotToken(token) {
  if (String(token) === String(config.token)) {
    return { ok: false, reason: 'هذا توكن البوت الرئيسي نفسه. أنشئ بوتاً جديداً من BotFather.' };
  }
  try {
    const response = await axios.get(`https://api.telegram.org/bot${token}/getMe`, {
      timeout: 12000,
      validateStatus: () => true
    });
    if (response.status !== 200 || response.data?.ok !== true || response.data?.result?.is_bot !== true) {
      return { ok: false, reason: 'Telegram رفض التوكن. انسخه من BotFather مرة ثانية.' };
    }
    return {
      ok: true,
      username: String(response.data.result.username || '').trim()
    };
  } catch {
    return { ok: false, reason: 'تعذر فحص التوكن مع Telegram الآن. أرسله مرة ثانية بعد قليل.' };
  }
}

async function completePartnerBotSetup(user, data, partnerBotToken) {
  const masterApiUrl = String(config.network.publicUrl || '').trim().replace(/\/$/, '');
  if (!/^https:\/\//i.test(masterApiUrl)) {
    throw Object.assign(new Error('MASTER_PUBLIC_URL_REQUIRED'), { code: 'MASTER_PUBLIC_URL_REQUIRED' });
  }

  const currency = ['USD', 'IQD', 'EGP'].includes(String(config.network.settlementCurrency || '').toUpperCase())
    ? String(config.network.settlementCurrency).toUpperCase()
    : 'USD';
  const created = await network.createClient({
    name: data.name,
    ownerTelegramId: data.ownerTelegramId,
    settlementCurrency: currency
  });
  const databaseReference = railwayServiceVariableReference(
    config.railway?.databaseServiceName,
    'DATABASE_URL'
  );
  const rawVariables = [
    `BOT_TOKEN=${railwayEnvironmentValue(partnerBotToken)}`,
    `ADMIN_IDS=${railwayEnvironmentValue(data.ownerTelegramId)}`,
    `DATABASE_URL=${databaseReference}`,
    `DATABASE_SCHEMA=${railwayEnvironmentValue(created.databaseSchema)}`,
    'NETWORK_ROLE=client',
    `NETWORK_API_URL=${railwayEnvironmentValue(masterApiUrl)}`,
    `NETWORK_API_KEY=${railwayEnvironmentValue(created.apiKey)}`,
    `NETWORK_SHOP_ID=${railwayEnvironmentValue(created.row.shopId)}`,
    `NETWORK_SHOP_NAME=${railwayEnvironmentValue(created.row.name)}`,
    `NETWORK_SETTLEMENT_CURRENCY=${currency}`
  ].join('\n');
  const copyChunks = splitRailwayCopyChunks(rawVariables);

  await bot.sendMessage(user.id, [
    '✅ <b>بوت الشريك صار جاهز بالكامل</b>',
    `الاسم: <b>${escapeHtml(created.row.name)}</b>`,
    `Shop ID: <code>${escapeHtml(created.row.shopId)}</code>`,
    `Schema المنفصل: <code>${escapeHtml(created.databaseSchema)}</code>`,
    '',
    'ما يحتاج تختار عملة أو تكتب أي متغير إضافي.',
    'داخل خدمة البوت الجديدة في Railway افتح <b>Variables → Raw Editor</b>، انسخ البلوك كاملاً والصقه ثم اضغط Deploy.',
    '',
    `<pre>${escapeHtml(rawVariables)}</pre>`,
    '',
    copyChunks.length > 1
      ? `الأزرار بالأسفل قسمت النص بسبب حد Telegram. انسخ الأجزاء <b>كلها بالترتيب من 1 إلى ${copyChunks.length}</b> داخل Raw Editor نفسه.`
      : 'استخدم زر النسخ بالأسفل والصق النص في Raw Editor.',
    '🔐 لا ترسل هذا البلوك لأي شخص لأنه يحتوي توكن البوت ومفتاح الشبكة.'
  ].join('\n'), {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: copyChunks.map((chunk, index) => [{
      text: copyChunks.length === 1
        ? '📋 نسخ إعدادات Railway كاملة'
        : `📋 نسخ الجزء ${index + 1}/${copyChunks.length}`,
      copy_text: { text: chunk }
    }]) }
  });
  await clearState(user.id);
  return created;
}

async function handleStateMessage(msg, user, state) {
  if (state.action === 'virtual_number_search') {
    const queryText = String(msg.text || '').trim();
    if (!queryText) {
      await bot.sendMessage(user.id, user.lang === 'en' ? 'Send a service name or code.' : 'أرسل اسم الخدمة أو رمزها.');
      return true;
    }
    try {
      const providerId = String(state.providerId || '');
      const services = await virtualNumbers.listServices(providerId);
      const rawMatches = (await searchVirtualServices(services, queryText)).slice(0, 30);
      let summary = [];
      try { summary = await virtualNumbers.availableServicesSummary(providerId); } catch {}
      const availableCodes = new Set(summary.map(row => String(row.serviceCode)));
      let matches = summary.length ? rawMatches.filter(service => availableCodes.has(String(service.code))) : [];

      // If the provider's all-prices endpoint is temporarily incomplete, verify
      // search candidates individually instead of showing dead buttons.
      if (!summary.length && rawMatches.length) {
        const checked = await Promise.all(rawMatches.slice(0, 15).map(async service => {
          try {
            const rows = await virtualNumbers.availabilityForService(providerId, service.code, true);
            return rows.length ? service : null;
          } catch { return null; }
        }));
        matches = checked.filter(Boolean);
      }

      await clearState(user.id);
      if (!matches.length) {
        const anyService = findAnyOtherVirtualService(services);
        let anyAvailable = false;
        if (anyService) {
          if (availableCodes.has(String(anyService.code))) anyAvailable = true;
          else {
            try { anyAvailable = (await virtualNumbers.availabilityForService(providerId, anyService.code, true)).length > 0; }
            catch {}
          }
        }
        if (anyService && anyAvailable) {
          await bot.sendMessage(user.id, user.lang === 'en'
            ? '🔄 That service is not currently available. I found <b>Any number</b> instead; current prices are below.'
            : '🔄 الخدمة اللي بحثت عنها مو متوفرة حالياً. ظهر لك بدلها <b>أي رقم</b> والأسعار الحالية:', { parse_mode: 'HTML' });
          return showVirtualCountries(user.id, user, providerId, anyService.code, 0, { noFallback: true });
        }
        await bot.sendMessage(user.id, user.lang === 'en'
          ? '🔎 No currently available option matched that search. Try another service name.'
          : '🔎 ما حصلت خيار متاح حالياً يطابق البحث. جرّب اسم خدمة ثانية.');
        return true;
      }

      const labels = await Promise.all(matches.map(service => virtualServiceDisplayName(service, user.lang)));
      const summaryByCode = new Map(summary.map(row => [String(row.serviceCode), row]));
      const keyboard = matches.map((service, index) => [{
        text: `📲 ${labels[index]}${summaryByCode.has(String(service.code)) ? ` • ${virtualRetailPriceText(summaryByCode.get(String(service.code)).retailPrice)}` : ''}`,
        callback_data: `vn:svc:${providerId}:${service.code}`,
        style: 'primary'
      }]);
      keyboard.push([{ text: user.lang === 'en' ? '⬅️ Popular services' : '⬅️ الخدمات المشهورة', callback_data: `vn:p:${providerId}` }]);
      await bot.sendMessage(user.id, user.lang === 'en'
        ? `🔎 Found ${matches.length} currently available matching service(s):`
        : `🔎 حصلت ${matches.length} خدمة مطابقة ومتوفرة حالياً:`, { reply_markup: { inline_keyboard: keyboard } });
      return true;
    } catch (error) {
      await clearState(user.id);
      await bot.sendMessage(user.id, `❌ ${virtualNumberErrorText(error, user.lang)}`);
      return true;
    }
  }

  if (state.action === 'virtual_number_country_search') {
    const queryText = String(msg.text || '').trim();
    if (!queryText) {
      await bot.sendMessage(user.id, user.lang === 'en' ? 'Send a country name in English or Arabic.' : 'أرسل اسم الدولة بالعربي أو بالإنجليزي.');
      return true;
    }
    try {
      const providerId = String(state.providerId || '');
      const serviceCode = String(state.serviceCode || '');
      const services = await virtualNumbers.listServices(providerId);
      const service = services.find(row => row.code === serviceCode);
      if (!service) throw Object.assign(new Error('BAD_SERVICE'), { code: 'BAD_SERVICE' });
      let rows = await virtualNumbers.availabilityForService(providerId, serviceCode, true);
      let matches = searchVirtualCountries(rows, queryText);
      if (!matches.length && looksArabic(queryText)) {
        let translated = '';
        try { translated = await translateArToEn(queryText); } catch {}
        if (translated && normalizeVirtualSearch(translated) !== normalizeVirtualSearch(queryText)) {
          matches = searchVirtualCountries(rows, translated);
        }
      }
      matches = matches.slice(0, 30);
      await clearState(user.id);
      if (!matches.length) {
        await bot.sendMessage(user.id, user.lang === 'en'
          ? '❌ No matching available country found.'
          : '❌ ما حصلت دولة متوفرة تطابق البحث.');
        return true;
      }
      const serviceName = await virtualServiceDisplayName(service, user.lang);
      const showProviderCost = canSeeVirtualProviderCost(user);
      const keyboard = matches.map(row => {
        const country = localizedVirtualCountry(row.countryName, user.lang);
        const priceText = showProviderCost
          ? virtualProviderCostText(row.providerCost, row.retailPrice)
          : virtualRetailPriceText(row.retailPrice);
        return [{
          text: `${country.flag} ${country.name} • ${priceText} • ${row.count}`,
          callback_data: `vn:quote:${providerId}:${serviceCode}:${row.countryId}`,
          style: 'primary'
        }];
      });
      keyboard.push([{ text: user.lang === 'en' ? '⬅️ All countries' : '⬅️ كل الدول', callback_data: `vn:countries:${providerId}:${serviceCode}:0` }]);
      await bot.sendMessage(user.id, user.lang === 'en'
        ? `🔎 <b>${premiumLabelHtml(serviceName)}</b> — found ${matches.length} country result(s), ordered by price.`
        : `🔎 <b>${premiumLabelHtml(serviceName)}</b> — حصلت ${matches.length} دولة، مرتبة حسب السعر.`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard }
      });
      return true;
    } catch (error) {
      await clearState(user.id);
      await bot.sendMessage(user.id, `❌ ${virtualNumberErrorText(error, user.lang)}`);
      return true;
    }
  }

  if (state.action === 'service_input') {
    const order = await PurchaseOrder.findByPk(state.orderId);
    if (!order || String(order.userId) !== String(user.id) || String(order.status) !== 'service_pending_input') {
      await clearState(user.id);
      return true;
    }
    const product = await Merchant.findByPk(order.merchantId);
    const meta = servicePromptMeta(product);
    const text = String(msg.text || '').trim();
    let value = text;
    if (meta.inputMode === 'email') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
        await bot.sendMessage(user.id, user.lang === 'en' ? '❌ Send a valid email address.' : '❌ أرسل إيميل صحيح.');
        return true;
      }
    } else if (meta.inputMode === 'phone') {
      const digits = text.replace(/[^\d+]/g, '');
      if (!digits || digits.length < 7) {
        await bot.sendMessage(user.id, user.lang === 'en' ? '❌ Send a valid phone number.' : '❌ أرسل رقم صحيح.');
        return true;
      }
      value = digits;
    } else if (!text) {
      return true;
    }

    order.delivery = [{
      serviceRequest: true,
      inputMode: meta.inputMode,
      submitted: true,
      customerValue: value,
      submittedAt: new Date().toISOString(),
      needsAdminAction: true
    }];
    order.status = 'service_pending_admin';
    await order.save({ fields: ['delivery', 'status'] });
    await clearState(user.id);
    await bot.sendMessage(user.id, user.lang === 'en'
      ? '✅ Your details were received. Please wait while the admin completes the service.'
      : '✅ تم استلام بياناتك. انتظر حتى يقوم الأدمن بتنفيذ الخدمة.');
    const label = user.username ? `@${user.username}` : `<code>${user.id}</code>`;
    for (const adminId of getAdminIds()) {
      await bot.sendMessage(adminId, [
        '🛠 <b>طلب تنفيذ خدمة جديد</b>',
        `الطلب: <b>#${order.id}</b>`,
        `المنتج: <b>${escapeHtml(productDisplayName(product, 'ar'))}</b>`,
        `المستخدم: ${label}`,
        `نوع الحقل: <b>${escapeHtml(serviceInputModeLabel(meta.inputMode, 'ar'))}</b>`,
        `البيانات: <code>${escapeHtml(value)}</code>`
      ].join('\n'), {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: '✅ تم التفعيل', callback_data: `service:done:${order.id}`, style: 'success' }],
          [{ text: '⏳ تأجيل 30 دقيقة', callback_data: `service:delay:${order.id}` }],
          [{ text: '💬 فتح محادثة مع الزبون', callback_data: `service:chat:${order.id}` }],
          [{ text: '↩️ إلغاء العملية واسترداد الأموال', callback_data: `service:refund:${order.id}`, style: 'danger' }]
        ] }
      }).catch(() => {});
    }
    return true;
  }

  if (state.action === 'support_chat') {
    const ticket = await SupportTicket.findByPk(state.ticketId);
    if (!ticket || ticket.status !== 'open' || String(ticket.userId) !== String(user.id)) {
      await clearState(user.id);
      return true;
    }
    await sendSupportMessageToAdmins(msg, user, ticket);
    await bot.sendMessage(user.id, user.lang === 'en'
      ? '✅ Your message reached support. You can send another message.'
      : '✅ وصلت رسالتك للدعم. تقدر ترسل رسالة ثانية.', {
      reply_markup: { inline_keyboard: [[{
        text: user.lang === 'en' ? '❌ Close chat' : '❌ إغلاق الدردشة',
        callback_data: `support:userclose:${ticket.id}`,
        style: 'danger'
      }]] }
    });
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
    if (state.keepOpen) {
      await bot.sendMessage(ticket.userId, targetLang === 'en' ? 'Chat controls:' : 'أزرار الدردشة:', {
        reply_markup: { inline_keyboard: [[{
          text: targetLang === 'en' ? '❌ Close chat' : '❌ إغلاق الدردشة',
          callback_data: `support:userclose:${ticket.id}`,
          style: 'danger'
        }]] }
      }).catch(() => {});
      await bot.sendMessage(user.id, '✅ تم إرسال الرسالة. المحادثة ما زالت مفتوحة، ارسل رسالة ثانية أو أغلقها من الزر.', {
        reply_markup: { inline_keyboard: [[{
          text: '❌ إغلاق الدردشة',
          callback_data: `support:close:${ticket.id}`,
          style: 'danger'
        }]] }
      });
    } else {
      await clearState(user.id);
      await bot.sendMessage(user.id, '✅ تم إرسال الرد للمستخدم.');
    }
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
    const maxAllowed = product?.type === 'service' ? 1 : Math.min(stock, 100);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > maxAllowed) {
      await bot.sendMessage(user.id, user.lang === 'en' ? `❌ Send a whole number from 1 to ${maxAllowed}.` : `❌ أرسل رقم صحيح من 1 إلى ${maxAllowed}.`);
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
    const minimumLocal = minimumTopupLocalAmount(inputRate, inputCurrency, minimumUsd, state.topupMinimumLocal);
    const exactUsd = enteredAmount / (Number.isFinite(inputRate) && inputRate > 0 ? inputRate : 1);
    const amount = Number(exactUsd.toFixed(8));

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

    if (String(state.method || '').startsWith('shared:')) {
      const sharedId = String(state.method).slice('shared:'.length);
      let sharedMethod = null;
      try {
        const shared = await network.listSharedPaymentMethods();
        sharedMethod = (shared.methods || []).find(row => String(row.id || '') === sharedId && row.isActive !== false) || null;
      } catch (error) {
        console.error('Resolve shared topup method:', error.message);
      }
      if (!sharedMethod) {
        await clearState(user.id);
        await bot.sendMessage(user.id, user.lang === 'en' ? '❌ Shared payment method is unavailable.' : '❌ طريقة الدفع المشتركة غير متاحة.');
        return true;
      }
      const transaction = await BalanceTransaction.create({
        userId: user.id,
        amount,
        type: 'deposit',
        txid: `SHARED-${Date.now()}-${user.id}`,
        caption: `${sharedMethod.nameAr || sharedMethod.nameEn} shared wallet topup (${enteredAmount} ${inputCurrency})`,
        status: 'awaiting_proof',
        paymentOrigin: 'network_shared',
        networkMethod: sharedMethod.id,
        lastReminderAt: new Date()
      });
      await setState(user.id, {
        action: 'shared_topup_proof',
        transactionId: transaction.id,
        sharedPaymentMethodId: sharedMethod.id,
        methodNameAr: sharedMethod.nameAr,
        methodNameEn: sharedMethod.nameEn,
        paymentAmount: enteredAmount
      });
      const methodName = user.lang === 'en' ? (sharedMethod.nameEn || sharedMethod.nameAr) : (sharedMethod.nameAr || sharedMethod.nameEn);
      await bot.sendMessage(user.id, [
        `💳 <b>${escapeHtml(methodName)}</b>`,
        sharedMethod.ownerShopName ? `${user.lang === 'en' ? 'Payment owner' : 'صاحب طريقة الدفع'}: <b>${escapeHtml(sharedMethod.ownerShopName)}</b>` : '',
        '',
        `${user.lang === 'en' ? 'Top-up amount' : 'مبلغ الشحن'}: <b>${formatPaymentCurrencyAmount(enteredAmount, inputCurrency, user.lang)}</b>`,
        `${user.lang === 'en' ? 'Wallet credit' : 'يضاف للمحفظة'}: <b>${formatPaymentCurrencyAmount(enteredAmount, inputCurrency, user.lang)}</b>`,
        `${user.lang === 'en' ? 'Send to' : 'حوّل إلى'}: <code>${escapeHtml(sharedMethod.paymentNumber)}</code>`,
        '',
        t(user.lang, 'proofPrompt'),
        user.lang === 'en' ? 'The payment-method owner will confirm receipt.' : 'صاحب طريقة الدفع راح يؤكد وصول المبلغ.'
      ].filter(Boolean).join('\n'), { parse_mode: 'HTML', reply_markup: cancelInlineKeyboard() });
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
        await bot.sendMessage(user.id, [
          `✅ <b>${user.lang === 'en' ? 'Top-up request created' : 'تم إنشاء طلب الشحن'}</b>`,
          '',
          `💰 ${user.lang === 'en' ? 'Send' : 'حوّل'}: <b>${Number(amount).toFixed(2)} USDT</b>`,
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
        `${user.lang === 'en' ? 'Wallet credit' : 'يضاف للمحفظة'}: <b>${formatPaymentCurrencyAmount(enteredAmount, inputCurrency, user.lang)}</b>`,
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
      `${user.lang === 'en' ? 'Wallet credit' : 'يضاف للمحفظة'}: <b>${formatPaymentCurrencyAmount(enteredAmount, inputCurrency, user.lang)}</b>`,
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
    const updated = await User.findByPk(user.id);
    const moneyContext = await customerMoneyContext(updated || user);
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
      `المنتج: <b>${escapeHtml(productDisplayName(product, 'ar'))}</b>`,
      `المستخدم: <code>${user.id}</code>`,
      `المبلغ المطلوب: <b>${moneyUsd(order.externalAmount || order.totalAmount)}</b>`
    ].join('\n');
    for (const adminId of getAdminIds()) {
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
    for (const adminId of getAdminIds()) {
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
    for (const adminId of getAdminIds()) {
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
    for (const adminId of getAdminIds()) {
      try {
        const sent = await bot.sendPhoto(adminId, fileId, {
          caption: [
            `${premiumEmojiHtml(PREMIUM_EMOJI.superqi)} <b>إيصال سوبركي</b>`,
            `الطلب: <code>#${order.id}</code>`,
            `الزبون: ${escapeHtml(user.firstName || '')} — <code>${user.id}</code>`,
            `المنتج: ${escapeHtml(productDisplayName(product, 'ar'))}`,
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

  if (state.action === 'shared_payment_proof') {
    const fileId = msg.photo?.length ? msg.photo[msg.photo.length - 1].file_id : msg.document?.file_id;
    if (!fileId) {
      await bot.sendMessage(user.id, t(user.lang, 'proofPrompt'));
      return true;
    }
    const order = await PurchaseOrder.findByPk(state.orderId);
    if (!order || String(order.userId) !== String(user.id) || order.status !== 'pending_payment') {
      await clearState(user.id);
      return true;
    }
    try {
      const created = await network.createSharedPaymentRequest({
        sharedPaymentMethodId: state.sharedPaymentMethodId,
        activity: 'purchase',
        sourceRef: `order:${order.id}`,
        sourceEntityId: String(order.id),
        customerId: String(user.id),
        customerName: user.firstName || user.username || String(user.id),
        amountUsd: Number(order.externalAmount || order.totalAmount),
        paymentAmount: Number(state.paymentAmount || 0) || undefined
      });
      order.proofFileId = fileId;
      order.status = 'proof_pending';
      order.paymentOrigin = 'network_shared';
      order.paymentRef = `sharedreq:${created.request.id}`;
      await order.save();
      await clearState(user.id);
      const ownerName = created.method?.ownerShopName || created.method?.ownerShopId || '';
      await bot.sendMessage(user.id, user.lang === 'en'
        ? `✅ Receipt recorded. ${ownerName ? `The payment owner (${ownerName})` : 'The payment owner'} will confirm the transfer, then delivery will complete automatically.`
        : `✅ تم تسجيل الإيصال. ${ownerName ? `صاحب طريقة الدفع (${ownerName})` : 'صاحب طريقة الدفع'} راح يؤكد وصول المبلغ، وبعدها يتم التسليم تلقائياً.`);
    } catch (error) {
      console.error('Create shared purchase request:', error.message);
      await bot.sendMessage(user.id, error.message === 'BELOW_MINIMUM_TRANSFER'
        ? '❌ المبلغ أقل من الحد الأدنى لهذه الطريقة.'
        : '❌ تعذر إرسال طلب التحقق لصاحب طريقة الدفع. جرّب مرة ثانية أو اكتب إغلاق.');
    }
    return true;
  }

  if (state.action === 'shared_topup_proof') {
    const fileId = msg.photo?.length ? msg.photo[msg.photo.length - 1].file_id : msg.document?.file_id;
    if (!fileId) {
      await bot.sendMessage(user.id, t(user.lang, 'proofPrompt'));
      return true;
    }
    const transaction = await BalanceTransaction.findByPk(state.transactionId);
    if (!transaction || String(transaction.userId) !== String(user.id) || transaction.status !== 'awaiting_proof') {
      await clearState(user.id);
      return true;
    }
    try {
      const created = await network.createSharedPaymentRequest({
        sharedPaymentMethodId: state.sharedPaymentMethodId,
        activity: 'topup',
        sourceRef: `topup:${transaction.id}`,
        sourceEntityId: String(transaction.id),
        customerId: String(user.id),
        customerName: user.firstName || user.username || String(user.id),
        amountUsd: Number(transaction.amount),
        paymentAmount: Number(state.paymentAmount || 0) || undefined
      });
      transaction.imageFileId = fileId;
      transaction.status = 'proof_pending';
      transaction.txid = `SHAREDREQ-${created.request.id}`;
      await transaction.save();
      await clearState(user.id);
      const ownerName = created.method?.ownerShopName || created.method?.ownerShopId || '';
      await bot.sendMessage(user.id, user.lang === 'en'
        ? `✅ Receipt recorded. ${ownerName ? `The payment owner (${ownerName})` : 'The payment owner'} will confirm it, then your wallet will be credited automatically.`
        : `✅ تم تسجيل الإيصال. ${ownerName ? `صاحب طريقة الدفع (${ownerName})` : 'صاحب طريقة الدفع'} راح يؤكد وصول المبلغ، وبعدها تنشحن محفظتك تلقائياً.`);
    } catch (error) {
      console.error('Create shared topup request:', error.message);
      await bot.sendMessage(user.id, error.message === 'BELOW_MINIMUM_TRANSFER'
        ? '❌ المبلغ أقل من الحد الأدنى لهذه الطريقة.'
        : '❌ تعذر إرسال طلب التحقق لصاحب طريقة الدفع. جرّب مرة ثانية أو اكتب إغلاق.');
    }
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
    const localAmount = paymentLocalAmount(Number(transaction.amount), paymentMethod);
    const icon = customPaymentEmoji(paymentMethod);
    for (const adminId of getAdminIds()) {
      try {
        await bot.sendPhoto(adminId, fileId, {
          caption: [
            `${icon ? premiumEmojiHtml(icon) : '💳'} <b>إيصال شحن ${escapeHtml(paymentMethod.nameAr)}</b>`,
            `العملية: <code>#${transaction.id}</code>`,
            `المستخدم: ${escapeHtml(user.firstName || '')} — <code>${user.id}</code>`,
            `المبلغ: ${formatPaymentCurrencyAmount(localAmount.amount, localAmount.currency, 'ar')}`,
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
    const localAmount = paymentLocalAmount(Number(order.externalAmount || order.totalAmount), paymentMethod);
    const icon = customPaymentEmoji(paymentMethod);
    for (const adminId of getAdminIds()) {
      try {
        const sent = await bot.sendPhoto(adminId, fileId, {
          caption: [
            `${icon ? premiumEmojiHtml(icon) : '💳'} <b>إيصال ${escapeHtml(paymentMethod.nameAr)}</b>`,
            `الطلب: <code>#${order.id}</code>`,
            `الزبون: ${escapeHtml(user.firstName || '')} — <code>${user.id}</code>`,
            `المنتج: ${escapeHtml(productDisplayName(product, 'ar'))}`,
            `الكمية: ${order.quantity}`,
            `المبلغ المطلوب: ${formatPaymentCurrencyAmount(localAmount.amount, localAmount.currency, 'ar')}`,
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

  if (state.action === 'admin_add_admin_id') {
    const raw = String(msg.text || '').trim();
    const id = adminAccess.normalizeTelegramId(raw);
    if (id === null) {
      await bot.sendMessage(user.id, '❌ الـTelegram ID غير صحيح. أرسل أرقام فقط، مثال: <code>123456789</code>.', { parse_mode: 'HTML', reply_markup: cancelInlineKeyboard() });
      return true;
    }
    try {
      const row = await grantAdminByTelegramId(user, id);
      await clearState(user.id);
      await bot.sendMessage(user.id, [
        '✅ <b>تمت إضافة الأدمن بصلاحيات كاملة</b>',
        `Telegram ID: <code>${row.telegramId}</code>`,
        '',
        'يقدر الآن يفتح /admin ويتحكم بهذا البوت. إذا ما سبق وفتح البوت، يكفي يرسل /start ثم /admin.'
      ].join('\n'), { parse_mode: 'HTML' });
      await bot.sendMessage(Number(row.telegramId), '👑 تمت إضافتك كأدمن بصلاحيات كاملة في هذا البوت. أرسل /admin لفتح لوحة الإدارة.').catch(() => {});
      await showAdminAccessManager(user.id);
    } catch (error) {
      await bot.sendMessage(user.id, error.message === 'INVALID_TELEGRAM_ID' ? '❌ Telegram ID غير صحيح.' : `❌ تعذر إضافة الأدمن: ${escapeHtml(error.message)}`, { parse_mode: 'HTML' });
    }
    return true;
  }

  if (state.action === 'admin_debt_manual_proof') {
    const photoFileId = msg.photo?.length ? msg.photo[msg.photo.length - 1].file_id : '';
    const documentIsImage = Boolean(msg.document?.file_id && /^image\/(?:jpeg|png|webp)$/i.test(String(msg.document.mime_type || '')));
    const fileId = photoFileId || (documentIsImage ? msg.document.file_id : '');
    if (!fileId) {
      await bot.sendMessage(user.id, '❌ أرسل صورة إثبات بصيغة JPG أو PNG أو WEBP، أو اكتب إغلاق للإلغاء.', { reply_markup: cancelInlineKeyboard() });
      return true;
    }
    try {
      const link = await bot.getFileLink(fileId);
      const response = await axios.get(link, { responseType: 'arraybuffer', timeout: 30000, maxContentLength: 1200000 });
      const image = Buffer.from(response.data || []);
      if (image.length < 32 || image.length > 1200000) throw new Error('PROOF_IMAGE_TOO_LARGE');
      const mime = documentIsImage ? String(msg.document.mime_type).toLowerCase() : 'image/jpeg';
      await network.submitDebtManualProof(state.debtPaymentId, { mime, base64: image.toString('base64') });
      await clearState(user.id);
      invalidateCommerceStatus();
      await bot.sendMessage(user.id, [
        '✅ <b>تم إرسال إثبات الدفع</b>',
        `إلى: <b>${escapeHtml(state.creditorName || state.creditorShopId || '')}</b>`,
        `المبلغ: <b>$${Number(state.amountUsd || 0).toFixed(2)}</b>`,
        '',
        'بانتظار أن يؤكد الطرف الدائن وصول المبلغ. إذا رفض الإثبات، يرجع الدين تلقائياً إلى الحساب.'
      ].join('\n'), { parse_mode: 'HTML' });
    } catch (error) {
      const message = error.message === 'PROOF_IMAGE_TOO_LARGE'
        ? '❌ الصورة أكبر من الحد المسموح. أرسل لقطة شاشة مضغوطة أصغر من 1.2MB.'
        : `❌ تعذر إرسال الإثبات: ${escapeHtml(error.message)}`;
      await bot.sendMessage(user.id, message, { parse_mode: 'HTML', reply_markup: cancelInlineKeyboard() });
    }
    return true;
  }

  if (state.action === 'admin_debt_binance_order') {
    const submittedOrderId = String(msg.text || '').trim();
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(submittedOrderId)) {
      await bot.sendMessage(user.id, '❌ Order ID غير صحيح. أرسل المعرف كما يظهر داخل Binance.');
      return true;
    }
    try {
      const result = await network.submitDebtBinanceOrder(state.debtPaymentId, submittedOrderId);
      await clearState(user.id);
      await bot.sendMessage(user.id, [
        '🔄 <b>تم استلام Order ID</b>',
        '',
        `المبلغ: <b>$${Number(state.amountUsd || result?.request?.amountUsd || 0).toFixed(2)}</b>`,
        `إلى: <b>${escapeHtml(state.creditorName || state.creditorShopId || '')}</b>`,
        '',
        'النظام راح يتحقق تلقائياً من حساب Binance الخاص بالطرف المستلم.',
        'إذا نجحت العملية ينغلق الدين تلقائياً وينفتح البيع إذا كان متوقف.'
      ].join('\n'), { parse_mode: 'HTML' });
      return true;
    } catch (error) {
      const text = error.message === 'DUPLICATE_TRANSACTION'
        ? '❌ Order ID مستخدم سابقاً بتسوية ثانية.'
        : error.message === 'INVALID_ORDER_ID'
          ? '❌ Order ID غير صحيح.'
          : `❌ تعذر حفظ Order ID: ${error.message}`;
      await bot.sendMessage(user.id, text);
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
      await bot.sendMessage(user.id, '2/3 أرسل Telegram ID الرقمي لصاحب البوت.');
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
        '3/3 أرسل <b>BOT TOKEN</b> مالالبوت الجديد من BotFather.',
        '',
        '🔐 راح أحذف رسالتك مباشرة بعد قراءتها، وأفحصه مع Telegram، وما أخزن التوكن بقاعدة البيانات.',
        'بعدها أعطيك إعدادات Railway كاملة مباشرة بدون أي سؤال إضافي.'
      ].join('\n'), { parse_mode: 'HTML' });
      return true;
    }
    if (state.step === 'bot_token') {
      // Delete every token attempt immediately, even when the format is wrong.
      await bot.deleteMessage(user.id, msg.message_id).catch(() => {});
      if (!/^\d{6,15}:[A-Za-z0-9_-]{20,}$/.test(text)) {
        await bot.sendMessage(user.id, '❌ صيغة BOT TOKEN مو صحيحة. انسخ التوكن كامل من BotFather.');
        return true;
      }
      const verification = await verifyPartnerBotToken(text);
      if (!verification.ok) {
        await bot.sendMessage(user.id, `❌ ${verification.reason}\nأرسل التوكن الصحيح أو اكتب إغلاق للإلغاء.`, {
          reply_markup: cancelInlineKeyboard()
        });
        return true;
      }
      try {
        await bot.sendMessage(user.id, verification.username
          ? `✅ تم التحقق من @${escapeHtml(verification.username)}. جاري تجهيز متغيرات Railway...`
          : '✅ تم التحقق من البوت. جاري تجهيز متغيرات Railway...', { parse_mode: 'HTML' });
        await completePartnerBotSetup(user, data, text);
      } catch (error) {
        if (error.code === 'MASTER_PUBLIC_URL_REQUIRED') {
          await bot.sendMessage(user.id, [
            '❌ ما قدرت أُنشئ إعدادات مكتملة لأن رابط البوت الرئيسي غير موجود.',
            'أنشئ Domain للبوت الرئيسي في Railway أو ضع NETWORK_PUBLIC_URL فيه، ثم أرسل توكن البوت الجديد مرة ثانية.'
          ].join('\n'), { reply_markup: cancelInlineKeyboard() });
        } else {
          console.error('Partner bot setup:', error.message);
          await bot.sendMessage(user.id, '❌ تعذر إنشاء إعدادات البوت الآن. لم يُحفظ التوكن؛ أرسله مرة ثانية للمحاولة.', {
            reply_markup: cancelInlineKeyboard()
          });
        }
      }
      return true;
    }
  }

  if (state.action === 'admin_ui_text_edit' && isAdmin(user.id)) {
    if (!canManagePremiumEmojis(user)) {
      await clearState(user.id);
      await bot.sendMessage(user.id, 'هذا الإعداد لأدمنات هذا البوت فقط.');
      return true;
    }
    const submittedText = String(msg.text || '').trim();
    if (state.step === 'query') {
      if (!submittedText || submittedText.length > 120) {
        await bot.sendMessage(user.id, 'أرسل كلمة أو جزءاً من النص أو اسم الزر، بحد أقصى 120 حرفاً.', {
          reply_markup: cancelInlineKeyboard()
        });
        return true;
      }
      await uiTextOverrides.persistCatalog().catch(error => console.error('UI text catalog flush:', error.message));
      const matches = uiTextOverrides.search(submittedText, 8);
      if (!matches.length) {
        await bot.sendMessage(user.id, [
          'لم أجد نصاً أو زراً مشابهاً ضمن الواجهات الآمنة التي ظهرت في البوت حتى الآن.',
          'افتح الشاشة المطلوبة مرة واحدة ثم ابحث بكلمة أوضح من النص، أو اكتب إغلاق للإلغاء.'
        ].join('\n'), { reply_markup: cancelInlineKeyboard() });
        return true;
      }
      const nextState = {
        action: 'admin_ui_text_edit',
        step: 'confirm',
        data: {
          query: submittedText,
          candidateIds: matches.map(row => row.id),
          candidateIndex: 0
        }
      };
      await setState(user.id, nextState);
      await showUiTextCandidate(user.id, nextState);
      return true;
    }
    if (state.step === 'confirm') {
      const answer = uiTextOverrides.normalizeText(submittedText);
      if (['نعم', 'اي', 'ايوه', 'اجل', 'yes', 'y'].includes(answer)) {
        await selectCurrentUiTextCandidate(user, state);
        return true;
      }
      if (['التالي', 'لا', 'next', 'n', 'no'].includes(answer)) {
        await nextUiTextCandidate(user, state);
        return true;
      }
      await bot.sendMessage(user.id, 'اكتب نعم إذا كانت هذه هي النتيجة، أو التالي لعرض نتيجة أخرى.', {
        reply_markup: cancelInlineKeyboard()
      });
      return true;
    }
    if (state.step === 'replacement') {
      const candidate = uiTextOverrides.findCandidate(state.data?.selectedId);
      if (!candidate) {
        await setState(user.id, { action: 'admin_ui_text_edit', step: 'query', data: {} });
        await bot.sendMessage(user.id, 'تعذر العثور على النص المحدد. أرسل كلمة للبحث من جديد.', {
          reply_markup: cancelInlineKeyboard()
        });
        return true;
      }
      const rich = extractTelegramRichText(submittedText, msg.entities || []);
      const bracketId = submittedText.match(/\[\s*(\d{5,24})\s*\]/);
      const standaloneId = submittedText.match(/^\s*(\d{5,24})\s*$/);
      const requestedEmojiId = String(rich.firstCustomEmojiId || bracketId?.[1] || standaloneId?.[1] || '');
      if (requestedEmojiId && !premiumEmojis.validEmojiId(requestedEmojiId)) {
        await bot.sendMessage(user.id, 'معرّف الإيموجي المميز غير صحيح. أرسله بين أقواس مربعة مع النص الجديد.', {
          reply_markup: cancelInlineKeyboard()
        });
        return true;
      }
      let replacementText = String(rich.plain || submittedText || '').trim();
      if (bracketId) replacementText = replacementText.replace(bracketId[0], ' ').replace(/\s+/g, ' ').trim();
      if (standaloneId) replacementText = '';
      if (rich.firstCustomEmojiId && rich.firstCustomEmojiAlt) {
        replacementText = replacementText.replace(rich.firstCustomEmojiAlt, ' ').replace(/\s+/g, ' ').trim();
      }
      replacementText = stripOrdinaryEmojiText(replacementText, false).trim();
      if (!replacementText) {
        replacementText = String(candidate.override?.replacementText || candidate.plainText || '').trim();
      }
      const replacementLimit = candidate.kind === 'button' ? 64 : 700;
      if (!replacementText || replacementText.length > replacementLimit) {
        await bot.sendMessage(user.id, `أرسل ${candidate.kind === 'button' ? 'اسماً للزر' : 'نصاً'} لا يتجاوز ${replacementLimit} حرفاً، أو أرسل الإيموجي المميز وحده للإبقاء على النص الحالي.`, {
          reply_markup: cancelInlineKeyboard()
        });
        return true;
      }
      try {
        const saved = await uiTextOverrides.upsert({
          kind: candidate.kind,
          originalText: candidate.text,
          replacementText,
          emojiId: requestedEmojiId || candidate.override?.emojiId || '',
          emojiAlt: requestedEmojiId ? (rich.firstCustomEmojiAlt || '✨') : (candidate.override?.emojiAlt || '✨'),
          replyKeyboard: candidate.replyKeyboard === true
        });
        await clearState(user.id);
        await bot.sendMessage(user.id, [
          `${saved.emojiId ? premiumEmojiHtml({ id: saved.emojiId, alt: saved.emojiAlt }) : premiumEmojiHtml(PREMIUM_EMOJI.success)} <b>تم حفظ التعديل.</b>`,
          `النوع: <b>${uiTextKindLabel(saved.kind)}</b>`,
          `النص الجديد: <b>${escapeHtml(saved.replacementText)}</b>`,
          '',
          'سيُطبق على المطابقة الكاملة لهذا النص أو الزر، من دون تغيير المنتجات أو المخزون أو الطلبات.'
        ].join('\n'), { parse_mode: 'HTML' });
        await showUiTextOverridesAdmin(user.id, user, 0);
      } catch (error) {
        const reason = error.code === 'UI_TEXT_OVERRIDE_LIMIT'
          ? 'وصلت للحد الأعلى من تعديلات النصوص. احذف تعديلاً قديماً ثم حاول مرة أخرى.'
          : 'تعذر حفظ تعديل النص. حاول مرة ثانية.';
        await bot.sendMessage(user.id, reason, { reply_markup: cancelInlineKeyboard() });
      }
      return true;
    }
  }

  if (state.action === 'admin_premium_emoji_add' && isAdmin(user.id)) {
    if (!canManagePremiumEmojis(user)) {
      await clearState(user.id);
      await bot.sendMessage(user.id, '⛔ هذا الإعداد لأدمنات هذا البوت فقط.');
      return true;
    }
    const text = String(msg.text || '').trim();
    if (state.step === 'keyword_ar') {
      if (!text || text.length > 80 || !looksArabic(text)) {
        await bot.sendMessage(user.id, '❌ أرسل الاسم أو المعنى <b>بالعربية فقط</b> وبحد أقصى 80 حرفاً. مثال: كانفا', {
          parse_mode: 'HTML',
          reply_markup: cancelInlineKeyboard()
        });
        return true;
      }
      const known = premiumEmojis.resolve(text);
      let keywordEn = '';
      try { keywordEn = String(await translateArToEn(text) || '').trim(); } catch {}
      if (!keywordEn || looksArabic(keywordEn)) keywordEn = String(known?.keywordEn || '').trim();
      if (!keywordEn || looksArabic(keywordEn)) {
        await bot.sendMessage(user.id, '⚠️ تعذرت الترجمة الإنجليزية التلقائية الآن، لذلك لم أحفظ ربطاً ناقصاً. أرسل الاسم العربي مرة ثانية بعد قليل.', {
          reply_markup: cancelInlineKeyboard()
        });
        return true;
      }
      keywordEn = keywordEn.slice(0, 80);
      await setState(user.id, {
        action: 'admin_premium_emoji_add',
        step: 'emoji',
        data: { keywordAr: text, keywordEn }
      });
      await bot.sendMessage(user.id, [
        '✅ تمت مزامنة الاسمين تلقائياً:',
        `العربي: <b>${escapeHtml(text)}</b>`,
        `English: <b>${escapeHtml(keywordEn)}</b>`,
        '',
        'الآن أرسل الإيموجي المميز نفسه من تيليجرام، أو أرسل المعرّف بهذه الصيغة: <code>[5796637619601283518]</code>.'
      ].join('\n'), { parse_mode: 'HTML', reply_markup: cancelInlineKeyboard() });
      return true;
    }
    if (state.step === 'emoji') {
      const selected = customEmojiFromMessage(msg);
      if (!selected.emojiId) {
        await bot.sendMessage(user.id, '❌ ما قدرت أقرأ Custom Emoji ID. أرسل الإيموجي المميز نفسه أو المعرّف الرقمي بين أقواس مربعة.', {
          reply_markup: cancelInlineKeyboard()
        });
        return true;
      }
      try {
        const saved = await premiumEmojis.upsertCustom({
          keywordAr: state.data?.keywordAr,
          keywordEn: state.data?.keywordEn,
          emojiId: selected.emojiId,
          alt: selected.alt
        });
        const repairedProducts = await repairKnownProductEmojiMappings();
        await clearState(user.id);
        await bot.sendMessage(user.id, [
          `${premiumEmojiHtml({ id: saved.emojiId, alt: saved.alt })} <b>تم حفظ الربط وتفعيله على جميع البوتات.</b>`,
          `العربي: <b>${escapeHtml(saved.keywordAr)}</b>`,
          `English: <b>${escapeHtml(saved.keywordEn)}</b>`,
          ...(saved.autoCorrected ? ['تم تصحيح المعرّف تلقائياً لأنه كان تابعاً لخدمة معروفة أخرى.'] : []),
          ...(repairedProducts ? [`تم تصحيح الإيموجي في <b>${repairedProducts}</b> منتج موجود.`] : []),
          '',
          'أي منتج أو خدمة أو زر يحتوي هذا الاسم سيأخذ الإيموجي تلقائياً، وتتلقى بقية البوتات الربط خلال 30 ثانية.'
        ].join('\n'), { parse_mode: 'HTML' });
        await showPremiumEmojiAdmin(user.id, user);
      } catch (error) {
        const reason = error.code === 'PREMIUM_EMOJI_LIMIT'
          ? 'وصلت للحد الأعلى للروابط المخصصة.'
          : 'تعذر حفظ الربط. تحقق من الاسم ومعرّف الإيموجي.';
        await bot.sendMessage(user.id, `❌ ${reason}`, { reply_markup: cancelInlineKeyboard() });
      }
      return true;
    }
  }

  if (state.action === 'admin_virtual_provider_api_key' && isAdmin(user.id)) {
    if (!canManageVirtualProviders(user)) {
      await clearState(user.id);
      await bot.sendMessage(user.id, '⛔ هذا الإعداد لأدمنات هذا البوت فقط.');
      return true;
    }
    const requestedProviderId = String(state.providerId || '').trim().toLowerCase();
    if (!VIRTUAL_PROVIDER_IDS.has(requestedProviderId)) {
      await clearState(user.id);
      return true;
    }
    const detectedProviderId = virtualNumbers.detectProviderFromApiInput(msg.text || '');
    const providerId = detectedProviderId || requestedProviderId;
    const apiKey = virtualNumbers.normalizeProviderApiKeyInput(msg.text || '');
    if (!virtualNumbers.validProviderApiKeyInput(apiKey)) {
      await bot.sendMessage(user.id, '❌ صيغة المفتاح غير صحيحة. أرسل قيمة API Key أو رابط الـAPI الكامل؛ البوت يزيل المسافات الخفية تلقائياً. اكتب إغلاق للإلغاء.');
      return true;
    }
    // The Telegram message containing the secret should disappear immediately.
    await bot.deleteMessage(user.id, msg.message_id).catch(() => {});
    try {
      const providerName = virtualProviderName(providerId);
      const result = await virtualNumbers.setProviderApiKey(providerId, apiKey);
      await clearState(user.id);
      const detectedNote = detectedProviderId && detectedProviderId !== requestedProviderId
        ? `\nتم التعرف تلقائياً أن المفتاح يخص ${providerName} وحُفظ في مكانه الصحيح.`
        : '';
      await bot.sendMessage(user.id, `✅ تم فحص API ${providerName} وحفظه بشكل مشفر. الرصيد الحالي: $${Number(result.balance || 0).toFixed(4)}${detectedNote}`);
      await showVirtualProviderAdmin(user.id, user);
    } catch (error) {
      const providerName = virtualProviderName(providerId);
      const badKeyHint = String(error.code || '') === 'BAD_KEY'
        ? `\n\nالموقع <b>${providerName}</b> نفسه رفض المفتاح بعد تنظيفه. تأكد أن المفتاح صادر من حساب ${providerName} وأنك اخترت الموقع الصحيح. يقبل البوت المفتاح وحده أو رابط الـAPI الكامل.`
        : '';
      await bot.sendMessage(user.id, `❌ لم يتم حفظ المفتاح: ${virtualNumberErrorText(error, 'ar')}${badKeyHint}\n\nأرسل المفتاح مرة ثانية أو اكتب إغلاق للإلغاء.`, {
        parse_mode: 'HTML',
        reply_markup: cancelInlineKeyboard()
      });
    }
    return true;
  }

  if (state.action === 'admin_virtual_provider_profit' && isAdmin(user.id)) {
    if (!canManageVirtualProviders(user)) {
      await clearState(user.id);
      await bot.sendMessage(user.id, '⛔ هذا الإعداد لأدمنات هذا البوت فقط.');
      return true;
    }
    const providerId = String(state.providerId || '').trim().toLowerCase();
    const value = Number(String(msg.text || '').trim());
    if (!VIRTUAL_PROVIDER_IDS.has(providerId) || !Number.isFinite(value) || value < 0 || value > 100) {
      await bot.sendMessage(user.id, '❌ أرسل قيمة الربح بالدولار، مثال: 0.15 أو 0.20.');
      return true;
    }
    try {
      const profit = await virtualNumbers.setProviderProfit(providerId, value);
      await clearState(user.id);
      await bot.sendMessage(user.id, `✅ تم ضبط ربح كل رقم على <b>${virtualRetailPriceText(profit)}</b>.`, { parse_mode: 'HTML' });
      await showVirtualProviderAdmin(user.id, user);
    } catch (error) {
      await bot.sendMessage(user.id, `❌ ${virtualNumberErrorText(error, 'ar')}`);
    }
    return true;
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
      `المنتج: <b>${escapeHtml(productDisplayName(product, 'ar'))}</b>`,
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
      await bot.sendMessage(user.id, '2/5 أرسل رقم/معرّف الدفع الذي راح يظهر للزبون.\nمثال: 010xxxxxxx أو Wallet-ID-123', { reply_markup: cancelInlineKeyboard() });
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
      await bot.sendMessage(user.id, '3/5 اختَر عملة الاستلام لهذه الطريقة. الزبون راح يكتب مبلغ الشحن بهذه العملة نفسها:', {
        reply_markup: { inline_keyboard: currencyButtons.map(button => [button]) }
      });
      return true;
    }

    if (state.step === 'rate') {
      const rate = Number(text.replace(/,/g, ''));
      if (!Number.isFinite(rate) || rate <= 0) {
        await bot.sendMessage(user.id, '❌ سعر الصرف غير صحيح. مثال للعراقي: 1500، وللمصري: 50.');
        return true;
      }
      data.ratePerUsd = rate;
      await setState(user.id, { action: 'admin_new_payment_method', step: 'minimum', data });
      const currency = normalizePaymentCurrency(data.settlementCurrency);
      const example = currency === 'IQD' ? '1000' : currency === 'EGP' ? '10' : '0.50';
      await bot.sendMessage(user.id, `5/5 كم الحد الأدنى للتحويل بهذه الطريقة؟\nأرسل الرقم بعملة ${paymentCurrencyLabel(currency, 'ar')} فقط. مثال: ${example}`, { reply_markup: cancelInlineKeyboard() });
      return true;
    }

    if (state.step === 'minimum') {
      const minimum = Number(text.replace(/,/g, ''));
      if (!Number.isFinite(minimum) || minimum <= 0) {
        await bot.sendMessage(user.id, '❌ الحد الأدنى غير صحيح. أرسل رقم أكبر من صفر.');
        return true;
      }
      data.minimumTransferAmount = minimum;
      const method = await createConfiguredPaymentMethod(data);
      await clearState(user.id);
      const icon = customPaymentEmoji(method);
      await bot.sendMessage(user.id, [
        '✅ <b>تمت إضافة طريقة الدفع</b>',
        `${icon ? premiumEmojiHtml(icon) : '💳'} الاسم: <b>${escapeHtml(method.nameAr)}</b>`,
        `الرقم: <code>${escapeHtml(method.paymentNumber)}</code>`,
        `العملة: <b>${method.settlementCurrency}</b>`,
        `سعر 1$: <b>${Number(method.ratePerUsd)}</b> ${method.settlementCurrency}`,
        `الحد الأدنى: <b>${formatPaymentCurrencyAmount(method.minimumTransferAmount, method.settlementCurrency, 'ar')}</b>`,
        '',
        'هذه طريقة دفع مشتركة: تظهر تلقائياً بباقي البوتات حسب قسم عملتها، بينما Binance/SuperQi الأساسيين يبقون خاصين بكل بوت.'
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
    } else if (state.field === 'minimum') {
      const minimum = Number(text.replace(/,/g, ''));
      if (!Number.isFinite(minimum) || minimum <= 0) {
        await bot.sendMessage(user.id, '❌ الحد الأدنى غير صحيح.');
        return true;
      }
      method.minimumTransferAmount = minimum;
    }
    await method.save();
    invalidatePaymentMethodsCache();
    try { await syncPaymentMethodToNetwork(method); } catch (error) { console.error('Payment method edit sync:', error.message); }
    await clearState(user.id);
    await bot.sendMessage(user.id, '✅ تم تحديث طريقة الدفع.', {
      reply_markup: { inline_keyboard: [[{ text: 'رجوع لطريقة الدفع', callback_data: `adm:pm:${method.id}` }]] }
    });
    return true;
  }

  if (state.action === 'admin_publish_network_product') {
    const value = Number(String(msg.text || '').trim().replace(/,/g, ''));
    if (!Number.isFinite(value) || value < 0 || value > 1000000) {
      await bot.sendMessage(user.id, '❌ السعر غير صحيح. أرسل رقماً بالدولار مثل 5 أو 1.50.');
      return true;
    }

    let product = null;
    let basePrice = 0;
    let alreadyDecided = false;
    try {
      await sequelize.transaction(async transaction => {
        product = await Merchant.findByPk(state.productId, {
          transaction,
          lock: transaction.LOCK.UPDATE
        });
        if (!product || !product.isActive || !isForeignPublicProduct(product)) throw new Error('NETWORK_PRODUCT_NOT_AVAILABLE');
        if (String(product.localPublicationStatus || '').toLowerCase() !== 'pending') {
          alreadyDecided = true;
          return;
        }
        basePrice = networkProductBasePrice(product);
        if (value + 1e-9 < basePrice) throw new Error(`PRICE_BELOW_BASE:${basePrice}`);
        await product.update({
          localPriceOverrideUsd: value > basePrice + 1e-9 ? value : null,
          localPublicationStatus: 'published',
          localReviewNotifiedAt: new Date()
        }, { transaction });
      });
    } catch (error) {
      if (error.message === 'NETWORK_PRODUCT_NOT_AVAILABLE') {
        await clearState(user.id);
        await bot.sendMessage(user.id, '❌ المنتج العام غير موجود أو لم يعد متاحاً.');
        return true;
      }
      if (String(error.message || '').startsWith('PRICE_BELOW_BASE:')) {
        const floor = Number(String(error.message).split(':')[1] || 0);
        await bot.sendMessage(user.id, `❌ أقل سعر مسموح هو ${moneyUsd(floor)} لأنه حق صاحب المنتج.`);
        return true;
      }
      throw error;
    }

    if (alreadyDecided) {
      await clearState(user.id);
      await bot.sendMessage(user.id, 'ℹ️ اتخذ أدمن آخر قراراً بهذا المنتج داخل البوت قبل إكمال التسعير.');
      return true;
    }

    product = await Merchant.findByPk(state.productId);
    await clearState(user.id);
    const profit = Math.max(0, value - basePrice);
    await bot.sendMessage(user.id, [
      '✅ <b>تم تسعير المنتج ونشره فعلياً داخل هذا البوت</b>',
      `سعر صاحب المنتج: <b>${moneyUsd(basePrice)}</b>`,
      `سعر البيع في بوتك: <b>${moneyUsd(value)}</b>`,
      `ربح فرق السعر لك: <b>${moneyUsd(profit)}</b> لكل وحدة.`,
      '',
      'صار المنتج بحالة «منشور» في قاعدة بيانات هذا البوت، ويظهر للزبائن حسب توفر المخزون. قرار بقية البوتات مستقل.'
    ].join('\n'), { parse_mode: 'HTML' });
    await broadcastNewProductNotification(product, product.createdByDisplayName || '').catch(error => {
      console.error('Publish reviewed product notification:', error.message);
    });
    await showAdminProductEditor(user.id, product.id);
    return true;
  }

  if (state.action === 'admin_new_product') {
    const data = state.data || {};
    const text = String(msg.text || '').trim();
    const photoFileId = msg.photo?.length ? msg.photo[msg.photo.length - 1].file_id : '';

    if (state.step === 'scope') {
      await bot.sendMessage(user.id, 'اختَر من الأزرار: منتج محلي لهذا البوت فقط، أو منتج عام يُرسل لبقية الإدارات للموافقة.', {
        reply_markup: { inline_keyboard: [
          [{ text: '🔒 محلي — داخل هذا البوت فقط', callback_data: 'adm:newscope:local', style: 'primary' }],
          [{ text: '🌐 عام — لكل البوتات بعد الموافقة', callback_data: 'adm:newscope:public', style: 'success' }],
          [{ text: '❌ إغلاق', callback_data: 'flow:cancel', style: 'danger' }]
        ] }
      });
      return true;
    }

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
      data.imageValue = imageValue;

      if ((data.type || 'free') === 'service') {
        await setState(user.id, { action: 'admin_new_product', step: 'serviceInputMode', data });
        await bot.sendMessage(user.id, '6/7 اختَر نوع البيانات اللي تريدها من الزبون بعد الدفع:', {
          reply_markup: { inline_keyboard: [
            [{ text: '📧 إيميل', callback_data: 'adm:svcinputmode:email', style: 'primary' }],
            [{ text: '📱 رقم', callback_data: 'adm:svcinputmode:phone', style: 'primary' }],
            [{ text: '📝 نص', callback_data: 'adm:svcinputmode:text', style: 'primary' }],
            [{ text: '❌ إغلاق', callback_data: 'flow:cancel', style: 'danger' }]
          ] }
        });
        return true;
      }

      return finalizeNewProduct(user, data);
    }

    if (state.step === 'serviceInputMode') {
      await bot.sendMessage(user.id, 'اختَر نوع البيانات من الأزرار: إيميل، رقم، أو نص.', {
        reply_markup: { inline_keyboard: [
          [{ text: '📧 إيميل', callback_data: 'adm:svcinputmode:email', style: 'primary' }],
          [{ text: '📱 رقم', callback_data: 'adm:svcinputmode:phone', style: 'primary' }],
          [{ text: '📝 نص', callback_data: 'adm:svcinputmode:text', style: 'primary' }],
          [{ text: '❌ إغلاق', callback_data: 'flow:cancel', style: 'danger' }]
        ] }
      });
      return true;
    }

    if (state.step === 'servicePromptAr') {
      if (!text) {
        await bot.sendMessage(user.id, 'اكتب الرسالة اللي تريد تظهر للزبون.');
        return true;
      }
      data.servicePromptAr = text;
      data.servicePromptEn = await translateArToEn(text);
      return finalizeNewProduct(user, data);
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
    if (['image', 'localImage'].includes(field) && msg.photo?.length) value = msg.photo[msg.photo.length - 1].file_id;
    if (!value) return true;

    if (!canEditProductField(product, field)) {
      await clearState(user.id);
      await bot.sendMessage(user.id, '⛔ لا يمكنك تعديل البيانات العامة لهذا المنتج. استخدم أزرار الاسم والسعر الخاصين بهذا البوت.');
      return true;
    }

    const description = parseDescription(product.description);
    const localContent = parseLocalContentOverride(product.localContentOverride);
    if (field === 'localNameAr' || (field === 'nameAr' && isForeignPublicProduct(product))) {
      if (value === '-') {
        product.localNameArOverride = null;
        product.localNameEnOverride = null;
        product.localNameEmojiId = null;
        product.localNameEmojiAlt = null;
      } else {
        const rich = extractProductNameRichText(value, msg.entities);
        if (!rich.plain) {
          await bot.sendMessage(user.id, '❌ اكتب اسم المنتج أيضاً، مو فقط ID الإيموجي.');
          return true;
        }
        const translatableName = rich.firstCustomEmojiAlt ? rich.plain.replace(rich.firstCustomEmojiAlt, '').trim() : rich.plain;
        product.localNameArOverride = rich.plain;
        product.localNameEnOverride = await translateArToEn(translatableName || rich.plain);
        product.localNameEmojiId = rich.firstCustomEmojiId || null;
        product.localNameEmojiAlt = rich.firstCustomEmojiAlt || null;
      }
      await product.save({ fields: ['localNameArOverride', 'localNameEnOverride', 'localNameEmojiId', 'localNameEmojiAlt'] });
      await clearState(user.id);
      await bot.sendMessage(user.id, value === '-' ? '✅ رجع اسم المنتج العام داخل هذا البوت.' : '✅ تم حفظ الاسم داخل هذا البوت فقط، وبقية البوتات لم تتغير.');
      await showAdminProductEditor(user.id, product.id);
      return true;
    } else if (field === 'nameAr') {
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
    } else if (field === 'localPrice' || (field === 'price' && isForeignPublicProduct(product))) {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0 || number > 1000000) {
        await bot.sendMessage(user.id, '❌ سعر غير صحيح.');
        return true;
      }

      const basePrice = networkProductBasePrice(product);
      if (number + 1e-9 < basePrice) {
        await bot.sendMessage(user.id, `❌ أقل سعر مسموح هو ${moneyUsd(basePrice)} لأنه سعر المنتج العام. تگدر تخليه نفسه أو ترفعه فقط.`);
        return true;
      }
      product.localPriceOverrideUsd = number > basePrice + 1e-9 ? number : null;
      await product.save({ fields: ['localPriceOverrideUsd'] });
      await clearState(user.id);
      const effectivePrice = effectiveProductPrice(product);
      const profit = Math.max(0, effectivePrice - basePrice);
      await bot.sendMessage(user.id, product.localPriceOverrideUsd
        ? `✅ تم حفظ السعر داخل هذا البوت فقط.
السعر الأساسي: ${moneyUsd(basePrice)}
سعر هذا البوت: ${moneyUsd(effectivePrice)}
فرق السعر: ${moneyUsd(profit)} لكل وحدة.`
        : `✅ رجّعت سعر هذا البوت إلى السعر الأساسي ${moneyUsd(basePrice)}.`);
      await showAdminProductEditor(user.id, product.id);
      return true;
    } else if (field === 'localDescriptionAr') {
      if (value === '-') {
        delete localContent.ar;
        delete localContent.en;
        delete localContent.descriptionArHtml;
      } else {
        const rich = extractTelegramRichText(value, msg.entities);
        localContent.ar = rich.plain;
        localContent.en = await translateArToEn(rich.plain);
        localContent.descriptionArHtml = rich.html;
      }
      product.localContentOverride = { ...localContent };
      product.changed('localContentOverride', true);
      await product.save({ fields: ['localContentOverride'] });
      await clearState(user.id);
      await bot.sendMessage(user.id, value === '-'
        ? '✅ رجع وصف هذا البوت إلى الوصف العام.'
        : '✅ تم حفظ الوصف داخل هذا البوت فقط. بقية البوتات لم تتغير.');
      await showAdminProductEditor(user.id, product.id);
      return true;
    } else if (field === 'localWarrantyAr') {
      if (value === '-') {
        delete localContent.warrantyAr;
        delete localContent.warrantyEn;
        delete localContent.warrantyArHtml;
      } else {
        const rich = extractTelegramRichText(value, msg.entities);
        localContent.warrantyAr = rich.plain;
        localContent.warrantyEn = await translateArToEn(rich.plain);
        localContent.warrantyArHtml = rich.html;
      }
      product.localContentOverride = { ...localContent };
      product.changed('localContentOverride', true);
      await product.save({ fields: ['localContentOverride'] });
      await clearState(user.id);
      await bot.sendMessage(user.id, value === '-'
        ? '✅ رجع ضمان هذا البوت إلى الضمان العام.'
        : '✅ تم حفظ الضمان داخل هذا البوت فقط. بقية البوتات لم تتغير.');
      await showAdminProductEditor(user.id, product.id);
      return true;
    } else if (field === 'localImage') {
      if (value === '-') delete localContent.image;
      else if (['حذف', 'بدون', 'remove', 'none'].includes(String(value).trim().toLowerCase())) localContent.image = null;
      else localContent.image = value;
      product.localContentOverride = { ...localContent };
      product.changed('localContentOverride', true);
      await product.save({ fields: ['localContentOverride'] });
      await clearState(user.id);
      await bot.sendMessage(user.id, value === '-'
        ? '✅ رجعت صورة هذا البوت إلى الصورة العامة.'
        : (localContent.image ? '✅ تم حفظ الصورة داخل هذا البوت فقط.' : '✅ تم إخفاء الصورة داخل هذا البوت فقط.'));
      await showAdminProductEditor(user.id, product.id);
      return true;
    } else if (field === 'price') {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0 || number > 1000000) {
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
      if (isPublicProduct(product)) {
        product.networkBasePriceUsd = number;
        if (!(Number(product.localPriceOverrideUsd) > number + 1e-9)) product.localPriceOverrideUsd = null;
      }
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
        product.networkBasePriceUsd = Number(product.price);
        if (!(Number(product.localPriceOverrideUsd) > Number(product.price) + 1e-9)) product.localPriceOverrideUsd = null;
      } catch (error) {
        await network.syncCatalogToLocal({ force: true }).catch(() => {});
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

    if (String(product.type || '') === 'service') {
      await clearState(user.id);
      await bot.sendMessage(user.id, '🛠 تنفيذ خدمة ما يحتاج مخزون، لذلك تم إغلاق إضافة المخزون لهذا المنتج.');
      return true;
    }

    // Free-form inventory is ALWAYS one Telegram message = one inventory unit.
    // Keep this guard here (in addition to utils.js) so future parser changes or
    // partially-updated deployments can never split a multiline free product
    // into separate rows again.
    const normalizedStockText = String(text || '').replace(/\r\n/g, '\n').trim();
    const parsed = String(product.type || '').toLowerCase() === 'free'
      ? {
          items: normalizedStockText
            ? [{ email: '', password: '', twoFactor: '', code: '', extra: '', raw: normalizedStockText }]
            : [],
          errors: []
        }
      : parseInventoryTextForProduct(text, product.type);
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
        await bot.sendMessage(user.id, [
          `✅ تمت إضافة ${remote.added} للمخزون المشترك.`,
          Number(remote.repairedLegacyFragments || 0) > 0 ? `🧹 تم إصلاح ${remote.repairedLegacyFragments} أجزاء قديمة كانت محفوظة بالخطأ كأسطر منفصلة.` : '',
          `المخزون العالمي الآن: ${remote.stock}`
        ].filter(Boolean).join('\n'));
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
      const repairedLegacyFragments = product.type === 'free'
        ? await repairLegacyFreeFragmentsLocal(product, normalizedStockText, transaction)
        : 0;
      const prepared = new Map();
      let duplicates = 0;
      for (const item of parsed.items) {
        const fingerprint = inventoryFingerprint(product.type, item);
        if (prepared.has(fingerprint)) {
          duplicates += 1;
          continue;
        }
        prepared.set(fingerprint, item);
      }

      const fingerprints = [...prepared.keys()];
      const existingRows = fingerprints.length
        ? await Code.findAll({
            where: { merchantId: product.id, fingerprint: { [Op.in]: fingerprints } },
            attributes: ['fingerprint'],
            raw: true,
            transaction
          })
        : [];
      const existing = new Set(existingRows.map(row => String(row.fingerprint || '')));
      duplicates += existing.size;

      const rowsToCreate = [];
      for (const [fingerprint, item] of prepared.entries()) {
        if (existing.has(fingerprint)) continue;
        rowsToCreate.push({
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
        });
      }
      if (rowsToCreate.length) await Code.bulkCreate(rowsToCreate, { transaction });
      const added = rowsToCreate.length;

      await transaction.commit();

      if (added > 0) await clearState(user.id);
      const privateDetails = product.type === 'shared'
        ? `\n🔒 عدد الاستخدامات لكل حساب: ${maxUses} — يظهر للإدارة فقط.`
        : '';
      await bot.sendMessage(user.id, [
        `✅ تمت إضافة: ${added}`,
        `♻️ المكرر الذي تم تجاهله: ${duplicates}`,
        repairedLegacyFragments > 0 ? `🧹 تم إصلاح ${repairedLegacyFragments} أجزاء قديمة كانت محفوظة بالخطأ كأسطر منفصلة.` : '',
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
    const creditedUser = await User.findByPk(state.targetId);
    const creditedContext = await customerMoneyContext(creditedUser || { paymentCurrency: 'USD' });
    await bot.sendMessage(state.targetId, `✅ تم شحن محفظتك من الإدارة بمبلغ <b>${customerMoney(amount, creditedContext, creditedUser?.lang || 'ar')}</b>.\nرصيدك الجديد: <b>${customerMoney(result.balance, creditedContext, creditedUser?.lang || 'ar')}</b>`, { parse_mode: 'HTML' }).catch(() => {});
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

async function adminZeroUserBalance(targetId, admin) {
  const transaction = await sequelize.transaction();
  try {
    const target = await User.findByPk(targetId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!target) throw new Error('USER_NOT_FOUND');
    const parsedBalance = Number(target.balance || 0);
    const previousBalance = Number.isFinite(parsedBalance) ? parsedBalance : 0;
    target.balance = 0;
    await target.save({ transaction, fields: ['balance'] });
    await BalanceTransaction.create({
      userId: target.id,
      amount: -previousBalance,
      type: 'admin_balance_reset',
      txid: `ADMIN-ZERO-${admin?.id || admin}-${Date.now()}`,
      caption: `Wallet reset from ${previousBalance.toFixed(8)} USD by admin ${admin?.id || admin}`,
      status: 'completed',
      lastReminderAt: new Date(),
      approvedByTelegramId: admin?.id || admin || null,
      approvedByUsername: admin?.username || null,
      approvedByDisplayName: admin?.firstName || admin?.username || String(admin?.id || admin || ''),
      approvalSource: 'admin_balance_reset'
    }, { transaction });
    await transaction.commit();
    return { previousBalance, balance: 0 };
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
    const moneyContext = await customerMoneyContext(targetUser);
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
    const moneyContext = await customerMoneyContext(targetUser);
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
  const moneyContext = await customerMoneyContext(targetUser || { paymentCurrency: 'USD' });
  const targetLang = targetUser?.lang === 'en' ? 'en' : 'ar';
  await bot.sendMessage(targetUser.id, `✅ ${targetLang === 'en' ? 'Wallet credited' : 'تم شحن محفظتك'}: <b>${customerMoney(ledger.amount, moneyContext, targetLang)}</b>\n${targetLang === 'en' ? 'New balance' : 'الرصيد الجديد'}: <b>${customerMoney(targetUser.balance, moneyContext, targetLang)}</b>`, { parse_mode: 'HTML' }).catch(() => {});
}

async function handleSharedPaymentOwnerAdmin(query, data) {
  if (!isAdmin(query.from.id)) return answerCallback(query.id, 'Admins only', true);
  const parts = data.split(':');
  const action = parts[1];
  const requestId = parts.slice(2).join(':');
  if (!requestId) return answerCallback(query.id, 'طلب الدفع غير صحيح.', true);
  try {
    const actor = {
      telegramId: query.from?.id ? String(query.from.id) : null,
      username: query.from?.username ? String(query.from.username) : null,
      displayName: [query.from?.first_name, query.from?.last_name].filter(Boolean).join(' ') || query.from?.username || String(query.from?.id || '')
    };
    const result = await network.resolveSharedPaymentRequest(requestId, action === 'approve', actor);
    await answerCallback(query.id, action === 'approve' ? 'تم تأكيد وصول المبلغ.' : 'تم رفض العملية.');
    if (query.message) {
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id
      }).catch(() => {});
    }
    return result;
  } catch (error) {
    return answerCallback(query.id, `تعذر معالجة العملية: ${error.message}`, true);
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
    text: `#${order.id} | ${productDisplayName(order.Merchant, user.lang)} | ${order.status}`,
    callback_data: `order:${order.id}`
  }]);
  return bot.sendMessage(chatId, `${premiumEmojiHtml(PREMIUM_EMOJI.orders)} <b>${escapeHtml(t(user.lang, 'orders'))}</b>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
}

async function showOrder(chatId, user, orderId, callbackId = null) {
  if (callbackId) await answerCallback(callbackId);
  const order = await PurchaseOrder.findByPk(orderId, { include: [Merchant] });
  if (!order || (String(order.userId) !== String(user.id) && !isAdmin(user.id))) return;

  const displayUser = String(order.userId) === String(user.id)
    ? (await User.findByPk(user.id) || user)
    : user;
  const moneyContext = await customerMoneyContext(displayUser);

  const name = productDisplayName(order.Merchant, user.lang);

  const deliveries = await DeliveryRecord.findAll({
    where: { orderId: order.id },
    order: [['createdAt', 'ASC']]
  });

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

  if (Number(order.externalAmount || 0) > 0 &&
      Number(order.externalAmount || 0) + 1e-9 < Number(order.totalAmount || 0)) {
    lines.push(`${isEn ? 'External payment' : 'الدفع الخارجي'}: ${customerMoney(order.externalAmount, moneyContext, user.lang)}`);
  }

  lines.push(`${isEn ? 'Payment' : 'طريقة الدفع'}: ${escapeHtml(order.paymentMethod)}`);
  lines.push(`${isEn ? 'Status' : 'الحالة'}: ${escapeHtml(order.status)}`);

  if (deliveries.length) {
    lines.push('', `<b>${isEn ? 'Delivery IDs' : 'معرفات المنتجات المستلمة'}:</b>`);
    for (const delivery of deliveries) {
      lines.push(`<code>${escapeHtml(delivery.id)}</code>`);
    }
  }

  await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
}

async function movePaymentMethod(methodId, direction) {
  const rows = await PaymentMethod.findAll({ order: [['sortOrder', 'ASC'], ['id', 'ASC']] });
  const index = rows.findIndex(row => Number(row.id) === Number(methodId));
  if (index < 0) throw new Error('PAYMENT_METHOD_NOT_FOUND');
  const nextIndex = direction === 'up' ? index - 1 : index + 1;
  if (nextIndex < 0 || nextIndex >= rows.length) return { moved: false, row: rows[index] };

  await sequelize.transaction(async transaction => {
    for (let i = 0; i < rows.length; i++) {
      const desired = (i + 1) * 10;
      if (Number(rows[i].sortOrder) !== desired) {
        await rows[i].update({ sortOrder: desired }, { transaction });
      }
    }
    const current = rows[index];
    const neighbor = rows[nextIndex];
    const currentOrder = Number(current.sortOrder);
    const neighborOrder = Number(neighbor.sortOrder);
    await current.update({ sortOrder: neighborOrder }, { transaction });
    await neighbor.update({ sortOrder: currentOrder }, { transaction });
  });
  invalidatePaymentMethodsCache();
  return { moved: true, row: await PaymentMethod.findByPk(methodId) };
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
    'طرق الدفع التي تضيفها هنا تقدر تعدلها أو توقفها أو تحذفها، ومن داخل كل طريقة تگدر ترفعها أو تنزلها حتى ترتب ظهور طرق الدفع المحلية للزبون. Binance/SuperQi الأساسيين يبقون خاصين بكل بوت.',
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
    `الحد الأدنى: <b>${formatPaymentCurrencyAmount(method.minimumTransferAmount || minimumTransferForMethod(method), method.settlementCurrency || 'USD', 'ar')}</b>`,
    `الحالة: <b>${method.isActive ? 'مفعلة' : 'متوقفة'}</b>`,
    `الترتيب: <b>${Number(method.sortOrder || 0)}</b>`,
    `Custom Emoji ID: <code>${escapeHtml(method.iconCustomEmojiId || 'بدون')}</code>`
  ].join('\n'), {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [
      [
        { text: '✏️ تغيير الاسم', callback_data: `adm:pmfield:${method.id}:name` },
        { text: '🔢 تغيير الرقم', callback_data: `adm:pmfield:${method.id}:number` }
      ],
      [{ text: '💰 تغيير الحد الأدنى', callback_data: `adm:pmfield:${method.id}:minimum` }],
      [
        { text: '⬆️ رفع للأعلى', callback_data: `adm:pmmove:${method.id}:up`, style: 'primary' },
        { text: '⬇️ تنزيل للأسفل', callback_data: `adm:pmmove:${method.id}:down`, style: 'primary' }
      ],
      [{ text: method.isActive ? '⛔ إيقاف الطريقة' : '✅ تشغيل الطريقة', callback_data: `adm:pmtoggle:${method.id}`, style: method.isActive ? 'danger' : 'success' }],
      [{ text: '🗑 حذف طريقة الدفع', callback_data: `adm:pmdelete:${method.id}`, style: 'danger' }],
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
    'كل الديون والتسويات هنا بالدولار فقط. إذا صار دين بالعكس بين نفس الطرفين، النظام يسوي صافي تلقائياً.'
  ];
  const keyboard = [];
  lines.push('', `💸 عمولة البيع التقليدية من مخزون الآخرين (${Number(data.sellerCommissionPercent ?? config.network.sellerCommissionPercent ?? 10).toFixed(0)}%): <b>$${Number(data.sellerCommissionEarnedUsd || 0).toFixed(2)}</b>`);
  lines.push(`📈 أرباح فرق السعر المحلي: <b>$${Number(data.sellerMarkupEarnedUsd || 0).toFixed(2)}</b>`);
  lines.push(`💰 إجمالي ربح البيع الشبكي: <b>$${Number(data.sellerNetworkProfitUsd ?? ((data.sellerCommissionEarnedUsd || 0) + (data.sellerMarkupEarnedUsd || 0))).toFixed(2)}</b>`);
  const debtStatus = data.commerceStatus || await currentCommerceStatus(true);
  if (debtStatus?.suspended) {
    lines.push(
      '',
      `⛔ <b>البيع متوقف مؤقتاً</b> لأن الالتزامات الحالية وصلت إلى <b>$${Number(debtStatus.liabilityUsd || 0).toFixed(2)}</b> (حد الإيقاف $${Number(debtStatus.thresholdUsd || 40).toFixed(2)}).`,
      'ينفتح البيع تلقائياً بعد نجاح تسوية Binance.'
    );
  }

  if (!data.accounts?.length) lines.push('', '✅ ماكو ديون مفتوحة حالياً.');
  for (const account of data.accounts || []) {
    const usd = Number(account.amountUsd || account.values?.usd || 0);
    lines.push('', account.direction === 'owe'
      ? `🔴 عليك لـ <b>${escapeHtml(account.counterpartyName)}</b>: <b>$${usd.toFixed(2)}</b>`
      : `🟢 إلك على <b>${escapeHtml(account.counterpartyName)}</b>: <b>$${usd.toFixed(2)}</b>`);

    if (account.direction === 'owe' && usd > 0) {
      let profile = null;
      try { profile = await network.getCounterpartyPaymentProfile(account.counterpartyId); } catch {}
      if (profile?.binanceReady && profile?.binancePayId) {
        lines.push(`💳 التسوية: Binance ID <code>${escapeHtml(profile.binancePayId)}</code>`);
        keyboard.push([{
          text: `💰 تسديد $${usd.toFixed(2)} عبر Binance لـ ${String(account.counterpartyName).slice(0, 22)}`,
          callback_data: `adm:debt_paid:${account.counterpartyId}`,
          style: 'success'
        }]);
      } else {
        lines.push('⚠️ الطرف المقابل ما مفعّل Binance؛ يبقى التسديد اليدوي متاحاً.');
      }
      keyboard.push([{
        text: `🧾 تسديد يدوي وإرسال صورة — $${usd.toFixed(2)}`,
        callback_data: `adm:debt_manual:${account.counterpartyId}`,
        style: 'primary'
      }]);
    }
  }

  for (const pending of data.pendingOutgoing || []) {
    const amount = Number(pending.amountUsd || 0);
    lines.push('', `🕓 تسوية معلقة إلى <b>${escapeHtml(pending.creditorName || pending.creditorShopId)}</b>: <b>$${amount.toFixed(2)}</b>`);
    if (String(pending.paymentMethod || '') === 'manual') {
      if (pending.manualProofSubmittedAt) {
        lines.push('🧾 تم إرسال صورة الإثبات وبانتظار موافقة الطرف الدائن.');
      } else {
        lines.push('🧾 تم اختيار التسديد اليدوي، لكن صورة الإثبات لم تُرسل بعد.');
        keyboard.push([{
          text: `📷 إرسال صورة الإثبات — $${amount.toFixed(2)}`,
          callback_data: `adm:debt_manual_retry:${pending.id}`,
          style: 'primary'
        }]);
      }
    } else if (pending.status === 'confirmed') {
      lines.push('✅ تم التحقق منها تلقائياً.');
    } else if (pending.submittedOrderId) {
      lines.push(`🔄 Order ID: <code>${escapeHtml(pending.submittedOrderId)}</code> — جاري التحقق تلقائياً عند الطرف المستلم.`);
    } else if (pending.verificationError) {
      lines.push(`❌ آخر محاولة لم تنجح: <code>${escapeHtml(pending.verificationError)}</code>. أرسل Order ID صحيح للمحاولة مرة ثانية.`);
      keyboard.push([{
        text: `🔁 إعادة إرسال Order ID — $${amount.toFixed(2)}`,
        callback_data: `adm:debt_retry:${pending.id}`,
        style: 'primary'
      }]);
    } else {
      lines.push(`🆔 Binance ID: <code>${escapeHtml(pending.binancePayId || '')}</code>`, 'بعد التحويل لازم ترسل Order ID حتى يتم التحقق تلقائياً.');
      keyboard.push([{
        text: `🆔 إرسال Order ID — $${amount.toFixed(2)}`,
        callback_data: `adm:debt_retry:${pending.id}`,
        style: 'primary'
      }]);
    }
  }

  for (const pending of data.pendingIncoming || []) {
    const amount = Number(pending.amountUsd || 0);
    if (String(pending.paymentMethod || '') === 'manual') {
      lines.push('', `🧾 إثبات يدوي من <b>${escapeHtml(pending.debtorName || pending.debtorShopId)}</b> بقيمة <b>$${amount.toFixed(2)}</b>.`);
      lines.push(pending.manualProofSubmittedAt ? '📷 وصلت الصورة وبانتظار قرارك.' : '⏳ لم تصل صورة الإثبات بعد.');
      if (pending.manualProofSubmittedAt) keyboard.push([
        { text: '✅ وصل المبلغ', callback_data: `adm:debt_resolve:1:${pending.id}`, style: 'success' },
        { text: '❌ رفض الإثبات', callback_data: `adm:debt_resolve:0:${pending.id}`, style: 'danger' }
      ]);
      continue;
    }
    if (pending.binancePayId) {
      lines.push('', `📥 <b>${escapeHtml(pending.debtorName || pending.debtorShopId)}</b> عنده تسوية Binance معلقة إلك بقيمة <b>$${amount.toFixed(2)}</b>.`);
      if (pending.submittedOrderId) lines.push('🔄 وصل Order ID والنظام يتحقق منه تلقائياً بحساب Binance الخاص بهذا البوت.');
      continue;
    }

    // Compatibility only for old manual settlement requests created before v11.8.
    lines.push('', `⚠️ طلب تسوية قديم من <b>${escapeHtml(pending.debtorName || pending.debtorShopId)}</b> بقيمة <b>$${amount.toFixed(2)}</b>.`);
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
  if (String(product.type || '') === 'service') return bot.sendMessage(chatId, '🛠 تنفيذ خدمة ما عنده مخزون أو مساهمو مخزون.');
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
    `📊 <b>${escapeHtml(productDisplayName(product, 'ar'))}</b>`,
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
      `عمولة البيع التي كسبها من مخزون الآخرين: <b>$${Number(row.sellerCommissionUsd || 0).toFixed(2)}</b>`,
      `ربح فرق السعر المحلي: <b>$${Number(row.sellerMarkupUsd || 0).toFixed(2)}</b>`
    );
  }
  if (!contributors.length) lines.push('— ماكو مخزون بعد.');
  return bot.sendMessage(chatId, lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '📥 إضافة مخزون', callback_data: `adm:stockprod:${product.id}`, style: 'success' }]] }
  });
}

async function handleAdminCallback(query, user, data) {
  if (data === 'adm:admins') {
    await answerCallback(query.id);
    return showAdminAccessManager(query.message.chat.id);
  }

  if (data === 'adm:admin_add') {
    await setState(user.id, { action: 'admin_add_admin_id' });
    await answerCallback(query.id);
    return bot.sendMessage(user.id, [
      '➕ <b>إضافة أدمن جديد</b>',
      '',
      'أرسل Telegram ID رقمي فقط.',
      'بعد الإضافة يحصل الأدمن على صلاحيات كاملة داخل هذا البوت مباشرة، وتبقى الصلاحية محفوظة في قاعدة البيانات بعد إعادة التشغيل.',
      '',
      'مثال: <code>123456789</code>'
    ].join('\n'), { parse_mode: 'HTML', reply_markup: cancelInlineKeyboard() });
  }

  if (data.startsWith('adm:admin_remove_confirm:')) {
    const id = adminAccess.normalizeTelegramId(data.split(':')[3]);
    if (id === null) return answerCallback(query.id, 'Telegram ID غير صحيح.', true);
    if (id === Number(user.id)) return answerCallback(query.id, 'ما تگدر تحذف صلاحيتك بنفسك. خلي أدمن آخر يشيلك.', true);
    const admins = await adminAccess.listAdmins();
    const row = admins.find(item => Number(item.telegramId) === id && item.isActive);
    if (!row) return answerCallback(query.id, 'الأدمن غير موجود أو محذوف مسبقاً.', true);
    if (row.isProtected) return answerCallback(query.id, 'الأدمن الأساسي محمي من الحذف.', true);
    await answerCallback(query.id);
    return bot.sendMessage(query.message.chat.id, [
      '⚠️ <b>تأكيد إزالة الأدمن</b>',
      `Telegram ID: <code>${id}</code>`,
      '',
      'راح يفقد صلاحية /admin وإدارة هذا البوت فقط. بيانات البوت والمستخدمين والطلبات لن تتأثر.'
    ].join('\n'), {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[
        { text: '🗑 نعم، إزالة الأدمن', callback_data: `adm:admin_remove:${id}`, style: 'danger' },
        { text: 'إلغاء', callback_data: 'adm:admins' }
      ]] }
    });
  }

  if (data.startsWith('adm:admin_remove:')) {
    const id = adminAccess.normalizeTelegramId(data.split(':')[3]);
    if (id === null) return answerCallback(query.id, 'Telegram ID غير صحيح.', true);
    if (id === Number(user.id)) return answerCallback(query.id, 'ما تگدر تحذف صلاحيتك بنفسك.', true);
    try {
      await adminAccess.removeAdmin(id, user);
      await bot.setMyCommands([
        { command: 'start', description: 'فتح المتجر' },
        { command: 'cancel', description: 'إلغاء العملية الحالية' }
      ], { scope: { type: 'chat', chat_id: id } }).catch(() => {});
      await answerCallback(query.id, 'تمت إزالة صلاحية الأدمن.');
      await bot.sendMessage(id, 'ℹ️ تم إلغاء صلاحية الإدارة الخاصة بك في هذا البوت.').catch(() => {});
      return showAdminAccessManager(query.message.chat.id);
    } catch (error) {
      const messages = {
        PROTECTED_ADMIN: 'الأدمن الأساسي محمي من الحذف.',
        LAST_ADMIN: 'لا يمكن حذف آخر أدمن في البوت.',
        ADMIN_NOT_FOUND: 'الأدمن غير موجود.'
      };
      return answerCallback(query.id, messages[error.message] || `تعذر حذف الأدمن: ${error.message}`, true);
    }
  }

  if (data === 'adm:home') {
    await answerCallback(query.id);
    return bot.sendMessage(query.message.chat.id, await adminDashboardText(), {
      parse_mode: 'HTML',
      reply_markup: await adminMenu()
    });
  }

  if (data.startsWith('adm:menu:')) {
    const section = data.slice('adm:menu:'.length);
    const menu = await adminSectionMenu(section, user);
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
      let creditor;
      if (network.isMaster()) {
        creditor = await network.getCounterpartyPaymentProfile(counterpartyShopId);
        if (!creditor?.binanceReady || !creditor?.binancePayId) throw new Error('CREDITOR_BINANCE_NOT_CONFIGURED');
        request = await networkLedger.createDebtPaymentRequest('master', counterpartyShopId, { binancePayId: creditor.binancePayId });
      } else {
        const started = await network.startDebtBinancePayment(counterpartyShopId);
        request = started?.request;
        creditor = started?.creditor;
      }
      if (!request) throw new Error('PAYMENT_REQUEST_NOT_FOUND');
      invalidateCommerceStatus();
      await setState(user.id, {
        action: 'admin_debt_binance_order',
        debtPaymentId: request.id,
        creditorShopId: counterpartyShopId,
        creditorName: creditor?.shopName || counterpartyShopId,
        binancePayId: request.binancePayId || creditor?.binancePayId,
        amountUsd: Number(request.amountUsd || 0)
      });
      await answerCallback(query.id, 'تم إنشاء تسوية Binance.');
      return bot.sendMessage(query.message.chat.id, [
        '💰 <b>تسديد الدين عبر Binance</b>',
        '',
        `<b>${escapeHtml(creditor?.shopName || counterpartyShopId)}</b> يطلبك <b>$${Number(request.amountUsd || 0).toFixed(2)}</b>.`,
        'يجب تسديده بالدولار.',
        '',
        `قم بإرسال <b>${Number(request.amountUsd || 0).toFixed(2)} USDT</b> إلى Binance ID:`,
        `<code>${escapeHtml(request.binancePayId || creditor?.binancePayId || '')}</code>`,
        '',
        'ثم ارسل Order ID هنا للتأكيد التلقائي:'
      ].join('\n'), { parse_mode: 'HTML', reply_markup: cancelInlineKeyboard() });
    } catch (error) {
      const message = error.message === 'NO_DEBT_TO_PAY'
        ? 'ماكو دين مفتوح لهذا الطرف.'
        : error.message === 'CREDITOR_BINANCE_NOT_CONFIGURED'
          ? 'الطرف المقابل لازم يضيف Binance API + Binance ID حتى تقدر تسدد له تلقائياً.'
          : error.message === 'MANUAL_PROOF_ALREADY_SUBMITTED'
            ? 'سبق إرسال صورة دفع يدوي لهذا الدين؛ انتظر موافقة الطرف الدائن أو رفضه.'
          : error.message;
      return answerCallback(query.id, message, true);
    }
  }

  if (data.startsWith('adm:debt_manual:')) {
    const counterpartyShopId = data.slice('adm:debt_manual:'.length);
    try {
      const started = await network.startDebtManualPayment(counterpartyShopId);
      const request = started?.request;
      if (!request) throw new Error('PAYMENT_REQUEST_NOT_FOUND');
      invalidateCommerceStatus();
      await setState(user.id, {
        action: 'admin_debt_manual_proof',
        debtPaymentId: request.id,
        creditorShopId: counterpartyShopId,
        creditorName: started?.creditor?.shopName || request.creditorName || counterpartyShopId,
        amountUsd: Number(request.amountUsd || 0)
      });
      await answerCallback(query.id, 'أرسل صورة الدفع اليدوي.');
      return bot.sendMessage(query.message.chat.id, [
        '🧾 <b>تسديد الدين يدوياً</b>',
        '',
        `إلى: <b>${escapeHtml(started?.creditor?.shopName || request.creditorName || counterpartyShopId)}</b>`,
        `المبلغ المطلوب: <b>$${Number(request.amountUsd || 0).toFixed(2)}</b>`,
        '',
        'بعد تحويل المبلغ، أرسل صورة واضحة لإثبات الدفع هنا. ستصل الصورة إلى إدارة الطرف الدائن، ولن يُغلق الدين إلا بعد موافقتها.'
      ].join('\n'), { parse_mode: 'HTML', reply_markup: cancelInlineKeyboard() });
    } catch (error) {
      const message = error.message === 'NO_DEBT_TO_PAY'
        ? 'ماكو دين مفتوح لهذا الطرف.'
        : error.message === 'BINANCE_PAYMENT_ALREADY_SUBMITTED'
          ? 'سبق إرسال Order ID عبر Binance لهذا الدين؛ انتظر نتيجة التحقق أولاً.'
          : error.message;
      return answerCallback(query.id, message, true);
    }
  }

  if (data.startsWith('adm:debt_retry:')) {
    const requestId = data.slice('adm:debt_retry:'.length);
    try {
      const accountData = await localNetworkAccounts();
      const request = (accountData.pendingOutgoing || []).find(row => String(row.id) === String(requestId));
      if (!request) return answerCallback(query.id, 'طلب التسوية غير موجود.', true);
      await setState(user.id, {
        action: 'admin_debt_binance_order',
        debtPaymentId: request.id,
        creditorShopId: request.creditorShopId,
        creditorName: request.creditorName || request.creditorShopId,
        binancePayId: request.binancePayId,
        amountUsd: Number(request.amountUsd || 0)
      });
      await answerCallback(query.id);
      return bot.sendMessage(query.message.chat.id, [
        '🔁 <b>إعادة التحقق من تسوية Binance</b>',
        '',
        `المبلغ: <b>$${Number(request.amountUsd || 0).toFixed(2)}</b>`,
        `Binance ID: <code>${escapeHtml(request.binancePayId || '')}</code>`,
        '',
        'أرسل Order ID الصحيح هنا:'
      ].join('\n'), { parse_mode: 'HTML', reply_markup: cancelInlineKeyboard() });
    } catch (error) {
      return answerCallback(query.id, error.message, true);
    }
  }

  if (data.startsWith('adm:debt_manual_retry:')) {
    const requestId = data.slice('adm:debt_manual_retry:'.length);
    try {
      const accountData = await localNetworkAccounts();
      const request = (accountData.pendingOutgoing || []).find(row => String(row.id) === String(requestId));
      if (!request || String(request.paymentMethod || '') !== 'manual') return answerCallback(query.id, 'طلب التسوية اليدوية غير موجود.', true);
      await setState(user.id, {
        action: 'admin_debt_manual_proof',
        debtPaymentId: request.id,
        creditorShopId: request.creditorShopId,
        creditorName: request.creditorName || request.creditorShopId,
        amountUsd: Number(request.amountUsd || 0)
      });
      await answerCallback(query.id);
      return bot.sendMessage(query.message.chat.id, `📷 أرسل الآن صورة إثبات دفع <b>$${Number(request.amountUsd || 0).toFixed(2)}</b> إلى <b>${escapeHtml(request.creditorName || request.creditorShopId)}</b>.`, {
        parse_mode: 'HTML',
        reply_markup: cancelInlineKeyboard()
      });
    } catch (error) {
      return answerCallback(query.id, error.message, true);
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
    if (!network.isMaster()) return answerCallback(query.id, 'هذا الخيار متاح في البوت الرئيسي للشبكة فقط.', true);
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
    if (!network.isMaster()) return answerCallback(query.id, 'هذا الخيار متاح في البوت الرئيسي للشبكة فقط.', true);
    const enabled = String(await getSetting('network_api_enabled', 'true')).toLowerCase() !== 'false';
    await setSetting('network_api_enabled', enabled ? 'false' : 'true');
    await answerCallback(query.id, enabled ? 'تم إغلاق API لجميع الشركاء.' : 'تم فتح API لجميع الشركاء.');
    return;
  }

  if (data === 'adm:network_add') {
    if (!network.isMaster()) return answerCallback(query.id, 'هذا الخيار متاح في البوت الرئيسي للشبكة فقط.', true);
    await setState(user.id, { action: 'admin_network_add', step: 'name', data: {} });
    await answerCallback(query.id);
    return bot.sendMessage(user.id, '1/3 أرسل اسم صاحب البوت أو اسم المتجر، مثال: أحمد', { reply_markup: cancelInlineKeyboard() });
  }

  if (data.startsWith('adm:network_currency:')) {
    return answerCallback(query.id, 'هذا زر من مسار قديم. الإصدار الجديد يجهز الإعدادات تلقائياً بعد إرسال التوكن.', true);
  }

  if (data.startsWith('adm:network_client:')) {
    if (!network.isMaster()) return answerCallback(query.id, 'هذا الخيار متاح في البوت الرئيسي للشبكة فقط.', true);
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
    if (!network.isMaster()) return answerCallback(query.id, 'هذا الخيار متاح في البوت الرئيسي للشبكة فقط.', true);
    const client = await NetworkClient.findByPk(Number(data.split(':')[2]));
    if (!client) return answerCallback(query.id, 'الشريك غير موجود.', true);
    client.isActive = !client.isActive;
    await client.save({ fields: ['isActive'] });
    await answerCallback(query.id, client.isActive ? 'تم تفعيل API.' : 'تم إيقاف API لهذا البوت.');
    return;
  }

  if (data === 'adm:emoji:repairproducts') {
    if (!canManagePremiumEmojis(user)) return answerCallback(query.id, 'لأدمنات هذا البوت فقط.', true);
    await answerCallback(query.id, 'جاري فحص إيموجيات المنتجات...');
    try {
      const report = await auditProductEmojiMappings({ repair: true });
      const lines = [
        `${premiumEmojiHtml(PREMIUM_EMOJI.success)} <b>اكتملت المراجعة الذكية لإيموجيات المنتجات</b>`,
        '',
        `كل المنتجات المفحوصة: <b>${report.total}</b>`,
        `الخدمات المعروفة في القاموس: <b>${report.recognized}</b>`,
        `كانت صحيحة: <b>${report.correct}</b>`,
        `تم تصحيحها الآن: <b>${report.repaired}</b>`,
        '',
        'أي تغيير تحفظه عمداً من هذا الإصدار يبقى معتمداً لنفس الخدمة. الروابط القديمة غير المؤكدة والكلمات العامة لا تتغلب على اسم خدمة أدق.'
      ];
      if (report.unknownNames.length) {
        lines.push('', '<b>أسماء تحتاج ربطاً يدوياً لأنها غير معروفة بالقاموس:</b>');
        for (const name of report.unknownNames) lines.push(`• ${escapeHtml(name)}`);
      }
      return bot.sendMessage(query.message.chat.id, lines.join('\n'), {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: 'رجوع إلى الإيموجيات المميزة', callback_data: 'adm:emoji:0' }]] }
      });
    } catch (error) {
      console.error('Product emoji audit:', error.message);
      return bot.sendMessage(query.message.chat.id, 'تعذر إكمال المراجعة الآن. لم يتم حذف أو تغيير أي مخزون أو طلب.', {
        reply_markup: { inline_keyboard: [[{ text: 'رجوع', callback_data: 'adm:emoji:0' }]] }
      });
    }
  }

  if (data === 'adm:uitext:search') {
    if (!canManagePremiumEmojis(user)) return answerCallback(query.id, 'لأدمنات هذا البوت فقط.', true);
    await uiTextOverrides.persistCatalog().catch(error => console.error('UI text catalog flush:', error.message));
    await setState(user.id, { action: 'admin_ui_text_edit', step: 'query', data: {} });
    await answerCallback(query.id);
    return bot.sendMessage(user.id, [
      `${premiumEmojiHtml(PREMIUM_EMOJI.search)} <b>البحث عن نص أو زر</b>`,
      '',
      'أرسل كلمة موجودة داخل النص أو اسم الزر، أو اكتب عبارة مشابهة له.',
      'سأعرض أقرب نتيجة كاملة وأسألك: هل أنت تبحث عن هذا؟',
      '',
      'للحماية، لا يفهرس هذا البحث كلمات المرور أو مفاتيح API أو بيانات التسليم الحساسة.',
      'اكتب إغلاق للإلغاء.'
    ].join('\n'), { parse_mode: 'HTML', reply_markup: cancelInlineKeyboard() });
  }

  if (data === 'adm:uitext:yes' || data === 'adm:uitext:next') {
    if (!canManagePremiumEmojis(user)) return answerCallback(query.id, 'لأدمنات هذا البوت فقط.', true);
    const fresh = await User.findByPk(user.id);
    const state = parseState(fresh);
    if (!state || state.action !== 'admin_ui_text_edit' || state.step !== 'confirm') {
      return answerCallback(query.id, 'انتهت جلسة البحث. ابدأ بحثاً جديداً.', true);
    }
    await answerCallback(query.id);
    if (data === 'adm:uitext:yes') return selectCurrentUiTextCandidate(user, state);
    return nextUiTextCandidate(user, state);
  }

  if (data.startsWith('adm:uitext:list:')) {
    if (!canManagePremiumEmojis(user)) return answerCallback(query.id, 'لأدمنات هذا البوت فقط.', true);
    await answerCallback(query.id);
    return showUiTextOverridesAdmin(query.message.chat.id, user, Number(data.split(':')[3] || 0));
  }

  if (data.startsWith('adm:uitext:askdel:')) {
    if (!canManagePremiumEmojis(user)) return answerCallback(query.id, 'لأدمنات هذا البوت فقط.', true);
    const parts = data.split(':');
    const entryId = String(parts[3] || '');
    const page = Math.max(0, Number(parts[4] || 0));
    const row = uiTextOverrides.list().find(entry => entry.id === entryId);
    if (!row) return answerCallback(query.id, 'التعديل غير موجود.', true);
    await answerCallback(query.id);
    return bot.sendMessage(query.message.chat.id, [
      '⚠️ <b>هل تريد إلغاء هذا التعديل؟</b>',
      '',
      `الأصلي: <b>${escapeHtml(row.originalPlainText)}</b>`,
      `المعدل: <b>${escapeHtml(row.replacementText)}</b>`,
      '',
      'سيعود النص الأصلي فقط. لن يُحذف أي منتج أو طلب أو مخزون.'
    ].join('\n'), {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[
        emojiButton('تأكيد إلغاء التعديل', PREMIUM_EMOJI.delete, {
          callback_data: `adm:uitext:del:${row.id}:${page}`,
          style: 'danger'
        }),
        { text: 'رجوع', callback_data: `adm:uitext:list:${page}` }
      ]] }
    });
  }

  if (data.startsWith('adm:uitext:del:')) {
    if (!canManagePremiumEmojis(user)) return answerCallback(query.id, 'لأدمنات هذا البوت فقط.', true);
    const parts = data.split(':');
    const entryId = String(parts[3] || '');
    const page = Math.max(0, Number(parts[4] || 0));
    const removed = await uiTextOverrides.remove(entryId);
    await answerCallback(query.id, removed ? 'تمت إعادة النص الأصلي.' : 'التعديل ملغى أصلاً.');
    return showUiTextOverridesAdmin(query.message.chat.id, user, page);
  }

  if (data === 'adm:emoji:add') {
    if (!canManagePremiumEmojis(user)) return answerCallback(query.id, 'لأدمنات هذا البوت فقط.', true);
    await setState(user.id, { action: 'admin_premium_emoji_add', step: 'keyword_ar', data: {} });
    await answerCallback(query.id);
    return bot.sendMessage(user.id, [
      `${premiumEmojiHtml(PREMIUM_EMOJI.edit)} <b>إضافة أو تغيير إيموجي مميز</b>`,
      '',
      'أرسل الاسم أو المعنى <b>بالعربية فقط</b>، مثال: <code>كانفا</code>.',
      'سأولّد الاسم الإنجليزي وأزامنه تلقائياً، ثم أطلب منك الإيموجي.',
      'إذا كان الاسم محفوظاً من قبل، سيتم استبدال ربطه بالإيموجي الجديد.',
      'اكتب إغلاق للإلغاء.'
    ].join('\n'), { parse_mode: 'HTML', reply_markup: cancelInlineKeyboard() });
  }

  if (data.startsWith('adm:emoji:askdel:')) {
    if (!canManagePremiumEmojis(user)) return answerCallback(query.id, 'لأدمنات هذا البوت فقط.', true);
    const parts = data.split(':');
    const entryId = String(parts[3] || '');
    const page = Math.max(0, Number(parts[4] || 0));
    const entry = premiumEmojis.listCustom().find(row => row.id === entryId);
    if (!entry) return answerCallback(query.id, 'الربط غير موجود.', true);
    await answerCallback(query.id);
    return bot.sendMessage(query.message.chat.id, [
      '⚠️ <b>تأكيد حذف الربط فقط</b>',
      `${premiumEmojiHtml({ id: entry.emojiId, alt: entry.alt })} ${escapeHtml(entry.keywordAr)} ↔ ${escapeHtml(entry.keywordEn || '—')}`,
      '',
      'لن يُحذف أي منتج أو طلب أو سجل من قاعدة البيانات.'
    ].join('\n'), {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[
        emojiButton('تأكيد حذف الربط', PREMIUM_EMOJI.delete, { callback_data: `adm:emoji:del:${entry.id}:${page}`, style: 'danger' }),
        { text: 'إلغاء', callback_data: `adm:emoji:${page}` }
      ]] }
    });
  }

  if (data.startsWith('adm:emoji:del:')) {
    if (!canManagePremiumEmojis(user)) return answerCallback(query.id, 'لأدمنات هذا البوت فقط.', true);
    const parts = data.split(':');
    const entryId = String(parts[3] || '');
    const page = Math.max(0, Number(parts[4] || 0));
    const removed = await premiumEmojis.removeCustom(entryId);
    if (removed) await repairKnownProductEmojiMappings();
    await answerCallback(query.id, removed ? 'تم حذف الربط من جميع البوتات.' : 'الربط محذوف أصلاً.');
    return showPremiumEmojiAdmin(query.message.chat.id, user, page);
  }

  if (data.startsWith('adm:emoji:page:')) {
    if (!canManagePremiumEmojis(user)) return answerCallback(query.id, 'لأدمنات هذا البوت فقط.', true);
    await answerCallback(query.id);
    return showPremiumEmojiAdmin(query.message.chat.id, user, Number(data.split(':')[3] || 0));
  }

  if (/^adm:emoji(?::\d+)?$/.test(data)) {
    if (!canManagePremiumEmojis(user)) return answerCallback(query.id, 'لأدمنات هذا البوت فقط.', true);
    await answerCallback(query.id);
    return showPremiumEmojiAdmin(query.message.chat.id, user, Number(data.split(':')[2] || 0));
  }

  if (data === 'adm:vnproviders') {
    await answerCallback(query.id);
    if (!canManageVirtualProviders(user)) return bot.sendMessage(user.id, '⛔ إعدادات مزودي الأرقام متاحة لأدمنات هذا البوت فقط.');
    return showVirtualProviderAdmin(query.message.chat.id, user);
  }

  if (data.startsWith('adm:vnprovider:key:')) {
    if (!canManageVirtualProviders(user)) return answerCallback(query.id, 'لأدمنات هذا البوت فقط.', true);
    const providerId = String(data.split(':')[3] || '').toLowerCase();
    if (!VIRTUAL_PROVIDER_IDS.has(providerId)) return answerCallback(query.id, 'مزود غير صحيح.', true);
    const providerName = virtualProviderName(providerId);
    await setState(user.id, { action: 'admin_virtual_provider_api_key', providerId });
    await answerCallback(query.id);
    return bot.sendMessage(user.id, [
      `🔑 أرسل الآن API Key الخاص بـ <b>${providerName}</b>.`,
      '',
      '🔐 لن أعرض المفتاح بعد حفظه، وراح أحاول حذف رسالتك مباشرة بعد قراءتها.',
      'اكتب إغلاق للإلغاء.'
    ].join('\n'), { parse_mode: 'HTML', reply_markup: cancelInlineKeyboard() });
  }

  if (data.startsWith('adm:vnprovider:clear:')) {
    if (!canManageVirtualProviders(user)) return answerCallback(query.id, 'لأدمنات هذا البوت فقط.', true);
    const providerId = String(data.split(':')[3] || '').toLowerCase();
    if (!VIRTUAL_PROVIDER_IDS.has(providerId)) return answerCallback(query.id, 'مزود غير صحيح.', true);
    try {
      await virtualNumbers.removeProviderApiKey(providerId);
    } catch (error) {
      return answerCallback(query.id, virtualNumberErrorText(error, 'ar'), true);
    }
    await answerCallback(query.id, `تم حذف API ${virtualProviderName(providerId)} المحفوظ داخل البوت.`);
    return showVirtualProviderAdmin(query.message.chat.id, user);
  }

  if (data.startsWith('adm:vnprovider:profit:')) {
    if (!canManageVirtualProviders(user)) return answerCallback(query.id, 'لأدمنات هذا البوت فقط.', true);
    const providerId = String(data.split(':')[3] || '').toLowerCase();
    if (!VIRTUAL_PROVIDER_IDS.has(providerId)) return answerCallback(query.id, 'مزود غير صحيح.', true);
    const providerName = virtualProviderName(providerId);
    const current = await virtualNumbers.getProviderProfit(providerId);
    await setState(user.id, { action: 'admin_virtual_provider_profit', providerId });
    await answerCallback(query.id);
    return bot.sendMessage(user.id, [
      `📈 ربح <b>${providerName}</b> الحالي: <b>${virtualRetailPriceText(current)}</b>.`,
      'أرسل الربح الجديد لكل رقم بالدولار، مثال: <code>0</code> للبيع بسعر الموقع، أو <code>0.15</code> لإضافة 15 سنتاً.',
      'اكتب إغلاق للإلغاء.'
    ].join('\n'), { parse_mode: 'HTML', reply_markup: cancelInlineKeyboard() });
  }

  if (data === 'adm:vnprovider:test') {
    if (!canManageVirtualProviders(user)) return answerCallback(query.id, 'لأدمنات هذا البوت فقط.', true);
    await answerCallback(query.id, 'جاري فحص المزودات...');
    return showVirtualProviderAdmin(query.message.chat.id, user);
  }

  if (data.startsWith('adm:vnprovider:topup:')) {
    if (!canManageVirtualProviders(user)) return answerCallback(query.id, 'لأدمنات هذا البوت فقط.', true);
    const providerId = String(data.split(':')[3] || '').toLowerCase();
    if (providerId !== 'smsbower') return answerCallback(query.id, 'محفظة الشحن متاحة لـ SMSBower فقط.', true);
    const providerName = 'SMSBower';
    await answerCallback(query.id, `جاري جلب محفظة ${providerName}...`);
    try {
      const wallet = await virtualNumbers.providerWallet(providerId);
      const lines = [
        `💰 <b>شحن ${escapeHtml(providerName)}</b>`,
        '',
        `الشبكة: <b>${escapeHtml(wallet.network)}</b>`,
        `العملة: <b>${escapeHtml(wallet.coin)}</b>`,
        '',
        'عنوان المحفظة:',
        `<code>${escapeHtml(wallet.address)}</code>`,
        '',
        Number.isFinite(Number(wallet.balance)) ? `الرصيد الحالي بالموقع: <b>$${Number(wallet.balance).toFixed(2)}</b>` : ''
      ].filter(Boolean);
      lines.push('', '⚠️ تأكد من الشبكة قبل التحويل. البوت يعرض عنوان الشحن من API الرسمي للمزود ولا ينفذ التحويل بنفسه.');
      return bot.sendMessage(query.message.chat.id, lines.join('\n'), {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{ text: '🔄 تحديث المحفظة والرصيد', callback_data: `adm:vnprovider:topup:${providerId}` }],
          [{ text: '⬅️ رجوع لمزودي الأرقام', callback_data: 'adm:vnproviders' }]
        ] }
      });
    } catch (error) {
      const detail = String(error?.code || error?.message || 'UNKNOWN');
      return bot.sendMessage(query.message.chat.id, [
        `❌ تعذر جلب محفظة شحن ${providerName}.`,
        detail === 'VIRTUAL_NUMBERS_NOT_CONFIGURED' ? 'أضف API Key أولاً من زر إضافة API.' : `الخطأ: <code>${escapeHtml(detail)}</code>`
      ].join('\n'), {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '⬅️ رجوع لمزودي الأرقام', callback_data: 'adm:vnproviders' }]] }
      });
    }
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
      await setState(user.id, { action: 'admin_new_payment_method', step: 'minimum', data: dataState });
      return bot.sendMessage(user.id, `4/5 سعر الدولار ثابت: 1$ = 1 USD.\n\n5/5 كم الحد الأدنى للتحويل بالدولار؟ مثال: 0.50`, { reply_markup: cancelInlineKeyboard() });
    }
    await setState(user.id, { action: 'admin_new_payment_method', step: 'rate', data: dataState });
    return bot.sendMessage(user.id, currency === 'IQD'
      ? '4/5 أرسل سعر 1$ بالدينار العراقي، مثال: 1500'
      : '4/5 أرسل سعر 1$ بالجنيه المصري، مثال: 50', { reply_markup: cancelInlineKeyboard() });
  }

  if (data === 'adm:add_payment_method') {
    await setState(user.id, { action: 'admin_new_payment_method', step: 'nameAr', data: {} });
    await answerCallback(query.id);
    return bot.sendMessage(user.id, [
      '➕ <b>إضافة طريقة دفع</b>',
      '',
      '1/5 أرسل اسم الخدمة بالعربي.',
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

  if (data.startsWith('adm:pmmove:')) {
    const [, , idRaw, direction] = data.split(':');
    const id = Number(idRaw);
    if (!['up', 'down'].includes(direction)) return answerCallback(query.id, 'اتجاه الترتيب غير صحيح.', true);
    try {
      const result = await movePaymentMethod(id, direction);
      await answerCallback(query.id, result.moved ? 'تم تغيير ترتيب طريقة الدفع.' : (direction === 'up' ? 'هذه الطريقة بالأعلى أصلاً.' : 'هذه الطريقة بالأسفل أصلاً.'));
      return showAdminPaymentMethod(query.message.chat.id, id);
    } catch (error) {
      return answerCallback(query.id, error.message === 'PAYMENT_METHOD_NOT_FOUND' ? 'طريقة الدفع غير موجودة.' : `تعذر الترتيب: ${error.message}`, true);
    }
  }

  if (data.startsWith('adm:pmfield:')) {
    const [, , idRaw, field] = data.split(':');
    const id = Number(idRaw);
    if (!['name', 'number', 'minimum'].includes(field)) return answerCallback(query.id, 'حقل غير صحيح.', true);
    const method = await PaymentMethod.findByPk(id);
    if (!method) return answerCallback(query.id, 'طريقة الدفع غير موجودة.', true);
    if (network.enabledClient()) await setSetting('custom_payment_override', 'true');
    await setState(user.id, { action: 'admin_edit_payment_method', paymentMethodId: id, field });
    await answerCallback(query.id);
    return bot.sendMessage(user.id, field === 'name'
      ? 'أرسل الاسم الجديد بالعربي. تقدر تستخدم Premium Emoji أو [ID] قبل الاسم.'
      : field === 'number'
        ? 'أرسل رقم/معرّف الدفع الجديد.'
        : `أرسل الحد الأدنى الجديد بعملة ${paymentCurrencyLabel(method.settlementCurrency, 'ar')}.`, { reply_markup: cancelInlineKeyboard() });
  }

  if (data.startsWith('adm:pmtoggle:')) {
    const id = Number(data.split(':')[2]);
    const method = await PaymentMethod.findByPk(id);
    if (!method) return answerCallback(query.id, 'طريقة الدفع غير موجودة.', true);
    if (network.enabledClient()) await setSetting('custom_payment_override', 'true');
    method.isActive = !method.isActive;
    await method.save({ fields: ['isActive'] });
    invalidatePaymentMethodsCache();
    try { await syncPaymentMethodToNetwork(method); } catch (error) { console.error('Payment method toggle sync:', error.message); }
    await answerCallback(query.id, method.isActive ? 'تم تشغيل طريقة الدفع بكل البوتات.' : 'تم إيقاف طريقة الدفع بكل البوتات.');
    return showAdminPaymentMethod(query.message.chat.id, method.id);
  }

  if (data.startsWith('adm:pmdeleteconfirm:')) {
    const id = Number(data.split(':')[2]);
    const method = await PaymentMethod.findByPk(id);
    if (!method) return answerCallback(query.id, 'طريقة الدفع محذوفة مسبقاً.', true);
    try {
      method.isActive = false;
      await method.save({ fields: ['isActive'] });
      await syncPaymentMethodToNetwork(method).catch(error => console.error('Deactivate shared method before delete:', error.message));
    } catch (error) {
      console.error('Deactivate shared method before delete:', error.message);
    }
    const name = method.nameAr;
    await method.destroy();
    invalidatePaymentMethodsCache();
    await answerCallback(query.id, 'تم حذف طريقة الدفع.');
    await bot.sendMessage(query.message.chat.id, `🗑 تم حذف <b>${escapeHtml(name)}</b> من هذا البوت ومن طرق الدفع المشتركة. السجلات القديمة تبقى محفوظة بالحسابات.`, { parse_mode: 'HTML' });
    return showAdminPaymentMethods(query.message.chat.id);
  }

  if (data.startsWith('adm:pmdelete:')) {
    const id = Number(data.split(':')[2]);
    const method = await PaymentMethod.findByPk(id);
    if (!method) return answerCallback(query.id, 'طريقة الدفع غير موجودة.', true);
    await answerCallback(query.id);
    return bot.sendMessage(query.message.chat.id, `⚠️ حذف <b>${escapeHtml(method.nameAr)}</b>؟
راح تختفي من كل البوتات، لكن سجلات العمليات القديمة تبقى محفوظة.`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[
        { text: '🗑 نعم، حذف', callback_data: `adm:pmdeleteconfirm:${id}`, style: 'danger' },
        { text: 'إلغاء', callback_data: `adm:pm:${id}` }
      ]] }
    });
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
    const menu = await adminSectionMenu('marketing', user);
    return bot.sendMessage(query.message.chat.id, nowEnabled ? '🔔 <b>الإشعارات التلقائية شغالة الآن.</b>' : '🔕 <b>الإشعارات التلقائية متوقفة الآن.</b>', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: menu.keyboard }
    });
  }

  if (data === 'adm:store_toggle') {
    const open = await isStoreOpen();
    await setSetting('store_open', open ? 'false' : 'true');
    await answerCallback(query.id, open ? 'تم إغلاق المتجر.' : 'تم فتح المتجر.');
    const menu = await adminSectionMenu('settings', user);
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
    const allProducts = await Merchant.findAll({ where: { isActive: true }, order: [['id', 'ASC']] });
    const products = allProducts.filter(product => productVisibleInCurrentShop(product) && String(product.type || '') !== 'service');
    const keyboard = products.map(product => [{
      text: `${productDisplayName(product, 'ar')} | ${moneyUsd(effectiveProductPrice(product))}`,
      callback_data: `adm:ref_product_set:${product.id}`
    }]);
    keyboard.push([{ text: '❌ بدون منتج هدية', callback_data: 'adm:ref_product_set:0' }]);
    return bot.sendMessage(query.message.chat.id, 'اختَر المنتج الذي يُسلَّم مجاناً عند اكتمال الدعوات:', {
      reply_markup: { inline_keyboard: keyboard }
    });
  }

  if (data.startsWith('adm:ref_product_set:')) {
    const productId = Number(data.split(':')[2]);
    if (productId > 0) {
      const product = await Merchant.findByPk(productId);
      if (!product || !product.isActive || !productVisibleInCurrentShop(product) || String(product.type || '') === 'service') {
        return answerCallback(query.id, 'هذا المنتج غير صالح كهدية.', true);
      }
    }
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

  if (data.startsWith('adm:userzeroask:')) {
    const targetId = Number(data.split(':')[2]);
    const target = await User.findByPk(targetId);
    if (!target) return answerCallback(query.id, 'المستخدم غير موجود.', true);
    await answerCallback(query.id);
    return bot.sendMessage(query.message.chat.id, [
      '⚠️ <b>تأكيد تصفير المحفظة</b>',
      `المستخدم: <code>${target.id}</code>`,
      `الرصيد الحالي: <b>${moneyUsd(target.balance)}</b>`,
      '',
      'سيُسجَّل المبلغ المزال في سجل معاملات المحفظة باسم الأدمن المنفذ.'
    ].join('\n'), {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[
        { text: '✅ نعم، صفّر الرصيد', callback_data: `adm:userzero:${target.id}`, style: 'danger' },
        { text: '❌ إلغاء', callback_data: `adm:usercard:${target.id}` }
      ]] }
    });
  }

  if (data.startsWith('adm:userzero:')) {
    const targetId = Number(data.split(':')[2]);
    try {
      const result = await adminZeroUserBalance(targetId, user);
      await answerCallback(query.id, 'تم تصفير المحفظة.');
      await bot.sendMessage(targetId, `ℹ️ قامت الإدارة بتصفير محفظتك. الرصيد السابق: <b>${moneyUsd(result.previousBalance)}</b>، والرصيد الحالي: <b>$0.00</b>.`, { parse_mode: 'HTML' }).catch(() => {});
      return showAdminUserCard(query.message.chat.id, targetId);
    } catch (error) {
      return answerCallback(query.id, error.message === 'USER_NOT_FOUND' ? 'المستخدم غير موجود.' : error.message, true);
    }
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
      lines.push(...rows.map(order => `#${order.id} | ${escapeHtml(productDisplayName(order.Merchant, 'ar'))} | ${moneyUsd(order.totalAmount)}`));
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
      ? rows.map(order => `#${order.id} | ${productDisplayName(order.Merchant, 'ar')} | ${order.status} | ${moneyUsd(order.totalAmount)}`).join('\n')
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
    const currencyLine = [
      `عملة تسوية المتجر: <b>${escapeHtml(localCurrency)}</b>`,
      `سعر عرض IQD: <b>1$ = ${moneyIqd(rate)}</b>`,
      `سعر عرض EGP: <b>1$ = ${escapeHtml(String(egpRate))} جنيه مصري</b>`
    ].join('\n');
    const currencyButtons = [
      { text: '🇮🇶 سعر الدولار IQD', callback_data: 'adm:set:iqd_rate' },
      { text: '🇪🇬 سعر الدولار EGP', callback_data: 'adm:set:egp_rate_per_usd' },
      emojiButton('رقم سوبركي', PREMIUM_EMOJI.superqi, { callback_data: 'adm:set:superqi_number' })
    ];
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
        ...(canManageVirtualProviders(user) ? [[{ text: '📱 مزودات الأرقام الافتراضية', callback_data: 'adm:vnproviders', style: 'primary' }]] : []),
        ...(canManagePremiumEmojis(user) ? [[emojiButton('الإيموجيات المميزة', PREMIUM_EMOJI.settings, { callback_data: 'adm:emoji:0', style: 'primary' })]] : []),
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
    await setState(user.id, { action: 'admin_new_product', step: 'scope', data: {} });
    await answerCallback(query.id);
    return bot.sendMessage(user.id, '➕ <b>إضافة منتج جديد</b>\n\nوين تريد نشر المنتج؟', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [{ text: '🔒 محلي — داخل هذا البوت فقط', callback_data: 'adm:newscope:local', style: 'primary' }],
        [{ text: '🌐 عام — يُعرض على كل إدارات البوتات', callback_data: 'adm:newscope:public', style: 'success' }],
        [{ text: '❌ إغلاق', callback_data: 'flow:cancel', style: 'danger' }]
      ] }
    });
  }

  if (data === 'adm:add_service_local') {
    await setState(user.id, {
      action: 'admin_new_product',
      step: 'nameAr',
      data: { type: 'service', scope: 'local', localOnly: true }
    });
    await answerCallback(query.id, 'إضافة خدمة محلية لهذا البوت.');
    return bot.sendMessage(user.id, [
      '🛠 <b>إضافة خدمة محلية</b>',
      '',
      'هذه الخدمة ستظهر داخل هذا البوت فقط ولن تدخل كتالوج الشبكة.',
      '1/7 أرسل اسم الخدمة بالعربي.',
      'تقدر تستخدم Custom Emoji Premium مباشرة، أو تكتب ID الإيموجي بين أقواس مربعة.'
    ].join('\n'), {
      parse_mode: 'HTML',
      reply_markup: cancelInlineKeyboard()
    });
  }

  if (data.startsWith('adm:newscope:')) {
    const scope = data.split(':')[2];
    if (!['local', 'public'].includes(scope)) return answerCallback(query.id, 'خيار النشر غير صحيح.', true);
    const fresh = await User.findByPk(user.id);
    const state = parseState(fresh);
    if (!state || state.action !== 'admin_new_product' || state.step !== 'scope') {
      return answerCallback(query.id, 'عملية إضافة المنتج غير فعالة.', true);
    }
    if (scope === 'public' && network.isClient() && !network.enabledClient()) {
      return answerCallback(query.id, 'ربط الشبكة غير مكتمل؛ لا يمكن نشر منتج عام حالياً. اختَر محلي أو أكمل إعداد الشبكة.', true);
    }
    state.data.scope = scope;
    state.data.localOnly = scope === 'local';
    await setState(user.id, { action: 'admin_new_product', step: 'type', data: state.data });
    await answerCallback(query.id, scope === 'local' ? 'سيُنشر داخل هذا البوت فقط.' : 'سيُرسل لبقية إدارات البوتات للموافقة والتسعير.');
    return bot.sendMessage(user.id, 'ما نوع المنتج؟', {
      reply_markup: { inline_keyboard: [
        [{ text: '🔑 كود', callback_data: 'adm:newtype:code', style: 'primary' }],
        [{ text: '📧 إيميل وباسورد', callback_data: 'adm:newtype:account', style: 'primary' }],
        [{ text: '📝 منتج حر', callback_data: 'adm:newtype:free', style: 'primary' }],
        [{ text: '👥 حساب مشترك', callback_data: 'adm:newtype:shared', style: 'primary' }],
        [{ text: '❌ إغلاق', callback_data: 'flow:cancel', style: 'danger' }]
      ] }
    });
  }

  if (data.startsWith('adm:newtype:')) {
    const type = data.split(':')[2];
    if (!['code', 'account', 'free', 'service', 'shared'].includes(type)) return answerCallback(query.id, 'نوع غير صحيح.', true);
    const fresh = await User.findByPk(user.id);
    const state = parseState(fresh);
    if (!state || state.action !== 'admin_new_product' || state.step !== 'type') {
      return answerCallback(query.id, 'عملية إضافة المنتج غير فعالة.', true);
    }
    state.data.type = type;
    if (type === 'service') state.data.localOnly = true;
    await setState(user.id, { action: 'admin_new_product', step: 'nameAr', data: state.data });
    await answerCallback(query.id, `تم اختيار: ${productTypeLabel(type)}`);
    return bot.sendMessage(user.id, '1/5 أرسل اسم المنتج بالعربي.\nتقدر تستخدم Custom Emoji Premium مباشرة، أو تكتب ID الإيموجي بين أقواس مربعة مثل: [5221980268230882832] اسم المنتج.', {
      reply_markup: cancelInlineKeyboard()
    });
  }

  if (data.startsWith('adm:svcinputmode:')) {
    const mode = data.split(':')[2];
    if (!['email', 'phone', 'text'].includes(mode)) return answerCallback(query.id, 'نوع غير صحيح.', true);
    const fresh = await User.findByPk(user.id);
    const state = parseState(fresh);
    if (!state || state.action !== 'admin_new_product' || state.step !== 'serviceInputMode') {
      return answerCallback(query.id, 'عملية إضافة الخدمة غير فعالة.', true);
    }
    state.data.serviceInputMode = mode;
    await setState(user.id, { action: 'admin_new_product', step: 'servicePromptAr', data: state.data });
    await answerCallback(query.id, 'تم اختيار نوع البيانات.');
    return bot.sendMessage(user.id, '7/7 اكتب الرسالة التي ستظهر للزبون ليرسل البيانات المطلوبة.\nمثال: ارسل ايميلك فقط', { reply_markup: cancelInlineKeyboard() });
  }

  if (data.startsWith('adm:netprod:price:')) {
    const productId = Number(data.split(':')[3]);
    if (network.enabledClient()) await network.syncCatalogToLocal({ force: true }).catch(() => null);
    const product = await Merchant.findByPk(productId);
    if (!product || !isForeignPublicProduct(product)) return answerCallback(query.id, 'المنتج العام غير موجود.', true);
    if (String(product.localPublicationStatus || '').toLowerCase() !== 'pending') {
      return answerCallback(query.id, 'تم اتخاذ قرار بهذا المنتج مسبقاً داخل هذا البوت.', true);
    }
    const basePrice = networkProductBasePrice(product);
    await setState(user.id, { action: 'admin_publish_network_product', productId: product.id });
    await answerCallback(query.id);
    return bot.sendMessage(user.id, [
      `💵 <b>تسعير ونشر: ${escapeHtml(productDisplayName(product, 'ar'))}</b>`,
      `سعر صاحب المنتج: <b>${moneyUsd(basePrice)}</b>`,
      '',
      `أرسل سعر البيع داخل بوتك. يجب أن يكون ${moneyUsd(basePrice)} أو أكثر.`,
      'فرق السعر فوق السعر الأساسي يكون ربحاً لهذا البوت.'
    ].join('\n'), { parse_mode: 'HTML', reply_markup: cancelInlineKeyboard() });
  }

  if (data.startsWith('adm:netprod:reject:')) {
    const productId = Number(data.split(':')[3]);
    if (network.enabledClient()) await network.syncCatalogToLocal({ force: true }).catch(() => null);
    let product = null;
    let alreadyDecided = false;
    try {
      await sequelize.transaction(async transaction => {
        product = await Merchant.findByPk(productId, { transaction, lock: transaction.LOCK.UPDATE });
        if (!product || !isForeignPublicProduct(product)) throw new Error('NETWORK_PRODUCT_NOT_AVAILABLE');
        if (String(product.localPublicationStatus || '').toLowerCase() !== 'pending') {
          alreadyDecided = true;
          return;
        }
        await product.update({
          localPublicationStatus: 'rejected',
          localPriceOverrideUsd: null,
          localReviewNotifiedAt: new Date()
        }, { transaction });
      });
    } catch (error) {
      if (error.message === 'NETWORK_PRODUCT_NOT_AVAILABLE') return answerCallback(query.id, 'المنتج العام غير موجود.', true);
      throw error;
    }
    if (alreadyDecided) return answerCallback(query.id, 'تم اتخاذ قرار بهذا المنتج مسبقاً داخل هذا البوت.', true);
    product = await Merchant.findByPk(productId);
    await clearState(user.id);
    await answerCallback(query.id, 'تم رفضه في هذا البوت فقط.');
    return bot.sendMessage(user.id, `❌ تم رفض <b>${escapeHtml(productDisplayName(product, 'ar'))}</b> داخل هذا البوت فقط. بقية البوتات تتخذ قرارها بشكل مستقل.`, { parse_mode: 'HTML' });
  }

  if (data.startsWith('adm:netprod:hide:')) {
    const productId = Number(data.split(':')[3]);
    const product = await Merchant.findByPk(productId);
    if (!product || !isForeignPublicProduct(product)) return answerCallback(query.id, 'المنتج العام غير موجود.', true);
    product.localPublicationStatus = 'hidden';
    product.localReviewNotifiedAt = new Date();
    await product.save({ fields: ['localPublicationStatus', 'localReviewNotifiedAt'] });
    await clearState(user.id);
    await answerCallback(query.id, 'تم إخفاؤه من هذا البوت فقط.');
    return showAdminProducts(query.message.chat.id, 0);
  }

  if (data.startsWith('adm:localstatus:')) {
    const [, , status, idRaw] = data.split(':');
    if (!['published', 'hidden', 'deleted'].includes(status)) return answerCallback(query.id, 'حالة غير صحيحة.', true);
    const product = await Merchant.findByPk(Number(idRaw));
    if (!product || !productAccessibleInCurrentShop(product) || !isPublicProduct(product)) {
      return answerCallback(query.id, 'المنتج العام غير موجود في هذا البوت.', true);
    }
    product.localPublicationStatus = status;
    product.localReviewNotifiedAt = new Date();
    await product.save({ fields: ['localPublicationStatus', 'localReviewNotifiedAt'] });
    const resultText = status === 'published'
      ? 'تم إظهار المنتج في هذا البوت فقط.'
      : status === 'hidden'
        ? 'تم إخفاء المنتج من هذا البوت فقط.'
        : 'تم حذف المنتج من واجهة هذا البوت فقط.';
    await answerCallback(query.id, resultText);
    return showAdminProductEditor(query.message.chat.id, product.id);
  }

  if (data.startsWith('adm:edit:')) {
    await answerCallback(query.id);
    return showAdminProductEditor(query.message.chat.id, Number(data.split(':')[2]));
  }

  if (data.startsWith('adm:publish_network_confirm:')) {
    const product = await Merchant.findByPk(Number(data.split(':')[2]));
    if (!product || !canManageNetworkProduct(product)) return answerCallback(query.id, 'المنتج غير موجود أو لا تملكه.', true);
    try {
      await answerCallback(query.id, 'جاري نشر المنتج ونقل مخزونه...');
      const result = await promoteLocalProductToNetwork(product, user);
      await bot.sendMessage(query.message.chat.id, [
        '✅ <b>تم نشر المنتج في شبكة البوتات</b>',
        `المنتج: <b>${escapeHtml(productDisplayName(result.product, 'ar'))}</b>`,
        `المخزون الذي نُقل بأمان: <b>${Number(result.transferred || 0)}</b>`,
        '',
        'سيصل المنتج لبقية الإدارات، وكل إدارة تختار اسمها المحلي وسعرها أو تخفيه من بوتها.'
      ].join('\n'), { parse_mode: 'HTML' });
      return showAdminProductEditor(query.message.chat.id, result.product.id);
    } catch (error) {
      const message = String(error.message || '');
      const friendly = message.startsWith('PARTIAL_SHARED_INVENTORY:')
        ? `❌ يوجد ${Number(message.split(':')[1] || 0)} حساب مشترك بيع منه بعض الاستخدامات. انتظر نفاد هذه الحسابات أو عالجها قبل النشر حتى لا تتكرر الاستخدامات.`
        : message === 'SERVICE_PRODUCTS_MUST_BE_LOCAL'
          ? '❌ الخدمات التنفيذية تبقى محلية لأنها تعتمد على إدارة البوت المنفذ.'
          : `❌ تعذر نشر المنتج: ${escapeHtml(message)}`;
      return bot.sendMessage(query.message.chat.id, friendly, { parse_mode: 'HTML' });
    }
  }

  if (data.startsWith('adm:publish_network:')) {
    const product = await Merchant.findByPk(Number(data.split(':')[2]));
    if (!product || !canManageNetworkProduct(product)) return answerCallback(query.id, 'المنتج غير موجود أو لا تملكه.', true);
    if (String(product.visibilityScope || '').toLowerCase() !== 'private') return answerCallback(query.id, 'المنتج منشور في الشبكة مسبقاً.', true);
    if (String(product.type || '') === 'service') return answerCallback(query.id, 'الخدمات التنفيذية تبقى محلية.', true);
    const stock = await getProductStock(product.id);
    await answerCallback(query.id);
    return bot.sendMessage(query.message.chat.id, [
      '🌐 <b>تأكيد النشر في باقي البوتات</b>',
      `المنتج: <b>${escapeHtml(productDisplayName(product, 'ar'))}</b>`,
      `السعر الأساسي: <b>${moneyUsd(product.price)}</b>`,
      `المخزون الحالي: <b>${stock}</b>`,
      '',
      'سيُنقل المخزون غير المباع إلى الكتالوج المشترك، ثم تقرر كل إدارة نشر المنتج وتسعيره داخل بوتها.'
    ].join('\n'), {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[
        { text: '✅ نشر في باقي البوتات', callback_data: `adm:publish_network_confirm:${product.id}`, style: 'success' },
        { text: '❌ إلغاء', callback_data: `adm:edit:${product.id}` }
      ]] }
    });
  }

  if (data.startsWith('adm:field:')) {
    const [, , idRaw, field] = data.split(':');
    const managedProduct = await Merchant.findByPk(Number(idRaw));
    if (!canEditProductField(managedProduct, field)) return answerCallback(query.id, 'لا يمكنك تعديل هذا الحقل. استخدم الاسم أو السعر الخاصين بهذا البوت.', true);
    if (!['nameAr', 'price', 'localNameAr', 'localPrice', 'localDescriptionAr', 'localWarrantyAr', 'localImage', 'descriptionAr', 'warrantyAr', 'image'].includes(field)) {
      return answerCallback(query.id, 'هذا الحقل لم يعد مستخدماً.', true);
    }
    await setState(user.id, { action: 'admin_edit_product', productId: Number(idRaw), field });
    await answerCallback(query.id);
    const prompts = {
      nameAr: 'أرسل اسم المنتج بالعربي. تقدر تستخدم Custom Emoji Premium مباشرة أو ID بين [] مثل [5221980268230882832] اسم المنتج.',
      localNameAr: 'أرسل الاسم الذي تريد عرضه داخل هذا البوت فقط. بقية البوتات لن تتغير. أرسل - للرجوع إلى الاسم العام.',
      price: isForeignPublicProduct(managedProduct)
        ? `أرسل السعر الذي تريد عرضه داخل بوتك فقط. أقل سعر مسموح: ${moneyUsd(networkProductBasePrice(managedProduct))}. تگدر ترفع السعر لكن ما تگدر تنزله عن سعر صاحب المنتج.`
        : 'أرسل السعر الجديد بالدولار.',
      localPrice: `أرسل سعر هذا البوت فقط. أقل سعر مسموح: ${moneyUsd(networkProductBasePrice(managedProduct))}. أرسل السعر الأساسي نفسه لإلغاء التخصيص.`,
      localDescriptionAr: 'أرسل الوصف الذي تريد عرضه داخل هذا البوت فقط. الترجمة الإنجليزية تلقائية. أرسل - للرجوع إلى الوصف العام.',
      localWarrantyAr: 'أرسل الضمان الذي تريد عرضه داخل هذا البوت فقط. الترجمة الإنجليزية تلقائية. أرسل - للرجوع إلى الضمان العام.',
      localImage: 'أرسل صورة مباشرة أو رابطاً لتكون خاصة بهذا البوت. أرسل - للرجوع للصورة العامة، أو اكتب «حذف» حتى لا تظهر صورة في هذا البوت.',
      descriptionAr: 'أرسل الوصف بالعربي، أو - للحذف. الترجمة الإنجليزية تلقائية.',
      warrantyAr: 'أرسل الضمان بالعربي، أو - للحذف. الترجمة الإنجليزية تلقائية.',
      image: 'أرسل صورة مباشرة، رابط صورة، أو - لحذف الصورة.'
    };
    return bot.sendMessage(user.id, `${prompts[field]}\nاكتب إغلاق للإلغاء.`, { reply_markup: cancelInlineKeyboard() });
  }

  if (data.startsWith('adm:type:')) {
    const [, , idRaw, type] = data.split(':');
    if (!['code', 'account', 'free', 'service', 'shared'].includes(type)) return answerCallback(query.id, 'نوع غير صحيح.', true);
    const product = await Merchant.findByPk(Number(idRaw));
    if (!product) return answerCallback(query.id, 'المنتج غير موجود.', true);
    if (type === 'service' || String(product.type || '') === 'service') {
      return answerCallback(query.id, 'تنفيذ خدمة نوع محلي خاص. أنشئه من زر «إضافة خدمة محلية» ولا يتم تحويل المنتجات إليه أو منه.', true);
    }
    if (!canManageNetworkProduct(product)) return answerCallback(query.id, 'هذا المنتج تابع لمتجر آخر بالشبكة.', true);
    if (!network.enabledClient()) {
      const protection = await network.productStockProtection(product.id, product.networkOwnerShopId || 'master');
      if (protection.externalAvailable > 0) return answerCallback(query.id, `ما تگدر تغيّر نوع المنتج لأن بيه ${protection.externalAvailable} وحدات مخزون لأشخاص آخرين.`, true);
    }
    if (product.networkManaged && network.enabledClient()) {
      try { await network.updateRemoteProduct(product.networkProductId, { type, sharedLimit: type === 'shared' ? 5 : 1, deliveryMode: 'instant' }); }
      catch (error) { return answerCallback(query.id, error.message.startsWith('STRUCTURE_LOCKED_BY_EXTERNAL_STOCK:') ? 'ما تگدر تغيّر نوع المنتج لأن بيه مخزون لأشخاص آخرين.' : error.message, true); }
    }
    product.type = type;
    product.sharedLimit = type === 'shared' ? 5 : 1;
    product.deliveryMode = 'instant';
    await product.save();
    await Code.update({ maxUses: type === 'shared' ? 5 : 1 }, { where: { merchantId: product.id, usedCount: 0, isUsed: false } });
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
      `📦 <b>${escapeHtml(productDisplayName(product, 'ar'))}</b> — ${productTypeLabel(product.type)}`,
      '',
      stockPrompt(product),
      '',
      'في المنتج الحر، التكرار يعني نفس الرسالة كاملة فقط، مو الأسطر داخلها. اكتب إغلاق للإلغاء.'
    ].join('\n'), { parse_mode: 'HTML', reply_markup: cancelInlineKeyboard() });
  }

  console.warn('Unhandled admin callback_data:', data, 'from admin', user.id);
  return answerCallback(query.id, 'هذا الزر قديم أو غير مدعوم حالياً. افتح لوحة الإدارة من جديد.', true);

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
    `منتج الهدية: <b>${escapeHtml(product ? productDisplayName(product, 'ar') : 'غير محدد')}</b>`,
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
    [{ text: '🧹 تصفير المحفظة', callback_data: `adm:userzeroask:${target.id}`, style: 'danger' }],
    [{ text: target.blocked ? '✅ فك الحظر' : '⛔ حظر المستخدم', callback_data: `adm:userblock:${target.id}` }],
    [{ text: '🔄 تحديث', callback_data: `adm:usercard:${target.id}` }]
  ];
  return bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
}

function productTypeLabel(type) {
  if (type === 'code') return 'كود';
  if (type === 'account') return 'إيميل وباسورد';
  if (type === 'free') return 'منتج حر';
  if (type === 'service') return 'تنفيذ خدمة';
  if (type === 'shared') return 'حساب مشترك';
  return String(type || 'منتج حر');
}

function productLocalStatusLabel(status) {
  const value = String(status || 'published').toLowerCase();
  if (value === 'pending') return 'بانتظار موافقة إدارة هذا البوت';
  if (value === 'hidden') return 'مخفي في هذا البوت';
  if (value === 'deleted') return 'محذوف من واجهة هذا البوت';
  if (value === 'rejected') return 'مرفوض في هذا البوت';
  return 'منشور في هذا البوت';
}

function stockPrompt(product) {
  if (product.type === 'code') {
    return `📥 أرسل الأكواد الآن، كل كود بسطر.\nمثال:\n<code>ABC-123\nXYZ-456</code>\n\nتقدر ترسل TXT/CSV أيضاً.`;
  }
  if (product.type === 'account') {
    return `📥 أرسل الحسابات الآن، كل حساب بسطر بصيغة:\n<code>email@example.com|password</code>\n\nتقدر ترسل TXT/CSV أيضاً.`;
  }
  if (product.type === 'shared') {
    return `👥 <b>حساب مشترك — 5 مستخدمين لكل حساب</b>\n\nأرسل كل حساب بسطر بصيغة:\n<code>email@example.com|password</code>\n\nكل إيميل ينبيع إلى 5 زبائن فقط، وبعد الاستخدام الخامس ينتقل البوت تلقائياً إلى الإيميل التالي.\nإذا أضفت حسابين يصير المخزون 10 استخدامات.`;
  }
  if (product.type === 'service') {
    return '🛠 تنفيذ خدمة ما يحتاج مخزون. بعد الدفع يرسل الزبون البيانات المطلوبة، وبعدها توصلك أزرار تنفيذ الخدمة.';
  }
  return `📥 <b>المنتج الحر — كل رسالة = قطعة واحدة</b>\n\nأرسل محتوى القطعة كامل برسالة واحدة، حتى لو كان من عدة أسطر مثل إيميل + باسورد + رمز مصادقة + رابط.\nالبوت يحفظ الرسالة كلها كمنتج واحد ويسلمها للزبون بنفس المحتوى.\n\nإذا تريد تضيف قطعة ثانية، أرسلها برسالة ثانية بعد إكمال إضافة الأولى.`;
}

async function showAdminProducts(chatId, page = 0) {
  if (network.enabledClient()) await network.syncCatalogToLocal().catch(() => {});
  const allProducts = await Merchant.findAll({ order: [['sortOrder', 'ASC'], ['id', 'ASC']] });
  // The admin list intentionally includes locally hidden/rejected/deleted
  // network products so each shop can restore or edit its own presentation.
  const products = allProducts.filter(product => productAccessibleInCurrentShop(product));
  const stocks = await getProductStocksMap(products);
  const sortedRows = sortProductStockRows(products.map(product => ({
    product,
    stock: Number(stocks.get(Number(product.id)) || 0)
  })));
  const perPage = 8;
  const pages = Math.max(1, Math.ceil(sortedRows.length / perPage));
  const safePage = Math.max(0, Math.min(page, pages - 1));
  const keyboard = [];

  const pageRows = sortedRows.slice(safePage * perPage, safePage * perPage + perPage);
  for (const { product, stock } of pageRows) {
    const localStatus = String(product.localPublicationStatus || 'published').toLowerCase();
    const statusPrefix = localStatus === 'published'
      ? ''
      : localStatus === 'pending'
        ? '⏳ '
        : localStatus === 'rejected'
          ? '🚫 '
          : '🙈 ';
    keyboard.push([{
      text: `${statusPrefix}${productDisplayName(product, 'ar')} | ${product.type === 'service' ? '🛠 خدمة' : product.type === 'shared' ? `👥 ${stock}/استخدام` : `📦 ${stock}`} | ${moneyUsd(effectiveProductPrice(product))}`,
      callback_data: `adm:edit:${product.id}`,
      style: localStatus !== 'published' || !product.isActive || (product.type !== 'service' && stock < 1) ? 'danger' : 'success'
    }]);
  }

  keyboard.push([
    { text: '➕ إضافة منتج', callback_data: 'adm:add_product', style: 'success' },
    { text: '🛠 خدمة محلية', callback_data: 'adm:add_service_local', style: 'success' }
  ]);
  const navigation = [];
  if (safePage > 0) navigation.push({ text: '⬅️', callback_data: `adm:products:${safePage - 1}` });
  navigation.push({ text: `${safePage + 1}/${pages}`, callback_data: 'noop' });
  if (safePage < pages - 1) navigation.push({ text: '➡️', callback_data: `adm:products:${safePage + 1}` });
  keyboard.push(navigation);
  keyboard.push([{ text: '⬅️ رجوع للمنتجات والمخزون', callback_data: 'adm:menu:products' }]);

  await bot.sendMessage(chatId, '📦 <b>إدارة المنتجات</b>\n🟢 منشور ومتوفر  •  🔴 فارغ/مخفي/مرفوض/محذوف محلياً', {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function showAdminProductEditor(chatId, productId) {
  const product = await Merchant.findByPk(productId);
  if (!product || !productAccessibleInCurrentShop(product)) return bot.sendMessage(chatId, 'هذا المنتج غير تابع لهذا البوت.');
  const publicationStatus = String(product.localPublicationStatus || 'published').toLowerCase();
  const description = productPresentationDescription(product);
  const stock = await getProductStock(product.id);
  const manageable = canManageNetworkProduct(product);
  const foreignPublic = isForeignPublicProduct(product);
  const publicProduct = isPublicProduct(product);
  const privateProduct = !publicProduct;
  const displayPrice = effectiveProductPrice(product);
  const basePrice = networkProductBasePrice(product);
  const scopeLabel = privateProduct ? 'محلي — هذا البوت فقط' : 'عام — كتالوج الشبكة';
  const localEmoji = productDisplayEmoji(product, parseDescription(product.description));
  const displayImage = productDisplayImage(product);
  const text = [
    `📝 <b>${escapeHtml(productDisplayName(product, 'ar'))}</b>`,
    '',
    `النوع: <b>${productTypeLabel(product.type)}</b>`,
    `سعر البيع في هذا البوت: <b>${moneyUsd(displayPrice)}</b>`,
    publicProduct ? `السعر العام لصاحب المنتج: <b>${moneyUsd(basePrice)}</b>` : '',
    publicProduct && hasLocalNetworkPriceOverride(product) ? `ربح فرق السعر بهذا البوت: <b>${moneyUsd(displayPrice - basePrice)}</b> لكل وحدة` : '',
    `المخزون: <b>${product.type === 'service' ? 'لا يحتاج مخزون' : product.type === 'shared' ? `${stock} استخدام` : stock}</b>`,
    product.type === 'shared' ? `حد المشاركة لكل حساب: <b>${Number(product.sharedLimit || 5)} زبائن</b>` : '',
    `حالة هذا البوت: <b>${productLocalStatusLabel(publicationStatus)}</b>`,
    `الحالة العامة: <b>${product.isActive ? 'فعّال' : 'متوقف'}</b>`,
    `نطاق النشر: <b>${scopeLabel}</b>`,
    `الترجمة الإنجليزية: <b>تلقائية</b>`,
    String(product.visibilityScope || 'public').toLowerCase() === 'public' ? `المالك: <code>${escapeHtml(product.networkOwnerShopId || 'master')}</code>${product.createdByDisplayName ? ` — ${escapeHtml(product.createdByDisplayName)}` : ''}` : '',
    publicProduct ? '🧩 <b>التخصيص المحلي:</b> الاسم والسعر والوصف والضمان والصورة والإخفاء والحذف تخص هذا البوت فقط ولا تغيّر بقية البوتات.' : '',
    '',
    `الوصف: ${escapeHtml(description.ar || '—')}`,
    `الضمان: ${escapeHtml(description.warrantyAr || '—')}`,
    `الصورة المعروضة بهذا البوت: ${displayImage ? 'موجودة' : 'بدون'}`,
    product.type === 'service' ? `بيانات الزبون المطلوبة: ${escapeHtml(serviceInputModeLabel(description.serviceInputMode || 'text', 'ar'))}` : '',
    product.type === 'service' ? `رسالة الطلب: ${escapeHtml(description.servicePromptAr || '—')}` : '',
    localEmoji?.id ? '✨ Custom Emoji: محفوظة للاسم المعروض' : '✨ Custom Emoji: لا توجد'
  ].filter(Boolean).join('\n');

  const commonRows = product.type === 'service' ? [] : [
    [{ text: '📥 إضافة مخزون لهذا المنتج', callback_data: `adm:stockprod:${product.id}`, style: 'success' }],
    [{ text: '📊 مساهمو المخزون والمبيعات', callback_data: `adm:contributors:${product.id}`, style: 'primary' }]
  ];
  const keyboard = [];
  if (publicProduct) {
    keyboard.push([{
      text: '✏️ اسم هذا البوت فقط',
      callback_data: `adm:field:${product.id}:localNameAr`,
      style: 'primary'
    }, {
      text: '💵 سعر هذا البوت فقط',
      callback_data: `adm:field:${product.id}:localPrice`,
      style: 'primary'
    }]);
    keyboard.push([{
      text: '📝 وصف هذا البوت فقط',
      callback_data: `adm:field:${product.id}:localDescriptionAr`,
      style: 'primary'
    }, {
      text: '🛡 ضمان هذا البوت فقط',
      callback_data: `adm:field:${product.id}:localWarrantyAr`,
      style: 'primary'
    }]);
    keyboard.push([{
      text: '🖼 صورة هذا البوت فقط',
      callback_data: `adm:field:${product.id}:localImage`,
      style: 'primary'
    }]);
    if (publicationStatus === 'published') {
      keyboard.push([
        { text: '🙈 إخفاء محلياً', callback_data: `adm:localstatus:hidden:${product.id}`, style: 'danger' },
        { text: '🗑 حذف محلياً', callback_data: `adm:localstatus:deleted:${product.id}`, style: 'danger' }
      ]);
    } else {
      keyboard.push([{
        text: '👁 نشر/استعادة في هذا البوت',
        callback_data: `adm:localstatus:published:${product.id}`,
        style: 'success'
      }]);
    }
  }
  if (manageable) {
    keyboard.push([{ text: publicProduct ? '✏️ الاسم العام لكل البوتات' : '✏️ الاسم', callback_data: `adm:field:${product.id}:nameAr` }, { text: publicProduct ? '💵 السعر العام لكل البوتات' : '💵 السعر', callback_data: `adm:field:${product.id}:price` }]);
    keyboard.push([{ text: publicProduct ? '📝 الوصف العام' : '📝 الوصف', callback_data: `adm:field:${product.id}:descriptionAr` }, { text: publicProduct ? '🛡 الضمان العام' : '🛡 الضمان', callback_data: `adm:field:${product.id}:warrantyAr` }]);
    keyboard.push([{ text: publicProduct ? '🖼 الصورة العامة' : '🖼 الصورة', callback_data: `adm:field:${product.id}:image` }]);
  }
  keyboard.push(...commonRows);
  if (manageable && privateProduct && String(product.type || '') !== 'service') {
    keyboard.push([{ text: '🌐 نشر المنتج في باقي البوتات', callback_data: `adm:publish_network:${product.id}`, style: 'success' }]);
  }
  if (manageable) {
    keyboard.push([{
      text: publicProduct
        ? (product.isActive ? '⛔ إيقاف عام بكل البوتات' : '✅ تشغيل عام بكل البوتات')
        : (product.isActive ? '🙈 إخفاء المنتج' : '👁 إظهار المنتج'),
      callback_data: `adm:toggle:${product.id}`,
      style: product.isActive ? 'danger' : 'success'
    }]);
    keyboard.push([{
      text: publicProduct ? '🗑 حذف نهائي من كل البوتات' : '🗑 حذف المنتج',
      callback_data: `adm:delete:${product.id}`,
      style: 'danger'
    }]);
  }
  keyboard.push([{ text: '⬅️ كل المنتجات', callback_data: 'adm:products:0' }]);
  await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
}

async function showStockProductList(chatId) {
  if (network.enabledClient()) await network.syncCatalogToLocal().catch(() => null);
  const allProducts = await Merchant.findAll({ where: { isActive: true }, order: [['sortOrder', 'ASC'], ['id', 'ASC']] });
  const products = allProducts.filter(product => productVisibleInCurrentShop(product) && String(product.type || '') !== 'service');
  const keyboard = [];
  const stocks = await getProductStocksMap(products);
  const sortedRows = sortProductStockRows(products.map(product => ({
    product,
    stock: Number(stocks.get(Number(product.id)) || 0)
  })));
  for (const { product, stock } of sortedRows) {
    keyboard.push([{
      text: `${productDisplayName(product, 'ar')} | 📦 ${stock}`,
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
let networkAccountWatcherRunning = false;
let lastSharedPaymentSnapshotHash = '';
let lastSharedPaymentSnapshotAt = 0;

async function fetchLocalNetworkAccountData() {
  if (network.isMaster()) return networkLedger.accountsForShop('master');
  if (network.enabledClient()) {
    const remote = await network.getMyAccounts();
    return remote?.accounts || { accounts: [], pendingIncoming: [], pendingOutgoing: [] };
  }
  return { accounts: [], pendingIncoming: [], pendingOutgoing: [], commerceStatus: { suspended: false, liabilityUsd: 0, thresholdUsd: Number(config.network.debtSuspendThresholdUsd || 40) } };
}

async function syncLocalSharedPaymentMethods() {
  if (!network.isMaster() && !network.enabledClient()) return;
  const methods = await PaymentMethod.findAll({ order: [['id', 'ASC']] });

  const snapshotPayload = methods.map(method => ({
    localMethodId: method.id,
    nameAr: method.nameAr,
    nameEn: method.nameEn,
    paymentNumber: method.paymentNumber,
    iconCustomEmojiId: method.iconCustomEmojiId,
    iconAlt: method.iconAlt,
    settlementCurrency: method.settlementCurrency,
    ratePerUsd: Number(method.ratePerUsd || 1),
    minimumTransferAmount: minimumTransferForMethod(method),
    isActive: Boolean(method.isActive)
  }));
  const snapshotHash = crypto.createHash('sha256').update(JSON.stringify(snapshotPayload)).digest('hex');
  // Do not re-send the exact same payment-method snapshot every 30 seconds.
  // A 5-minute heartbeat still repairs any missed network sync automatically.
  if (snapshotHash === lastSharedPaymentSnapshotHash && Date.now() - lastSharedPaymentSnapshotAt < 300000) return;

  // v12.0.2: publish the whole local wallet list as one authoritative snapshot.
  // This makes newly-added Egyptian/Iraqi/USD wallets propagate to every bot
  // and also removes deleted wallets from the shared registry. Older masters
  // are still supported through the per-method fallback below.
  if (typeof network.syncSharedPaymentMethodsSnapshot === 'function') {
    try {
      await network.syncSharedPaymentMethodsSnapshot(snapshotPayload);
      lastSharedPaymentSnapshotHash = snapshotHash;
      lastSharedPaymentSnapshotAt = Date.now();
      return;
    } catch (error) {
      console.error('Shared payment snapshot sync:', error.message);
    }
  }

  for (const method of methods) {
    try { await syncPaymentMethodToNetwork(method); }
    catch (error) { console.error(`Shared payment method sync #${method.id}:`, error.message); }
  }
}

async function processOwnedSharedPaymentRequests() {
  if (!network.isMaster() && !network.enabledClient()) return;
  const data = await network.ownedSharedPaymentRequests();
  let seen = [];
  try { seen = JSON.parse(await getSetting('shared_payment_owner_notified_ids_v117', '[]')); } catch { seen = []; }
  const seenSet = new Set(Array.isArray(seen) ? seen.map(String) : []);
  let changed = false;
  for (const request of data.requests || []) {
    if (seenSet.has(String(request.id))) continue;
    const method = request.method || {};
    const currency = normalizePaymentCurrency(request.paymentCurrency || method.settlementCurrency || 'USD');
    const amountLocal = Number(request.paymentAmount || 0);
    const methodName = method.nameAr || method.nameEn || 'طريقة دفع مشتركة';
    const text = [
      '💳 <b>تأكيد دفعة مشتركة</b>',
      '',
      `الطريقة: <b>${escapeHtml(methodName)}</b>`,
      `المتجر الذي تمت فيه العملية: <b>${escapeHtml(request.sourceShopName || request.sourceShopId || '')}</b>`,
      `الزبون: <b>${escapeHtml(request.customerName || String(request.customerId || ''))}</b>`,
      `النوع: <b>${request.activity === 'topup' ? 'شحن محفظة' : 'شراء منتج'}</b>`,
      `المبلغ: <b>${formatPaymentCurrencyAmount(amountLocal, currency, 'ar')}</b>`,
      '',
      'وافق فقط إذا المبلغ وصل فعلاً إلى طريقة الدفع الخاصة بك.'
    ].join('\n');
    for (const adminId of getAdminIds()) {
      await bot.sendMessage(adminId, text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[
          { text: '✅ وصل المبلغ', callback_data: `shpay:approve:${request.id}`, style: 'success' },
          { text: '❌ ما وصل', callback_data: `shpay:reject:${request.id}`, style: 'danger' }
        ]] }
      }).catch(() => {});
    }
    seenSet.add(String(request.id));
    changed = true;
  }
  if (changed) await setSetting('shared_payment_owner_notified_ids_v117', JSON.stringify([...seenSet].slice(-500)));
}

function telegramIdentityText({ username = null, id = null, name = null } = {}) {
  const cleanUsername = String(username || '').trim().replace(/^@/, '');
  if (cleanUsername) return `@${cleanUsername}`;
  const cleanName = String(name || '').trim();
  if (cleanName && id) return `${cleanName} — Telegram ID: ${id}`;
  if (id) return `Telegram ID: ${id}`;
  return cleanName || 'غير معروف';
}

async function notifySourceAdminsSharedApproval(request, userRow, activityLabel) {
  const approver = telegramIdentityText({
    username: request.approvedByUsername,
    id: request.approvedByTelegramId,
    name: request.approvedByDisplayName || request.paymentOwnerShopName
  });
  const customer = telegramIdentityText({
    username: userRow?.username,
    id: userRow?.id || request.customerId,
    name: userRow?.firstName || request.customerName
  });
  const methodName = request.method?.nameAr || request.method?.nameEn || 'طريقة دفع مشتركة';
  const amountLocal = formatPaymentCurrencyAmount(
    Number(request.paymentAmount || 0),
    request.paymentCurrency || request.method?.settlementCurrency || 'USD',
    'ar'
  );
  const text = [
    '✅ <b>عملية ناجحة</b>',
    '',
    `${activityLabel}: <b>${customer}</b>`,
    `طريقة الدفع: <b>${escapeHtml(methodName)}</b>`,
    `المبلغ: <b>${amountLocal}</b>`,
    `تمت الموافقة بواسطة: <b>${escapeHtml(approver)}</b>`
  ].join('\n');
  for (const adminId of getAdminIds()) {
    await bot.sendMessage(adminId, text, { parse_mode: 'HTML' }).catch(() => {});
  }
}

async function processSharedPaymentResults() {
  if (!network.isMaster() && !network.enabledClient()) return;
  const data = await network.sourceSharedPaymentResults();
  for (const request of data.requests || []) {
    try {
      if (request.activity === 'topup') {
        const txId = Number(request.sourceEntityId || String(request.sourceRef || '').split(':')[1]);
        const dbTx = await sequelize.transaction();
        let targetUser = null;
        let ledger = null;
        try {
          ledger = await BalanceTransaction.findByPk(txId, { transaction: dbTx, lock: dbTx.LOCK.UPDATE });
          if (ledger && ledger.status === 'proof_pending') {
            if (request.status === 'approved') {
              targetUser = await User.findByPk(ledger.userId, { transaction: dbTx, lock: dbTx.LOCK.UPDATE });
              targetUser.balance = Number(targetUser.balance || 0) + Number(ledger.amount || 0);
              await targetUser.save({ transaction: dbTx });
              ledger.status = 'completed';
            } else {
              ledger.status = 'rejected';
            }
            await ledger.save({ transaction: dbTx });
          }
          await dbTx.commit();
        } catch (error) {
          await dbTx.rollback();
          throw error;
        }
        if (ledger) {
          const userRow = targetUser || await User.findByPk(ledger.userId);
          if (request.status === 'approved' && userRow) {
            const moneyContext = await customerMoneyContext(userRow);
            const lang = userRow.lang === 'en' ? 'en' : 'ar';
            await bot.sendMessage(userRow.id, lang === 'en'
              ? `✅ Payment confirmed. Wallet credited ${customerMoney(ledger.amount, moneyContext, lang)}. New balance: ${customerMoney(userRow.balance, moneyContext, lang)}.`
              : `✅ تم تأكيد الدفعة وشحن محفظتك بمبلغ <b>${customerMoney(ledger.amount, moneyContext, lang)}</b>.\nالرصيد الجديد: <b>${customerMoney(userRow.balance, moneyContext, lang)}</b>.`, { parse_mode: 'HTML' }).catch(() => {});
            await notifySourceAdminsSharedApproval(request, userRow, 'تم شحن رصيد للمستخدم');
          } else if (request.status === 'rejected') {
            await bot.sendMessage(ledger.userId, '❌ صاحب طريقة الدفع لم يؤكد وصول المبلغ. إذا تعتقد أكو خطأ راجع الدعم.').catch(() => {});
          }
        }
      } else {
        const orderId = Number(request.sourceEntityId || String(request.sourceRef || '').split(':')[1]);
        const order = await PurchaseOrder.findByPk(orderId);
        if (order && order.status === 'proof_pending') {
          if (request.status === 'approved') {
            try {
              const fulfillment = await completeExternalPayment(order.id, `shared:${request.id}`);
              await sendDeliveryToUser(order.userId, fulfillment);
              const orderUser = await User.findByPk(order.userId);
              await notifySourceAdminsSharedApproval(request, orderUser, `تم تأكيد دفع الطلب #${order.id} للمستخدم`);
            } catch (error) {
              if (error.message === 'OUT_OF_STOCK') {
                order.status = 'paid_waiting_stock';
                await order.save({ fields: ['status'] });
                await bot.sendMessage(order.userId, '✅ تم تأكيد الدفع، لكن المخزون غير متوفر بهذه اللحظة. تم تسجيل حقك، لا تدفع مرة ثانية وراجع الدعم.').catch(() => {});
                await notifyAdmins(`⚠️ دفعة مشتركة مؤكدة للطلب <code>#${order.id}</code> لكن المخزون نفد. لازم متابعة الطلب يدوياً.`);
              } else throw error;
            }
          } else {
            await refundWalletReservation(order.id).catch(() => order.update({ status: 'rejected' }));
            await bot.sendMessage(order.userId, `❌ تم رفض تأكيد الدفع للطلب #${order.id}. تم إرجاع أي رصيد محجوز من المحفظة.`).catch(() => {});
          }
        }
      }
      await network.acknowledgeSharedPaymentRequest(request.id);
    } catch (error) {
      console.error(`Shared payment result ${request.id}:`, error.message);
    }
  }
}

async function processNetworkNotificationEvents() {
  if (!network.isMaster() && !network.enabledClient()) return;
  if (network.enabledClient()) await network.syncCatalogToLocal().catch(() => null);
  await notifyPendingNetworkProductReviews().catch(error => console.error('Pending product reviews:', error.message));
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

  if (network.enabledClient()) {
    await network.syncCatalogToLocal({ force: true }).catch(() => null);
    await notifyPendingNetworkProductReviews().catch(error => console.error('Pending product reviews after sync:', error.message));
  }

  for (const event of events) {
    const eventId = Number(event.id || 0);
    try {
      const product = event.networkProductId
        ? await Merchant.findOne({ where: { networkProductId: String(event.networkProductId) } })
        : null;
      if (product?.isActive) {
        const publicationStatus = String(product.localPublicationStatus || 'published').toLowerCase();
        if (event.eventType === 'new_product' && publicationStatus === 'pending' && isForeignPublicProduct(product)) {
          await notifyAdminsForNetworkProductReview(product, event.actorName || '');
        } else if (event.eventType === 'new_product' && productVisibleInCurrentShop(product)) {
          await broadcastNewProductNotification(product, event.actorName || '');
        } else if (event.eventType === 'stock_added' && Number(event.amount || 0) > 0 && productVisibleInCurrentShop(product)) {
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
      'اختَر Binance للتحقق التلقائي، أو التسديد اليدوي ثم أرسل صورة الدفع للطرف الدائن.'
    ].join('\n');
    for (const adminId of getAdminIds()) {
      await bot.sendMessage(adminId, text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [
          [{
            text: `💰 Binance — $${amount.toFixed(2)}`,
            callback_data: `adm:debt_paid:${counterpartyId}`,
            style: 'success'
          }],
          [{
            text: `🧾 يدوي وإرسال صورة — $${amount.toFixed(2)}`,
            callback_data: `adm:debt_manual:${counterpartyId}`,
            style: 'primary'
          }]
        ] }
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
      ? `⛔ <b>تم إيقاف البيع مؤقتاً</b>\nالالتزامات الحالية: <b>$${Number(status.liabilityUsd || 0).toFixed(2)}</b>\nحد الإيقاف: <b>$${Number(status.thresholdUsd || 40).toFixed(2)}</b>\n\nيبقى البيع متوقفاً إلى أن تُؤكد التسوية عبر Binance أو الدفع اليدوي.`
      : '✅ <b>تم فتح البيع تلقائياً</b> بعد تأكيد تسوية الدين. البوت رجع يشتغل بدون تدخل إضافي.';
    for (const adminId of getAdminIds()) await bot.sendMessage(adminId, text, { parse_mode: 'HTML' }).catch(() => {});
  }
}

async function processOwnedDebtBinanceVerifications() {
  if (!network.isMaster() && !network.enabledClient()) return;
  const data = await network.ownedDebtBinanceVerifications();
  for (const request of data.requests || []) {
    if (!request.submittedOrderId || request.status !== 'pending') continue;
    try {
      const result = await binancePay.verifyStandalone({
        submittedOrderId: request.submittedOrderId,
        expectedAmount: Number(request.amountUsd || 0),
        createdAt: request.createdAt
      });
      if (result.success) {
        const resolved = await network.finishDebtBinanceVerification(request.id, {
          success: true,
          transactionId: result.transactionId
        });
        const resolvedRequest = resolved?.request || resolved;
        if (resolvedRequest?.status === 'confirmed') {
          const text = [
            '✅ <b>تم استلام تسوية دين عبر Binance</b>',
            '',
            `من: <b>${escapeHtml(request.debtorName || request.debtorShopId)}</b>`,
            `المبلغ: <b>$${Number(request.amountUsd || 0).toFixed(2)}</b>`,
            `Order ID: <code>${escapeHtml(request.submittedOrderId)}</code>`,
            'تم التحقق تلقائياً.'
          ].join('\n');
          for (const adminId of getAdminIds()) await bot.sendMessage(adminId, text, { parse_mode: 'HTML' }).catch(() => {});
        } else if (resolvedRequest?.verificationError === 'DUPLICATE_TRANSACTION') {
          for (const adminId of getAdminIds()) {
            await bot.sendMessage(adminId, [
              '⚠️ <b>رفض Order ID مكرر</b>',
              `من: <b>${escapeHtml(request.debtorName || request.debtorShopId)}</b>`,
              `المبلغ: <b>$${Number(request.amountUsd || 0).toFixed(2)}</b>`,
              'رقم العملية مستخدم سابقاً، لذلك الدين لم يُغلق.'
            ].join('\n'), { parse_mode: 'HTML' }).catch(() => {});
          }
        }
      } else {
        await network.finishDebtBinanceVerification(request.id, {
          success: false,
          reason: result.reason || 'NO_MATCH'
        });
        if (result.reason === 'REGION_RESTRICTED') {
          for (const adminId of getAdminIds()) {
            await bot.sendMessage(adminId, [
              '⚠️ <b>تعذر التحقق التلقائي من تسوية Binance بسبب موقع السيرفر</b>',
              `المبلغ: <b>$${Number(request.amountUsd || 0).toFixed(2)}</b>`,
              `من: <b>${escapeHtml(request.debtorName || request.debtorShopId)}</b>`,
              'لا يتم إغلاق الدين. يمكن إعادة المحاولة بعد معالجة وصول Binance API.'
            ].join('\n'), { parse_mode: 'HTML' }).catch(() => {});
          }
        }
      }
      invalidateCommerceStatus();
    } catch (error) {
      console.error(`Debt Binance verification ${request.id}:`, error.message);
    }
  }
}

async function processDebtPaymentResults() {
  if (!network.isMaster() && !network.enabledClient()) return;
  const data = await network.debtPaymentResults();
  for (const request of data.requests || []) {
    try {
      if (request.status === 'confirmed') {
        const manual = String(request.paymentMethod || '') === 'manual';
        const text = [
          manual ? '✅ <b>أكد الطرف الدائن استلام التسديد اليدوي</b>' : '✅ <b>تم تسديد الدين تلقائياً عبر Binance</b>',
          '',
          `إلى: <b>${escapeHtml(request.creditorName || request.creditorShopId)}</b>`,
          `المبلغ: <b>$${Number(request.amountUsd || 0).toFixed(2)}</b>`,
          request.transactionId ? `رقم العملية: <code>${escapeHtml(request.transactionId)}</code>` : '',
          manual ? 'تم إغلاق مبلغ التسوية بعد موافقة الطرف المستلم.' : 'تم إغلاق مبلغ التسوية تلقائياً.'
        ].filter(Boolean).join('\n');
        for (const adminId of getAdminIds()) await bot.sendMessage(adminId, text, { parse_mode: 'HTML' }).catch(() => {});
      } else if (request.status === 'rejected') {
        const text = [
          '❌ <b>تم رفض إثبات التسديد اليدوي</b>',
          '',
          `الطرف: <b>${escapeHtml(request.creditorName || request.creditorShopId)}</b>`,
          `المبلغ: <b>$${Number(request.amountUsd || 0).toFixed(2)}</b>`,
          'أُعيد الدين إلى الحساب ويمكن إنشاء تسوية جديدة بعد التأكد من الدفع.'
        ].join('\n');
        for (const adminId of getAdminIds()) await bot.sendMessage(adminId, text, { parse_mode: 'HTML' }).catch(() => {});
      } else if (request.verificationError) {
        const text = [
          '❌ <b>لم تنجح محاولة تسوية Binance</b>',
          '',
          `إلى: <b>${escapeHtml(request.creditorName || request.creditorShopId)}</b>`,
          `المبلغ: <b>$${Number(request.amountUsd || 0).toFixed(2)}</b>`,
          `السبب: <code>${escapeHtml(request.verificationError)}</code>`,
          '',
          'الدين ما زال مفتوحاً. أرسل Order ID صحيح للمحاولة مرة ثانية.'
        ].join('\n');
        for (const adminId of getAdminIds()) {
          await bot.sendMessage(adminId, text, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{
              text: '🔁 إرسال Order ID جديد',
              callback_data: `adm:debt_retry:${request.id}`,
              style: 'primary'
            }]] }
          }).catch(() => {});
        }
      }
      await network.acknowledgeDebtPaymentResult(request.id);
      invalidateCommerceStatus();
    } catch (error) {
      console.error(`Debt payment result ${request.id}:`, error.message);
    }
  }
}

async function processIncomingDebtConfirmations(data) {
  const incoming = Array.isArray(data?.pendingIncoming) ? data.pendingIncoming : [];
  let seen = [];
  try { seen = JSON.parse(await getSetting('network_notified_debt_payment_ids', '[]')); } catch { seen = []; }
  const seenSet = new Set(Array.isArray(seen) ? seen.map(String) : []);
  let changed = false;
  for (const request of incoming) {
    if (request.binancePayId) continue; // v11.8 debt settlements are verified automatically through Binance.
    const isManualProof = String(request.paymentMethod || '') === 'manual';
    if (isManualProof && !request.manualProofBase64) continue;
    if (seenSet.has(String(request.id))) continue;
    const text = [
      isManualProof ? '🧾 <b>إثبات تسديد دين يدوي</b>' : '🤝 <b>طلب تأكيد تسديد دين</b>',
      '',
      `<b>${escapeHtml(request.debtorName || request.debtorShopId)}</b> سجّل أنه سدّد لك <b>$${Number(request.amountUsd || 0).toFixed(2)}</b>.`,
      `المبلغ المثبت: <b>${Number(request.values?.settlementAmount || request.settlementAmount || request.amountUsd || 0).toFixed((request.values?.settlementCurrency || request.settlementCurrency) === 'IQD' ? 0 : 2)} ${escapeHtml(request.values?.settlementCurrency || request.settlementCurrency || 'USD')}</b>`,
      isManualProof ? 'الصورة مرفقة أدناه. وافق فقط إذا المبلغ وصل فعلاً إلى حسابك.' : 'وافق فقط إذا المبلغ وصل فعلاً.'
    ].join('\n');
    let sent = 0;
    for (const adminId of getAdminIds()) {
      const options = {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[
          { text: '✅ وصل المبلغ', callback_data: `adm:debt_resolve:1:${request.id}`, style: 'success' },
          { text: '❌ رفض الإثبات', callback_data: `adm:debt_resolve:0:${request.id}`, style: 'danger' }
        ]] }
      };
      try {
        if (isManualProof) {
          const image = Buffer.from(String(request.manualProofBase64), 'base64');
          await bot.sendPhoto(adminId, image, { ...options, caption: text }, { filename: `debt-proof-${request.id}.jpg`, contentType: request.manualProofMime || 'image/jpeg' });
        } else {
          await bot.sendMessage(adminId, text, options);
        }
        sent += 1;
      } catch (error) {
        console.error(`Debt proof notify ${adminId}:`, error.message);
      }
    }
    if (sent > 0) {
      changed = true;
      seenSet.add(String(request.id));
    }
  }
  if (changed) await setSetting('network_notified_debt_payment_ids', JSON.stringify([...seenSet].slice(-300)));
}

function startNetworkAccountWatcher() {
  if (networkAccountWatcherStarted || (!network.isMaster() && !network.enabledClient())) return;
  networkAccountWatcherStarted = true;
  const poll = async () => {
    if (networkAccountWatcherRunning) return;
    networkAccountWatcherRunning = true;
    try {
      if (network.enabledClient()) {
        await network.bootstrapCatalogToLocal().catch(error => {
          console.error('Shared catalog watcher sync:', error.message);
        });
      }
      await syncNetworkPremiumEmojiMappings({ repairProducts: true }).catch(error => {
        console.error('Shared Premium emoji watcher sync:', error.message);
      });
      await syncLocalSharedPaymentMethods();
      await network.syncPublicPaymentProfile().catch(error => console.error('Payment profile sync:', error.message));
      await processOwnedSharedPaymentRequests();
      await processSharedPaymentResults();
      await processOwnedDebtBinanceVerifications();
      await processDebtPaymentResults();
      await processNetworkNotificationEvents();
      const data = await fetchLocalNetworkAccountData();
      await processIncomingDebtConfirmations(data);
      await processDebtRemindersAndStatus(data);
    } catch (error) {
      console.error('Network watcher:', error.message);
    } finally {
      networkAccountWatcherRunning = false;
    }
  };
  poll().catch(error => console.error('Initial network watcher:', error.message));
  setInterval(poll, 30000).unref?.();
}

let virtualNumbersWatcherStarted = false;
let virtualNumbersWatcherRunning = false;

function startVirtualNumbersWatcher() {
  if (virtualNumbersWatcherStarted || !virtualNumbers.enabled()) return;
  virtualNumbersWatcherStarted = true;
  const poll = async () => {
    if (virtualNumbersWatcherRunning) return;
    virtualNumbersWatcherRunning = true;
    try {
      await virtualNumbers.syncAccountingBacklog().catch(error => {
        console.error('Virtual number accounting backlog:', error.message);
      });
      const events = await virtualNumbers.pollPendingOrders();
      for (const event of events) {
        const order = event.order;
        const customer = await User.findByPk(order.userId).catch(() => null);
        const lang = customer?.lang === 'en' ? 'en' : 'ar';
        if (event.type === 'sms') {
          await bot.sendMessage(order.userId, lang === 'en'
            ? [
                '📩 <b>SMS code received</b>',
                `📲 ${premiumLabelHtml(order.serviceName)}`,
                `📞 <code>${escapeHtml(order.phoneNumber || '')}</code>`,
                `🔑 Code: <code>${escapeHtml(event.code || '')}</code>`,
                `🆔 Order: <code>#${order.id}</code>`
              ].join('\n')
            : [
                '📩 <b>وصل كود SMS</b>',
                `📲 ${premiumLabelHtml(order.serviceName)}`,
                `📞 <code>${escapeHtml(order.phoneNumber || '')}</code>`,
                `🔑 الكود: <code>${escapeHtml(event.code || '')}</code>`,
                `🆔 الطلب: <code>#${order.id}</code>`
              ].join('\n'), { parse_mode: 'HTML' }).catch(() => {});
        }
        if (event.type === 'expired_refund') {
          await bot.sendMessage(order.userId, lang === 'en'
            ? `⏱ No SMS code arrived within ${virtualNumbers.ACTIVATION_TIMEOUT_MINUTES} minutes. Number order #${order.id} was cancelled automatically and ${virtualRetailPriceText(event.refunded || 0)} was returned to your wallet.`
            : `⏱ ما وصل كود خلال ${virtualNumbers.ACTIVATION_TIMEOUT_MINUTES} دقائق. تم إلغاء طلب الرقم #${order.id} تلقائياً وإرجاع ${virtualRetailPriceText(event.refunded || 0)} إلى محفظتك.`).catch(() => {});
        }
        if (event.type === 'provider_cancelled') {
          await bot.sendMessage(order.userId, lang === 'en'
            ? `↩️ Virtual-number order #${order.id} was cancelled by the provider and ${virtualRetailPriceText(event.refunded || 0)} was returned to your wallet.`
            : `↩️ تم إلغاء طلب الرقم #${order.id} من المزود وإرجاع ${virtualRetailPriceText(event.refunded || 0)} إلى محفظتك.`).catch(() => {});
        }
      }
    } catch (error) {
      console.error('Virtual numbers watcher:', error.code || error.message, error.detail || '');
    } finally {
      virtualNumbersWatcherRunning = false;
    }
  };
  poll().catch(error => console.error('Initial virtual numbers watcher:', error.message));
  setInterval(poll, config.virtualNumbers.pollIntervalMs).unref?.();
}

bot.on('polling_error', error => console.error('Telegram polling error:', error.message));

module.exports = { bot, notifyBinanceResult, sendDeliveryToUser, startNetworkAccountWatcher, startVirtualNumbersWatcher, loadPersistentRuntimeConfig };
