import {defaultRelayUrls as mqttRelays} from '@trystero-p2p/mqtt'
import {defaultRelayUrls as nostrRelays} from '@trystero-p2p/nostr'
import {defaultRelayUrls as torrentRelays} from '@trystero-p2p/torrent'

const defaultRelayRedundancy = 4
const wsRelayUrls = (process.env['TRYSTERO_WS_RELAY_URLS'] ?? '')
  .split(',')
  .filter(Boolean)

export type StrategyName =
  | 'nostr'
  | 'mqtt'
  | 'torrent'
  | 'ws-relay'
  | 'firebase'
  | 'supabase'

export type StrategyConfig = {
  appId?: string
  password?: string
  relayConfig?: {
    redundancy?: number
    urls?: string[]
    supabaseKey?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

export const strategyConfigs: Record<StrategyName, StrategyConfig> = {
  nostr: {
    relayConfig: {
      redundancy: Math.min(defaultRelayRedundancy, nostrRelays.length)
    }
  },
  mqtt: {
    relayConfig: {
      redundancy: Math.min(defaultRelayRedundancy, mqttRelays.length)
    }
  },
  torrent: {
    relayConfig: {
      redundancy: Math.min(defaultRelayRedundancy, torrentRelays.length)
    }
  },
  'ws-relay': {relayConfig: {urls: wsRelayUrls}},
  firebase: {appId: 'trystero-94db3.firebaseio.com'},
  supabase: {
    appId: 'https://swhajnendtrtanrqufqg.supabase.co',
    relayConfig: {
      supabaseKey: 'sb_publishable_Bimr4WAzoSgyXK70-dS2PQ_rkvLGGlc'
    }
  }
}
