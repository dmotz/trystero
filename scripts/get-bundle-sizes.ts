import {readFile} from 'node:fs/promises'
import {brotliCompress} from 'node:zlib'

const strategies = ['firebase', 'ipfs', 'mqtt', 'nostr', 'supabase', 'torrent']
const longestName = Math.max(...strategies.map(name => name.length))

const getBrotliSize = async (filePath: string): Promise<number> => {
  const content = await readFile(filePath)

  return new Promise<number>((resolve, reject) => {
    brotliCompress(content, (error, compressed) => {
      if (error) {
        reject(error)
        return
      }

      resolve(compressed.byteLength)
    })
  })
}

const sizes = await Promise.all(
  strategies.map(async strategy => [
    strategy,
    await getBrotliSize(`./dist/trystero-${strategy}.min.js`)
  ])
)

sizes.forEach(([strategy, size]) => {
  const label = `${strategy}:`.padEnd(longestName + 1, ' ')
  console.log(`${label} ${Math.round((size as number) / 1024)} KB`)
})
