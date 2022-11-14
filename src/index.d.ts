declare module 'trystero' {
  import {TorrentRoomConfig} from 'trystero/torrent'

  type Metadata =
    | null
    | string
    | number
    | boolean
    | undefined
    | Metadata[]
    | {[key: string]: Metadata}

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
      metadata?: Metadata,
      progress?: (percent: number, peerId: string) => void
    ): Promise<Array<undefined>>
  }

  export interface ActionReceiver<T> {
    (receiver: (data: T, peerId: string, metadata?: Metadata) => void): void
  }

  export interface ActionProgress {
    (
      progressHandler: (
        percent: number,
        peerId: string,
        metadata?: Metadata
      ) => void
    ): void
  }

  export interface Room {
    makeAction: <T>(
      namespace: string
    ) => [ActionSender<T>, ActionReceiver<T>, ActionProgress]

    ping: (id: string) => Promise<number>

    leave: () => void

    getPeers: () => string[]

    addStream: (
      stream: MediaStream,
      targetPeers?: TargetPeers,
      metadata?: Metadata
    ) => Promise<void>[]

    removeStream: (stream: MediaStream, targetPeers?: TargetPeers) => void

    addTrack: (
      track: MediaStreamTrack,
      stream: MediaStream,
      targetPeers?: TargetPeers,
      metadata?: Metadata
    ) => Promise<void>[]

    removeTrack: (
      track: MediaStreamTrack,
      stream: MediaStream,
      targetPeers?: TargetPeers
    ) => void

    replaceTrack: (
      oldTrack: MediaStreamTrack,
      newTrack: MediaStreamTrack,
      stream: MediaStream,
      targetPeers?: TargetPeers
    ) => Promise<void>[]

    onPeerJoin: (fn: (peerId: string) => void) => void

    onPeerLeave: (fn: (peerId: string) => void) => void

    onPeerStream: (
      fn: (stream: MediaStream, peerId: string, metadata: Metadata) => void
    ) => void

    onPeerTrack: (
      fn: (track: MediaStreamTrack, stream: MediaStream, peerId: string) => void
    ) => void
  }

  export function joinRoom(
    config: BaseRoomConfig & TorrentRoomConfig,
    roomId: string
  ): Room

  export const selfId: string
}
