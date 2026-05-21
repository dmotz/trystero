import {
  Context,
  Data,
  Duration,
  Effect,
  pipe,
  Queue,
  Result,
  Stream,
  Types
} from 'effect'
import type {Scope} from 'effect/Scope'

export type PeerConnectionConfig = globalThis.RTCConfiguration

export class IceCandidateError extends Data.TaggedError(
  'IceCandidateConnectionError'
)<RTCPeerConnectionIceErrorEvent> {}

export class RtcPeerConnectionError extends Data.TaggedError(
  'RtcPeerConnectionOperationError'
)<{
  readonly operation: string
  readonly cause: unknown
}> {}

// https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection#events
type PeerConnectionEventMap = {
  connectionstatechange: Event
  datachannel: RTCDataChannelEvent
  icecandidate: RTCPeerConnectionIceEvent
  icecandidateerror: RTCPeerConnectionIceErrorEvent
  iceconnectionstatechange: Event
  icegatheringstatechange: Event
  negotiationneeded: Event
  signalingstatechange: Event
  track: RTCTrackEvent
  removestream: {stream: MediaStream} // todo remove
}
export type RtcPeerConnectionEvent = Data.TaggedEnum<PeerConnectionEventMap>
const makeTaggedEvent = Data.taggedEnum<RtcPeerConnectionEvent>()

const toRtcPeerConnectionEvent = <T extends Types.Tags<RtcPeerConnectionEvent>>(
  eventName: T,
  event: PeerConnectionEventMap[T]
) =>
  makeTaggedEvent[eventName](event as any) as Types.ExtractTag<
    RtcPeerConnectionEvent,
    T
  >

export const makeStreamFromEventListeners = <
  const Events extends ReadonlyArray<Types.Tags<RtcPeerConnectionEvent>>
>(
  peerConnection: RtcPeerConnection,
  events: Events
) =>
  Stream.callback<Types.ExtractTag<RtcPeerConnectionEvent, Events[number]>>(
    Effect.fnUntraced(function* (queue) {
      const {addListener, removeListener} = yield* peerConnection.useUnsafe(
        pc =>
          Effect.succeed({
            addListener: pc.addEventListener.bind(pc),
            removeListener: pc.removeEventListener.bind(pc)
          })
      )
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          events.map(eventName => {
            const dispatcher = (
              event: PeerConnectionEventMap[typeof eventName]
            ) =>
              Queue.offerUnsafe(
                queue,
                toRtcPeerConnectionEvent(eventName, event) as Types.ExtractTag<
                  RtcPeerConnectionEvent,
                  Events[number]
                >
              )
            addListener(eventName, dispatcher)
            return () => removeListener(eventName, dispatcher)
          })
        ),
        cleanups => Effect.all(cleanups.map(Effect.sync))
      )
    })
  )

const RtcPeerConnectionInterface = Context.Service<typeof RTCPeerConnection>(
  'RtcPeerConnectionInterface'
)

const make = Effect.fn(function* (rtcConfig?: globalThis.RTCConfiguration) {
  // const context = yield* Effect.context()
  const peerConnection = yield* RtcPeerConnectionInterface.use(
    RTCPeerConnection => Effect.succeed(new RTCPeerConnection(rtcConfig))
  )

  const tryOperation = <A>(opName: string, tryFn: () => A) => ({
    try: tryFn,
    catch: (cause: unknown) =>
      new RtcPeerConnectionError({operation: opName, cause})
  })

  yield* Effect.addFinalizer(() =>
    Effect.all([Effect.sync(() => peerConnection.close())], {discard: true})
  )

  const service = {
    /** Allows access to the raw RTCPeerConnection instance */
    useUnsafe: <A, E, R>(
      f: (pc: RTCPeerConnection) => Effect.Effect<A, E, R>
    ) => f(peerConnection),

    localDescription: Effect.sync(() => peerConnection.localDescription),
    remoteDescription: Effect.sync(() => peerConnection.remoteDescription),
    connectionState: Effect.sync(() => peerConnection.connectionState),
    signalingState: Effect.sync(() => peerConnection.signalingState),
    iceGatheringState: Effect.sync(() => peerConnection.iceGatheringState),
    getSenders: Effect.sync(peerConnection.getSenders.bind(peerConnection)),
    restartIce: Effect.sync(peerConnection.restartIce.bind(peerConnection)),
    close: Effect.sync(peerConnection.close.bind(peerConnection)),

    addIceCandidate: Effect.fnUntraced(function* (
      candidate?: RTCIceCandidateInit | null
    ) {
      return yield* Effect.tryPromise(
        tryOperation('addIceCandidate', () =>
          peerConnection.addIceCandidate(candidate)
        )
      )
    }),
    setLocalDescription: Effect.fnUntraced(function* (
      description?: RTCLocalSessionDescriptionInit
    ) {
      return yield* Effect.tryPromise(
        tryOperation('setLocalDescription', () =>
          peerConnection.setLocalDescription(description)
        )
      )
    }),
    setRemoteDescription: Effect.fnUntraced(function* (
      description: RTCSessionDescriptionInit
    ) {
      return yield* Effect.tryPromise(
        tryOperation('setRemoteDescription', () =>
          peerConnection.setRemoteDescription(description)
        )
      )
    }),
    createOffer: Effect.fnUntraced(function* (options?: RTCOfferOptions) {
      return yield* Effect.tryPromise(
        tryOperation('createOffer', () => peerConnection.createOffer(options))
      )
    }),
    createDataChannel: Effect.fnUntraced(function* (
      label: string,
      options?: RTCDataChannelInit
    ) {
      return yield* Effect.try(
        tryOperation('createDataChannel', () =>
          peerConnection.createDataChannel(label, options)
        )
      )
    }),
    addTrack: Effect.fnUntraced(function* (
      track: MediaStreamTrack,
      ...streams: MediaStream[]
    ) {
      return yield* Effect.try(
        tryOperation('addTrack', () =>
          peerConnection.addTrack(track, ...streams)
        )
      )
    }),
    /** helper for deprecated `addStream` feature */
    addStream: Effect.fnUntraced(function* (stream: MediaStream) {
      const senders: RTCRtpSender[] = []
      for (const track of stream.getTracks()) {
        senders.push(
          yield* Effect.try(
            tryOperation('addTrack', () =>
              peerConnection.addTrack(track, stream)
            )
          )
        )
      }

      return senders
    }),
    removeTrack: Effect.fnUntraced(function* (sender: RTCRtpSender) {
      yield* Effect.try(
        tryOperation('removeTrack', () => peerConnection.removeTrack(sender))
      )
    }),
    /** helper for deprecated `removeStream` feature */
    removeStream: Effect.fnUntraced(function* (
      stream: MediaStream,
      options?: {
        failFast?: boolean
      }
    ) {
      const tracks = stream.getTracks()
      const results = []
      for (const sender of peerConnection.getSenders()) {
        if (sender.track && tracks.includes(sender.track)) {
          const result = yield* Effect.try(
            tryOperation('removeTrack', () =>
              peerConnection.removeTrack(sender)
            )
          ).pipe(Effect.result)
          if (options?.failFast && Result.isFailure(result)) {
            return yield* Effect.fail(result.failure)
          }
          results.push(result)
        }
      }
      return results
    }),
    /** helper for replacing a track without having to manage senders */
    replaceTrack: Effect.fnUntraced(function* (
      oldTrack: MediaStreamTrack,
      newTrack: MediaStreamTrack | null
    ) {
      const sender = peerConnection
        .getSenders()
        .find(candidate => candidate.track === oldTrack)
      if (!sender) {
        return false
      }
      yield* Effect.tryPromise(
        tryOperation('replaceTrack', () => sender.replaceTrack(newTrack))
      )
      return true
    })
  }
  return service
})
const TypeId = '~/webrtc/RtcPeerConnection' as const
type RtcPeerConnection = Effect.Success<ReturnType<typeof make>> & {
  readonly [TypeId]: typeof TypeId
}

export const RtcPeerConnection = Context.Service<RtcPeerConnection>(
  '@/webrtc/RtcPeerConnection'
)
export const makeGlobalThis = (
  config: PeerConnectionConfig
): Effect.Effect<RtcPeerConnection, never, Scope> =>
  Effect.provideService(
    Effect.map(make(config), s =>
      RtcPeerConnection.of({...s, [TypeId]: TypeId})
    ),
    RtcPeerConnectionInterface,
    globalThis.RTCPeerConnection
  )

export const makePolyFill = (
  polyfill: typeof globalThis.RTCPeerConnection,
  config: PeerConnectionConfig
): Effect.Effect<RtcPeerConnection, never, Scope> =>
  Effect.map(make(config), s =>
    RtcPeerConnection.of({...s, [TypeId]: TypeId})
  ).pipe(
    Effect.provideContext(
      Context.mergeAll(Context.make(RtcPeerConnectionInterface, polyfill))
    )
  )

export const waitForIceGathering = Effect.fnUntraced(function* (
  pc: RtcPeerConnection,
  timeout: Duration.Input = Duration.seconds(15)
) {
  if ((yield* pc.iceGatheringState) !== 'complete') {
    yield* makeStreamFromEventListeners(pc, ['icegatheringstatechange']).pipe(
      Stream.filterMapEffect(_ =>
        pc.iceGatheringState.pipe(
          Effect.map(state =>
            state === 'complete' ? Result.void : Result.failVoid
          )
        )
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.timeout(timeout)
    )
  }
})

/**
 * Tracks all RTCDataChannels created by the peer connection and ensures they are closed when the peer connection is closed.
 */
export const manageDataChannels = Effect.fnUntraced(function* (
  pc: RtcPeerConnection
) {
  const seenDataChannels = new Set<RTCDataChannel>()
  yield* Effect.forkScoped(
    pipe(
      makeStreamFromEventListeners(pc, ['datachannel']),
      Stream.tap(({channel}) =>
        Effect.sync(() => {
          seenDataChannels.add(channel)
          const prevOnclose = channel.onclose
          // todo: use event listener instead.
          channel.onclose = ev => {
            if (prevOnclose) {
              prevOnclose.call(channel, ev)
            }
            seenDataChannels.delete(channel)
          }
        })
      ),
      Stream.runDrain
    )
  )
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => seenDataChannels.forEach(dc => dc.close()))
  )
})
