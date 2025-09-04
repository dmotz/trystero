import checkProxy from 'proxy-check'
import {shuffle} from '../src/utils.js'

const proxies = await fetch(
  'https://api.proxyscrape.com/v4/free-proxy-list/get?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all&skip=0&limit=2000'
)
  .then(res => res.text())
  .then(res => shuffle(res.split('\r\n').slice(0, 333), Math.random() * 1e10))

console.log(
  await Promise.any(
    proxies.map(addr => {
      const [host, port] = addr.split(':')
      return checkProxy({host, port}).then(() => addr)
    })
  )
)
