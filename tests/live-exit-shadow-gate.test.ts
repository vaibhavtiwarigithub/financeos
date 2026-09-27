import { describe, expect, it } from "vitest";
import { liveExitShadowMode } from "@/lib/trading/live-exit-monitor";

describe("live exit monitor execution/shadow separation", () => {
  it("runs the evidence-only shadow whenever either execution kill switch is off", () => {
    expect(liveExitShadowMode(false, false)).toBe(true);
    expect(liveExitShadowMode(false, true)).toBe(true);
    expect(liveExitShadowMode(true, false)).toBe(true);
  });

  it("enters the executable mode only when both deployment and owner switches are explicitly on", () => {
    expect(liveExitShadowMode(true, true)).toBe(false);
  });
});
