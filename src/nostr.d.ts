declare module 'trystero/nostr' {
  import {BaseRoomConfig, RelayConfig, Room} from 'trystero'

  export function joinRoom(
    config: BaseRoomConfig & RelayConfig,
    roomId: string
  ): Room

  export function getRelaySockets(): Record<string, WebSocket>

  export * from 'trystero'
}
