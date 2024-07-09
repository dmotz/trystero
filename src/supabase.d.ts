declare module 'trystero/supabase' {
  import {BaseRoomConfig, Room} from 'trystero'

  export interface SupabaseRoomConfig {
    supabaseKey: string
  }

  export function joinRoom(
    config: BaseRoomConfig & SupabaseRoomConfig,
    roomId: string
  ): Room

  export * from 'trystero'
}
