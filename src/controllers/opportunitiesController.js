// Backend-MERN/src/controllers/opportunitiesController.js

import SalesforceService, { soqlEscape } from '../services/salesforceService.js';
import SyncLog from '../models/SyncLog.js';
import cacheService from '../services/CacheService.js';
import NotificationService from '../services/NotificationService.js';
import AuditLogger from '../services/AuditLogger.js';
import { sendDealStageChangeEmail } from '../services/emailService.js';

/**
 * Every cache namespace that depends on opportunity data - the single-record
 * cache (only when `id` is known), the list cache, analytics reports (they
 * aggregate opportunities), and search/suggestions results. Called after
 * every create/update/close/delete so none of them ever serves stale data
 * for longer than their own TTL would otherwise allow.
 */
const invalidateOpportunityCaches = async (userId, id) => {
  const tasks = [
    cacheService.deleteByPrefix(`opp_list_${userId}`),
    cacheService.deleteByPrefix(`analytics_${userId}`),
    cacheService.deleteByPrefix(`search_${userId}`),
    cacheService.deleteByPrefix(`suggest_${userId}`),
  ];
  if (id) tasks.push(cacheService.delete(`opp_${userId}_${id}`));
  await Promise.all(tasks);
};

/**
 * Fetch just the fields needed to detect a stage change and label activity
 * feed / notification entries with a human-readable deal name, without
 * pulling the full Opportunity record.
 */
const getOpportunitySnapshot = async (salesforce, id) => {
  const soql = `SELECT Id, Name, StageName, Amount FROM Opportunity WHERE Id = '${soqlEscape(id)}'`;
  const result = await salesforce.query(soql);
  return result.records[0] || null;
};

/**
 * Record a failed notification-email delivery so it's never *only* a
 * console.error the user has no way to see - a bad address, a full mailbox,
 * or an SMTP outage previously vanished into the server log with no trace
 * anywhere the user could find it (they'd only learn about it days later,
 * indirectly, from an external bounce landing in their inbox). This gives
 * every failure two visible homes: a persisted AuditLog entry (status:
 * 'failure') and a live WebSocket push that shows up in the notification
 * bell immediately, the same way opportunity.* events do.
 */
const reportEmailDeliveryFailure = (user, { event, resourceId, errorMessage }) => {
  NotificationService.notify(user._id.toString(), 'notification.email_failed', {
    title: 'Email notification failed to send',
    message: `We couldn't email "${resourceId}" to ${user.email}. Check your email address in Profile Information.`,
    resourceId,
  });

  AuditLogger.log('NOTIFY', {
    userId: user._id,
    resourceType: 'EmailNotification',
    resourceId,
    changes: { channel: 'email', event, to: user.email },
    status: 'failure',
    errorMessage,
  }).catch((auditError) => {
    console.error('Failed to record email delivery failure in audit log:', auditError.message);
  });
};

/**
 * Send the "deal stage changed" notification email (see emailService.js).
 * Deliberately not awaited by callers - a slow or failing mailbox must
 * never delay or fail the opportunity update/close request that triggered
 * it. Respects the user's notification preference, defaulting to enabled
 * (opt-out) since most users expect stage-change alerts by default.
 */
const notifyStageChange = (user, { dealName, oldStage, newStage, amount }) => {
  if (user.preferences?.notifications?.email === false) return;

  sendDealStageChangeEmail({
    to: user.email,
    name: user.name,
    dealName,
    oldStage,
    newStage,
    amount,
  }).catch((error) => {
    console.error('Failed to send deal stage change email:', error.message);
    reportEmailDeliveryFailure(user, {
      event: 'stage_change',
      resourceId: dealName,
      errorMessage: error.message,
    });
  });
};

/**
 * Record an Opportunity change in the audit trail (backs the Deal Activity
 * Feed - see AuditLogger.getAuditTrail / opportunitiesController.getActivityFeed)
 * and broadcast it over the user's WebSocket connection for the live feed.
 */
const recordActivity = async (req, { action, eventType, resourceId, changes, title, message }) => {
  NotificationService.notify(req.user._id.toString(), eventType, {
    title,
    message,
    resourceId,
    changes,
  });

  await AuditLogger.log(action, {
    userId: req.user._id,
    resourceType: 'Opportunity',
    resourceId,
    changes,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  });
};

/**
 * @route   GET /api/salesforce/opportunities
 * @desc    Get all opportunities with filtering and pagination
 * @access  Private
 */
export const getOpportunities = async (req, res) => {
  try {
    const { limit = 50, offset = 0, stage, amountMin, amountMax, accountId, search } = req.query;
    const cacheKey = `opp_list_${req.user._id}_${limit}_${offset}_${stage}_${accountId}_${search}`;

    // Check cache
    let cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        source: 'cache',
      });
    }

    const salesforce = new SalesforceService(req.user);
    const result = await salesforce.getOpportunities({
      limit: Math.min(parseInt(limit), 500),
      offset: Math.max(0, parseInt(offset)),
      stageName: stage,
      amountMin: amountMin ? parseFloat(amountMin) : null,
      amountMax: amountMax ? parseFloat(amountMax) : null,
      accountId,
      searchTerm: search,
    });

    // Cache for 5 minutes
    await cacheService.set(cacheKey, result, 300);

    res.status(200).json({
      success: true,
      data: result,
      source: 'salesforce',
    });
  } catch (error) {
    console.error('Error fetching opportunities:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
      error: process.env.NODE_ENV === 'development' ? error : undefined,
    });
  }
};

/**
 * @route   GET /api/salesforce/opportunities/:id
 * @desc    Get single opportunity with details
 * @access  Private
 */
export const getOpportunityById = async (req, res) => {
  try {
    const { id } = req.params;
    const cacheKey = `opp_${req.user._id}_${id}`;

    let cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        source: 'cache',
      });
    }

    const salesforce = new SalesforceService(req.user);
    const soql = `SELECT Id, Name, StageName, Amount, CloseDate, 
                         Probability, AccountId, OwnerId, Description,
                         CreatedDate, LastModifiedDate 
                  FROM Opportunity WHERE Id = '${soqlEscape(id)}'`;
    const result = await salesforce.query(soql);

    if (result.records.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Opportunity not found',
      });
    }

    const opportunity = result.records[0];
    await cacheService.set(cacheKey, opportunity, 300);

    res.status(200).json({
      success: true,
      data: opportunity,
    });
  } catch (error) {
    console.error('Error fetching opportunity:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * @route   POST /api/salesforce/opportunities
 * @desc    Create new opportunity
 * @access  Private
 */
export const createOpportunity = async (req, res) => {
  try {
    const { Name, StageName, CloseDate, Amount, AccountId, Description } =
      req.body;

    // Validation
    if (!Name || !StageName || !CloseDate || !AccountId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: Name, StageName, CloseDate, AccountId',
      });
    }

    if (new Date(CloseDate) < new Date()) {
      return res.status(400).json({
        success: false,
        message: 'Close date must be in the future',
      });
    }

    const salesforce = new SalesforceService(req.user);
    const result = await salesforce.createOpportunity({
      Name,
      StageName,
      CloseDate,
      Amount: Amount ? parseFloat(Amount) : null,
      AccountId,
      Description,
    });

    // Invalidate cache
    await invalidateOpportunityCaches(req.user._id);

    await recordActivity(req, {
      action: 'CREATE',
      eventType: 'opportunity.created',
      resourceId: result.id,
      changes: { dealName: Name, StageName, CloseDate, Amount: Amount ? parseFloat(Amount) : null, AccountId },
      title: 'Opportunity created',
      message: `${Name} was created`,
    });

    res.status(201).json({
      success: true,
      message: 'Opportunity created successfully',
      data: result,
    });
  } catch (error) {
    console.error('Error creating opportunity:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * @route   PATCH /api/salesforce/opportunities/:id
 * @desc    Update opportunity
 * @access  Private
 */
export const updateOpportunity = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Validate close date if provided
    if (updates.CloseDate && new Date(updates.CloseDate) < new Date()) {
      return res.status(400).json({
        success: false,
        message: 'Close date must be in the future',
      });
    }

    if (updates.Amount !== undefined) {
      updates.Amount = parseFloat(updates.Amount);
    }

    const salesforce = new SalesforceService(req.user);

    // Snapshot the current record before updating - needed both to detect a
    // stage change (triggers the notification email) and to label the
    // activity feed entry with the deal's name even when `updates` doesn't
    // include one.
    const before = await getOpportunitySnapshot(salesforce, id);

    await salesforce.updateOpportunity(id, updates);

    // Invalidate cache
    await invalidateOpportunityCaches(req.user._id, id);

    const dealName = updates.Name || before?.Name || id;
    const stageChanged = Boolean(
      before && updates.StageName && before.StageName !== updates.StageName
    );

    await recordActivity(req, {
      action: 'UPDATE',
      eventType: 'opportunity.updated',
      resourceId: id,
      changes: {
        dealName,
        ...updates,
        ...(stageChanged ? { previousStage: before.StageName } : {}),
      },
      // Match the title ActivityFeed.jsx derives for this same kind of
      // entry when it re-fetches history from AuditLog (which has no title
      // field of its own - see titleForLog() there) - otherwise a stage
      // change shows the nicer "Stage changed: X -> Y" label only after a
      // reload, and the plain generic one live over the WebSocket.
      title: stageChanged ? `Stage changed: ${before.StageName} → ${updates.StageName}` : 'Opportunity updated',
      message: `${dealName} was updated`,
    });

    if (stageChanged) {
      notifyStageChange(req.user, {
        dealName,
        oldStage: before.StageName,
        newStage: updates.StageName,
        amount: updates.Amount ?? before.Amount,
      });
    }

    res.status(200).json({
      success: true,
      message: 'Opportunity updated successfully',
    });
  } catch (error) {
    console.error('Error updating opportunity:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * @route   POST /api/salesforce/opportunities/:id/close
 * @desc    Close opportunity as won or lost
 * @access  Private
 */
export const closeOpportunity = async (req, res) => {
  try {
    const { id } = req.params;
    const { won = true } = req.body;

    const salesforce = new SalesforceService(req.user);
    const before = await getOpportunitySnapshot(salesforce, id);

    await salesforce.closeOpportunity(id, true, won);

    await invalidateOpportunityCaches(req.user._id, id);

    const newStage = won ? 'Closed Won' : 'Closed Lost';
    const dealName = before?.Name || id;

    await recordActivity(req, {
      action: 'UPDATE',
      eventType: 'opportunity.closed',
      resourceId: id,
      changes: {
        dealName,
        previousStage: before?.StageName,
        StageName: newStage,
        IsClosed: true,
        IsWon: won,
      },
      title: `Opportunity closed as ${won ? 'Won' : 'Lost'}`,
      message: `${dealName} was closed as ${won ? 'Won' : 'Lost'}`,
    });

    if (before && before.StageName !== newStage) {
      notifyStageChange(req.user, {
        dealName,
        oldStage: before.StageName,
        newStage,
        amount: before.Amount,
      });
    }

    res.status(200).json({
      success: true,
      message: `Opportunity closed as ${won ? 'Won' : 'Lost'}`,
    });
  } catch (error) {
    console.error('Error closing opportunity:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * @route   DELETE /api/salesforce/opportunities/:id
 * @desc    Delete opportunity
 * @access  Private
 */
export const deleteOpportunity = async (req, res) => {
  try {
    const { id } = req.params;

    const salesforce = new SalesforceService(req.user);
    const before = await getOpportunitySnapshot(salesforce, id);

    await salesforce.deleteOpportunity(id);

    await invalidateOpportunityCaches(req.user._id, id);

    const dealName = before?.Name || id;

    await recordActivity(req, {
      action: 'DELETE',
      eventType: 'opportunity.deleted',
      resourceId: id,
      changes: before ? { dealName, deletedRecord: before } : { dealName },
      title: 'Opportunity deleted',
      message: `${dealName} was deleted`,
    });

    res.status(200).json({
      success: true,
      message: 'Opportunity deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting opportunity:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * @route   GET /api/salesforce/opportunities/sync/status
 * @desc    Get sync status for opportunities
 * @access  Private
 */
export const getSyncStatus = async (req, res) => {
  try {
    const syncLog = await SyncLog.findOne(
      {
        userId: req.user._id,
        syncType: { $in: ['opportunities', 'all'] },
      },
      {},
      { sort: { createdAt: -1 } }
    );

    res.status(200).json({
      success: true,
      data: syncLog || null,
    });
  } catch (error) {
    console.error('Error getting sync status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get sync status',
    });
  }
};

/**
 * @route   GET /api/salesforce/opportunities/activity
 * @desc    Deal Activity Feed - recent create/update/close/delete history
 *          for the user's opportunities (backed by AuditLog). Real-time
 *          updates arrive separately over WebSocket - see
 *          middleware/websocket.js and the opportunity.* events emitted
 *          above by recordActivity().
 * @access  Private
 */
export const getActivityFeed = async (req, res) => {
  try {
    const { limit = 20, page = 1 } = req.query;

    const trail = await AuditLogger.getAuditTrail(
      { userId: req.user._id, resourceType: 'Opportunity' },
      { page: parseInt(page), limit: Math.min(parseInt(limit), 100) }
    );

    res.status(200).json({
      success: true,
      ...trail,
    });
  } catch (error) {
    console.error('Error fetching activity feed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch activity feed',
    });
  }
};