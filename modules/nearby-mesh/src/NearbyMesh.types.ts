/**
 * Type contract for the `NearbyMesh` native module.
 *
 * The native layer is a *dumb byte pipe*. It carries no chat logic: no message
 * parsing, no dedup, no storage, no crypto. Binary payloads cross the bridge as
 * base64 strings and come back out of the other device byte-for-byte identical.
 */

/** Opaque, transport-assigned endpoint identifier. Not stable across sessions. */
export type PeerId = string;

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

/** A nearby advertiser was discovered while discovery is running. */
export type PeerFoundEvent = {
  /** Transport-assigned endpoint id. Use this for every other call. */
  id: PeerId;
  /** Display name the remote peer advertised. Empty string if it sent none. */
  name: string;
};

/** A previously discovered advertiser went out of range / stopped advertising. */
export type PeerLostEvent = {
  id: PeerId;
};

/**
 * A connection handshake needs a decision. Call `acceptConnection(id)` or
 * `rejectConnection(id)` — the handshake stalls until you do, on both platforms.
 */
export type ConnectionInitiatedEvent = {
  id: PeerId;
  /** Best-known display name for the peer (may be an empty string). */
  name: string;
  /** Short human-readable digits. Identical on both devices — show it to users to compare. */
  verificationCode: string;
  /** `true` when the remote side initiated, `false` when we called `requestConnection`. */
  isIncoming: boolean;
};

/** The handshake completed; `send()` to this peer is now valid. */
export type ConnectedEvent = {
  id: PeerId;
  name: string;
};

/**
 * The peer is no longer connected. Also emitted when a handshake fails or is
 * rejected by either side, so a rejected `onConnectionInitiated` always
 * terminates in exactly one `onDisconnected`.
 */
export type DisconnectedEvent = {
  id: PeerId;
};

/** Bytes arrived from a connected peer, verbatim, base64-encoded. */
export type PayloadEvent = {
  peerId: PeerId;
  /** Standard base64 (RFC 4648), no line wrapping. */
  payloadBase64: string;
};

/**
 * Something failed. Emitted *in addition to* the rejected promise when the
 * failure originates from a call, and on its own for asynchronous transport
 * failures that belong to no particular call.
 */
export type ErrorEvent = {
  message: string;
  /** Coded error identifier, e.g. `ERR_NEARBY_NOT_STARTED`. */
  code: string;
};

// ---------------------------------------------------------------------------
// Event map
// ---------------------------------------------------------------------------

export type NearbyMeshEvents = {
  onPeerFound: (event: PeerFoundEvent) => void;
  onPeerLost: (event: PeerLostEvent) => void;
  onConnectionInitiated: (event: ConnectionInitiatedEvent) => void;
  onConnected: (event: ConnectedEvent) => void;
  onDisconnected: (event: DisconnectedEvent) => void;
  onPayload: (event: PayloadEvent) => void;
  onError: (event: ErrorEvent) => void;
};

export type NearbyMeshEventName = keyof NearbyMeshEvents;

// ---------------------------------------------------------------------------
// Module surface
// ---------------------------------------------------------------------------

export type NearbyMeshApi = {
  /**
   * Sets the local display name broadcast to peers. Takes effect on the next
   * `startAdvertising` / `requestConnection`; it does not rename a live session.
   */
  setDisplayName(name: string): Promise<void>;

  /** Starts advertising under `serviceId` using the cluster (many-to-many) strategy. */
  startAdvertising(serviceId: string): Promise<void>;

  /** Starts discovering advertisers of `serviceId` using the cluster strategy. */
  startDiscovery(serviceId: string): Promise<void>;

  /** Stops advertising and discovery and tears down every connection. */
  stopAll(): Promise<void>;

  /** Asks a discovered peer to connect. Resolves when the request is sent, not when connected. */
  requestConnection(peerId: PeerId): Promise<void>;

  /** Accepts a pending handshake previously announced by `onConnectionInitiated`. */
  acceptConnection(peerId: PeerId): Promise<void>;

  /** Rejects a pending handshake previously announced by `onConnectionInitiated`. */
  rejectConnection(peerId: PeerId): Promise<void>;

  /** Drops a connection. Resolves even if the peer was already gone. */
  disconnect(peerId: PeerId): Promise<void>;

  /** Sends raw bytes (base64-encoded) to one connected peer. */
  send(peerId: PeerId, payloadBase64: string): Promise<void>;

  /** Whether the Nearby transport can run on this device right now. */
  isAvailable(): Promise<boolean>;
};
