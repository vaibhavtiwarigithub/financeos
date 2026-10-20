export type AlertClassificationInput = {
  severity?: string | null;
  category?: string | null;
  title?: string | null;
  detail?: string | null;
};

/** Keep owner-operated connection work separate from system failures. */
export function isOwnerActionAlert(alert: AlertClassificationInput): boolean {
  return alert.category === "broker" || /\b(reconnect|owner action|manual login)\b|(?:claude|codex).*?(?:run on your pc|signed out|usage limit)|(?:pc|local machine).*?(?:off|asleep)|cli.*?signed out/i.test(`${alert.title ?? ""} ${alert.detail ?? ""}`);
}

export function isInformationalNoticeAlert(alert: AlertClassificationInput): boolean {
  return alert.severity === "info" || alert.severity === "success" || /(?:✅|\bevidence is ready\b)/i.test(alert.title ?? "");
}

/** Informational and successful notices are visible, but are not health failures. */
export function isActionableHealthAlert(alert: AlertClassificationInput): boolean {
  return !isInformationalNoticeAlert(alert) && !isOwnerActionAlert(alert);
}
