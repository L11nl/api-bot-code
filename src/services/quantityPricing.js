const config = require('../config');

function currentShopId() {
  if (String(config.network.role || '') === 'client') return String(config.network.shopId || '');
  if (String(config.network.role || '') === 'master') return 'master';
  return String(config.network.shopId || 'master');
}

function effectiveProductPrice(product) {
  const base = Math.max(0, Number(product?.price || 0));
  const override = product?.localPriceOverrideUsd == null ? NaN : Number(product.localPriceOverrideUsd);
  return Number.isFinite(override) && override >= 0 ? override : base;
}

function normalizeTiers(raw) {
  const rows = Array.isArray(raw) ? raw : [];
  return rows.map(row => ({
    min: Math.max(1, Math.floor(Number(row?.min || 1))),
    max: Math.max(1, Math.floor(Number(row?.max || row?.min || 1))),
    price: Math.max(0, Number(row?.price || 0))
  })).filter(row => Number.isFinite(row.price) && row.max >= row.min)
    .sort((a, b) => a.min - b.min || a.max - b.max);
}

function quantityPricingApplies(product) {
  const tiers = normalizeTiers(product?.quantityPricingTiers);
  if (!tiers.length) return false;
  if (product?.quantityPricingOwnerOnly === true) {
    const owner = String(product?.networkOwnerShopId || (product?.networkManaged ? '' : currentShopId()) || 'master');
    if (owner !== currentShopId()) return false;
  }
  return true;
}

function unitPriceForQuantity(product, quantity) {
  const fallback = effectiveProductPrice(product);
  const qty = Math.max(1, Math.floor(Number(quantity || 1)));
  if (!quantityPricingApplies(product)) return fallback;
  const tiers = normalizeTiers(product.quantityPricingTiers);
  let selected = null;
  for (const tier of tiers) {
    if (qty >= tier.min && qty <= tier.max) {
      selected = tier;
      break;
    }
    if (qty >= tier.min) selected = tier;
  }
  return selected ? Number(selected.price) : fallback;
}

function maxPurchaseQuantity(product, stock = Infinity) {
  const configured = Math.max(1, Math.floor(Number(product?.maxPurchaseQuantity || 100)));
  if (String(product?.type || '') === 'service' || String(product?.type || '') === 'shared') return 1;
  const available = Number.isFinite(Number(stock)) ? Math.max(0, Math.floor(Number(stock))) : configured;
  return Math.max(0, Math.min(configured, available));
}

function availableTiers(product, stock) {
  if (!quantityPricingApplies(product)) return [];
  const available = Math.max(0, Math.floor(Number(stock || 0)));
  if (available < 1) return [];
  return normalizeTiers(product.quantityPricingTiers)
    .filter(tier => tier.min <= available)
    .map(tier => ({ ...tier, visibleMax: Math.min(tier.max, available) }));
}

function networkSupplierUnitPrice(product) {
  const value = product?.networkSupplierPriceUsd == null ? NaN : Number(product.networkSupplierPriceUsd);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

module.exports = {
  currentShopId,
  effectiveProductPrice,
  normalizeTiers,
  quantityPricingApplies,
  unitPriceForQuantity,
  maxPurchaseQuantity,
  availableTiers,
  networkSupplierUnitPrice
};
