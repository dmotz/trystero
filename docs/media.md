# Audio, Video & Screen Sharing

[← Back to README](../README.md) · [API Reference](./api.md)

WebRTC was born for live media, and Trystero gets the SDP renegotiation
headaches out of your way: pass any browser `MediaStream` — microphone audio,
webcam video, screen capture, `<canvas>.captureStream()`, or Web Audio output —
straight to `room.addStream()`.

---

## Voice chatroom in 20 lines

```js
import {joinRoom} from 'trystero'

const room = joinRoom({appId: 'oedipa/walkie-talkie'}, 'channel-1')
const peerAudios = {}

// Grab microphone audio
const micStream = await navigator.mediaDevices.getUserMedia({
  audio: true,
  video: false
})

// Send to everyone already here, plus newcomers who join later
await room.addStream(micStream)
room.onUserJoin(({userId}) => room.addStream(micStream, {target: userId}))

// Play incoming audio streams
room.onPeerStream((stream, {userId}) => {
  const audio = peerAudios[userId] ?? new Audio()
  audio.srcObject = stream
  audio.autoplay = true
  peerAudios[userId] = audio
})

// Clean up when someone leaves
room.onUserLeave(({userId}) => {
  peerAudios[userId]?.pause()
  delete peerAudios[userId]
})
```

---

## Video & multiple streams per user (`metadata`)

What if a user shares **both** their webcam and their screen at the same time?
Pass a `metadata` object to `room.addStream()` so recipients know how to lay out
each stream:

```js
const camStream = await navigator.mediaDevices.getUserMedia({
  audio: true,
  video: true
})
const screenStream = await navigator.mediaDevices.getDisplayMedia({
  video: true
})

// Tag each stream so recipients can tell them apart
await room.addStream(camStream, {metadata: {kind: 'camera'}})
await room.addStream(screenStream, {metadata: {kind: 'screen'}})

room.onUserJoin(({userId}) => {
  room.addStream(camStream, {target: userId, metadata: {kind: 'camera'}})
  room.addStream(screenStream, {target: userId, metadata: {kind: 'screen'}})
})

room.onPeerStream((stream, {userId, metadata}) => {
  if (metadata?.kind === 'screen') {
    stageVideoElement.srcObject = stream
  } else {
    getTileForUser(userId).srcObject = stream
  }
})
```

If you call
`room.addStream(camStream, {metadata: {kind: 'camera', muted: true}})` again
with updated `metadata`, Trystero re-emits `onPeerStream` on recipients with the
fresh metadata automatically.

---

## Stopping streams, muting & switching cameras

### Stopping a stream (`removeStream`)

Stop transmitting a stream to everyone — or to a specific user/tab:

```js
room.removeStream(screenStream)

// Or stop sending only to one user:
room.removeStream(screenStream, {target: someUserId})
```

_(Remember to also call `track.stop()` on your local `MediaStreamTrack`s if you
want the browser's camera/screen-recording indicator light to turn off!)_

### Seamless camera switching (`replaceTrack`)

Want a user to switch from their laptop webcam to an external USB camera (or
flip front/back cameras on mobile) without a hitch? `room.replaceTrack()` swaps
the track right on the underlying WebRTC sender with **zero SDP renegotiation**:

```js
const oldVideoTrack = camStream.getVideoTracks()[0]

const nextCam = await navigator.mediaDevices.getUserMedia({
  video: {deviceId: {exact: selectedDeviceId}}
})
const newVideoTrack = nextCam.getVideoTracks()[0]

await room.replaceTrack(oldVideoTrack, newVideoTrack)
oldVideoTrack.stop()
```

### Adding or removing tracks on an existing stream

`room.addStream()` is **idempotent**: if you start an audio-only call and later
add a video track to that same `MediaStream` via `stream.addTrack(videoTrack)`,
just call `await room.addStream(stream)` again and Trystero syncs the added (or
removed) tracks across connected peers.

### Late UI subscribers (`{replay: true}`)

Mounting a video grid component after streams have already arrived? Pass
`{replay: true}` to `onPeerStream` to immediately receive all currently active
remote streams and their latest `metadata`:

```js
const unsub = room.onPeerStream(
  (stream, {userId, metadata}) => renderVideoTile(userId, stream, metadata),
  {replay: true}
)
```

<details>
  <summary>Deep dive: stream metadata pairing & multi-hop direct promotion</summary>

- **Deterministic stream-to-metadata pairing**: Native WebRTC `ontrack` events
  don't carry custom JSON metadata, and multi-track streams (`audio` + `video`)
  can fire `ontrack` incrementally. Before adding RTP tracks, `addStream()`
  transmits a compact internal metadata descriptor binding a stable stream UUID,
  the `MediaStream.id`, expected track count, and your custom `metadata`. The
  receiver correlates incoming `MediaStream`s and waits until expected tracks
  attach before firing `onPeerStream(stream, {userId, peerId, metadata})`, and
  automatically prunes inactive streams if tracks end or are removed.
- **Direct 1-hop promotion in `scale()` rooms**: When [`scale()`](./scaling.md)
  is enabled, calling `addStream()` or `replaceTrack()` targeting a multi-hop
  peer automatically negotiates a direct 1-hop WebRTC connection to that peer
  (pinning the direct link while media remains active) so audio and video flow
  straight peer-to-peer without decoding or re-encoding on intermediate
  browsers. Because WebRTC media is sent directly per recipient, media scales as
  a 1-to-N mesh for each broadcaster.

</details>
