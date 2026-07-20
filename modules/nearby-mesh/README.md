# nearby-mesh

A local Expo native module wrapping **Google Nearby Connections** on iOS (Swift) and
Android (Kotlin), using the **cluster** strategy (`P2P_CLUSTER`) so many devices can
be connected to many devices at once — the shape a mesh needs.

> **This module is a dumb byte pipe.** It carries no chat logic: no message parsing,
> no dedup, no storage, no crypto, no retries, no ordering guarantees beyond what the
> transport gives you. It moves opaque bytes and reports peer/connection lifecycle.
> Everything else belongs in JS. Please keep it that way.

Modules under `modules/` are autolinked by Expo automatically — there is nothing to
install or register.

## API

```ts
import * as NearbyMesh from '@/../modules/nearby-mesh';
// or: import NearbyMesh from '../../modules/nearby-mesh';

await NearbyMesh.setDisplayName('Alice');
await NearbyMesh.startAdvertising('com.example.protestchat');
await NearbyMesh.startDiscovery('com.example.protestchat');

const sub = NearbyMesh.addPeerFoundListener(({ id, name }) => {
  NearbyMesh.requestConnection(id);
});
```

| Function | Notes |
| --- | --- |
| `setDisplayName(name)` | Applies to the *next* advertise/connect, not a live session. Trimmed to 64 chars; empty becomes `Anonymous`. |
| `startAdvertising(serviceId)` | Resolves once advertising is actually running. |
| `startDiscovery(serviceId)` | Resolves once discovery is actually running. |
| `stopAll()` | Stops both, disconnects everyone, clears all internal maps. Always resolves. |
| `requestConnection(peerId)` | Resolves when the *request* is sent, not when connected. Wait for `onConnected`. |
| `acceptConnection(peerId)` / `rejectConnection(peerId)` | Only valid between `onConnectionInitiated` and its terminal event. |
| `disconnect(peerId)` | No-op success if the peer is already gone — safe in cleanup paths. |
| `send(peerId, payloadBase64)` | Standard base64. Fire-and-forget; only fails on local/transport errors. |
| `isAvailable()` | Android: Google Play services present. iOS: always `true`. |

Events: `onPeerFound`, `onPeerLost`, `onConnectionInitiated`, `onConnected`,
`onDisconnected`, `onPayload`, `onError`. Each has a typed
`add<Name>Listener(cb): EventSubscription` helper in `src/NearbyMeshModule.ts`.

Every failure both **rejects the promise** with a coded exception *and* emits
`onError` with the same `code`/`message`, so a global error surface can observe
failures without wrapping every call. Error codes are shared verbatim between the
two platforms (`ERR_NEARBY_*`).

## You must rebuild the native app

This module ships native Swift and Kotlin. It **cannot** be picked up by a JS reload
or by Expo Go. After adding or changing it you must produce a new development build:

```sh
npx expo prebuild --clean
npx expo run:ios      # or: npx expo run:android
```

(or an EAS `development` build). Metro-only restarts will keep failing with
"Cannot find native module 'NearbyMesh'".

## Permissions

### Android

Declared in this module's `AndroidManifest.xml` and merged into the app; also listed
in `app.json` under `expo.android.permissions` so `prebuild` keeps them.

| Permission | Applies to |
| --- | --- |
| `BLUETOOTH`, `BLUETOOTH_ADMIN` | API ≤ 30 only (`maxSdkVersion="30"`), install-time |
| `BLUETOOTH_SCAN`, `BLUETOOTH_ADVERTISE`, `BLUETOOTH_CONNECT` | API 31+ (Android 12), runtime |
| `NEARBY_WIFI_DEVICES` | API 33+ (Android 13), runtime, declared `neverForLocation` |
| `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION` | API ≤ 32, runtime (`maxSdkVersion="32"`) |
| `ACCESS_WIFI_STATE`, `CHANGE_WIFI_STATE` | all levels, install-time |

`startAdvertising` and `startDiscovery` request the API-level-appropriate runtime set
themselves before touching Nearby, and reject with `ERR_NEARBY_PERMISSION_DENIED`
listing exactly which ones were refused. Nearby also needs **Bluetooth and Location
services switched on** at the OS level on API ≤ 32 — a granted permission with
Location toggled off still fails, and that surfaces as `ERR_NEARBY_DISCOVER_FAILED`.

Google Play services must be present; `isAvailable()` reports this.

### iOS

The following **Info.plist** keys are required — they are set in `app.json` under
`expo.ios.infoPlist`, so `prebuild` writes them for you:

- `NSBluetoothAlwaysUsageDescription` — Nearby uses BLE for discovery and as a
  transport. Without this string the app is terminated on first Bluetooth use.
- `NSLocalNetworkUsageDescription` — Nearby's high-bandwidth transports use the
  local network (Bonjour/AWDL). Without it, peers are discovered but never upgrade.
- `NSBonjourServices` — must list the Bonjour service types Nearby registers.
  These are derived from the `serviceId` you pass to `startAdvertising`, hashed by
  the SDK, so the safe declaration is a wildcard-ish list of the types the SDK uses:
  `_<serviceId-hash>._tcp` / `_udp`. In practice you declare what the SDK logs on
  first run. The `app.json` here declares the generic Nearby entries; **if you change
  `serviceId`, re-check the console for `NSNetServiceBrowser` errors and update the
  list**, otherwise local-network discovery silently fails on iOS 14+.

There is no equivalent to Play services on iOS, so `isAvailable()` returns `true`
unconditionally; permission prompts happen lazily on first use.

## Platform semantics the TS layer must paper over

These are real behavioural differences, not implementation sloppiness. The native
code hides what it can; the rest is on the JS layer.

1. **Two-phase handshake on iOS.** iOS splits the handshake into
   `didReceiveConnectionRequestFrom` (accept the endpoint at all) and
   `didReceive verificationCode` (confirm the code). Android exposes only the
   second. To keep one `onConnectionInitiated` on both platforms, iOS
   auto-accepts phase one and defers the real user decision to the verification
   callback. Consequence: on iOS an inbound peer briefly progresses before the user
   sees anything. Do not treat `onConnectionInitiated` as "nothing has happened yet".

2. **`verificationCode` provenance.** Android returns
   `ConnectionInfo.getAuthenticationDigits()` — genuine short digits. iOS returns an
   opaque token string. When the token is not already numeric, both platforms fall
   back to the *same* FNV-1a-derived 4-digit code, so a cross-platform pair still
   shows matching digits. It is a display aid, not a security primitive; the JS layer
   owns any real authentication.

3. **`isIncoming`.** Android reports `ConnectionInfo.isIncomingConnection` directly.
   iOS has no such flag, so the module infers it: `false` if we called
   `requestConnection`, `true` if the advertiser delegate saw the request. If both
   sides request simultaneously, the two devices may disagree. Do not build tie-breaks
   on `isIncoming` alone.

4. **Rejection is modelled as a disconnect.** Android surfaces
   `STATUS_CONNECTION_REJECTED` via `onConnectionResult`; iOS has a `.rejected`
   connection state. Both are emitted as `onDisconnected`, so every
   `onConnectionInitiated` has exactly one terminal event
   (`onConnected` or `onDisconnected`). There is no dedicated "rejected" event.

5. **Peer names.** Android hands the display name to Nearby as a first-class
   endpoint name. iOS has no name field — the name rides in the connection *context*
   `Data`. Both platforms keep an `endpointId -> name` map so every event carries a
   name, but a peer that advertises nothing yields `""`, never `null`. Names are
   attacker-controlled strings; never treat them as identity.

6. **`onPeerLost` is advisory.** Android fires `onEndpointLost` eagerly; iOS's
   `didLose` timing differs and a peer can be "lost" while still connected. Neither
   platform clears the cached name on loss (so in-flight connections can still report
   one). Treat `onPeerLost` as "stop offering to connect", not "gone".

7. **`stopAll()` synthesises disconnects.** Neither SDK reliably fires per-endpoint
   disconnect callbacks when you tear the whole transport down, so both platforms
   emit `onDisconnected` for each previously connected peer themselves. Your handler
   must tolerate an `onDisconnected` for a peer you already forgot.

8. **Permissions.** Android can fail a start call purely on permissions
   (`ERR_NEARBY_PERMISSION_DENIED`); iOS never does — it fails later, or silently
   degrades to a slower transport, when Bluetooth/local-network access is refused.
   JS must not assume a resolved `startDiscovery` means the radio is usable on iOS.

9. **One `serviceId` at a time.** Both platforms bind the transport to the first
   `serviceId` seen and reject a different one with `ERR_NEARBY_SERVICE_MISMATCH`
   until `stopAll()` is called. This is a module-level constraint, not an SDK one.

10. **Payload types.** Only byte payloads are supported. Stream and file payloads are
    cancelled on iOS and ignored on Android, and never reach JS. Nearby caps a single
    byte payload at ~32 KiB — chunking is the JS layer's job.
