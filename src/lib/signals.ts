/**
 * Preset situational-awareness signals.
 *
 * Buttons, not free text: fifty people reporting the same thing should each
 * cost one batteryless tap rather than a typed sentence, and a fixed vocabulary
 * is the groundwork for later deduplicating identical alerts across the mesh.
 *
 * Danger-monotone by construction: every preset is 'danger' or 'caution'. There
 * is deliberately no "safe"/"all-clear" preset and there must never be one — a
 * forged all-clear is the single lie that walks people into a trap. The wire
 * type (SignalSeverity) cannot express safety either, so this list and the
 * protocol enforce the same rule from both ends.
 */

import type { SignalSeverity } from './protocol';

export type SignalPreset = {
  /** Stable token that travels on the wire. Never localise this. */
  event: string;
  /** What the button and the resulting message line read as. */
  label: string;
  severity: SignalSeverity;
};

export const SIGNAL_PRESETS: readonly SignalPreset[] = [
  { event: 'police', label: 'Police', severity: 'danger' },
  { event: 'gas', label: 'Tear gas', severity: 'danger' },
  { event: 'kettle', label: 'Kettle', severity: 'danger' },
  { event: 'medic', label: 'Medic', severity: 'danger' },
  { event: 'blocked', label: 'Blocked', severity: 'caution' },
];

// A glyph rather than a colour word: the message stream has no severity column
// yet, and colour alone fails in direct sun and for a colour-blind user.
const GLYPH: Record<SignalSeverity, string> = { danger: '⚠', caution: '△' };

const LABELS: Record<string, string> = Object.fromEntries(
  SIGNAL_PRESETS.map((p) => [p.event, p.label]),
);

/** Longest location we will render. One signal must not dominate the feed. */
const MAX_LOCATION = 80;

/**
 * `location` is free text from a sender we authenticated but do not trust.
 * Danger-monotone guards the SEVERITY, not the words, so a hostile 'danger'
 * signal could otherwise smuggle a fake all-clear into the location: a newline
 * or other control character lets it paint a second line under the ⚠ that mimics
 * the very safe/clear message the wire type refuses to carry. Replace every C0/C1
 * control character (newlines included) with a space, collapse runs of
 * whitespace, and cap the length, so a location is always one short inline
 * phrase and can forge no structure.
 */
function cleanLocation(location: string): string {
  let out = '';
  for (const ch of location) {
    const c = ch.codePointAt(0)!;
    const isControl = c < 0x20 || (c >= 0x7f && c <= 0x9f);
    out += isControl ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, MAX_LOCATION);
}

/**
 * One human line for a signal, e.g. "⚠ Police — Gate 4". `event` and `location`
 * come from a decoded body, so an unknown event (a newer peer's preset) falls
 * back to its raw token rather than vanishing from the feed.
 */
export function formatSignal(event: string, location: string, severity: SignalSeverity): string {
  const name = LABELS[event] ?? event;
  const where = cleanLocation(location);
  return `${GLYPH[severity]} ${name}${where ? ` — ${where}` : ''}`;
}
