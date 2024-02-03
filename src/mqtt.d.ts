declare module 'trystero/mqtt' {
  import {BaseRoomConfig, Room} from 'trystero'

  export interface MqttRoomConfig {
    brokerUrls?: string[]
    brokerRedundancy?: number
  }

  export function joinRoom(
    config: BaseRoomConfig & MqttRoomConfig,
    roomId: string
  ): Room

  export * from 'trystero'
}
