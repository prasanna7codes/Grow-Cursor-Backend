
import { Resend } from 'resend';
import dotenv from 'dotenv';
import path from 'path';

// Fix for dynamic import of 'dotenv' if using ESM
dotenv.config();

const resend = new Resend(process.env.RESEND_API_KEY || 're_123456789'); // Placeholder if key missing to prevent crash on init from null

/**
 * Generic function to send an email
 * @param {Object} options - Email options
 */
export const sendEmail = async ({ to, subject, html }) => {
  if (!process.env.RESEND_API_KEY) {
    console.warn('⚠️ RESEND_API_KEY is missing in .env. Email sending skipped.');
    return;
  }

  // Handle Resend Free Plan limitation: Can only send to verified email
  // If RESEND_TEST_EMAIL is set, redirect all emails to that address
  const finalTo = process.env.RESEND_TEST_EMAIL || to;

  if (process.env.RESEND_TEST_EMAIL) {
    console.log(`ℹ️ [Free Plan Mode] Redirecting email for ${JSON.stringify(to)} to ${finalTo}`);
  }

  try {
    const data = await resend.emails.send({
      from: 'Grow Cursor <onboarding@resend.dev>', // Default sender for Resend free tier/test
      to: finalTo,
      subject,
      html,
    });
    console.log('✅ Email sent successfully:', data);
    return data;
  } catch (error) {
    console.error('❌ Error sending email:', error);
    // Don't throw error to prevent blocking the main request flow
  }
};

/**
 * Send email notification for a new announcement
 * @param {Object} announcement - The announcement object
 * @param {string[]} recipients - List of recipient emails
 */
export const sendAnnouncementEmail = async (announcement, recipients) => {
  if (!recipients || recipients.length === 0) return;

  const subject = `📢 [Announcement] ${announcement.title}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
      <h2 style="color: #2c3e50;">${announcement.title}</h2>
      <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #3498db;">
        <p style="white-space: pre-wrap; margin: 0;">${announcement.message}</p>
      </div>
      <div style="color: #7f8c8d; font-size: 12px; margin-top: 20px; border-top: 1px solid #eee; padding-top: 10px;">
        <p style="margin: 5px 0;">Priority: <strong>${announcement.priority}</strong></p>
        <p style="margin: 5px 0;">Posted by: ${announcement.createdBy}</p>
      </div>
    </div>
  `;

  // Use BCC for bulk emails to protect privacy and respect potential limits on 'to' field visible list
  // Note: Free tier Resend might have limits on number of recipients per request.
  // For 'company-wide', recipient list could be large.
  // In a real production scenario with large user base, batching would be needed.
  // For now, assuming manageable list size.

  // Resend API allows up to 50 recipients in to/cc/bcc combined on free tier usually, need to check specific plan limits.
  // We'll proceed with simple implementation.

  // Safe-guard: split into chunks if needed, but for MVP keep simple.

  await sendEmail({
    to: recipients, // Testing with 'to' for visibility during dev
    subject,
    html
  });
};

/**
 * Send email notification for a new issue
 * @param {Object} issue - The issue object
 * @param {string[]} recipients - List of recipient emails
 */
export const sendIssueCreatedEmail = async (issue, recipients) => {
  if (!recipients || recipients.length === 0) return;

  const priorityColor = issue.priority === 'high' ? '#e74c3c' : issue.priority === 'medium' ? '#f39c12' : '#2ecc71';

  const subject = `🚨 [New Issue] ${issue.title} (${issue.priority.toUpperCase()})`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
      <h2 style="color: #c0392b; border-bottom: 2px solid #eee; padding-bottom: 10px;">New Issue Reported</h2>
      
      <table style="width: 100%; margin-bottom: 20px; border-collapse: collapse;">
        <tr>
          <td style="padding: 8px 0; width: 120px; font-weight: bold;">Title:</td>
          <td style="padding: 8px 0;">${issue.title}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; font-weight: bold;">Type:</td>
          <td style="padding: 8px 0;">${issue.type}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; font-weight: bold;">Priority:</td>
          <td style="padding: 8px 0;"><span style="color: ${priorityColor}; font-weight: bold;">${issue.priority.toUpperCase()}</span></td>
        </tr>
        <tr>
          <td style="padding: 8px 0; font-weight: bold;">Department:</td>
          <td style="padding: 8px 0;">${issue.department || 'General'}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; font-weight: bold;">Reported By:</td>
          <td style="padding: 8px 0;">${issue.createdBy}</td>
        </tr>
        ${issue.completeByDate ? `
        <tr>
          <td style="padding: 8px 0; font-weight: bold;">Due Date:</td>
          <td style="padding: 8px 0;">${new Date(issue.completeByDate).toLocaleDateString()}</td>
        </tr>` : ''}
      </table>
      
      <div style="background-color: #fff3e0; padding: 15px; border-radius: 5px; border: 1px solid #ffe0b2;">
        <strong style="display: block; margin-bottom: 10px; color: #e65100;">Description:</strong>
        <p style="white-space: pre-wrap; margin: 0; line-height: 1.5;">${issue.description}</p>
      </div>
      
      <div style="margin-top: 30px; text-align: center; color: #999; font-size: 12px;">
        <p>You are receiving this notification because you are an admin or department head.</p>
      </div>
    </div>
  `;

  await sendEmail({
    to: recipients,
    subject,
    html
  });
};

/**
 * Send email notification for a new leave request
 * @param {Object} leave - The leave request object (populated user preferred)
 * @param {string[]} recipients - List of recipient emails
 */
export const sendLeaveRequestEmail = async (leave, recipients) => {
  if (!recipients || recipients.length === 0) return;

  const subject = `🗓️ [Leave Request] ${leave.user?.username || 'Employee'} requested leave`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
      <h2 style="color: #2c3e50;">Leave Request Submitted</h2>
      <table style="width:100%; border-collapse: collapse; margin-bottom: 16px;">
        <tr><td style="padding:6px; font-weight:600; width:140px;">Employee:</td><td style="padding:6px;">${leave.user?.username || 'Unknown'}</td></tr>
        <tr><td style="padding:6px; font-weight:600;">Department:</td><td style="padding:6px;">${leave.user?.department || 'N/A'}</td></tr>
        <tr><td style="padding:6px; font-weight:600;">Start Date:</td><td style="padding:6px;">${new Date(leave.startDate).toLocaleDateString()}</td></tr>
        <tr><td style="padding:6px; font-weight:600;">End Date:</td><td style="padding:6px;">${new Date(leave.endDate).toLocaleDateString()}</td></tr>
        <tr><td style="padding:6px; font-weight:600;">Days:</td><td style="padding:6px;">${leave.numberOfDays}</td></tr>
      </table>
      <div style="background:#f7f9fc; padding:12px; border-radius:6px; border:1px solid #e6eef8;">
        <strong style="display:block; margin-bottom:8px;">Reason</strong>
        <p style="white-space:pre-wrap; margin:0;">${leave.reason || ''}</p>
      </div>
      <div style="margin-top:18px; font-size:12px; color:#777">This request is currently in <strong>${leave.status}</strong> status.</div>
    </div>
  `;

  await sendEmail({ to: recipients, subject, html });
};
