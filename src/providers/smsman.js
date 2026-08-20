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
function responseText(value) { return typeof value === 'string' ? value.trim() : String(value ?? '').trim(); }
function providerErrorFromText(text) {
  const match = String(text || '').match(/^(BAD_KEY|BAD_ACTION|BAD_SERVICE|BAD_COUNTRY|NO_ACTIVATION|NO_NUMBERS|NO_NUMBER|NO_BALANCE|NO_MONEY|ERROR_SQL|WRONG_MAX_PRICE)/i);
  return match ? match[1].toUpperCase() : '';
}

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
    const detail = responseText(error?.response?.data);
    const providerCode = providerErrorFromText(detail);
    if (providerCode) throw apiError(providerCode, detail);
    throw apiError('PROVIDER_UNAVAILABLE', detail || error?.message || 'request failed');
  }
  const text = responseText(response.data);
  const providerCode = providerErrorFromText(text);
  if (providerCode) throw apiError(providerCode, text);
  return text;
}

function parsePrice(serviceData) {
  if (!serviceData || typeof serviceData !== 'object') return null;
  const offers = [];
  const visit = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || Array.isArray(node) || depth > 8) return;
    const directCost = Number(node.cost ?? node.price);
    const directCount = Number(node.count ?? node.qty ?? node.quantity ?? 0);
    if (Number.isFinite(directCost) && directCost >= 0 && Number.isFinite(directCount) && directCount > 0) {
      offers.push({ price: directCost, count: Math.floor(directCount) });
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const tierPrice = Number(key);
      const tierCount = Number(value && typeof value === 'object'
        ? (value.count ?? value.qty ?? value.quantity)
        : value);
      if (Number.isFinite(tierPrice) && tierPrice >= 0 && Number.isFinite(tierCount) && tierCount > 0) {
        offers.push({ price: tierPrice, count: Math.floor(tierCount) });
      } else if (value && typeof value === 'object') {
        visit(value, depth + 1);
      }
    }
  };
  visit(serviceData);
  if (!offers.length) return null;
  const cheapest = Math.min(...offers.map(row => row.price));
  const count = offers
    .filter(row => Math.abs(row.price - cheapest) < 1e-9)
    .reduce((sum, row) => sum + row.count, 0);
  return count > 0 ? { providerCost: cheapest, count } : null;
}

function mergeCheapest(map, serviceCode, parsed) {
  const current = map.get(serviceCode);
  if (!current || parsed.providerCost < current.providerCost - 1e-9) {
    map.set(serviceCode, { serviceCode, count: parsed.count, providerCost: parsed.providerCost });
  } else if (Math.abs(parsed.providerCost - current.providerCost) < 1e-9) {
    current.count += parsed.count;
  }
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
        mergeCheapest(map, serviceCode, parsed);
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
