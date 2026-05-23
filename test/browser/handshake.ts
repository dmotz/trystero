import {expect} from '@playwright/test'
import {sleep, withStrategyBrowserPair} from './harness'
import {joinEagerRoom, leaveRoom} from './room-helpers'

export const registerHandshakeTests = (strategy, overrides) =>
  withStrategyBrowserPair(
    strategy,
    overrides,
    'handshake gating and timeout',
    async ({joinPairWithRetry, page, page2, roomConfig, selfId1, selfId2}) => {
      const {roomId: roomNs} = await joinPairWithRetry({
        label: 'handshake seed room join',
        makeRoomId: () =>
          `handshake-seed-${Math.random().toString().replace('.', '')}`,
        join: joinEagerRoom,
        makeArgs: nextRoomId => [nextRoomId, roomConfig, 33]
      })

      const handshakeRoomNs = roomNs + '-handshake'

      const setupHandshakeRoom = ([roomId, config, delayMs]) => {
        const state = {
          joinCount: 0,
          joinAt: 0,
          clearedAt: 0,
          earlyReceived: 0,
          joinErrors: []
        }
        const key = `hsState_${roomId}`
        const joinKey = `hsJoin_${roomId}`
        const postKey = `hsPost_${roomId}`
        const sendPostKey = `hsSendPost_${roomId}`
        let resolveJoin = null
        let resolvePost = null

        window[key] = state
        window[joinKey] = new Promise(res => (resolveJoin = res))
        window[postKey] = new Promise(res => (resolvePost = res))

        const room = window.trystero.joinRoom(config, roomId, {
          handshakeTimeoutMs: 8_000,
          onJoinError: details => state.joinErrors.push(details.error),
          onPeerHandshake: async (_, send, receive) => {
            const keyPair = await crypto.subtle.generateKey(
              {name: 'ECDSA', namedCurve: 'P-256'},
              true,
              ['sign', 'verify']
            )
            const challenge = crypto.getRandomValues(new Uint8Array(32))
            const signature = await crypto.subtle.sign(
              {name: 'ECDSA', hash: 'SHA-256'},
              keyPair.privateKey,
              challenge
            )
            const publicKey = await crypto.subtle.exportKey(
              'raw',
              keyPair.publicKey
            )

            await send({
              publicKey: Array.from(new Uint8Array(publicKey)),
              challenge: Array.from(challenge),
              signature: Array.from(new Uint8Array(signature))
            })

            const {data} = await receive()
            const packet = data

            if (
              !packet ||
              typeof packet !== 'object' ||
              !Array.isArray(packet.publicKey) ||
              !Array.isArray(packet.challenge) ||
              !Array.isArray(packet.signature)
            ) {
              throw new Error('invalid handshake payload')
            }

            const importedKey = await crypto.subtle.importKey(
              'raw',
              new Uint8Array(packet.publicKey),
              {name: 'ECDSA', namedCurve: 'P-256'},
              true,
              ['verify']
            )

            const didVerify = await crypto.subtle.verify(
              {name: 'ECDSA', hash: 'SHA-256'},
              importedKey,
              new Uint8Array(packet.signature),
              new Uint8Array(packet.challenge)
            )

            if (!didVerify) {
              throw new Error('peer key verification failed')
            }

            if (delayMs > 0) {
              await new Promise(res => setTimeout(res, delayMs))
            }

            state.clearedAt = Date.now()
          }
        })

        window[roomId] = room

        const earlyAction = room.makeAction('hsearly')
        const postAction = room.makeAction('hspost')

        window[sendPostKey] = payload => postAction.send(payload)

        earlyAction.onMessage = () => state.earlyReceived++

        postAction.onMessage = (payload, {peerId}) => {
          resolvePost?.([payload, peerId])
          resolvePost = null
        }

        room.onPeerJoin = peerId => {
          state.joinCount++
          state.joinAt = Date.now()
          resolveJoin?.(peerId)
          resolveJoin = null
        }

        setTimeout(() => earlyAction.send('early-message'), 100)
      }

      const readHandshakeState = roomId => {
        const state = window[`hsState_${roomId}`]

        return {
          ...state,
          peerCount: Object.keys(window[roomId].getPeers()).length
        }
      }

      const waitForHandshakeJoin = roomId => window[`hsJoin_${roomId}`]
      const waitForHandshakePost = roomId => window[`hsPost_${roomId}`]
      const sendHandshakePost = ([roomId, payload]) =>
        window[`hsSendPost_${roomId}`](payload)

      await Promise.all([
        page.evaluate(setupHandshakeRoom, [handshakeRoomNs, roomConfig, 0]),
        page2.evaluate(setupHandshakeRoom, [handshakeRoomNs, roomConfig, 1_500])
      ])

      await sleep(400)

      const [pendingState1, pendingState2] = await Promise.all([
        page.evaluate(readHandshakeState, handshakeRoomNs),
        page2.evaluate(readHandshakeState, handshakeRoomNs)
      ])

      expect(pendingState1.joinCount).toEqual(0)
      expect(pendingState1.peerCount).toEqual(0)
      expect(pendingState2.joinCount).toEqual(0)
      expect(pendingState2.peerCount).toEqual(0)

      const [joinPeer1, joinPeer2] = await Promise.all([
        page.evaluate(waitForHandshakeJoin, handshakeRoomNs),
        page2.evaluate(waitForHandshakeJoin, handshakeRoomNs)
      ])

      expect(joinPeer1).toEqual(selfId2)
      expect(joinPeer2).toEqual(selfId1)

      const [activeState1, activeState2] = await Promise.all([
        page.evaluate(readHandshakeState, handshakeRoomNs),
        page2.evaluate(readHandshakeState, handshakeRoomNs)
      ])

      expect(activeState1.joinErrors).toEqual([])
      expect(activeState2.joinErrors).toEqual([])
      expect(activeState1.peerCount).toEqual(1)
      expect(activeState2.peerCount).toEqual(1)
      expect(activeState1.earlyReceived).toEqual(0)
      expect(activeState2.earlyReceived).toEqual(0)
      expect(activeState1.clearedAt).toBeGreaterThan(0)
      expect(activeState2.clearedAt).toBeGreaterThan(0)
      expect(activeState1.joinAt).toBeGreaterThanOrEqual(activeState1.clearedAt)
      expect(activeState2.joinAt).toBeGreaterThanOrEqual(activeState2.clearedAt)

      await Promise.all([
        page.evaluate(sendHandshakePost, [handshakeRoomNs, 'from-page-1']),
        page2.evaluate(sendHandshakePost, [handshakeRoomNs, 'from-page-2'])
      ])

      const [postPayload1, postPayload2] = await Promise.all([
        page.evaluate(waitForHandshakePost, handshakeRoomNs),
        page2.evaluate(waitForHandshakePost, handshakeRoomNs)
      ])

      expect(postPayload1).toEqual(['from-page-2', selfId2])
      expect(postPayload2).toEqual(['from-page-1', selfId1])

      await Promise.all([
        page.evaluate(leaveRoom, handshakeRoomNs),
        page2.evaluate(leaveRoom, handshakeRoomNs)
      ])

      const timeoutRoomNs = roomNs + '-handshake-timeout'
      const runHandshakeTimeout = ([
        roomId,
        config,
        timeoutMs,
        waitMultiplier
      ]) =>
        new Promise(res => {
          const state = {joinCount: 0, errors: []}
          const maxWaitMultiplier =
            typeof waitMultiplier === 'number' ? waitMultiplier : 6
          const room = window.trystero.joinRoom(config, roomId, {
            handshakeTimeoutMs: timeoutMs,
            onJoinError: details => state.errors.push(details.error),
            onPeerHandshake: async (_, __, receive) => {
              await receive()
            }
          })

          window[roomId] = room
          room.onPeerJoin = () => state.joinCount++

          const start = Date.now()
          const waitForError = () => {
            if (
              state.errors.length > 0 ||
              Date.now() - start > timeoutMs * maxWaitMultiplier
            ) {
              res({
                ...state,
                peerCount: Object.keys(room.getPeers()).length
              })
              return
            }

            setTimeout(waitForError, 50)
          }

          waitForError()
        })

      const [timeoutState1, timeoutState2] = await Promise.all([
        page.evaluate(runHandshakeTimeout, [
          timeoutRoomNs,
          roomConfig,
          900,
          strategy === 'torrent' ? 14 : 6
        ]),
        page2.evaluate(runHandshakeTimeout, [
          timeoutRoomNs,
          roomConfig,
          900,
          strategy === 'torrent' ? 14 : 6
        ])
      ])

      const timeoutErrors = [...timeoutState1.errors, ...timeoutState2.errors]

      expect(timeoutState1.joinCount).toEqual(0)
      expect(timeoutState2.joinCount).toEqual(0)
      expect(timeoutState1.peerCount).toEqual(0)
      expect(timeoutState2.peerCount).toEqual(0)
      if (strategy === 'torrent') {
        if (timeoutErrors.length > 0) {
          expect(
            timeoutErrors.some(error => /handshake timed out/.test(error))
          ).toBe(true)
        }
      } else {
        expect(timeoutErrors.length).toBeGreaterThan(0)
        expect(
          timeoutErrors.some(error => /handshake timed out/.test(error))
        ).toBe(true)
      }

      await Promise.all([
        page.evaluate(leaveRoom, timeoutRoomNs),
        page2.evaluate(leaveRoom, timeoutRoomNs),
        page.evaluate(leaveRoom, roomNs),
        page2.evaluate(leaveRoom, roomNs)
      ])
    }
  )
