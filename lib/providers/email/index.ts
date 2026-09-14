// Email provider factory.
// Swap by setting EMAIL_PROVIDER=resend|smtp in env (default: resend).
// Add a custom provider: registerEmailProvider("sendgrid", () => new SendGridProvider()).
export * from "./types";

import { ResendEmailProvider } from "./resend";
import { SmtpEmailProvider }   from "./smtp";
import type { EmailProvider }  from "./types";

const _registry: Record<string, () => EmailProvider> = {
  resend: () => new ResendEmailProvider(),
  smtp:   () => new SmtpEmailProvider(),
};

let _singleton: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
  if (_singleton) return _singleton;
  const name = (process.env.EMAIL_PROVIDER ?? "resend").toLowerCase().trim();
  const factory = _registry[name];
  if (!factory) {
    throw new Error(`Unknown EMAIL_PROVIDER: "${name}". Valid: ${Object.keys(_registry).join(", ")}`);
  }
  _singleton = factory();
  return _singleton;
}

/**
 * Whether mail can ACTUALLY be delivered right now.
 *
 * Prefer this over `provider.isAvailable()` anywhere the answer changes what
 * the caller does. `isAvailable()` is env-only and synchronous; Resend resolves
 * its key from `api_key_vault` first, so the two disagree whenever the key is
 * stored there — which is what made the invitation route refuse to send while
 * email was working.
 */
export async function emailDeliveryAvailable(): Promise<boolean> {
  const provider = getEmailProvider() as EmailProvider & { isDeliverable?: () => Promise<boolean> };
  if (typeof provider.isDeliverable === "function") return provider.isDeliverable();
  return provider.isAvailable();
}

export function registerEmailProvider(name: string, factory: () => EmailProvider): void {
  _registry[name.toLowerCase()] = factory;
  _singleton = null;
}
