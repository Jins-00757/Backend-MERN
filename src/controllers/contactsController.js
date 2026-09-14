
import SalesforceService, { soqlEscape } from '../services/salesforceService.js';
import cacheService from '../services/CacheService.js';

/**
 * @route   GET /api/salesforce/contacts
 * @desc    Get contacts, optionally filtered by account
 * @access  Private
 */
export const getContacts = async (req, res) => {
  try {
    const { accountId, limit = 50, offset = 0 } = req.query;
    const cacheKey = `contacts_${req.user._id}_${accountId}_${limit}_${offset}`;

    let cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        source: 'cache',
      });
    }

    const salesforce = new SalesforceService(req.user);
    const result = await salesforce.getContacts(accountId || null, {
      limit: Math.min(parseInt(limit), 500),
      offset: Math.max(0, parseInt(offset)),
    });

    await cacheService.set(cacheKey, result, 300);

    res.status(200).json({
      success: true,
      data: result,
      source: 'salesforce',
    });
  } catch (error) {
    console.error('Error fetching contacts:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * @route   GET /api/salesforce/contacts/:id
 * @desc    Get single contact details
 * @access  Private
 */
export const getContactById = async (req, res) => {
  try {
    const { id } = req.params;
    const cacheKey = `contact_${req.user._id}_${id}`;

    let cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        source: 'cache',
      });
    }

    const salesforce = new SalesforceService(req.user);
    const soql = `SELECT Id, FirstName, LastName, Email, Phone, 
                         Title, Department, AccountId, ReportsToId,
                         MailingStreet, MailingCity, MailingState,
                         CreatedDate, LastModifiedDate
                  FROM Contact WHERE Id = '${soqlEscape(id)}'`;
    const result = await salesforce.query(soql);

    if (result.records.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Contact not found',
      });
    }

    const contact = result.records[0];
    await cacheService.set(cacheKey, contact, 300);

    res.status(200).json({
      success: true,
      data: contact,
    });
  } catch (error) {
    console.error('Error fetching contact:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * @route   POST /api/salesforce/contacts
 * @desc    Create new contact
 * @access  Private
 */
export const createContact = async (req, res) => {
  try {
    const { FirstName, LastName, Email, Phone, Title, AccountId } = req.body;

    if (!LastName || !AccountId) {
      return res.status(400).json({
        success: false,
        message: 'Last name and account ID are required',
      });
    }

    const salesforce = new SalesforceService(req.user);
    const result = await salesforce.createContact({
      FirstName,
      LastName,
      Email,
      Phone,
      Title,
      AccountId,
    });

    // Invalidate cache
    await cacheService.deleteByPrefix(`contacts_${req.user._id}`);

    res.status(201).json({
      success: true,
      message: 'Contact created successfully',
      data: result,
    });
  } catch (error) {
    console.error('Error creating contact:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * @route   PATCH /api/salesforce/contacts/:id
 * @desc    Update contact
 * @access  Private
 */
export const updateContact = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const salesforce = new SalesforceService(req.user);
    await salesforce.updateContact(id, updates);

    // Invalidate cache
    await cacheService.delete(`contact_${req.user._id}_${id}`);

    res.status(200).json({
      success: true,
      message: 'Contact updated successfully',
    });
  } catch (error) {
    console.error('Error updating contact:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

export default {
  getContacts,
  getContactById,
  createContact,
  updateContact,
};