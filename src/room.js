import {
  combineChunks,
  decodeBytes,
  encodeBytes,
  entries,
  events,
  keys,
  libName,
  mkErr,
  noOp
} from './utils.js'

const TypedArray = Object.getPrototypeOf(Uint8Array)
const typeByteLimit = 12
const typeIndex = 0
const nonceIndex = typeIndex + typeByteLimit
const tagIndex = nonceIndex + 1
const progressIndex = tagIndex + 1
const payloadIndex = progressIndex + 1
const chunkSize = 16 * 2 ** 10 - payloadIndex
const oneByteMax = 0xff
const buffLowEvent = 'bufferedamountlow'

export default (onPeer, onSelfLeave) => {
  const peerMap = {}
  const actions = {}
  const pendingTransmissions = {}
  const pendingPongs = {}
  const pendingStreamMetas = {}
  const pendingTrackMetas = {}

  const iterate = (targets, f) =>
    (targets
      ? Array.isArray(targets)
        ? targets
        : [targets]
      : keys(peerMap)
    ).flatMap(id => {
      const peer = peerMap[id]

      if (!peer) {
        console.warn(`${libName}: no peer with id ${id} found`)
        return []
      }

      return f(id, peer)
    })

  const exitPeer = id => {
    if (!peerMap[id]) {
      return
    }

    delete peerMap[id]
    delete pendingTransmissions[id]
    delete pendingPongs[id]
    onPeerLeave(id)
  }

  const makeAction = type => {
    if (!type) {
      throw mkErr('action type argument is required')
    }

    const typeEncoded = encodeBytes(type)

    if (typeEncoded.byteLength > typeByteLimit) {
      throw mkErr(
        `action type string "${type}" (${typeEncoded.byteLength}b) exceeds ` +
          `byte limit (${typeByteLimit}). Hint: choose a shorter name.`
      )
    }

    const typeBytes = new Uint8Array(typeByteLimit)
    typeBytes.set(typeEncoded)

    const typePadded = decodeBytes(typeBytes)

    if (actions[typePadded]) {
      throw mkErr(`action '${type}' already registered`)
    }

    let nonce = 0

    actions[typePadded] = {onComplete: noOp, onProgress: noOp}

    return [
      async (data, targets, meta, onProgress) => {
        if (meta && typeof meta !== 'object') {
          throw mkErr('action meta argument must be an object')
        }

        if (data === undefined) {
          throw mkErr('action data cannot be undefined')
        }

        const isJson = typeof data !== 'string'
        const isBlob = data instanceof Blob
        const isBinary =
          isBlob || data instanceof ArrayBuffer || data instanceof TypedArray

        if (meta && !isBinary) {
          throw mkErr('action meta argument can only be used with binary data')
        }

        const buffer = isBinary
          ? new Uint8Array(isBlob ? await data.arrayBuffer() : data)
          : encodeBytes(isJson ? JSON.stringify(data) : data)

        const metaEncoded = meta ? encodeBytes(JSON.stringify(meta)) : null

        const chunkTotal =
          Math.ceil(buffer.byteLength / chunkSize) + (meta ? 1 : 0)

        const chunks = new Array(chunkTotal).fill().map((_, i) => {
          const isLast = i === chunkTotal - 1
          const isMeta = meta && i === 0
          const chunk = new Uint8Array(
            payloadIndex +
              (isMeta
                ? metaEncoded.byteLength
                : isLast
                ? buffer.byteLength - chunkSize * (chunkTotal - (meta ? 2 : 1))
                : chunkSize)
          )

          chunk.set(typeBytes)
          chunk.set([nonce], nonceIndex)
          chunk.set(
            [isLast | (isMeta << 1) | (isBinary << 2) | (isJson << 3)],
            tagIndex
          )
          chunk.set(
            [Math.round(((i + 1) / chunkTotal) * oneByteMax)],
            progressIndex
          )
          chunk.set(
            meta
              ? isMeta
                ? metaEncoded
                : buffer.subarray((i - 1) * chunkSize, i * chunkSize)
              : buffer.subarray(i * chunkSize, (i + 1) * chunkSize),
            payloadIndex
          )

          return chunk
        })

        nonce = (nonce + 1) & oneByteMax

        return Promise.all(
          iterate(targets, async (id, peer) => {
            const chan = peer._channel
            let chunkN = 0

            while (chunkN < chunkTotal) {
              const chunk = chunks[chunkN]

              if (chan.bufferedAmount > chan.bufferedAmountLowThreshold) {
                await new Promise(res => {
                  const next = () => {
                    chan.removeEventListener(buffLowEvent, next)
                    res()
                  }

                  chan.addEventListener(buffLowEvent, next)
                })
              }

              if (!peerMap[id]) {
                break
              }

              peer.send(chunk)
              chunkN++

              if (onProgress) {
                onProgress(chunk[progressIndex] / oneByteMax, id, meta)
              }
            }
          })
        )
      },

      onComplete =>
        (actions[typePadded] = {...actions[typePadded], onComplete}),

      onProgress => (actions[typePadded] = {...actions[typePadded], onProgress})
    ]
  }

  const handleData = (id, data) => {
    const buffer = new Uint8Array(data)
    const type = decodeBytes(buffer.subarray(typeIndex, nonceIndex))
    const [nonce] = buffer.subarray(nonceIndex, tagIndex)
    const [tag] = buffer.subarray(tagIndex, progressIndex)
    const [progress] = buffer.subarray(progressIndex, payloadIndex)
    const payload = buffer.subarray(payloadIndex)
    const isLast = !!(tag & 1)
    const isMeta = !!(tag & (1 << 1))
    const isBinary = !!(tag & (1 << 2))
    const isJson = !!(tag & (1 << 3))

    if (!actions[type]) {
      throw mkErr(`received message with unregistered type (${type})`)
    }

    if (!pendingTransmissions[id]) {
      pendingTransmissions[id] = {}
    }

    if (!pendingTransmissions[id][type]) {
      pendingTransmissions[id][type] = {}
    }

    let target = pendingTransmissions[id][type][nonce]

    if (!target) {
      target = pendingTransmissions[id][type][nonce] = {chunks: []}
    }

    if (isMeta) {
      target.meta = JSON.parse(decodeBytes(payload))
    } else {
      target.chunks.push(payload)
    }

    actions[type].onProgress(progress / oneByteMax, id, target.meta)

    if (!isLast) {
      return
    }

    const full = combineChunks(target.chunks)

    if (isBinary) {
      actions[type].onComplete(full, id, target.meta)
    } else {
      const text = decodeBytes(full)
      actions[type].onComplete(isJson ? JSON.parse(text) : text, id)
    }

    delete pendingTransmissions[id][type][nonce]
  }

  const [sendPing, getPing] = makeAction('__91n6__')
  const [sendPong, getPong] = makeAction('__90n6__')
  const [sendSignal, getSignal] = makeAction('__516n4L__')
  const [sendStreamMeta, getStreamMeta] = makeAction('__57r34m__')
  const [sendTrackMeta, getTrackMeta] = makeAction('__7r4ck__')

  let onPeerJoin = noOp
  let onPeerLeave = noOp
  let onPeerStream = noOp
  let onPeerTrack = noOp

  onPeer((peer, id) => {
    if (peerMap[id]) {
      return
    }

    const onData = handleData.bind(null, id)

    peerMap[id] = peer

    peer.on(events.signal, sdp => sendSignal(sdp, id))
    peer.on(events.close, () => exitPeer(id))
    peer.on(events.data, onData)

    peer.on(events.stream, stream => {
      onPeerStream(stream, id, pendingStreamMetas[id])
      delete pendingStreamMetas[id]
    })

    peer.on(events.track, (track, stream) => {
      onPeerTrack(track, stream, id, pendingTrackMetas[id])
      delete pendingTrackMetas[id]
    })

    peer.on(events.error, e => {
      if (e.code === 'ERR_DATA_CHANNEL') {
        return
      }
      console.error(e)
    })

    onPeerJoin(id)
    peer.__drainEarlyData(onData)
  })

  getPing((_, id) => sendPong(null, id))

  getPong((_, id) => {
    if (pendingPongs[id]) {
      pendingPongs[id]()
      delete pendingPongs[id]
    }
  })

  getSignal((sdp, id) => {
    if (peerMap[id]) {
      peerMap[id].signal(sdp)
    }
  })

  getStreamMeta((meta, id) => (pendingStreamMetas[id] = meta))

  getTrackMeta((meta, id) => (pendingTrackMetas[id] = meta))

  return {
    makeAction,

    ping: async id => {
      if (!id) {
        throw mkErr('ping() must be called with target peer ID')
      }

      const start = Date.now()
      sendPing(null, id)
      await new Promise(res => (pendingPongs[id] = res))
      return Date.now() - start
    },

    leave: () => {
      entries(peerMap).forEach(([id, peer]) => {
        peer.destroy()
        delete peerMap[id]
      })
      onSelfLeave()
    },

    getPeers: () => keys(peerMap),

    addStream: (stream, targets, meta) =>
      iterate(targets, async (id, peer) => {
        if (meta) {
          await sendStreamMeta(meta, id)
        }

        peer.addStream(stream)
      }),

    removeStream: (stream, targets) =>
      iterate(targets, (_, peer) => peer.removeStream(stream)),

    addTrack: (track, stream, targets, meta) =>
      iterate(targets, async (id, peer) => {
        if (meta) {
          await sendTrackMeta(meta, id)
        }

        peer.addTrack(track, stream)
      }),

    removeTrack: (track, stream, targets) =>
      iterate(targets, (_, peer) => peer.removeTrack(track, stream)),

    replaceTrack: (oldTrack, newTrack, stream, targets, meta) =>
      iterate(targets, async (id, peer) => {
        if (meta) {
          await sendTrackMeta(meta, id)
        }

        peer.replaceTrack(oldTrack, newTrack, stream)
      }),

    onPeerJoin: f => (onPeerJoin = f),

    onPeerLeave: f => (onPeerLeave = f),

    onPeerStream: f => (onPeerStream = f),

    onPeerTrack: f => (onPeerTrack = f)
  }
}
