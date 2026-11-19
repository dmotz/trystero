import {expect, test} from '@playwright/test'
import type initPeer from '../../packages/core/src/peer'

for (const prepare of [false, true]) {
  test(`Trystero: browser: initial negotiation ${prepare ? 'with' : 'without'} peer preparation`, async ({
    page
  }) => {
    await page.goto(
      `https://127.0.0.1:${process.env['TRYSTERO_TEST_PORT']}/test`
    )
    const result = await page.evaluate(async prepare => {
      const peerModule = '../packages/core/dist/peer.mjs'
      const {default: createPeer}: {default: typeof initPeer} = await import(
        peerModule
      )
      const calls: string[][] = []
      const config: Parameters<typeof createPeer>[1] = {
        appId: 'peer-preparation-test',
        rtcConfig: {iceServers: []},
        trickleIce: false
      }
      if (prepare) {
        config.preparePeerConnection = (pc, role) => {
          calls.push([
            role,
            pc.signalingState,
            String(pc.getTransceivers().length)
          ])
          if (role === 'initiator') {
            pc.addTransceiver('audio', {direction: 'recvonly'})
          } else {
            for (const transceiver of pc.getTransceivers()) {
              transceiver.direction = 'inactive'
            }
          }
        }
      }

      const initiator = createPeer(true, config)
      const responder = createPeer(false, config)
      const signals: string[] = []
      const connected = (peer: ReturnType<typeof createPeer>) =>
        new Promise<void>((resolve, reject) => {
          peer.setHandlers({
            connect: resolve,
            error: reject,
            signal: signal => signals.push(signal.type)
          })
        })

      try {
        const offer = await initiator.getOffer()
        if (!offer) {
          throw new Error('missing initial offer')
        }
        const [, , answer] = await Promise.all([
          connected(initiator),
          connected(responder),
          (async () => {
            const answer = await responder.signal(offer)
            if (!answer) {
              throw new Error('missing initial answer')
            }
            await initiator.signal(answer)
            return answer
          })()
        ])

        const audioSection = (sdp: string) =>
          sdp.split(/^m=/m).find(section => section.startsWith('audio ')) ??
          null
        return {
          calls,
          signals,
          offerAudio: audioSection(offer.sdp),
          answerAudio: audioSection(answer.sdp)
        }
      } finally {
        initiator.destroy()
        responder.destroy()
      }
    }, prepare)

    expect(result.signals).toEqual(['answer'])
    if (prepare) {
      expect(result.calls).toEqual([
        ['initiator', 'stable', '0'],
        ['responder', 'have-remote-offer', '1']
      ])
      expect(result.offerAudio).toMatch(/^a=recvonly\r?$/m)
      expect(result.answerAudio).toMatch(/^a=inactive\r?$/m)
    } else {
      expect(result.calls).toEqual([])
      expect(result.offerAudio).toBeNull()
      expect(result.answerAudio).toBeNull()
    }
  })
}
