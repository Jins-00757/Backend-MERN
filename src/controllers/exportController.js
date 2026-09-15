import { redeemDownloadToken } from '../services/downloadTokenService.js';
import AuditLogger from '../services/AuditLogger.js';

/**
 * @route   GET /api/export/download/:token
 * @desc    Redeem a single-use, time-limited export download link created by
 *          data.controller.js (dashboard stats) or bulkOperationsController.js
 *          (bulk job results/failed records) - see downloadTokenService.js
 *          for the token lifecycle (1-hour expiry, atomic single-use, hash
 *          verification).
 * @access  Private - the token alone isn't treated as sufficient proof of
 *          identity the way a password-reset/email-verification link is:
 *          it's bound to the user who requested it (see
 *          redeemDownloadToken's ownership check), which requires the
 *          redeeming request to already be authenticated as that same user.
 */
export const downloadExport = async (req, res, next) => {
  const { token } = req.params;

  try {
    const result = await redeemDownloadToken(token, {
      userId: req.user._id,
      ip: req.ip,
    });

    await AuditLogger.log('EXPORT', {
      userId: req.user._id,
      resourceType: 'ExportDownload',
      resourceId: result.filename,
      changes: { fileHash: result.fileHash, ipMismatch: result.ipMismatch, createdIp: result.createdIp },
      status: 'success',
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch((err) => console.error('Failed to audit-log export download:', err.message));

    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('X-Content-SHA256', result.fileHash);
    res.send(result.content);
  } catch (error) {
    AuditLogger.log('EXPORT', {
      userId: req.user._id,
      resourceType: 'ExportDownload',
      resourceId: token,
      status: 'failure',
      errorMessage: error.message,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch((err) => console.error('Failed to audit-log export download failure:', err.message));

    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * @route   GET /api/export/history
 * @desc    The signed-in user's own download history - every export-link
 *          creation and redemption (success or failure) logged above and
 *          by data.controller.js/bulkOperationsController.js, all sharing
 *          the 'EXPORT' audit action. This is the "download history"
 *          requirement: who downloaded what, when, from which IP, and
 *          whether it succeeded.
 * @access  Private - always scoped to req.user._id, never another user's
 *          history.
 */
export const getDownloadHistory = async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;

    const trail = await AuditLogger.getAuditTrail(
      { userId: req.user._id, action: 'EXPORT' },
      { page: parseInt(page), limit: Math.min(parseInt(limit), 100) }
    );

    res.status(200).json({ success: true, ...trail });
  } catch (error) {
    console.error('Error fetching download history:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

export default { downloadExport, getDownloadHistory };
