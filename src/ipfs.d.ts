declare module 'trystero/ipfs' {
  import {BaseRoomConfig, Room} from 'trystero'
  import type {Libp2pOptions} from 'libp2p'

  export interface IpfsRoomConfig {
    libp2pConfig?: Partial<Libp2pOptions>
  }

  export function joinRoom(
    config: BaseRoomConfig & IpfsRoomConfig,
    roomId: string
  ): Room

  export * from 'trystero'
}
