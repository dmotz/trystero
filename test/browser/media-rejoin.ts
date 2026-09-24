import {expect} from '@playwright/test'
import {withStrategyBrowserPair} from './harness'
import {joinRoomAndWaitForPeer} from './room-helpers'

withStrategyBrowserPair(
  'ws-relay',
  {},
  'one-sided room rejoin restores video',
  async ({joinPairWithRetry, page, page2, roomConfig}) => {
    const {roomId} = await joinPairWithRetry({
      label: 'media rejoin',
      makeRoomId: () => `media-rejoin-${Math.random()}`,
      join: joinRoomAndWaitForPeer,
      makeArgs: roomId => [roomId, roomConfig]
    })

    try {
      const prepareViewer = roomId => {
        const video = document.createElement('video')
        video.id = 'media-rejoin-video'
        video.autoplay = true
        video.muted = true
        video.playsInline = true
        document.body.append(video)
        window[roomId].onPeerStream = stream => {
          video.srcObject = stream
          void video.play().catch(() => {})
        }
      }

      await page2.evaluate(prepareViewer, roomId)
      await page.evaluate(async roomId => {
        const stream = await navigator.mediaDevices.getUserMedia({video: true})
        window.__streamSwitchLocalStream = stream
        window[roomId].onPeerJoin = peerId => {
          void Promise.all(window[roomId].addStream(stream, {target: peerId}))
        }
      }, roomId)
      await expect
        .poll(
          () =>
            page2.evaluate(() => {
              const video = document.querySelector<HTMLVideoElement>(
                '#media-rejoin-video'
              )!
              return video.readyState >= 2 && video.currentTime > 0
            }),
          {timeout: 10_000}
        )
        .toBe(true)

      await page2.evaluate(roomId => window[roomId].leave(), roomId)

      await page2.evaluate(
        ([roomId, config]) => {
          window[roomId] = window.trystero.joinRoom(config, roomId)
          const video = document.querySelector<HTMLVideoElement>(
            '#media-rejoin-video'
          )!
          video.srcObject = null
          window[roomId].onPeerStream = stream => {
            video.srcObject = stream
            void video.play().catch(() => {})
          }
        },
        [roomId, roomConfig]
      )

      await expect
        .poll(
          () =>
            page2.evaluate(() => {
              const video = document.querySelector<HTMLVideoElement>(
                '#media-rejoin-video'
              )!
              return video.readyState >= 2 && video.currentTime > 0
            }),
          {timeout: 10_000}
        )
        .toBe(true)
    } finally {
      await Promise.all([
        page.evaluate(roomId => {
          window.__streamSwitchLocalStream
            ?.getTracks()
            .forEach(track => track.stop())
          return window[roomId]?.leave()
        }, roomId),
        page2.evaluate(roomId => window[roomId]?.leave(), roomId)
      ])
    }
  }
)
