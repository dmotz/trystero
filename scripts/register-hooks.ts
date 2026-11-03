import {registerHooks} from 'node:module'

const workspaceSrcUrls: Record<string, string> = {
  '@trystero-p2p/core': new URL(
    '../packages/core/src/index.ts',
    import.meta.url
  ).href,
  '@trystero-p2p/firebase': new URL(
    '../packages/firebase/src/index.ts',
    import.meta.url
  ).href,
  '@trystero-p2p/mqtt': new URL(
    '../packages/mqtt/src/index.ts',
    import.meta.url
  ).href,
  '@trystero-p2p/nostr': new URL(
    '../packages/nostr/src/index.ts',
    import.meta.url
  ).href,
  '@trystero-p2p/supabase': new URL(
    '../packages/supabase/src/index.ts',
    import.meta.url
  ).href,
  '@trystero-p2p/torrent': new URL(
    '../packages/torrent/src/index.ts',
    import.meta.url
  ).href,
  '@trystero-p2p/ws-relay': new URL(
    '../packages/ws-relay/src/index.ts',
    import.meta.url
  ).href,
  '@trystero-p2p/ws-relay/server': new URL(
    '../packages/ws-relay/src/server.ts',
    import.meta.url
  ).href,
  trystero: new URL('../packages/trystero/src/index.ts', import.meta.url).href
}

const isRelativeOrFileSpecifier = (specifier: string): boolean =>
  specifier.startsWith('./') ||
  specifier.startsWith('../') ||
  specifier.startsWith('/') ||
  specifier.startsWith('file://')

const isMissingModuleError = (err: unknown): boolean => {
  if (!err || typeof err !== 'object' || !('code' in err)) {
    return false
  }

  return (
    err.code === 'ERR_MODULE_NOT_FOUND' ||
    err.code === 'ERR_UNSUPPORTED_DIR_IMPORT'
  )
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      !context.parentURL?.includes('/node_modules/') &&
      !context.parentURL?.includes('/dist/')
    ) {
      const mappedUrl = workspaceSrcUrls[specifier]
      if (mappedUrl) {
        return {url: mappedUrl, shortCircuit: true}
      }
    }

    try {
      return nextResolve(specifier, context)
    } catch (err) {
      if (
        !isRelativeOrFileSpecifier(specifier) ||
        context.parentURL?.includes('/node_modules/') ||
        !isMissingModuleError(err)
      ) {
        throw err
      }

      const candidates = specifier.endsWith('.js')
        ? [`${specifier.slice(0, -3)}.ts`]
        : [`${specifier}.ts`, `${specifier}/index.ts`]

      for (const candidate of candidates) {
        try {
          return nextResolve(candidate, context)
        } catch {}
      }

      throw err
    }
  }
})
