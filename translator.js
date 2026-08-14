const axios = require('axios');

const cache = new Map();

function looksArabic(text) {
  return /[\u0600-\u06FF]/.test(String(text || ''));
}

async function googlePublicTranslate(source) {
  const response = await axios.get('https://translate.googleapis.com/translate_a/single', {
    params: { client: 'gtx', sl: 'ar', tl: 'en', dt: 't', q: source },
    timeout: 10000,
    validateStatus: status => status >= 200 && status < 400
  });
  return Array.isArray(response.data?.[0])
    ? response.data[0].map(part => String(part?.[0] || '')).join('').trim()
    : '';
}

async function myMemoryTranslate(source) {
  const response = await axios.get('https://api.mymemory.translated.net/get', {
    params: { q: source.slice(0, 450), langpair: 'ar|en' },
    timeout: 10000,
    validateStatus: status => status >= 200 && status < 400
  });
  return String(response.data?.responseData?.translatedText || '').trim();
}

async function translateArToEn(text) {
  const source = String(text || '').trim();
  if (!source) return '';
  if (!looksArabic(source)) return source;
  if (cache.has(source)) return cache.get(source);

  let translated = '';
  try {
    translated = await googlePublicTranslate(source);
  } catch (error) {
    console.error('Google auto translation failed:', error.message);
  }

  if (!translated) {
    try {
      translated = await myMemoryTranslate(source);
    } catch (error) {
      console.error('MyMemory auto translation failed:', error.message);
    }
  }

  const result = translated || source;
  cache.set(source, result);
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return result;
}

module.exports = { translateArToEn };
