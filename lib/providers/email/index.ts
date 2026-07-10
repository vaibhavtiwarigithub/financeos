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

export function registerEmailProvider(name: string, factory: () => EmailProvider): void {
  _registry[name.toLowerCase()] = factory;
  _singleton = null;
}
