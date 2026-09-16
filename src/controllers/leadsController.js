
import SalesforceService, { soqlEscape } from '../services/salesforceService.js';
import cacheService from '../services/CacheService.js';
import AuditLogger from '../services/AuditLogger.js';
import NotificationService from '../services/NotificationService.js';
import { scoreLead, scoreLeads } from '../services/LeadScoringService.js';

const invalidateLeadCaches = async (userId, id) => {
  const tasks = [cacheService.deleteByPrefix(`leads_${userId}`)];
  if (id) tasks.push(cacheService.delete(`lead_${userId}_${id}`));
  await Promise.all(tasks);
};

const recordActivity = async (req, { action, eventType, resourceId, changes, title, message }) => {
  NotificationService.notify(req.user._id.toString(), eventType, { title, message, resourceId, changes });

  await AuditLogger.log(action, {
    userId: req.user._id,
    resourceType: 'Lead',
    resourceId,
    eventType,
    title,
    message,
    changes,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  }).catch((err) => console.error('Failed to audit-log lead activity:', err.message));
};

/**
 * @route   GET /api/salesforce/leads
 * @desc    List open (unconverted) leads with computed scores, filterable
 *          by Status/Rating, cached like every other list endpoint here.
 * @access  Private
 */
export const getLeads = async (req, res) => {
  try {
    const { limit = 50, offset = 0, status, rating, search } = req.query;
    const cacheKey = `leads_${req.user._id}_${limit}_${offset}_${status}_${rating}_${search}`;

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({ success: true, data: cached, source: 'cache' });
    }

    const salesforce = new SalesforceService(req.user);
    const result = await salesforce.getLeads({
      limit: Math.min(parseInt(limit), 200),
      offset: Math.max(0, parseInt(offset)),
      status,
      rating,
      searchTerm: search,
    });

    const scored = scoreLeads(result.records);
    const payload = { ...result, records: scored };

    await cacheService.set(cacheKey, payload, 180);

    res.status(200).json({ success: true, data: payload, source: 'salesforce' });
  } catch (error) {
    console.error('Error fetching leads:', error);
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/salesforce/leads/:id
 * @desc    Single lead with full score breakdown
 * @access  Private
 */
export const getLeadById = async (req, res) => {
  try {
    const { id } = req.params;
    const cacheKey = `lead_${req.user._id}_${id}`;

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({ success: true, data: cached, source: 'cache' });
    }

    const salesforce = new SalesforceService(req.user);
    const result = await salesforce.getLeadById(id);

    if (result.records.length === 0) {
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    const lead = { ...result.records[0], scoreData: scoreLead(result.records[0]) };
    await cacheService.set(cacheKey, lead, 180);

    res.status(200).json({ success: true, data: lead });
  } catch (error) {
    console.error('Error fetching lead:', error);
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/salesforce/leads
 * @desc    Create a lead
 * @access  Private
 */
export const createLead = async (req, res) => {
  try {
    const { FirstName, LastName, Company, Title, Email, Phone, Status, LeadSource, Industry, AnnualRevenue, NumberOfEmployees } = req.body;

    if (!LastName || !Company) {
      return res.status(400).json({ success: false, message: 'Last name and company are required' });
    }

    const salesforce = new SalesforceService(req.user);
    const result = await salesforce.createLead({
      FirstName,
      LastName,
      Company,
      Title,
      Email,
      Phone,
      Status: Status || 'Open - Not Contacted',
      LeadSource,
      Industry,
      AnnualRevenue: AnnualRevenue ? parseFloat(AnnualRevenue) : null,
      NumberOfEmployees: NumberOfEmployees ? parseInt(NumberOfEmployees, 10) : null,
    });

    await invalidateLeadCaches(req.user._id);

    await recordActivity(req, {
      action: 'CREATE',
      eventType: 'lead.created',
      resourceId: result.id,
      changes: { Company, LastName },
      title: 'Lead created',
      message: `${FirstName || ''} ${LastName} (${Company}) was added as a lead`,
    });

    res.status(201).json({ success: true, message: 'Lead created successfully', data: result });
  } catch (error) {
    console.error('Error creating lead:', error);
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

/**
 * @route   PATCH /api/salesforce/leads/:id
 * @desc    Update a lead (status changes, contact info, etc)
 * @access  Private
 */
export const updateLead = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = { ...req.body };

    if (updates.AnnualRevenue !== undefined) updates.AnnualRevenue = parseFloat(updates.AnnualRevenue) || null;
    if (updates.NumberOfEmployees !== undefined) updates.NumberOfEmployees = parseInt(updates.NumberOfEmployees, 10) || null;

    const salesforce = new SalesforceService(req.user);
    await salesforce.updateLead(id, updates);

    await invalidateLeadCaches(req.user._id, id);

    await recordActivity(req, {
      action: 'UPDATE',
      eventType: 'lead.updated',
      resourceId: id,
      changes: updates,
      title: 'Lead updated',
      message: `A lead was updated`,
    });

    res.status(200).json({ success: true, message: 'Lead updated successfully' });
  } catch (error) {
    console.error('Error updating lead:', error);
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

/**
 * @route   DELETE /api/salesforce/leads/:id
 * @desc    Delete a lead
 * @access  Private
 */
export const deleteLead = async (req, res) => {
  try {
    const { id } = req.params;
    const salesforce = new SalesforceService(req.user);
    await salesforce.deleteLead(id);

    await invalidateLeadCaches(req.user._id, id);

    await recordActivity(req, {
      action: 'DELETE',
      eventType: 'lead.deleted',
      resourceId: id,
      title: 'Lead deleted',
      message: 'A lead was deleted',
    });

    res.status(200).json({ success: true, message: 'Lead deleted successfully' });
  } catch (error) {
    console.error('Error deleting lead:', error);
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/salesforce/leads/meta/statuses
 * @desc    This org's configured Lead Status values, flagged by whether
 *          each one is a "converted" status - the frontend uses this to
 *          populate both the normal Status dropdown and the Convert
 *          dialog's status choice, instead of a hardcoded guess.
 * @access  Private
 */
export const getLeadStatuses = async (req, res) => {
  try {
    const cacheKey = `lead_statuses_${req.user._id}`;
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({ success: true, data: cached, source: 'cache' });
    }

    const salesforce = new SalesforceService(req.user);
    const statuses = await salesforce.getLeadStatuses();

    // Rarely changes - an hour's cache is fine and cuts a describe-style
    // call off the hot path of opening the create/convert forms.
    await cacheService.set(cacheKey, statuses, 3600);

    res.status(200).json({ success: true, data: statuses });
  } catch (error) {
    console.error('Error fetching lead statuses:', error);
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/salesforce/leads/:id/convert
 * @desc    Convert a lead into an Account + Contact (+ Opportunity)
 * @access  Private
 */
export const convertLead = async (req, res) => {
  try {
    const { id } = req.params;
    const { convertedStatus, createOpportunity = true, opportunityName } = req.body;

    if (!convertedStatus) {
      return res.status(400).json({ success: false, message: 'convertedStatus is required (a Closed/Converted Lead Status)' });
    }

    const salesforce = new SalesforceService(req.user);
    const result = await salesforce.convertLead(id, { convertedStatus, createOpportunity, opportunityName });

    if (!result?.isSuccess) {
      const message = result?.errors?.map((e) => e.message).join('; ') || 'Lead conversion failed';
      return res.status(400).json({ success: false, message });
    }

    await invalidateLeadCaches(req.user._id, id);
    // A converted lead becomes a live Account/Contact/Opportunity - every
    // list that reads those objects is now stale too.
    await cacheService.deleteByPrefix(`accounts_${req.user._id}`);
    await cacheService.deleteByPrefix(`contacts_${req.user._id}`);
    await cacheService.deleteByPrefix(`opp_list_${req.user._id}`);

    const outputs = result.outputValues || result;

    await recordActivity(req, {
      action: 'UPDATE',
      eventType: 'lead.converted',
      resourceId: id,
      changes: { accountId: outputs.accountId, contactId: outputs.contactId, opportunityId: outputs.opportunityId },
      title: 'Lead converted',
      message: 'A lead was converted to an account/contact',
    });

    res.status(200).json({
      success: true,
      message: 'Lead converted successfully',
      data: {
        accountId: outputs.accountId,
        contactId: outputs.contactId,
        opportunityId: outputs.opportunityId || null,
      },
    });
  } catch (error) {
    console.error('Error converting lead:', error);
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

const MAX_BULK_CONVERT = 50;

/**
 * @route   POST /api/salesforce/leads/bulk-convert
 * @desc    Convert several leads in one Salesforce SOAP call (see
 *          salesforceService.convertLeads - Salesforce natively batches up
 *          to 200 leadConverts per request; this endpoint caps it at 50 to
 *          keep response times and per-lead error reporting manageable in
 *          the UI). A partial failure never fails the whole request - each
 *          lead gets its own success/error in the response so the caller
 *          can show exactly which ones converted.
 * @access  Private
 */
export const bulkConvertLeads = async (req, res) => {
  try {
    const { leadIds, convertedStatus, createOpportunity = true } = req.body;

    if (!Array.isArray(leadIds) || leadIds.length === 0) {
      return res.status(400).json({ success: false, message: 'leadIds must be a non-empty array' });
    }
    if (leadIds.length > MAX_BULK_CONVERT) {
      return res.status(400).json({ success: false, message: `Cannot convert more than ${MAX_BULK_CONVERT} leads at once` });
    }
    if (!convertedStatus) {
      return res.status(400).json({ success: false, message: 'convertedStatus is required (a Closed/Converted Lead Status)' });
    }

    const salesforce = new SalesforceService(req.user);

    // Company names for a sensible per-lead Opportunity name - a bulk
    // action can't reasonably prompt for N separate names, so this mirrors
    // the "{Company} - Opportunity" default the single-convert form already
    // pre-fills.
    const leadsResult = await salesforce.query(
      `SELECT Id, Company FROM Lead WHERE Id IN (${leadIds.map((id) => `'${soqlEscape(id)}'`).join(',')})`
    );
    const companyById = new Map(leadsResult.records.map((r) => [r.Id, r.Company]));

    const conversions = leadIds.map((leadId) => ({
      leadId,
      convertedStatus,
      createOpportunity,
      opportunityName: createOpportunity && companyById.get(leadId) ? `${companyById.get(leadId)} - Opportunity` : undefined,
    }));

    const results = await salesforce.convertLeads(conversions);

    const succeeded = results.filter((r) => r.isSuccess);
    const failed = results.filter((r) => !r.isSuccess);

    if (succeeded.length > 0) {
      await invalidateLeadCaches(req.user._id);
      await cacheService.deleteByPrefix(`accounts_${req.user._id}`);
      await cacheService.deleteByPrefix(`contacts_${req.user._id}`);
      await cacheService.deleteByPrefix(`opp_list_${req.user._id}`);
    }

    await recordActivity(req, {
      action: 'UPDATE',
      eventType: 'lead.bulk_converted',
      resourceId: `${succeeded.length}/${leadIds.length}`,
      changes: { leadIds, succeeded: succeeded.length, failed: failed.length },
      title: 'Leads bulk-converted',
      message: `${succeeded.length} of ${leadIds.length} leads converted`,
    });

    res.status(200).json({
      success: true,
      message: `${succeeded.length} of ${leadIds.length} lead(s) converted successfully`,
      data: {
        results: results.map((r) => ({
          leadId: r.leadId,
          isSuccess: r.isSuccess,
          accountId: r.accountId,
          contactId: r.contactId,
          opportunityId: r.opportunityId,
          error: r.errors?.[0]?.message || null,
        })),
        succeeded: succeeded.length,
        failed: failed.length,
      },
    });
  } catch (error) {
    console.error('Error bulk-converting leads:', error);
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/salesforce/leads/:id/sync-score
 * @desc    Write the computed score tier (Hot/Warm/Cold) into Salesforce's
 *          native Lead.Rating picklist - the only score-related write this
 *          app makes to the org's actual data, and always explicit/opt-in
 *          rather than automatic, since it overwrites whatever a human may
 *          have set on Rating themselves.
 * @access  Private
 */
export const syncLeadScore = async (req, res) => {
  try {
    const { id } = req.params;
    const salesforce = new SalesforceService(req.user);
    const result = await salesforce.getLeadById(id);

    if (result.records.length === 0) {
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    const { score, tier } = scoreLead(result.records[0]);
    await salesforce.updateLead(id, { Rating: tier });

    await invalidateLeadCaches(req.user._id, id);

    res.status(200).json({ success: true, message: `Rating synced to ${tier}`, data: { score, tier } });
  } catch (error) {
    console.error('Error syncing lead score:', error);
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

export default {
  getLeads,
  getLeadById,
  createLead,
  updateLead,
  deleteLead,
  convertLead,
  bulkConvertLeads,
  syncLeadScore,
  getLeadStatuses,
};
