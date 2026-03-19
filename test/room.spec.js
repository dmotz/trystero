import {test, expect} from '@playwright/test'
import room from '../src/room.js'

test('room.leave() calls onPeerLeave for each peer', async () => {
  let onPeerJoin
  const onPeerLeaveCalls = []
  const onSelfLeaveCalls = []

  const roomApi = room(
    f => {
      onPeerJoin = f
    },
    id => onPeerLeaveCalls.push(id),
    () => onSelfLeaveCalls.push('self')
  )

  const makePeer = () => ({
    channel: {
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0xffff,
      addEventListener() {},
      removeEventListener() {}
    },
    sendData() {},
    destroy: () => {},
    setHandlers: () => {}
  })

  onPeerJoin(makePeer(), 'p1')
  onPeerJoin(makePeer(), 'p2')

  const originalSetTimeout = globalThis.setTimeout
  try {
    globalThis.setTimeout = cb => {
      cb()
      return 1
    }

    await roomApi.leave()
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }

  expect(onPeerLeaveCalls).toEqual(['p1', 'p2'])
  expect(onSelfLeaveCalls).toEqual(['self'])
})

