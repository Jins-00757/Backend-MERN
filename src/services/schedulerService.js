
import cron from 'node-cron';
import User from '../models/User.js';
import { getSalesPipelineSummary } from '../controllers/data.controller.js';
import { sendDailySummaryEmail } from './emailService.js';
import { config } from '../config/env.js';
import NotificationService from './NotificationService.js';
import AuditLogger from './AuditLogger.js';

/**
 * Same opt-out semantics as notifyStageChange() in opportunitiesController.js:
 * daily summaries are sent unless the user has explicitly turned email
 * notifications off, and only ever to users with a connected Salesforce org
 * (there's nothing to summarize otherwise).
 */
const shouldReceiveDailySummary = (user) =>
  user.isSalesforceConnected && user.preferences?.notifications?.email !== false;

/**
 * Send the daily pipeline summary email to every eligible user. Exported
 * separately from startScheduledJobs() so it can be triggered directly
 * (manual testing, an admin "send now" action) without going through cron.
 * Each user's failure is caught and logged individually so one broken
 * mailbox or expired Salesforce token doesn't stop the rest of the batch.
 */
export const sendDailySummaries = async () => {
  const users = await User.find({ isSalesforceConnected: true, isInactive: { $ne: true } });
  let sent = 0;

  for (const user of users) {
    if (!shouldReceiveDailySummary(user)) continue;

    try {
      const { data: stats } = await getSalesPipelineSummary(user._id);
      await sendDailySummaryEmail({ to: user.email, name: user.name, stats });
      sent += 1;
    } catch (error) {
      console.error(`Daily summary email failed for user ${user._id}:`, error.message);

      // Same visibility gap as notifyStageChange() in opportunitiesController.js -
      // a batch job failure here previously only ever reached the server
      // log, never the user. Push it to their notification bell and persist
      // it so a bad address (or any other delivery failure) doesn't just
      // silently repeat every day at the next scheduled run.
      NotificationService.notify(user._id.toString(), 'notification.email_failed', {
        title: 'Daily summary email failed to send',
        message: `We couldn't email your daily pipeline summary to ${user.email}. Check your email address in Profile Information.`,
        resourceId: 'daily-summary',
      });

      AuditLogger.log('NOTIFY', {
        userId: user._id,
        resourceType: 'EmailNotification',
        resourceId: 'daily-summary',
        changes: { channel: 'email', event: 'daily_summary', to: user.email },
        status: 'failure',
        errorMessage: error.message,
      }).catch((auditError) => {
        console.error('Failed to record email delivery failure in audit log:', auditError.message);
      });
    }
  }

  console.log(`Daily summary emails sent: ${sent}/${users.length} eligible users`);
  return { sent, total: users.length };
};

let scheduledTask = null;

/**
 * Register the daily summary cron job. Safe to call more than once (only
 * the first call schedules anything) and a no-op when scheduled jobs are
 * disabled (see DISABLE_SCHEDULED_JOBS in config/env.js - useful for tests
 * and one-off scripts that import the app without wanting a background timer).
 */
export const startScheduledJobs = () => {
  if (scheduledTask || !config.enableScheduledJobs) return;

  scheduledTask = cron.schedule(config.dailySummaryCron, () => {
    sendDailySummaries().catch((error) => {
      console.error('Daily summary job failed:', error.message);
    });
  });

  console.log(`✓ Scheduled daily summary email job (cron: "${config.dailySummaryCron}")`);
};

export const stopScheduledJobs = () => {
  scheduledTask?.stop();
  scheduledTask = null;
};
