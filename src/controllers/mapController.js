import SalesforceService from '../services/salesforceService.js';
import cacheService from '../services/CacheService.js';
import { geocodeAddress } from '../services/GeocodingService.js';

/**
 * @route   GET /api/salesforce/map/accounts
 * @desc    Accounts geocoded from their billing address, each annotated
 *          with its opportunity count + pipeline value - powers the
 *          territory map (AccountsMap.jsx). Accounts with no usable
 *          address are returned separately under `ungeocoded` rather than
 *          dropped or erroring the whole request.
 * @access  Private
 */
export const getAccountsMap = async (req, res) => {
  try {
    const { limit = 100, offset = 0 } = req.query;
    const cacheKey = `map_accounts_${req.user._id}_${limit}_${offset}`;

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({ success: true, data: cached, source: 'cache' });
    }

    const salesforce = new SalesforceService(req.user);
    const accountsResult = await salesforce.getAccounts({
      limit: Math.min(parseInt(limit), 500),
      offset: Math.max(0, parseInt(offset)),
    });
    const accountRecords = accountsResult.records || [];

    const totalsByAccountId = await salesforce.getOpportunityTotalsByAccountIds(
      accountRecords.map((account) => account.Id)
    );

    const accounts = [];
    const ungeocoded = [];

    // Sequential (not Promise.all) so every geocode call funnels through
    // GeocodingService's single throttled queue one at a time, rather than
    // firing a burst of concurrent requests at Nominatim.
    for (const account of accountRecords) {
      const hasAddress = account.BillingCity || account.BillingStreet;
      const totals = totalsByAccountId[account.Id] || { opportunityCount: 0, pipelineValue: 0 };

      if (!hasAddress) {
        ungeocoded.push({ id: account.Id, name: account.Name, reason: 'No billing address on file' });
        continue;
      }

      const coords = await geocodeAddress({
        street: account.BillingStreet,
        city: account.BillingCity,
        state: account.BillingState,
        postalCode: account.BillingPostalCode,
        country: account.BillingCountry,
      });

      if (!coords) {
        ungeocoded.push({ id: account.Id, name: account.Name, reason: 'Address could not be located' });
        continue;
      }

      accounts.push({
        id: account.Id,
        name: account.Name,
        lat: coords.lat,
        lng: coords.lng,
        city: account.BillingCity,
        state: account.BillingState,
        opportunityCount: totals.opportunityCount,
        pipelineValue: totals.pipelineValue,
      });
    }

    const data = { accounts, ungeocoded };
    await cacheService.set(cacheKey, data, 300);

    res.status(200).json({ success: true, data, source: 'salesforce' });
  } catch (error) {
    console.error('Error building accounts map:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

export default { getAccountsMap };
