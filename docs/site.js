import {joinRoom, selfId} from 'https://cdn.skypack.dev/trystero'

const canvas = document.getElementById('canvas')
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

  cursors[id] = el
  return el
}

function removeCursor(id) {
  const el = cursors[id]

  if (el) {
    canvas.removeChild(el)
  }
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
