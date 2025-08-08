declare module 'trystero' {
  type JsonValue =
    | null
    | string
    | number
    | boolean
    | JsonValue[]
    | {[key: string]: JsonValue}

  type DataPayload = JsonValue | Blob | ArrayBuffer | ArrayBufferView

  type TargetPeers = string | string[] | null

  export interface BaseRoomConfig {
    appId: string
    password?: string
    rtcConfig?: RTCConfiguration
  }

  export interface ActionSender<T> {
    (
      data: T,
      targetPeers?: TargetPeers,
      metadata?: JsonValue,
      progress?: (percent: number, peerId: string) => void
    ): Promise<void[]>
  }

  export interface ActionReceiver<T> {
    (receiver: (data: T, peerId: string, metadata?: JsonValue) => void): void
  }

  export interface ActionProgress {
    (
      progressHandler: (
        percent: number,
        peerId: string,
        metadata?: JsonValue
      ) => void
    ): void
  }

  export interface RelayConfig {
    relayUrls?: string[]
    relayRedundancy?: number
  }

  export interface TurnConfig {
    turnConfig?: {
      urls: string | string[]
      username?: string
      credential?: string
      credentialType?: string
    }[]
  }

  export interface Room {
    makeAction: <T extends DataPayload>(
      namespace: string
    ) => [ActionSender<T>, ActionReceiver<T>, ActionProgress]

    ping: (id: string) => Promise<number>

    leave: () => Promise<void>

    getPeers: () => Record<string, RTCPeerConnection>

    addStream: (
      stream: MediaStream,
      targetPeers?: TargetPeers,
      metadata?: JsonValue
    ) => Promise<void>[]

    removeStream: (stream: MediaStream, targetPeers?: TargetPeers) => void

    addTrack: (
      track: MediaStreamTrack,
      stream: MediaStream,
      targetPeers?: TargetPeers,
      metadata?: JsonValue
    ) => Promise<void>[]

    removeTrack: (track: MediaStreamTrack, targetPeers?: TargetPeers) => void

    replaceTrack: (
      oldTrack: MediaStreamTrack,
      newTrack: MediaStreamTrack,
      targetPeers?: TargetPeers,
      metadata?: JsonValue
    ) => Promise<void>[]

    onPeerJoin: (fn: (peerId: string) => void) => void

    onPeerLeave: (fn: (peerId: string) => void) => void

    onPeerStream: (
      fn: (stream: MediaStream, peerId: string, metadata: JsonValue) => void
    ) => void

    onPeerTrack: (
      fn: (
        track: MediaStreamTrack,
        stream: MediaStream,
        peerId: string,
        metadata: JsonValue
      ) => void
    ) => void
  }

  export function joinRoom(
    config: BaseRoomConfig & RelayConfig & TurnConfig,
    roomId: string,
    onJoinError?: (details: {
      error: string
      appId: string
      roomId: string
      peerId: string
    }) => void
  ): Room

  export const selfId: string
}
