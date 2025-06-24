import stun from 'stun'
import {defaultIceServers} from '../src/peer.js'

Promise.all(
  defaultIceServers.map(({urls: url}) =>
    stun
      .request(url.replace(/^stun:/, ''))
      .then(() => '✅ ' + url)
      .catch(() => '❌ ' + url)
  )
).then(res => res.forEach(x => console.log(x)))
