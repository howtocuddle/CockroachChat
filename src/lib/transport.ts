/**
 * Transport abstraction.
 *
 * The mesh engine talks to this, never to the native module directly. Two
 * reasons, both of which matter more than the indirection costs:
 *
 *   1. The radio is going to change. BLE/Wi-Fi Direct via Nearby is v1; LoRa,
 *      Wi-Fi Aware, or an internet gateway for peers who have walked out of the
 *      jammed zone all plug in behind this same interface.
 *   2. Nearby is unavailable in Expo Go and on web. Without a stub, the whole
 *      app becomes untestable except on a custom dev build wired to a phone.
 */

import { Platform } from 'react-native';

export type Peer = { id: string; name: string };

export type TransportEvents = {
  peerFound: (peer: Peer) => void;
  peerLost: (peerId: string) => void;
  connected: (peer: Peer) => void;
  disconnected: (peerId: string) => void;
  payload: (peerId: string, payloadBase64: string) => void;
  error: (message: string) => void;
};

export interface Transport {
  readonly available: boolean;
  start(serviceId: string, displayName: string): Promise<void>;
  stop(): Promise<void>;
  send(peerId: string, payloadBase64: string): Promise<void>;
  on<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): () => void;
}

// ---------------------------------------------------------------------------
// Shared listener bookkeeping
// ---------------------------------------------------------------------------

class Emitter {
  private handlers: { [K in keyof TransportEvents]?: Set<TransportEvents[K]> } = {};

  on<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): () => void {
    const set = (this.handlers[event] ??= new Set() as any) as Set<TransportEvents[K]>;
    set.add(handler);
    return () => set.delete(handler);
  }

  emit<K extends keyof TransportEvents>(event: K, ...args: Parameters<TransportEvents[K]>): void {
    for (const h of this.handlers[event] ?? []) {
      try {
        (h as (...a: any[]) => void)(...args);
      } catch (err) {
        // A throwing listener must never take down the radio loop.
        console.warn(`[transport] listener for "${event}" threw:`, err);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Nearby-backed transport
// ---------------------------------------------------------------------------

class NearbyTransport implements Transport {
  readonly available = true;
  private emitter = new Emitter();
  private subscriptions: { remove(): void }[] = [];
  private running = false;

  constructor(private native: any) {}

  on = <K extends keyof TransportEvents>(e: K, h: TransportEvents[K]) => this.emitter.on(e, h);
  emit = <K extends keyof TransportEvents>(e: K, ...a: Parameters<TransportEvents[K]>) =>
    this.emitter.emit(e, ...a);

  async start(serviceId: string, displayName: string): Promise<void> {
    if (this.running) return;
    this.running = true;

    const n = this.native;
    this.subscriptions = [
      n.addPeerFoundListener((p: Peer) => this.emit('peerFound', p)),
      n.addPeerLostListener((p: { id: string }) => this.emit('peerLost', p.id)),
      n.addConnectedListener((p: Peer) => this.emit('connected', p)),
      n.addDisconnectedListener((p: { id: string }) => this.emit('disconnected', p.id)),
      n.addPayloadListener((p: { peerId: string; payloadBase64: string }) =>
        this.emit('payload', p.peerId, p.payloadBase64),
      ),
      n.addErrorListener((p: { message: string }) => this.emit('error', p.message)),

      // Connections are accepted unconditionally and immediately. This looks
      // alarming and is not: the mesh is a public medium by construction, a
      // relay cannot prompt a human for every stranger it forwards through, and
      // refusing connections would only shrink the network without protecting
      // anything. Confidentiality and authenticity come from the sealed payload
      // (see crypto.ts), never from who we agreed to shake hands with.
      n.addConnectionInitiatedListener((p: { id: string }) => {
        n.acceptConnection(p.id).catch((err: unknown) =>
          this.emit('error', `accept failed: ${String(err)}`),
        );
      }),
    ];

    await n.setDisplayName(displayName);
    // Advertise and discover simultaneously: every device is both an endpoint
    // and a relay, so there is no "host" role to elect.
    await n.startAdvertising(serviceId);
    await n.startDiscovery(serviceId);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    for (const s of this.subscriptions) s.remove();
    this.subscriptions = [];
    await this.native.stopAll();
  }

  send(peerId: string, payloadBase64: string): Promise<void> {
    return this.native.send(peerId, payloadBase64);
  }
}

// ---------------------------------------------------------------------------
// Stub transport (web, Expo Go, simulator without the native module)
// ---------------------------------------------------------------------------

class UnavailableTransport implements Transport {
  readonly available = false;
  private emitter = new Emitter();

  on = <K extends keyof TransportEvents>(e: K, h: TransportEvents[K]) => this.emitter.on(e, h);

  async start(): Promise<void> {
    this.emitter.emit(
      'error',
      Platform.OS === 'web'
        ? 'Radio unavailable in a browser. Install the app on a phone.'
        : 'Radio unavailable. This build is missing the native mesh module — run `npx expo run:ios` or `npx expo run:android`.',
    );
  }

  async stop(): Promise<void> {}

  async send(): Promise<void> {
    throw new Error('transport unavailable');
  }
}

// ---------------------------------------------------------------------------

let cached: Transport | null = null;

export function getTransport(): Transport {
  if (cached) return cached;

  try {
    // Required lazily and defensively: on web and in Expo Go this throws, and
    // that is an expected, recoverable state rather than a crash.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../../modules/nearby-mesh');
    const native = mod?.default ?? mod;
    cached =
      native && typeof native.startAdvertising === 'function'
        ? new NearbyTransport(native)
        : new UnavailableTransport();
  } catch {
    cached = new UnavailableTransport();
  }

  return cached!;
}
