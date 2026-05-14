// Spec 028: TS mirror of the inline escapeHtml helper in
// supabase/functions/send-invite-email/index.ts and
// supabase/functions/send-welcome-email/index.ts. This module is
// NOT imported by those edge functions (different bundle); it
// exists exclusively as the jest-testable mirror.
export function escapeHtml(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
