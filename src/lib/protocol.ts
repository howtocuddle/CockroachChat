/**
 * Wire protocol.
 *
 * The outer envelope is the only part a relay can read. Everything a relay does
 * not strictly need in order to forward and expire a message lives inside the
 * sealed payload instead. Concretely, a relay learns:
 *
 *   - that an envelope exists, and its (bucketed) size
 *   - a random id, so it can avoid forwarding the same thing twice
 *   - roughly when it was created and when it should die
 *   - how many hops it has taken
 *
 * It does NOT learn the sender, the recipient, or the content.
 *
 * Sizes matter: Nearby will happily carry megabytes over Wi-Fi Direct, but the
 * BLE-only fallback path is slow and lossy, so the header is kept to 34 bytes
 * and payloads are padded into buckets rather than sent at their true length.
 */

import { concat } from './bytes';

export const PROTOCOL_VERSION = 1;
const MAGIC_0 = 0x50; // 'P'
const MAGIC_1 = 0x43; // 'C'

export const HEADER_LEN = 34;
/**
 * Nearby caps a BYTES payload at ~32 KiB on both platforms, so an envelope that
 * exceeds this is not "slow", it is undeliverable. Held well under the cap to
 * leave room for the header and the sealing overhead.
 */
export const MAX_ENVELOPE_LEN = 30_000;

/** Coarse timestamps only — a millisecond-accurate clock is a fingerprint. */
export const TIME_GRANULARITY_MS = 60_000;

/**
 * A const object rather than a TS `enum`: enums emit a runtime object Metro
 * cannot tree-shake, and they are not strippable, which would put this file
 * out of reach of `npm test`.
 */
export const EnvelopeType = {
  /** A sealed one-to-one message. Payload is opaque ciphertext. */
  Sealed: 1,
  /**
   * "Here are the envelope ids I already hold." Lets two peers avoid
   * re-sending everything on every reconnect.
   */
  Inventory: 2,
  /** "Please send me these envelope ids." */
  Request: 3,
} as const;

export type EnvelopeType = (typeof EnvelopeType)[keyof typeof EnvelopeType];

export type Envelope = {
  version: number;
  type: EnvelopeType;
  /** 16 random bytes. Dedup key across the whole mesh. */
  id: Uint8Array;
  /** ms since epoch, rounded down to TIME_GRANULARITY_MS. */
  createdAt: number;
  /** Seconds after createdAt at which every relay must drop this. */
  ttlSeconds: number;
  hopCount: number;
  maxHops: number;
  payload: Uint8Array;
};

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

export function encodeEnvelope(e: Envelope): Uint8Array {
  if (e.payload.length > MAX_ENVELOPE_LEN - HEADER_LEN) {
    throw new Error(`envelope payload too large: ${e.payload.length}`);
  }
  if (e.id.length !== 16) throw new Error('envelope id must be 16 bytes');

  const header = new Uint8Array(HEADER_LEN);
  const view = new DataView(header.buffer);

  header[0] = MAGIC_0;
  header[1] = MAGIC_1;
  header[2] = e.version;
  header[3] = e.type;
  header.set(e.id, 4);

  // 48-bit big-endian timestamp: 6 bytes instead of 8, and still good for
  // another few thousand years.
  const t = Math.floor(e.createdAt / TIME_GRANULARITY_MS) * TIME_GRANULARITY_MS;
  view.setUint16(20, Math.floor(t / 0x100000000));
  view.setUint32(22, t % 0x100000000);

  view.setUint32(26, e.ttlSeconds);
  header[30] = e.hopCount;
  header[31] = e.maxHops;
  view.setUint16(32, e.payload.length);

  return concat(header, e.payload);
}

export function decodeEnvelope(raw: Uint8Array): Envelope | null {
  if (raw.length < HEADER_LEN) return null;
  if (raw[0] !== MAGIC_0 || raw[1] !== MAGIC_1) return null;
  if (raw[2] !== PROTOCOL_VERSION) return null;

  const type = raw[3];
  if (type !== EnvelopeType.Sealed && type !== EnvelopeType.Inventory && type !== EnvelopeType.Request) {
    return null;
  }

  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const payloadLen = view.getUint16(32);
  if (raw.length !== HEADER_LEN + payloadLen) return null;

  const createdAt = view.getUint16(20) * 0x100000000 + view.getUint32(22);
  const ttlSeconds = view.getUint32(26);

  // A hostile peer can put anything here. Clamp rather than trust.
  if (ttlSeconds <= 0 || ttlSeconds > 7 * 24 * 3600) return null;

  return {
    version: raw[2],
    type,
    id: raw.slice(4, 20),
    createdAt,
    ttlSeconds,
    hopCount: raw[30],
    maxHops: raw[31],
    payload: raw.slice(HEADER_LEN),
  };
}

// ---------------------------------------------------------------------------
// Padding
// ---------------------------------------------------------------------------

/**
 * Message length is metadata. "Yes" and a street address are obviously
 * different sizes, and an observer counting bytes learns something even though
 * the bytes are encrypted. Round every body up to a bucket before sealing.
 */
// Top bucket stops at 16 KiB: sealing adds ~200 bytes and the header 34, and
// the whole thing still has to fit inside Nearby's ~32 KiB payload limit.
const BUCKETS = [256, 512, 1024, 2048, 4096, 8192, 16384];

export function pad(body: Uint8Array): Uint8Array {
  const needed = body.length + 4;
  const bucket = BUCKETS.find((b) => b >= needed) ?? needed;

  const out = new Uint8Array(bucket);
  new DataView(out.buffer).setUint32(0, body.length);
  out.set(body, 4);
  // Remainder stays zero. It is inside the AEAD, so it costs an adversary
  // nothing to guess and gains them nothing to know.
  return out;
}

export function unpad(padded: Uint8Array): Uint8Array | null {
  if (padded.length < 4) return null;
  const len = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0);
  if (len > padded.length - 4) return null;
  return padded.slice(4, 4 + len);
}

// ---------------------------------------------------------------------------
// Application-level message body (lives inside the sealed payload)
// ---------------------------------------------------------------------------

/**
 * Signal severities. There is deliberately NO 'safe'/'clear'/'all-clear'
 * member: danger-monotone means the mesh can raise caution but can never assert
 * safety, because a forged all-clear is the lie that walks people into a trap.
 * The absence is load-bearing — do not add a "safe" tone here.
 */
export type SignalSeverity = 'danger' | 'caution';

export type MessageBody =
  /**
   * `id` is the SENDER's local message id, carried so the recipient has
   * something to reference in a receipt. It is a fresh random 128-bit value per
   * message and it never appears outside the ciphertext, so it tells a relay
   * nothing and cannot be used to link two envelopes.
   *
   * Optional on the wire in both directions:
   *   - a sender omits it when it does not want a receipt (channel and public
   *     broadcast — see the rationale on MeshEngine.packBody), so "no id" is
   *     the structural way of saying "do not ack this";
   *   - a peer running an older build omits it always, and must still be
   *     readable rather than rejected.
   */
  | { kind: 'text'; text: string; sentAt: number; id?: string }
  | { kind: 'receipt'; messageId: string; receivedAt: number }
  /**
   * A preset situational-awareness signal: [event] at [location]. Its severity
   * cannot express safety (see SignalSeverity), so a hostile channel member
   * cannot forge an all-clear. decodeBody re-checks the severity because the
   * body arrives from a sender we authenticated but do not trust.
   */
  | {
      kind: 'signal';
      event: string;
      location: string;
      severity: SignalSeverity;
      sentAt: number;
      id?: string;
    };

export const encodeBody = (b: MessageBody): string => JSON.stringify(b);

/**
 * Strict on the fields a variant is defined to have, tolerant of the one field
 * that is genuinely optional.
 *
 * Strict matters because the body arrives from inside a ciphertext we opened,
 * which authenticates the SENDER but says nothing about whether that sender is
 * honest. Rebuilding the object field by field rather than returning `parsed`
 * also stops any extra attacker-chosen keys riding along into the rest of the
 * app.
 */
export function decodeBody(json: string): MessageBody | null {
  try {
    const parsed = JSON.parse(json);

    if (
      parsed?.kind === 'text' &&
      typeof parsed.text === 'string' &&
      typeof parsed.sentAt === 'number'
    ) {
      // A present-but-wrong-typed id is a malformed body, not an old peer.
      if (parsed.id !== undefined && typeof parsed.id !== 'string') return null;
      return typeof parsed.id === 'string'
        ? { kind: 'text', text: parsed.text, sentAt: parsed.sentAt, id: parsed.id }
        : { kind: 'text', text: parsed.text, sentAt: parsed.sentAt };
    }

    if (
      parsed?.kind === 'receipt' &&
      typeof parsed.messageId === 'string' &&
      typeof parsed.receivedAt === 'number'
    ) {
      return { kind: 'receipt', messageId: parsed.messageId, receivedAt: parsed.receivedAt };
    }

    if (
      parsed?.kind === 'signal' &&
      typeof parsed.event === 'string' &&
      typeof parsed.location === 'string' &&
      typeof parsed.sentAt === 'number' &&
      // Danger-monotone at the trust boundary: any severity outside this set —
      // above all a forged 'safe'/'all-clear' — is dropped as a malformed body
      // and never reaches the user. The mesh can raise caution, never safety.
      (parsed.severity === 'danger' || parsed.severity === 'caution')
    ) {
      if (parsed.id !== undefined && typeof parsed.id !== 'string') return null;
      return typeof parsed.id === 'string'
        ? {
            kind: 'signal',
            event: parsed.event,
            location: parsed.location,
            severity: parsed.severity,
            sentAt: parsed.sentAt,
            id: parsed.id,
          }
        : {
            kind: 'signal',
            event: parsed.event,
            location: parsed.location,
            severity: parsed.severity,
            sentAt: parsed.sentAt,
          };
    }

    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULTS = {
  /**
   * 6 hours. Long enough to walk out of a jammed area and hand a message to the
   * open internet; short enough that a seized phone is not a month-long archive.
   */
  ttlSeconds: 6 * 3600,
  /**
   * Each hop is a chance to be observed, and the marginal reach past ~6 is
   * small in a dense crowd where everyone is a relay anyway.
   */
  maxHops: 6,
} as const;

export const isExpired = (e: Envelope, now = Date.now()): boolean =>
  now > e.createdAt + e.ttlSeconds * 1000;
