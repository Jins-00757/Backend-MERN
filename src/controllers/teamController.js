import Team from '../models/Team.js';
import User from '../models/User.js';

/**
 * Confirm every id in `ids` actually references an existing User -
 * mirrors the light existence-check level the rest of the app uses (e.g.
 * accountsController's `if (!Name)` guard) rather than deep validation.
 * Returns the ids that do NOT exist, so callers can build a clear error.
 */
const findMissingUserIds = async (ids) => {
  if (!ids || ids.length === 0) return [];
  const existing = await User.find({ _id: { $in: ids } }).select('_id');
  const existingIds = new Set(existing.map((u) => u._id.toString()));
  return ids.filter((id) => !existingIds.has(String(id)));
};

/**
 * @route   POST /api/teams
 * @desc    Create a team
 * @access  Private (manage:team - manager or admin)
 */
export const createTeam = async (req, res) => {
  try {
    const { name, description, managerId, members = [] } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'Team name is required',
      });
    }

    // A manager can only create a team they themselves manage - never hand
    // it to someone else. Only an admin may set an arbitrary managerId.
    const effectiveManagerId =
      req.user.role === 'manager' ? req.user._id : managerId || req.user._id;

    const missingIds = await findMissingUserIds([effectiveManagerId, ...members]);
    if (missingIds.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Unknown user id(s): ${missingIds.join(', ')}`,
      });
    }

    const team = await Team.create({
      name,
      description,
      managerId: effectiveManagerId,
      members,
    });

    res.status(201).json({
      success: true,
      message: 'Team created successfully',
      data: team,
    });
  } catch (error) {
    console.error('Error creating team:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * @route   GET /api/teams
 * @desc    List teams - admin sees every team, manager sees only teams
 *          they manage
 * @access  Private (manage:team - manager or admin)
 */
export const listTeams = async (req, res) => {
  try {
    const query = req.user.role === 'admin' ? {} : { managerId: req.user._id };
    const teams = await Team.find(query).sort({ name: 1 });

    res.status(200).json({
      success: true,
      data: teams,
    });
  } catch (error) {
    console.error('Error listing teams:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * @route   GET /api/teams/:id
 * @desc    Get a single team
 * @access  Private (manage:team + checkTeamAccess)
 */
export const getTeamById = async (req, res) => {
  try {
    const team = await Team.findById(req.params.id);

    if (!team) {
      return res.status(404).json({
        success: false,
        message: 'Team not found',
      });
    }

    res.status(200).json({
      success: true,
      data: team,
    });
  } catch (error) {
    console.error('Error fetching team:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * @route   PATCH /api/teams/:id
 * @desc    Update a team
 * @access  Private (manage:team + checkTeamAccess)
 */
export const updateTeam = async (req, res) => {
  try {
    const { name, description, isActive, members, managerId } = req.body;

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (isActive !== undefined) updates.isActive = isActive;

    if (members !== undefined) {
      const missingIds = await findMissingUserIds(members);
      if (missingIds.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Unknown user id(s): ${missingIds.join(', ')}`,
        });
      }
      updates.members = members;
    }

    // Same reasoning as createTeam - a manager can't hand their team off to
    // someone else; only an admin may reassign managerId.
    if (managerId !== undefined && req.user.role === 'admin') {
      const missingIds = await findMissingUserIds([managerId]);
      if (missingIds.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Unknown user id: ${managerId}`,
        });
      }
      updates.managerId = managerId;
    }

    const team = await Team.findByIdAndUpdate(req.params.id, updates, {
      new: true,
      runValidators: true,
    });

    if (!team) {
      return res.status(404).json({
        success: false,
        message: 'Team not found',
      });
    }

    res.status(200).json({
      success: true,
      message: 'Team updated successfully',
      data: team,
    });
  } catch (error) {
    console.error('Error updating team:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * @route   DELETE /api/teams/:id
 * @desc    Deactivate a team (soft delete - isActive: false, never removed
 *          outright, since it's a reversible action and other records may
 *          still reference this team's id)
 * @access  Private (delete:all / manage:team + checkTeamAccess)
 */
export const deleteTeam = async (req, res) => {
  try {
    const team = await Team.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true }
    );

    if (!team) {
      return res.status(404).json({
        success: false,
        message: 'Team not found',
      });
    }

    res.status(200).json({
      success: true,
      message: 'Team deactivated successfully',
      data: team,
    });
  } catch (error) {
    console.error('Error deleting team:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

export default { createTeam, listTeams, getTeamById, updateTeam, deleteTeam };
