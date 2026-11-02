import {resolve} from 'node:path'

const testBuild = process.env['TEST_BUILD'] === '1'

const strategyNames = [
  'firebase',
  'mqtt',
  'nostr',
  'supabase',
  'torrent',
  'ws-relay'
]
const ci = process.env['CI'] === 'true'
const coreSourcePath = resolve('packages/core/src/index.ts')
const corePublicSourcePath = resolve('packages/core/src/public.ts')
const empty = resolve('scripts/empty.ts')
const packageDepsConfig = {
  deps: {
    skipNodeModulesBundle: true
  }
}

const browserBundleDepsConfig = {
  deps: {
    alwaysBundle: [/^@trystero-p2p\//],
    onlyBundle: false
  }
}

const dropDevLabelStatements = testBuild
  ? {}
  : {
      inputOptions: {
        transform: {
          dropLabels: ['DEV']
        }
      }
    }

export default [
  {
    workspace: {
      include: ['packages/core']
    },
    entry: {
      index: 'src/index.ts',
      public: 'src/public.ts'
    },
    dts: {generator: 'oxc'},
    unbundle: true,
    sourcemap: false,
    minify: false,
    ...packageDepsConfig,
    publint: ci,
    attw: ci,
    ...dropDevLabelStatements
  },
  {
    workspace: {
      include: ['packages/ws-relay']
    },
    entry: {
      index: 'src/index.ts',
      server: 'src/server.ts'
    },
    dts: {generator: 'oxc'},
    unbundle: true,
    sourcemap: false,
    minify: false,
    ...packageDepsConfig,
    publint: ci,
    attw: ci,
    ...dropDevLabelStatements
  },
  {
    workspace: {
      include: ['packages/*'],
      exclude: ['packages/core', 'packages/ws-relay']
    },
    entry: 'src/index.ts',
    dts: {generator: 'oxc'},
    unbundle: true,
    sourcemap: false,
    minify: false,
    ...packageDepsConfig,
    publint: ci,
    attw: ci,
    ...dropDevLabelStatements
  },
  ...(testBuild
    ? strategyNames.map((name, index) => ({
        workspace: false as const,
        entry: {
          [`trystero-${name}`]: `packages/${name}/src/index.ts`
        },
        outDir: 'test/dist',
        dts: false,
        format: 'es' as const,
        platform: 'browser' as const,
        sourcemap: true,
        minify: false,
        ...browserBundleDepsConfig,
        alias: {
          '@trystero-p2p/core/public': corePublicSourcePath,
          '@trystero-p2p/core': coreSourcePath,
          crypto: empty,
          'node:crypto': empty
        },
        clean: index === 0
      }))
    : [])
]
