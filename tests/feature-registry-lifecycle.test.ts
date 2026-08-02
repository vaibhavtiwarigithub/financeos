import { describe, expect, it } from "vitest";
import { nextFeatureRegistryStatus } from "@/lib/feature-packs/lifecycle";

describe("feature registry lifecycle", () => {
  it("never auto-promotes a formula into an active scoring state", () => {
    expect(nextFeatureRegistryStatus("proposed", true, false)).toBe("quarantined");
    expect(nextFeatureRegistryStatus("quarantined", true, false)).toBe("measure_only");
    expect(nextFeatureRegistryStatus("measure_only", true, false)).toBe("measure_only");
  });

  it("retires only an already measured feature after persistent failure", () => {
    expect(nextFeatureRegistryStatus("quarantined", false, true)).toBe("quarantined");
    expect(nextFeatureRegistryStatus("measure_only", false, true)).toBe("retired");
  });
});
