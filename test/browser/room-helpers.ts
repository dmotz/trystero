export const joinEagerRoom = ([roomId, config, payload]) => {
  window[roomId] = window.trystero.joinRoom(config, roomId)

  const eagerAction = window[roomId].makeAction('eager')

  let didSend = false
  let sendInterval = null

  return new Promise(res => {
    eagerAction.onMessage(
      (received, ctx) => {
        clearInterval(sendInterval)
        res([received, ctx.peerId, ctx.metadata])
      },
      {once: true}
    )
    window[roomId].onPeerJoin(
      ({peerId}) => {
        if (!didSend) {
          const send = () =>
            eagerAction.send(payload, {target: peerId}).catch(() => {})

          send()
          sendInterval = setInterval(send, 333)
          window[roomId].__eagerSendInterval = sendInterval
          didSend = true
        }
      },
      {replay: true}
    )
  })
}

export const getPeerId = roomId => Object.keys(window[roomId].getPeers())[0]

export const joinRoomAndWaitForPeer = ([roomId, config, timeoutMs = 10_000]) =>
  new Promise((res, rej) => {
    const room = (window[roomId] = window.trystero.joinRoom(config, roomId))
    const existingPeer = Object.keys(room.getPeers())[0]

    if (existingPeer) {
      res(existingPeer)
      return
    }

    const timeout = setTimeout(() => {
      unsub()
      rej(new Error(`timed out joining ${roomId}`))
    }, timeoutMs)

    const unsub = room.onPeerJoin(
      ({peerId}) => {
        clearTimeout(timeout)
        res(peerId)
      },
      {once: true}
    )
  })

export const rejoinRoomAndWaitForPeer = async ([
  roomId,
  config,
  timeoutMs = 4_000,
  attempts = 4
]) => {
  let lastError = null
  const join = () =>
    new Promise((res, rej) => {
      const room = (window[roomId] = window.trystero.joinRoom(config, roomId))
      const existingPeer = Object.keys(room.getPeers())[0]

      if (existingPeer) {
        res(existingPeer)
        return
      }

      const timeout = setTimeout(() => {
        unsub()
        rej(new Error(`timed out joining ${roomId}`))
      }, timeoutMs)

      const unsub = room.onPeerJoin(
        ({peerId}) => {
          clearTimeout(timeout)
          res(peerId)
        },
        {once: true}
      )
    })

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await join()
    } catch (err) {
      lastError = err
      await window[roomId]?.leave?.().catch?.(() => {})
      await new Promise(res => setTimeout(res, 250 * attempt))
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

export const leaveRoom = roomId => window[roomId]?.leave()

export const ping = ([roomId, id]) => window[roomId].ping(id)
