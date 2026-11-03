import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {brotliCompress} from 'node:zlib'
import {build} from 'tsdown'

const strategies = [
  'firebase',
  'mqtt',
  'nostr',
  'supabase',
  'torrent',
  'ws-relay'
] as const

const variants = [
  {
    name: 'core',
    exports:
      'joinRoom, createUserIdentity, importUserIdentity, exportUserIdentity, clearUserIdentity'
  },
  {
    name: 'core+roles',
    exports:
      'joinRoom, createUserIdentity, importUserIdentity, exportUserIdentity, clearUserIdentity, roles'
  },
  {
    name: 'core+scale',
    exports:
      'joinRoom, createUserIdentity, importUserIdentity, exportUserIdentity, clearUserIdentity, scale'
  },
  {
    name: 'core+both',
    exports: '*'
  }
] as const

const getBrotliSize = async (filePath: string): Promise<number> => {
  const content = await readFile(filePath)

  return new Promise<number>((resolvePromise, reject) => {
    brotliCompress(content, (error, compressed) => {
      if (error) {
        reject(error)
        return
      }

      resolvePromise(compressed.byteLength)
    })
  })
}

const formatKb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`

const tempDir = await mkdtemp(join(tmpdir(), 'trystero-bundle-sizes-'))
const coreSourcePath = resolve('packages/core/src/index.ts')
const empty = resolve('scripts/empty.ts')

try {
  const entryMap: Record<string, string> = {}

  for (const strategy of strategies) {
    const strategyEntry = resolve(`packages/${strategy}/src/index.ts`)
    for (const variant of variants) {
      const key = `${strategy}__${variant.name.replace(/\+/g, '_')}`
      const entryFile = join(tempDir, `${key}.ts`)
      const code =
        variant.exports === '*'
          ? `export * from ${JSON.stringify(strategyEntry)}\n`
          : `export {${variant.exports}} from ${JSON.stringify(strategyEntry)}\n`
      await writeFile(entryFile, code)
      entryMap[key] = entryFile
    }
  }

  await Promise.all(
    Object.entries(entryMap).map(([key, entryFile]) =>
      build({
        config: false,
        clean: false,
        entry: {[key]: entryFile},
        outDir: tempDir,
        dts: false,
        format: 'es',
        platform: 'browser',
        sourcemap: false,
        minify: true,
        logLevel: 'silent',
        deps: {
          alwaysBundle: [/^@trystero-p2p\//],
          onlyBundle: false
        },
        alias: {
          '@trystero-p2p/core': coreSourcePath,
          crypto: empty,
          'node:crypto': empty
        },
        inputOptions: {
          transform: {
            dropLabels: ['DEV']
          }
        }
      })
    )
  )

  const headers = ['strategy', ...variants.map(v => v.name)]
  const rows: string[][] = []

  for (const strategy of strategies) {
    const row: string[] = [strategy]
    for (const variant of variants) {
      const key = `${strategy}__${variant.name.replace(/\+/g, '_')}`
      const bytes = await getBrotliSize(join(tempDir, `${key}.js`))
      row.push(formatKb(bytes))
    }
    rows.push(row)
  }

  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => r[i]!.length))
  )

  const formatRow = (cols: string[]) =>
    cols
      .map((c, i) =>
        i === 0 ? c.padEnd(colWidths[i]!) : c.padStart(colWidths[i]!)
      )
      .join('   ')

  console.log(formatRow(headers))
  console.log(colWidths.map(w => '-'.repeat(w)).join('   '))
  for (const row of rows) {
    console.log(formatRow(row))
  }
} finally {
  await rm(tempDir, {recursive: true, force: true})
}
