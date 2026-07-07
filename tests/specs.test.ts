import { describe, it, expect } from "vitest";
import { formatRequirements } from "../src/specs.js";

describe("formatRequirements", () => {
  it("collapses free-everywhere APIs", () => {
    expect(
      formatRequirements({
        marketing: "FREE",
        sales: "FREE",
        service: "FREE",
        cms: "FREE",
        commerce: "FREE",
        crmHub: "FREE",
        dataHub: "FREE",
      }),
    ).toBe("any HubSpot plan (Free and up)");
  });

  it("collapses a uniform paid tier across all hubs", () => {
    expect(
      formatRequirements({
        marketing: "PROFESSIONAL",
        sales: "PROFESSIONAL",
        service: "PROFESSIONAL",
        cms: "PROFESSIONAL",
        commerce: "PROFESSIONAL",
        crmHub: "PROFESSIONAL",
        dataHub: "PROFESSIONAL",
      }),
    ).toBe("Professional tier of any hub");
  });

  it("names the hubs for a narrow single-tier requirement", () => {
    expect(formatRequirements({ marketing: "PROFESSIONAL", cms: "PROFESSIONAL" })).toBe(
      "Professional tier of Marketing Hub / Content Hub",
    );
    expect(formatRequirements({ cms: "ENTERPRISE" })).toBe("Content Hub Enterprise");
  });

  it("spells out mixed tiers per hub", () => {
    expect(formatRequirements({ marketing: "PROFESSIONAL", cms: "STARTER" })).toBe(
      "Marketing Hub Professional, or Content Hub Starter",
    );
  });

  it("returns undefined when HubSpot lists no requirements", () => {
    expect(formatRequirements({})).toBeUndefined();
    expect(formatRequirements({ marketing: null })).toBeUndefined();
  });
});
