
import AuditLogger from '../services/AuditLogger.js';

// Every CRM object the app writes to - kept in one place so the feed and
// its frontend event-type list can't drift apart from each other.
export const ACTIVITY_RESOURCE_TYPES = ['Lead', 'Account', 'Contact', 'Opportunity', 'Contract', 'Quote'];

/**
 * @route   GET /api/salesforce/activity
 * @desc    Cross-entity "what changed" feed - the history half of the live
 *          activity feed (see NotificationService/useNotifications for the
 *          WebSocket half). Deliberately scoped to real data changes
 *          (create/update/delete on a CRM object) rather than every
 *          AuditLog row - LOGIN/LOGOUT, EXPORT/IMPORT, and NOTIFY (email
 *          delivery failure) entries are a different concern and would
 *          just be noise here.
 * @access  Private
 */
export const getActivity = async (req, res) => {
  try {
    const { limit = 30, page = 1 } = req.query;

    const trail = await AuditLogger.getAuditTrail(
      {
        userId: req.user._id,
        resourceType: ACTIVITY_RESOURCE_TYPES,
        action: ['CREATE', 'UPDATE', 'DELETE'],
      },
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

export default { getActivity, ACTIVITY_RESOURCE_TYPES };
