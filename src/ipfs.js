import {create} from 'ipfs'
import Peer from 'simple-peer-light'
import room from './room'
import {
  combineChunks,
  decodeBytes,
  events,
  fromEntries,
  initGuard,
  libName,
  noOp,
  selfId,
  values
} from './utils'

const occupiedRooms = {}
const pollMs = 999

const init = () => nodeP || (nodeP = create())

let nodeP

export const joinRoom = initGuard(occupiedRooms, (config, ns) => {
  const offers = {}
  const path = `/${libName.toLowerCase()}/${config.appId}/${ns}`

  let onPeerConnect = noOp
  let rootPoll
  let selfPoll

  init().then(async node => {
    const selfPath = `${path}/${selfId}`
    const seenFiles = {}

    const listFiles = async path => {
      const files = []
      for await (const file of node.files.ls(path)) {
        files.push(file)
      }
      return files
    }

    const checkSelf = async () => {
      ;(await listFiles(selfPath)).forEach(async file => {
        if (file.type !== 0 || seenFiles[selfPath + file.name]) {
          return
        }

        seenFiles[selfPath + file.name] = true

        const peerId = file.name
        const chunks = []

        for await (const chunk of node.files.read(`${selfPath}/${file.name}`)) {
          chunks.push(chunk)
        }

        let parsed

        try {
          parsed = JSON.parse(decodeBytes(combineChunks(chunks)))
        } catch (e) {
          console.error(`${libName}: received malformed SDP JSON`)
        }

        if (offers[peerId]) {
          offers[peerId].signal(parsed)
          return
        }

        const answerPath = `${path}/${peerId}/${selfId}`
        const peer = new Peer({initiator: false, trickle: false})

        peer.once(events.signal, answer =>
          node.files.write(answerPath, JSON.stringify(answer), {create: true})
        )
        peer.on(events.connect, () => {
          onPeerConnect(peer, peerId)
          node.files.rm(answerPath)
        })
        peer.signal(parsed)
      })
    }

    await node.files.mkdir(path, {parents: true})

    const [files] = await Promise.all([
      listFiles(path),
      node.files.mkdir(selfPath, {parents: true})
    ])

    const staleDirs = fromEntries(values(files).map(f => [f.name, true]))

    checkSelf()

    selfPoll = setInterval(checkSelf, pollMs)
    rootPoll = setInterval(async () => {
      ;(await listFiles(path)).forEach(file => {
        if (staleDirs[file.name] || seenFiles[path + file.name]) {
          return
        }

        seenFiles[path + file.name] = true

        const peerId = file.name

        if (file.type === 0 || peerId === selfId) {
          return
        }

        const offerPath = `${path}/${peerId}/${selfId}`
        const peer = (offers[peerId] = new Peer({
          initiator: true,
          trickle: false
        }))

        peer.once(events.signal, offer =>
          node.files.write(offerPath, JSON.stringify(offer), {create: true})
        )
        peer.on(events.connect, () => {
          onPeerConnect(peer, peerId)
          node.files.rm(offerPath)
        })
      })
    }, pollMs)
  })

  return room(
    f => (onPeerConnect = f),
    () => {
      clearInterval(selfPoll)
      clearInterval(rootPoll)
    }
  )
})

export {selfId} from './utils'
