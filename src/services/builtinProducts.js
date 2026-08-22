const { Merchant } = require('../db');
const config = require('../config');

const GEMINI_18M_NETWORK_ID = 'builtin-gemini-18m-v14';
const GEMINI_18M_OWNER_NOTE = 'Builtin Gemini 18M';
const GEMINI_18M_TIERS = Object.freeze([
  { min: 1, max: 9, price: 0.50 },
  { min: 10, max: 49, price: 0.40 },
  { min: 50, max: 99, price: 0.35 },
  { min: 100, max: 499, price: 0.30 },
  { min: 500, max: 1000, price: 0.25 }
]);

function isGemini18mProduct(product) {
  return Boolean(product && String(product.networkProductId || '') === GEMINI_18M_NETWORK_ID);
}

async function ensureGemini18MonthProduct() {
  if (String(config.network.role || '') !== 'master') return { created: false, product: null, skipped: true };

  const defaults = {
    networkProductId: GEMINI_18M_NETWORK_ID,
    nameAr: 'جمناي 18 شهر',
    nameEn: 'Gemini 18 Months',
    price: 0.50,
    networkBasePriceUsd: 0.50,
    networkSupplierPriceUsd: 0.40,
    localPriceOverrideUsd: null,
    category: 'Gemini',
    type: 'code',
    description: {
      ar: 'رابط تفعيل Gemini لمدة 18 شهر. خصم الكمية يُحسب تلقائياً حسب الكمية والمخزون المتوفر.',
      en: 'Gemini 18-month activation link. Quantity pricing is calculated automatically from the requested quantity and available stock.',
      warrantyAr: '24H — 24 ساعة',
      warrantyEn: '24H — 24 hours',
      sold: 0,
      builtinProduct: 'gemini18m'
    },
    image: null,
    isActive: true,
    sharedLimit: 1,
    deliveryMode: 'instant',
    sortOrder: 0,
    ownerNote: GEMINI_18M_OWNER_NOTE,
    networkManaged: false,
    networkOwnerShopId: 'master',
    networkStock: 0,
    visibilityScope: 'public',
    localPublicationStatus: 'published',
    networkDistributionEnabled: true,
    quantityPricingTiers: GEMINI_18M_TIERS,
    quantityPricingOwnerOnly: true,
    maxPurchaseQuantity: 1000
  };

  let product = await Merchant.findOne({ where: { networkProductId: GEMINI_18M_NETWORK_ID } });
  let created = false;

  // If the owner already created a product with the exact requested name,
  // adopt that row instead of creating a duplicate. Existing stock remains
  // attached to the same merchant id. This adoption happens only once because
  // the stable networkProductId is written immediately.
  if (!product) {
    const sameNameRows = await Merchant.findAll({ where: { nameAr: 'جمناي 18 شهر', type: 'code' } });
    product = sameNameRows.find(row => {
      const owner = String(row.networkOwnerShopId || 'master');
      return owner === 'master' && row.networkManaged !== true;
    }) || null;
    if (product) {
      await product.update({
        networkProductId: GEMINI_18M_NETWORK_ID,
        networkBasePriceUsd: 0.50,
        networkSupplierPriceUsd: 0.40,
        networkOwnerShopId: 'master',
        visibilityScope: 'public',
        localPublicationStatus: 'published',
        networkDistributionEnabled: true,
        quantityPricingTiers: GEMINI_18M_TIERS,
        quantityPricingOwnerOnly: true,
        maxPurchaseQuantity: 1000
      });
      created = true;
    } else {
      product = await Merchant.create(defaults);
      created = true;
    }
  }

  // Keep the pricing engine fields healthy for installations where an earlier
  // preview created the row before all v14 columns existed. Do not overwrite
  // normal admin-editable content on every restart.
  const patch = {};
  if (!Array.isArray(product.quantityPricingTiers) || !product.quantityPricingTiers.length) patch.quantityPricingTiers = GEMINI_18M_TIERS;
  if (product.quantityPricingOwnerOnly !== true) patch.quantityPricingOwnerOnly = true;
  if (!(Number(product.maxPurchaseQuantity) >= 1000)) patch.maxPurchaseQuantity = 1000;
  if (!(Number(product.networkSupplierPriceUsd) > 0)) patch.networkSupplierPriceUsd = 0.40;
  const currentDescription = product.description && typeof product.description === 'object' && !Array.isArray(product.description)
    ? { ...product.description }
    : { ar: String(product.description || ''), en: '' };
  if (currentDescription.warrantyAr !== '24H — 24 ساعة' || currentDescription.warrantyEn !== '24H — 24 hours') {
    patch.description = {
      ...currentDescription,
      warrantyAr: '24H — 24 ساعة',
      warrantyEn: '24H — 24 hours',
      builtinProduct: 'gemini18m'
    };
  }
  if (String(product.visibilityScope || '').toLowerCase() !== 'public') patch.visibilityScope = 'public';
  if (product.networkDistributionEnabled === false) patch.networkDistributionEnabled = true;
  if (Object.keys(patch).length) await product.update(patch);

  return { created, product: Object.keys(patch).length ? await Merchant.findByPk(product.id) : product };
}

module.exports = {
  GEMINI_18M_NETWORK_ID,
  GEMINI_18M_TIERS,
  isGemini18mProduct,
  ensureGemini18MonthProduct
};
