/** Спільна логіка цін для каталогу та рекомендованих карток. */

export function findRule(rules, type, brand, id, supplier) {
  if (!rules?.rules || !Array.isArray(rules.rules)) return null;

  for (const rule of rules.rules) {
    if (rule.type === "product" && type === "product" && rule.brand === brand && rule.id === id) {
      return rule;
    }
    if (rule.type === "brand" && type === "brand" && rule.brand === brand) {
      return rule;
    }
    if (rule.type === "supplier" && type === "supplier" && rule.supplier === supplier) {
      return rule;
    }
  }
  return null;
}

function ruleAdjustment(rule) {
  if (rule.adjustment !== undefined) {
    return Number(rule.adjustment || 0);
  }
  const discount = Number(rule.discount || 0);
  const markup = Number(rule.markup || 0);
  return markup - discount;
}

export function calculatePriceWithRules(product, offer, clientPricingRules, defaultPriceType = "роздріб") {
  if (!offer?.publicPrices) return 0;

  let priceGroup = defaultPriceType || "роздріб";
  let adjustment = 0;

  if (clientPricingRules?.rules) {
    const productRule = findRule(clientPricingRules, "product", product.brand, product.id, null);
    if (productRule) {
      priceGroup = productRule.priceGroup;
      adjustment = ruleAdjustment(productRule);
    } else {
      const brandRule = findRule(clientPricingRules, "brand", product.brand, null, null);
      if (brandRule) {
        priceGroup = brandRule.priceGroup;
        adjustment = ruleAdjustment(brandRule);
      } else {
        const supplierRule = findRule(clientPricingRules, "supplier", null, null, offer.supplier);
        if (supplierRule) {
          priceGroup = supplierRule.priceGroup;
          adjustment = ruleAdjustment(supplierRule);
        }
      }
    }
  }

  let basePrice = offer.publicPrices[priceGroup];
  if (!basePrice || basePrice <= 0) {
    basePrice = offer.publicPrices.роздріб;
    if (!basePrice || basePrice <= 0) return 0;
  }

  let price = basePrice * (1 + adjustment / 100);

  if (clientPricingRules) {
    let globalAdjustment = 0;
    if (clientPricingRules.globalAdjustment !== undefined) {
      globalAdjustment = Number(clientPricingRules.globalAdjustment || 0);
    } else {
      const globalDiscount = Number(clientPricingRules.globalDiscount || 0);
      const globalMarkup = Number(clientPricingRules.globalMarkup || 0);
      globalAdjustment = globalMarkup - globalDiscount;
    }
    price = price * (1 + globalAdjustment / 100);
  }

  return Math.ceil(price * 100) / 100;
}

export function getPriceFromPublicPrices(publicPrices, priceType) {
  if (!publicPrices || typeof publicPrices !== "object") return null;
  return publicPrices[priceType] ?? null;
}

/**
 * Ціна для відображення з урахуванням правил клієнта та валюти.
 */
export function calculateProductPrice({
  product,
  offer = null,
  client,
  clientPricingRules,
  selectedCurrency = "EUR",
  uahRate = null,
}) {
  const priceType = client?.priceType || "роздріб";
  let price = 0;
  const productRef = { brand: product.brand, id: product.id };

  if (clientPricingRules && offer) {
    price = calculatePriceWithRules(productRef, offer, clientPricingRules, priceType);
  } else if (offer) {
    price = offer.publicPrices?.[priceType] ?? 0;
  } else if (product.offers?.length) {
    const myWarehouseOffer = product.offers.find((o) => o.supplier === "Мій склад");
    if (!myWarehouseOffer) return 0;
    if (clientPricingRules) {
      price = calculatePriceWithRules(productRef, myWarehouseOffer, clientPricingRules, priceType);
    } else {
      price = myWarehouseOffer.publicPrices?.[priceType] ?? 0;
    }
  }

  if (selectedCurrency === "UAH" && uahRate > 0 && price > 0) {
    price = Math.round(price * uahRate * 100) / 100;
  }

  return price;
}

/** Фільтр і сортування offers (як у ProductCatalog). */
export function filterAndSortOffers(
  product,
  {
    showOnlyPartners = false,
    showOnlyInStock = false,
    isArticleSearchActive = false,
    clientPricingRules = null,
    client = null,
  } = {}
) {
  if (!product?.offers?.length) return [];

  let filteredOffers = product.offers;

  if (!isArticleSearchActive) {
    if (!showOnlyPartners) {
      filteredOffers = filteredOffers.filter((o) => o.supplier === "Мій склад");
    }
    if (showOnlyInStock) {
      filteredOffers = filteredOffers.filter((o) => (o.stock || 0) > 0);
    }
  }

  if (filteredOffers.length === 0) return [];

  const priceType = client?.priceType || "роздріб";
  const productRef = { brand: product.brand, id: product.id };

  filteredOffers = [...filteredOffers].sort((a, b) => {
    if (a.supplier === "Мій склад" && b.supplier !== "Мій склад") return -1;
    if (a.supplier !== "Мій склад" && b.supplier === "Мій склад") return 1;

    const priceA = clientPricingRules
      ? calculatePriceWithRules(productRef, a, clientPricingRules, priceType)
      : (getPriceFromPublicPrices(a.publicPrices, priceType) ?? Infinity);
    const priceB = clientPricingRules
      ? calculatePriceWithRules(productRef, b, clientPricingRules, priceType)
      : (getPriceFromPublicPrices(b.publicPrices, priceType) ?? Infinity);
    return priceA - priceB;
  });

  return filteredOffers;
}

export function pickPrimaryOffer(product, options) {
  const offers = filterAndSortOffers(product, options);
  return offers[0] || null;
}
