import stun from 'stun'
import {defaultIceServers} from '../src/peer.js'

!(
  await Promise.all(
    defaultIceServers.map(({urls}) =>
      stun
        .request(urls.replace('stun:', ''))
        .then(() => '✅ ' + urls)
        .catch(() => '❌ ' + urls)
    )
  )
).forEach(x => console.log(x))
