import { NativeModule, requireNativeModule, type EventSubscription } from 'expo-modules-core';

import type {
  ConnectedEvent,
  ConnectionInitiatedEvent,
  DisconnectedEvent,
  ErrorEvent,
  NearbyMeshApi,
  NearbyMeshEvents,
  PayloadEvent,
  PeerFoundEvent,
  PeerId,
  PeerLostEvent,
} from './NearbyMesh.types';

declare class NearbyMeshNativeModule
  extends NativeModule<NearbyMeshEvents>
  implements NearbyMeshApi
{
  setDisplayName(name: string): Promise<void>;
  startAdvertising(serviceId: string): Promise<void>;
  startDiscovery(serviceId: string): Promise<void>;
  stopAll(): Promise<void>;
  requestConnection(peerId: PeerId): Promise<void>;
  acceptConnection(peerId: PeerId): Promise<void>;
  rejectConnection(peerId: PeerId): Promise<void>;
  disconnect(peerId: PeerId): Promise<void>;
  send(peerId: PeerId, payloadBase64: string): Promise<void>;
  isAvailable(): Promise<boolean>;
}

const NearbyMesh = requireNativeModule<NearbyMeshNativeModule>('NearbyMesh');

export default NearbyMesh;

// ---------------------------------------------------------------------------
// Typed event subscription helpers
// ---------------------------------------------------------------------------

export function addPeerFoundListener(
  listener: (event: PeerFoundEvent) => void
): EventSubscription {
  return NearbyMesh.addListener('onPeerFound', listener);
}

export function addPeerLostListener(
  listener: (event: PeerLostEvent) => void
): EventSubscription {
  return NearbyMesh.addListener('onPeerLost', listener);
}

export function addConnectionInitiatedListener(
  listener: (event: ConnectionInitiatedEvent) => void
): EventSubscription {
  return NearbyMesh.addListener('onConnectionInitiated', listener);
}

export function addConnectedListener(
  listener: (event: ConnectedEvent) => void
): EventSubscription {
  return NearbyMesh.addListener('onConnected', listener);
}

export function addDisconnectedListener(
  listener: (event: DisconnectedEvent) => void
): EventSubscription {
  return NearbyMesh.addListener('onDisconnected', listener);
}

export function addPayloadListener(
  listener: (event: PayloadEvent) => void
): EventSubscription {
  return NearbyMesh.addListener('onPayload', listener);
}

export function addErrorListener(
  listener: (event: ErrorEvent) => void
): EventSubscription {
  return NearbyMesh.addListener('onError', listener);
}
