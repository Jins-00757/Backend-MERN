import nodemailer from 'nodemailer';
import { resolve4 } from 'node:dns/promises';
import { config } from '../config/env.js';

/**
 * Single shared SMTP transport, created lazily so a missing/incomplete
 * EMAIL_* config doesn't crash the whole server at import time - it only
 * surfaces as an error when an email actually needs to be sent.
 *
 * BUG FIX: nodemailer's `family` transport option (previously set here to
 * force IPv4) is not actually honored anywhere in its connection logic -
 * confirmed by reading its installed source (smtp-connection/index.js,
 * shared/index.js): resolveHostname() unconditionally resolves *both*
 * A and AAAA records and never once reads a `family` option to skip IPv6.
 * Render (and many PaaS hosts) has no outbound IPv6 route, so whenever that
 * dual-stack resolution handed back an IPv6 address for smtp.gmail.com, the
 * connection failed immediately with ENETUNREACH even with `family: 4` set -
 * this was silently never actually taking effect.
 *
 * The one connection mode nodemailer's resolver can't override: a literal
 * IP address as `host` short-circuits its DNS resolution entirely
 * (`net.isIP(options.host)` in resolveHostname()), so it never has the
 * chance to resolve or try an IPv6 address at all. Resolving the hostname
 * to a literal IPv4 address ourselves via Node's own `dns.resolve4` (a
 * genuine A-record lookup, unaffected by local network interface routing)
 * and passing that as `host`, with `servername` set to the real hostname
 * for TLS SNI/certificate validation, is the only way that's actually been
 * confirmed to work.
 */
let transporter = null;
let transporterHost = null;

const resolveEmailHostIPv4 = async () => {
  try {
    const [address] = await resolve4(config.emailHost);
    return address;
  } catch (err) {
    console.error(`Failed to resolve ${config.emailHost} to an IPv4 address, connecting by hostname instead:`, err.message);
    return config.emailHost;
  }
};

const buildTransporter = async () => {
  const host = await resolveEmailHostIPv4();
  transporterHost = host;

  return nodemailer.createTransport({
    host,
    // TLS/SNI must still validate against the real hostname, not the IP
    // literal we're connecting to - see this.servername in
    // smtp-connection/index.js, which falls back to `false` (no SNI at
    // all) for a literal IP host unless this is set explicitly.
    servername: config.emailHost,
    port: config.emailPort,
    secure: config.emailPort === 465, // true for 465 (implicit TLS), false for 587 (STARTTLS)
    auth: {
      user: config.emailUser,
      pass: config.emailPassword,
    },
    // nodemailer's defaults (2min connect / 10min socket) mean a genuinely
    // unreachable/blocked SMTP host hangs the request far longer than any
    // reasonable client timeout, which just looks like "timeout error"
    // with no indication of why. Fail fast instead, so a real SMTP
    // problem surfaces as its own clear error rather than being
    // indistinguishable from ordinary slow-cold-start latency.
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });
};

const getTransporter = async () => {
  if (!config.emailUser || !config.emailPassword) {
    throw new Error('Email is not configured (EMAIL_USER/EMAIL_PASSWORD missing)');
  }

  if (!transporter) {
    transporter = await buildTransporter();
  }

  return transporter;
};

/**
 * Connection-level failure codes worth invalidating the cached transporter
 * over - the resolved IP may have gone stale (Google's SMTP endpoints do
 * rotate occasionally) or was simply unreachable this one time. Anything
 * else (auth failure, rejected recipient, etc.) is a real error the caller
 * should see as-is, not something a fresh IP would fix.
 */
const isConnectionLevelError = (err) =>
  ['ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'ECONNREFUSED', 'ESOCKET'].includes(err.code);

/**
 * Every send* helper below goes through this instead of calling
 * transporter.sendMail() directly - on a connection-level failure it drops
 * the cached transporter (so the *next* send re-resolves a fresh IPv4
 * address rather than being stuck reusing a bad one for the rest of the
 * process's life) and retries exactly once against a freshly resolved host.
 */
const sendMail = async (mailOptions) => {
  const mailer = await getTransporter();

  try {
    return await mailer.sendMail(mailOptions);
  } catch (err) {
    if (!isConnectionLevelError(err)) throw err;

    console.error(`SMTP connection to ${transporterHost} failed (${err.code}), re-resolving and retrying once:`, err.message);
    transporter = null;
    const retryMailer = await getTransporter();
    return retryMailer.sendMail(mailOptions);
  }
};

const passwordResetTemplate = ({ name, resetUrl }) => `
<div style="background-color:#f4f5fa;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e5e7eb;">
    <tr>
      <td style="padding:32px 32px 8px;text-align:center;">
        <div style="display:inline-flex;align-items:center;gap:10px;">
          <div style="width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#667eea,#764ba2);"></div>
          <span style="font-size:18px;font-weight:700;color:#111827;">Sales Pipeline <span style="background:linear-gradient(135deg,#667eea,#764ba2);-webkit-background-clip:text;background-clip:text;color:transparent;">Intelligence</span></span>
        </div>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 32px 0;">
        <h1 style="font-size:20px;color:#111827;margin:0 0 12px;">Reset your password</h1>
        <p style="font-size:14px;line-height:1.6;color:#4b5563;margin:0 0 24px;">
          Hi ${name || 'there'}, we received a request to reset the password for your Sales Pipeline Intelligence account.
          This link expires in 30 minutes and can only be used once.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:0 32px;text-align:center;">
        <a href="${resetUrl}"
           style="display:inline-block;padding:12px 28px;border-radius:9px;background:linear-gradient(135deg,#667eea,#764ba2);color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;">
          Reset Password
        </a>
      </td>
    </tr>
    <tr>
      <td style="padding:24px 32px 8px;">
        <p style="font-size:12.5px;line-height:1.6;color:#9ca3af;margin:0;">
          If the button above doesn't work, copy and paste this link into your browser:<br />
          <a href="${resetUrl}" style="color:#667eea;word-break:break-all;">${resetUrl}</a>
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 32px 32px;border-top:1px solid #f3f4f6;">
        <p style="font-size:12.5px;line-height:1.6;color:#9ca3af;margin:16px 0 0;">
          If you didn't request a password reset, you can safely ignore this email - your password will not be changed.
        </p>
      </td>
    </tr>
  </table>
</div>
`;

/**
 * Send the password reset email. Throws on failure so callers (the
 * forgot-password controller) can decide how to respond - it must not be
 * swallowed silently, or a broken email config would look like a working
 * reset flow.
 */
export const sendPasswordResetEmail = async ({ to, name, resetUrl }) => {
  await sendMail({
    from: `"Sales Pipeline Intelligence" <${config.emailFrom}>`,
    to,
    subject: 'Reset your Sales Pipeline Intelligence password',
    html: passwordResetTemplate({ name, resetUrl }),
    text: `Hi ${name || 'there'},\n\nWe received a request to reset your Sales Pipeline Intelligence password. This link expires in 30 minutes:\n${resetUrl}\n\nIf you didn't request this, you can safely ignore this email.`,
  });
};

const verifyEmailTemplate = ({ name, verifyUrl }) => `
<div style="background-color:#f4f5fa;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e5e7eb;">
    <tr>
      <td style="padding:32px 32px 8px;text-align:center;">
        <div style="display:inline-flex;align-items:center;gap:10px;">
          <div style="width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#667eea,#764ba2);"></div>
          <span style="font-size:18px;font-weight:700;color:#111827;">Sales Pipeline <span style="background:linear-gradient(135deg,#667eea,#764ba2);-webkit-background-clip:text;background-clip:text;color:transparent;">Intelligence</span></span>
        </div>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 32px 0;">
        <h1 style="font-size:20px;color:#111827;margin:0 0 12px;">Verify your email address</h1>
        <p style="font-size:14px;line-height:1.6;color:#4b5563;margin:0 0 24px;">
          Hi ${name || 'there'}, confirm this is your email address to finish setting up your Sales Pipeline
          Intelligence account. This link expires in 24 hours.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:0 32px;text-align:center;">
        <a href="${verifyUrl}"
           style="display:inline-block;padding:12px 28px;border-radius:9px;background:linear-gradient(135deg,#667eea,#764ba2);color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;">
          Verify Email
        </a>
      </td>
    </tr>
    <tr>
      <td style="padding:24px 32px 8px;">
        <p style="font-size:12.5px;line-height:1.6;color:#9ca3af;margin:0;">
          If the button above doesn't work, copy and paste this link into your browser:<br />
          <a href="${verifyUrl}" style="color:#667eea;word-break:break-all;">${verifyUrl}</a>
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 32px 32px;border-top:1px solid #f3f4f6;">
        <p style="font-size:12.5px;line-height:1.6;color:#9ca3af;margin:16px 0 0;">
          If you didn't create a Sales Pipeline Intelligence account, you can safely ignore this email.
        </p>
      </td>
    </tr>
  </table>
</div>
`;

/**
 * Send the "verify your email" link (sent on signup, and again whenever the
 * user asks for a resend). Throws on failure like sendPasswordResetEmail -
 * see auth.controller.js for how each caller handles that.
 */
export const sendVerificationEmail = async ({ to, name, verifyUrl }) => {
  await sendMail({
    from: `"Sales Pipeline Intelligence" <${config.emailFrom}>`,
    to,
    subject: 'Verify your Sales Pipeline Intelligence email',
    html: verifyEmailTemplate({ name, verifyUrl }),
    text: `Hi ${name || 'there'},\n\nConfirm this is your email address to finish setting up your Sales Pipeline Intelligence account. This link expires in 24 hours:\n${verifyUrl}\n\nIf you didn't create this account, you can safely ignore this email.`,
  });
};

const brandHeader = `
  <tr>
    <td style="padding:32px 32px 8px;text-align:center;">
      <div style="display:inline-flex;align-items:center;gap:10px;">
        <div style="width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#667eea,#764ba2);"></div>
        <span style="font-size:18px;font-weight:700;color:#111827;">Sales Pipeline <span style="background:linear-gradient(135deg,#667eea,#764ba2);-webkit-background-clip:text;background-clip:text;color:transparent;">Intelligence</span></span>
      </div>
    </td>
  </tr>
`;

const stageChangeTemplate = ({ name, dealName, oldStage, newStage, amount }) => `
<div style="background-color:#f4f5fa;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e5e7eb;">
    ${brandHeader}
    <tr>
      <td style="padding:16px 32px 0;">
        <h1 style="font-size:20px;color:#111827;margin:0 0 12px;">Deal stage updated</h1>
        <p style="font-size:14px;line-height:1.6;color:#4b5563;margin:0 0 16px;">
          Hi ${name || 'there'}, <strong>${dealName}</strong> moved from <strong>${oldStage}</strong> to <strong>${newStage}</strong>.
        </p>
        ${amount ? `<p style="font-size:14px;line-height:1.6;color:#4b5563;margin:0 0 8px;">Deal value: <strong>$${Number(amount).toLocaleString()}</strong></p>` : ''}
      </td>
    </tr>
    <tr>
      <td style="padding:8px 32px 32px;">
        <div style="display:flex;align-items:center;justify-content:center;gap:12px;padding:14px;background:#f9fafb;border-radius:10px;">
          <span style="font-size:13px;font-weight:600;color:#6b7280;">${oldStage}</span>
          <span style="color:#9ca3af;">&rarr;</span>
          <span style="font-size:13px;font-weight:700;color:#667eea;">${newStage}</span>
        </div>
      </td>
    </tr>
  </table>
</div>
`;

/**
 * Send a deal stage change notification. Fire-and-forget from the caller's
 * perspective (opportunitiesController) - a failed notification email must
 * never fail the opportunity update itself, so this still throws on failure
 * like every other send* helper here, and the caller decides whether to
 * await it or just log the rejection.
 */
export const sendDealStageChangeEmail = async ({ to, name, dealName, oldStage, newStage, amount }) => {
  await sendMail({
    from: `"Sales Pipeline Intelligence" <${config.emailFrom}>`,
    to,
    subject: `${dealName}: ${oldStage} → ${newStage}`,
    html: stageChangeTemplate({ name, dealName, oldStage, newStage, amount }),
    text: `Hi ${name || 'there'},\n\n${dealName} moved from ${oldStage} to ${newStage}.${
      amount ? ` Deal value: $${Number(amount).toLocaleString()}` : ''
    }`,
  });
};

const dailySummaryTemplate = ({ name, stats }) => {
  const stageRows = (stats.stageBreakdown || [])
    .map(
      (s) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;font-size:13px;color:#374151;">${s.stage}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;font-size:13px;color:#374151;text-align:right;">${s.count}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;font-size:13px;color:#374151;text-align:right;">$${(s.totalAmount || 0).toLocaleString()}</td>
        </tr>`
    )
    .join('');

  return `
<div style="background-color:#f4f5fa;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e5e7eb;">
    ${brandHeader}
    <tr>
      <td style="padding:16px 32px 0;">
        <h1 style="font-size:20px;color:#111827;margin:0 0 4px;">Your daily pipeline summary</h1>
        <p style="font-size:13px;color:#9ca3af;margin:0 0 20px;">Hi ${name || 'there'} - here's where things stand today.</p>
      </td>
    </tr>
    <tr>
      <td style="padding:0 32px;">
        <div style="display:flex;gap:12px;margin-bottom:20px;">
          <div style="flex:1;background:#f0f9ff;border-radius:10px;padding:14px;text-align:center;">
            <div style="font-size:11px;font-weight:700;color:#3b82f6;text-transform:uppercase;">Open Deals</div>
            <div style="font-size:22px;font-weight:700;color:#111827;">${stats.totalOpportunities ?? 0}</div>
          </div>
          <div style="flex:1;background:#fef2f2;border-radius:10px;padding:14px;text-align:center;">
            <div style="font-size:11px;font-weight:700;color:#ef4444;text-transform:uppercase;">Pipeline Value</div>
            <div style="font-size:22px;font-weight:700;color:#111827;">$${(stats.totalPipelineValue || 0).toLocaleString()}</div>
          </div>
        </div>
      </td>
    </tr>
    <tr>
      <td style="padding:0 32px 32px;">
        <table role="presentation" width="100%" style="border-collapse:collapse;">
          <thead>
            <tr>
              <th style="padding:8px 12px;text-align:left;font-size:11px;color:#9ca3af;text-transform:uppercase;">Stage</th>
              <th style="padding:8px 12px;text-align:right;font-size:11px;color:#9ca3af;text-transform:uppercase;">Deals</th>
              <th style="padding:8px 12px;text-align:right;font-size:11px;color:#9ca3af;text-transform:uppercase;">Value</th>
            </tr>
          </thead>
          <tbody>
            ${stageRows || '<tr><td colspan="3" style="padding:12px;text-align:center;color:#9ca3af;font-size:13px;">No open opportunities</td></tr>'}
          </tbody>
        </table>
      </td>
    </tr>
  </table>
</div>
`;
};

/**
 * Send the daily pipeline summary. Same fire-and-forget contract as
 * sendDealStageChangeEmail - see schedulerService.js, which sends these one
 * user at a time and logs (rather than throws on) a per-user failure so one
 * broken mailbox doesn't stop the rest of the batch.
 */
export const sendDailySummaryEmail = async ({ to, name, stats }) => {
  const totalValue = (stats.totalPipelineValue || 0).toLocaleString();

  await sendMail({
    from: `"Sales Pipeline Intelligence" <${config.emailFrom}>`,
    to,
    subject: `Daily Pipeline Summary: ${stats.totalOpportunities ?? 0} open deals, $${totalValue}`,
    html: dailySummaryTemplate({ name, stats }),
    text: `Hi ${name || 'there'},\n\nYour daily pipeline summary:\nOpen deals: ${stats.totalOpportunities ?? 0}\nPipeline value: $${totalValue}\n\n${(
      stats.stageBreakdown || []
    )
      .map((s) => `${s.stage}: ${s.count} deals, $${(s.totalAmount || 0).toLocaleString()}`)
      .join('\n')}`,
  });
};

const quotePdfTemplate = ({ recipientName, senderName, quoteName, quoteNumber, accountName, grandTotal }) => `
<div style="background-color:#f4f5fa;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e5e7eb;">
    ${brandHeader}
    <tr>
      <td style="padding:16px 32px 0;">
        <h1 style="font-size:20px;color:#111827;margin:0 0 12px;">Your quote from ${senderName || 'Sales Pipeline Intelligence'}</h1>
        <p style="font-size:14px;line-height:1.6;color:#4b5563;margin:0 0 16px;">
          Hi ${recipientName || 'there'}, please find attached quote <strong>${quoteName}</strong>${quoteNumber ? ` (#${quoteNumber})` : ''}${accountName ? ` for ${accountName}` : ''}.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:8px 32px 32px;">
        <div style="text-align:center;padding:16px;background:#f9fafb;border-radius:10px;">
          <div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;">Grand Total</div>
          <div style="font-size:24px;font-weight:700;color:#111827;">$${Number(grandTotal || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>
      </td>
    </tr>
  </table>
</div>
`;

/**
 * Email a generated quote PDF to a recipient the user chose (quotesController's
 * emailQuotePdf). The PDF bytes are generated fresh server-side per send
 * (see ExportService.exportQuoteToPDF) rather than accepted from the client,
 * so this never trusts client-supplied file content and can't be used to
 * relay arbitrary attachments.
 */
export const sendQuotePdfEmail = async ({ to, recipientName, senderName, quoteName, quoteNumber, accountName, grandTotal, pdfBuffer, pdfFilename }) => {
  await sendMail({
    from: `"Sales Pipeline Intelligence" <${config.emailFrom}>`,
    to,
    subject: `Quote ${quoteNumber ? `#${quoteNumber} ` : ''}from ${senderName || 'Sales Pipeline Intelligence'}: ${quoteName}`,
    html: quotePdfTemplate({ recipientName, senderName, quoteName, quoteNumber, accountName, grandTotal }),
    text: `Hi ${recipientName || 'there'},\n\nPlease find attached quote "${quoteName}"${quoteNumber ? ` (#${quoteNumber})` : ''}${accountName ? ` for ${accountName}` : ''}.\nGrand Total: $${Number(grandTotal || 0).toLocaleString()}`,
    attachments: [
      {
        filename: pdfFilename,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ],
  });
};
