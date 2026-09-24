import {RTCPeerConnection} from 'werift'
import WebSocket from 'ws'

class ObservedWebSocket extends WebSocket {
  constructor(url: string, ...args: any[]) {
    super(url, ...args)
    if (!process.env['PUBLIC_RELAYS']) {
      return
    }
    this.on('open', () => process.send?.({type: 'socket-open', url: this.url}))
    this.on('close', () =>
      process.send?.({type: 'socket-close', url: this.url})
    )
    this.on('message', data => {
      const frame = JSON.parse(
        (Array.isArray(data)
          ? Buffer.concat(data)
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : data
        ).toString('utf8')
      )
      if (frame[0] !== 'EVENT') {
        process.send?.({type: 'relay-feedback', url: this.url, frame})
      }
    })
  }

  override send(data: any, ...args: any[]) {
    if (process.env['PUBLIC_RELAYS']) {
      process.send?.({
        type: 'wire',
        url: this.url,
        frame: JSON.parse(String(data))
      })
    }
    return super.send(data, ...args)
  }
}

globalThis.WebSocket =
  ObservedWebSocket as unknown as typeof globalThis.WebSocket

const {joinRoom} = await import(process.env['TRYSTERO_COMPARE_MODULE']!)
let room: ReturnType<typeof joinRoom>
let started = 0
let isRejoining = false

process.on('message', message => {
  if ((message as {type?: string}).type === 'disconnect') {
    started = performance.now()
    isRejoining = true
    Object.values(room.getPeers()).forEach(peer => {
      void (peer as RTCPeerConnection).close()
    })
    return
  }
  const {config, roomId} = message as {
    config: Record<string, unknown>
    roomId: string
  }
  started = performance.now()
  room = joinRoom({...config, rtcPolyfill: RTCPeerConnection}, roomId)
  room.onPeerJoin = () =>
    process.send?.({
      type: isRejoining ? 'reconnected' : 'connected',
      ms: performance.now() - started
    })
})

process.on('SIGTERM', () => {
  void Promise.resolve(room?.leave()).finally(() => process.exit(0))
})

process.send?.({type: 'ready'})
