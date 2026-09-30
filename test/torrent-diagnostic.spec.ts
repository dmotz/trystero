import {expect, test} from '@playwright/test'

test('temporary torrent peer state probe', async ({page, browser}) => {
  const port = process.env.TRYSTERO_TEST_PORT
  const context2 = await browser.newContext({ignoreHTTPSErrors: true})
  const page2 = await context2.newPage()
  const appId = `torrent-probe-${Math.random()}`
  const roomId = `room-${Math.random()}`
  const configure = async (target, [appId, roomId, passive]) => {
    await target.goto(`https://127.0.0.1:${port}/test`)
    await target.evaluate(async ([appId, roomId, passive]) => {
      window.trystero = await import('../dist/trystero-torrent.min.js')
      window.__pcs = []
      window.__joins = []
      window.__leaves = []
      window.__errors = []
      class Inspect extends RTCPeerConnection {
        constructor(config) {
          super(config)
          this.events = []
          this.channels = []
          this.addEventListener('connectionstatechange', () => this.events.push(this.connectionState))
          this.addEventListener('datachannel', event => this.recordChannel(event.channel))
          window.__pcs.push(this)
        }
        createDataChannel(name, options) {
          return this.recordChannel(super.createDataChannel(name, options))
        }
        recordChannel(channel) {
          this.channels.push(channel)
          channel.addEventListener('open', () => this.events.push('channel-open'))
          channel.addEventListener('close', () => this.events.push('channel-close'))
          return channel
        }
      }
      window.__room = window.trystero.joinRoom({
        appId,
        password: 'probe',
        passive,
        rtcPolyfill: Inspect,
        relayConfig: {urls: ['wss://tracker.webtorrent.dev'], redundancy: 1}
      }, roomId, {onJoinError: error => window.__errors.push(error)})
      window.__room.onPeerJoin = id => window.__joins.push(id)
      window.__room.onPeerLeave = id => window.__leaves.push(id)
    }, [appId, roomId, passive])
  }
  try {
    await Promise.all([configure(page, [appId, roomId, false]), configure(page2, [appId, roomId, true])])
    await page.waitForTimeout(12_000)
    const snapshot = target => target.evaluate(() => ({
      peers: Object.keys(window.__room.getPeers()).length,
      created: window.__pcs.length,
      joins: window.__joins.length,
      leaves: window.__leaves.length,
      errors: window.__errors.slice(0, 4),
      states: window.__pcs.map(pc => pc.connectionState).reduce((count, state) => ({...count, [state]: (count[state] ?? 0) + 1}), {}),
      channels: window.__pcs.flatMap(pc => pc.channels.map(channel => channel.readyState)).reduce((count, state) => ({...count, [state]: (count[state] ?? 0) + 1}), {}),
      recent: window.__pcs.slice(-8).map(pc => ({
        connection: pc.connectionState,
        ice: pc.iceConnectionState,
        signaling: pc.signalingState,
        localType: pc.localDescription?.type,
        remoteType: pc.remoteDescription?.type,
        localMedia: (pc.localDescription?.sdp.match(/^m=/gm) ?? []).length,
        remoteMedia: (pc.remoteDescription?.sdp.match(/^m=/gm) ?? []).length,
        localCandidates: (pc.localDescription?.sdp.match(/^a=candidate:/gm) ?? []).length,
        remoteCandidates: (pc.remoteDescription?.sdp.match(/^a=candidate:/gm) ?? []).length,
        localUfrag: pc.localDescription?.sdp.match(/^a=ice-ufrag:(.*)$/m)?.[1],
        remoteUfrag: pc.remoteDescription?.sdp.match(/^a=ice-ufrag:(.*)$/m)?.[1],
        events: pc.events
      }))
    }))
    const states = await Promise.all([snapshot(page), snapshot(page2)])
    console.log('TORRENT_DIAGNOSTIC', JSON.stringify(states))
    expect(states.map(state => state.peers)).toEqual([1, 1])
  } finally {
    await Promise.all([page.evaluate(() => window.__room?.leave()).catch(() => {}), page2.evaluate(() => window.__room?.leave()).catch(() => {})])
    await context2.close()
  }
})
