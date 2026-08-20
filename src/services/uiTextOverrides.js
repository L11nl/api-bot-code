const crypto = require('crypto');
const { getSetting, setSetting } = require('../db');

const OVERRIDES_STORAGE_KEY = 'ui_text_overrides_v1';
const CATALOG_STORAGE_KEY = 'ui_text_catalog_v1';
const MAX_OVERRIDES = 200;
const MAX_CATALOG_ENTRIES = 350;
const MAX_TEXT_LENGTH = 700;
const CATALOG_SAVE_DELAY_MS = 1500;

let overrides = [];
let catalog = [];
let catalogSaveTimer = null;
let catalogDirty = false;
const replyButtonAliases = new Map();
const MAX_REPLY_BUTTON_ALIASES = 500;

function normalizeText(value) {
  return String(value || '')
    .replace(/<tg-emoji\b[^>]*>[\s\S]*?<\/tg-emoji>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
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

function plainText(value) {
  return String(value || '')
    .replace(/<tg-emoji\b[^>]*>([\s\S]*?)<\/tg-emoji>/gi, '$1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function validKind(value) {
  return value === 'button' || value === 'message';
}

function validEmojiId(value) {
  return /^\d{5,24}$/.test(String(value || '').trim());
}

function entryId(kind, text) {
  return crypto.createHash('sha256').update(`${kind}\u0000${text}`).digest('hex').slice(0, 16);
}

function containsSensitiveData(raw, cleaned) {
  const value = String(raw || '');
  const searchable = `${value}\n${cleaned}`;
  if (/<(?:code|pre)\b/i.test(value) || /```/.test(value)) return true;
  if (/https?:\/\/|t\.me\/|www\./i.test(searchable)) return true;
  if (/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(searchable)) return true;
  if (/\b\d{6,15}:[A-Za-z0-9_-]{20,}\b/.test(searchable)) return true;
  if (/\b[A-Za-z0-9_-]{28,}\b/.test(searchable)) return true;
  if (/\b\d{8,24}\b/.test(searchable)) return true;
  if (/(?:api[\s_-]*key|bot[\s_-]*token|access[\s_-]*token|secret|password)\s*[:=]/i.test(searchable)) return true;
  if (/(?:كلمة المرور|الباسورد|التوكن|مفتاح\s*(?:api|الـ?api))\s*[:：]/i.test(searchable)) return true;
  return false;
}

function cleanCatalogEntry(value) {
  const kind = String(value?.kind || '').trim();
  const text = String(value?.text || '').trim();
  const clean = plainText(text);
  if (!validKind(kind) || !text || text.length > MAX_TEXT_LENGTH || clean.length < 2 || containsSensitiveData(text, clean)) return null;
  return {
    id: entryId(kind, text),
    kind,
    text,
    plainText: clean.slice(0, MAX_TEXT_LENGTH),
    callbackData: kind === 'button' ? String(value?.callbackData || '').slice(0, 80) : '',
    replyKeyboard: kind === 'button' && value?.replyKeyboard === true,
    seenAt: Math.max(0, Number(value?.seenAt || Date.now())),
    seenCount: Math.max(1, Number(value?.seenCount || 1))
  };
}

function cleanOverride(value) {
  const kind = String(value?.kind || '').trim();
  const originalText = String(value?.originalText || '').trim();
  const replacementText = String(value?.replacementText || '').trim();
  const emojiId = validEmojiId(value?.emojiId) ? String(value.emojiId).trim() : '';
  if (
    !validKind(kind) ||
    !originalText ||
    originalText.length > MAX_TEXT_LENGTH ||
    !replacementText ||
    replacementText.length > (kind === 'button' ? 64 : MAX_TEXT_LENGTH)
  ) return null;
  return {
    id: entryId(kind, originalText),
    kind,
    originalText,
    originalPlainText: plainText(originalText).slice(0, MAX_TEXT_LENGTH),
    replacementText,
    emojiId,
    emojiAlt: String(value?.emojiAlt || '✨').slice(0, 16) || '✨',
    replyKeyboard: kind === 'button' && value?.replyKeyboard === true,
    updatedAt: Math.max(0, Number(value?.updatedAt || Date.now()))
  };
}

function parseStoredList(raw, cleaner, limit) {
  try {
    const parsed = JSON.parse(String(raw || '[]'));
    if (!Array.isArray(parsed)) return [];
    const unique = new Map();
    for (const row of parsed) {
      const clean = cleaner(row);
      if (clean) unique.set(clean.id, clean);
    }
    return [...unique.values()].slice(-limit);
  } catch {
    return [];
  }
}

async function load() {
  const [storedOverrides, storedCatalog] = await Promise.all([
    getSetting(OVERRIDES_STORAGE_KEY, '[]'),
    getSetting(CATALOG_STORAGE_KEY, '[]')
  ]);
  overrides = parseStoredList(storedOverrides, cleanOverride, MAX_OVERRIDES);
  catalog = parseStoredList(storedCatalog, cleanCatalogEntry, MAX_CATALOG_ENTRIES);
  catalogDirty = false;
  return { overrides: overrides.length, catalog: catalog.length };
}

async function persistCatalog() {
  if (catalogSaveTimer) {
    clearTimeout(catalogSaveTimer);
    catalogSaveTimer = null;
  }
  if (!catalogDirty) return catalog.length;
  catalogDirty = false;
  try {
    await setSetting(CATALOG_STORAGE_KEY, JSON.stringify(catalog));
  } catch (error) {
    catalogDirty = true;
    throw error;
  }
  return catalog.length;
}

function scheduleCatalogPersist() {
  if (catalogSaveTimer) return;
  catalogSaveTimer = setTimeout(() => {
    catalogSaveTimer = null;
    persistCatalog().catch(error => console.error('UI text catalog save:', error.message));
  }, CATALOG_SAVE_DELAY_MS);
  if (typeof catalogSaveTimer.unref === 'function') catalogSaveTimer.unref();
}

function record({ kind, text, callbackData = '', replyKeyboard = false }) {
  const clean = cleanCatalogEntry({ kind, text, callbackData, replyKeyboard, seenAt: Date.now(), seenCount: 1 });
  if (!clean) return null;
  const index = catalog.findIndex(row => row.id === clean.id);
  let shouldPersist = false;
  if (index >= 0) {
    shouldPersist = Boolean(
      (clean.callbackData && clean.callbackData !== catalog[index].callbackData) ||
      (clean.replyKeyboard && !catalog[index].replyKeyboard)
    );
    catalog[index] = {
      ...catalog[index],
      callbackData: clean.callbackData || catalog[index].callbackData,
      replyKeyboard: clean.replyKeyboard || catalog[index].replyKeyboard,
      seenAt: Date.now(),
      seenCount: Math.min(1000000, Number(catalog[index].seenCount || 0) + 1)
    };
  } else {
    catalog.push(clean);
    shouldPersist = true;
    if (catalog.length > MAX_CATALOG_ENTRIES) {
      catalog.sort((a, b) => Number(a.seenAt || 0) - Number(b.seenAt || 0));
      catalog = catalog.slice(-MAX_CATALOG_ENTRIES);
    }
  }
  if (shouldPersist) {
    catalogDirty = true;
    scheduleCatalogPersist();
  }
  return clean.id;
}

function get(kind, originalText) {
  const id = entryId(String(kind || ''), String(originalText || '').trim());
  const row = overrides.find(entry => entry.id === id && entry.kind === kind);
  return row ? { ...row } : null;
}

function levenshtein(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  if (!a) return b.length;
  if (!b) return a.length;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const old = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diagonal = old;
    }
  }
  return previous[b.length];
}

function matchScore(query, candidate) {
  const q = normalizeText(query);
  const value = normalizeText(candidate);
  if (!q || !value) return 0;
  if (q === value) return 10000;
  if (value.startsWith(q)) return 8500 - Math.min(1000, value.length - q.length);
  if (value.includes(q)) return 7500 - Math.min(1500, value.length - q.length);
  const queryTokens = new Set(q.split(' ').filter(Boolean));
  const valueTokens = new Set(value.split(' ').filter(Boolean));
  const overlap = [...queryTokens].filter(token => valueTokens.has(token)).length;
  const tokenScore = overlap ? (overlap / queryTokens.size) * 5000 : 0;
  const distance = levenshtein(q.slice(0, 120), value.slice(0, 120));
  const similarity = 1 - distance / Math.max(q.length, value.length, 1);
  return Math.max(tokenScore, similarity >= 0.48 ? similarity * 4000 : 0);
}

function search(query, limit = 8) {
  const q = normalizeText(query);
  if (!q) return [];
  const candidates = new Map();
  for (const row of catalog) candidates.set(row.id, row);
  for (const row of overrides) {
    if (!candidates.has(row.id)) {
      candidates.set(row.id, {
        id: row.id,
        kind: row.kind,
        text: row.originalText,
        plainText: row.originalPlainText,
        callbackData: '',
        replyKeyboard: row.replyKeyboard,
        seenAt: row.updatedAt,
        seenCount: 1
      });
    }
  }
  return [...candidates.values()].map(row => {
    const override = overrides.find(item => item.id === row.id);
    const score = Math.max(
      matchScore(q, row.plainText),
      override ? matchScore(q, override.replacementText) : 0
    );
    return { ...row, override: override ? { ...override } : null, score };
  }).filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.seenCount || 0) - Number(a.seenCount || 0) || Number(b.seenAt || 0) - Number(a.seenAt || 0))
    .slice(0, Math.max(1, Math.min(20, Number(limit) || 8)));
}

async function persistOverrides() {
  await setSetting(OVERRIDES_STORAGE_KEY, JSON.stringify(overrides));
}

async function upsert({ kind, originalText, replacementText, emojiId = '', emojiAlt = '✨', replyKeyboard = false }) {
  const clean = cleanOverride({ kind, originalText, replacementText, emojiId, emojiAlt, replyKeyboard, updatedAt: Date.now() });
  if (!clean) {
    const error = new Error('INVALID_UI_TEXT_OVERRIDE');
    error.code = 'INVALID_UI_TEXT_OVERRIDE';
    throw error;
  }
  const index = overrides.findIndex(row => row.id === clean.id);
  if (index >= 0) overrides[index] = clean;
  else {
    if (overrides.length >= MAX_OVERRIDES) {
      const error = new Error('UI_TEXT_OVERRIDE_LIMIT');
      error.code = 'UI_TEXT_OVERRIDE_LIMIT';
      throw error;
    }
    overrides.push(clean);
  }
  await persistOverrides();
  return { ...clean };
}

async function remove(id) {
  const index = overrides.findIndex(row => row.id === String(id || ''));
  if (index < 0) return false;
  overrides.splice(index, 1);
  await persistOverrides();
  return true;
}

function list() {
  return overrides.slice().sort((a, b) => b.updatedAt - a.updatedAt).map(row => ({ ...row }));
}

function findCandidate(id) {
  const wanted = String(id || '');
  const row = catalog.find(entry => entry.id === wanted);
  if (row) return { ...row, override: get(row.kind, row.text) };
  const override = overrides.find(entry => entry.id === wanted);
  if (!override) return null;
  return {
    id: override.id,
    kind: override.kind,
    text: override.originalText,
    plainText: override.originalPlainText,
    callbackData: '',
    replyKeyboard: override.replyKeyboard,
    seenAt: override.updatedAt,
    seenCount: 1,
    override: { ...override }
  };
}

function registerReplyButtonAlias(displayedText, originalText) {
  const shown = String(displayedText || '').trim();
  const original = String(originalText || '').trim();
  if (!shown || !original) return false;
  replyButtonAliases.delete(shown);
  replyButtonAliases.set(shown, original);
  while (replyButtonAliases.size > MAX_REPLY_BUTTON_ALIASES) {
    replyButtonAliases.delete(replyButtonAliases.keys().next().value);
  }
  return true;
}

function originalButtonText(displayedText) {
  const shown = String(displayedText || '').trim();
  if (!shown) return '';
  const runtimeOriginal = replyButtonAliases.get(shown);
  if (runtimeOriginal) return runtimeOriginal;

  const exactOverrides = overrides.filter(row => (
    row.kind === 'button' && row.replyKeyboard && row.replacementText === shown
  ));
  if (exactOverrides.length === 1) return exactOverrides[0].originalText;

  // Reply keyboards send their visible label back as a normal message. The
  // Premium Emoji decorator may remove an old Unicode icon from that label,
  // so compare normalized text as a restart-safe fallback for keyboards that
  // were already open before the current process started.
  const normalizedShown = normalizeText(shown);
  if (!normalizedShown) return '';
  const matches = new Map();
  for (const row of catalog) {
    if (row.kind !== 'button' || !row.replyKeyboard) continue;
    const override = overrides.find(item => item.id === row.id);
    const visibleCandidates = [row.text, row.plainText, override?.replacementText].filter(Boolean);
    if (visibleCandidates.some(value => normalizeText(value) === normalizedShown)) {
      matches.set(row.text, row.text);
    }
  }
  for (const row of overrides) {
    if (row.kind !== 'button' || !row.replyKeyboard) continue;
    if ([row.originalText, row.originalPlainText, row.replacementText].some(value => normalizeText(value) === normalizedShown)) {
      matches.set(row.originalText, row.originalText);
    }
  }
  return matches.size === 1 ? [...matches.values()][0] : '';
}

module.exports = {
  load,
  record,
  get,
  search,
  upsert,
  remove,
  list,
  findCandidate,
  persistCatalog,
  registerReplyButtonAlias,
  originalButtonText,
  normalizeText,
  plainText,
  validEmojiId
};
