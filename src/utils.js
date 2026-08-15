const crypto = require('crypto');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function moneyUsd(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function moneyIqd(value) {
  return `${new Intl.NumberFormat('ar-IQ', { maximumFractionDigits: 0 }).format(Number(value || 0))} د.ع`;
}

function parseDescription(value) {
  if (!value) return {
    ar: '', en: '', warrantyAr: '', warrantyEn: '', sold: 0,
    nameArHtml: '', nameEmojiId: '', nameEmojiAlt: '',
    descriptionArHtml: '', warrantyArHtml: '',
    serviceInputMode: '', servicePromptAr: '', servicePromptEn: ''
  };

  let parsed = value;
  for (let attempt = 0; attempt < 3 && typeof parsed === 'string'; attempt += 1) {
    const trimmed = parsed.trim();
    if (!trimmed) break;
    try { parsed = JSON.parse(trimmed); }
    catch {
      parsed = { ar: trimmed, en: trimmed };
      break;
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    parsed = { ar: String(parsed || ''), en: String(parsed || '') };
  }

  const legacyContent = parsed.type === 'text' ? String(parsed.content || '') : '';

  // IMPORTANT: preserve every existing custom field. Older startup code rebuilt
  // this object from a small whitelist and accidentally deleted Premium Emoji
  // IDs and later feature metadata (for example serviceInputMode/servicePrompt).
  // Returning the original keys plus normalized aliases makes upgrades additive,
  // never destructive.
  return {
    ...parsed,
    ar: String(parsed.ar ?? parsed.descriptionAr ?? parsed.description_ar ?? parsed.arabic ?? parsed.descriptionArabic ?? legacyContent ?? ''),
    en: String(parsed.en ?? parsed.descriptionEn ?? parsed.description_en ?? parsed.english ?? parsed.descriptionEnglish ?? legacyContent ?? ''),
    warrantyAr: String(parsed.warrantyAr ?? parsed.warranty_ar ?? parsed.arWarranty ?? ''),
    warrantyEn: String(parsed.warrantyEn ?? parsed.warranty_en ?? parsed.enWarranty ?? ''),
    sold: Number(parsed.sold ?? parsed.soldCount ?? 0) || 0,
    nameArHtml: String(parsed.nameArHtml || ''),
    nameEmojiId: String(parsed.nameEmojiId || ''),
    nameEmojiAlt: String(parsed.nameEmojiAlt || ''),
    descriptionArHtml: String(parsed.descriptionArHtml || ''),
    warrantyArHtml: String(parsed.warrantyArHtml || ''),
    serviceInputMode: String(parsed.serviceInputMode || ''),
    servicePromptAr: String(parsed.servicePromptAr || ''),
    servicePromptEn: String(parsed.servicePromptEn || '')
  };
}

function extractTelegramRichText(text, entities = []) {
  const raw = String(text || '');
  const custom = (Array.isArray(entities) ? entities : [])
    .filter(entity => entity?.type === 'custom_emoji' && entity.custom_emoji_id)
    .sort((a, b) => Number(a.offset || 0) - Number(b.offset || 0));

  if (!custom.length) {
    return { plain: raw, html: escapeHtml(raw), customEmojiIds: [], firstCustomEmojiId: '', firstCustomEmojiAlt: '' };
  }

  let cursor = 0;
  const chunks = [];
  const ids = [];
  let firstAlt = '';
  for (const entity of custom) {
    const offset = Number(entity.offset || 0);
    const length = Number(entity.length || 0);
    if (offset < cursor || length <= 0) continue;
    chunks.push(escapeHtml(raw.slice(cursor, offset)));
    const alt = raw.slice(offset, offset + length) || '✨';
    const id = String(entity.custom_emoji_id);
    if (!firstAlt) firstAlt = alt;
    ids.push(id);
    chunks.push(`<tg-emoji emoji-id="${escapeHtml(id)}">${escapeHtml(alt)}</tg-emoji>`);
    cursor = offset + length;
  }
  chunks.push(escapeHtml(raw.slice(cursor)));
  return {
    plain: raw,
    html: chunks.join(''),
    customEmojiIds: ids,
    firstCustomEmojiId: ids[0] || '',
    firstCustomEmojiAlt: firstAlt || ''
  };
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function looksLikeEmail(value) {
  const email = normalizeEmail(value);
  return /^[^\s@|;,]+@[^\s@|;,]+\.[^\s@|;,]+$/.test(email);
}

function splitInventoryLine(raw) {
  if (raw.includes('|')) return raw.split('|');
  if (raw.includes(';')) return raw.split(';');
  if (raw.includes('\t')) return raw.split('\t');
  if (raw.includes(',')) return raw.split(',');
  return [raw];
}

function parseJsonInventory(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON must be an object');
  }
  return {
    email: String(parsed.email || '').trim(),
    password: String(parsed.password || parsed.pass || '').trim(),
    twoFactor: String(parsed.twoFactor || parsed.two_factor || parsed['2fa'] || '').trim(),
    code: String(parsed.code || parsed.key || '').trim(),
    extra: String(parsed.extra || parsed.note || '').trim(),
    raw
  };
}

function parseInventoryLineForType(line, productType = 'account') {
  const raw = String(line || '').trim();
  if (!raw) return { item: null, error: null };

  const type = String(productType || 'account').toLowerCase();

  if (type === 'code') {
    return {
      item: { email: '', password: '', twoFactor: '', code: raw, extra: '', raw },
      error: null
    };
  }

  if (type === 'free') {
    return {
      item: { email: '', password: '', twoFactor: '', code: '', extra: '', raw },
      error: null
    };
  }

  let item;
  try {
    if (raw.startsWith('{')) {
      if (type === 'shared') return { item: null, error: 'الحساب المشترك يقبل فقط email|password' };
      item = parseJsonInventory(raw);
    } else {
      const parts = splitInventoryLine(raw).map(value => String(value).trim());
      if (type === 'shared' && parts.length !== 2) return { item: null, error: 'الحساب المشترك يقبل فقط email|password' };
      const [email = '', password = '', ...rest] = parts;
      item = { email, password, twoFactor: '', code: '', extra: rest.join('|').trim(), raw };
    }
  } catch (error) {
    return { item: null, error: `JSON غير صالح: ${error.message}` };
  }

  const email = String(item.email || '').trim();
  const password = String(item.password || '').trim();
  const extra = String(item.extra || '').trim();
  if (!looksLikeEmail(email)) return { item: null, error: 'الإيميل غير صحيح' };
  if (!password) return { item: null, error: 'لازم يحتوي إيميل وباسورد' };
  return {
    item: { email, password, twoFactor: '', code: '', extra, raw },
    error: null
  };
}

function parseInventoryTextForProduct(text, productType = 'account') {
  const lines = String(text || '').split(/\r?\n/);
  const items = [];
  const errors = [];

  lines.forEach((line, index) => {
    const trimmed = String(line || '').trim();
    if (!trimmed) return;
    const result = parseInventoryLineForType(trimmed, productType);
    if (result.error) errors.push({ line: index + 1, value: trimmed, error: result.error });
    else if (result.item) items.push(result.item);
  });

  return { items, errors };
}

function parseInventoryText(text) {
  return parseInventoryTextForProduct(text, 'account').items;
}

function deserializeInventory(value, extra = '') {
  const raw = String(value || '');
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}
  const result = parseInventoryLineForType(raw, 'account');
  const parsed = result.item || { raw };
  if (extra && !parsed.extra) parsed.extra = extra;
  return parsed;
}

function inventoryPayloadIsValid(productType, item) {
  const type = String(productType || 'account');
  if (type === 'code') return Boolean(String(item?.code || item?.raw || '').trim());
  if (type === 'free') return Boolean(String(item?.raw || item?.extra || '').trim());
  return looksLikeEmail(item?.email) && Boolean(String(item?.password || '').trim());
}

function inventoryFingerprint(productType, item) {
  const type = String(productType || 'account');
  let normalized;
  if (type === 'code') normalized = { code: String(item?.code || item?.raw || '').trim() };
  else if (type === 'free') normalized = { raw: String(item?.raw || item?.extra || '').trim() };
  else normalized = { email: normalizeEmail(item?.email), password: String(item?.password || '').trim() };
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function renderDelivery(item, lang = 'ar') {
  const labels = lang === 'en'
    ? { email: 'Email', password: 'Password', code: 'Code', extra: 'Extra' }
    : { email: 'الإيميل', password: 'الباسورد', code: 'الكود', extra: 'إضافي' };
  const lines = [];
  if (item.email) lines.push(`<b>${labels.email}:</b> <code>${escapeHtml(item.email)}</code>`);
  if (item.password) lines.push(`<b>${labels.password}:</b> <code>${escapeHtml(item.password)}</code>`);
  if (item.code) lines.push(`<b>${labels.code}:</b> <code>${escapeHtml(item.code)}</code>`);
  if (item.extra) lines.push(`<b>${labels.extra}:</b> ${escapeHtml(item.extra)}`);
  if (!lines.length && item.raw) lines.push(`<code>${escapeHtml(item.raw)}</code>`);
  return lines.join('\n') || (lang === 'en' ? 'Contact support for delivery.' : 'راجع الدعم للتسليم.');
}

function randomCaptcha() {
  const a = Math.floor(Math.random() * 8) + 2;
  const b = Math.floor(Math.random() * 7) + 1;
  const answer = a + b;
  const options = new Set([answer]);
  while (options.size < 4) options.add(Math.max(1, answer + Math.floor(Math.random() * 9) - 4));
  return { question: `${a} + ${b}`, answer, options: [...options].sort(() => Math.random() - 0.5) };
}

module.exports = {
  escapeHtml,
  moneyUsd,
  moneyIqd,
  parseDescription,
  parseInventoryText,
  parseInventoryTextForProduct,
  parseInventoryLineForType,
  inventoryFingerprint,
  inventoryPayloadIsValid,
  deserializeInventory,
  renderDelivery,
  randomCaptcha,
  looksLikeEmail,
  extractTelegramRichText
};
