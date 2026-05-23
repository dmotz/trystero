import assert from 'node:assert/strict'
// @ts-expect-error Internal source import crosses a referenced package boundary.
import createRoom from '../../packages/core/src/room.ts'

type PeerHandlers = Record<string, (...args: any[]) => void>
type TestMediaTrack = {id: string}
type TestMediaStream = {
  id: string
  getTracks: () => TestMediaTrack[]
}

const internalTypeByteLimit = 32
const internalNonceIndex = internalTypeByteLimit
const internalTagIndex = internalNonceIndex + 2
const internalProgressIndex = internalTagIndex + 1
const internalPayloadIndex = internalProgressIndex + 1
const encoder = new TextEncoder()

export const tick = () => new Promise(res => setTimeout(res, 0))

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

export const withTimeout = (promise, ms = 500) =>
  Promise.race([
    promise,
    wait(ms).then(() => {
      throw new Error('timed out waiting for result')
    })
  ])

export const encodeInternalAction = type => {
  const typeBytes = encoder.encode(type)
  assert.ok(typeBytes.byteLength <= internalTypeByteLimit)

  const packet = new Uint8Array(internalPayloadIndex)
  packet.set(typeBytes)
  packet[internalTagIndex] = 1
  packet[internalProgressIndex] = 0xff

  return packet.buffer
}

export class MockDataChannel {
  readyState = 'connecting'
  binaryType = 'arraybuffer'
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  onmessage = null
  onopen = null
  onclose = null
  onerror = null

  close() {
    this.readyState = 'closed'
    this.onclose?.()
  }

  send() {}
}

export class MockRTCPeerConnection {
  iceGatheringState = 'complete'
  connectionState = 'new'
  iceConnectionState = 'new'
  signalingState = 'stable'
  localDescription = null
  remoteDescription = null
  onnegotiationneeded = null
  onconnectionstatechange = null
  ontrack = null
  ondatachannel = null
  listeners = {}

  createDataChannel() {
    return new MockDataChannel()
  }

  addEventListener(event, fn) {
    ;(this.listeners[event] ??= new Set()).add(fn)
  }

  removeEventListener(event, fn) {
    this.listeners[event]?.delete(fn)
  }

  restartIce() {}

  async createOffer() {
    return {type: 'offer', sdp: `mock-offer-${Math.random()}`}
  }

  async setLocalDescription(description) {
    if (description?.type === 'rollback') {
      this.signalingState = 'stable'
      return
    }

    const nextDescription = description ?? (await this.createOffer())
    this.localDescription = nextDescription
    this.signalingState =
      nextDescription.type === 'offer' ? 'have-local-offer' : 'stable'

    this.listeners['icegatheringstatechange']?.forEach(listener => listener())
  }

  async setRemoteDescription(description) {
    this.remoteDescription = description ?? {type: 'answer', sdp: 'mock-answer'}
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

export class MockPeer {
  created = Date.now()
  isDead = false
  destroyCount = 0
  handlers: PeerHandlers = {}
  offerPromise = Promise.resolve()
  connection = {
    connectionState: 'connected',
    iceConnectionState: 'connected',
    getSenders: () => []
  }
  channel = {readyState: 'open'}

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

  setHandlers(newHandlers) {
    Object.assign(this.handlers, newHandlers)
  }

  addStream() {}
  removeStream() {}
  addTrack() {
    return {}
  }
  removeTrack() {}
  replaceTrack() {}
}

export class LinkedPeer {
  created = Date.now()
  isDead = false
  handlers: PeerHandlers = {}
  offerPromise = Promise.resolve()
  partner: LinkedPeer | null = null
  lastSentData = null
  connection = {
    connectionState: 'connected',
    iceConnectionState: 'connected',
    getSenders: () => []
  }
  channel = {
    readyState: 'open',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0
  }

  async getOffer() {}

  async signal() {}

  sendData(data) {
    this.lastSentData = data.slice().buffer
    this.partner?.handlers.data?.(data.slice().buffer)
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

  setHandlers(newHandlers) {
    Object.assign(this.handlers, newHandlers)
  }

  addStream(_stream?: TestMediaStream) {}
  removeStream() {}
  addTrack(_track?: TestMediaTrack, _stream?: TestMediaStream) {
    return {}
  }
  removeTrack() {}
  replaceTrack() {}
}

export class LinkedMediaPeer extends LinkedPeer {
  addStreamCalls = 0
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

  addStream(stream: TestMediaStream) {
    this.addStreamCalls += 1

    stream.getTracks().forEach(track => {
      const remote = (
        this.partner as LinkedMediaPeer | null
      )?.ensureRemoteTrack(track, stream)

      if (remote?.isNew) {
        this.partner?.handlers.track?.(remote.track, remote.stream)
      }
    })
  }

  addTrack(track: TestMediaTrack, stream: TestMediaStream) {
    const remote = (this.partner as LinkedMediaPeer | null)?.ensureRemoteTrack(
      track,
      stream
    )

    if (remote?.isNew) {
      this.partner?.handlers.track?.(remote.track, remote.stream)
    }

    return {}
  }
}

export const linkPeers = <A extends LinkedPeer, B extends LinkedPeer>(
  peerA: A,
  peerB: B
): {peerA: A; peerB: B} => {
  peerA.partner = peerB
  peerB.partner = peerA

  return {peerA, peerB}
}

export const createJoinedRooms = async () => {
  let registerPeerA = null
  let registerPeerB = null
  const roomA = createRoom(
    f => {
      registerPeerA = f
    },
    () => {},
    () => {}
  )
  const roomB = createRoom(
    f => {
      registerPeerB = f
    },
    () => {},
    () => {}
  )
  const joinA = new Promise(resolve => (roomA.onPeerJoin = resolve))
  const joinB = new Promise(resolve => (roomB.onPeerJoin = resolve))
  const {peerA, peerB} = linkPeers(new LinkedPeer(), new LinkedPeer())

  assert.ok(registerPeerA, 'expected first room to register its peer callback')
  assert.ok(registerPeerB, 'expected second room to register its peer callback')
  registerPeerA(peerA, 'peer-b')
  registerPeerB(peerB, 'peer-a')

  await Promise.all([joinA, joinB])

  return {roomA, roomB, peerA, peerB}
}
