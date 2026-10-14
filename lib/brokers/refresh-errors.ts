// Token-refresh outcomes that are TRANSIENT and must never raise a "reconnect required" alert.
// A refresh that started within the last 30 s is still in flight (another invocation holds the compare-and-swap claim). Reporting
// that as a critical "connection expired" alert is wrong twice over: nothing is broken, and the alert text overwrote the real failure
// reason (e.g. Webull's repeated `refresh failed (417)`), hiding what actually needed fixing.
export const REFRESH_IN_FLIGHT = "refresh in flight — retry";
export const isTransientRefreshError = (error: string | undefined | null): boolean => error === REFRESH_IN_FLIGHT;
