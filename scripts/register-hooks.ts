import {registerHooks} from 'node:module'

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
