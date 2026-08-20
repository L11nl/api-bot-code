const crypto = require('crypto');
const { getSetting, setSetting } = require('../db');

const STORAGE_KEY = 'premium_emoji_keyword_map_v1';
const MAX_CUSTOM_ENTRIES = 120;

// Telegram Premium Custom Emoji IDs supplied by the store owner. Aliases are
// deliberately bilingual so one mapping works in Arabic and English screens.
// Keep these defaults additive: owner-created mappings are stored separately.
// A newly confirmed mapping may override the same service, while unmarked
// mappings written by older releases cannot replace a canonical platform.
const BUILT_INS = [
  { key: 'iraq', id: '5221980268230882832', alt: '🇮🇶', aliases: ['العراق', 'عراقي', 'iraq', 'iraqi'] },
  { key: 'binance', id: '5875443023873053217', alt: '🟡', aliases: ['بايننس', 'بينانس', 'binance'] },
  { key: 'superqi', id: '5184203496831846429', alt: '🔵', aliases: ['سوبركي', 'سوبر كي', 'superqi', 'super qi'] },
  { key: 'google_one', id: '5796314805564346672', alt: '☁️', aliases: ['جوجل وان', 'قوقل وان', 'google one', 'google 1'] },
  { key: 'youtube_premium', id: '5873070917730439903', alt: '▶️', aliases: ['يوتيوب بريميوم', 'youtube premium'] },
  { key: 'canva', id: '6275971058054995473', alt: '🎨', aliases: ['كانفا', 'كنفا', 'انفا', 'canva'] },
  { key: 'capcut', id: '5364339557712020484', alt: '✂️', aliases: ['كاب كات', 'كابكات', 'كاب كت', 'capcut', 'cap cut'] },
  { key: 'verified', id: '5436335853976692415', alt: '✅', aliases: ['علامة التوثيق', 'موثق', 'موثقة', 'verified', 'verification badge'] },
  { key: 'error', id: '5271934564699226262', alt: '❌', aliases: ['❌', 'خطأ', 'فشل', 'error', 'failed', 'invalid'] },
  { key: 'success', id: '5273806972871787310', alt: '✅', aliases: ['✅', 'علامة الصح', 'صحيح', 'نجاح', 'تم بنجاح', 'تفعيل', 'موافقة', 'تنفيذ خدمة', 'success', 'correct', 'enable', 'approve'] },
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
  { key: 'telegram', id: '6273877888563421002', alt: '✈️', aliases: ['تيليجرام', 'تلغرام', 'تليجرام', 'قناتنا', 'القناة', 'فتح القناة', 'الانضمام للقناة', 'القناة الإجبارية', 'قناة تيليجرام', 'telegram', 'our channel', 'channel', 'open channel', 'join channel', 'telegram channel'] },
  { key: 'facebook', id: '6273966236040699752', alt: '👤', aliases: ['فيسبوك', 'فيس بوك', 'facebook'] },
  { key: 'paypal', id: '6276017886083423354', alt: '💳', aliases: ['باي بال', 'بايبال', 'paypal', 'pay pal'] },
  { key: 'api', id: '5881713916643382055', alt: '🔑', aliases: ['واجهة برمجة التطبيقات', 'مفتاح api', 'api key', 'api'] },
  { key: 'x', id: '5794261081052418411', alt: '✖️', aliases: ['تويتر سابقا', 'تويتر', 'twitter', 'x.com'] },
  // The owner intentionally supplied one ID for both X/Twitter and WhatsApp.
  { key: 'whatsapp', id: '5794261081052418411', alt: '💬', aliases: ['واتساب', 'واتس اب', 'whatsapp', 'whats app'] },
  { key: 'search', id: '5874960879434338403', alt: '🔎', aliases: ['بحث عن', 'البحث', 'بحث', 'search', 'find', '🔎', '🔍'] },
  { key: 'delete', id: '5841541824803509441', alt: '🗑️', aliases: ['حذف', 'قمامة', 'مسح', 'delete', 'remove', 'trash', '🗑️', '🗑'] },
  { key: 'edit', id: '5879841310902324730', alt: '✏️', aliases: ['تعديل', 'تغيير', 'رد', 'الوصف', 'نص', 'كتابة', 'edit', 'change', 'reply', 'description', 'text', 'write', '✏️', '✏'] },
  { key: 'pin', id: '5796440171364749940', alt: '📌', aliases: ['تثبيت', 'مثبت', 'pin', 'pinned', '📌'] },
  { key: 'lock', id: '5879895758202735862', alt: '🔒', aliases: ['قفل', 'مغلق', 'الضمان', 'ضمان', 'lock', 'locked', 'warranty', 'guarantee', '🔒'] },
  { key: 'phone', id: '6325330308279308485', alt: '📱', aliases: ['هاتف', 'الهاتف', 'الأرقام الافتراضية', 'الارقام الافتراضية', 'رقم افتراضي', 'شراء رقم', 'اتصال', 'phone', 'telephone', 'virtual numbers', 'virtual number', 'phone number', '📱'] },
  { key: 'notifications_on', id: '5909201569898827582', alt: '🔔', aliases: ['تفعيل الجرس', 'تشغيل الإشعارات', 'تشغيل الاشعارات', 'الإشعارات', 'الاشعارات', 'إعلان', 'اعلان', 'notifications on', 'enable notifications', 'notifications', 'announcement', '🔔'] },
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
  { key: 'loading', id: '5434074875817898163', alt: '⏳', aliases: ['جاري التحميل', 'جاري تحميل', 'جاري الانتظار', 'تحديث', 'إعادة تحميل', 'اعادة تحميل', 'loading', 'please wait', 'refresh', 'update', 'reload', '⏳'] },
  { key: 'play_store', id: '5775925350269719113', alt: '🎮', aliases: ['متجر بلي', 'متجر بلاي', 'جوجل بلاي', 'google play', 'play store'] },
  { key: 'settings', id: '5801152386143620268', alt: '⚙️', aliases: ['الإعدادات', 'الاعدادات', 'إعدادات', 'اعدادات', 'لوحة الإدارة', 'لوحة الادارة', 'إدارة البوت', 'ادارة البوت', 'settings', 'setting', 'admin panel', '⚙️', '⚙'] },
  { key: 'language', id: '5798420477705719523', alt: '🌐', aliases: ['اللغة', 'تغيير اللغة', 'language', 'change language', '🌐'] },
  { key: 'purchased', id: '5796205953913196373', alt: '✅', aliases: ['تم الشراء', 'تمت العملية بنجاح', 'تمت عملية الشراء', 'شراء', 'اشتري', 'purchase complete', 'purchased successfully', 'purchase', 'buy'] },
  { key: 'trending', id: '5999246912174166759', alt: '🔥', aliases: ['نار', 'النار', 'رائج', 'الرائج', 'ترند', 'شائع', 'الأكثر طلبا', 'الاكثر طلبا', 'fire', 'trending', 'hot', 'popular', '🔥'] },
  { key: 'save', id: '5366201992970518798', alt: '💾', aliases: ['حفظ', 'احفظ', 'تم الحفظ', 'حفظ لاحقا', 'تذكره لاحقا', 'علامة الحفظ', 'save', 'saved', 'save for later', 'bookmark', '💾'] },
  { key: 'copy', id: '5877301185639091664', alt: '📋', aliases: ['نسخ', 'نسخ النص', 'نسخ نص', 'انسخ', 'copy', 'copy text', 'clipboard', '📋'] },
  { key: 'key', id: '6005570495603282482', alt: '🔑', aliases: ['مفتاح', 'المفتاح', 'كلمة مفتاح', 'key', 'secret key', '🔑'] },
  { key: 'add_message', id: '5883973610606956186', alt: '💬', aliases: ['إضافة رسالة', 'اضافة رسالة', 'رسالة جديدة', 'أضف رسالة', 'اضف رسالة', 'add message', 'new message'] },
  { key: 'image', id: '5775949822993371030', alt: '🖼️', aliases: ['صورة', 'الصورة', 'صور', 'إضافة صورة', 'اضافة صورة', 'ارسل صورة', 'أرسل صورة', 'image', 'photo', 'picture', '🖼️', '🖼'] },
  { key: 'live_support', id: '5908808657700655253', alt: '🧑‍💼', aliases: ['الدعم الحي', 'الدعم المباشر', 'موظف الدعم', 'دعم حقيقي', 'موظف حقيقي', 'live support', 'human support', 'support agent'] },
  { key: 'fix', id: '5988023995125993550', alt: '🔧', aliases: ['إصلاح', 'اصلاح', 'تصليح', 'إصلاح برمجي', 'اصلاح برمجي', 'صيانة', 'fix', 'repair', 'maintenance', 'wrench', '🔧'] },
  { key: 'close_live_support', id: '5886496611835581345', alt: '🚫', aliases: ['إغلاق الدعم الحي', 'اغلاق الدعم الحي', 'إنهاء الدعم', 'انهاء الدعم', 'إغلاق الدردشة', 'اغلاق الدردشة', 'close live support', 'close support', 'end chat'] },
  { key: 'hashtag', id: '5951584964305755220', alt: '#️⃣', aliases: ['هاشتاق', 'هاشتاغ', 'وسم', 'hashtag', '#'] },
  { key: 'laptop', id: '6325569336094232734', alt: '💻', aliases: ['لابتوب', 'حاسوب محمول', 'كمبيوتر', 'حاسوب', 'laptop', 'computer', 'pc', '💻'] },
  { key: 'free_gift', id: '6325864460477010488', alt: '🎁', aliases: ['هدية مجانية', 'الهدية المجانية', 'مجانا', 'مجاناً', 'free gift', 'freebie'] },
  { key: 'add', id: '6325454162251223334', alt: '➕', aliases: ['إضافة منتج', 'اضافة منتج', 'إضافة خدمة', 'اضافة خدمة', 'إضافة شيء', 'اضافة شيء', 'أضف', 'اضف', 'add product', 'add service', 'add item', 'create product', '➕'] },
  { key: 'qr', id: '5987917196469213507', alt: '🔳', aliases: ['كيو ار', 'كيو آر', 'باركود', 'رمز qr', 'مسح الرمز', 'qr', 'qr code', 'barcode'] },
  { key: 'fingerprint', id: '5886505193180239900', alt: '🫆', aliases: ['بصمة', 'بصمة اصبع', 'بصمة إصبع', 'fingerprint', 'touch id'] },
  { key: 'plus', id: '5775937998948404844', alt: '+', aliases: ['علامة الجمع', 'زائد', 'plus', '+'] },
  { key: 'minus', id: '5877413297170419326', alt: '−', aliases: ['علامة الطرح', 'ناقص', 'minus', '−', '-'] },
  { key: 'multiply', id: '5778527486270770928', alt: '×', aliases: ['علامة الضرب', 'ضرب', 'multiply', 'times', '×'] },
  { key: 'direction_right', id: '5875506366050734240', alt: '👉🏼', aliases: ['اتجاه يمين', 'إلى اليمين', 'الى اليمين', 'right direction', 'point right', '👉🏼', '👉'] },
  { key: 'direction_left', id: '5877536313623711363', alt: '👈🏼', aliases: ['اتجاه يسار', 'إلى اليسار', 'الى اليسار', 'left direction', 'point left', '👈🏼', '👈'] },
  { key: 'star', id: '5958376256788502078', alt: '⭐', aliases: ['نجمة', 'مميز', 'المفضلة', 'star', 'favorite', 'featured', '⭐'] },
  { key: 'developer', id: '5801040467885822075', alt: '🧑‍💻', aliases: ['مبرمج', 'المبرمج', 'إصلاح كود', 'اصلاح كود', 'تعديل كود', 'برمجة', 'developer', 'programmer', 'fix code', 'coding'] },
  { key: 'gift', id: '5470041305616759456', alt: '🎁', aliases: ['هدية', 'الهدايا', 'إهداء', 'اهداء', 'gift', 'gifts', 'present', '🎁'] },
  { key: 'ios', id: '5332512686112520612', alt: '🍎', aliases: ['ايفون', 'آيفون', 'نظام ايفون', 'ios', 'iphone', 'apple ios'] },
  { key: 'android', id: '5332560480508591604', alt: '🤖', aliases: ['اندرويد', 'أندرويد', 'نظام اندرويد', 'android'] },
  { key: 'money', id: '5361656830944624968', alt: '💰', aliases: ['علامة الفلوس', 'فلوس', 'المال', 'السعر', 'المبلغ', 'الربح', 'الدفع', 'العملة', 'دولار', 'money', 'price', 'amount', 'profit', 'payment', 'currency', 'dollar', 'usd', '💰'] },
  { key: 'box', id: '5366201992970518798', alt: '📦', aliases: ['علامة الصندوق', 'الصندوق', 'المخزون', 'الكمية', 'المتوفر', 'box', 'stock', 'package', 'quantity', 'available', '📦'] },

  // Existing bot-wide icons are retained so the restoration does not regress
  // menus that already used them before the owner's new dictionary arrived.
  { key: 'support', id: '5908808657700655253', alt: '🧑‍💼', aliases: ['الدعم', 'الدعم الفني', 'مساعدة', 'المساعدة', 'تواصل', 'العملاء', 'محادثة', 'الزبون', 'support', 'help', 'contact', 'customers', 'conversation', 'customer'] },
  { key: 'wallet', id: '6325416826100519483', alt: '👛', aliases: ['المحفظة', 'محفظتك', 'شحن المحفظة', 'الرصيد', 'wallet', 'balance', 'top up wallet'] },
  { key: 'orders', id: '5882175861850903857', alt: '📦', aliases: ['طلباتي', 'الطلبات', 'الطلبات والتسليم', 'الطلب', 'التسليم', 'استرجاع طلب', 'orders', 'my orders', 'order', 'delivery'] },
  { key: 'products', id: '5800639128961814362', alt: '🛍️', aliases: ['المنتجات', 'إدارة المنتجات', 'ادارة المنتجات', 'المنتجات والمخزون', 'منتج', 'منتج جديد', 'المتجر', 'products', 'product', 'store'] }
];

// These keys identify known platforms for the conservative startup repair.
// They are defaults only: a mapping explicitly saved by the owner always wins.
const CANONICAL_PLATFORM_KEYS = new Set([
  'binance', 'superqi', 'google_one', 'youtube_premium', 'canva', 'capcut',
  'youtube', 'instagram', 'netflix', 'duolingo', 'adobe', 'chrome', 'google',
  'gemini', 'gmail', 'chatgpt', 'tiktok', 'authenticator', 'spotify',
  'telegram', 'facebook', 'paypal', 'x', 'whatsapp', 'play_store'
]);
const builtInOverrides = new Map();
let customEntries = [];
let loaded = false;

function canonicalKeysForEmojiId(emojiId) {
  const wanted = String(emojiId || '').trim();
  if (!wanted) return [];
  return BUILT_INS
    .filter(entry => CANONICAL_PLATFORM_KEYS.has(entry.key) && String(entry.id) === wanted)
    .map(entry => entry.key);
}

function sanitizeCustomEntries(rows = []) {
  let correctedCrossPlatform = 0;
  const entries = (Array.isArray(rows) ? rows : [])
    .map(entry => cleanEntry(entry, 'custom'))
    .filter(Boolean)
    .slice(0, MAX_CUSTOM_ENTRIES)
    .map(entry => {
      if (!entry.platformKey || entry.confirmedPlatformOverride === true) return entry;
      const owners = canonicalKeysForEmojiId(entry.emojiId);
      if (!owners.length || owners.includes(entry.platformKey)) return entry;
      const canonical = BUILT_INS.find(row => row.key === entry.platformKey);
      if (!canonical) return entry;
      correctedCrossPlatform += 1;
      return {
        ...entry,
        emojiId: String(canonical.id),
        alt: canonical.alt || entry.alt || '✨'
      };
    });
  return { entries, correctedCrossPlatform };
}

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
  const aliases = [...new Set([keywordAr, keywordEn, ...(Array.isArray(entry?.aliases) ? entry.aliases : [])].map(value => String(value || '').trim()).filter(Boolean))];
  const storedPlatformKey = String(entry?.platformKey || '').trim();
  const storedSemanticKey = String(entry?.semanticKey || '').trim();
  return {
    id: String(entry?.entryId || entry?.customId || entry?.rowId || '').trim() || crypto.randomBytes(6).toString('hex'),
    key: String(entry?.key || '').trim() || `custom_${crypto.randomBytes(4).toString('hex')}`,
    keywordAr,
    keywordEn,
    emojiId,
    alt: String(entry?.alt || '✨').slice(0, 16) || '✨',
    aliases,
    platformKey: source === 'custom'
      ? (CANONICAL_PLATFORM_KEYS.has(storedPlatformKey) ? storedPlatformKey : inferCanonicalPlatformKey(aliases))
      : '',
    semanticKey: source === 'custom'
      ? (BUILT_INS.some(row => row.key === storedSemanticKey) ? storedSemanticKey : inferBuiltInKey(aliases))
      : '',
    confirmedPlatformOverride: source === 'custom' && entry?.confirmedPlatformOverride === true,
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
  const sanitized = sanitizeCustomEntries(parsed);
  customEntries = sanitized.entries;
  loaded = true;
  if (sanitized.correctedCrossPlatform > 0) await persistCustom();
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
  if (needle === '-') return raw === '-' || raw.includes(' - ');
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

function inferBuiltInKey(aliases = [], canonicalOnly = false) {
  const matches = [];
  for (const suppliedAlias of aliases) {
    const normalizedSupplied = normalizeKeyword(suppliedAlias);
    if (!normalizedSupplied) continue;
    for (const entry of BUILT_INS) {
      if (canonicalOnly && !CANONICAL_PLATFORM_KEYS.has(entry.key)) continue;
      for (const builtInAlias of entry.aliases || []) {
        const normalizedBuiltIn = normalizeKeyword(builtInAlias);
        if (!normalizedBuiltIn) continue;
        if (
          normalizedSupplied === normalizedBuiltIn ||
          (` ${normalizedSupplied} `).includes(` ${normalizedBuiltIn} `)
        ) {
          matches.push({
            key: entry.key,
            tokenCount: normalizedBuiltIn.split(' ').length,
            aliasLength: normalizedBuiltIn.length
          });
        }
      }
    }
  }
  matches.sort((a, b) => b.tokenCount - a.tokenCount || b.aliasLength - a.aliasLength);
  return matches[0]?.key || '';
}

function inferCanonicalPlatformKey(aliases = []) {
  return inferBuiltInKey(aliases, true);
}

function candidateScore({ entry, normalizedAlias, normalizedText, rawMatched }) {
  const exact = Boolean(normalizedAlias && normalizedText === normalizedAlias);
  const tokenCount = normalizedAlias ? normalizedAlias.split(' ').filter(Boolean).length : 0;
  const aliasLength = normalizedAlias.length;
  const actionKeys = new Set([
    'error', 'success', 'search', 'delete', 'edit', 'pin', 'lock',
    'notifications_on', 'notifications_off', 'settings', 'save', 'copy',
    'key', 'add_message', 'image', 'live_support', 'fix',
    'close_live_support', 'add', 'qr'
  ]);
  const genericKeys = new Set(['support', 'wallet', 'orders', 'products']);
  const actionAtEdge = normalizedAlias && actionKeys.has(entry.key) && (
    normalizedText === normalizedAlias ||
    normalizedText.startsWith(`${normalizedAlias} `) ||
    normalizedText.endsWith(` ${normalizedAlias}`)
  );
  // Specific meaning wins before source. A manual mapping only wins a tie
  // against the same exact service; it cannot let a generic word such as
  // "مشترك" or "جوجل" replace CapCut/Gmail in a composite product name.
  return (
    (exact ? 1000000 : 0) +
    (tokenCount * 10000) +
    (aliasLength * 100) +
    (rawMatched ? 20 : 0) +
    (entry.source === 'custom' ? 10 : 0) +
    (actionAtEdge ? 5 : 0) -
    (genericKeys.has(entry.key) ? 2 : 0)
  );
}

function matchingCandidates(value) {
  const raw = String(value || '').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim();
  if (!raw) return [];
  const normalized = normalizeKeyword(raw);
  const candidates = [];
  for (const entry of allEntries()) {
    if (!validEmojiId(entry.emojiId)) continue;
    for (const alias of entry.aliases || []) {
      const rawMatched = rawAliasMatch(raw, alias);
      const normalizedMatched = normalizedAliasMatch(normalized, alias);
      const matched = rawMatched || normalizedMatched;
      if (!matched) continue;
      const normalizedAlias = normalizeKeyword(alias);
      candidates.push({
        entry,
        alias,
        normalizedAlias,
        exact: Boolean(normalizedAlias && normalized === normalizedAlias),
        score: candidateScore({ entry, normalizedAlias, normalizedText: normalized, rawMatched })
      });
    }
  }
  return candidates.sort((a, b) => b.score - a.score);
}

function candidateResult(candidate, platformKey = '') {
  if (!candidate?.entry) return null;
  const winner = candidate.entry;
  const inferredArabic = winner.keywordAr || (winner.aliases || []).find(alias => /[\u0600-\u06FF]/.test(String(alias))) || '';
  const inferredEnglish = winner.keywordEn || (winner.aliases || []).find(alias => /[A-Za-z]/.test(String(alias))) || '';
  return {
    key: platformKey || winner.key,
    mappingKey: winner.key,
    platformKey: platformKey || winner.platformKey || (CANONICAL_PLATFORM_KEYS.has(winner.key) ? winner.key : ''),
    id: String(winner.emojiId),
    emojiId: String(winner.emojiId),
    alt: winner.alt || '✨',
    source: winner.source,
    exactMatch: candidate.exact === true,
    keywordAr: inferredArabic,
    keywordEn: inferredEnglish
  };
}

function resolve(value) {
  return candidateResult(matchingCandidates(value)[0]);
}

function selectCanonicalProductCandidate(candidates) {
  const canonical = candidates.filter(candidate => (
    candidate.entry.source === 'built-in' && CANONICAL_PLATFORM_KEYS.has(candidate.entry.key)
  ));
  if (!canonical.length) return null;
  const matchedKeys = new Set(canonical.map(candidate => candidate.entry.key));
  const shadowedParents = new Set();
  const googleChildren = ['google_one', 'chrome', 'gmail', 'gemini', 'play_store', 'youtube', 'youtube_premium'];
  if (googleChildren.some(key => matchedKeys.has(key))) shadowedParents.add('google');
  if (matchedKeys.has('youtube_premium')) shadowedParents.add('youtube');
  return canonical.find(candidate => !shadowedParents.has(candidate.entry.key)) || canonical[0];
}

function resolveProduct(value) {
  const candidates = matchingCandidates(value);
  if (!candidates.length) return null;
  const canonicalBuiltIn = selectCanonicalProductCandidate(candidates);
  if (!canonicalBuiltIn) return candidateResult(candidates[0]);

  const platformKey = canonicalBuiltIn.entry.key;
  const samePlatform = candidates.filter(candidate => (
    (candidate.entry.source === 'built-in' && candidate.entry.key === platformKey) ||
    (
      candidate.entry.source === 'custom' &&
      candidate.entry.platformKey === platformKey &&
      candidate.entry.confirmedPlatformOverride === true
    )
  ));
  return candidateResult(samePlatform[0] || canonicalBuiltIn, platformKey);
}

function getByKey(key) {
  const wanted = String(key || '').trim();
  const custom = customEntries.find(entry => entry.key === wanted);
  if (custom) return { id: custom.emojiId, alt: custom.alt, key: custom.key };
  for (let index = customEntries.length - 1; index >= 0; index -= 1) {
    const platformOverride = customEntries[index];
    const isCanonicalPlatform = CANONICAL_PLATFORM_KEYS.has(wanted);
    if (
      (platformOverride.platformKey === wanted && (!isCanonicalPlatform || platformOverride.confirmedPlatformOverride === true)) ||
      (!isCanonicalPlatform && platformOverride.semanticKey === wanted)
    ) {
      return { id: platformOverride.emojiId, alt: platformOverride.alt, key: wanted, mappingKey: platformOverride.key };
    }
  }
  const entry = BUILT_INS.find(row => row.key === wanted);
  if (!entry) return null;
  const resolved = builtInEntry(entry);
  return { id: resolved.emojiId, alt: resolved.alt, key: resolved.key };
}

function setBuiltInOverride(key, emojiId) {
  const normalizedKey = String(key || '').trim();
  if (!BUILT_INS.some(entry => entry.key === normalizedKey)) return false;
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
    aliases: entry.aliases,
    platformKey: entry.platformKey || '',
    semanticKey: entry.semanticKey || '',
    confirmedPlatformOverride: entry.confirmedPlatformOverride === true
  }))));
}

async function replaceCustom(entries = []) {
  const before = JSON.stringify(customEntries.map(entry => ({
    id: entry.id,
    keywordAr: entry.keywordAr,
    keywordEn: entry.keywordEn,
    emojiId: entry.emojiId,
    aliases: entry.aliases,
    platformKey: entry.platformKey,
    semanticKey: entry.semanticKey,
    confirmedPlatformOverride: entry.confirmedPlatformOverride === true
  })));
  const sanitized = sanitizeCustomEntries(entries);
  customEntries = sanitized.entries;
  loaded = true;
  const after = JSON.stringify(customEntries.map(entry => ({
    id: entry.id,
    keywordAr: entry.keywordAr,
    keywordEn: entry.keywordEn,
    emojiId: entry.emojiId,
    aliases: entry.aliases,
    platformKey: entry.platformKey,
    semanticKey: entry.semanticKey,
    confirmedPlatformOverride: entry.confirmedPlatformOverride === true
  })));
  const changed = before !== after;
  if (changed || sanitized.correctedCrossPlatform > 0) await persistCustom();
  return {
    count: customEntries.length,
    changed,
    correctedCrossPlatform: sanitized.correctedCrossPlatform
  };
}

async function migrateConfirmedPlatformIds(overrides = {}) {
  let changed = 0;
  customEntries = customEntries.map(entry => {
    const wanted = String(overrides?.[entry.platformKey] || '').trim();
    if (!validEmojiId(wanted) || String(entry.emojiId) === wanted) return entry;
    changed += 1;
    const builtIn = BUILT_INS.find(row => row.key === entry.platformKey);
    return { ...entry, emojiId: wanted, alt: builtIn?.alt || entry.alt || '✨' };
  });
  if (changed) await persistCustom();
  return changed;
}

async function upsertCustom({ keywordAr, keywordEn, emojiId, alt = '✨' }) {
  let candidate = cleanEntry({
    keywordAr,
    keywordEn,
    emojiId,
    alt,
    // Only mappings deliberately saved through the current owner workflow
    // may replace a known platform. This quarantines bad legacy assignments
    // without deleting any Setting rows from the database.
    confirmedPlatformOverride: true
  }, 'custom');
  if (!candidate) {
    const error = new Error('INVALID_PREMIUM_EMOJI_MAPPING');
    error.code = 'INVALID_PREMIUM_EMOJI_MAPPING';
    throw error;
  }
  const sanitized = sanitizeCustomEntries([candidate]);
  candidate = sanitized.entries[0];
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
  return { ...candidate, autoCorrected: sanitized.correctedCrossPlatform > 0 };
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
  resolveProduct,
  getByKey,
  setBuiltInOverride,
  listCustom,
  replaceCustom,
  migrateConfirmedPlatformIds,
  upsertCustom,
  removeCustom,
  isCanonicalPlatformKey: key => CANONICAL_PLATFORM_KEYS.has(String(key || '')),
  builtInCount: () => BUILT_INS.length
};
