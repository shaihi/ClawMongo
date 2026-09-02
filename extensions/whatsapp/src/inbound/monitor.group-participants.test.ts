import { describe, expect, it } from "vitest";
import { groupIdIfBotAdded } from "./monitor.js";

// TourBot §7: the group welcome must fire on "bot was added", never on
// "someone else was added" or on any non-"add" action. The @lid-safe
// identity compare (identitiesOverlap under the hood) is the point of the
// test — a raw JID string compare would fail the "bot's own @lid" cases.

const BOT_JID = "1234567890@s.whatsapp.net";
const BOT_LID = "998877665544@lid";
const OTHER_JID = "1112223333@s.whatsapp.net";
const GROUP_ID = "120000000000000001@g.us";

describe("groupIdIfBotAdded", () => {
  it("returns the group id when the bot itself is among the added participants", () => {
    const self = { jid: BOT_JID, e164: "+1234567890" };
    const result = groupIdIfBotAdded(
      { id: GROUP_ID, action: "add", participants: [OTHER_JID, BOT_JID] },
      self,
    );
    expect(result).toBe(GROUP_ID);
  });

  it("matches the bot's privacy @lid JID against its ordinary JID via identity overlap", () => {
    // The self identity was resolved from the e164/jid; the event reports the
    // bot only by its @lid form (WhatsApp's ghost-thread identity for privacy
    // contacts) — a raw string compare of BOT_JID vs BOT_LID would fail.
    const self = { jid: BOT_JID, lid: BOT_LID, e164: "+1234567890" };
    const result = groupIdIfBotAdded(
      { id: GROUP_ID, action: "add", participants: [{ id: BOT_LID }] },
      self,
    );
    expect(result).toBe(GROUP_ID);
  });

  it("does not fire when another participant (not the bot) is added", () => {
    const self = { jid: BOT_JID, e164: "+1234567890" };
    const result = groupIdIfBotAdded(
      { id: GROUP_ID, action: "add", participants: [OTHER_JID] },
      self,
    );
    expect(result).toBeNull();
  });

  it("does not fire on remove", () => {
    const self = { jid: BOT_JID, e164: "+1234567890" };
    const result = groupIdIfBotAdded(
      { id: GROUP_ID, action: "remove", participants: [BOT_JID] },
      self,
    );
    expect(result).toBeNull();
  });

  it("does not fire on promote/demote even if the bot is the subject", () => {
    const self = { jid: BOT_JID, e164: "+1234567890" };
    expect(
      groupIdIfBotAdded({ id: GROUP_ID, action: "promote", participants: [BOT_JID] }, self),
    ).toBeNull();
    expect(
      groupIdIfBotAdded({ id: GROUP_ID, action: "demote", participants: [BOT_JID] }, self),
    ).toBeNull();
  });

  it("is null-safe against a missing group id or participants list", () => {
    const self = { jid: BOT_JID, e164: "+1234567890" };
    expect(groupIdIfBotAdded({ action: "add", participants: [BOT_JID] }, self)).toBeNull();
    expect(groupIdIfBotAdded({ id: GROUP_ID, action: "add" }, self)).toBeNull();
  });
});
