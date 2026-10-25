export {}

declare module '../packages/core/src/types' {
  interface BaseRoomConfig {
    _test_only_forcedPeerId?: string
    _test_only_mdnsHostFallbackToLoopback?: boolean
    _test_only_sharedPeerIdleMs?: number
  }
}

declare module '@trystero-p2p/core' {
  interface BaseRoomConfig {
    _test_only_forcedPeerId?: string
    _test_only_mdnsHostFallbackToLoopback?: boolean
    _test_only_sharedPeerIdleMs?: number
  }
}
