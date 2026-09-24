// Browser worker for compare-relay-joins.ts; module must be a browser bundle.
import {readFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {chromium} from 'playwright'

const bundle = await readFile(new URL(process.env['TRYSTERO_COMPARE_MODULE']!))
const server = createServer((request, response) => {
  response.setHeader(
    'Content-Type',
    request.url === '/module.js' ? 'text/javascript' : 'text/html'
  )
  response.end(
    request.url === '/module.js'
      ? bundle
      : '<!doctype html><title>Relay comparison</title>'
  )
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (!address || typeof address === 'string') {
  throw new Error('missing browser test port')
}
const browser = await chromium.launch({
  args: ['--disable-features=WebRtcHideLocalIpsWithMdns']
})
const page = await browser.newPage()
await page.exposeFunction('reportJoin', (type: string, ms: number) =>
  process.send?.({type, ms})
)
await page.goto(`http://127.0.0.1:${address.port}`)
await page.evaluate(async () => {
  const moduleUrl = '/module.js'
  ;(window as any).joinRoom = (await import(moduleUrl)).joinRoom
})
process.on('message', message => {
  if ((message as {type?: string}).type === 'disconnect') {
    void page.evaluate(() => {
      ;(window as any).started = performance.now()
      ;(window as any).isRejoining = true
      Object.values((window as any).room.getPeers()).forEach(peer =>
        (peer as RTCPeerConnection).close()
      )
    })
    return
  }
  void page.evaluate(
    ({config, roomId}) => {
      ;(window as any).started = performance.now()
      const room = ((window as any).room = (window as any).joinRoom(
        config,
        roomId
      ))
      room.onPeerJoin = () =>
        (window as any).reportJoin(
          (window as any).isRejoining ? 'reconnected' : 'connected',
          performance.now() - (window as any).started
        )
    },
    message as {config: Record<string, unknown>; roomId: string}
  )
})
process.on('SIGTERM', () => {
  void (async () => {
    await page.evaluate(() => (window as any).room?.leave())
    await browser.close()
    server.close()
    process.exit(0)
  })()
})
process.send?.({type: 'ready'})
