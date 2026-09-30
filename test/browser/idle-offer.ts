import {expect, test} from '@playwright/test'
import {sleep, withStrategyBrowserPair} from './harness'
import {joinRoomAndWaitForPeer, leaveRoom, ping} from './room-helpers'

test('Trystero: browser: restarting an unanswered data channel offer retains its media section', async ({
  page
}) => {
  await page.goto(`https://127.0.0.1:${process.env.TRYSTERO_TEST_PORT}/test`)
  const offers = await page.evaluate(async () => {
    const peerModule = '../packages/core/dist/peer.mjs'
    const {default: initPeer} = await import(peerModule)
    const peer = initPeer(true, {rtcConfig: {iceServers: []}})

    try {
      const initial = await peer.getOffer()
      const replacement = await peer.getOffer(true)
      return {
        initial: initial?.sdp,
        replacement: replacement?.sdp,
        initialIceUfrag: initial?.sdp.match(/^a=ice-ufrag:(.*)$/m)?.[1],
        replacementIceUfrag: replacement?.sdp.match(/^a=ice-ufrag:(.*)$/m)?.[1],
        state: peer.connection.signalingState,
        remoteDescription: peer.connection.remoteDescription?.type ?? null
      }
    } finally {
      peer.destroy()
    }
  })

  expect(offers.initial).toMatch(/^m=application/m)
  expect(offers.replacement).toMatch(/^m=application/m)
  expect(offers.initialIceUfrag).toBeTruthy()
  expect(offers.replacementIceUfrag).toBeTruthy()
  expect(offers.replacementIceUfrag).not.toBe(offers.initialIceUfrag)
  expect(offers.state).toBe('have-local-offer')
  expect(offers.remoteDescription).toBeNull()
})

withStrategyBrowserPair(
  'ws-relay',
  {rtcConfig: {iceServers: []}},
  'idle peer leads with a fresh offer after the former offer TTL',
  async ({page, page2, roomConfig, selfId1, selfId2}) => {
    const [idlePage, freshPage] =
      selfId1 < selfId2 ? [page, page2] : [page2, page]
    const [idleId, freshId] =
      selfId1 < selfId2 ? [selfId1, selfId2] : [selfId2, selfId1]
    const roomId = `idle-offer-${Math.random()}`

    try {
      await idlePage.evaluate(
        ([roomId, config]) => {
          window[roomId] = window.trystero.joinRoom(config, roomId)
        },
        [roomId, roomConfig]
      )
      // Let any prewarmed native ICE gather, then advance only Date past its TTL.
      await sleep(250)
      await idlePage.clock.setFixedTime(Date.now() + 62_000)

      expect(
        await freshPage.evaluate(joinRoomAndWaitForPeer, [roomId, roomConfig])
      ).toBe(idleId)
      await expect
        .poll(() =>
          idlePage.evaluate(
            roomId => Object.keys(window[roomId].getPeers()),
            roomId
          )
        )
        .toEqual([freshId])
      expect(await idlePage.evaluate(ping, [roomId, freshId])).toBeLessThan(
        1000
      )
    } finally {
      await idlePage.clock.resume()
      await Promise.all([
        idlePage.evaluate(leaveRoom, roomId),
        freshPage.evaluate(leaveRoom, roomId)
      ])
    }
  }
)
