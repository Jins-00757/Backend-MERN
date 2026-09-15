
import Team from '../models/Team.js';

// Matches the `role` enum on the User model ('user', 'admin', 'manager') -
// 'sales_rep'/'viewer' are kept as aliases for roles that don't exist yet
// today but that the model's enum may grow to include.
const rolePermissions = {
  admin: ['read:all', 'write:all', 'delete:all', 'manage:users', 'manage:settings'],
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
  const teamId = req.params.teamId || req.body.teamId;

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