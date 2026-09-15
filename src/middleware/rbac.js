
import Team from '../models/Team.js';

// Matches the `role` enum on the User model ('user', 'admin', 'manager') -
// 'sales_rep'/'viewer' are kept as aliases for roles that don't exist yet
// today but that the model's enum may grow to include.
// BUG FIX: 'admin' used to be missing 'manage:team' entirely - since
// authorize() checks for exact permission strings (no role hierarchy, no
// "admin implies manager" logic), any route gated with just
// authorize(['manage:team']) and no admin-inclusive fallback (unlike
// canWrite/canDelete elsewhere, which explicitly list 'write:all'/
// 'delete:all' alongside the lower-role permissions) rejected admin with
// a 403 while manager passed - a lower role had strictly more access than
// the top one. Confirmed live against /api/analytics/team-performance
// (pre-existing) and the new /api/teams routes. Admin's permission set
// should always be a superset of manager's.
const rolePermissions = {
  admin: ['read:all', 'write:all', 'delete:all', 'manage:users', 'manage:settings', 'manage:team'],
  manager: ['read:all', 'write:own', 'write:team', 'delete:own', 'manage:team'],
  user: ['read:all', 'write:own', 'delete:own'],
  sales_rep: ['read:all', 'write:own', 'delete:own'],
  viewer: ['read:own'],
};

// Exported so call sites that need to branch on permission inline (e.g. a
// single route handler serving several report types with different
// requirements - see analyticsController.exportAnalytics) can reuse the same
// rolePermissions table instead of duplicating it.
export const hasPermission = (role, permission) => {
  const userPermissions = rolePermissions[role] || [];
  return userPermissions.includes(permission) || userPermissions.includes('*');
};

export const authorize = (requiredPermissions) => {
  return (req, res, next) => {
    const userRole = req.user?.role || 'viewer';

    const allowed = requiredPermissions.some((permission) =>
      hasPermission(userRole, permission)
    );

    if (!allowed) {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions',
      });
    }

    next();
  };
};

export const checkOwnership = (req, res, next) => {
  const userId = req.user._id.toString();
  const resourceUserId = req.params.userId || req.body.userId;

  if (req.user.role === 'admin') {
    return next();
  }

  if (userId !== resourceUserId) {
    return res.status(403).json({
      success: false,
      message: 'Not authorized to access this resource',
    });
  }

  next();
};

export const checkTeamAccess = async (req, res, next) => {
  const userRole = req.user?.role;
  // BUG FIX: this read only req.params.teamId, but every route in this
  // codebase (accountsController, contactsController, opportunitiesController,
  // and now team.routes.js) names its id param `:id`, not `:teamId` - so
  // teamId was always undefined, Team.findById(undefined) always resolved
  // null, and every manager was rejected even from their own team. This
  // middleware was defined but never actually wired to a route until
  // team.routes.js, so the bug was never exercised until now.
  const teamId = req.params.id || req.params.teamId || req.body.teamId;

  if (userRole === 'admin') {
    return next();
  }

  if (userRole === 'manager') {
    // Check if user manages this team
    const team = await Team.findById(teamId);

    if (team?.managerId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to access this team',
      });
    }
  }

  next();
};