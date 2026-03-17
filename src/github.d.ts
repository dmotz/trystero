declare module 'trystero/github' {
  import {BaseRoomConfig, Room} from 'trystero'

  export interface GitHubRoomConfig extends BaseRoomConfig {
    token?: string
    basePath?: string
    signalBranch?: string
    pollIntervalMs?: number
    presenceTtlMs?: number
  }

  export function joinRoom(config: GitHubRoomConfig, roomId: string): Room

  export * from 'trystero'
}