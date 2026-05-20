// @ts-nocheck
import {registerActionsAndMediaTests} from './browser/actions-and-media'
import {registerHandshakeTests} from './browser/handshake'
import {registerMediaSwitchTests} from './browser/media-switch'
import {registerPeerLifecycleTests} from './browser/peer-lifecycle'

export default (strategy, overrides = {}) => {
  registerMediaSwitchTests(strategy, overrides)
  registerActionsAndMediaTests(strategy, overrides)
  registerHandshakeTests(strategy, overrides)
  registerPeerLifecycleTests(strategy, overrides)
}
