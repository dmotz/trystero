declare module 'trystero/ipfs' {
  import {BaseRoomConfig, Room} from 'trystero'

  export interface IpfsRoomConfig {
    swarmAddresses?: string[]
  }

  export function joinRoom(
    config: BaseRoomConfig & IpfsRoomConfig,
    roomId: string
  ): Room

  export * from 'trystero'
}
