// NearbyMeshModule.swift
//
// Google Nearby Connections transport for Expo, iOS side.
//
// IMPORTANT: this file is a *dumb byte pipe*. It must never learn anything about
// chat: no message parsing, no dedup, no storage, no crypto. Bytes in, bytes out,
// plus peer/connection lifecycle events. Keep it that way.

import ExpoModulesCore
import Foundation
import NearbyConnections

// MARK: - Errors

/// Coded error identifiers. These strings are part of the public contract and are
/// duplicated verbatim in the Android implementation — keep the two in sync.
private enum NearbyErrorCode {
  static let unavailable = "ERR_NEARBY_UNAVAILABLE"
  static let notStarted = "ERR_NEARBY_NOT_STARTED"
  static let serviceMismatch = "ERR_NEARBY_SERVICE_MISMATCH"
  static let unknownPeer = "ERR_NEARBY_UNKNOWN_PEER"
  static let noPendingConnection = "ERR_NEARBY_NO_PENDING_CONNECTION"
  static let notConnected = "ERR_NEARBY_NOT_CONNECTED"
  static let invalidPayload = "ERR_NEARBY_INVALID_PAYLOAD"
  static let invalidArgument = "ERR_NEARBY_INVALID_ARGUMENT"
  static let advertiseFailed = "ERR_NEARBY_ADVERTISE_FAILED"
  static let discoverFailed = "ERR_NEARBY_DISCOVER_FAILED"
  static let connectFailed = "ERR_NEARBY_CONNECT_FAILED"
  static let sendFailed = "ERR_NEARBY_SEND_FAILED"
  static let disconnectFailed = "ERR_NEARBY_DISCONNECT_FAILED"
  static let internalError = "ERR_NEARBY_INTERNAL"
}

private func nearbyException(_ code: String, _ message: String) -> Exception {
  return Exception(name: "NearbyMeshException", description: message, code: code)
}

// MARK: - Module

public final class NearbyMeshModule: Module {
  // Nearby primitives. Created lazily on the first start* call.
  private var connectionManager: ConnectionManager?
  private var advertiser: Advertiser?
  private var discoverer: Discoverer?
  private var activeServiceId: String?

  private var isAdvertising = false
  private var isDiscovering = false

  // Local display name broadcast to peers as the connection "context".
  private var displayName = "Anonymous"

  /// endpointId -> best-known display name. Populated from discovery context and
  /// from inbound connection-request context, so every event can carry a name.
  private var endpointNames: [String: String] = [:]

  /// Endpoints we have seen via discovery and not yet lost.
  private var discoveredEndpoints: Set<String> = []

  /// Endpoints currently in the `connected` state.
  private var connectedEndpoints: Set<String> = []

  /// Endpoints for which the remote side initiated the handshake.
  private var incomingEndpoints: Set<String> = []

  /// Advertiser-side "should I even talk to this endpoint" handlers. See the note
  /// on the two-phase iOS handshake in `advertiser(_:didReceiveConnectionRequestFrom:...)`.
  private var pendingRequestHandlers: [String: (Bool) -> Void] = [:]

  /// Handlers awaiting the user's accept/reject decision once the verification
  /// code is known. This is the one the JS `acceptConnection` / `rejectConnection`
  /// resolves against on both platforms.
  private var pendingVerificationHandlers: [String: (Bool) -> Void] = [:]

  /// Guards every mutable property above. Recursive so helpers can nest safely.
  private let lock = NSRecursiveLock()

  /// Set while JS holds at least one listener. Events are cheap enough that we
  /// always emit, but we avoid churning the transport when nobody is listening.
  private var isObserving = false

  // MARK: Definition

  public func definition() -> ModuleDefinition {
    Name("NearbyMesh")

    Events(
      "onPeerFound",
      "onPeerLost",
      "onConnectionInitiated",
      "onConnected",
      "onDisconnected",
      "onPayload",
      "onError"
    )

    OnStartObserving {
      self.withLock { self.isObserving = true }
    }

    OnStopObserving {
      self.withLock { self.isObserving = false }
    }

    OnDestroy {
      self.teardown()
    }

    AsyncFunction("setDisplayName") { (name: String) in
      let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
      // Nearby caps the connection context; keep it well under the limit.
      let clipped = String(trimmed.prefix(64))
      self.withLock {
        self.displayName = clipped.isEmpty ? "Anonymous" : clipped
      }
    }

    AsyncFunction("startAdvertising") { (serviceId: String, promise: Promise) in
      do {
        let manager = try self.ensureConnectionManager(serviceId: serviceId)
        let advertiser: Advertiser = self.withLock {
          if let existing = self.advertiser { return existing }
          let created = Advertiser(connectionManager: manager)
          created.delegate = self
          self.advertiser = created
          return created
        }
        let context = Data(self.currentDisplayName().utf8)
        advertiser.startAdvertising(using: context) { [weak self] error in
          guard let self else { return }
          if let error {
            self.withLock { self.isAdvertising = false }
            self.failPromise(
              promise,
              code: NearbyErrorCode.advertiseFailed,
              message: "Failed to start advertising: \(error.localizedDescription)"
            )
            return
          }
          self.withLock { self.isAdvertising = true }
          promise.resolve(nil)
        }
      } catch {
        self.failPromise(promise, error: error)
      }
    }

    AsyncFunction("startDiscovery") { (serviceId: String, promise: Promise) in
      do {
        let manager = try self.ensureConnectionManager(serviceId: serviceId)
        let discoverer: Discoverer = self.withLock {
          if let existing = self.discoverer { return existing }
          let created = Discoverer(connectionManager: manager)
          created.delegate = self
          self.discoverer = created
          return created
        }
        discoverer.startDiscovery { [weak self] error in
          guard let self else { return }
          if let error {
            self.withLock { self.isDiscovering = false }
            self.failPromise(
              promise,
              code: NearbyErrorCode.discoverFailed,
              message: "Failed to start discovery: \(error.localizedDescription)"
            )
            return
          }
          self.withLock { self.isDiscovering = true }
          promise.resolve(nil)
        }
      } catch {
        self.failPromise(promise, error: error)
      }
    }

    AsyncFunction("stopAll") { (promise: Promise) in
      self.teardown()
      promise.resolve(nil)
    }

    AsyncFunction("requestConnection") { (peerId: String, promise: Promise) in
      guard let discoverer = self.withLock({ self.discoverer }) else {
        self.failPromise(
          promise,
          code: NearbyErrorCode.notStarted,
          message: "Discovery is not running; call startDiscovery before requestConnection."
        )
        return
      }
      guard self.withLock({ self.discoveredEndpoints.contains(peerId) }) else {
        self.failPromise(
          promise,
          code: NearbyErrorCode.unknownPeer,
          message: "Unknown peer '\(peerId)'. It was never discovered, or it was already lost."
        )
        return
      }

      // We initiated, so the eventual handshake is outbound.
      self.withLock { self.incomingEndpoints.remove(peerId) }

      let context = Data(self.currentDisplayName().utf8)
      discoverer.requestConnection(to: peerId, using: context) { [weak self] error in
        guard let self else { return }
        if let error {
          self.failPromise(
            promise,
            code: NearbyErrorCode.connectFailed,
            message: "Failed to request connection to '\(peerId)': \(error.localizedDescription)"
          )
          return
        }
        promise.resolve(nil)
      }
    }

    AsyncFunction("acceptConnection") { (peerId: String) in
      try self.resolvePendingConnection(peerId: peerId, accept: true)
    }

    AsyncFunction("rejectConnection") { (peerId: String) in
      try self.resolvePendingConnection(peerId: peerId, accept: false)
    }

    AsyncFunction("disconnect") { (peerId: String, promise: Promise) in
      // Never crash on an absent endpoint: a disconnect of something already gone
      // is a no-op success, so callers can be sloppy in cleanup paths.
      guard let manager = self.withLock({ self.connectionManager }),
            self.withLock({ self.connectedEndpoints.contains(peerId) || self.pendingVerificationHandlers[peerId] != nil })
      else {
        self.forgetEndpoint(peerId)
        promise.resolve(nil)
        return
      }

      // Deny any half-open handshake first so the remote side is not left hanging.
      self.abortPendingHandshake(peerId)

      manager.disconnect(from: peerId) { [weak self] error in
        guard let self else { return }
        if let error {
          self.failPromise(
            promise,
            code: NearbyErrorCode.disconnectFailed,
            message: "Failed to disconnect from '\(peerId)': \(error.localizedDescription)"
          )
          return
        }
        promise.resolve(nil)
      }
    }

    AsyncFunction("send") { (peerId: String, payloadBase64: String, promise: Promise) in
      guard let data = Data(base64Encoded: payloadBase64, options: [.ignoreUnknownCharacters]) else {
        self.failPromise(
          promise,
          code: NearbyErrorCode.invalidPayload,
          message: "payloadBase64 is not valid base64."
        )
        return
      }
      guard let manager = self.withLock({ self.connectionManager }) else {
        self.failPromise(
          promise,
          code: NearbyErrorCode.notStarted,
          message: "Nearby transport is not running."
        )
        return
      }
      guard self.withLock({ self.connectedEndpoints.contains(peerId) }) else {
        self.failPromise(
          promise,
          code: NearbyErrorCode.notConnected,
          message: "Peer '\(peerId)' is not connected."
        )
        return
      }

      // The returned cancellation token is intentionally discarded: this module
      // exposes fire-and-forget sends only.
      _ = manager.send(data, to: [peerId]) { [weak self] error in
        guard let self else { return }
        if let error {
          self.failPromise(
            promise,
            code: NearbyErrorCode.sendFailed,
            message: "Failed to send to '\(peerId)': \(error.localizedDescription)"
          )
          return
        }
        promise.resolve(nil)
      }
    }

    AsyncFunction("isAvailable") { () -> Bool in
      // Nearby Connections ships in-process on iOS; there is no Play-services-style
      // gate. Bluetooth/local-network permission is prompted lazily by the OS, so
      // the transport is always "available" as far as this module can tell.
      return true
    }
  }

  // MARK: - State helpers

  @discardableResult
  private func withLock<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }

  private func currentDisplayName() -> String {
    return withLock { displayName }
  }

  private func nameFor(_ endpointId: String) -> String {
    return withLock { endpointNames[endpointId] ?? "" }
  }

  private func ensureConnectionManager(serviceId: String) throws -> ConnectionManager {
    let trimmed = serviceId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      throw nearbyException(NearbyErrorCode.invalidArgument, "serviceId must not be empty.")
    }

    lock.lock()
    defer { lock.unlock() }

    if let existing = connectionManager {
      guard activeServiceId == trimmed else {
        throw nearbyException(
          NearbyErrorCode.serviceMismatch,
          "Nearby is already running with serviceId '\(activeServiceId ?? "")'. Call stopAll() before switching to '\(trimmed)'."
        )
      }
      return existing
    }

    // Cluster strategy: many-to-many, which is what a mesh needs.
    let manager = ConnectionManager(serviceID: trimmed, strategy: .cluster)
    manager.delegate = self
    connectionManager = manager
    activeServiceId = trimmed
    return manager
  }

  private func resolvePendingConnection(peerId: String, accept: Bool) throws {
    let handler: ((Bool) -> Void)? = withLock {
      let pending = pendingVerificationHandlers.removeValue(forKey: peerId)
      if !accept {
        // A rejected handshake never reaches `.connected`; drop the bookkeeping now.
        incomingEndpoints.remove(peerId)
      }
      return pending
    }

    guard let handler else {
      throw nearbyException(
        NearbyErrorCode.noPendingConnection,
        "No pending connection for peer '\(peerId)'. It may have already timed out or been resolved."
      )
    }
    handler(accept)
  }

  /// Denies any handler still parked for this endpoint so the SDK is never left
  /// holding an unanswered continuation.
  private func abortPendingHandshake(_ peerId: String) {
    let handlers: [(Bool) -> Void] = withLock {
      var result: [(Bool) -> Void] = []
      if let request = pendingRequestHandlers.removeValue(forKey: peerId) { result.append(request) }
      if let verification = pendingVerificationHandlers.removeValue(forKey: peerId) { result.append(verification) }
      return result
    }
    handlers.forEach { $0(false) }
  }

  private func forgetEndpoint(_ peerId: String) {
    withLock {
      connectedEndpoints.remove(peerId)
      incomingEndpoints.remove(peerId)
      pendingRequestHandlers.removeValue(forKey: peerId)
      pendingVerificationHandlers.removeValue(forKey: peerId)
    }
  }

  private func teardown() {
    let (advertiserRef, discovererRef, managerRef, peers) = withLock {
      (advertiser, discoverer, connectionManager, connectedEndpoints)
    }

    // Deny everything still in flight before tearing the transport down.
    let stalled: [(Bool) -> Void] = withLock {
      let all = Array(pendingRequestHandlers.values) + Array(pendingVerificationHandlers.values)
      pendingRequestHandlers.removeAll()
      pendingVerificationHandlers.removeAll()
      return all
    }
    stalled.forEach { $0(false) }

    advertiserRef?.stopAdvertising(completionHandler: nil)
    discovererRef?.stopDiscovery(completionHandler: nil)
    for peer in peers {
      managerRef?.disconnect(from: peer, completionHandler: nil)
    }

    withLock {
      advertiser = nil
      discoverer = nil
      connectionManager = nil
      activeServiceId = nil
      isAdvertising = false
      isDiscovering = false
      endpointNames.removeAll()
      discoveredEndpoints.removeAll()
      connectedEndpoints.removeAll()
      incomingEndpoints.removeAll()
    }

    for peer in peers {
      emit("onDisconnected", ["id": peer])
    }
  }

  // MARK: - Emitting

  /// All events reach JS on the main queue; Nearby's callbacks arrive on internal
  /// queues and must not touch the JS runtime directly.
  private func emit(_ name: String, _ body: [String: Any]) {
    if Thread.isMainThread {
      sendEvent(name, body)
    } else {
      DispatchQueue.main.async { [weak self] in
        self?.sendEvent(name, body)
      }
    }
  }

  private func emitError(code: String, message: String) {
    emit("onError", ["message": message, "code": code])
  }

  /// Every failure both rejects the promise and surfaces on `onError`.
  private func failPromise(_ promise: Promise, code: String, message: String) {
    emitError(code: code, message: message)
    promise.reject(nearbyException(code, message))
  }

  private func failPromise(_ promise: Promise, error: Error) {
    if let exception = error as? Exception {
      emitError(code: exception.code, message: exception.description)
      promise.reject(exception)
    } else {
      let message = error.localizedDescription
      emitError(code: NearbyErrorCode.internalError, message: message)
      promise.reject(nearbyException(NearbyErrorCode.internalError, message))
    }
  }

  // MARK: - Verification code normalisation

  /// The contract promises "short human-readable digits". Nearby on iOS hands us
  /// an opaque token string, which on some builds is already numeric and on others
  /// is not. Digits derived deterministically from the token are identical on both
  /// devices (they see the same token), so comparing them stays meaningful.
  private static func humanReadableCode(from token: String) -> String {
    let digitsOnly = token.filter(\.isNumber)
    if digitsOnly.count >= 4 && digitsOnly.count == token.count {
      return String(digitsOnly.prefix(6))
    }

    // FNV-1a over the UTF-8 bytes -> stable 4 digits.
    var hash: UInt64 = 0xcbf2_9ce4_8422_2325
    for byte in Array(token.utf8) {
      hash ^= UInt64(byte)
      hash = hash &* 0x1000_0000_01b3
    }
    return String(format: "%04d", Int(hash % 10000))
  }
}

// MARK: - DiscovererDelegate

extension NearbyMeshModule: DiscovererDelegate {
  public func discoverer(_ discoverer: Discoverer, didFind endpointID: EndpointID, with context: Data) {
    let name = String(data: context, encoding: .utf8) ?? ""
    withLock {
      endpointNames[endpointID] = name
      discoveredEndpoints.insert(endpointID)
    }
    emit("onPeerFound", ["id": endpointID, "name": name])
  }

  public func discoverer(_ discoverer: Discoverer, didLose endpointID: EndpointID) {
    withLock {
      discoveredEndpoints.remove(endpointID)
      // Deliberately keep endpointNames: a lost-then-reconnecting peer, and any
      // in-flight connection to it, should still be able to report a name.
    }
    emit("onPeerLost", ["id": endpointID])
  }
}

// MARK: - AdvertiserDelegate

extension NearbyMeshModule: AdvertiserDelegate {
  public func advertiser(
    _ advertiser: Advertiser,
    didReceiveConnectionRequestFrom endpointID: EndpointID,
    with context: Data,
    connectionRequestHandler: @escaping (Bool) -> Void
  ) {
    let name = String(data: context, encoding: .utf8) ?? ""
    withLock {
      endpointNames[endpointID] = name
      incomingEndpoints.insert(endpointID)
      pendingRequestHandlers[endpointID] = connectionRequestHandler
    }

    // iOS splits the handshake in two: first "do you want to talk to this endpoint
    // at all", then "here is the verification code, confirm it". Android exposes
    // only the second. To keep one `onConnectionInitiated` on both platforms we
    // auto-accept phase one here and defer the real user decision to the
    // verification callback, which is where `verificationCode` becomes known.
    withLock { _ = pendingRequestHandlers.removeValue(forKey: endpointID) }
    connectionRequestHandler(true)
  }
}

// MARK: - ConnectionManagerDelegate

extension NearbyMeshModule: ConnectionManagerDelegate {
  public func connectionManager(
    _ connectionManager: ConnectionManager,
    didReceive verificationCode: String,
    from endpointID: EndpointID,
    verificationHandler: @escaping (Bool) -> Void
  ) {
    let isIncoming: Bool = withLock {
      pendingVerificationHandlers[endpointID] = verificationHandler
      return incomingEndpoints.contains(endpointID)
    }

    emit("onConnectionInitiated", [
      "id": endpointID,
      "name": nameFor(endpointID),
      "verificationCode": Self.humanReadableCode(from: verificationCode),
      "isIncoming": isIncoming,
    ])
  }

  public func connectionManager(
    _ connectionManager: ConnectionManager,
    didReceive data: Data,
    withID payloadID: PayloadID,
    from endpointID: EndpointID
  ) {
    // Opaque bytes straight through. No inspection, no interpretation.
    emit("onPayload", [
      "peerId": endpointID,
      "payloadBase64": data.base64EncodedString(),
    ])
  }

  public func connectionManager(
    _ connectionManager: ConnectionManager,
    didReceive stream: InputStream,
    withID payloadID: PayloadID,
    from endpointID: EndpointID,
    cancellationToken token: CancellationToken
  ) {
    // Unsupported transfer type for this module — cancel rather than leak.
    token.cancel()
  }

  public func connectionManager(
    _ connectionManager: ConnectionManager,
    didStartReceivingResourceWithID payloadID: PayloadID,
    from endpointID: EndpointID,
    at localURL: URL,
    withName name: String,
    cancellationToken token: CancellationToken
  ) {
    // Unsupported transfer type for this module — cancel rather than leak.
    token.cancel()
  }

  public func connectionManager(
    _ connectionManager: ConnectionManager,
    didReceiveTransferUpdate update: TransferUpdate,
    from endpointID: EndpointID,
    forPayload payloadID: PayloadID
  ) {
    // Byte payloads are delivered whole; progress updates carry nothing the
    // contract exposes. Only surface hard failures.
    switch update {
    case .failure:
      emitError(
        code: NearbyErrorCode.sendFailed,
        message: "Payload transfer with '\(endpointID)' failed."
      )
    default:
      break
    }
  }

  public func connectionManager(
    _ connectionManager: ConnectionManager,
    didChangeTo state: ConnectionState,
    for endpointID: EndpointID
  ) {
    switch state {
    case .connecting:
      break

    case .connected:
      withLock {
        connectedEndpoints.insert(endpointID)
        pendingRequestHandlers.removeValue(forKey: endpointID)
        pendingVerificationHandlers.removeValue(forKey: endpointID)
      }
      emit("onConnected", ["id": endpointID, "name": nameFor(endpointID)])

    case .disconnected:
      let wasKnown = withLock {
        connectedEndpoints.contains(endpointID) || pendingVerificationHandlers[endpointID] != nil
      }
      forgetEndpoint(endpointID)
      if wasKnown {
        emit("onDisconnected", ["id": endpointID])
      }

    case .rejected:
      // A rejection terminates the handshake; the contract models that as a
      // disconnect so every onConnectionInitiated has exactly one terminal event.
      forgetEndpoint(endpointID)
      emit("onDisconnected", ["id": endpointID])

    @unknown default:
      break
    }
  }
}
