declare module 'trystero/torrent' {
  import {BaseRoomConfig, Room} from 'trystero'

  export interface TorrentRoomConfig {
    trackerUrls?: string[]
    trackerRedundancy?: number
  }

  export function joinRoom(
    config: BaseRoomConfig & TorrentRoomConfig,
    roomId: string
  ): Room

  export function getTrackers(): Record<string, WebSocket>

  export * from 'trystero'
}
