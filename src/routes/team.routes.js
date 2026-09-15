import express from 'express';
import { protect } from '../middleware/auth.js';
import { authorize, checkTeamAccess } from '../middleware/rbac.js';
import * as teamCtrl from '../controllers/teamController.js';

/**
 * Team Routes - CRUD for the Team model (name, manager, members).
 * Mounted at /api/teams (see app.js).
 *
 * manage:team is held by 'manager' and 'admin' only (see rbac.js's
 * rolePermissions) - a plain 'user' gets 403 on every route here, matching
 * how /api/analytics/team-performance is already gated.
 *
 * :id routes additionally go through checkTeamAccess (rbac.js), which lets
 * admin through unconditionally but restricts manager to teams they
 * themselves manage - this is the first route wiring for that middleware,
 * which previously existed but was never used anywhere.
 */

const router = express.Router();

router.use(protect);

const canManage = authorize(['manage:team']);
// Mirrors salesforce.routes.js's existing convention - manage:team is
// already treated as sufficient for destructive operations there, so a
// manager deactivating their own team is consistent with that, not a new,
// looser rule invented here.
const canDelete = authorize(['delete:all', 'manage:team']);

router.get('/', canManage, teamCtrl.listTeams);
router.post('/', canManage, teamCtrl.createTeam);
router.get('/:id', canManage, checkTeamAccess, teamCtrl.getTeamById);
router.patch('/:id', canManage, checkTeamAccess, teamCtrl.updateTeam);
router.delete('/:id', canDelete, checkTeamAccess, teamCtrl.deleteTeam);

export default router;
