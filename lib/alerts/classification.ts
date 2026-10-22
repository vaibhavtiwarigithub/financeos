export type AlertClassificationInput = {
  severity?: string | null;
  category?: string | null;
  title?: string | null;
  detail?: string | null;
};

/** Keep owner-operated connection work separate from system failures. */
export function isOwnerActionAlert(alert: AlertClassificationInput): boolean {
  const text = `${alert.title ?? ""} ${alert.detail ?? ""}`;
  // Broker is a subsystem, not an action class. Reconciliation/order failures
  // must remain visible even when their remediation mentions reconnecting.
  if (/\b(mismatch|oversell|double.sell|unprotected|unconfirmed|needs.reconcile|reconciliation failed|cancel failed|ledger.*failed|order.*(?:failed|unknown))\b/i.test(text)) return false;
  return /\b(reconnect|re-auth|owner action|manual login)\b|(?:claude|codex).*?(?:run on your pc|signed out|usage limit)|(?:pc|local machine).*?(?:off|asleep)|cli.*?signed out/i.test(text);
}

export function isInformationalNoticeAlert(alert: AlertClassificationInput): boolean {
  if (alert.severity === "critical") return false;
  return alert.severity === "info" || alert.severity === "success" || /(?:✅|\bevidence is ready\b)/i.test(alert.title ?? "");
}

/** Informational and successful notices are visible, but are not health failures. */
export function isActionableHealthAlert(alert: AlertClassificationInput): boolean {
  return !isInformationalNoticeAlert(alert) && !isOwnerActionAlert(alert);
}
