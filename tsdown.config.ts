import {resolve} from 'node:path'

const strategyNames = [
  'firebase',
  'ipfs',
  'mqtt',
  'nostr',
  'supabase',
  'torrent'
]
const ci = process.env['CI'] === 'true'
const coreSourcePath = resolve('packages/core/src/index.ts')
const dropDevLabelStatements = {
  inputOptions: {
    transform: {
      dropLabels: ['DEV']
    }
  }
}

const browserBundleConfigs = strategyNames.map((name, index) => ({
  workspace: false as const,
  entry: {
    [`trystero-${name}.min`]: `packages/${name}/src/index.ts`
  },
  outDir: 'dist',
  dts: false,
  format: 'es' as const,
  platform: 'browser' as const,
  sourcemap: true,
  minify: !process.env['NO_MINIFY'],
  noExternal: [/^@trystero\//],
  alias: {
    '@trystero/core': coreSourcePath
  },
  clean: index === 0,
  ...dropDevLabelStatements
}))

export default [
  {
    workspace: {
      include: ['packages/*'],
      exclude: ['packages/trystero']
    },
    entry: 'src/index.ts',
    dts: true,
    unbundle: true,
    sourcemap: true,
    exports: true,
    publint: ci,
    attw: ci,
    ...dropDevLabelStatements
  },
  {
    workspace: {
      include: ['packages/trystero']
    },
    entry: {
      index: 'src/index.ts',
      nostr: 'src/nostr.ts',
      torrent: 'src/torrent.ts',
      mqtt: 'src/mqtt.ts',
      ipfs: 'src/ipfs.ts',
      supabase: 'src/supabase.ts',
      firebase: 'src/firebase.ts'
    },
    dts: true,
    unbundle: true,
    sourcemap: true,
    exports: true,
    publint: ci,
    attw: ci,
    ...dropDevLabelStatements
  },
  ...browserBundleConfigs
]
