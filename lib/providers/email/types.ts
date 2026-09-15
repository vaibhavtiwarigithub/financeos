export interface EmailMessage {
  from: string;
  to: string | string[];
  subject: string;
  html: string;
}

export interface EmailProvider {
  readonly name: string;
  /**
   * Synchronous, env-only check. NOTE: a provider may resolve its credential
   * from somewhere this cannot see (Resend also reads `api_key_vault`), so a
   * false here does NOT prove mail is unconfigured. Use
   * `emailDeliveryAvailable()` when the answer must be right.
   */
  isAvailable(): boolean;
  /** Sends the message. Never throws — swallows errors so callers don't need try/catch. */
  send(msg: EmailMessage): Promise<void>;
  /**
   * Send and REPORT the outcome. Optional: `send` deliberately swallows
   * everything, which is fine for best-effort mail but useless when the caller
   * must not proceed on a silent failure — an invitation, for instance, where
   * granting access to someone who was never emailed is worse than an error.
   */
  sendChecked?(msg: EmailMessage): Promise<SendResult>;
}

export interface SendResult {
  ok: boolean;
  error?: string;
  /**
   * The provider's own id for the accepted message, when it returns one.
   *
   * ACCEPTANCE IS NOT DELIVERY. A provider returns 200 once it has taken the
   * message, and a dead mailbox bounces asynchronously minutes later. The id is
   * the only handle that ties that later webhook back to this exact send, so
   * anything that must know whether its mail actually ARRIVED has to keep it.
   */
  id?: string;
}
