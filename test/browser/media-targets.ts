import {expect, test} from '@playwright/test'
import {strategyConfigs} from '../strategy-configs'

test('Trystero: ws-relay: targeted media connects multi-hop peers privately', async ({
  browser,
  browserName
}) => {
  test.setTimeout(90_000)
  const roomId = `private-media-${Math.random()}`
  const config = {
    ...strategyConfigs['ws-relay'],
    appId: roomId,
    identity: 'none',
    rtcConfig: {iceServers: []},
    ...(browserName === 'firefox' || browserName === 'webkit'
      ? {_test_only_mdnsHostFallbackToLoopback: true}
      : {})
  }
  const contexts = await Promise.all(
    Array.from({length: 8}, () =>
      browser.newContext({
        ignoreHTTPSErrors: true,
        ...(browserName === 'webkit'
          ? {permissions: ['camera', 'microphone']}
          : {})
      })
    )
  )
  try {
    const pages = await Promise.all(contexts.map(context => context.newPage()))
    const ids: string[] = []
    for (const page of pages) {
      await page.goto(
        `https://127.0.0.1:${process.env['TRYSTERO_TEST_PORT']}/test`
      )
      ids.push(
        await page.evaluate(
          async ({roomId, config}) => {
            const scriptUrl = '../dist/trystero-ws-relay.min.js'
            window.trystero = await import(scriptUrl)
            const room = (window[roomId] = window.trystero.joinRoom(
              {
                ...config,
                use: [
                  window.trystero.scale({
                    mode: 'broadcast',
                    maxConnections: 2,
                    fanout: 2
                  })
                ]
              },
              roomId
            ))
            window.receivedPrivateMedia = []
            room.onPeerStream = (stream, {peerId}) => {
              window.receivedPrivateMedia.push(peerId)
              const video = document.createElement('video')
              video.autoplay = true
              video.muted = true
              video.srcObject = stream
              document.body.append(video)
              void video.play()
            }
            return (await room.getSelf()).peerId
          },
          {roomId, config}
        )
      )
      if (ids.length > 1) {
        await expect
          .poll(() =>
            page.evaluate(
              roomId => Object.keys(window[roomId].getPeers()).length,
              roomId
            )
          )
          .toBeGreaterThan(0)
      }
    }
    await expect
      .poll(
        async () =>
          Promise.all(
            pages.map(page =>
              page.evaluate(
                roomId => Object.keys(window[roomId].getPeers()).length,
                roomId
              )
            )
          ),
        {timeout: 20_000}
      )
      .toEqual(ids.map(() => ids.length - 1))

    const peerMaps = await Promise.all(
      pages.map(page =>
        page.evaluate(
          roomId =>
            Object.entries(window[roomId].getPeers())
              .filter(([, peer]) => !(peer as {direct: boolean}).direct)
              .map(([id]) => id),
          roomId
        )
      )
    )
    const sourceIndex = peerMaps.findIndex(peers => peers.length > 0)
    expect(sourceIndex).toBeGreaterThanOrEqual(0)
    const targetId = peerMaps[sourceIndex][0]
    const targetIndex = ids.indexOf(targetId)
    await pages[sourceIndex].evaluate(
      async ([roomId, target]) => {
        const stream = await navigator.mediaDevices.getUserMedia({video: true})
        window.__streamSwitchLocalStream = stream
        await Promise.all(window[roomId].addStream(stream, {target}))
      },
      [roomId, targetId]
    )
    await expect
      .poll(
        () =>
          pages[targetIndex].evaluate(() => {
            const video = document.querySelector('video')
            return Boolean(
              video && video.readyState >= 2 && video.currentTime > 0
            )
          }),
        {timeout: 15_000}
      )
      .toBe(true)
    expect(
      await pages[sourceIndex].evaluate(
        ([roomId, target]) => window[roomId].getPeers()[target].direct,
        [roomId, targetId]
      )
    ).toBe(true)
    expect(
      await Promise.all(
        pages.map(page => page.evaluate(() => window.receivedPrivateMedia))
      )
    ).toEqual(ids.map((_, i) => (i === targetIndex ? [ids[sourceIndex]] : [])))
  } finally {
    await Promise.all(contexts.map(context => context.close()))
  }
})
