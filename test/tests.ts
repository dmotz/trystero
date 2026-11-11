import type {StrategyConfig, StrategyName} from './strategy-configs'
import {registerActionsAndMediaTests} from './browser/actions-and-media'
import {registerMediaSwitchTests} from './browser/media-switch'
import {registerPeerLifecycleTests} from './browser/peer-lifecycle'

export default (strategy: StrategyName, overrides: StrategyConfig = {}) => {
  registerMediaSwitchTests(strategy, overrides)
  registerActionsAndMediaTests(strategy, overrides)
  registerPeerLifecycleTests(strategy, overrides)
}
