import {joinRoom, selfId} from 'https://cdn.skypack.dev/trystero'

const byId = document.getElementById.bind(document)
const canvas = byId('canvas')
const peerInfo = byId('peer-info')
const noPeersCopy = peerInfo.innerText
const config = {appId: 'trystero-demo1'}
const cursors = {}
const fruits = [
  '🍏',
  '🍎',
  '🍐',
  '🍊',
  '🍋',
  '🍌',
  '🍉',
  '🍇',
  '🍓',
  '🫐',
  '🍈',
  '🍒',
  '🍑',
  '🥭',
  '🍍',
  '🥥',
  '🥝'
]
const randomFruit = () => Math.floor(Math.random() * fruits.length)

let mouseX = 0
let mouseY = 0
let room
let sendMove
let sendClick

init(49)
document.documentElement.className = 'ready'
addCursor(selfId, true)

addEventListener('mousemove', ({clientX, clientY}) => {
  mouseX = clientX / innerWidth
  mouseY = clientY / innerHeight
  moveCursor([mouseX, mouseY], selfId)
  if (room) {
    sendMove([mouseX, mouseY])
  }
})

addEventListener('click', () => {
  const payload = [randomFruit(), mouseX, mouseY]

  dropFruit(payload)
  if (room) {
    sendClick(payload)
  }
})

addEventListener('touchstart', e => {
  const x = e.touches[0].clientX / innerWidth
  const y = e.touches[0].clientY / innerHeight
  const payload = [randomFruit(), x, y]

  dropFruit(payload)
  moveCursor([x, y], selfId)

  if (room) {
    sendMove([x, y])
    sendClick(payload)
  }
})

function init(n) {
  let getMove
  let getClick

  room = joinRoom(config, 'room' + n)
  ;[sendMove, getMove] = room.makeAction('mouseMove')
  ;[sendClick, getClick] = room.makeAction('click')

  byId('room-num').innerText = 'room #' + n
  room.onPeerJoin(addCursor)
  room.onPeerLeave(removeCursor)
  getMove(moveCursor)
  getClick(dropFruit)
}

function moveCursor([x, y], id) {
  const el = cursors[id]

  if (el && typeof x === 'number' && typeof y === 'number') {
    el.style.left = x * innerWidth + 'px'
    el.style.top = y * innerHeight + 'px'
  }
}

function addCursor(id, isSelf) {
  const el = document.createElement('div')
  const img = document.createElement('img')
  const txt = document.createElement('p')

  el.className = `cursor${isSelf ? ' self' : ''}`
  el.style.left = el.style.top = '-99px'
  img.src = 'images/hand.png'
  txt.innerText = isSelf ? 'you' : id.slice(0, 4)
  el.appendChild(img)
  el.appendChild(txt)
  canvas.appendChild(el)
  cursors[id] = el

  if (!isSelf) {
    sendMove([Math.random() * 0.93, Math.random() * 0.93], id)
    updatePeerInfo()
  }

  return el
}

function removeCursor(id) {
  if (cursors[id]) {
    canvas.removeChild(cursors[id])
  }
  updatePeerInfo()
}

function updatePeerInfo() {
  const count = Object.keys(room.getPeers()).length
  peerInfo.innerHTML = count
    ? `Right now <em>${count}</em> other peer${
        count === 1 ? ' is' : 's are'
      } connected with you. Click to send them some fruit.`
    : noPeersCopy
}

function dropFruit([fruitIndex, x, y]) {
  const fruit = fruits[fruitIndex]
  if (!fruit || typeof x !== 'number' || typeof y !== 'number') {
    return
  }

  const el = document.createElement('div')
  el.className = 'fruit'
  el.innerText = fruit
  el.style.left = x * innerWidth + 'px'
  el.style.top = y * innerHeight + 'px'
  canvas.appendChild(el)
  setTimeout(() => canvas.removeChild(el), 3000)
}
