package expo.modules.nearbymesh

// Google Nearby Connections transport for Expo, Android side.
//
// IMPORTANT: this file is a *dumb byte pipe*. It must never learn anything about
// chat: no message parsing, no dedup, no storage, no crypto. Bytes in, bytes out,
// plus peer/connection lifecycle events. Keep it that way.

import android.Manifest
import android.os.Build
import android.os.Bundle
import android.util.Base64
import androidx.core.os.bundleOf
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.AdvertisingOptions
import com.google.android.gms.nearby.connection.ConnectionInfo
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback
import com.google.android.gms.nearby.connection.ConnectionResolution
import com.google.android.gms.nearby.connection.ConnectionsClient
import com.google.android.gms.nearby.connection.ConnectionsStatusCodes
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo
import com.google.android.gms.nearby.connection.DiscoveryOptions
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback
import com.google.android.gms.nearby.connection.Payload
import com.google.android.gms.nearby.connection.PayloadCallback
import com.google.android.gms.nearby.connection.PayloadTransferUpdate
import com.google.android.gms.nearby.connection.Strategy
import expo.modules.interfaces.permissions.PermissionsResponse
import expo.modules.interfaces.permissions.PermissionsResponseListener
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Coded error identifiers. These strings are part of the public contract and are
 * duplicated verbatim in the iOS implementation - keep the two in sync.
 */
private object NearbyErrorCode {
  const val UNAVAILABLE = "ERR_NEARBY_UNAVAILABLE"
  const val NOT_STARTED = "ERR_NEARBY_NOT_STARTED"
  const val SERVICE_MISMATCH = "ERR_NEARBY_SERVICE_MISMATCH"
  const val UNKNOWN_PEER = "ERR_NEARBY_UNKNOWN_PEER"
  const val NO_PENDING_CONNECTION = "ERR_NEARBY_NO_PENDING_CONNECTION"
  const val NOT_CONNECTED = "ERR_NEARBY_NOT_CONNECTED"
  const val INVALID_PAYLOAD = "ERR_NEARBY_INVALID_PAYLOAD"
  const val INVALID_ARGUMENT = "ERR_NEARBY_INVALID_ARGUMENT"
  const val ADVERTISE_FAILED = "ERR_NEARBY_ADVERTISE_FAILED"
  const val DISCOVER_FAILED = "ERR_NEARBY_DISCOVER_FAILED"
  const val CONNECT_FAILED = "ERR_NEARBY_CONNECT_FAILED"
  const val SEND_FAILED = "ERR_NEARBY_SEND_FAILED"
  const val DISCONNECT_FAILED = "ERR_NEARBY_DISCONNECT_FAILED"
  const val PERMISSION_DENIED = "ERR_NEARBY_PERMISSION_DENIED"
  const val NO_CONTEXT = "ERR_NEARBY_NO_CONTEXT"
  const val INTERNAL = "ERR_NEARBY_INTERNAL"
}

private class NearbyMeshException(code: String, message: String) :
  CodedException(code, message, null)

class NearbyMeshModule : Module() {
  /** Guards every mutable field below. Nearby callbacks arrive on the main looper,
   *  but JS calls arrive on the module executor, so both touch this state. */
  private val lock = Any()

  private var connectionsClient: ConnectionsClient? = null
  private var activeServiceId: String? = null

  private var displayName: String = "Anonymous"

  /** endpointId -> best-known display name, so every event can carry a name. */
  private val endpointNames = mutableMapOf<String, String>()

  /** Endpoints seen via discovery and not yet lost. */
  private val discoveredEndpoints = mutableSetOf<String>()

  /** Endpoints whose handshake was announced but not yet accepted/rejected. */
  private val pendingConnections = mutableSetOf<String>()

  /** Endpoints currently connected. */
  private val connectedEndpoints = mutableSetOf<String>()

  private var isAdvertising = false
  private var isDiscovering = false

  // ---------------------------------------------------------------------------
  // Definition
  // ---------------------------------------------------------------------------

  override fun definition() = ModuleDefinition {
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

    OnDestroy {
      runCatching { teardown() }
    }

    AsyncFunction("setDisplayName") { name: String ->
      val trimmed = name.trim().take(64)
      synchronized(lock) {
        displayName = trimmed.ifEmpty { "Anonymous" }
      }
    }

    AsyncFunction("startAdvertising") { serviceId: String, promise: Promise ->
      val normalized = normalizeServiceId(serviceId, promise) ?: return@AsyncFunction
      withPermissions(promise) {
        val client = ensureClient(normalized, promise) ?: return@withPermissions
        val options = AdvertisingOptions.Builder()
          // Cluster: many-to-many, which is what a mesh needs.
          .setStrategy(Strategy.P2P_CLUSTER)
          .build()

        client.startAdvertising(currentDisplayName(), normalized, connectionLifecycleCallback, options)
          .addOnSuccessListener {
            synchronized(lock) { isAdvertising = true }
            promise.resolve(null)
          }
          .addOnFailureListener { error ->
            synchronized(lock) { isAdvertising = false }
            failPromise(
              promise,
              NearbyErrorCode.ADVERTISE_FAILED,
              "Failed to start advertising: ${describe(error)}"
            )
          }
      }
    }

    AsyncFunction("startDiscovery") { serviceId: String, promise: Promise ->
      val normalized = normalizeServiceId(serviceId, promise) ?: return@AsyncFunction
      withPermissions(promise) {
        val client = ensureClient(normalized, promise) ?: return@withPermissions
        val options = DiscoveryOptions.Builder()
          .setStrategy(Strategy.P2P_CLUSTER)
          .build()

        client.startDiscovery(normalized, endpointDiscoveryCallback, options)
          .addOnSuccessListener {
            synchronized(lock) { isDiscovering = true }
            promise.resolve(null)
          }
          .addOnFailureListener { error ->
            synchronized(lock) { isDiscovering = false }
            failPromise(
              promise,
              NearbyErrorCode.DISCOVER_FAILED,
              "Failed to start discovery: ${describe(error)}"
            )
          }
      }
    }

    AsyncFunction("stopAll") { promise: Promise ->
      teardown()
      promise.resolve(null)
    }

    AsyncFunction("requestConnection") { peerId: String, promise: Promise ->
      val client = synchronized(lock) { connectionsClient }
      if (client == null) {
        failPromise(
          promise,
          NearbyErrorCode.NOT_STARTED,
          "Nearby transport is not running; call startDiscovery before requestConnection."
        )
        return@AsyncFunction
      }
      if (!synchronized(lock) { discoveredEndpoints.contains(peerId) }) {
        failPromise(
          promise,
          NearbyErrorCode.UNKNOWN_PEER,
          "Unknown peer '$peerId'. It was never discovered, or it was already lost."
        )
        return@AsyncFunction
      }

      client.requestConnection(currentDisplayName(), peerId, connectionLifecycleCallback)
        .addOnSuccessListener { promise.resolve(null) }
        .addOnFailureListener { error ->
          failPromise(
            promise,
            NearbyErrorCode.CONNECT_FAILED,
            "Failed to request connection to '$peerId': ${describe(error)}"
          )
        }
    }

    AsyncFunction("acceptConnection") { peerId: String, promise: Promise ->
      val client = requirePendingConnection(peerId, promise) ?: return@AsyncFunction
      client.acceptConnection(peerId, payloadCallback)
        .addOnSuccessListener { promise.resolve(null) }
        .addOnFailureListener { error ->
          synchronized(lock) { pendingConnections.remove(peerId) }
          failPromise(
            promise,
            NearbyErrorCode.CONNECT_FAILED,
            "Failed to accept connection from '$peerId': ${describe(error)}"
          )
        }
    }

    AsyncFunction("rejectConnection") { peerId: String, promise: Promise ->
      val client = requirePendingConnection(peerId, promise) ?: return@AsyncFunction
      synchronized(lock) { pendingConnections.remove(peerId) }
      client.rejectConnection(peerId)
        .addOnSuccessListener { promise.resolve(null) }
        .addOnFailureListener { error ->
          failPromise(
            promise,
            NearbyErrorCode.CONNECT_FAILED,
            "Failed to reject connection from '$peerId': ${describe(error)}"
          )
        }
    }

    AsyncFunction("disconnect") { peerId: String, promise: Promise ->
      // Never crash on an absent endpoint: disconnecting something already gone is
      // a no-op success so callers can be sloppy in cleanup paths.
      val client = synchronized(lock) { connectionsClient }
      if (client == null) {
        forgetEndpoint(peerId)
        promise.resolve(null)
        return@AsyncFunction
      }
      forgetEndpoint(peerId)
      // disconnectFromEndpoint returns void and tolerates unknown endpoints.
      try {
        client.disconnectFromEndpoint(peerId)
        promise.resolve(null)
      } catch (error: Throwable) {
        failPromise(
          promise,
          NearbyErrorCode.DISCONNECT_FAILED,
          "Failed to disconnect from '$peerId': ${describe(error)}"
        )
      }
    }

    AsyncFunction("send") { peerId: String, payloadBase64: String, promise: Promise ->
      val bytes = try {
        Base64.decode(payloadBase64, Base64.DEFAULT)
      } catch (error: IllegalArgumentException) {
        failPromise(promise, NearbyErrorCode.INVALID_PAYLOAD, "payloadBase64 is not valid base64.")
        return@AsyncFunction
      }

      val client = synchronized(lock) { connectionsClient }
      if (client == null) {
        failPromise(promise, NearbyErrorCode.NOT_STARTED, "Nearby transport is not running.")
        return@AsyncFunction
      }
      if (!synchronized(lock) { connectedEndpoints.contains(peerId) }) {
        failPromise(promise, NearbyErrorCode.NOT_CONNECTED, "Peer '$peerId' is not connected.")
        return@AsyncFunction
      }

      client.sendPayload(peerId, Payload.fromBytes(bytes))
        .addOnSuccessListener { promise.resolve(null) }
        .addOnFailureListener { error ->
          failPromise(
            promise,
            NearbyErrorCode.SEND_FAILED,
            "Failed to send to '$peerId': ${describe(error)}"
          )
        }
    }

    AsyncFunction("isAvailable") {
      val context = appContext.reactContext
      context != null &&
        GoogleApiAvailability.getInstance()
          .isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS
    }
  }

  // ---------------------------------------------------------------------------
  // Nearby callbacks
  // ---------------------------------------------------------------------------

  private val endpointDiscoveryCallback = object : EndpointDiscoveryCallback() {
    override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
      val name = info.endpointName ?: ""
      synchronized(lock) {
        endpointNames[endpointId] = name
        discoveredEndpoints.add(endpointId)
      }
      emit("onPeerFound", bundleOf("id" to endpointId, "name" to name))
    }

    override fun onEndpointLost(endpointId: String) {
      synchronized(lock) {
        discoveredEndpoints.remove(endpointId)
        // Deliberately keep endpointNames: a lost-then-reconnecting peer, and any
        // in-flight connection to it, should still be able to report a name.
      }
      emit("onPeerLost", bundleOf("id" to endpointId))
    }
  }

  private val connectionLifecycleCallback = object : ConnectionLifecycleCallback() {
    override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
      val name = info.endpointName ?: synchronized(lock) { endpointNames[endpointId] } ?: ""
      synchronized(lock) {
        endpointNames[endpointId] = name
        pendingConnections.add(endpointId)
      }

      emit(
        "onConnectionInitiated",
        bundleOf(
          "id" to endpointId,
          "name" to name,
          "verificationCode" to verificationCodeOf(info),
          "isIncoming" to info.isIncomingConnection
        )
      )
    }

    override fun onConnectionResult(endpointId: String, resolution: ConnectionResolution) {
      synchronized(lock) { pendingConnections.remove(endpointId) }

      when (resolution.status.statusCode) {
        ConnectionsStatusCodes.STATUS_OK -> {
          synchronized(lock) { connectedEndpoints.add(endpointId) }
          emit(
            "onConnected",
            bundleOf("id" to endpointId, "name" to nameFor(endpointId))
          )
        }

        ConnectionsStatusCodes.STATUS_CONNECTION_REJECTED -> {
          // A rejection terminates the handshake. The contract models that as a
          // disconnect so every onConnectionInitiated has exactly one terminal event.
          forgetEndpoint(endpointId)
          emit("onDisconnected", bundleOf("id" to endpointId))
        }

        else -> {
          forgetEndpoint(endpointId)
          emitError(
            NearbyErrorCode.CONNECT_FAILED,
            "Connection to '$endpointId' failed: ${resolution.status.statusMessage ?: resolution.status.statusCode}"
          )
          emit("onDisconnected", bundleOf("id" to endpointId))
        }
      }
    }

    override fun onDisconnected(endpointId: String) {
      forgetEndpoint(endpointId)
      emit("onDisconnected", bundleOf("id" to endpointId))
    }
  }

  private val payloadCallback = object : PayloadCallback() {
    override fun onPayloadReceived(endpointId: String, payload: Payload) {
      // Only byte payloads are part of the contract. Streams and files are ignored
      // rather than half-handled.
      if (payload.type != Payload.Type.BYTES) {
        return
      }
      val bytes = payload.asBytes() ?: return
      // Opaque bytes straight through. No inspection, no interpretation.
      emit(
        "onPayload",
        bundleOf(
          "peerId" to endpointId,
          "payloadBase64" to Base64.encodeToString(bytes, Base64.NO_WRAP)
        )
      )
    }

    override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {
      // Byte payloads are delivered whole; progress carries nothing the contract
      // exposes. Only surface hard failures.
      if (update.status == PayloadTransferUpdate.Status.FAILURE) {
        emitError(
          NearbyErrorCode.SEND_FAILED,
          "Payload transfer with '$endpointId' failed."
        )
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private fun currentDisplayName(): String = synchronized(lock) { displayName }

  private fun nameFor(endpointId: String): String =
    synchronized(lock) { endpointNames[endpointId] } ?: ""

  /**
   * Nearby exposes short digits on modern Play services and only an opaque token
   * on older ones. Fall back to deterministic digits derived from the token so the
   * value is still short, human readable and identical on both devices.
   */
  private fun verificationCodeOf(info: ConnectionInfo): String {
    val digits = runCatching { info.authenticationDigits }.getOrNull()
    if (!digits.isNullOrEmpty()) {
      return digits
    }

    @Suppress("DEPRECATION")
    val token = runCatching { info.authenticationToken }.getOrNull().orEmpty()
    if (token.isEmpty()) {
      return "0000"
    }
    if (token.all { it.isDigit() }) {
      return token.take(6)
    }

    // FNV-1a over the UTF-8 bytes -> stable 4 digits. Matches the iOS fallback.
    var hash = 0xcbf29ce484222325uL
    for (byte in token.toByteArray(Charsets.UTF_8)) {
      hash = hash xor (byte.toLong() and 0xff).toULong()
      hash *= 0x100000001b3uL
    }
    return (hash % 10000uL).toString().padStart(4, '0')
  }

  private fun normalizeServiceId(serviceId: String, promise: Promise): String? {
    val trimmed = serviceId.trim()
    if (trimmed.isEmpty()) {
      failPromise(promise, NearbyErrorCode.INVALID_ARGUMENT, "serviceId must not be empty.")
      return null
    }
    return trimmed
  }

  private fun ensureClient(serviceId: String, promise: Promise): ConnectionsClient? {
    synchronized(lock) {
      val existing = connectionsClient
      if (existing != null) {
        if (activeServiceId != serviceId) {
          failPromise(
            promise,
            NearbyErrorCode.SERVICE_MISMATCH,
            "Nearby is already running with serviceId '$activeServiceId'. Call stopAll() before switching to '$serviceId'."
          )
          return null
        }
        return existing
      }

      val context = appContext.reactContext
      if (context == null) {
        failPromise(promise, NearbyErrorCode.NO_CONTEXT, "React context is unavailable.")
        return null
      }

      val created = Nearby.getConnectionsClient(context)
      connectionsClient = created
      activeServiceId = serviceId
      return created
    }
  }

  private fun requirePendingConnection(peerId: String, promise: Promise): ConnectionsClient? {
    val client = synchronized(lock) { connectionsClient }
    if (client == null) {
      failPromise(promise, NearbyErrorCode.NOT_STARTED, "Nearby transport is not running.")
      return null
    }
    if (!synchronized(lock) { pendingConnections.contains(peerId) }) {
      failPromise(
        promise,
        NearbyErrorCode.NO_PENDING_CONNECTION,
        "No pending connection for peer '$peerId'. It may have already timed out or been resolved."
      )
      return null
    }
    return client
  }

  private fun forgetEndpoint(peerId: String) {
    synchronized(lock) {
      connectedEndpoints.remove(peerId)
      pendingConnections.remove(peerId)
    }
  }

  private fun teardown() {
    val (client, peers) = synchronized(lock) {
      connectionsClient to connectedEndpoints.toList()
    }

    client?.let {
      runCatching { it.stopAdvertising() }
      runCatching { it.stopDiscovery() }
      runCatching { it.stopAllEndpoints() }
    }

    synchronized(lock) {
      connectionsClient = null
      activeServiceId = null
      isAdvertising = false
      isDiscovering = false
      endpointNames.clear()
      discoveredEndpoints.clear()
      pendingConnections.clear()
      connectedEndpoints.clear()
    }

    // stopAllEndpoints does not fire onDisconnected, so synthesise it.
    peers.forEach { emit("onDisconnected", bundleOf("id" to it)) }
  }

  // ---------------------------------------------------------------------------
  // Permissions
  // ---------------------------------------------------------------------------

  /**
   * The permission set Nearby needs varies by API level:
   *  - <= 30: legacy BLUETOOTH / BLUETOOTH_ADMIN (install-time) plus location.
   *  - 31/32: the BLUETOOTH_SCAN / ADVERTISE / CONNECT split, still plus location.
   *  - >= 33: the Bluetooth split plus NEARBY_WIFI_DEVICES; location is no longer
   *    required because NEARBY_WIFI_DEVICES is declared neverForLocation.
   */
  private fun requiredPermissions(): Array<String> {
    val permissions = mutableListOf<String>()

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      permissions += Manifest.permission.BLUETOOTH_SCAN
      permissions += Manifest.permission.BLUETOOTH_ADVERTISE
      permissions += Manifest.permission.BLUETOOTH_CONNECT
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      permissions += Manifest.permission.NEARBY_WIFI_DEVICES
    } else {
      permissions += Manifest.permission.ACCESS_FINE_LOCATION
      permissions += Manifest.permission.ACCESS_COARSE_LOCATION
    }

    return permissions.toTypedArray()
  }

  /** Requests the API-level-appropriate permissions, then runs [block] if granted. */
  private fun withPermissions(promise: Promise, block: () -> Unit) {
    val permissions = requiredPermissions()
    if (permissions.isEmpty()) {
      block()
      return
    }

    val manager = appContext.permissions
    if (manager == null) {
      // No permissions service linked. Fall through and let Nearby itself fail
      // with a real error rather than blocking on a service we do not have.
      block()
      return
    }

    val listener = PermissionsResponseListener { result: Map<String, PermissionsResponse> ->
      val denied = permissions.filter {
        result[it]?.status != PermissionsStatus.GRANTED
      }
      if (denied.isEmpty()) {
        block()
      } else {
        failPromise(
          promise,
          NearbyErrorCode.PERMISSION_DENIED,
          "Missing permissions required by Nearby Connections: ${denied.joinToString(", ")}"
        )
      }
    }
    manager.askForPermissions(listener, *permissions)
  }

  // ---------------------------------------------------------------------------
  // Emitting
  // ---------------------------------------------------------------------------

  private fun emit(name: String, body: Bundle) {
    runCatching { sendEvent(name, body) }
  }

  private fun emitError(code: String, message: String) {
    emit("onError", bundleOf("message" to message, "code" to code))
  }

  /** Every failure both rejects the promise and surfaces on `onError`. */
  private fun failPromise(promise: Promise, code: String, message: String) {
    emitError(code, message)
    promise.reject(NearbyMeshException(code, message))
  }

  private fun describe(error: Throwable): String = when (error) {
    is ApiException -> "${error.statusCode} ${error.status.statusMessage ?: error.message ?: ""}".trim()
    else -> error.message ?: error.javaClass.simpleName
  }
}
