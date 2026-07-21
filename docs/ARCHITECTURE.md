# Architecture — how protestchat actually works

This is the internals map: the data path a message takes, and the contract each
module holds up along the way. The [README](../README.md) is the user- and
build-facing view; [THREAT-MODEL.md](./THREAT-MODEL.md) is the adversarial view;
[modules/ble-mesh/README.md](../modules/ble-mesh/README.md) is the radio. This
file is the middle: what happens between a tap and a byte on the air, and back.

If you read one thing first, read the `THREAT MODEL` block at the top of
`src/lib/crypto-core.ts`. Every decision below falls out of it.

---

## The one-sentence version

A message is sealed so only its recipient can open it, wrapped in an envelope
that names no one, and then **flooded**: every phone carries every unexpired
envelope it has seen and offers it to every peer it meets. The recipient is
whoever can decrypt it. Nothing routes; a captured phone reveals no social
graph because there is no social graph on the wire to reveal.

---

## Layers

```
┌──────────────────────────────────────────────────────────────┐
│ src/app/*            screens (expo-router)                    │  UI
│ src/lib/app-state    React context: identity, radio, sends    │
├──────────────────────────────────────────────────────────────┤
│ src/lib/mesh         THE ENGINE — seal, dedup, relay, expire  │  logic
│ src/lib/conversation derive mode + warning (one place)        │
│ src/lib/signals      preset danger/caution alerts             │
├──────────────────────────────────────────────────────────────┤
│ src/lib/crypto-core  seal / open / channel keys / safety no.  │  crypto
│ src/lib/crypto       + device keystore (expo-secure-store)    │
│ src/lib/protocol     wire envelope, padding buckets, expiry   │
├──────────────────────────────────────────────────────────────┤
│ src/lib/store        MeshStore interface + in-memory impl     │  storage
│ src/lib/db           SQLite implementation of MeshStore       │
├──────────────────────────────────────────────────────────────┤
│ src/lib/transport    radio abstraction (Transport interface)  │  radio
│ modules/ble-mesh     Swift (CoreBluetooth) + Kotlin (GATT)    │
└──────────────────────────────────────────────────────────────┘
```

Two split points are load-bearing, both so the security-critical code can be
run on a laptop under `npm test` instead of only on a phone:

- **`crypto-core` vs `crypto`** — the core has zero React Native imports.
  `crypto.ts` adds the `expo-secure-store` keystore and re-exports the rest.
- **`store` vs `db`** — `store.ts` is the `MeshStore` interface plus a
  memory-backed implementation whose semantics match the SQL in `db.ts`
  statement for statement. `mesh.ts` takes its store and transport by
  injection, so the whole engine is exercised against a fake radio and a memory
  store with no device present.

The native radio is a **dumb byte pipe**: advertise, discover, connect, send
bytes, receive bytes. No chat logic, no storage, no crypto — one implementation
of the risky code to audit, not three.

---

## Identity

An identity is one 32-byte seed. Everything else is derived (`identityFromSeed`
in `crypto-core.ts`):

- **Ed25519** signing keypair — the seed *is* the Ed secret.
- **X25519** agreement keypair — `xSecret = HKDF(seed)`, so there is one secret
  to protect and one secret to wipe, not two.
- **`publicId`** = base64(`edPublic ‖ xPublic`), 64 bytes. This is the whole
  public identity; it is what a QR code carries and what you hand another person
  in the flesh.

The seed lives in the OS keystore (`crypto.ts`). Panic wipe deletes it and
generates a fresh one; there is no recovery, by design.

### Safety number (`safetyNumber`)

Two people confirm there is no machine in the middle by reading a number aloud,
in person. It is **two per-key fingerprints concatenated** — 60 decimal digits,
grouped in fives — each fingerprint an iterated hash (5200 rounds, Signal-style)
committing to *one* fixed public key.

Why per-key halves and not one hash of both keys: a single combined hash is
order-independent and fully attacker-chosen at introduction, so a MITM
supplying both keys only needs a **birthday collision** to make the two screens
match. Committing each half to a fixed real key turns the attack into a
per-half **second-preimage** (~10^30 work). Digits are drawn by rejection
sampling (drop bytes ≥ 250) to kill the `byte % 10` modulo bias.

---

## Sealing — the payload a relay cannot read

Two constructions, chosen automatically by mode. Both put the sender's identity
and signature **inside** the ciphertext, so authorship survives relaying but is
invisible to relays.

### Direct / group — `seal(sender, recipient, body)`

```
wire:   ephPublic(32) ‖ nonce(24) ‖ XChaCha20-Poly1305 ciphertext
inner:  senderEd(32) ‖ senderX(32) ‖ sig(64) ‖ body
```

- Fresh ephemeral X25519 keypair per message → the sender is anonymous to
  everyone but the recipient.
- Key = `HKDF(sharedSecret, salt = ephPublic ‖ recipientX)`. Binding the
  recipient key into the salt stops a recorded ciphertext being replayed toward
  a different recipient.
- Signature covers `context ‖ ephPublic ‖ recipientX ‖ body`, tying it to this
  one ciphertext so it cannot be lifted into another envelope.
- `open()` is trial decryption: wrong recipient and forgery are
  indistinguishable to the caller — **no oracle to probe**.

### Channel / public — `sealToKey(sender, key, body)`

```
wire:   nonce(24) ‖ XChaCha20-Poly1305 ciphertext
inner:  senderEd(32) ‖ senderX(32) ‖ sig(64) ‖ body
```

- One symmetric key. Anyone holding it can read *and* verify authorship — inside
  a channel you can tell who said what, and no member can forge another's
  messages.
- Signature covers `context ‖ channelBinding(key) ‖ nonce ‖ body`, where
  `channelBinding = HKDF(key)`. Without this binding a member could decrypt the
  signed inner plaintext and **re-encrypt it under a different channel key** (or
  the public key every install holds) and it would still verify — laundering a
  private statement into another channel with valid authorship. The binding
  makes a signature verify only under the key it was sealed for.

The two wire layouts differ in length (direct carries an ephemeral key, channel
does not). That length difference is the *only* discriminator — there is no mode
byte on the wire, so a relay cannot even learn which kind of message it carries.
`tryOpen` in `mesh.ts` just tries the identity key, then every channel key, and
takes the first that opens.

### Channels have no privileged operations

A channel is a symmetric key **and nothing else** — no owner, admin, kick, or
membership list. This is a direct lesson from BitChat, where channel commands
were validated only by the issuing client, so any member could seize a channel
or strip its encryption. The fix is not to validate them properly; it is to not
have them. Cost: a leaked passphrase ends the channel — start a new one. The key
is derived by scrypt (N=2¹⁴) from `passphrase` salted by the normalised channel
name (`deriveChannelKey`); slow by design, never called on a render path.

The **public broadcast** channel is a hardcoded, well-known key
(`PUBLIC_CHANNEL_KEY`). It provides zero confidentiality — every install,
including a hostile one, holds it. It exists so broadcast and channel traffic
share one code path and are indistinguishable on the wire.

---

## Wire protocol (`protocol.ts`)

### Envelope — the only part a relay reads

34-byte fixed header + payload. A relay learns only: an envelope exists, its
(bucketed) size, a random dedup id, coarse create/expire times, and hop count.
Not sender, not recipient, not content.

| bytes | field | notes |
|------:|-------|-------|
| 0–1 | magic `PC` | |
| 2 | version | |
| 3 | type | `Sealed(1)` / `Inventory(2)` / `Request(3)` |
| 4–19 | id (16B) | random; the **dedup key across the whole mesh** |
| 20–25 | createdAt (48-bit) | floored to 60 s — a precise clock is a fingerprint |
| 26–29 | ttlSeconds | clamped on decode to `(0, 7 days]` |
| 30 | hopCount | mutated by relays |
| 31 | maxHops | default 6 |
| 32–33 | payload length | |

`decodeEnvelope` rejects bad magic/version/type, a length that disagrees with
the buffer, and an absurd TTL — a hostile peer can write anything here, so
clamp rather than trust.

### Padding buckets

Message length is metadata ("yes" vs a street address are different sizes even
encrypted). `pad` rounds every body up to the next of
`[256, 512, 1024, 2048, 4096, 8192, 16384]` before sealing; the zero remainder
sits inside the AEAD, so it costs an adversary nothing to guess and gains
nothing to know. `unpad` reads back a 4-byte length prefix.

---

## The mesh engine (`mesh.ts`)

One class, `MeshEngine`, owning the entire message lifecycle. The module-level
`mesh` singleton is what the app uses; tests construct their own with injected
fakes.

### Sending

All four send paths are the same machinery; only the sealing and the receipt
policy differ.

```
sendText / sendToChannel / sendSignalToChannel / sendToGroup
  → seal (per mode)
  → recordOutgoing(id, conversationId, text, expectedFrom, severity?)   // store row, state 'queued'
  → if connected: setMessageState('sent')          // BEFORE inject — see below
  → inject(sealed)
```

- **`recordOutgoing`** writes the local message row and registers who must ack
  it (`expectedFrom`). Empty for channel/public/signal — those never ack.
- **`'sent'` is written before `inject`** deliberately: the recipient may be in
  range and its receipt back in our hands inside the same tick, and writing
  `'sent'` afterwards would overwrite `'delivered'` with a weaker state.
- **`inject`** wraps the sealed payload in an envelope with a fresh random id,
  stores it (so it survives an app kill before transmission), `markSeen`s its
  own id (so it never loops back in), and broadcasts to every connected peer.
- **Receipt policy is structural**: `packBody` includes a message id *only* for
  direct/group. No id = nothing to ack. Channels and public omit it so
  key-holders are never handed a per-member read log, and public never turns
  every silent listener into a signed reply. It is opt-in by construction, not a
  flag a bug can flip.
- **Groups are fan-out**: one independently sealed copy per member, injected
  with 0–3 s of jitter each so an observer counting envelopes leaving a phone
  cannot read off the group size. No group key, so no rekeying and no group
  crypto to get wrong. Delivery is all-or-nothing: `'delivered'` only once every
  member has acked, because the row is one thing in the user's head and showing
  it delivered while copies sit uncarried is a lie in the dangerous direction.

### Receiving — `handleSealed`

```
ingest(peer, bytes)
  → decodeEnvelope; drop if malformed or expired
  → by type: Inventory | Request | Sealed
Sealed:
  → markSeen(id)  — if already seen, STOP. Dedup before anything expensive.
  → tryOpen(payload): identity key, then each channel key
  → if it opened, by body kind:
       text    → upsert sender, insert row, ack iff direct + body has id
       receipt → applyReceipt (direct hits only)
       signal  → insert row (channel hits only), never ack
  → store the envelope and RELAY it (hopCount+1) regardless of whether it opened
```

The relay happens **whether or not the message was for us** — dropping our own
mail here would tell a traffic observer which device is the recipient. Relaying
stops at `maxHops`, and the forward is sent to everyone except the peer it came
from.

Dedup is purely envelope-id based (`markSeen`), and the id is preserved across
relay hops, so the same logical message arriving from many directions in a dense
crowd is opened and stored exactly once.

### Receipts

`sendReceipt` seals an ack back to the one sender, padded to the same buckets as
text and pushed through the same store-and-forward cache — a relay cannot tell a
receipt from a message, and it works even if we have never met the sender. A
receipt itself carries no id, so it is never acked; that is what stops two
phones acking each other's acks forever. `applyReceipt` updates the ledger keyed
on `(messageId, senderPublicId)`: a receipt for something we never sent, or from
someone we never sent it to, matches no row and is dropped — "delivered" is a
claim a user acts on, so it must not be forgeable by replaying an id.

---

## Sync — two phones meet and reconcile

Flooding alone re-sends everything on every reconnect. The inventory/request
exchange trims that:

```
on connect  → offerInventory:  Inventory { my envelope ids }        (maxHops 1)
peer receives → handleInventory: Request { ids I lack and haven't seen }
we receive    → handleRequest:   send those envelopes (hopCount+1)
```

Control envelopes are point-to-point, capped at `MAX_SYNC_PER_PEER = 200` ids
per encounter (one greedy peer can't drain us), and given a **300 s TTL** —
*not* 60 s. `createdAt` is floored to the 60 s granularity boundary, so with a
60 s TTL the receiver's expiry check killed control traffic 0–60 s after it was
sent, uniformly at random, and sync silently failed a large fraction of the
time on a lossy BLE link. Five minutes swamps both the granularity floor and
realistic clock skew.

---

## Retention & expiry — a security control, not housekeeping

An envelope past its TTL is evidence sitting on a phone that might be seized, so
expiry is enforced hard and locally:

- Default message TTL 6 h, `maxHops` 6 (`DEFAULTS`).
- The outer header is unauthenticated (relays legitimately mutate `hopCount`),
  so a hostile relay could inflate `ttlSeconds` to make the whole mesh hoard a
  message. Defeated with **first-sight retention**: each device caps how long it
  keeps anything at `MAX_LOCAL_RETENTION_MS = 6 h` from when *it* first saw it —
  `expiresAt = min(claimed, firstSeen + cap)`. An attacker cannot forge our
  clock.
- A background sweep runs every 60 s and on foreground.
- Dedup (`seen`) entries outlive envelopes (`SEEN_RETENTION_MS = 7 days`) so a
  long-expired message cannot loop back in as "new".

---

## The four modes

Mode is derived in exactly one place — `describeConversation` in
`conversation.ts` — and every screen renders its warning from there, because the
single most dangerous failure is someone typing into public broadcast believing
it is private. Weaker confidentiality gets a *louder* warning, never a quieter
one; no padlock iconography anywhere.

| Mode | Conversation id | Who can read | Acks |
|------|-----------------|--------------|------|
| Public | `#<public>` | anyone nearby, police included | no |
| Channel | `#<id>` | anyone with the passphrase | no |
| Group | `~<id>` | only the members you added | yes (all) |
| Direct | `<publicId>` | one person | yes |

---

## Signals — preset danger/caution alerts (`signals.ts`)

Buttons, not free text: fifty people reporting the same thing should each cost
one tap, and a fixed vocabulary is groundwork for later cross-mesh dedup. A
signal is an ordinary channel/public message with a `signal` body; the sender
records its own copy with the exact one-line rendering the receiver will show
(`formatSignal`, e.g. `⚠ Police — Gate 4`), so both ends read alike.

**Danger-monotone** is the whole point and is enforced from three sides:

1. The wire type `SignalSeverity = 'danger' | 'caution'` has no `safe`/
   `all-clear` member — a forged all-clear is the one lie that walks people into
   a trap, and it is unrepresentable.
2. Every preset in `SIGNAL_PRESETS` is danger or caution (tested).
3. `decodeBody` re-checks severity at the trust boundary: a body from a sender
   we authenticated but do **not** trust, with any severity outside the set, is
   dropped as malformed and never reaches the user.

Two consequences worth knowing:

- Signals are **never acked** — no id in the body, same read-log reasoning as
  channel text.
- The free-text `location` is hardened, because danger-monotone guards the
  *severity*, not the words. `formatSignal` strips C0/C1 control characters
  (newlines included), collapses whitespace, and caps length, so a hostile
  `danger` signal cannot paint a fake second line under the ⚠ that mimics a
  safe/clear message. On receive, `handleSealed` also clamps the
  attacker-controlled `sentAt` to `≤ now` (the feed sorts on it) and files a
  signal only from a **channel** hit, mirroring the send-side rule so a signal
  sealed directly to your identity cannot appear as an unsolicited alert in a
  one-to-one thread.

What is **not** here yet: cross-mesh coalescing of identical alerts, and any
resistance to a present attacker flooding forged *danger* signals (herding).
Both are named future work — danger-monotone only closes the forged-all-clear
hole.

---

## Storage (`db.ts` / `store.ts`)

`store.ts` defines `MeshStore` — exactly the surface the engine touches, nothing
more, so a test double can't accidentally be handed responsibilities the engine
doesn't have. `db.ts` implements it over `expo-sqlite`: `messages`, `contacts`,
`channels`, `groups`, the envelope cache, and the `seen` dedup set. The
in-memory store in `store.ts` mirrors each SQL statement (e.g. `INSERT OR
IGNORE` so re-delivery never clobbers settled UI state; `(message_id,
public_id)` as the receipt key). If the two drift, the tests are testing a
fiction.

Additive migrations that can't live in the `CREATE` batch (which aborts wholesale
on a mid-statement failure) run afterwards and swallow the duplicate-column
error on re-run — that is how the `severity` column was added for installs that
predate signals.

---

## Transport (`transport.ts` + `modules/ble-mesh`)

The engine only ever talks to the `Transport` interface — `start`, `stop`,
`send`, and an event emitter (`peerFound`, `connected`, `payload`, …). Two
implementations:

- **`BleTransport`** wraps the native module. Every device is both a GATT
  peripheral and central — there is no host role in a mesh. Connections are
  dialled and accepted unconditionally: the medium is public by construction,
  and confidentiality comes from the sealed payload, never from who we shook
  hands with. `displayName` is accepted but **never advertised** — anything in a
  BLE advertisement is readable by a police scanner. The endpoint identifier
  rotates every 15 minutes from fresh CSPRNG bytes. MTU chunking happens
  natively; see the module's own README.
- **`UnavailableTransport`** is the stub used on web, in Expo Go, and on a
  simulator without the native module — it just reports a "no radio" error so
  the app still launches and shows that state. `getTransport()` picks between
  them by trying to `require` the native module and checking for its functions.

Nearby Connections was v0 and was removed: on iOS it only brings up the Wi-Fi
LAN medium (useless in a jammed square with no infrastructure) and gave no
control over the advertising identifier. See the README for the full account.

---

## Testing

`npm test` runs Node's test runner over `src/lib/__tests__/*.test.ts` via a
type-stripping resolver — no bundler, no device:

- **crypto.test** — sealing, channel keys, safety numbers.
- **protocol.test** — envelope round-trips, rejection of malformed/forged
  headers, body encode/decode incl. the danger-monotone severity filter.
- **mesh.test** — the engine driven through the fake transport and memory store:
  relay, dedup, hop limits, fan-out, store-and-forward, receipts, channels,
  and the signal path (a relay holding the wrong key forwards but reads
  nothing).
- **signals.test** — presets, formatting, location flattening/cap.

Everything above the radio is testable here. What is **not**: the radio actually
finding a peer — that needs two physical phones in a room, and there is no
emulator trick for it. The manual test matrix is in the README.

---

## Cross-references

- [README.md](../README.md) — what it is, how to build and manually test it.
- [docs/THREAT-MODEL.md](./THREAT-MODEL.md) — who this defends, what it does not,
  the cryptographic design, and the open problems.
- [modules/ble-mesh/README.md](../modules/ble-mesh/README.md) — GATT design,
  native chunking, identifier rotation, platform quirks.
- The `THREAT MODEL` header comment in `src/lib/crypto-core.ts` — the source of
  truth every choice here derives from.
