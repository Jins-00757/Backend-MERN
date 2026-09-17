
import { getChatReply, isGroqConfigured } from '../services/groqService.js';
import AuditLogger from '../services/AuditLogger.js';

/**
 * @route   GET /api/chatbot/status
 * @desc    Whether the AI assistant is configured (GROQ_API_KEY set) - lets
 *          the frontend hide the chat widget entirely rather than showing a
 *          bubble that always errors when an admin hasn't set the key.
 * @access  Private
 */
export const getStatus = (req, res) => {
  res.status(200).json({ success: true, data: { enabled: isGroqConfigured() } });
};

/**
 * @route   POST /api/chatbot/message
 * @desc    Send one chat turn to the Groq-backed assistant and return its
 *          reply. Stateless on the backend: the client resends recent
 *          history each call (see groqService.sanitizeHistory for the
 *          server-side cap), nothing is persisted here.
 * @access  Private
 *
 * Only usage metadata is audit-logged, never message content - this chat can
 * be used to paste/summarize arbitrary text, so treating message bodies like
 * any other sensitive user input (not stored) is a deliberate data-
 * minimization choice, not an oversight.
 */
export const sendMessage = async (req, res, next) => {
  const { message, history } = req.body;

  try {
    const reply = await getChatReply({ message, history });

    AuditLogger.log('CREATE', {
      userId: req.user._id,
      resourceType: 'ChatbotMessage',
      eventType: 'chatbot.message',
      title: 'AI assistant message',
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch((err) => console.error('Failed to audit-log chatbot activity:', err.message));

    res.status(200).json({ success: true, data: { reply } });
  } catch (error) {
    AuditLogger.log('CREATE', {
      userId: req.user._id,
      resourceType: 'ChatbotMessage',
      eventType: 'chatbot.message',
      title: 'AI assistant message',
      status: 'failure',
      errorMessage: error.message,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch((err) => console.error('Failed to audit-log chatbot failure:', err.message));

    next(error);
  }
};
