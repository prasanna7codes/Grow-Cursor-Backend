
/*
 * NO-OP email stub
 * -----------------
 * This file intentionally replaces the real email sending implementation
 * with no-op functions so that the application can run in production
 * without sending emails. Keep the exported function names and signatures
 * identical to the real implementation so route code does not need changes.
 *
 * Reverting to the real implementation:
 * - If you have the original implementation committed, restore with:
 *     git checkout -- src/lib/email.js
 * - Or retrieve it from your VCS history and replace this file.
 *
 * Notes:
 * - This stub logs when a mail function is invoked to help with debugging
 *   and to confirm that email code paths are still exercised.
 * - Keeping a single stub file is safer than removing route-level calls,
 *   reduces the risk of runtime import errors, and is easy to revert.
 */

/**
 * Generic no-op sendEmail. Logs the call and returns immediately.
 * @param {{to: string|Array<string>, subject: string, html: string}} options
 */
export const sendEmail = async ({ to, subject, html } = {}) => {
  console.info('[NO-OP EMAIL] sendEmail called. Email delivery is currently disabled. subject=%s, to=%s', subject, Array.isArray(to) ? to.length + ' recipients' : to);
  return null;
};

/**
 * No-op wrapper for announcement emails
 */
export const sendAnnouncementEmail = async (announcement, recipients) => {
  console.info('[NO-OP EMAIL] sendAnnouncementEmail called. Announcement id=%s, recipients=%d', announcement?._id || announcement?.id || 'unknown', Array.isArray(recipients) ? recipients.length : 0);
  return null;
};

/**
 * No-op wrapper for issue/idea-created emails
 */
export const sendIssueCreatedEmail = async (issue, recipients) => {
  console.info('[NO-OP EMAIL] sendIssueCreatedEmail called. Issue id=%s, recipients=%d', issue?._id || issue?.id || 'unknown', Array.isArray(recipients) ? recipients.length : 0);
  return null;
};

/**
 * No-op wrapper for leave request emails
 */
export const sendLeaveRequestEmail = async (leave, recipients) => {
  console.info('[NO-OP EMAIL] sendLeaveRequestEmail called. Leave id=%s, recipients=%d', leave?._id || leave?.id || 'unknown', Array.isArray(recipients) ? recipients.length : 0);
  return null;
};
