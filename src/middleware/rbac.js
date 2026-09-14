
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

export const authorize = (requiredPermissions) => {
  return (req, res, next) => {
    const userRole = req.user?.role || 'viewer';
    const userPermissions = rolePermissions[userRole] || [];

    const hasPermission = requiredPermissions.some((permission) =>
      userPermissions.includes(permission) || userPermissions.includes('*')
    );

    if (!hasPermission) {
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