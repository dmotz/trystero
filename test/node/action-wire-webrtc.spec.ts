import assert from 'node:assert/strict'
import test from './test.ts'
import {waitFor} from './peer-harness.ts'
import {RTCPeerConnection} from 'werift'
// @ts-expect-error Internal source import crosses a referenced package boundary.
import {createActionManager} from '../../packages/core/src/actions.ts'

void test(
  'action proposals and binary transfers work over a local WebRTC data channel',
  {timeout: 20_000},
  async t => {
    const config = {
      iceServers: [],
      iceAdditionalHostAddresses: ['127.0.0.1'],
      iceUseIpv4: false,
      iceUseIpv6: false
    }
    const sender = new RTCPeerConnection(config)
    const receiver = new RTCPeerConnection(config)
    const channel = sender.createDataChannel('actions')
    channel.bufferedAmountLowThreshold = 65_535
    let remoteChannel: typeof channel
    const toReceiver = {
      channel,
      sendData: (data: Uint8Array) => channel.send(Buffer.from(data)),
      destroy: () => {
        void sender.close()
      }
    }
    const toSender = {
      get channel() {
        return remoteChannel
      },
      sendData: (data: Uint8Array) => remoteChannel.send(Buffer.from(data)),
      destroy: () => {
        void receiver.close()
      }
    }
    const left = createActionManager({
      onPeerError: (id, error) => {
        left.clearPeer(id, error)
        void sender.close()
      },
      getPeer: () => toReceiver as never,
      getPeerIds: () => ['receiver'],
      canReceiveFromPeer: () => true
    })
    const right = createActionManager({
      onPeerError: (id, error) => {
        right.clearPeer(id, error)
        void receiver.close()
      },
      getPeer: () => toSender as never,
      getPeerIds: () => ['sender'],
      canReceiveFromPeer: () => true
    })
    t.after(async () => {
      left.clearPeer('receiver', new Error('test complete'))
      right.clearPeer('sender', new Error('test complete'))
      await Promise.all([sender.close(), receiver.close()])
    })
    channel.onmessage = event =>
      left.handleData('receiver', event.data as never)
    receiver.ondatachannel = event => {
      remoteChannel = event.channel
      remoteChannel.bufferedAmountLowThreshold = 65_535
      remoteChannel.onmessage = message =>
        right.handleData('sender', message.data as never)
    }
    await sender.setLocalDescription(await sender.createOffer())
    await receiver.setRemoteDescription(sender.localDescription!)
    await receiver.setLocalDescription(await receiver.createAnswer())
    await sender.setRemoteDescription(receiver.localDescription!)
    await waitFor(
      () =>
        channel.readyState === 'open' && remoteChannel?.readyState === 'open',
      10_000
    )

    const received: unknown[] = []
    const file = right.makeAction('file', {
      onReceive: ({byteLength}) => byteLength <= 300_000,
      onMessage: data => {
        received.push(data)
      }
    })
    const send = left.makeAction('file').send
    const payload = new Uint8Array(256_000).fill(42)
    await send(payload, {metadata: {name: 'test.bin'}})
    await waitFor(() => received.length === 1)
    assert.deepEqual(received, [payload])
    await assert.rejects(send(new Uint8Array(400_000)), {kind: 'rejected'})
    file.onReceive = null
    await send('still connected')
    await waitFor(() => received.length === 2)
    assert.equal(received.at(-1), 'still connected')
  }
)
