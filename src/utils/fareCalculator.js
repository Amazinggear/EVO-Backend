'use strict';

/**
 * EVO Fare Calculator
 * ───────────────────────────────────────────────────────────────────
 * Handles fare computation for all 5 EVO car types:
 *   ev_mini | ev_taxi | ev_sedan | ev_suv | ev_luxury
 *
 * ev_taxi uses Jordan's official meter tariffs (day / night).
 * All other types use configurable pricing with built-in defaults.
 *
 * Exports: { calculateFare, haversineDistance, co2Saved }
 */

// ─────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────

/** Petrol CO₂ emission factor: 0.21 kg CO₂ saved per km vs a petrol vehicle. */
const CO2_PETROL_KG_PER_KM = 0.21;

/** Earth's mean radius in km (WGS-84 approximation). */
const EARTH_RADIUS_KM = 6371.0088;

/**
 * Default fare parameters per car type (all amounts in JOD).
 * ev_taxi overrides these with tariff_type-specific rates below.
 */
const DEFAULT_PRICING = {
  ev_mini: {
    baseFare:  0.30,
    perKm:     0.20,
    perMin:    0.02,
    minFare:   1.00,
  },
  ev_sedan: {
    baseFare:  0.35,
    perKm:     0.22,
    perMin:    0.03,
    minFare:   1.20,
  },
  ev_suv: {
    baseFare:  0.40,
    perKm:     0.25,
    perMin:    0.03,
    minFare:   1.30,
  },
  ev_luxury: {
    baseFare:  0.50,
    perKm:     0.35,
    perMin:    0.04,
    minFare:   2.00,
  },
};

/**
 * Jordan official taxi meter rates (JOD).
 * Source: Jordan Land Transport Regulatory Commission (LTRC) tariff schedule.
 */
const EV_TAXI_TARIFFS = {
  day: {
    baseFare: 0.450,
    perKm:    0.316,
    perMin:   0.060,
    minFare:  0.450,   // flag-fall is the minimum for day
  },
  night: {
    baseFare: 0.462,
    perKm:    0.389,
    perMin:   0.070,
    minFare:  0.462,   // flag-fall is the minimum for night
  },
};

// ─────────────────────────────────────────────────────────────────
// Haversine Distance
// ─────────────────────────────────────────────────────────────────

/**
 * Computes the great-circle distance between two GPS coordinates.
 *
 * @param {number} lat1 - Origin latitude  (decimal degrees)
 * @param {number} lon1 - Origin longitude (decimal degrees)
 * @param {number} lat2 - Destination latitude  (decimal degrees)
 * @param {number} lon2 - Destination longitude (decimal degrees)
 * @returns {number} Distance in kilometres (rounded to 3 decimal places)
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return parseFloat((EARTH_RADIUS_KM * c).toFixed(3));
}

// ─────────────────────────────────────────────────────────────────
// CO₂ Savings
// ─────────────────────────────────────────────────────────────────

/**
 * Estimates the CO₂ mass (in kg) saved by taking an EV ride
 * instead of a comparable petrol vehicle over the same distance.
 *
 * Uses 0.21 kg CO₂/km as the petrol baseline.
 * EV direct emissions are treated as 0 at the point of use.
 *
 * @param {number} distanceKm
 * @returns {number} CO₂ saved in kg (rounded to 3 decimal places)
 */
function co2Saved(distanceKm) {
  if (typeof distanceKm !== 'number' || distanceKm < 0) return 0;
  return parseFloat((distanceKm * CO2_PETROL_KG_PER_KM).toFixed(3));
}

// ─────────────────────────────────────────────────────────────────
// Promo Code Helper
// ─────────────────────────────────────────────────────────────────

/**
 * Resolves a promo code discount from the pricing config.
 * The promo_codes map in pricingConfig is keyed by uppercase code and
 * contains `{ discount_type: 'percent'|'fixed', discount_value: number }`.
 *
 * Returns the discount amount in JOD (0 if code is invalid / expired).
 *
 * @param {string}  code
 * @param {object}  pricingConfig
 * @param {number}  rawFare - pre-discount, pre-surge fare
 * @returns {number}
 */
function _resolvePromoDiscount(code, pricingConfig, rawFare) {
  if (!code || !pricingConfig?.promo_codes) return 0;

  const promo = pricingConfig.promo_codes[code.toUpperCase()];
  if (!promo) return 0;

  if (promo.discount_type === 'percent') {
    const pct = Math.min(100, Math.max(0, promo.discount_value));
    return parseFloat(((rawFare * pct) / 100).toFixed(3));
  }

  if (promo.discount_type === 'fixed') {
    return Math.min(rawFare, Math.max(0, promo.discount_value));
  }

  return 0;
}

// ─────────────────────────────────────────────────────────────────
// Main Fare Calculator
// ─────────────────────────────────────────────────────────────────

/**
 * Calculates the total ride fare for an EVO trip.
 *
 * Algorithm (for non-taxi types):
 *   rawFare  = baseFare + (distanceKm × perKm) + (durationMin × perMin)
 *   surged   = rawFare × surgeMultiplier
 *   discounted = surged − promoDiscount
 *   final    = max(discounted, minFare)   ← floor is always applied
 *
 * For ev_taxi, the same formula applies but uses the LTRC tariff rates
 * selected by tariff_type ('day' | 'night'). Surge can still apply.
 *
 * @param {object} params
 * @param {string} params.carType          - One of: ev_mini | ev_taxi | ev_sedan | ev_suv | ev_luxury
 * @param {number} params.distanceKm       - Trip distance in kilometres
 * @param {number} params.durationMin      - Trip duration in minutes
 * @param {number} [params.surgeMultiplier=1.0] - Surge pricing multiplier (≥ 1.0)
 * @param {object} [params.pricingConfig]  - DB pricing row for this car type (overrides defaults)
 * @param {string} [params.promoCode]      - Optional promo code string
 * @param {string} [params.tariffType='day'] - 'day' or 'night' (ev_taxi only)
 *
 * @returns {{
 *   carType: string,
 *   distanceKm: number,
 *   durationMin: number,
 *   baseFare: number,
 *   distanceFare: number,
 *   timeFare: number,
 *   rawFare: number,
 *   surgeMultiplier: number,
 *   surgedFare: number,
 *   promoDiscount: number,
 *   minFare: number,
 *   totalFare: number,
 *   currency: string,
 *   co2SavedKg: number,
 *   tariffType: string|null
 * }}
 */
function calculateFare({
  carType,
  distanceKm,
  durationMin,
  surgeMultiplier = 1.0,
  pricingConfig   = null,
  promoCode       = null,
  tariffType      = 'day',
}) {
  // ── Input guards ─────────────────────────────────────────────────
  if (typeof distanceKm !== 'number' || distanceKm < 0) {
    throw new TypeError('distanceKm must be a non-negative number');
  }
  if (typeof durationMin !== 'number' || durationMin < 0) {
    throw new TypeError('durationMin must be a non-negative number');
  }
  const surge = Math.max(1.0, typeof surgeMultiplier === 'number' ? surgeMultiplier : 1.0);

  // ── Select pricing rates ─────────────────────────────────────────
  let rates;
  let resolvedTariffType = null;

  if (carType === 'ev_taxi') {
    resolvedTariffType = tariffType === 'night' ? 'night' : 'day';
    rates = EV_TAXI_TARIFFS[resolvedTariffType];
  } else {
    // pricingConfig from DB takes priority; fall back to hardcoded defaults.
    const defaults = DEFAULT_PRICING[carType];
    if (!defaults) {
      throw new Error(
        `Unknown carType "${carType}". Must be one of: ev_mini, ev_taxi, ev_sedan, ev_suv, ev_luxury`
      );
    }
    rates = {
      baseFare: pricingConfig?.base_fare  ?? pricingConfig?.baseFare ?? defaults.baseFare,
      perKm:    pricingConfig?.per_km     ?? pricingConfig?.perKmRate ?? pricingConfig?.perKm ?? defaults.perKm,
      perMin:   pricingConfig?.per_minute ?? pricingConfig?.perMinRate ?? pricingConfig?.perMin ?? defaults.perMin,
      minFare:  pricingConfig?.min_fare   ?? pricingConfig?.minFare ?? defaults.minFare,
    };
  }

  // ── Fare components ─────────────────────────────────────────────
  const distanceFare = parseFloat((distanceKm  * rates.perKm).toFixed(4));
  const timeFare     = parseFloat((durationMin * rates.perMin).toFixed(4));
  const rawFare      = parseFloat((rates.baseFare + distanceFare + timeFare).toFixed(4));

  // ── Surge ────────────────────────────────────────────────────────
  const surgedFare = parseFloat((rawFare * surge).toFixed(4));

  // ── Promo ────────────────────────────────────────────────────────
  const promoDiscount = promoCode
    ? _resolvePromoDiscount(promoCode, pricingConfig, surgedFare)
    : 0;

  const afterPromo = parseFloat((surgedFare - promoDiscount).toFixed(4));

  // ── Minimum fare floor ───────────────────────────────────────────
  const totalFare = parseFloat(Math.max(afterPromo, rates.minFare).toFixed(3));

  // ── CO₂ savings ──────────────────────────────────────────────────
  const co2SavedKg = co2Saved(distanceKm);

  return {
    carType,
    distanceKm:      parseFloat(distanceKm.toFixed(3)),
    durationMin:     parseFloat(durationMin.toFixed(2)),
    baseFare:        parseFloat(rates.baseFare.toFixed(3)),
    distanceFare:    parseFloat(distanceFare.toFixed(3)),
    timeFare:        parseFloat(timeFare.toFixed(3)),
    rawFare:         parseFloat(rawFare.toFixed(3)),
    surgeMultiplier: surge,
    surgedFare:      parseFloat(surgedFare.toFixed(3)),
    promoDiscount:   parseFloat(promoDiscount.toFixed(3)),
    minFare:         parseFloat(rates.minFare.toFixed(3)),
    totalFare,
    currency:        'JOD',
    co2SavedKg,
    tariffType:      resolvedTariffType,
  };
}

// ─────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────

module.exports = { calculateFare, haversineDistance, co2Saved };
