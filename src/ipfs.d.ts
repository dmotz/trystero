declare module 'trystero/ipfs' {
  import {BaseRoomConfig, Room} from 'trystero'

  export function joinRoom(config: BaseRoomConfig, roomId: string): Room

  export * from 'trystero'
}
