declare module 'trystero/torrent' {
  import {BaseRoomConfig, RelayConfig, Room} from 'trystero'

  export function joinRoom(
    config: BaseRoomConfig & RelayConfig,
    roomId: string
  ): Room

  export function getRelaySockets(): Record<string, WebSocket>

  export function pauseReconnection(): void;

  export function resumeReconnection(): void;

  export function isReconnectionPaused(): boolean;

  export * from 'trystero'
}
