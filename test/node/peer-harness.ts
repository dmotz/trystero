import {createActionManager} from '../../packages/core/src/actions.ts'
import assert from 'node:assert/strict'
import type {
  InternalRoomContext,
  KernelRolesProvider,
  KernelScaleProvider,
  PeerHandle
} from '../../packages/core/src/internal-types.ts'
import {createDirectPeerTransport} from '../../packages/core/src/peer-transport.ts'
import {
  base62Alphabet,
  pluginSlotSymbol
} from '../../packages/core/src/primitives.ts'
import createRoom from '../../packages/core/src/room.ts'
import type {
  Room,
  RoomPlugin,
  UserIdentity
} from '../../packages/core/src/types.ts'
import {internalActionPrefix} from '../../packages/core/src/utils.ts'
import {
  allocTestPeerIds,
  createSortedJoinRooms,
  getTestEndpointByPeerId,
  joinAsTestPeer,
  testEndpoint,
  testPeerId,
  withTestPeerId
} from './test-identity.ts'

export {
  allocTestPeerIds,
  createSortedJoinRooms,
  getTestEndpointByPeerId,
  internalActionPrefix,
  joinAsTestPeer,
  testEndpoint,
  testPeerId,
  withTestPeerId
}

type PeerHandlers = {
  connect?: () => void
  close?: () => void
  data?: (data: ArrayBuffer) => void
  stream?: (stream: TestMediaStream | MediaStream) => void
  track?: (
    track: TestMediaTrack | MediaStreamTrack,
    stream: TestMediaStream | MediaStream
  ) => void
  signal?: (sdp: unknown) => void
  error?: (err: Error) => void
  [key: string]: ((...args: any[]) => void) | undefined
}
type TestMediaTrack = {id: string}
type TestMediaStream = {
  id: string
  getTracks: () => TestMediaTrack[]
}

const internalTypeByteLimit = 32
const encoder = new TextEncoder()

export const tick = () => new Promise(res => setTimeout(res, 0))

export const turn = () => new Promise<void>(resolve => setImmediate(resolve))

export const wait = (ms: number) => new Promise(res => setTimeout(res, ms))

export const waitFor = async (
  check: () => boolean,
  timeoutMs = 2_000
): Promise<void> => {
  const start = Date.now()

  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition')
    }

    await wait(10)
  }
}

export const withTimeout = <T>(promise: Promise<T>, ms = 500): Promise<T> =>
  Promise.race([
    promise,
    wait(ms).then(() => {
      throw new Error('timed out waiting for result')
    })
  ])

export const encodeInternalAction = (type: string): ArrayBuffer => {
  const wireType = type.startsWith(internalActionPrefix)
    ? type
    : `${internalActionPrefix}${type}`
  const typeBytes = encoder.encode(wireType)
  assert.ok(typeBytes.byteLength <= internalTypeByteLimit)

  const packet = new Uint8Array(36)
  packet[0] = 3 // wire version; inline empty string, with no metadata
  packet.set(typeBytes, 2)

  return packet.buffer
}

export const actionStartFrame = (
  id: number,
  size: number,
  {
    type = 'file',
    payload,
    metadata,
    format = 2
  }: {
    type?: string
    payload?: Uint8Array
    metadata?: unknown
    format?: number
  } = {}
) => {
  const meta =
    metadata === undefined
      ? new Uint8Array()
      : encoder.encode(JSON.stringify(metadata))
  const header = payload ? 36 : 48
  const bytes = new Uint8Array(header + meta.length + (payload?.length ?? 0))
  const view = new DataView(bytes.buffer)
  bytes[0] = 3
  bytes[1] = (payload ? 0 : 1) | (format << 4)
  bytes.set(encoder.encode(type), 2)
  view.setUint16(34, meta.length)
  if (!payload) {
    view.setUint32(36, id)
    view.setFloat64(40, size)
  }
  bytes.set(meta, header)
  if (payload) {
    bytes.set(payload, header + meta.length)
  }
  return bytes.buffer
}

export class MockDataChannel {
  readyState = 'connecting'
  binaryType = 'arraybuffer'
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  onmessage: ((ev: {data: unknown}) => void) | null = null
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((ev: unknown) => void) | null = null

  close() {
    this.readyState = 'closed'
    this.onclose?.()
  }

  send(_data?: unknown) {}
}

export class MockRTCPeerConnection {
  iceGatheringState = 'complete'
  connectionState = 'new'
  iceConnectionState = 'new'
  signalingState = 'stable'
  localDescription: {type: string; sdp: string} | null = null
  remoteDescription: {type: string; sdp: string} | null = null
  onnegotiationneeded: (() => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  ontrack: ((ev: unknown) => void) | null = null
  ondatachannel: ((ev: {channel: MockDataChannel}) => void) | null = null
  listeners: Record<string, Set<(...args: any[]) => void>> = {}

  createDataChannel(_label?: string) {
    return new MockDataChannel()
  }

  addEventListener(event: string, fn: (...args: any[]) => void) {
    ;(this.listeners[event] ??= new Set()).add(fn)
  }

  removeEventListener(event: string, fn: (...args: any[]) => void) {
    this.listeners[event]?.delete(fn)
  }

  restartIce() {}

  async createOffer() {
    return {type: 'offer', sdp: `mock-offer-${Math.random()}`}
  }

  async setLocalDescription(description?: {type: string; sdp?: string}) {
    if (description?.type === 'rollback') {
      this.signalingState = 'stable'
      return
    }

    const nextDescription = description
      ? {type: description.type, sdp: description.sdp ?? ''}
      : await this.createOffer()
    this.localDescription = nextDescription
    this.signalingState =
      nextDescription.type === 'offer' ? 'have-local-offer' : 'stable'

    this.listeners['icegatheringstatechange']?.forEach(listener => listener())
  }

  async setRemoteDescription(description?: {type: string; sdp?: string}) {
    this.remoteDescription = description
      ? {type: description.type, sdp: description.sdp ?? ''}
      : {type: 'answer', sdp: 'mock-answer'}
    this.signalingState = 'stable'
  }

  close() {
    this.connectionState = 'closed'
    this.iceConnectionState = 'closed'
    this.onconnectionstatechange?.()
  }

  getSenders() {
    return []
  }

  addTrack() {
    return {}
  }

  removeTrack() {}
}

let mockFingerprintCounter = 0

const nextMockFingerprintSdp = () => {
  const n = ++mockFingerprintCounter
  const b0 = ((n >>> 16) & 0xff).toString(16).padStart(2, '0').toUpperCase()
  const b1 = ((n >>> 8) & 0xff).toString(16).padStart(2, '0').toUpperCase()
  const b2 = (n & 0xff).toString(16).padStart(2, '0').toUpperCase()
  return `v=0\r\na=fingerprint:sha-256 AA:BB:CC:${b0}:${b1}:${b2}\r\n`
}

export class MockPeer {
  created = Date.now()
  isDead = false
  destroyCount = 0
  handlers: PeerHandlers = {}
  offerPromise = Promise.resolve()
  connection = {
    connectionState: 'connected',
    iceConnectionState: 'connected',
    localDescription: {type: 'offer', sdp: nextMockFingerprintSdp()},
    remoteDescription: {type: 'answer', sdp: nextMockFingerprintSdp()},
    getSenders: () => []
  }
  channel = {
    readyState: 'open',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0
  }

  async getOffer() {}

  async signal() {
    this.handlers.connect?.()
  }

  sendData() {}

  destroy() {
    if (this.isDead) {
      return
    }

    this.isDead = true
    this.destroyCount += 1
    this.connection.connectionState = 'closed'
    this.connection.iceConnectionState = 'closed'
    this.handlers.close?.()
  }

  setHandlers(newHandlers: PeerHandlers) {
    Object.assign(this.handlers, newHandlers)
  }

  addStream(_stream?: unknown) {}
  removeStream(_stream?: unknown) {}
  addTrack(_track?: unknown, _stream?: unknown) {
    return {}
  }
  removeTrack(_track?: unknown) {}
  async replaceTrack(_oldTrack?: unknown, _newTrack?: unknown) {}
}

export class LinkedPeer {
  created = Date.now()
  isDead = false
  handlers: PeerHandlers = {}
  offerPromise = Promise.resolve()
  partner: LinkedPeer | null = null
  lastSentData: ArrayBuffer | null = null
  connection = {
    connectionState: 'connected',
    iceConnectionState: 'connected',
    localDescription: {type: 'offer', sdp: nextMockFingerprintSdp()},
    remoteDescription: {type: 'answer', sdp: nextMockFingerprintSdp()},
    getSenders: () => []
  }
  channel = {
    readyState: 'open',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0
  }

  async getOffer() {}

  async signal() {}

  sendData(data: Uint8Array | ArrayBuffer) {
    const view = data instanceof Uint8Array ? data : new Uint8Array(data)
    this.lastSentData = view.slice().buffer
    this.partner?.handlers.data?.(view.slice().buffer)
  }

  destroy() {
    if (this.isDead) {
      return
    }

    this.isDead = true
    this.connection.connectionState = 'closed'
    this.connection.iceConnectionState = 'closed'
    this.handlers.close?.()
  }

  setHandlers(newHandlers: PeerHandlers) {
    Object.assign(this.handlers, newHandlers)
  }

  addStream(_stream?: TestMediaStream) {}
  removeStream(_stream?: TestMediaStream) {}
  addTrack(_track?: TestMediaTrack, _stream?: TestMediaStream) {
    return {}
  }
  removeTrack(_track?: TestMediaTrack) {}
  async replaceTrack(_oldTrack?: TestMediaTrack, _newTrack?: TestMediaTrack) {}
}

export class BufferedPeer extends LinkedPeer {
  inbox: ArrayBuffer[] = []

  override async signal() {
    this.handlers.connect?.()
  }

  override sendData(data: Uint8Array | ArrayBuffer) {
    const view = data instanceof Uint8Array ? data : new Uint8Array(data)
    const payload = view.slice().buffer
    const partner = this.partner as BufferedPeer

    queueMicrotask(() => {
      partner.inbox.push(payload)
      partner.flush()
    })
  }

  override setHandlers(handlers: PeerHandlers) {
    super.setHandlers(handlers)
    this.flush()
  }

  flush() {
    const onData = this.handlers.data
    if (onData) {
      this.inbox.splice(0).forEach(data => onData(data))
    }
  }
}

export class LinkedMediaPeer extends LinkedPeer {
  addStreamCalls = 0
  addTrackCalls = 0
  removeTrackCalls = 0
  replaceTrackCalls = 0
  replacedTrackIds = new Map<string, string>()
  remoteStreams = new Map<
    string,
    {stream: TestMediaStream; tracksById: Map<string, TestMediaTrack>}
  >()

  ensureRemoteTrack(track: TestMediaTrack, stream: TestMediaStream) {
    let streamEntry = this.remoteStreams.get(stream.id)

    if (!streamEntry) {
      const tracksById = new Map()
      const remoteStream = {
        id: stream.id,
        getTracks: () => Array.from(tracksById.values())
      }

      streamEntry = {stream: remoteStream, tracksById}
      this.remoteStreams.set(stream.id, streamEntry)
    }

    const existingTrack = streamEntry.tracksById.get(track.id)

    if (existingTrack) {
      return {stream: streamEntry.stream, track: existingTrack, isNew: false}
    }

    const remoteTrack = {id: track.id}
    streamEntry.tracksById.set(track.id, remoteTrack)

    return {stream: streamEntry.stream, track: remoteTrack, isNew: true}
  }

  override addStream(stream: TestMediaStream) {
    this.addStreamCalls += 1

    stream.getTracks().forEach(track => {
      const remote = (
        this.partner as LinkedMediaPeer | null
      )?.ensureRemoteTrack(track, stream)

      if (remote?.isNew) {
        this.partner?.handlers.stream?.(remote.stream)
      }
    })
  }

  override removeStream(stream: TestMediaStream) {
    ;(this.partner as LinkedMediaPeer | null)?.remoteStreams.delete(stream.id)
  }

  override addTrack(track: TestMediaTrack, stream: TestMediaStream) {
    this.addTrackCalls += 1
    const remote = (this.partner as LinkedMediaPeer | null)?.ensureRemoteTrack(
      track,
      stream
    )

    if (remote?.isNew) {
      this.partner?.handlers.stream?.(remote.stream)
    }

    return {}
  }

  override removeTrack(track: TestMediaTrack) {
    this.removeTrackCalls += 1
    const targetId = this.replacedTrackIds.get(track.id) ?? track.id
    ;(this.partner as LinkedMediaPeer | null)?.remoteStreams.forEach(entry => {
      entry.tracksById.delete(targetId)
    })
  }

  override async replaceTrack(
    oldTrack: TestMediaTrack,
    newTrack: TestMediaTrack
  ) {
    this.replaceTrackCalls += 1
    if (oldTrack?.id && newTrack?.id) {
      const originalId = this.replacedTrackIds.get(oldTrack.id) ?? oldTrack.id
      this.replacedTrackIds.set(newTrack.id, originalId)
    }
  }
}

export const linkPeers = <A extends LinkedPeer, B extends LinkedPeer>(
  peerA: A,
  peerB: B
): {peerA: A; peerB: B} => {
  peerA.partner = peerB
  peerB.partner = peerA
  peerA.connection.remoteDescription = {
    type: 'answer',
    sdp: peerB.connection.localDescription.sdp
  }
  peerB.connection.remoteDescription = {
    type: 'answer',
    sdp: peerA.connection.localDescription.sdp
  }

  return {peerA, peerB}
}

export const createJoinedRooms = async () => {
  const epA = testEndpoint('joined-room-a')
  const epB = testEndpoint('joined-room-b')
  let registerPeerA: ((peer: PeerHandle, id: string) => void) | null = null
  let registerPeerB: ((peer: PeerHandle, id: string) => void) | null = null
  const roomA = createRoom(
    f => {
      registerPeerA = f
    },
    () => {},
    () => {},
    {endpointIdentity: epA, appId: 'joined-app', roomId: 'joined-room'}
  )
  const roomB = createRoom(
    f => {
      registerPeerB = f
    },
    () => {},
    () => {},
    {endpointIdentity: epB, appId: 'joined-app', roomId: 'joined-room'}
  )
  const joinA = new Promise(resolve => roomA.onPeerJoin(resolve, {once: true}))
  const joinB = new Promise(resolve => roomB.onPeerJoin(resolve, {once: true}))
  const {peerA, peerB} = linkPeers(new LinkedPeer(), new LinkedPeer())

  if (!registerPeerA || !registerPeerB) {
    assert.fail('expected both rooms to register their peer callbacks')
  }
  ;(registerPeerA as (peer: PeerHandle, id: string) => void)(
    peerA as unknown as PeerHandle,
    epB.peerId
  )
  ;(registerPeerB as (peer: PeerHandle, id: string) => void)(
    peerB as unknown as PeerHandle,
    epA.peerId
  )

  await Promise.all([joinA, joinB])

  return {
    roomA,
    roomB,
    peerA,
    peerB,
    peerIdA: epA.peerId,
    peerIdB: epB.peerId
  }
}

export const linkedActions = (maxReceiveBytes?: number) => {
  let disconnected = false
  const frames: {from: string; kind: number; id: number}[] = []
  const peer = (from: string, deliver: (data: ArrayBuffer) => void) => ({
    sendData: (bytes: Uint8Array) => {
      const b1 = bytes[1] ?? 0
      frames.push({
        from,
        kind: b1 & 15,
        id:
          (b1 & 15) === 0
            ? -1
            : new DataView(bytes.buffer).getUint32((b1 & 15) === 1 ? 36 : 2)
      })
      deliver(bytes.slice().buffer)
    },
    destroy: () => {
      disconnected = true
    }
  })
  const toRight = peer('left', bytes => right.handleData('left', bytes))
  const toLeft = peer('right', bytes => left.handleData('right', bytes))
  const left = createActionManager({
    onPeerError: (id, error) => {
      disconnected = true
      left.clearPeer(id, error)
    },
    getTransport: () => createDirectPeerTransport(toRight as never),
    getPeerIds: () => ['right'],
    canReceiveFromPeer: () => !disconnected
  })
  const right = createActionManager({
    onPeerError: (id, error) => {
      disconnected = true
      right.clearPeer(id, error)
    },
    getTransport: () => createDirectPeerTransport(toLeft as never),
    getPeerIds: () => ['left'],
    canReceiveFromPeer: () => !disconnected,
    ...(maxReceiveBytes === undefined ? {} : {maxReceiveBytes})
  })
  return {
    left,
    right,
    frames,
    disconnected: () => disconnected,
    close: () => {
      left.clearPeer('right', new Error('closed'))
      right.clearPeer('left', new Error('closed'))
    }
  }
}

export const makeTrack = (
  id: string,
  readyState: MediaStreamTrackState = 'live'
): MediaStreamTrack =>
  ({
    id,
    kind: 'video',
    readyState
  }) as unknown as MediaStreamTrack

export const makeStream = (
  id: string,
  tracks: MediaStreamTrack[],
  active?: boolean
): MediaStream =>
  ({
    id,
    ...(active === undefined ? {} : {active}),
    getTracks: () => tracks
  }) as unknown as MediaStream

export const createLinkedHandlePair = () => {
  let handlersA: Parameters<PeerHandle['setHandlers']>[0] = {}
  let handlersB: Parameters<PeerHandle['setHandlers']>[0] = {}
  let deadA = false
  let deadB = false
  const sdpA = nextMockFingerprintSdp()
  const sdpB = nextMockFingerprintSdp()

  const makeEndpoint = (
    isA: boolean
  ): PeerHandle & {
    emitRemoteStream: (stream: MediaStream) => void
  } => ({
    get isDead() {
      return isA ? deadA : deadB
    },
    connection: {
      connectionState: 'connected',
      iceConnectionState: 'connected',
      signalingState: 'stable',
      localDescription: {type: 'offer', sdp: isA ? sdpA : sdpB},
      remoteDescription: {type: 'answer', sdp: isA ? sdpB : sdpA},
      getSenders: () => [],
      getTransceivers: () => []
    } as unknown as RTCPeerConnection,
    channel: {
      readyState: 'open',
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0,
      addEventListener: () => {},
      removeEventListener: () => {}
    } as unknown as RTCDataChannel,
    getOffer: async () => undefined,
    signal: async () => undefined,
    sendData: data => {
      const copy = new Uint8Array(data.byteLength)
      copy.set(
        data instanceof Uint8Array
          ? data
          : new Uint8Array(data as ArrayBufferLike)
      )
      queueMicrotask(() => {
        const target = isA ? handlersB : handlersA
        const targetDead = isA ? deadB : deadA
        if (!targetDead) {
          target.data?.(copy.buffer)
        }
      })
    },
    destroy: () => {
      if (isA) {
        if (deadA) {
          return
        }
        deadA = true
        queueMicrotask(() => {
          if (!deadB) {
            deadB = true
            handlersB.close?.()
          }
        })
      } else {
        if (deadB) {
          return
        }
        deadB = true
        queueMicrotask(() => {
          if (!deadA) {
            deadA = true
            handlersA.close?.()
          }
        })
      }
    },
    setHandlers: next => {
      if (isA) {
        handlersA = {...handlersA, ...next}
      } else {
        handlersB = {...handlersB, ...next}
      }
    },
    addStream: stream => {
      const target = isA ? handlersB : handlersA
      queueMicrotask(() => {
        target.stream?.(stream)
      })
    },
    removeStream: () => {},
    addTrack: (_track, stream) => {
      const target = isA ? handlersB : handlersA
      queueMicrotask(() => {
        target.stream?.(stream)
      })
      return {} as RTCRtpSender
    },
    removeTrack: () => {},
    replaceTrack: async () => {},
    emitRemoteStream: stream => {
      const local = isA ? handlersA : handlersB
      local.stream?.(stream)
    }
  })

  return {
    peerA: makeEndpoint(true),
    peerB: makeEndpoint(false)
  }
}

export const connectVerifiedPeers = (
  regMap: Map<string, (peer: PeerHandle, id: string) => void>,
  _roomA: Room,
  idA: string,
  _userA: UserIdentity,
  _roomB: Room,
  idB: string,
  _userB: UserIdentity
) => {
  const link = createLinkedHandlePair()
  regMap.get(idA)!(link.peerA, idB)
  regMap.get(idB)!(link.peerB, idA)
  return link
}

export const higherPeerId = (selfId: string): string => {
  for (let i = 0; i < selfId.length; i++) {
    const idx = base62Alphabet.indexOf(selfId[i]!)
    if (idx >= 0 && idx < base62Alphabet.length - 1) {
      return selfId.slice(0, i) + base62Alphabet[idx + 1]! + selfId.slice(i + 1)
    }
  }
  throw new Error(`cannot compute peerId higher than ${selfId}`)
}

export const lowerPeerId = (selfId: string): string => {
  for (let i = 0; i < selfId.length; i++) {
    const idx = base62Alphabet.indexOf(selfId[i]!)
    if (idx > 0) {
      return selfId.slice(0, i) + base62Alphabet[idx - 1]! + selfId.slice(i + 1)
    }
  }
  throw new Error(`cannot compute peerId lower than ${selfId}`)
}

export const makeTestPluginSlot = <
  TName extends 'roles' | 'scale',
  TApi extends Record<string, unknown> = Record<string, never>
>(
  kind: TName,
  setupApi: (
    kernel: InternalRoomContext,
    effectiveRoomIdP?: Promise<string>
  ) => TApi,
  options: {
    selfAsAdmin?: boolean
    provider?: Partial<KernelRolesProvider & KernelScaleProvider>
  } = {}
): RoomPlugin<TName, TApi> =>
  ({
    name: kind,
    [pluginSlotSymbol]:
      kind === 'roles'
        ? {
            kind: 'roles' as const,
            selfAsAdmin: Boolean(options.selfAsAdmin),
            setup: (
              kernel: InternalRoomContext,
              effectiveRoomIdP?: Promise<string>
            ) => ({
              provider: {
                isAuthorityResolved: () => true,
                getEffectiveRoomId: () => kernel.getRoomId(),
                getPeerRoles: () => [],
                isPeerBanned: () => false,
                getBanReason: () => undefined,
                getLocalActionCert: async () => null,
                authorizePeerAction: () => true,
                getStateWriteCert: async () => ({cert: null, roles: []}),
                verifyStateRecordRoles: async () => ({valid: true, roles: []}),
                onPeerDescriptorCert: () => {},
                getAuthorityInfo: async () => ({
                  userId: (await kernel.getLocalUserIdentity()).userId,
                  roomId: kernel.getRoomId(),
                  baseRoomId: kernel.initialRoomId,
                  isAdmin: false,
                  roles: []
                }),
                ...(options.provider as Partial<KernelRolesProvider>)
              },
              api: {
                grantRole: async () => {},
                revokeRole: async () => {},
                getRoles: () => [],
                onRoleChange: () => () => {},
                ban: async () => {},
                unban: async () => {},
                isBanned: () => false,
                ...setupApi(kernel, effectiveRoomIdP)
              } as never
            })
          }
        : {
            kind: 'scale' as const,
            setup: (kernel: InternalRoomContext) => ({
              provider: {
                isDirectPeer: () => false,
                isVirtualPeer: () => false,
                getRoute: () => undefined,
                getSnapshot: () => ({
                  peerId: kernel.selfId,
                  directPeerIds: kernel.getDirectActivePeerIds(),
                  roomPeerIds: kernel.getActivePeerIds(),
                  routes: {},
                  stats: {
                    messagesSent: 0,
                    messagesRelayed: 0,
                    messagesReceived: 0,
                    duplicatesDropped: 0,
                    signatureFailures: 0,
                    directMediaConnections: 0
                  }
                }),
                handleFrame: () => false,
                addDirectPeer: () => {},
                removeDirectPeer: () => {},
                prepareMediaPeer: async () => {
                  throw new Error('peer disconnected')
                },
                setPeerMediaPinned: () => {},
                broadcastInline: () => false,
                requireDirectPeer: () => {},
                notePeerDiscovered: () => false,
                shouldConnectPeer: () => true,
                getTargetNeighbors: () => new Set<string>(),
                setOnTargetsChanged: () => {},
                announceLeave: async () => {},
                destroy: () => {},
                getPeerUserId: () => undefined,
                setPeerSignPublicKey: () => {},
                setLocalRoleCertificate: () => {},
                markPeerBanned: () => {},
                unmarkPeerBanned: () => {},
                isPeerBanned: () => false,
                registerActionAuthority: () => {},
                ...(options.provider as Partial<KernelScaleProvider>)
              },
              api: {
                getTopology: () => ({
                  peerId: kernel.selfId,
                  directPeerIds: kernel.getDirectActivePeerIds(),
                  roomPeerIds: kernel.getActivePeerIds(),
                  routes: {},
                  stats: {
                    messagesSent: 0,
                    messagesRelayed: 0,
                    messagesReceived: 0,
                    duplicatesDropped: 0,
                    signatureFailures: 0,
                    directMediaConnections: 0
                  }
                }),
                ...setupApi(kernel)
              } as never
            })
          }
  }) as unknown as RoomPlugin<TName, TApi>
