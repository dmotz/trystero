import {readFile} from 'fs/promises'
import {brotliCompress} from 'zlib'

const pkgs = ['firebase', 'ipfs', 'mqtt', 'nostr', 'supabase', 'torrent']
const longest = pkgs.sort((a, b) => b.length - a.length)[0].length

Promise.all(
  pkgs.map(pkg =>
    readFile(`./dist/trystero-${pkg}.min.js`).then(
      content =>
        new Promise(res =>
          brotliCompress(content, (_, bytes) => res([pkg, bytes.length]))
        )
    )
  )
).then(sizes =>
  sizes.forEach(([pkg, size]) =>
    console.log(
      `${(pkg + ':').padEnd(longest + 1, ' ')} ${Math.round(size / 1024)} KB`
    )
  )
)
