/** Supabase email OTP length is configurable; do not assume its default. */
export const VAULT_RECOVERY_CODE_MIN_LENGTH = 6;
export const VAULT_RECOVERY_CODE_MAX_LENGTH = 12;

export function isVaultRecoveryCode(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= VAULT_RECOVERY_CODE_MIN_LENGTH
    && value.length <= VAULT_RECOVERY_CODE_MAX_LENGTH
    && /^\d+$/.test(value);
}
