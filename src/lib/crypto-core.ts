/**
 * Identity and message sealing — pure core.
 *
 * Split from crypto.ts so it has ZERO React Native imports and can therefore be
 * exercised by `npm test` on a laptop. The security-critical code is the code
 * you can actually run tests against; anything that needs a device to execute
 * is code that in practice never gets tested.
 *
 * crypto.ts adds the device keystore on top and re-exports all of this.
 *
 * THREAT MODEL (read this before changing anything here):
 *
 *   What this protects:  message contents, and the sender's identity, against
 *                        every device on the mesh except the intended recipient.
 *   What it does NOT protect: the fact that your device is present and speaking.
 *                        A BLE radio is a beacon. See docs/THREAT-MODEL.md.
 *
 * Design constraints that drove the choices below:
 *
 *   1. Store-and-forward. Sender and recipient are frequently never online at
 *      the same moment, so no interactive handshake is possible. That rules out
 *      a live Noise/X3DH exchange for the message path and pushes us to a
 *      one-shot sealed construction.
 *   2. Relays must learn nothing. So the outer envelope carries no sender, no
 *      recipient, and no signature — only what is needed to route and expire.
 *      Recipients find their own mail by TRIAL DECRYPTION.
 *   3. Sender authentication must survive relaying, but must not be verifiable
 *      by relays. So the signature lives INSIDE the ciphertext.
 *
 * KNOWN LIMITATION, deliberately shipped in v1 and flagged in the README:
 * there is no forward secrecy toward the recipient. Compromise of a recipient's
 * long-term X25519 secret decrypts every message ever sent to them that an
 * adversary recorded. Fixing this needs a ratchet, which needs sender/recipient
 * liveness we do not have. Mitigated for now by aggressive message expiry.
 */

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { scrypt } from '@noble/hashes/scrypt.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';

import { concat, fromBase64, fromUtf8, toBase64, toUtf8 } from './bytes';

const KDF_INFO_SEAL = toUtf8('protestchat/v1/seal');
const KDF_INFO_X25519 = toUtf8('protestchat/v1/x25519');
const SIG_CONTEXT = toUtf8('protestchat/v1/sender-auth');

const EPH_LEN = 32;
const NONCE_LEN = 24;

export type Identity = {
  /** Long-term signing key. Never leaves the device. */
  edSecret: Uint8Array;
  edPublic: Uint8Array;
  /** Long-term agreement key, deterministically derived from the same seed. */
  xSecret: Uint8Array;
  xPublic: Uint8Array;
  /** edPublic || xPublic, base64. This is what you hand to another person. */
  publicId: string;
};

export type PublicIdentity = {
  edPublic: Uint8Array;
  xPublic: Uint8Array;
  publicId: string;
};

/** What a successfully opened message tells us. */
export type OpenedMessage = {
  /** Verified sender. Trustworthy only insofar as you have verified their safety number. */
  sender: PublicIdentity;
  body: Uint8Array;
};

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export function identityFromSeed(seed: Uint8Array): Identity {
  const edSecret = seed;
  const edPublic = ed25519.getPublicKey(edSecret);

  // Derive the agreement key from the same seed rather than storing a second
  // secret. One secret to protect, one secret to wipe.
  const xSecret = hkdf(sha256, seed, undefined, KDF_INFO_X25519, 32);
  const xPublic = x25519.getPublicKey(xSecret);

  return {
    edSecret,
    edPublic,
    xSecret,
    xPublic,
    publicId: toBase64(concat(edPublic, xPublic)),
  };
}

export function parsePublicId(publicId: string): PublicIdentity | null {
  try {
    const raw = fromBase64(publicId);
    if (raw.length !== 64) return null;
    return {
      edPublic: raw.subarray(0, 32),
      xPublic: raw.subarray(32, 64),
      publicId,
    };
  } catch {
    return null;
  }
}

/**
 * Short, human-comparable fingerprint. Two people read these aloud to each
 * other in person; if they match, there is no machine in the middle.
 * 60 bits — long enough that forging a match is not practical on a phone.
 */
export function safetyNumber(a: PublicIdentity, b: PublicIdentity): string {
  // Order-independent so both sides see the same digits.
  const [first, second] =
    a.publicId < b.publicId ? [a.publicId, b.publicId] : [b.publicId, a.publicId];
  const digest = sha256(toUtf8(`${first}|${second}`));

  let out = '';
  for (let i = 0; i < 15; i++) {
    if (i > 0 && i % 5 === 0) out += ' ';
    out += (digest[i] % 10).toString();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

function sealKey(ephPublic: Uint8Array, shared: Uint8Array, recipientX: Uint8Array): Uint8Array {
  // Binding the transcript (both public keys) into the salt stops an attacker
  // replaying a ciphertext toward a different recipient.
  return hkdf(sha256, shared, concat(ephPublic, recipientX), KDF_INFO_SEAL, 32);
}

/**
 * Encrypts `body` to `recipient`, authenticated as `sender`, in a form any
 * relay can carry but no relay can read or attribute.
 *
 * Wire layout: ephPublic(32) || nonce(24) || XChaCha20-Poly1305 ciphertext
 * Plaintext inside: senderEd(32) || senderX(32) || sig(64) || body
 */
export function seal(
  sender: Identity,
  recipient: PublicIdentity,
  body: Uint8Array,
): Uint8Array {
  const ephSecret = x25519.utils.randomSecretKey();
  const ephPublic = x25519.getPublicKey(ephSecret);
  const shared = x25519.getSharedSecret(ephSecret, recipient.xPublic);
  const key = sealKey(ephPublic, shared, recipient.xPublic);

  // Sign over the context, the ephemeral key and the body. Including ephPublic
  // ties the signature to this one ciphertext, so a signature cannot be lifted
  // out and replayed inside a different envelope.
  const signature = ed25519.sign(
    concat(SIG_CONTEXT, ephPublic, recipient.xPublic, body),
    sender.edSecret,
  );

  const inner = concat(sender.edPublic, sender.xPublic, signature, body);
  const nonce = randomBytes(NONCE_LEN);
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(inner);

  return concat(ephPublic, nonce, ciphertext);
}

/**
 * Attempts to open a sealed message addressed to us.
 *
 * Returns null for anything that is not ours or does not verify — a wrong
 * recipient and a forgery are indistinguishable to the caller by design, so
 * there is no oracle here to probe.
 */
export function open(recipient: Identity, sealed: Uint8Array): OpenedMessage | null {
  if (sealed.length < EPH_LEN + NONCE_LEN + 16 + 128) return null;

  try {
    const ephPublic = sealed.subarray(0, EPH_LEN);
    const nonce = sealed.subarray(EPH_LEN, EPH_LEN + NONCE_LEN);
    const ciphertext = sealed.subarray(EPH_LEN + NONCE_LEN);

    const shared = x25519.getSharedSecret(recipient.xSecret, ephPublic);
    const key = sealKey(ephPublic, shared, recipient.xPublic);

    // Throws on AEAD failure, which is the common case: most messages we see
    // are simply addressed to somebody else.
    const inner = xchacha20poly1305(key, nonce).decrypt(ciphertext);

    const senderEd = inner.subarray(0, 32);
    const senderX = inner.subarray(32, 64);
    const signature = inner.subarray(64, 128);
    const body = inner.subarray(128);

    const ok = ed25519.verify(
      signature,
      concat(SIG_CONTEXT, ephPublic, recipient.xPublic, body),
      senderEd,
    );
    if (!ok) return null;

    return {
      sender: {
        edPublic: senderEd,
        xPublic: senderX,
        publicId: toBase64(concat(senderEd, senderX)),
      },
      body,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Convenience
// ---------------------------------------------------------------------------

export const sealText = (sender: Identity, recipient: PublicIdentity, text: string) =>
  seal(sender, recipient, toUtf8(text));

export function openText(recipient: Identity, sealed: Uint8Array) {
  const result = open(recipient, sealed);
  return result && { sender: result.sender, text: fromUtf8(result.body) };
}

/** Random 128-bit id, used for message and envelope ids. */
export const randomId = (): string => toBase64(randomBytes(16));

// ---------------------------------------------------------------------------
// Channels and public broadcast
// ---------------------------------------------------------------------------
//
// A channel is a symmetric key and NOTHING ELSE. No owner, no admin, no kick,
// no membership list, no privileged operations of any kind.
//
// This is a direct lesson from BitChat, where channel commands were validated
// only by the issuing client, so any member could seize ownership of a channel
// or strip its encryption. The fix is not to validate those commands properly;
// it is to not have them. A construct with no privileged operations has no
// privileged operations to forge.
//
// The cost is real and worth stating: anyone holding the key can flood the
// channel and nobody can remove them. Moderation is traded away for the
// guarantee that possession of the key is the *only* thing that confers power.

const KDF_INFO_CHANNEL = toUtf8('protestchat/v1/channel');
const SIG_CONTEXT_CHANNEL = toUtf8('protestchat/v1/channel-auth');

/**
 * scrypt work factor.
 *
 * Paid once per channel join, never per message — the derived key is cached, so
 * this cost is invisible during normal use.
 *
 * N=2^14 is a compromise, not a recommendation. On Hermes this lands in the
 * few-hundred-millisecond range, which is what a person will tolerate while
 * standing in a crowd. It buys perhaps 10^4 work against an offline dictionary
 * attack on a captured channel, which helps against `gate4` and does not save a
 * passphrase that is genuinely weak.
 *
 * TODO: move to Argon2id via a native binding. Argon2 is memory-hard in a way
 * scrypt-at-these-parameters is not, and this is the single cheapest security
 * upgrade available to this codebase.
 */
const SCRYPT_PARAMS = { N: 2 ** 14, r: 8, p: 1, dkLen: 32 } as const;

/**
 * Derives a channel key from its name and passphrase.
 *
 * The channel name is the salt. This is deliberate and it is a real weakness:
 * two channels with the same name and passphrase collide, and there is no
 * per-channel random salt because there is no server to distribute one and the
 * whole point is that the passphrase can be spread by word of mouth.
 *
 * SLOW BY DESIGN — never call this on a render path.
 */
export function deriveChannelKey(name: string, passphrase: string): Uint8Array {
  const salt = concat(KDF_INFO_CHANNEL, toUtf8(normaliseChannelName(name)));
  return scrypt(toUtf8(passphrase.normalize('NFKC')), salt, SCRYPT_PARAMS);
}

/** Channel names are case- and whitespace-insensitive so word-of-mouth works. */
export const normaliseChannelName = (name: string): string =>
  name.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-');

/**
 * The public broadcast "channel" — a well-known, hardcoded key.
 *
 * This provides NO confidentiality whatsoever and is not intended to. Every
 * device running this app, including one carried by someone hostile, holds this
 * key. It exists so that broadcast and channel messages share one code path,
 * and so that public traffic is indistinguishable on the wire from channel
 * traffic to an observer who has not bothered to run the app.
 *
 * Any UI surfacing this mode MUST say, unambiguously, that anyone nearby can
 * read it. See PUBLIC_CHANNEL warnings in the app.
 */
export const PUBLIC_CHANNEL_KEY: Uint8Array = hkdf(
  sha256,
  toUtf8('protestchat/v1/public-broadcast'),
  undefined,
  KDF_INFO_CHANNEL,
  32,
);

export const PUBLIC_CHANNEL_NAME = 'public';

/**
 * Seals `body` to a symmetric key, authenticated as `sender`.
 *
 * Used for both channels and public broadcast. Authorship is verifiable by
 * anyone holding the key — within a channel you can tell who said what, and
 * a member cannot forge another member's messages.
 *
 * Wire layout: nonce(24) || XChaCha20-Poly1305 ciphertext
 * Plaintext inside: senderEd(32) || senderX(32) || sig(64) || body
 *
 * Note the layout deliberately has no ephemeral key, which is what lets
 * `open()` and `openWithKey()` be told apart by trial decryption alone without
 * any discriminator byte on the wire that would leak the mode to relays.
 */
export function sealToKey(sender: Identity, key: Uint8Array, body: Uint8Array): Uint8Array {
  const nonce = randomBytes(NONCE_LEN);

  // The nonce is bound into the signature so a signature cannot be lifted out
  // and replayed inside a different ciphertext under the same channel key.
  const signature = ed25519.sign(
    concat(SIG_CONTEXT_CHANNEL, nonce, body),
    sender.edSecret,
  );

  const inner = concat(sender.edPublic, sender.xPublic, signature, body);
  return concat(nonce, xchacha20poly1305(key, nonce).encrypt(inner));
}

/**
 * Opens a channel/broadcast message. Returns null if the key is wrong, the
 * ciphertext was tampered with, or the sender signature does not verify.
 */
export function openWithKey(key: Uint8Array, sealed: Uint8Array): OpenedMessage | null {
  if (sealed.length < NONCE_LEN + 16 + 128) return null;

  try {
    const nonce = sealed.subarray(0, NONCE_LEN);
    const ciphertext = sealed.subarray(NONCE_LEN);
    const inner = xchacha20poly1305(key, nonce).decrypt(ciphertext);

    const senderEd = inner.subarray(0, 32);
    const senderX = inner.subarray(32, 64);
    const signature = inner.subarray(64, 128);
    const body = inner.subarray(128);

    if (!ed25519.verify(signature, concat(SIG_CONTEXT_CHANNEL, nonce, body), senderEd)) {
      return null;
    }

    return {
      sender: {
        edPublic: senderEd,
        xPublic: senderX,
        publicId: toBase64(concat(senderEd, senderX)),
      },
      body,
    };
  } catch {
    return null;
  }
}
