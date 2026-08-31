// Shared config lookup for the two guide-handling features (grill-me DM
// interview + group defer-to-guide): both need to know which WhatsApp
// number is the real human guide (Thom). Kept as an env var rather than a
// new openclaw.json key because channels.whatsapp is validated by a strict
// Zod schema (see session history) — adding a bespoke key there would
// require a schema change out of scope for this feature. Set
// TOURBOT_GUIDE_E164 in ~/.tourbot-env to override for other deployments.
export const DEFAULT_GUIDE_E164 = "+255787096872";

export function resolveGuideE164(): string {
  return process.env.TOURBOT_GUIDE_E164?.trim() || DEFAULT_GUIDE_E164;
}
