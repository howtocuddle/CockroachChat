/**
 * nearby-mesh — Google Nearby Connections (cluster strategy) for iOS + Android.
 *
 * This module is a transport only. It moves opaque byte blobs between nearby
 * devices and reports peer/connection lifecycle. It has no knowledge of
 * messages, ordering, dedup, persistence or encryption — layer all of that on
 * top in JS.
 */

import type { PeerId } from './src/NearbyMesh.types';
import NearbyMesh from './src/NearbyMeshModule';

export * from './src/NearbyMesh.types';

export {
  addConnectedListener,
  addConnectionInitiatedListener,
  addDisconnectedListener,
  addErrorListener,
  addPayloadListener,
  addPeerFoundListener,
  addPeerLostListener,
} from './src/NearbyMeshModule';

export { NearbyMesh };

/** Sets the local display name advertised to peers. */
export function setDisplayName(name: string): Promise<void> {
  return NearbyMesh.setDisplayName(name);
}

/** Starts advertising under `serviceId`. */
export function startAdvertising(serviceId: string): Promise<void> {
  return NearbyMesh.startAdvertising(serviceId);
}

/** Starts discovering advertisers of `serviceId`. */
export function startDiscovery(serviceId: string): Promise<void> {
  return NearbyMesh.startDiscovery(serviceId);
}

/** Stops advertising + discovery and disconnects every peer. */
export function stopAll(): Promise<void> {
  return NearbyMesh.stopAll();
}

/** Requests a connection to a discovered peer. */
export function requestConnection(peerId: PeerId): Promise<void> {
  return NearbyMesh.requestConnection(peerId);
}

/** Accepts a pending handshake. */
export function acceptConnection(peerId: PeerId): Promise<void> {
  return NearbyMesh.acceptConnection(peerId);
}

/** Rejects a pending handshake. */
export function rejectConnection(peerId: PeerId): Promise<void> {
  return NearbyMesh.rejectConnection(peerId);
}

/** Disconnects a peer. */
export function disconnect(peerId: PeerId): Promise<void> {
  return NearbyMesh.disconnect(peerId);
}

/** Sends base64-encoded bytes to a connected peer. */
export function send(peerId: PeerId, payloadBase64: string): Promise<void> {
  return NearbyMesh.send(peerId, payloadBase64);
}

/** Whether the Nearby transport can run on this device right now. */
export function isAvailable(): Promise<boolean> {
  return NearbyMesh.isAvailable();
}

export default NearbyMesh;
