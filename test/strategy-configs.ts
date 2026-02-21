import {defaultRelayUrls as mqttRelays} from '@trystero/mqtt'
import {defaultRelayUrls as nostrRelays} from '@trystero/nostr'
import {defaultRelayUrls as torrentRelays} from '@trystero/torrent'

const defaultRelayRedundancy = 4

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
  ipfs: {},
  firebase: {appId: 'trystero-94db3.firebaseio.com'},
  supabase: {
    appId: 'https://swhajnendtrtanrqufqg.supabase.co',
    supabaseKey: 'sb_publishable_Bimr4WAzoSgyXK70-dS2PQ_rkvLGGlc'
  }
}
