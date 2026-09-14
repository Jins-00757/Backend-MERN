import nodemailer from 'nodemailer';
import { config } from '../config/env.js';

/**
 * Single shared SMTP transport, created lazily so a missing/incomplete
 * EMAIL_* config doesn't crash the whole server at import time - it only
 * surfaces as an error when an email actually needs to be sent.
 */
let transporter = null;

const getTransporter = () => {
  if (!config.emailUser || !config.emailPassword) {
    throw new Error('Email is not configured (EMAIL_USER/EMAIL_PASSWORD missing)');
  }

  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.emailHost,
      port: config.emailPort,
      secure: config.emailPort === 465, // true for 465 (implicit TLS), false for 587 (STARTTLS)
      auth: {
        user: config.emailUser,
        pass: config.emailPassword,
      },
    });
  }

  return transporter;
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
  const mailer = getTransporter();

  await mailer.sendMail({
    from: `"Sales Pipeline Intelligence" <${config.emailFrom}>`,
    to,
    subject: 'Reset your Sales Pipeline Intelligence password',
    html: passwordResetTemplate({ name, resetUrl }),
    text: `Hi ${name || 'there'},\n\nWe received a request to reset your Sales Pipeline Intelligence password. This link expires in 30 minutes:\n${resetUrl}\n\nIf you didn't request this, you can safely ignore this email.`,
  });
};
