
import SalesforceService from '../services/salesforceService.js';
import cacheService from '../services/CacheService.js';
import AuditLogger from '../services/AuditLogger.js';
import NotificationService from '../services/NotificationService.js';

const invalidateContractCaches = async (userId, id) => {
  const tasks = [cacheService.deleteByPrefix(`contracts_${userId}`)];
  if (id) tasks.push(cacheService.delete(`contract_${userId}_${id}`));
  await Promise.all(tasks);
};

const recordActivity = async (req, { action, eventType, resourceId, changes, title, message }) => {
  NotificationService.notify(req.user._id.toString(), eventType, { title, message, resourceId, changes });

  await AuditLogger.log(action, {
    userId: req.user._id,
    resourceType: 'Contract',
    resourceId,
    eventType,
    title,
    message,
    changes,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  }).catch((err) => console.error('Failed to audit-log contract activity:', err.message));
};

/**
 * @route   GET /api/salesforce/contracts/meta/statuses
 * @desc    This org's active Contract.Status picklist values - see
 *          salesforceService.getPicklistValues for why these can't be
 *          hardcoded.
 * @access  Private
 */
export const getContractStatuses = async (req, res) => {
  try {
    const cacheKey = `contract_statuses_${req.user._id}`;
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({ success: true, data: cached, source: 'cache' });
    }

    const salesforce = new SalesforceService(req.user);
    const statuses = await salesforce.getPicklistValues('Contract', 'Status');

    await cacheService.set(cacheKey, statuses, 3600);

    res.status(200).json({ success: true, data: statuses });
  } catch (error) {
    console.error('Error fetching contract statuses:', error);
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/salesforce/contracts
 * @desc    List contracts, optionally filtered by account/status
 * @access  Private
 */
export const getContracts = async (req, res) => {
  try {
    const { limit = 50, offset = 0, accountId, status } = req.query;
    const cacheKey = `contracts_${req.user._id}_${limit}_${offset}_${accountId}_${status}`;

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({ success: true, data: cached, source: 'cache' });
    }

    const salesforce = new SalesforceService(req.user);
    const result = await salesforce.getContracts({
      limit: Math.min(parseInt(limit), 200),
      offset: Math.max(0, parseInt(offset)),
      accountId,
      status,
    });

    await cacheService.set(cacheKey, result, 180);

    res.status(200).json({ success: true, data: result, source: 'salesforce' });
  } catch (error) {
    console.error('Error fetching contracts:', error);
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/salesforce/contracts/:id
 * @access  Private
 */
export const getContractById = async (req, res) => {
  try {
    const { id } = req.params;
    const cacheKey = `contract_${req.user._id}_${id}`;

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({ success: true, data: cached, source: 'cache' });
    }

    const salesforce = new SalesforceService(req.user);
    const result = await salesforce.getContractById(id);

    if (result.records.length === 0) {
      return res.status(404).json({ success: false, message: 'Contract not found' });
    }

    const contract = result.records[0];
    await cacheService.set(cacheKey, contract, 180);

    res.status(200).json({ success: true, data: contract });
  } catch (error) {
    console.error('Error fetching contract:', error);
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/salesforce/contracts
 * @desc    Create a contract (always starts life as Draft - see
 *          salesforceService.createContract)
 * @access  Private
 */
export const createContract = async (req, res) => {
  try {
    const { AccountId, StartDate, ContractTerm, Description, OwnerExpirationNotice } = req.body;

    if (!AccountId) {
      return res.status(400).json({ success: false, message: 'Account is required' });
    }

    const salesforce = new SalesforceService(req.user);
    const result = await salesforce.createContract({
      AccountId,
      StartDate: StartDate || null,
      ContractTerm: ContractTerm ? parseInt(ContractTerm, 10) : null,
      Description,
      OwnerExpirationNotice,
    });

    await invalidateContractCaches(req.user._id);

    await recordActivity(req, {
      action: 'CREATE',
      eventType: 'contract.created',
      resourceId: result.id,
      changes: { AccountId, StartDate, ContractTerm },
      title: 'Contract created',
      message: 'A new contract was drafted',
    });

    res.status(201).json({ success: true, message: 'Contract created successfully', data: result });
  } catch (error) {
    console.error('Error creating contract:', error);
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

/**
 * @route   PATCH /api/salesforce/contracts/:id
 * @desc    Update a contract, including Status transitions (Draft ->
 *          Activated, or toward expiration). Salesforce itself enforces
 *          which transitions are legal (e.g. it won't let a contract with
 *          no StartDate be Activated) - this endpoint just forwards
 *          whatever fields are sent and surfaces Salesforce's own
 *          validation error if a transition is rejected, rather than
 *          trying to duplicate that state machine here and risk getting it
 *          wrong.
 * @access  Private
 */
export const updateContract = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = { ...req.body };

    if (updates.ContractTerm !== undefined) updates.ContractTerm = parseInt(updates.ContractTerm, 10) || null;

    const salesforce = new SalesforceService(req.user);
    await salesforce.updateContract(id, updates);

    await invalidateContractCaches(req.user._id, id);

    await recordActivity(req, {
      action: 'UPDATE',
      eventType: 'contract.updated',
      resourceId: id,
      changes: updates,
      title: updates.Status ? `Contract ${updates.Status.toLowerCase()}` : 'Contract updated',
      message: updates.Status ? `A contract status changed to ${updates.Status}` : 'A contract was updated',
    });

    res.status(200).json({ success: true, message: 'Contract updated successfully' });
  } catch (error) {
    console.error('Error updating contract:', error);
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

export default {
  getContracts,
  getContractById,
  createContract,
  updateContract,
  getContractStatuses,
};
