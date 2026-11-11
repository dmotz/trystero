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

const maxBundleKb: Record<
  (typeof strategies)[number],
  Record<(typeof variants)[number]['name'], number>
> = {
  'ws-relay': {
    core: 42.5,
    'core+roles': 48.0,
    'core+scale': 55.0,
    'core+both': 60.5
  },
  torrent: {
    core: 44.0,
    'core+roles': 49.0,
    'core+scale': 56.0,
    'core+both': 61.5
  },
  nostr: {
    core: 47.5,
    'core+roles': 53.0,
    'core+scale': 60.0,
    'core+both': 65.0
  },
  firebase: {
    core: 83.0,
    'core+roles': 88.0,
    'core+scale': 95.5,
    'core+both': 100.5
  },
  supabase: {
    core: 87.0,
    'core+roles': 92.5,
    'core+scale': 99.5,
    'core+both': 104.5
  },
  mqtt: {
    core: 123.0,
    'core+roles': 128.5,
    'core+scale': 135.5,
    'core+both': 140.5
  }
}

const checkBudget = process.argv.includes('--check')

const tempDir = await mkdtemp(join(tmpdir(), 'trystero-bundle-sizes-'))
const coreSourcePath = resolve('packages/core/src/index.ts')
const coreTypesSourcePath = resolve('packages/core/src/types.ts')
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
          '@trystero-p2p/core/types': coreTypesSourcePath,
          '@trystero-p2p/core': coreSourcePath,
          crypto: empty,
          'node:crypto': empty
        }
      })
    )
  )

  const headers = ['strategy', ...variants.map(v => v.name)]
  const rows: string[][] = []
  const violations: string[] = []

  for (const strategy of strategies) {
    const row: string[] = [strategy]
    for (const variant of variants) {
      const key = `${strategy}__${variant.name.replace(/\+/g, '_')}`
      const bytes = await getBrotliSize(join(tempDir, `${key}.js`))
      row.push(formatKb(bytes))
      const limitKb = maxBundleKb[strategy][variant.name]
      if (checkBudget && bytes > limitKb * 1024) {
        violations.push(
          `${strategy} (${variant.name}): ${formatKb(bytes)} exceeds budget ${limitKb.toFixed(1)} KB`
        )
      }
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

  if (violations.length > 0) {
    console.error('\nBundle size budget exceeded:')
    for (const v of violations) {
      console.error(`  - ${v}`)
    }
    process.exitCode = 1
  }
} finally {
  await rm(tempDir, {recursive: true, force: true})
}
