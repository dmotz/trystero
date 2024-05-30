import checkProxy from 'proxy-check'

const proxies = await (
  await fetch(
    'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all'
  )
).text()

console.log(
  await Promise.any(
    proxies
      .split('\r\n')
      .slice(0, 99)
      .map(addr => {
        const [host, port] = addr.split(':')
        return checkProxy({host, port}).then(() => addr)
      })
  )
)
