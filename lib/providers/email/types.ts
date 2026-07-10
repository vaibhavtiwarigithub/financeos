export interface EmailMessage {
  from: string;
  to: string | string[];
  subject: string;
  html: string;
}

export interface EmailProvider {
  readonly name: string;
  isAvailable(): boolean;
  /** Sends the message. Never throws — swallows errors so callers don't need try/catch. */
  send(msg: EmailMessage): Promise<void>;
}
