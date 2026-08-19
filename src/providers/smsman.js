const axios = require('axios');

const ID = 'smsman';
const NAME = 'SMS-MAN';
const BASE_URL = String(process.env.SMSMAN_BASE_URL || 'https://api.sms-man.com/stubs/handler_api.php').trim();
const TIMEOUT_MS = Math.min(30000, Math.max(3000, Number(process.env.VIRTUAL_NUMBERS_TIMEOUT_MS || 12000)));
const servicesCache = { at: 0, value: [] };
const countriesCache = { at: 0, value: [] };
const pricesCache = new Map();
const allPricesCache = { at: 0, value: [] };
const SERVICES_TTL = 10 * 60_000;
const COUNTRIES_TTL = 24 * 60 * 60_000;
const PRICES_TTL = 5_000;

function clearCaches() {
  servicesCache.at = 0; servicesCache.value = [];
  countriesCache.at = 0; countriesCache.value = [];
  allPricesCache.at = 0; allPricesCache.value = [];
  pricesCache.clear();
}

function apiError(code, detail = '') { const error = new Error(code); error.code = code; error.detail = detail; return error; }
function parseJson(text, fallback = null) { try { return JSON.parse(text); } catch { return fallback; } }

async function request(apiKey, action, extra = {}) {
  if (!String(apiKey || '').trim()) throw apiError('BAD_KEY');
  let response;
  try {
    response = await axios.get(BASE_URL, {
      params: { api_key: String(apiKey).trim(), action, ...extra },
      timeout: TIMEOUT_MS,
      responseType: 'text',
      transformResponse: [data => data]
    });
  } catch (error) {
    throw apiError('PROVIDER_UNAVAILABLE', error?.message || 'request failed');
  }
  const text = typeof response.data === 'string' ? response.data.trim() : String(response.data ?? '').trim();
  if (/^(BAD_KEY|BAD_ACTION|BAD_SERVICE|BAD_COUNTRY|NO_ACTIVATION)/i.test(text)) throw apiError(text.split(':')[0].trim().toUpperCase(), text);
  return text;
}

function parsePrice(serviceData) {
  if (!serviceData || typeof serviceData !== 'object') return null;
  const cost = Number(serviceData.cost ?? serviceData.price);
  const count = Number(serviceData.count ?? 0);
  if (!Number.isFinite(cost) || cost < 0 || !Number.isFinite(count) || count <= 0) return null;
  return { providerCost: cost, count: Math.floor(count) };
}

async function getBalance(apiKey) {
  const text = await request(apiKey, 'getBalance');
  if (!text.startsWith('ACCESS_BALANCE:')) throw apiError('BAD_PROVIDER_RESPONSE', text);
  const balance = Number(text.slice('ACCESS_BALANCE:'.length));
  if (!Number.isFinite(balance)) throw apiError('BAD_PROVIDER_RESPONSE', text);
  return balance;
}

async function listServices(apiKey, force = false) {
  if (!force && servicesCache.value.length && Date.now() - servicesCache.at < SERVICES_TTL) return servicesCache.value;
  const json = parseJson(await request(apiKey, 'getServices'));
  const rowsRaw = Array.isArray(json) ? json : (Array.isArray(json?.services) ? json.services : []);
  const seen = new Set();
  const rows = rowsRaw.map(row => ({
    code: String(row?.id ?? row?.code ?? '').trim(),
    name: String(row?.name ?? row?.title ?? row?.id ?? '').trim()
  })).filter(row => row.code && row.name && /^[A-Za-z0-9_-]{1,24}$/.test(row.code))
    .filter(row => !seen.has(row.code) && seen.add(row.code))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  if (!rows.length) throw apiError('NO_SERVICES_AVAILABLE');
  servicesCache.at = Date.now(); servicesCache.value = rows;
  return rows;
}

async function listCountries(apiKey, force = false) {
  if (!force && countriesCache.value.length && Date.now() - countriesCache.at < COUNTRIES_TTL) return countriesCache.value;
  const json = parseJson(await request(apiKey, 'getCountries'));
  const rowsRaw = Array.isArray(json) ? json : (Array.isArray(json?.countries) ? json.countries : []);
  const seen = new Set();
  const rows = rowsRaw.map(row => ({
    id: String(row?.id ?? row?.country ?? '').trim(),
    name: String(row?.name_en ?? row?.eng ?? row?.en ?? row?.name ?? row?.title ?? row?.id ?? '').trim()
  })).filter(row => row.id && row.name).filter(row => !seen.has(row.id) && seen.add(row.id));
  if (!rows.length) throw apiError('NO_COUNTRIES_AVAILABLE');
  countriesCache.at = Date.now(); countriesCache.value = rows;
  return rows;
}

async function availableServicesSummary(apiKey, force = false) {
  if (!force && allPricesCache.value.length && Date.now() - allPricesCache.at < PRICES_TTL) return allPricesCache.value;
  // Keep summary prices in the same currency used for quote and purchase.
  // Otherwise SMS-MAN may return account-default prices while the bot treats
  // them as USD when ranking services.
  const json = parseJson(await request(apiKey, 'getPrices', { currency: 'USD' }));
  const map = new Map();
  if (json && typeof json === 'object') {
    for (const countryData of Object.values(json)) {
      if (!countryData || typeof countryData !== 'object') continue;
      for (const [serviceCode, serviceData] of Object.entries(countryData)) {
        const parsed = parsePrice(serviceData);
        if (!parsed || !/^[A-Za-z0-9_-]{1,24}$/.test(serviceCode)) continue;
        const current = map.get(serviceCode) || { serviceCode, count: 0, providerCost: Infinity };
        current.count += parsed.count;
        current.providerCost = Math.min(current.providerCost, parsed.providerCost);
        map.set(serviceCode, current);
      }
    }
  }
  const value = [...map.values()].filter(row => row.count > 0 && Number.isFinite(row.providerCost));
  allPricesCache.at = Date.now(); allPricesCache.value = value;
  return value;
}

async function availabilityForService(apiKey, serviceCode, force = false) {
  const code = String(serviceCode || '').trim();
  if (!/^[A-Za-z0-9_-]{1,24}$/.test(code)) throw apiError('BAD_SERVICE');
  const cached = pricesCache.get(code);
  if (!force && cached && Date.now() - cached.at < PRICES_TTL) return cached.value;
  const json = parseJson(await request(apiKey, 'getPrices', { service: code, currency: 'USD' }));
  const countries = await listCountries(apiKey).catch(() => []);
  const names = new Map(countries.map(row => [String(row.id), row.name]));
  const rows = [];
  if (json && typeof json === 'object') {
    for (const [countryId, countryData] of Object.entries(json)) {
      if (!countryData || typeof countryData !== 'object') continue;
      const parsed = parsePrice(countryData[code] || (('cost' in countryData || 'price' in countryData) ? countryData : null));
      if (!parsed) continue;
      rows.push({ countryId: String(countryId), countryName: names.get(String(countryId)) || `Country ${countryId}`, ...parsed });
    }
  }
  rows.sort((a, b) => a.providerCost - b.providerCost || a.countryName.localeCompare(b.countryName, 'en'));
  pricesCache.set(code, { at: Date.now(), value: rows });
  return rows;
}

async function quote(apiKey, serviceCode, countryId, force = false) {
  const rows = await availabilityForService(apiKey, serviceCode, force);
  return rows.find(row => String(row.countryId) === String(countryId)) || null;
}

async function allocate(apiKey, serviceCode, countryId, maxProviderCost) {
  const text = await request(apiKey, 'getNumber', {
    service: serviceCode,
    country: countryId,
    maxPrice: Number(maxProviderCost).toFixed(4),
    currency: 'USD'
  });
  if (text.startsWith('ACCESS_NUMBER:')) {
    const parts = text.split(':');
    return { activationId: String(parts[1] || '').trim(), phoneNumber: String(parts[2] || '').trim(), activationCost: Number(maxProviderCost), raw: { legacy: text } };
  }
  if (/^(NO_NUMBERS|NO_NUMBER|NO_BALANCE|NO_MONEY|ERROR_SQL|WRONG_MAX_PRICE|BAD_SERVICE|BAD_COUNTRY)/i.test(text)) throw apiError(text.split(':')[0].trim().toUpperCase(), text);
  throw apiError('BAD_PROVIDER_RESPONSE', text.slice(0, 300));
}

async function purchase(apiKey, { serviceCode, countryId, maxProviderCost }) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await allocate(apiKey, serviceCode, countryId, maxProviderCost); }
    catch (error) {
      if (!['NO_NUMBERS', 'NO_NUMBER', 'WRONG_MAX_PRICE'].includes(error.code)) throw error;
      lastError = error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 180));
    }
  }
  throw lastError || apiError('NO_NUMBERS');
}

async function getStatus(apiKey, activationId) { return request(apiKey, 'getStatus', { id: activationId }); }
async function cancel(apiKey, activationId) { return request(apiKey, 'setStatus', { id: activationId, status: -1 }); }
async function finish(apiKey, activationId) { return request(apiKey, 'setStatus', { id: activationId, status: 6 }); }

module.exports = { ID, NAME, BASE_URL, clearCaches, getBalance, listServices, listCountries, availableServicesSummary, availabilityForService, quote, purchase, getStatus, cancel, finish };
