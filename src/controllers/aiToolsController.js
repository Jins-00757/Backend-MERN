
import { runAgentTurn, confirmPendingAction } from '../services/aiToolsService.js';
import AuditLogger from '../services/AuditLogger.js';

const MAX_MESSAGE_LENGTH = 2000;
const MAX_HISTORY_MESSAGES = 8;

// Same "only trust user/assistant text turns from the client" stance as
// chatbotController's sanitizeHistory - a client-supplied 'system' or
// 'tool' role here would let the browser inject fake tool results or
// override the fixed system prompt, so anything else is dropped.
const sanitizeHistory = (history) => {
  if (!Array.isArray(history)) return [];

  return history
    .filter((entry) => entry && (entry.role === 'user' || entry.role === 'assistant') && typeof entry.content === 'string')
    .slice(-MAX_HISTORY_MESSAGES)
    .map((entry) => ({ role: entry.role, content: entry.content.slice(0, MAX_MESSAGE_LENGTH) }));
};

/**
 * @route   POST /api/ai/assistant/message
 * @desc    One turn of the CRM Actions Assistant. Unlike the general chatbot
 *          widget (chatbotController.js), this assistant can call read-only
 *          Salesforce lookup tools and can PROPOSE (never directly execute)
 *          mutating actions like approving a quote - see
 *          aiToolsService.runAgentTurn for the tool-calling loop, and
 *          confirmAction below for how a proposal actually gets executed.
 * @access  Private - requires a connected Salesforce account. Any
 *          authenticated role can chat/get proposals; only canWrite roles
 *          can actually confirm one (see aiTools/aiActions.routes.js).
 */
export const sendActionMessage = async (req, res) => {
  const { message, history } = req.body;

  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ success: false, message: 'Message is required' });
  }
  const trimmedMessage = message.trim();
  if (trimmedMessage.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ success: false, message: `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer` });
  }
  if (!req.user.isSalesforceConnected) {
    return res.status(400).json({ success: false, message: 'Connect your Salesforce account before using CRM actions' });
  }

  try {
    const { reply, pendingAction } = await runAgentTurn({
      message: trimmedMessage,
      history: sanitizeHistory(history),
      user: req.user,
    });

    // Same data-minimization stance as the general chat widget - only usage
    // metadata (and, when relevant, which action was proposed) is logged,
    // never message content.
    AuditLogger.log('CREATE', {
      userId: req.user._id,
      resourceType: 'ChatbotMessage',
      eventType: 'assistant.action_message',
      title: 'CRM actions assistant message',
      changes: pendingAction ? { proposedTool: pendingAction.tool } : undefined,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch((err) => console.error('Failed to audit-log assistant message:', err.message));

    res.status(200).json({ success: true, data: { reply, pendingAction: pendingAction || null } });
  } catch (error) {
    console.error('CRM actions assistant error:', error);

    AuditLogger.log('CREATE', {
      userId: req.user._id,
      resourceType: 'ChatbotMessage',
      eventType: 'assistant.action_message',
      status: 'failure',
      errorMessage: error.message,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch((err) => console.error('Failed to audit-log assistant failure:', err.message));

    res.status(error.statusCode || error.status || 500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/ai/assistant/confirm
 * @desc    Executes exactly one previously-proposed mutating tool call after
 *          explicit user confirmation - see aiToolsService.confirmPendingAction
 *          for the re-validation this performs (Quote Status re-checked
 *          against the org's live picklist, the write itself run through
 *          jsforce) before anything reaches Salesforce. That function does
 *          its own detailed audit log entry, so this controller doesn't
 *          duplicate one on success.
 * @access  Private - canWrite (same permission a manual quote status change
 *          requires, see quotesController.updateQuote / salesforce.routes.js)
 */
export const confirmAction = async (req, res) => {
  const { tool, args } = req.body;

  if (typeof tool !== 'string' || !tool) {
    return res.status(400).json({ success: false, message: 'tool is required' });
  }

  try {
    const result = await confirmPendingAction(req, { tool, args: args || {} });
    res.status(200).json({ success: true, message: 'Action completed', data: result });
  } catch (error) {
    console.error('CRM action confirmation error:', error);

    AuditLogger.log('UPDATE', {
      userId: req.user._id,
      resourceType: 'Quote',
      resourceId: args?.quoteId || null,
      eventType: 'quote.ai_approved_and_synced',
      status: 'failure',
      errorMessage: error.message,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch((err) => console.error('Failed to audit-log assistant confirmation failure:', err.message));

    res.status(error.statusCode || error.status || 500).json({ success: false, message: error.message });
  }
};
