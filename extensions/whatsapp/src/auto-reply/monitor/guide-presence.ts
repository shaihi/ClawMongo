// Group defer-to-guide: when the real human guide (Thom) is a participant of
// a WhatsApp group the bot is active in, the bot should not try to answer
// client questions autonomously in that group — it should defer to the
// guide instead. See resolveGuideE164() for how the guide's number is
// configured.
//
// Group participants can be identified by a privacy `@lid` rather than a
// plain phone-number JID (see identity.ts / ack-reaction.ts precedent), so
// this deliberately routes every participant string through
// resolveComparableIdentity + identitiesOverlap instead of doing a raw
// string/E.164 compare.
import {
  identitiesOverlap,
  resolveComparableIdentity,
  type WhatsAppIdentity,
} from "../../identity.js";
import { normalizeE164 } from "../../text-runtime.js";
import { resolveGuideE164 } from "./guide-activation-shared.js";

export { DEFAULT_GUIDE_E164, resolveGuideE164 } from "./guide-activation-shared.js";

export function isGuidePresentInGroup(params: {
  groupParticipants?: readonly string[];
  roster?: ReadonlyMap<string, string>;
  authDir?: string;
  guideE164?: string;
}): boolean {
  const guideE164 = normalizeE164(params.guideE164 ?? resolveGuideE164());
  if (!guideE164) {
    return false;
  }
  const guideIdentity: WhatsAppIdentity = { e164: guideE164 };

  for (const participant of params.groupParticipants ?? []) {
    if (!participant) {
      continue;
    }
    const candidate = resolveComparableIdentity({ jid: participant }, params.authDir);
    if (identitiesOverlap(guideIdentity, candidate)) {
      return true;
    }
  }

  if (params.roster) {
    for (const key of params.roster.keys()) {
      if (normalizeE164(key) === guideE164) {
        return true;
      }
    }
  }

  return false;
}

/** Deferral text uses `@<e164>` — the existing outbound-mentions resolver
 * (resolveWhatsAppOutboundMentions, wired in on `msg.reply`) turns that into
 * a real WhatsApp @mention against the group's participant list
 * automatically, so no extra mention plumbing is needed here. */
export function buildGuideDeferralText(guideE164?: string): string {
  const e164 = guideE164 ?? resolveGuideE164();
  return `Great question! I'll let @${e164} (your guide) jump in on this one — they know it best. 🙏`;
}
