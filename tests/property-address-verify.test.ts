import { describe, expect, it } from "vitest";
import {
  ADDRESS_VERIFICATION_LABEL,
  hasCompleteUsAddress,
  parseUspsAddressResponse,
  uspsCredentials,
  verifyPropertyAddress,
} from "@/lib/property/address-verify";

const AUSTIN = { addressLine: "1 Main St", city: "Austin", region: "TX", postalCode: "78701" };

describe("property address verification", () => {
  it("verifies only a USPS-standardized deliverable address", () => {
    const result = parseUspsAddressResponse(200, {
      address: { streetAddress: "1 MAIN ST", city: "AUSTIN", state: "TX", ZIPCode: "78701", ZIPPlus4: "1234" },
      additionalInfo: { DPVConfirmation: "Y" }, matches: [{}],
    });
    expect(result.state).toBe("verified");
    expect(result.source).toBe("usps");
    expect(result.standardized).toBe("1 MAIN ST, AUSTIN TX, 78701-1234");
    expect(result.postalCode).toBe("78701");
    expect(Date.parse(result.checkedAt)).not.toBeNaN();
  });

  it("does not claim deliverability without a positive, unambiguous DPV result", () => {
    const address = { streetAddress: "1 MAIN ST", city: "AUSTIN", state: "TX", ZIPCode: "78701" };
    expect(parseUspsAddressResponse(200, { address }).state).toBe("not_found");
    expect(parseUspsAddressResponse(200, { address, additionalInfo: { DPVConfirmation: "N" } }).state).toBe("not_found");
    expect(parseUspsAddressResponse(200, { address, additionalInfo: { DPVConfirmation: "Y" }, matches: [{}, {}] }).state).toBe("not_found");
  });

  it("fails closed on a 200 that carries no standardized street and ZIP", () => {
    // USPS can echo a partial match. Treating that as a pass is exactly the bug
    // this feature exists to prevent.
    expect(parseUspsAddressResponse(200, { address: { city: "AUSTIN", state: "TX" } }).state).toBe("not_found");
    expect(parseUspsAddressResponse(200, {}).state).toBe("not_found");
    expect(parseUspsAddressResponse(200, null).state).toBe("not_found");
  });

  it("reports a rejected address as not found and a broken credential or outage as unavailable", () => {
    expect(parseUspsAddressResponse(404, { error: { message: "Address Not Found" } }).state).toBe("not_found");
    expect(parseUspsAddressResponse(400, { error: { message: "Invalid State" } }).reason).toContain("Invalid State");
    expect(parseUspsAddressResponse(401, {}).state).toBe("unavailable");
    expect(parseUspsAddressResponse(503, {}).state).toBe("unavailable");
  });

  it("never claims a verification when no USPS credential is configured", async () => {
    const key = process.env.USPS_CONSUMER_KEY;
    const secret = process.env.USPS_CONSUMER_SECRET;
    delete process.env.USPS_CONSUMER_KEY;
    delete process.env.USPS_CONSUMER_SECRET;
    try {
      expect(uspsCredentials()).toBeNull();
      const result = await verifyPropertyAddress(AUSTIN, "austin");
      expect(result.state).toBe("not_configured");
      expect(result.source).toBe("none");
      // The UI has to be able to tell the owner the exact next step.
      expect(result.reason).toContain("developers.usps.com");
      expect(result.reason).toContain("USPS_CONSUMER_KEY");
      expect(result.standardized).toBeUndefined();
    } finally {
      if (key !== undefined) process.env.USPS_CONSUMER_KEY = key;
      if (secret !== undefined) process.env.USPS_CONSUMER_SECRET = secret;
    }
  });

  it("does not fake a result for India and does not check an incomplete address", async () => {
    const india = await verifyPropertyAddress({ addressLine: "1 MG Rd", city: "Bengaluru", region: "Karnataka", postalCode: "560001" }, "bengaluru");
    expect(india.state).toBe("no_validator");
    expect(india.source).toBe("none");
    expect(await verifyPropertyAddress({ addressLine: "1 Main St" }, "austin").then((r) => r.state)).toBe("not_found");
    expect(hasCompleteUsAddress(AUSTIN)).toBe(true);
    expect(hasCompleteUsAddress({ addressLine: "1 Main St", city: "Austin" })).toBe(false);
  });

  it("labels every state, and labels only a USPS match as verified", () => {
    expect(Object.values(ADDRESS_VERIFICATION_LABEL).every((label) => label.length > 0)).toBe(true);
    const verifiedLabels = Object.entries(ADDRESS_VERIFICATION_LABEL).filter(([, label]) => /^Address verified/.test(label));
    expect(verifiedLabels.map(([state]) => state)).toEqual(["verified"]);
  });
});
