import assert from 'node:assert/strict'
import test from './test.ts'
import {createTopicStrategy, scale} from '../../packages/core/src/index.ts'
import {wait, waitFor} from './peer-harness.ts'

class LinkedDataChannel {
  label: string
  ordered = true
  readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting'
  binaryType = 'arraybuffer'
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  onmessage: ((ev: {data: any}) => void) | null = null
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((ev: any) => void) | null = null
  partner: LinkedDataChannel | null = null
  listeners: Record<string, Set<(...args: any[]) => void>> = {}

  constructor(label = 'trystero') {
    this.label = label
  }

  addEventListener(event: string, fn: (...args: any[]) => void) {
    ;(this.listeners[event] ??= new Set()).add(fn)
  }

  removeEventListener(event: string, fn: (...args: any[]) => void) {
    this.listeners[event]?.delete(fn)
  }

  send(data: Uint8Array | ArrayBuffer | string) {
    if (this.readyState !== 'open' || !this.partner) {
      return
    }
    const partner = this.partner
    const payload =
      typeof data === 'string'
        ? data
        : data instanceof ArrayBuffer
          ? data.slice(0)
          : data.buffer.slice(
              data.byteOffset,
              data.byteOffset + data.byteLength
            )

    queueMicrotask(() => {
      if (partner.readyState === 'open') {
        partner.onmessage?.({data: payload})
        partner.listeners['message']?.forEach(fn => fn({data: payload}))
      }
    })
  }

  close() {
    if (this.readyState === 'closed') {
      return
    }
    this.readyState = 'closed'
    this.onclose?.()
    this.listeners['close']?.forEach(fn => fn())
    const partner = this.partner
    this.partner = null
    if (partner && partner.readyState !== 'closed') {
      queueMicrotask(() => partner.close())
    }
  }
}

const offerMap = new Map<string, InMemoryRTCPeerConnection>()
const answerMap = new Map<
  string,
  {offerPc: InMemoryRTCPeerConnection; answerPc: InMemoryRTCPeerConnection}
>()
let sdpCounter = 0

class InMemoryRTCPeerConnection {
  iceGatheringState = 'complete'
  connectionState = 'new'
  iceConnectionState = 'new'
  signalingState = 'stable'
  localDescription: {type: string; sdp: string} | null = null
  remoteDescription: {type: string; sdp: string} | null = null
  onnegotiationneeded: (() => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  ontrack: ((ev: any) => void) | null = null
  ondatachannel: ((ev: {channel: LinkedDataChannel}) => void) | null = null
  listeners: Record<string, Set<(...args: any[]) => void>> = {}
  dataChannel: LinkedDataChannel | null = null
  matchedOfferPc: InMemoryRTCPeerConnection | null = null
  partnerPc: InMemoryRTCPeerConnection | null = null

  createDataChannel(label: string) {
    const ch = new LinkedDataChannel(label)
    this.dataChannel = ch
    return ch
  }

  addEventListener(event: string, fn: (...args: any[]) => void) {
    ;(this.listeners[event] ??= new Set()).add(fn)
  }

  removeEventListener(event: string, fn: (...args: any[]) => void) {
    this.listeners[event]?.delete(fn)
  }

  restartIce() {}

  async createOffer() {
    const sdp = `inmem-offer-${++sdpCounter}-${Math.random().toString(36).slice(2)}`
    offerMap.set(sdp, this)
    return {type: 'offer', sdp}
  }

  async createAnswer() {
    const sdp = `inmem-answer-${++sdpCounter}-${Math.random().toString(36).slice(2)}`
    if (this.matchedOfferPc) {
      answerMap.set(sdp, {offerPc: this.matchedOfferPc, answerPc: this})
    }
    return {type: 'answer', sdp}
  }

  async setLocalDescription(description?: {type: string; sdp: string}) {
    if (description?.type === 'rollback') {
      this.signalingState = 'stable'
      return
    }
    const next =
      description ??
      (this.remoteDescription?.type === 'offer'
        ? await this.createAnswer()
        : await this.createOffer())
    this.localDescription = next
    this.signalingState = next.type === 'offer' ? 'have-local-offer' : 'stable'
    this.listeners['icegatheringstatechange']?.forEach(fn => fn())
  }

  async setRemoteDescription(description: {type: string; sdp: string}) {
    this.remoteDescription = description
    if (description.type === 'offer') {
      this.matchedOfferPc = offerMap.get(description.sdp) ?? null
      this.signalingState = 'have-remote-offer'
      return
    }
    if (description.type === 'answer') {
      this.signalingState = 'stable'
      const match = answerMap.get(description.sdp)
      if (!match || match.offerPc !== this) {
        return
      }
      const {answerPc} = match
      if (
        this.connectionState === 'closed' ||
        answerPc.connectionState === 'closed'
      ) {
        return
      }
      this.partnerPc = answerPc
      answerPc.partnerPc = this
      const offerCh = this.dataChannel ?? new LinkedDataChannel('trystero')
      const answerCh = new LinkedDataChannel(offerCh.label)
      offerCh.partner = answerCh
      answerCh.partner = offerCh
      answerPc.dataChannel = answerCh

      queueMicrotask(() => {
        if (
          this.connectionState === 'closed' ||
          answerPc.connectionState === 'closed'
        ) {
          return
        }
        this.connectionState = 'connected'
        this.iceConnectionState = 'connected'
        answerPc.connectionState = 'connected'
        answerPc.iceConnectionState = 'connected'
        this.onconnectionstatechange?.()
        answerPc.onconnectionstatechange?.()

        answerPc.ondatachannel?.({channel: answerCh})
        offerCh.readyState = 'open'
        answerCh.readyState = 'open'
        offerCh.onopen?.()
        answerCh.onopen?.()
      })
    }
  }

  close() {
    if (this.connectionState === 'closed') {
      return
    }
    this.connectionState = 'closed'
    this.iceConnectionState = 'closed'
    this.dataChannel?.close()
    this.onconnectionstatechange?.()
    const partner = this.partnerPc
    this.partnerPc = null
    if (partner && partner.connectionState !== 'closed') {
      queueMicrotask(() => partner.close())
    }
  }

  getSenders() {
    return []
  }

  addTrack() {
    return {}
  }

  removeTrack() {}
}

const createMemorySignalBus = () => {
  const topicHandlers = new Map<
    string,
    Set<(topic: string, data: any) => void>
  >()

  const makeJoinRoom = () =>
    createTopicStrategy({
      steadyAnnounceIntervalMs: 120,
      init: () => ({}),
      subscribeTopic: (_relay, topic, onTopicMessage) => {
        let set = topicHandlers.get(topic)
        if (!set) {
          set = new Set()
          topicHandlers.set(topic, set)
        }
        set.add(onTopicMessage)
        return () => {
          set?.delete(onTopicMessage)
        }
      },
      publishTopic: (_relay, topic, message) => {
        const handlers = topicHandlers.get(topic)
        if (!handlers) {
          return
        }
        for (const handler of handlers) {
          queueMicrotask(() => handler(topic, message))
        }
      }
    })

  return {makeJoinRoom}
}

void test('Trystero: validates config.limit as a positive safe integer', () => {
  const {makeJoinRoom} = createMemorySignalBus()
  const joinRoom = makeJoinRoom()

  for (const invalidLimit of [0, -1, -100, 1.5, NaN, Infinity, -Infinity]) {
    assert.throws(
      () =>
        joinRoom(
          {
            appId: 'limit-validation-app',
            limit: invalidLimit,
            rtcPolyfill: InMemoryRTCPeerConnection as any
          },
          'room-1'
        ),
      /Trystero: limit must be a positive safe integer/
    )
  }
})

void test(
  'Trystero: limit: 1 allows a solo occupant, rejects subsequent joiners with "room full", and allows join after occupant leaves',
  {timeout: 10_000},
  async () => {
    const {makeJoinRoom} = createMemorySignalBus()
    const appId = `limit-1-${Date.now()}`
    const roomId = 'solo-room'

    const hostJoin = makeJoinRoom()
    const hostErrors: any[] = []
    const hostJoins: string[] = []
    const hostLeaves: string[] = []

    const hostRoom = hostJoin(
      {
        appId,
        _test_only_forcedPeerId: 'peer-host',
        limit: 1,
        rtcPolyfill: InMemoryRTCPeerConnection as any
      },
      roomId,
      {
        onJoinError: err => hostErrors.push(err)
      }
    )
    hostRoom.onPeerJoin = ({peerId}) => hostJoins.push(peerId)
    hostRoom.onPeerLeave = ({peerId}) => hostLeaves.push(peerId)

    await wait(60)

    const lateJoin = makeJoinRoom()
    const lateErrors: any[] = []
    const lateJoins: string[] = []

    let lateRoom: any
    let nextRoom: any
    try {
      lateRoom = lateJoin(
        {
          appId,
          _test_only_forcedPeerId: 'peer-late',
          limit: 1,
          rtcPolyfill: InMemoryRTCPeerConnection as any
        },
        roomId,
        {
          onJoinError: err => lateErrors.push(err)
        }
      )
      lateRoom.onPeerJoin = ({peerId}) => lateJoins.push(peerId)

      await waitFor(() => lateErrors.length > 0, 3_000)
      await wait(120)

      assert.equal(
        lateErrors.length,
        1,
        'rejected joiner should receive onJoinError once'
      )
      assert.equal(lateErrors[0].error, 'room full')
      assert.equal(lateErrors[0].appId, appId)
      assert.equal(lateErrors[0].roomId, roomId)
      assert.equal(lateErrors[0].peerId, 'peer-host')
      assert.deepEqual(lateJoins, [])
      assert.deepEqual(hostErrors, [], 'host must not receive onJoinError')
      assert.deepEqual(
        hostJoins,
        [],
        'host must not receive onPeerJoin for rejected peer'
      )
      assert.deepEqual(
        hostLeaves,
        [],
        'host must not receive onPeerLeave for rejected peer'
      )

      // Host leaves and rejected joiner cleans up; now a new peer can join the limit: 1 room
      await lateRoom.leave()
      await hostRoom.leave()
      await wait(50)

      const nextJoin = makeJoinRoom()
      const nextErrors: any[] = []
      nextRoom = nextJoin(
        {
          appId,
          _test_only_forcedPeerId: 'peer-next',
          limit: 1,
          rtcPolyfill: InMemoryRTCPeerConnection as any
        },
        roomId,
        {
          onJoinError: err => nextErrors.push(err)
        }
      )

      await wait(150)
      assert.deepEqual(nextErrors, [])
    } finally {
      await Promise.all([
        hostRoom?.leave().catch(() => {}),
        nextRoom?.leave().catch(() => {}),
        lateRoom?.leave().catch(() => {})
      ])
    }
  }
)

void test(
  'Trystero: limit: 2 admits 2 peers, rejects a 3rd with "room full", and admits a 4th after one peer leaves',
  {timeout: 10_000},
  async () => {
    const {makeJoinRoom} = createMemorySignalBus()
    const appId = `limit-2-seq-${Date.now()}`
    const roomId = 'duel-room'

    const joinA = makeJoinRoom()
    const joinB = makeJoinRoom()
    const joinC = makeJoinRoom()
    const joinD = makeJoinRoom()

    const errorsA: any[] = []
    const errorsB: any[] = []
    const errorsC: any[] = []
    const errorsD: any[] = []

    const joinsA: string[] = []
    const leavesA: string[] = []
    const joinsB: string[] = []
    const leavesB: string[] = []
    const joinsC: string[] = []
    const joinsD: string[] = []

    const roomA = joinA(
      {
        appId,
        _test_only_forcedPeerId: 'peer-a',
        limit: 2,
        rtcPolyfill: InMemoryRTCPeerConnection as any
      },
      roomId,
      {onJoinError: err => errorsA.push(err)}
    )
    roomA.onPeerJoin = ({peerId}) => joinsA.push(peerId)
    roomA.onPeerLeave = ({peerId}) => leavesA.push(peerId)

    const roomB = joinB(
      {
        appId,
        _test_only_forcedPeerId: 'peer-b',
        limit: 2,
        rtcPolyfill: InMemoryRTCPeerConnection as any
      },
      roomId,
      {onJoinError: err => errorsB.push(err)}
    )
    roomB.onPeerJoin = ({peerId}) => joinsB.push(peerId)
    roomB.onPeerLeave = ({peerId}) => leavesB.push(peerId)

    await waitFor(
      () => joinsA.includes('peer-b') && joinsB.includes('peer-a'),
      3_000
    )

    // Peer C attempts to join when room is already at capacity (2/2)
    const roomC = joinC(
      {
        appId,
        _test_only_forcedPeerId: 'peer-c',
        limit: 2,
        rtcPolyfill: InMemoryRTCPeerConnection as any
      },
      roomId,
      {onJoinError: err => errorsC.push(err)}
    )
    roomC.onPeerJoin = ({peerId}) => joinsC.push(peerId)

    await waitFor(() => errorsC.length > 0, 3_000)
    await wait(120)

    assert.equal(
      errorsC.length,
      1,
      'Peer C must receive onJoinError exactly once'
    )
    assert.equal(errorsC[0].error, 'room full')
    assert.equal(errorsC[0].appId, appId)
    assert.equal(errorsC[0].roomId, roomId)
    assert.ok(
      errorsC[0].peerId === 'peer-a' || errorsC[0].peerId === 'peer-b',
      'rejecting peerId should be one of the existing members'
    )
    assert.deepEqual(joinsC, [], 'Peer C must not activate any peers')
    assert.deepEqual(errorsA, [], 'Peer A must not receive onJoinError')
    assert.deepEqual(errorsB, [], 'Peer B must not receive onJoinError')
    assert.deepEqual(
      joinsA,
      ['peer-b'],
      'Peer A must not fire onPeerJoin for C'
    )
    assert.deepEqual(
      joinsB,
      ['peer-a'],
      'Peer B must not fire onPeerJoin for C'
    )
    assert.deepEqual(leavesA, [], 'Peer A must not fire onPeerLeave for C')
    assert.deepEqual(leavesB, [], 'Peer B must not fire onPeerLeave for C')

    // Rejected Peer C cleans up and Peer B leaves, freeing 1 seat (1/2)
    await roomC.leave()
    await roomB.leave()
    await waitFor(() => leavesA.includes('peer-b'), 2_000)

    // Peer D joins and should be admitted into the newly opened seat!
    const roomD = joinD(
      {
        appId,
        _test_only_forcedPeerId: 'peer-d',
        limit: 2,
        rtcPolyfill: InMemoryRTCPeerConnection as any
      },
      roomId,
      {onJoinError: err => errorsD.push(err)}
    )
    roomD.onPeerJoin = ({peerId}) => joinsD.push(peerId)

    try {
      await waitFor(
        () => joinsA.includes('peer-d') && joinsD.includes('peer-a'),
        3_000
      )
      assert.deepEqual(errorsD, [])
      assert.deepEqual(Object.keys(roomA.getPeers()), ['peer-d'])
      assert.deepEqual(Object.keys(roomD.getPeers()), ['peer-a'])
    } finally {
      await Promise.all([
        roomA.leave().catch(() => {}),
        roomC.leave().catch(() => {}),
        roomD.leave().catch(() => {})
      ])
    }
  }
)

void test(
  'Trystero: simultaneous burst join with 5 peers on a limit: 2 room admits exactly 2 and rejects 3 with "room full"',
  {timeout: 10_000},
  async () => {
    const {makeJoinRoom} = createMemorySignalBus()
    const appId = `limit-burst-${Date.now()}`
    const roomId = 'burst-room'
    const peerIds = ['peer-1', 'peer-2', 'peer-3', 'peer-4', 'peer-5']

    const stateByPeer = new Map<
      string,
      {
        room: any
        errors: any[]
        joins: string[]
        leaves: string[]
      }
    >()

    // Launch all 5 peers concurrently in the same tick
    for (const peerId of peerIds) {
      const joinRoom = makeJoinRoom()
      const errors: any[] = []
      const joins: string[] = []
      const leaves: string[] = []
      const room = joinRoom(
        {
          appId,
          _test_only_forcedPeerId: peerId,
          limit: 2,
          rtcPolyfill: InMemoryRTCPeerConnection as any
        },
        roomId,
        {onJoinError: err => errors.push(err)}
      )
      room.onPeerJoin = ({peerId}) => joins.push(peerId)
      room.onPeerLeave = ({peerId}) => leaves.push(peerId)
      stateByPeer.set(peerId, {room, errors, joins, leaves})
    }

    try {
      await waitFor(() => {
        const rejectedCount = [...stateByPeer.values()].filter(
          s => s.errors.length > 0
        ).length
        const admittedCount = [...stateByPeer.values()].filter(
          s =>
            s.errors.length === 0 && Object.keys(s.room.getPeers()).length === 1
        ).length
        return rejectedCount === 3 && admittedCount === 2
      }, 4_000)

      await wait(120)

      const winners = peerIds.filter(
        id => stateByPeer.get(id)!.errors.length === 0
      )
      const losers = peerIds.filter(
        id => stateByPeer.get(id)!.errors.length > 0
      )

      assert.equal(winners.length, 2, 'expected exactly 2 winners')
      assert.equal(losers.length, 3, 'expected exactly 3 losers')

      const [w1, w2] = winners
      assert.deepEqual(
        Object.keys(stateByPeer.get(w1!)!.room.getPeers()),
        [w2],
        'winner 1 should only be connected to winner 2'
      )
      assert.deepEqual(
        Object.keys(stateByPeer.get(w2!)!.room.getPeers()),
        [w1],
        'winner 2 should only be connected to winner 1'
      )
      assert.deepEqual(stateByPeer.get(w1!)!.joins, [w2])
      assert.deepEqual(stateByPeer.get(w2!)!.joins, [w1])
      assert.deepEqual(stateByPeer.get(w1!)!.leaves, [])
      assert.deepEqual(stateByPeer.get(w2!)!.leaves, [])

      for (const loserId of losers) {
        const loser = stateByPeer.get(loserId)!
        assert.equal(
          loser.errors.length,
          1,
          `loser ${loserId} should receive onJoinError once`
        )
        assert.equal(loser.errors[0].error, 'room full')
        assert.deepEqual(
          loser.joins,
          [],
          `loser ${loserId} must not fire onPeerJoin`
        )
      }
    } finally {
      await Promise.all(
        [...stateByPeer.values()].map(({room}) => room.leave().catch(() => {}))
      )
    }
  }
)

void test(
  'Trystero: per-link rejection semantics: one peer claiming room full does not force newcomer to leave or propagate unauthenticated limit',
  {timeout: 10_000},
  async () => {
    const {makeJoinRoom} = createMemorySignalBus()
    const appId = `limit-asym-${Date.now()}`
    const roomId = 'asym-room'

    const hostRoom = makeJoinRoom()(
      {
        appId,
        _test_only_forcedPeerId: 'host-peer',
        limit: 2,
        rtcPolyfill: InMemoryRTCPeerConnection as any
      },
      roomId
    )
    const guest1Joins: string[] = []
    const guest1Room = makeJoinRoom()(
      {
        appId,
        _test_only_forcedPeerId: 'guest-1',
        // guest-1 omits limit and must not adopt unauthenticated limit from host-peer
        rtcPolyfill: InMemoryRTCPeerConnection as any
      },
      roomId
    )
    guest1Room.onPeerJoin = ({peerId}) => guest1Joins.push(peerId)

    await waitFor(
      () =>
        guest1Joins.includes('host-peer') &&
        Object.keys(hostRoom.getPeers()).includes('guest-1'),
      3_000
    )

    const guest2Errors: any[] = []
    const guest2Room = makeJoinRoom()(
      {
        appId,
        _test_only_forcedPeerId: 'guest-2',
        // guest-2 also omits limit and must not self-evict when host-peer rejects
        rtcPolyfill: InMemoryRTCPeerConnection as any
      },
      roomId,
      {onJoinError: err => guest2Errors.push(err)}
    )

    try {
      await waitFor(
        () =>
          guest2Errors.some(e => e.peerId === 'host-peer') &&
          guest1Joins.includes('guest-2') &&
          Object.keys(guest2Room.getPeers()).includes('guest-1'),
        3_000
      )
      assert.equal(guest2Errors[0].error, 'room full')
      assert.equal(guest2Errors[0].peerId, 'host-peer')
      assert.deepEqual(Object.keys(hostRoom.getPeers()), ['guest-1'])
      assert.ok(Object.keys(guest1Room.getPeers()).includes('guest-2'))
      assert.ok(Object.keys(guest2Room.getPeers()).includes('guest-1'))
    } finally {
      await Promise.all([
        hostRoom.leave().catch(() => {}),
        guest1Room.leave().catch(() => {}),
        guest2Room.leave().catch(() => {})
      ])
    }
  }
)

void test(
  'Trystero: limit with password checks password before capacity',
  {timeout: 10_000},
  async () => {
    const {makeJoinRoom} = createMemorySignalBus()
    const appId = `limit-pw-hs-${Date.now()}`
    const roomId = 'secure-duel'

    const roomA = makeJoinRoom()(
      {
        appId,
        _test_only_forcedPeerId: 'peer-a',
        password: 'correct-password',
        limit: 2,
        rtcPolyfill: InMemoryRTCPeerConnection as any
      },
      roomId
    )

    const roomB = makeJoinRoom()(
      {
        appId,
        _test_only_forcedPeerId: 'peer-b',
        password: 'correct-password',
        limit: 2,
        rtcPolyfill: InMemoryRTCPeerConnection as any
      },
      roomId
    )

    await waitFor(
      () =>
        Object.keys(roomA.getPeers()).includes('peer-b') &&
        Object.keys(roomB.getPeers()).includes('peer-a'),
      3_000
    )

    // 1. Peer with WRONG password must NOT receive 'room full' (must fail with password error)
    const wrongPwErrors: any[] = []
    const wrongPwRoom = makeJoinRoom()(
      {
        appId,
        _test_only_forcedPeerId: 'peer-wrong-pw',
        password: 'wrong-password',
        limit: 2,
        rtcPolyfill: InMemoryRTCPeerConnection as any
      },
      roomId,
      {onJoinError: err => wrongPwErrors.push(err)}
    )

    await waitFor(() => wrongPwErrors.length > 0, 3_000)
    assert.ok(
      wrongPwErrors.every(e => e.error !== 'room full'),
      'wrong-password peer must not learn that the room is full'
    )
    await wrongPwRoom.leave().catch(() => {})

    // 2. Peer with CORRECT password when room is full receives 'room full'
    const fullErrors: any[] = []
    const rightPwFullRoom = makeJoinRoom()(
      {
        appId,
        _test_only_forcedPeerId: 'peer-c',
        password: 'correct-password',
        limit: 2,
        rtcPolyfill: InMemoryRTCPeerConnection as any
      },
      roomId,
      {
        onJoinError: err => fullErrors.push(err)
      }
    )

    try {
      await waitFor(() => fullErrors.length > 0, 3_000)
      assert.equal(fullErrors.length, 1)
      assert.equal(fullErrors[0].error, 'room full')
    } finally {
      await Promise.all([
        roomA.leave().catch(() => {}),
        roomB.leave().catch(() => {}),
        rightPwFullRoom.leave().catch(() => {})
      ])
    }
  }
)

void test(
  'Trystero: enforces limit across multi-hop overlay topologies',
  {timeout: 10_000},
  async () => {
    const {makeJoinRoom} = createMemorySignalBus()
    const appId = `limit-overlay-${Date.now()}`
    const roomId = 'tree-room'
    const scaleConfig = {mode: 'gossip' as const, maxConnections: 2}

    const peerIds = ['node-1', 'node-2', 'node-3', 'node-4']
    const rooms: any[] = []

    for (const peerId of peerIds) {
      const room = makeJoinRoom()(
        {
          appId,
          _test_only_forcedPeerId: peerId,
          limit: 4,
          use: [scale(scaleConfig)],
          rtcPolyfill: InMemoryRTCPeerConnection as any
        },
        roomId
      )
      rooms.push(room)
    }

    await waitFor(
      () => rooms.every(r => Object.keys(r.getPeers()).length === 3),
      4_000
    )

    // 5th peer tries to join the 4-peer multi-hop tree room
    const fifthErrors: any[] = []
    const fifthRoom = makeJoinRoom()(
      {
        appId,
        _test_only_forcedPeerId: 'node-5',
        limit: 4,
        use: [scale(scaleConfig)],
        rtcPolyfill: InMemoryRTCPeerConnection as any
      },
      roomId,
      {onJoinError: err => fifthErrors.push(err)}
    )

    try {
      await waitFor(() => fifthErrors.length > 0, 3_000)
      assert.equal(fifthErrors.length, 1)
      assert.equal(fifthErrors[0].error, 'room full')
      for (const r of rooms) {
        assert.equal(Object.keys(r.getPeers()).length, 3)
      }
    } finally {
      await Promise.all([
        ...rooms.map(r => r.leave().catch(() => {})),
        fifthRoom.leave().catch(() => {})
      ])
    }
  }
)
