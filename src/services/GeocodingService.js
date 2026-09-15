import axios from 'axios';
import cacheService from './CacheService.js';
import { sha256Hex } from './encryptionService.js';

/**
 * GeocodingService - turns a billing/mailing address into { lat, lng }
 * using Nominatim, OpenStreetMap's free, keyless geocoding API. Unlike
 * SalesforceService, this has no per-user/OAuth dependency - it's a plain
 * standalone HTTP client, safe to call for any address regardless of which
 * user's request triggered it.
 *
 * Nominatim's usage policy caps requests at ~1/second and requires a
 * descriptive User-Agent - see https://operations.osmfoundation.org/policies/nominatim/.
 * Two things keep this app well inside that limit:
 *  - every result is cached (via the shared Redis-backed cacheService) for
 *    30 days, keyed by a hash of the normalized address, so a given address
 *    is only ever sent to Nominatim once;
 *  - outboundQueue below serializes any still-uncached calls to one in
 *    flight at a time with a minimum gap between them.
 */
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'SalesPipelineIntelligence/1.0 (CRM territory map feature)';
const CACHE_PREFIX = 'geocode_';
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days - addresses don't move
const MIN_REQUEST_GAP_MS = 1100;

let queueTail = Promise.resolve();
let lastRequestAt = 0;

/**
 * Run `fn` after every previously-queued call has finished AND at least
 * MIN_REQUEST_GAP_MS has passed since the last actual Nominatim request -
 * enforced globally (module-level), not per-call, so concurrent geocode
 * requests for different addresses still serialize onto one 1-req/sec
 * stream instead of firing in parallel.
 */
const runThrottled = (fn) => {
  const run = async () => {
    const wait = Math.max(0, MIN_REQUEST_GAP_MS - (Date.now() - lastRequestAt));
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    return fn();
  };

  const result = queueTail.then(run, run);
  // Keep the chain alive even if this call rejects - a failed geocode must
  // not permanently wedge every geocode after it.
  queueTail = result.catch(() => {});
  return result;
};

const buildQueryString = ({ street, city, state, postalCode, country }) =>
  [street, city, state, postalCode, country].filter(Boolean).join(', ');

export const geocodeAddress = async (address) => {
  const queryString = buildQueryString(address || {});
  if (!queryString) return null;

  const cacheKey = `${CACHE_PREFIX}${sha256Hex(queryString.toLowerCase())}`;
  // A cached miss is stored as `null` (see below), which CacheService.get()
  // can't distinguish from "never cached" (both come back as `null`) - so
  // check existence first via has()/EXISTS, which can.
  if (await cacheService.has(cacheKey)) {
    return cacheService.get(cacheKey);
  }

  const result = await runThrottled(async () => {
    try {
      const response = await axios.get(NOMINATIM_URL, {
        params: { q: queryString, format: 'jsonv2', limit: 1 },
        headers: { 'User-Agent': USER_AGENT },
        timeout: 8000,
      });

      const match = response.data?.[0];
      if (!match) return null;

      return { lat: parseFloat(match.lat), lng: parseFloat(match.lon) };
    } catch (err) {
      console.error(`❌ Geocoding failed for "${queryString}":`, err.message);
      return null;
    }
  });

  // Cache the miss too (as `null`) - an address Nominatim can't resolve
  // isn't going to resolve differently five minutes from now, so this
  // avoids re-querying (and re-waiting out the rate limit for) the same
  // ungeocodable address on every future request.
  await cacheService.set(cacheKey, result, CACHE_TTL_SECONDS);
  return result;
};

export default { geocodeAddress };
