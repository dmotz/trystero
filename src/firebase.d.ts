declare module 'trystero/firebase' {
  import {BaseRoomConfig, Room} from 'trystero'
  import {FirebaseApp} from 'firebase/app'

  export interface FirebaseRoomConfig {
    firebaseApp?: FirebaseApp
    rootPath?: string
  }

  export function joinRoom(
    config: BaseRoomConfig & FirebaseRoomConfig,
    roomId: string
  ): Room

  export function getOccupants(
    config: BaseRoomConfig & FirebaseRoomConfig,
    roomId: string
  ): Promise<string[]>

  export * from 'trystero'
}
