import {expect, test} from '@playwright/test'
import {strategyConfigs} from '../strategy-configs'
import {installLoopbackMdnsPeerConnection} from './mdns-loopback'

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
    rtcConfig: {iceServers: []}
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
    if (browserName === 'firefox' || browserName === 'webkit') {
      await Promise.all(pages.map(installLoopbackMdnsPeerConnection))
    }
    const ids: string[] = []
    for (const page of pages) {
      await page.goto(
        `https://127.0.0.1:${process.env['TRYSTERO_TEST_PORT']}/test`
      )
      ids.push(
        await page.evaluate(
          async ({roomId, config}) => {
            const scriptUrl = './test/dist/trystero-ws-relay.js'
            window.trystero = await import(scriptUrl)
            const room = (window[roomId] = window.trystero.joinRoom(
              {
                ...config,
                use: [
                  window.trystero.scale({
                    maxDirectPeers: 4
                  })
                ]
              },
              roomId
            ))
            const selfId = (await room.getSelf()).peerId
            window['receivedPrivateMedia'] = []
            window['receivedBroadcasts'] = []
            window['receivedUnicasts'] = []
            const bcastAction = room.makeAction('mhop-bcast')
            bcastAction.onMessage(
              (data: unknown, {peerId}: {peerId: string}) => {
                window['receivedBroadcasts'].push({data, peerId})
              }
            )
            const ucastAction = room.makeAction('mhop-ucast')
            ucastAction.onMessage(
              (data: unknown, {peerId}: {peerId: string}) => {
                window['receivedUnicasts'].push({data, peerId})
              }
            )
            const rpcAction = room.makeAction('mhop-rpc', {
              kind: 'request'
            })
            rpcAction.onRequest(
              (payload: unknown, {peerId}: {peerId: string}) => ({
                echo: payload,
                from: peerId,
                responder: selfId
              })
            )
            window['sendMultiHopBroadcast'] = bcastAction.send
            window['sendMultiHopUnicast'] = ucastAction.send
            window['requestMultiHopRpc'] = rpcAction.request
            const video = document.createElement('video')
            video.autoplay = true
            video.muted = true
            video.playsInline = true
            document.body.append(video)
            room.onPeerStream(
              (stream: MediaStream, {peerId}: {peerId: string}) => {
                window['receivedPrivateMedia'].push(peerId)
                video.srcObject = stream
                void video.play().catch(() => {})
              }
            )
            return selfId
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

    const lastJoinedId = ids.at(-1)!
    const peerMaps = await Promise.all(
      pages.map(page =>
        page.evaluate(
          ([rId, newestId]: [string, string]) =>
            Object.entries(window[rId].getPeers())
              .filter(([, peer]) => !(peer as {direct: boolean}).direct)
              .map(([id]) => id)
              .sort((a, b) => Number(a === newestId) - Number(b === newestId)),
          [roomId, lastJoinedId] satisfies [string, string]
        )
      )
    )
    const sourceIndex = peerMaps.findIndex(peers => peers.length > 0)
    expect(sourceIndex).toBeGreaterThanOrEqual(0)
    const targetId = peerMaps[sourceIndex]![0]!
    const targetIndex = ids.indexOf(targetId)

    const initialTargetInfo = await pages[sourceIndex]!.evaluate(
      ([rId, target]: [string, string]) => window[rId].getPeers()[target],
      [roomId, targetId] satisfies [string, string]
    )
    expect(initialTargetInfo.direct).toBe(false)
    expect(initialTargetInfo.hops).toBeGreaterThanOrEqual(2)

    // 1. Multi-hop broadcast action over real RTCPeerConnections
    await pages[sourceIndex]!.evaluate(() =>
      window['sendMultiHopBroadcast']({msg: 'hello-multihop-broadcast'})
    )
    await expect
      .poll(
        async () =>
          Promise.all(
            pages.map((page, i) =>
              i === sourceIndex
                ? Promise.resolve(true)
                : page.evaluate(
                    expectedSender =>
                      window['receivedBroadcasts'].some(
                        (entry: {data: {msg: string}; peerId: string}) =>
                          entry.peerId === expectedSender &&
                          entry.data?.msg === 'hello-multihop-broadcast'
                      ),
                    ids[sourceIndex]!
                  )
            )
          ),
        {timeout: 15_000}
      )
      .toEqual(ids.map(() => true))

    // 2. Multi-hop targeted unicast action over real RTCPeerConnections (stays indirect)
    await pages[sourceIndex]!.evaluate(
      target =>
        window['sendMultiHopUnicast'](
          {secret: 'multihop-only-for-target'},
          {target}
        ),
      targetId
    )
    await expect
      .poll(
        () =>
          pages[targetIndex]!.evaluate(() => window['receivedUnicasts'].length),
        {timeout: 15_000}
      )
      .toBe(1)
    expect(
      await Promise.all(
        pages.map(page => page.evaluate(() => window['receivedUnicasts']))
      )
    ).toEqual(
      ids.map((_, i) =>
        i === targetIndex
          ? [
              {
                data: {secret: 'multihop-only-for-target'},
                peerId: ids[sourceIndex]
              }
            ]
          : []
      )
    )
    expect(
      await pages[sourceIndex]!.evaluate(
        ([rId, target]: [string, string]) =>
          window[rId].getPeers()[target].direct,
        [roomId, targetId] satisfies [string, string]
      )
    ).toBe(false)

    // 3. Multi-hop RPC request and ping over real RTCPeerConnections (stays indirect)
    const rpcAndPing = await pages[sourceIndex]!.evaluate(
      async ([rId, target]: [string, string]) => {
        const rpcReply = await window['requestMultiHopRpc']({q: 42}, {target})
        const rtt = await window[rId].ping(target)
        const directAfter = window[rId].getPeers()[target].direct
        return {rpcReply, rtt, directAfter}
      },
      [roomId, targetId] satisfies [string, string]
    )
    expect(rpcAndPing.rpcReply).toEqual({
      echo: {q: 42},
      from: ids[sourceIndex],
      responder: targetId
    })
    expect(typeof rpcAndPing.rtt).toBe('number')
    expect(rpcAndPing.rtt).toBeGreaterThanOrEqual(0)
    expect(rpcAndPing.directAfter).toBe(false)

    // 4. Targeted media promotes the multi-hop peer to a direct RTCPeerConnection
    await pages[sourceIndex]!.evaluate(
      async ([roomId, target]: [string, string]) => {
        const stream = await navigator.mediaDevices.getUserMedia({video: true})
        window.__streamSwitchLocalStream = stream
        await window[roomId].addStream(stream, {target})
      },
      [roomId, targetId] satisfies [string, string]
    )
    await expect
      .poll(
        () =>
          pages[targetIndex]!.evaluate(() => {
            const video = document.querySelector('video')
            return Boolean(
              video && video.readyState >= 2 && video.currentTime > 0
            )
          }),
        {timeout: 15_000}
      )
      .toBe(true)
    expect(
      await pages[sourceIndex]!.evaluate(
        ([roomId, target]: [string, string]) =>
          window[roomId].getPeers()[target].direct,
        [roomId, targetId] satisfies [string, string]
      )
    ).toBe(true)
    expect(
      await Promise.all(
        pages.map(page => page.evaluate(() => window['receivedPrivateMedia']))
      )
    ).toEqual(ids.map((_, i) => (i === targetIndex ? [ids[sourceIndex]] : [])))
  } finally {
    await Promise.all(contexts.map(context => context.close()))
  }
})
