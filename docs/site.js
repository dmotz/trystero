// eslint-disable-next-line
import {joinRoom, selfId} from 'https://cdn.skypack.dev/trystero'

const byId = document.getElementById.bind(document)
const canvas = byId('canvas')
const peerInfo = byId('peer-info')
const noPeersCopy = peerInfo.innerText
const cursors = {}
const room = joinRoom({appId: 'trystero-94db3'}, '101')
const [sendMove, getMove] = room.makeAction('mouseMove')
const [sendClick, getClick] = room.makeAction('click')
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

let mouseX = 0
let mouseY = 0

room.onPeerJoin(addCursor)
room.onPeerLeave(removeCursor)
addCursor(selfId, true)
getMove(moveCursor)
getClick(dropFruit)

window.addEventListener('mousemove', ({clientX, clientY}) => {
  mouseX = clientX / window.innerWidth
  mouseY = clientY / window.innerHeight
  moveCursor([mouseX, mouseY], selfId)
  sendMove([mouseX, mouseY])
})

window.addEventListener('click', () => {
  const payload = [
    fruits[Math.floor(Math.random() * fruits.length)],
    mouseX,
    mouseY
  ]

  dropFruit(payload)
  sendClick(payload)
})

window.addEventListener('touchstart', e => {
  const x = e.touches[0].clientX / window.innerWidth
  const y = e.touches[0].clientY / window.innerHeight
  const payload = [fruits[Math.floor(Math.random() * fruits.length)], x, y]

  dropFruit(payload)
  sendMove([x, y])
  sendClick(payload)
  moveCursor([x, y], selfId)
})

function moveCursor([x, y], id) {
  const el = cursors[id]

  if (el) {
    el.style.left = x * window.innerWidth + 'px'
    el.style.top = y * window.innerHeight + 'px'
  }
}

function addCursor(id, isSelf) {
  const el = document.createElement('div')
  const img = document.createElement('img')
  const txt = document.createElement('p')

  el.className = `cursor${isSelf ? ' self' : ''}`
  img.src = 'images/hand.png'
  txt.innerText = isSelf ? 'you' : id.slice(0, 4)
  el.appendChild(img)
  el.appendChild(txt)
  canvas.appendChild(el)
  updatePeerInfo()
  cursors[id] = el

  return el
}

function removeCursor(id) {
  if (cursors[id]) {
    canvas.removeChild(cursors[id])
  }
  updatePeerInfo()
}

function updatePeerInfo() {
  const count = room.getPeers().length
  peerInfo.innerHTML = count
    ? `Right now <em>${count}</em> other peer${
        count === 1 ? ' is' : 's are'
      } connected with you.`
    : noPeersCopy
}

function dropFruit([fruit, x, y]) {
  const el = document.createElement('div')
  el.className = 'treat'
  el.innerText = fruit
  el.style.left = x * window.innerWidth + 'px'
  el.style.top = y * window.innerHeight + 'px'
  canvas.appendChild(el)
  setTimeout(() => canvas.removeChild(el), 3000)
}
