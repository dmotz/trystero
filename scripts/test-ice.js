import stun from 'stun'
import {defaultIceServers} from '../src/peer.js'

Promise.all(
  defaultIceServers.map(({urls}) =>
    stun
      .request(urls.replace(/^stun:/, ''))
      .then(() => '✅ ' + urls)
      .catch(() => '❌ ' + urls)
  )
).then(res => res.forEach(x => console.log(x)))
