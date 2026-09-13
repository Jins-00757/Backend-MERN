
import express from 'express';
import { protect } from '../middleware/auth.js';
import * as opportunitiesCtrl from '../controllers/opportunitiesController.js';
import * as accountsCtrl from '../controllers/accountsController.js';
import * as contactsCtrl from '../controllers/contactsController.js';
import * as bulkCtrl from '../controllers/bulkOperationsController.js';

const router = express.Router();

// Protect all routes
router.use(protect);

// ========================================================================
// OPPORTUNITIES ROUTES
// ========================================================================

router.get('/opportunities', opportunitiesCtrl.getOpportunities);
router.get('/opportunities/:id', opportunitiesCtrl.getOpportunityById);
router.post('/opportunities', opportunitiesCtrl.createOpportunity);
router.patch('/opportunities/:id', opportunitiesCtrl.updateOpportunity);
router.post('/opportunities/:id/close', opportunitiesCtrl.closeOpportunity);
router.delete('/opportunities/:id', opportunitiesCtrl.deleteOpportunity);
router.get('/opportunities/sync/status', opportunitiesCtrl.getSyncStatus);

// ========================================================================
// ACCOUNTS ROUTES
// ========================================================================

router.get('/accounts', accountsCtrl.getAccounts);
router.get('/accounts/:id', accountsCtrl.getAccountById);
router.get('/accounts/:id/opportunities', accountsCtrl.getAccountOpportunities);
router.post('/accounts', accountsCtrl.createAccount);
router.patch('/accounts/:id', accountsCtrl.updateAccount);

// ========================================================================
// CONTACTS ROUTES
// ========================================================================

router.get('/contacts', contactsCtrl.getContacts);
router.get('/contacts/:id', contactsCtrl.getContactById);
router.post('/contacts', contactsCtrl.createContact);
router.patch('/contacts/:id', contactsCtrl.updateContact);

// ========================================================================
// BULK OPERATIONS ROUTES
// ========================================================================

router.get('/bulk', bulkCtrl.getBulkJobs);
router.post('/bulk/create-job', bulkCtrl.createBulkJob);
router.post('/bulk/:jobId/upload', bulkCtrl.uploadBulkData);
router.post('/bulk/:jobId/close', bulkCtrl.closeBulkJob);
router.get('/bulk/:jobId/status', bulkCtrl.getBulkJobStatus);
router.get('/bulk/:jobId/results', bulkCtrl.getBulkJobResults);
router.get('/bulk/:jobId/failed', bulkCtrl.getBulkJobFailedRecords);

export default router;