declare module 'trystero/nostr' {
  import {BaseRoomConfig, RelayConfig, Room} from 'trystero'

  export function joinRoom(
    config: BaseRoomConfig & RelayConfig,
    roomId: string,
    manualRelayReconnection?: boolean
  ): Room

  export function getRelaySockets(): Record<string, WebSocket>
  export function pauseRelayReconnection(): void
  export function resumeRelayReconnection(): void

  export * from 'trystero'
}
