import {expect, test} from '@playwright/test'

test('Trystero: torrent: a prewarmed offer attaches after its data channel opens', async ({
  page,
  browserName
}) => {
  await page.goto(`https://127.0.0.1:${process.env.TRYSTERO_TEST_PORT}/test`)
  const attached = await page.evaluate(async useLoopbackFallback => {
    const peerModule = '../packages/core/dist/peer.mjs'
    const {default: initPeer} = await import(peerModule)
    const config = {
      appId: 'prewarmed-browser-test',
      trickleIce: false,
      rtcConfig: {iceServers: []},
      ...(useLoopbackFallback
        ? {_test_only_mdnsHostFallbackToLoopback: true}
        : {})
    }
    const initiator = initPeer(true, config)
    const answerer = initPeer(false, config)
    const joined = [0, 0]

    try {
      // The offer is published before a signaling handler exists, as with Torrent.
      const offer = await initiator.getOffer()
      initiator.setHandlers({
        connect: () => {
          joined[0]++
          initiator.setHandlers({data: () => {}, signal: () => {}})
        }
      })
      answerer.setHandlers({
        connect: () => {
          joined[1]++
          answerer.setHandlers({data: () => {}, signal: () => {}})
        }
      })
      const answer = await answerer.signal(offer)
      await initiator.signal(answer)
      const deadline = Date.now() + 10_000
      while (joined.some(count => count !== 1) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return {
        joined,
        channels: [initiator.channel?.readyState, answerer.channel?.readyState],
        closed: [initiator.isDead, answerer.isDead]
      }
    } finally {
      initiator.destroy()
      answerer.destroy()
    }
  }, browserName !== 'chromium')

  expect(attached.joined).toEqual([1, 1])
  expect(attached.channels).toEqual(['open', 'open'])
  expect(attached.closed).toEqual([false, false])
})
