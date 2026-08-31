import { afterEach, describe, expect, it } from "vitest";
import {
  buildGuideDeferralText,
  DEFAULT_GUIDE_E164,
  isGuidePresentInGroup,
  resolveGuideE164,
} from "./guide-presence.js";

describe("resolveGuideE164", () => {
  afterEach(() => {
    delete process.env.TOURBOT_GUIDE_E164;
  });

  it("defaults to Thom's configured number", () => {
    expect(resolveGuideE164()).toBe(DEFAULT_GUIDE_E164);
  });

  it("honors TOURBOT_GUIDE_E164 override", () => {
    process.env.TOURBOT_GUIDE_E164 = "+15551234567";
    expect(resolveGuideE164()).toBe("+15551234567");
  });
});

describe("isGuidePresentInGroup", () => {
  it("returns false when there are no participants and no roster", () => {
    expect(isGuidePresentInGroup({})).toBe(false);
  });

  it("matches the guide via a plain phone-number participant JID", () => {
    expect(
      isGuidePresentInGroup({
        groupParticipants: ["255787096872@s.whatsapp.net", "972524258852@s.whatsapp.net"],
      }),
    ).toBe(true);
  });

  it("does not match when the guide is absent from participants", () => {
    expect(
      isGuidePresentInGroup({
        groupParticipants: ["972524258852@s.whatsapp.net", "447700900000@s.whatsapp.net"],
      }),
    ).toBe(false);
  });

  it("matches via the group member roster (E.164 keys) when participants are unavailable", () => {
    const roster = new Map<string, string>([["+255787096872", "Thom"]]);
    expect(isGuidePresentInGroup({ roster })).toBe(true);
  });

  it("respects a custom guideE164 override", () => {
    expect(
      isGuidePresentInGroup({
        groupParticipants: ["15551234567@s.whatsapp.net"],
        guideE164: "+15551234567",
      }),
    ).toBe(true);
  });

  it("does not falsely match on a raw @lid participant with no phone mapping available", () => {
    // Without an authDir/lid-mapping file to resolve against, a bare @lid
    // participant cannot be proven to be the guide — must not match.
    expect(
      isGuidePresentInGroup({
        groupParticipants: ["999888777@lid"],
      }),
    ).toBe(false);
  });
});

describe("buildGuideDeferralText", () => {
  it("includes an @-mention token for the guide's number so outbound mention resolution can tag them", () => {
    const text = buildGuideDeferralText("+255787096872");
    expect(text).toContain("@+255787096872");
  });

  it("falls back to resolveGuideE164() when no override is given", () => {
    expect(buildGuideDeferralText()).toContain(`@${DEFAULT_GUIDE_E164}`);
  });
});
