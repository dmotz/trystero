// @ts-nocheck
import assert from 'node:assert/strict'
import test from 'node:test'
import {joinRoom} from '../../packages/torrent/src/index.ts'
import {MockRTCPeerConnection, wait} from './peer-harness.ts'

class MockWebSocket {
  static sockets = []

  readyState = 0
  sent = []
  onopen = null
  onclose = null
  onmessage = null
  url

  constructor(url) {
    this.url = url
    MockWebSocket.sockets.push(this)

    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.()
    })
  }

  send(data) {
    const msg = JSON.parse(data)
    this.sent.push(msg)

    if (msg.action === 'announce') {
      queueMicrotask(() =>
        this.onmessage?.({
          data: JSON.stringify({info_hash: msg.info_hash, interval: 120})
        })
      )
    }
  }

  close() {
    this.readyState = 3
    this.onclose?.()
  }
}

void test(
  'Trystero: torrent uses one warmup scheduler and honors tracker intervals',
  {timeout: 12_000},
  async () => {
    const originalWebSocket = globalThis.WebSocket
    MockWebSocket.sockets.length = 0
    globalThis.WebSocket = MockWebSocket

    const room = joinRoom(
      {
        appId: `torrent-announcement-rate-${Date.now()}`,
        relayConfig: {urls: [`wss://torrent-rate-${Date.now()}.test`]},
        rtcPolyfill: MockRTCPeerConnection
      },
      'room'
    )

    try {
      await wait(2_500)
      const socket = MockWebSocket.sockets[0]

      assert.equal(
        socket.sent.length,
        4,
        'torrent should retain the core startup burst without a duplicate scheduler'
      )

      await wait(5_500)
      assert.equal(
        socket.sent.length,
        4,
        'the tracker-requested 120-second interval should suppress steady chatter'
      )
    } finally {
      await room.leave().catch(() => {})
      globalThis.WebSocket = originalWebSocket
    }
  }
)

void test(
  'Trystero: torrent keeps one low-rate registration for passive rooms',
  {timeout: 5_000},
  async () => {
    const originalWebSocket = globalThis.WebSocket
    MockWebSocket.sockets.length = 0
    globalThis.WebSocket = MockWebSocket

    const room = joinRoom(
      {
        appId: `torrent-passive-rate-${Date.now()}`,
        passive: true,
        relayConfig: {urls: [`wss://torrent-passive-${Date.now()}.test`]},
        rtcPolyfill: MockRTCPeerConnection
      },
      'room'
    )

    try {
      await wait(1_000)
      assert.equal(
        MockWebSocket.sockets[0].sent.length,
        1,
        'passive rooms must register with the tracker without joining the active warmup'
      )
    } finally {
      await room.leave().catch(() => {})
      globalThis.WebSocket = originalWebSocket
    }
  }
)
