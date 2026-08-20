const crypto = require('crypto');
const { getSetting, setSetting } = require('../db');

const STORAGE_KEY = 'premium_emoji_keyword_map_v1';
const MAX_CUSTOM_ENTRIES = 120;

// Telegram Premium Custom Emoji IDs supplied by the store owner. Aliases are
// deliberately bilingual so one mapping works in Arabic and English screens.
// Keep these defaults additive: owner-created mappings are stored separately
// in Setting and always take precedence over this list.
const BUILT_INS = [
  { key: 'iraq', id: '5221980268230882832', alt: '🇮🇶', aliases: ['العراق', 'عراقي', 'iraq', 'iraqi'] },
  { key: 'binance', id: '5875443023873053217', alt: '🟡', aliases: ['بايننس', 'بينانس', 'binance'] },
  { key: 'superqi', id: '5184203496831846429', alt: '🔵', aliases: ['سوبركي', 'سوبر كي', 'superqi', 'super qi'] },
  { key: 'google_one', id: '5796314805564346672', alt: '☁️', aliases: ['جوجل وان', 'قوقل وان', 'google one', 'google 1'] },
  { key: 'youtube_premium', id: '5873070917730439903', alt: '▶️', aliases: ['يوتيوب بريميوم', 'youtube premium'] },
  { key: 'canva', id: '5796637619601283518', alt: '🎨', aliases: ['كانفا', 'كنفا', 'انفا', 'canva'] },
  { key: 'capcut', id: '5364339557712020484', alt: '✂️', aliases: ['كاب كات', 'كابكات', 'كاب كت', 'capcut', 'cap cut'] },
  { key: 'verified', id: '5436335853976692415', alt: '✅', aliases: ['علامة التوثيق', 'موثق', 'موثقة', 'verified', 'verification badge'] },
  { key: 'error', id: '5271934564699226262', alt: '❌', aliases: ['❌', 'خطأ', 'فشل', 'error', 'failed', 'invalid'] },
  { key: 'success', id: '5273806972871787310', alt: '✅', aliases: ['✅', 'علامة الصح', 'صحيح', 'نجاح', 'تم بنجاح', 'success', 'correct'] },
  { key: 'youtube', id: '5805401092346875873', alt: '▶️', aliases: ['يوتيوب', 'youtube'] },
  { key: 'instagram', id: '6274016787805775396', alt: '📷', aliases: ['انستغرام', 'إنستغرام', 'انستا', 'instagram'] },
  { key: 'netflix', id: '6276168506291527077', alt: '🎬', aliases: ['نتفلكس', 'نيتفلكس', 'نت فلكس', 'netflix'] },
  { key: 'duolingo', id: '6274059063168869584', alt: '🦉', aliases: ['دولنجو', 'دولينجو', 'duolingo'] },
  { key: 'adobe', id: '6274021404895620321', alt: '🎨', aliases: ['ادوبي', 'أدوبي', 'adobe'] },
  { key: 'chrome', id: '6276153753078865622', alt: '🌐', aliases: ['جوجل كروم', 'قوقل كروم', 'كروم', 'google chrome', 'chrome'] },
  { key: 'google', id: '6276229331618372151', alt: '🌐', aliases: ['جوجل', 'قوقل', 'google'] },
  // No separate Gemini ID was supplied. Gemini is a Google service, so all
  // common Arabic spellings use the supplied Google Custom Emoji ID.
  { key: 'gemini', id: '6276229331618372151', alt: '✨', aliases: ['جمني', 'جيميني', 'جمناي', 'جيمناي', 'جيميناي', 'gemini', 'google gemini'] },
  { key: 'gmail', id: '6273588910278844363', alt: '📧', aliases: ['جيميل جوجل', 'جيميل', 'بريد جوجل', 'gmail', 'google mail'] },
  { key: 'chatgpt', id: '6276304880093109177', alt: '🤖', aliases: ['شات جي بي تي', 'شات جي بي تى', 'chatgpt', 'chat gpt', 'openai'] },
  { key: 'tiktok', id: '6273825678940970726', alt: '🎵', aliases: ['تيك توك', 'تيكتوك', 'tiktok', 'tik tok'] },
  { key: 'authenticator', id: '6273712905984679845', alt: '🔐', aliases: ['المصدقة الثنائية', 'المصادقة الثنائية', 'التحقق بخطوتين', 'توثيق ثنائي', '2fa', 'authenticator', 'two factor'] },
  { key: 'spotify', id: '6276001354754302528', alt: '🎵', aliases: ['سبوتي فاي', 'سبوتيفاي', 'spotify'] },
  { key: 'telegram', id: '6273877888563421002', alt: '✈️', aliases: ['تيليجرام', 'تلغرام', 'تليجرام', 'telegram'] },
  { key: 'facebook', id: '6273966236040699752', alt: '👤', aliases: ['فيسبوك', 'فيس بوك', 'facebook'] },
  { key: 'paypal', id: '6276017886083423354', alt: '💳', aliases: ['باي بال', 'بايبال', 'paypal', 'pay pal'] },
  { key: 'api', id: '5881713916643382055', alt: '🔑', aliases: ['واجهة برمجة التطبيقات', 'مفتاح api', 'api key', 'api'] },
  { key: 'x', id: '5875114677918240630', alt: '✖️', aliases: ['تويتر سابقا', 'تويتر', 'twitter', 'x.com'] },
  // This is intentionally the same ID supplied by the owner for X and WhatsApp.
  { key: 'whatsapp', id: '5875114677918240630', alt: '💬', aliases: ['واتساب', 'واتس اب', 'whatsapp', 'whats app'] },
  { key: 'search', id: '5874960879434338403', alt: '🔎', aliases: ['بحث عن', 'البحث', 'بحث', 'search', 'find', '🔎', '🔍'] },
  { key: 'delete', id: '5841541824803509441', alt: '🗑️', aliases: ['حذف', 'قمامة', 'مسح', 'delete', 'remove', 'trash', '🗑️', '🗑'] },
  { key: 'edit', id: '5879841310902324730', alt: '✏️', aliases: ['تعديل', 'تغيير', 'edit', 'change', '✏️', '✏'] },
  { key: 'pin', id: '5796440171364749940', alt: '📌', aliases: ['تثبيت', 'مثبت', 'pin', 'pinned', '📌'] },
  { key: 'lock', id: '5879895758202735862', alt: '🔒', aliases: ['قفل', 'مغلق', 'lock', 'locked', '🔒'] },
  { key: 'phone', id: '5897488197650223178', alt: '📱', aliases: ['الأرقام الافتراضية', 'الارقام الافتراضية', 'رقم افتراضي', 'شراء رقم', 'اتصال', 'virtual numbers', 'virtual number', 'phone number', '📱'] },
  { key: 'notifications_on', id: '5909201569898827582', alt: '🔔', aliases: ['تفعيل الجرس', 'تشغيل الإشعارات', 'تشغيل الاشعارات', 'notifications on', 'enable notifications', '🔔'] },
  { key: 'notifications_off', id: '5909123362839335003', alt: '🔕', aliases: ['تعطيل الجرس', 'إيقاف الإشعارات', 'ايقاف الاشعارات', 'notifications off', 'disable notifications', '🔕'] },
  { key: 'digit_1', id: '5794182096603847292', alt: '1️⃣', aliases: ['1️⃣', '1'] },
  { key: 'digit_2', id: '5794303034292968945', alt: '2️⃣', aliases: ['2️⃣', '2'] },
  { key: 'digit_3', id: '5794031944547178894', alt: '3️⃣', aliases: ['3️⃣', '3'] },
  { key: 'digit_4', id: '5793901252987330401', alt: '4️⃣', aliases: ['4️⃣', '4'] },
  { key: 'digit_5', id: '5794066823976592976', alt: '5️⃣', aliases: ['5️⃣', '5'] },
  { key: 'digit_6', id: '5794235255414069703', alt: '6️⃣', aliases: ['6️⃣', '6'] },
  { key: 'digit_7', id: '5794030595927448202', alt: '7️⃣', aliases: ['7️⃣', '7'] },
  { key: 'digit_8', id: '5794426162415409242', alt: '8️⃣', aliases: ['8️⃣', '8'] },
  { key: 'digit_9', id: '5793905801357695657', alt: '9️⃣', aliases: ['9️⃣', '9'] },
  { key: 'english', id: '5224518800061245598', alt: '🇬🇧', aliases: ['اللغة الانجليزية', 'الإنجليزية', 'انجليزي', 'english language', 'english'] },
  { key: 'arabic', id: '5222041677673282461', alt: '🇸🇦', aliases: ['اللغة العربية', 'العربية', 'عربي', 'arabic language', 'arabic'] },
  { key: 'hours24', id: '5433933799027128806', alt: '🕐', aliases: ['24 ساعة', '24 ساعه', 'خلال يوم', '24 hours', '24h'] },
  { key: 'loading', id: '5434074875817898163', alt: '⏳', aliases: ['جاري التحميل', 'جاري تحميل', 'جاري الانتظار', 'loading', 'please wait', '⏳'] },
  { key: 'play_store', id: '5775925350269719113', alt: '🎮', aliases: ['متجر بلي', 'متجر بلاي', 'جوجل بلاي', 'google play', 'play store'] },
  { key: 'settings', id: '5801152386143620268', alt: '⚙️', aliases: ['الإعدادات', 'الاعدادات', 'إعدادات', 'اعدادات', 'settings', 'setting', '⚙️', '⚙'] },
  { key: 'language', id: '5798420477705719523', alt: '🌐', aliases: ['اللغة', 'تغيير اللغة', 'language', 'change language', '🌐'] },
  { key: 'purchased', id: '5796205953913196373', alt: '✅', aliases: ['تم الشراء', 'تمت العملية بنجاح', 'تمت عملية الشراء', 'purchase complete', 'purchased successfully'] },
  { key: 'save', id: '5366201992970518798', alt: '💾', aliases: ['حفظ', 'تم الحفظ', 'save', 'saved', '💾'] },

  // Existing bot-wide icons are retained so the restoration does not regress
  // menus that already used them before the owner's new dictionary arrived.
  { key: 'support', id: '5882260605850620296', alt: '💬', aliases: ['الدعم', 'مساعدة', 'support', 'help'] },
  { key: 'wallet', id: '6325416826100519483', alt: '👛', aliases: ['المحفظة', 'محفظتك', 'wallet', 'balance'] },
  { key: 'orders', id: '5882175861850903857', alt: '📦', aliases: ['طلباتي', 'الطلبات', 'orders', 'my orders'] },
  { key: 'products', id: '5800639128961814362', alt: '🛍️', aliases: ['المنتجات', 'منتج جديد', 'إضافة منتج', 'اضافة منتج', 'products', 'product'] }
];

// Brand/service mappings supplied by the owner are authoritative. A stale or
// accidentally-created custom mapping must not turn Canva into YouTube, or
// CapCut/Netflix into the phone icon. Custom mappings still win for names that
// are not part of this canonical platform dictionary.
const CANONICAL_PLATFORM_KEYS = new Set([
  'binance', 'superqi', 'google_one', 'youtube_premium', 'canva', 'capcut',
  'youtube', 'instagram', 'netflix', 'duolingo', 'adobe', 'chrome', 'google',
  'gemini', 'gmail', 'chatgpt', 'tiktok', 'authenticator', 'spotify',
  'telegram', 'facebook', 'paypal', 'x', 'whatsapp', 'play_store'
]);
const LEGACY_UI_KEYS = new Set(['support', 'wallet', 'orders', 'products']);
const OWNER_SUPPLIED_KEYS = new Set(BUILT_INS.map(entry => entry.key).filter(key => !LEGACY_UI_KEYS.has(key)));

const builtInOverrides = new Map();
let customEntries = [];
let loaded = false;

function normalizeKeyword(value) {
  return String(value || '')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function validEmojiId(value) {
  return /^\d{5,24}$/.test(String(value || '').trim());
}

function cleanEntry(entry, source = 'custom') {
  const keywordAr = String(entry?.keywordAr || '').trim().slice(0, 80);
  const keywordEn = String(entry?.keywordEn || '').trim().slice(0, 80);
  const emojiId = String(entry?.emojiId || entry?.id || '').trim();
  if (!keywordAr || !validEmojiId(emojiId)) return null;
  return {
    id: String(entry?.entryId || entry?.customId || entry?.rowId || '').trim() || crypto.randomBytes(6).toString('hex'),
    key: String(entry?.key || '').trim() || `custom_${crypto.randomBytes(4).toString('hex')}`,
    keywordAr,
    keywordEn,
    emojiId,
    alt: String(entry?.alt || '✨').slice(0, 16) || '✨',
    aliases: [...new Set([keywordAr, keywordEn, ...(Array.isArray(entry?.aliases) ? entry.aliases : [])].map(value => String(value || '').trim()).filter(Boolean))],
    source
  };
}

async function load() {
  let parsed = [];
  try {
    const raw = await getSetting(STORAGE_KEY, '[]');
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error('Premium emoji mapping load:', error.message);
  }
  customEntries = (Array.isArray(parsed) ? parsed : [])
    .map(entry => cleanEntry(entry, 'custom'))
    .filter(Boolean)
    .slice(0, MAX_CUSTOM_ENTRIES);
  loaded = true;
  return customEntries.length;
}

function builtInEntry(entry) {
  const override = builtInOverrides.get(entry.key);
  return {
    ...entry,
    emojiId: validEmojiId(override) ? override : entry.id,
    source: 'built-in'
  };
}

function allEntries() {
  return [
    ...customEntries.map(entry => ({ ...entry })),
    ...BUILT_INS.map(builtInEntry)
  ];
}

function rawAliasMatch(raw, alias) {
  const needle = String(alias || '').trim();
  if (!needle) return false;
  if (/^[\p{L}\p{N}\s._-]+$/u.test(needle)) return false;
  return raw.includes(needle);
}

function normalizedAliasMatch(normalizedText, alias) {
  const normalizedAlias = normalizeKeyword(alias);
  if (!normalizedAlias) return false;
  // A bare digit must be a complete token. This avoids assigning the “1” icon
  // to prices, order numbers, pagination, or IDs that merely contain 1.
  if (/^\d$/.test(normalizedAlias)) {
    return (` ${normalizedText} `).includes(` ${normalizedAlias} `) && normalizedText === normalizedAlias;
  }
  return (` ${normalizedText} `).includes(` ${normalizedAlias} `);
}

function resolve(value) {
  const raw = String(value || '').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim();
  if (!raw) return null;
  const normalized = normalizeKeyword(raw);
  const candidates = [];
  const actionKeys = new Set(['error', 'success', 'search', 'delete', 'edit', 'pin', 'lock', 'notifications_on', 'notifications_off', 'settings', 'save']);
  const genericKeys = new Set(['support', 'wallet', 'orders', 'products']);
  for (const entry of allEntries()) {
    if (!validEmojiId(entry.emojiId)) continue;
    for (const alias of entry.aliases || []) {
      const rawMatched = rawAliasMatch(raw, alias);
      const normalizedMatched = normalizedAliasMatch(normalized, alias);
      const matched = rawMatched || normalizedMatched;
      if (!matched) continue;
      const normalizedAlias = normalizeKeyword(alias);
      const aliasLength = normalizedAlias.length || String(alias).length;
      const exact = normalizedAlias && normalized === normalizedAlias;
      const actionAtEdge = normalizedAlias && actionKeys.has(entry.key) && (
        normalized === normalizedAlias || normalized.startsWith(`${normalizedAlias} `) || normalized.endsWith(` ${normalizedAlias}`)
      );
      const score =
        (entry.source === 'built-in' && OWNER_SUPPLIED_KEYS.has(entry.key) ? 20000 : 0) +
        (entry.source === 'custom' ? 10000 : 0) +
        (rawMatched ? 5000 : 0) +
        (exact ? 2000 : 0) +
        (actionAtEdge ? 1000 : 0) -
        (genericKeys.has(entry.key) ? 100 : 0) +
        aliasLength;
      candidates.push({ entry, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  if (!candidates.length) return null;
  const winner = candidates[0].entry;
  const inferredArabic = winner.keywordAr || (winner.aliases || []).find(alias => /[\u0600-\u06FF]/.test(String(alias))) || '';
  const inferredEnglish = winner.keywordEn || (winner.aliases || []).find(alias => /[A-Za-z]/.test(String(alias))) || '';
  return {
    key: winner.key,
    id: String(winner.emojiId),
    emojiId: String(winner.emojiId),
    alt: winner.alt || '✨',
    source: winner.source,
    keywordAr: inferredArabic,
    keywordEn: inferredEnglish
  };
}

function getByKey(key) {
  const wanted = String(key || '').trim();
  const custom = customEntries.find(entry => entry.key === wanted);
  if (custom) return { id: custom.emojiId, alt: custom.alt, key: custom.key };
  const entry = BUILT_INS.find(row => row.key === wanted);
  if (!entry) return null;
  const resolved = builtInEntry(entry);
  return { id: resolved.emojiId, alt: resolved.alt, key: resolved.key };
}

function setBuiltInOverride(key, emojiId) {
  const normalizedKey = String(key || '').trim();
  if (!BUILT_INS.some(entry => entry.key === normalizedKey)) return false;
  // IDs explicitly supplied by the owner are canonical. Do not let a stale
  // Setting row silently replace them. Only the four pre-existing UI icons
  // retain backwards-compatible database overrides.
  if (OWNER_SUPPLIED_KEYS.has(normalizedKey)) {
    builtInOverrides.delete(normalizedKey);
    return false;
  }
  if (validEmojiId(emojiId)) builtInOverrides.set(normalizedKey, String(emojiId));
  else builtInOverrides.delete(normalizedKey);
  return true;
}

function listCustom() {
  return customEntries.map(entry => ({ ...entry, aliases: [...entry.aliases] }));
}

async function persistCustom() {
  await setSetting(STORAGE_KEY, JSON.stringify(customEntries.map(entry => ({
    entryId: entry.id,
    key: entry.key,
    keywordAr: entry.keywordAr,
    keywordEn: entry.keywordEn,
    emojiId: entry.emojiId,
    alt: entry.alt,
    aliases: entry.aliases
  }))));
}

async function upsertCustom({ keywordAr, keywordEn, emojiId, alt = '✨' }) {
  const candidate = cleanEntry({ keywordAr, keywordEn, emojiId, alt }, 'custom');
  if (!candidate) {
    const error = new Error('INVALID_PREMIUM_EMOJI_MAPPING');
    error.code = 'INVALID_PREMIUM_EMOJI_MAPPING';
    throw error;
  }
  const canonical = resolve(`${candidate.keywordAr} ${candidate.keywordEn}`);
  if (canonical?.source === 'built-in' && OWNER_SUPPLIED_KEYS.has(canonical.key) && canonical.id !== candidate.emojiId) {
    const error = new Error('PROTECTED_PREMIUM_EMOJI_MAPPING');
    error.code = 'PROTECTED_PREMIUM_EMOJI_MAPPING';
    error.canonical = canonical;
    throw error;
  }
  const normalizedAr = normalizeKeyword(candidate.keywordAr);
  const index = customEntries.findIndex(entry => normalizeKeyword(entry.keywordAr) === normalizedAr);
  if (index >= 0) {
    candidate.id = customEntries[index].id;
    candidate.key = customEntries[index].key;
    customEntries[index] = candidate;
  } else {
    if (customEntries.length >= MAX_CUSTOM_ENTRIES) {
      const error = new Error('PREMIUM_EMOJI_LIMIT');
      error.code = 'PREMIUM_EMOJI_LIMIT';
      throw error;
    }
    customEntries.push(candidate);
  }
  await persistCustom();
  return { ...candidate };
}

async function removeCustom(entryId) {
  const wanted = String(entryId || '').trim();
  const before = customEntries.length;
  customEntries = customEntries.filter(entry => entry.id !== wanted);
  if (customEntries.length === before) return false;
  await persistCustom();
  return true;
}

module.exports = {
  STORAGE_KEY,
  load,
  loaded: () => loaded,
  normalizeKeyword,
  validEmojiId,
  resolve,
  getByKey,
  setBuiltInOverride,
  listCustom,
  upsertCustom,
  removeCustom,
  isCanonicalPlatformKey: key => CANONICAL_PLATFORM_KEYS.has(String(key || '')),
  isOwnerSuppliedKey: key => OWNER_SUPPLIED_KEYS.has(String(key || '')),
  builtInCount: () => BUILT_INS.length
};
