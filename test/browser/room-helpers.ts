import type {StrategyConfig} from '../strategy-configs'

export const joinEagerRoom = ([roomId, config, payload]: [
  string,
  StrategyConfig,
  unknown
]): Promise<[unknown, string, unknown]> => {
  window[roomId] = window.trystero.joinRoom(config, roomId)

  const eagerAction = window[roomId].makeAction('eager')

  let didSend = false
  let sendInterval: ReturnType<typeof setInterval> | undefined

  return new Promise(res => {
    eagerAction.onMessage(
      (received: unknown, ctx: {peerId: string; metadata?: unknown}) => {
        clearInterval(sendInterval)
        res([received, ctx.peerId, ctx.metadata])
      },
      {once: true}
    )
    window[roomId].onPeerJoin(
      ({peerId}: {peerId: string}) => {
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

export const getPeerId = (roomId: string): string | undefined =>
  Object.keys(window[roomId].getPeers())[0]

export const joinRoomAndWaitForPeer = ([roomId, config, timeoutMs = 10_000]: [
  string,
  StrategyConfig,
  number?
]): Promise<string> =>
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
      ({peerId}: {peerId: string}) => {
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
]: [string, StrategyConfig, number?, number?]): Promise<string> => {
  let lastError: unknown = null
  const join = () =>
    new Promise<string>((res, rej) => {
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
        ({peerId}: {peerId: string}) => {
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

export const leaveRoom = (roomId: string): Promise<void> | undefined =>
  window[roomId]?.leave()

export const ping = ([roomId, id]: [string, string]): Promise<number> =>
  window[roomId].ping(id)
