const axios = require('axios');

const cache = new Map();

function looksArabic(text) {
  return /[\u0600-\u06FF]/.test(String(text || ''));
}

function cacheKey(source, from, to) {
  return `${from}>${to}:${source}`;
}

async function googlePublicTranslate(source, from = 'ar', to = 'en') {
  const response = await axios.get('https://translate.googleapis.com/translate_a/single', {
    params: { client: 'gtx', sl: from, tl: to, dt: 't', q: source },
    timeout: 7000,
    validateStatus: status => status >= 200 && status < 400
  });
  return Array.isArray(response.data?.[0])
    ? response.data[0].map(part => String(part?.[0] || '')).join('').trim()
    : '';
}

async function myMemoryTranslate(source, from = 'ar', to = 'en') {
  const response = await axios.get('https://api.mymemory.translated.net/get', {
    params: { q: source.slice(0, 450), langpair: `${from}|${to}` },
    timeout: 7000,
    validateStatus: status => status >= 200 && status < 400
  });
  return String(response.data?.responseData?.translatedText || '').trim();
}

async function translateText(text, from = 'ar', to = 'en') {
  const source = String(text || '').trim();
  if (!source) return '';
  if (from === to) return source;
  const key = cacheKey(source, from, to);
  if (cache.has(key)) return cache.get(key);

  let translated = '';
  try {
    translated = await googlePublicTranslate(source, from, to);
  } catch (error) {
    console.error(`Google ${from}->${to} translation failed:`, error.message);
  }

  if (!translated) {
    try {
      translated = await myMemoryTranslate(source, from, to);
    } catch (error) {
      console.error(`MyMemory ${from}->${to} translation failed:`, error.message);
    }
  }

  const result = translated || source;
  cache.set(key, result);
  if (cache.size > 1000) cache.delete(cache.keys().next().value);
  return result;
}

async function translateArToEn(text) {
  const source = String(text || '').trim();
  if (!source) return '';
  if (!looksArabic(source)) return source;
  return translateText(source, 'ar', 'en');
}

async function translateEnToAr(text) {
  const source = String(text || '').trim();
  if (!source) return '';
  if (looksArabic(source)) return source;
  return translateText(source, 'en', 'ar');
}

module.exports = { translateArToEn, translateEnToAr, translateText, looksArabic };
