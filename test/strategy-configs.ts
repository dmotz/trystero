import {defaultRelayUrls as mqttRelays} from '@trystero-p2p/mqtt'
import {defaultRelayUrls as nostrRelays} from '@trystero-p2p/nostr'
import {defaultRelayUrls as torrentRelays} from '@trystero-p2p/torrent'

const defaultRelayRedundancy = 4
const wsRelayUrls = (process.env['TRYSTERO_WS_RELAY_URLS'] ?? '')
  .split(',')
  .filter(Boolean)

export type StrategyConfig = Record<string, unknown>

export const strategyConfigs: Record<string, StrategyConfig> = {
  nostr: {
    relayRedundancy: Math.min(defaultRelayRedundancy, nostrRelays.length)
  },
  mqtt: {
    relayRedundancy: Math.min(defaultRelayRedundancy, mqttRelays.length)
  },
  torrent: {
    relayRedundancy: Math.min(defaultRelayRedundancy, torrentRelays.length)
  },
  'ws-relay': {relayUrls: wsRelayUrls},
  firebase: {appId: 'trystero-94db3.firebaseio.com'},
  supabase: {
    appId: 'https://swhajnendtrtanrqufqg.supabase.co',
    supabaseKey: 'sb_publishable_Bimr4WAzoSgyXK70-dS2PQ_rkvLGGlc'
  },
  ipfs: {}
}
