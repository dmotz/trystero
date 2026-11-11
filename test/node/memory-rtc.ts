import {
  createTopicStrategy,
  type JoinRoomConfig,
  type StrategyMessage
} from '../../packages/core/src/index.ts'
import {joinAsTestPeer} from './peer-harness.ts'

export class LinkedDataChannel {
  label: string
  ordered = true
  readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting'
  binaryType = 'arraybuffer'
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  onmessage: ((ev: {data: ArrayBuffer | string}) => void) | null = null
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  partner: LinkedDataChannel | null = null
  listeners: Record<string, Set<(...args: unknown[]) => void>> = {}
  onSendHook: ((payload: ArrayBuffer | string) => void) | null = null

  constructor(label = 'trystero') {
    this.label = label
  }

  addEventListener(event: string, fn: (...args: unknown[]) => void) {
    ;(this.listeners[event] ??= new Set()).add(fn)
  }

  removeEventListener(event: string, fn: (...args: unknown[]) => void) {
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
          : (data.buffer.slice(
              data.byteOffset,
              data.byteOffset + data.byteLength
            ) as ArrayBuffer)

    this.onSendHook?.(payload)

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

export type MemoryRtcConnectionInstance = {
  iceGatheringState: string
  connectionState: string
  iceConnectionState: string
  signalingState: string
  localDescription: {type: string; sdp: string} | null
  remoteDescription: {type: string; sdp: string} | null
  onnegotiationneeded: (() => void) | null
  onconnectionstatechange: (() => void) | null
  ontrack: ((ev: unknown) => void) | null
  ondatachannel: ((ev: {channel: LinkedDataChannel}) => void) | null
  listeners: Record<string, Set<(...args: unknown[]) => void>>
  dataChannel: LinkedDataChannel | null
  matchedOfferPc: MemoryRtcConnectionInstance | null
  partnerPc: MemoryRtcConnectionInstance | null
  dtlsFingerprint: string
  overrideRemoteDtlsFingerprint: string | null
  createDataChannel: (label: string) => LinkedDataChannel
  addEventListener: (event: string, fn: (...args: unknown[]) => void) => void
  removeEventListener: (event: string, fn: (...args: unknown[]) => void) => void
  restartIce: () => void
  createOffer: () => Promise<{type: string; sdp: string}>
  createAnswer: () => Promise<{type: string; sdp: string}>
  setLocalDescription: (description?: {
    type: string
    sdp?: string
  }) => Promise<void>
  setRemoteDescription: (description: {
    type: string
    sdp: string
  }) => Promise<void>
  close: () => void
  getSenders: () => never[]
  addTrack: () => Record<string, never>
  removeTrack: () => void
}

export type MemoryRtcConstructor = {
  new (): MemoryRtcConnectionInstance
}

let globalRealmCounter = 0

export const createMemoryRtcRealm = () => {
  const realmId = (++globalRealmCounter & 0xff)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase()
  const offerMap = new Map<string, InMemoryRTCPeerConnection>()
  const answerMap = new Map<
    string,
    {offerPc: InMemoryRTCPeerConnection; answerPc: InMemoryRTCPeerConnection}
  >()
  let sdpCounter = 0
  let channelSendObserver: ((payload: ArrayBuffer | string) => void) | null =
    null

  class InMemoryRTCPeerConnection implements MemoryRtcConnectionInstance {
    iceGatheringState = 'complete'
    connectionState = 'new'
    iceConnectionState = 'new'
    signalingState = 'stable'
    localDescription: {type: string; sdp: string} | null = null
    remoteDescription: {type: string; sdp: string} | null = null
    onnegotiationneeded: (() => void) | null = null
    onconnectionstatechange: (() => void) | null = null
    ontrack: ((ev: unknown) => void) | null = null
    ondatachannel: ((ev: {channel: LinkedDataChannel}) => void) | null = null
    listeners: Record<string, Set<(...args: unknown[]) => void>> = {}
    dataChannel: LinkedDataChannel | null = null
    matchedOfferPc: InMemoryRTCPeerConnection | null = null
    partnerPc: InMemoryRTCPeerConnection | null = null
    dtlsFingerprint = (() => {
      const n = ++sdpCounter
      const b0 = ((n >>> 8) & 0xff).toString(16).padStart(2, '0').toUpperCase()
      const b1 = (n & 0xff).toString(16).padStart(2, '0').toUpperCase()
      return `sha-256 AA:BB:CC:${realmId}:${b0}:${b1}`
    })()
    overrideRemoteDtlsFingerprint: string | null = null

    createDataChannel(label: string) {
      const ch = new LinkedDataChannel(label)
      ch.onSendHook = payload => channelSendObserver?.(payload)
      this.dataChannel = ch
      return ch
    }

    addEventListener(event: string, fn: (...args: unknown[]) => void) {
      ;(this.listeners[event] ??= new Set()).add(fn)
    }

    removeEventListener(event: string, fn: (...args: unknown[]) => void) {
      this.listeners[event]?.delete(fn)
    }

    restartIce() {}

    async createOffer() {
      const sdp = `v=0\r\na=fingerprint:${this.dtlsFingerprint}\r\na=mid:${++sdpCounter}\r\n`
      offerMap.set(sdp, this)
      return {type: 'offer', sdp}
    }

    async createAnswer() {
      const sdp = `v=0\r\na=fingerprint:${this.dtlsFingerprint}\r\na=mid:${++sdpCounter}\r\n`
      if (this.matchedOfferPc) {
        answerMap.set(sdp, {offerPc: this.matchedOfferPc, answerPc: this})
      }
      return {type: 'answer', sdp}
    }

    async setLocalDescription(description?: {type: string; sdp?: string}) {
      if (description?.type === 'rollback') {
        this.signalingState = 'stable'
        return
      }
      const next =
        description && description.sdp !== undefined
          ? {type: description.type, sdp: description.sdp}
          : this.remoteDescription?.type === 'offer'
            ? await this.createAnswer()
            : await this.createOffer()
      this.localDescription = next
      this.signalingState =
        next.type === 'offer' ? 'have-local-offer' : 'stable'
      this.listeners['icegatheringstatechange']?.forEach(fn => fn())
    }

    async setRemoteDescription(description: {type: string; sdp: string}) {
      this.remoteDescription = this.overrideRemoteDtlsFingerprint
        ? {
            type: description.type,
            sdp: `v=0\r\na=fingerprint:${this.overrideRemoteDtlsFingerprint}\r\n`
          }
        : description
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
        offerCh.onSendHook = payload => channelSendObserver?.(payload)
        const answerCh = new LinkedDataChannel(offerCh.label)
        answerCh.onSendHook = payload => channelSendObserver?.(payload)
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

    getSenders(): never[] {
      return []
    }

    addTrack(): Record<string, never> {
      return {}
    }

    removeTrack() {}
  }

  const rtcPolyfill =
    InMemoryRTCPeerConnection as unknown as typeof RTCPeerConnection

  const setSendObserver = (
    observer: ((payload: ArrayBuffer | string) => void) | null
  ): void => {
    channelSendObserver = observer
  }

  const clear = (): void => {
    offerMap.clear()
    answerMap.clear()
    channelSendObserver = null
  }

  return {
    InMemoryRTCPeerConnection,
    rtcPolyfill,
    setSendObserver,
    clear
  }
}

export type MemorySignalBusOptions = {
  delivery?: 'timeout' | 'microtask'
  steadyAnnounceIntervalMs?: number
}

export const createMemorySignalBus = <
  TConfig extends JoinRoomConfig = JoinRoomConfig
>(
  options?: MemorySignalBusOptions
) => {
  const realm = createMemoryRtcRealm()
  const delivery = options?.delivery ?? 'timeout'
  const steadyAnnounceIntervalMs = options?.steadyAnnounceIntervalMs ?? 120
  const topicHandlers = new Map<
    string,
    Set<(topic: string, data: StrategyMessage) => void>
  >()

  const makeJoinRoom = (peerSeed?: string) => {
    const join = createTopicStrategy<Record<string, never>, TConfig>({
      steadyAnnounceIntervalMs,
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
        if (delivery === 'microtask') {
          for (const handler of handlers) {
            queueMicrotask(() => handler(topic, message))
          }
          return
        }
        for (const handler of handlers) {
          setTimeout(() => {
            if (topicHandlers.get(topic)?.has(handler)) {
              handler(topic, message)
            }
          }, 1)
        }
      }
    })
    return peerSeed ? joinAsTestPeer(peerSeed, join) : join
  }

  return {
    makeJoinRoom,
    InMemoryRTCPeerConnection: realm.InMemoryRTCPeerConnection,
    rtcPolyfill: realm.rtcPolyfill,
    setSendObserver: realm.setSendObserver,
    clearRtcRealm: realm.clear
  }
}
