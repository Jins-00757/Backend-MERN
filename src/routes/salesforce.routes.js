
import express from 'express';
import { protect } from '../middleware/auth.js';
import { authorize } from '../middleware/rbac.js';
import { salesforceCrudLimiter, sensitiveOperationLimiter } from '../middleware/rateLimiter.js';
import { csvUpload, handleCsvUploadError } from '../middleware/csvUpload.js';
import * as opportunitiesCtrl from '../controllers/opportunitiesController.js';
import * as accountsCtrl from '../controllers/accountsController.js';
import * as contactsCtrl from '../controllers/contactsController.js';
import * as bulkCtrl from '../controllers/bulkOperationsController.js';
import * as leadsCtrl from '../controllers/leadsController.js';
import * as contractsCtrl from '../controllers/contractsController.js';
import * as mapCtrl from '../controllers/mapController.js';
import * as quotesCtrl from '../controllers/quotesController.js';

const router = express.Router();

// Protect all routes and cap how fast one user can hit live Salesforce
// through this router - previously unlimited, which any interactive
// feature that fires several requests in a short window (e.g. dragging
// deals across Kanban board stages) could otherwise abuse or accidentally
// trip Salesforce's own org-level API limits.
router.use(protect);
router.use(salesforceCrudLimiter);

// Role gates below reuse the same rolePermissions table as
// analytics.routes.js / saasMetrics.routes.js (see middleware/rbac.js).
// Reads and single-record writes only require the baseline permissions
// every authenticated role already holds (read:all / write:own), so they
// behave the same as before this router had any RBAC - they just now
// formally document the requirement and reject any future low-privilege
// role (e.g. a read-only 'viewer'). Permanently destructive or org-wide
// operations - deleting a Salesforce record outright, and bulk
// insert/update/upsert/delete jobs that can touch many records in one
// call - are restricted to manager/admin (delete:all or manage:team),
// since a plain 'user' having delete:own doesn't meaningfully map to
// ownership of records that live in the connected Salesforce org.
const canWrite = authorize(['write:own', 'write:team', 'write:all']);
const canDelete = authorize(['delete:all', 'manage:team']);

// ========================================================================
// OPPORTUNITIES ROUTES
// ========================================================================

router.get('/opportunities', authorize(['read:all']), opportunitiesCtrl.getOpportunities);
// Must be registered before '/opportunities/:id' - otherwise Express would
// match this path with id='activity' instead.
router.get('/opportunities/activity', authorize(['read:all']), opportunitiesCtrl.getActivityFeed);
router.get('/opportunities/:id', authorize(['read:all']), opportunitiesCtrl.getOpportunityById);
router.post('/opportunities', canWrite, opportunitiesCtrl.createOpportunity);
router.patch('/opportunities/:id', canWrite, opportunitiesCtrl.updateOpportunity);
router.post('/opportunities/:id/close', canWrite, opportunitiesCtrl.closeOpportunity);
router.delete('/opportunities/:id', canDelete, opportunitiesCtrl.deleteOpportunity);
router.get('/opportunities/sync/status', authorize(['read:all']), opportunitiesCtrl.getSyncStatus);

// ========================================================================
// ACCOUNTS ROUTES
// ========================================================================

router.get('/accounts', authorize(['read:all']), accountsCtrl.getAccounts);
router.get('/accounts/:id', authorize(['read:all']), accountsCtrl.getAccountById);
router.get('/accounts/:id/opportunities', authorize(['read:all']), accountsCtrl.getAccountOpportunities);
router.post('/accounts', canWrite, accountsCtrl.createAccount);
router.patch('/accounts/:id', canWrite, accountsCtrl.updateAccount);

// ========================================================================
// MAP ROUTES
// ========================================================================

router.get('/map/accounts', authorize(['read:all']), mapCtrl.getAccountsMap);

// ========================================================================
// CONTACTS ROUTES
// ========================================================================

router.get('/contacts', authorize(['read:all']), contactsCtrl.getContacts);
router.get('/contacts/:id', authorize(['read:all']), contactsCtrl.getContactById);
router.post('/contacts', canWrite, contactsCtrl.createContact);
router.patch('/contacts/:id', canWrite, contactsCtrl.updateContact);

// ========================================================================
// LEADS ROUTES - Rating sync and delete follow the same "manager/admin
// only" reasoning as an outright Salesforce record delete above; everything
// else (read, create, edit, convert) is a normal day-to-day sales workflow
// action available to any connected role.
// ========================================================================

// Must be registered before '/leads/:id' - otherwise Express would match
// this path with id='meta'.
router.get('/leads/meta/statuses', authorize(['read:all']), leadsCtrl.getLeadStatuses);
router.get('/leads', authorize(['read:all']), leadsCtrl.getLeads);
router.get('/leads/:id', authorize(['read:all']), leadsCtrl.getLeadById);
router.post('/leads', canWrite, leadsCtrl.createLead);
router.patch('/leads/:id', canWrite, leadsCtrl.updateLead);
router.delete('/leads/:id', canDelete, leadsCtrl.deleteLead);
router.post('/leads/:id/convert', canWrite, leadsCtrl.convertLead);
router.post('/leads/:id/sync-score', canWrite, leadsCtrl.syncLeadScore);
// Converts up to 50 leads in one Salesforce SOAP call (creates that many
// Account/Contact/Opportunity records) - same sensitiveOperationLimiter
// (5/hour) as bulk CSV job creation, since the blast radius is comparable.
router.post('/leads/bulk-convert', canWrite, sensitiveOperationLimiter, leadsCtrl.bulkConvertLeads);

// ========================================================================
// CONTRACTS ROUTES
// ========================================================================

// Must be registered before '/contracts/:id' - otherwise Express would
// match this path with id='meta'.
router.get('/contracts/meta/statuses', authorize(['read:all']), contractsCtrl.getContractStatuses);
router.get('/contracts', authorize(['read:all']), contractsCtrl.getContracts);
router.get('/contracts/:id', authorize(['read:all']), contractsCtrl.getContractById);
router.post('/contracts', canWrite, contractsCtrl.createContract);
router.patch('/contracts/:id', canWrite, contractsCtrl.updateContract);

// ========================================================================
// QUOTES ROUTES - the quotation & proposal generator. Reads and everyday
// writes (create/update/save line items/download/email) follow the same
// baseline read:all/write:own permissions as opportunities/accounts/contacts
// above; only deleting a quote outright is restricted to manager/admin, same
// reasoning as every other outright-delete in this router.
// ========================================================================

// Must be registered before '/quotes/:id' - otherwise Express would match
// these paths with id='meta'/'products'.
router.get('/quotes/meta/statuses', authorize(['read:all']), quotesCtrl.getQuoteStatuses);
router.get('/quotes/products', authorize(['read:all']), quotesCtrl.getProductCatalog);
router.get('/quotes', authorize(['read:all']), quotesCtrl.getQuotes);
router.get('/quotes/:id', authorize(['read:all']), quotesCtrl.getQuoteById);
router.post('/quotes', canWrite, quotesCtrl.createQuote);
router.patch('/quotes/:id', canWrite, quotesCtrl.updateQuote);
router.delete('/quotes/:id', canDelete, quotesCtrl.deleteQuote);
router.put('/quotes/:id/line-items', canWrite, quotesCtrl.saveQuoteLineItems);
router.get('/quotes/:id/pdf', authorize(['read:all']), quotesCtrl.getQuotePdfLink);
// Sends an outbound email to an address the user supplies - same
// sensitiveOperationLimiter budget as other outbound/bulk actions above,
// so it can't be used to blast the connected mailbox.
router.post('/quotes/:id/email', canWrite, sensitiveOperationLimiter, quotesCtrl.emailQuotePdf);

// ========================================================================
// BULK OPERATIONS ROUTES - insert/update/upsert/delete against Salesforce
// at scale, so creating/uploading/closing a job requires manager/admin;
// reading the status of a job you already own stays available to whoever
// created it (ownership is enforced in bulkOperationsController via the
// BulkJob.userId match, not by role).
//
// create-job additionally passes through sensitiveOperationLimiter (5/hour)
// - it's the point where a *new* bulk operation is initiated, which is the
// action with the largest blast radius in this app (up to thousands of
// Salesforce records in one job). upload/close are necessary follow-up
// steps of an already-approved job, not new operations in their own right,
// so they stay on the router-wide salesforceCrudLimiter rather than also
// consuming the hourly budget - three counts per one logical bulk import
// would let a legitimate user exhaust 5/hour after a single operation.
// ========================================================================

// Export/template are read-only data pulls (no Salesforce record is ever
// created/changed/deleted), not job mutations - available to any connected
// role (read:all) rather than gated to manager/admin like create-job/upload/
// close below. export additionally passes through sensitiveOperationLimiter
// since it can pull an org's entire object table in one call, the same
// "large blast radius" reasoning as create-job; template is small, static,
// non-sensitive content and needs no extra limiting.
router.get('/bulk/export', authorize(['read:all']), sensitiveOperationLimiter, bulkCtrl.exportRecords);
router.get('/bulk/template', authorize(['read:all']), bulkCtrl.getImportTemplate);

router.get('/bulk', authorize(['read:all']), bulkCtrl.getBulkJobs);
router.post('/bulk/create-job', canDelete, sensitiveOperationLimiter, bulkCtrl.createBulkJob);
router.post('/bulk/:jobId/upload', canDelete, bulkCtrl.uploadBulkData);
router.post(
  '/bulk/:jobId/upload-file',
  canDelete,
  csvUpload.single('file'),
  handleCsvUploadError,
  bulkCtrl.uploadBulkDataFile
);
router.post('/bulk/:jobId/close', canDelete, bulkCtrl.closeBulkJob);
router.get('/bulk/:jobId/status', authorize(['read:all']), bulkCtrl.getBulkJobStatus);
router.get('/bulk/:jobId/results', authorize(['read:all']), bulkCtrl.getBulkJobResults);
router.get('/bulk/:jobId/failed', authorize(['read:all']), bulkCtrl.getBulkJobFailedRecords);
router.post(
  '/bulk/:jobId/results/download-link',
  authorize(['read:all']),
  sensitiveOperationLimiter,
  bulkCtrl.createResultsDownloadLink
);
router.post(
  '/bulk/:jobId/failed/download-link',
  authorize(['read:all']),
  sensitiveOperationLimiter,
  bulkCtrl.createFailedDownloadLink
);

export default router;