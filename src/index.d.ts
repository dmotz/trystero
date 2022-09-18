declare module 'trystero' {
  import {TorrentRoomConfig} from 'trystero/torrent'

  type Metadata = Record<string, number | string | boolean | null | undefined>

  export interface BaseRoomConfig {
    appId: string
    password?: string
    rtcConfig?: RTCConfiguration
  }

  export type RoomConfig = BaseRoomConfig &
    (BitTorrentRoomConfig | FirebaseRoomConfig | IpfsRoomConfig)

  export interface ActionSender<T> {
    (
      data: T,
      targetPeers?: string[],
      metadata?: Metadata,
      progress?: (percent: number, peerId: string) => void
    ): Promise<Array<undefined>>
  }

  export interface ActionReceiver<T> {
    (receiver: (data: T, peerId?: string, metadata?: Metadata) => void): void
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
      peerId?: string,
      metadata?: Metadata
    ) => Promise<void>[]

    removeStream: (stream: MediaStream, peerId?: string) => void

    addTrack: (
      track: MediaStreamTrack,
      stream: MediaStream,
      peerId?: string,
      metadata?: Metadata
    ) => Promise<void>[]

    removeTrack: (
      track: MediaStreamTrack,
      stream: MediaStream,
      peerId?: string
    ) => void

    replaceTrack: (
      oldTrack: MediaStreamTrack,
      newTrack: MediaStreamTrack,
      stream: MediaStream,
      peerId?: string
    ) => Promise<void>[]

    onPeerJoin: (fn: (peerId: string) => void) => void

    onPeerLeave: (fn: (peerId: string) => void) => void

    onPeerStream: (fn: (stream: MediaStream, peerId: string) => void) => void

    onPeerTrack: (
      fn: (track: MediaStreamTrack, stream: MediaStream, peerId: string) => void
    ) => void
  }

  export function joinRoom(
    config: BaseRoomConfig & TorrentRoomConfig,
    roomId: string
  ): Room
}
