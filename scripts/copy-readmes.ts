import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import {join, resolve, sep} from 'node:path'
import {fileURLToPath} from 'node:url'

export const defaultGithubBaseUrl = 'https://github.com/dmotz/trystero/'

const defaultRoot = resolve(fileURLToPath(import.meta.url), '../..')
const filesToCopy = ['README.md', 'LICENSE'] as const
const schemePattern = /^[a-zA-Z][a-zA-Z\d+.-]*:/
const fenceOpenPattern = /^[ ]{0,3}(`{3,}|~{3,})/

export interface RewriteOptions {
  baseUrl?: string
  ref?: string
  rootDir?: string
}

export interface CopyReadmesOptions extends RewriteOptions {
  log?: (message: string) => void
}

export const resolveGitRef = (
  rootDir: string = defaultRoot,
  env: NodeJS.ProcessEnv = process.env
): string => {
  if (env['GITHUB_REF_TYPE'] === 'tag' && env['GITHUB_REF_NAME']) {
    return env['GITHUB_REF_NAME']
  }

  for (const pkgJsonRel of ['packages/trystero/package.json', 'package.json']) {
    const pkgJsonPath = join(rootDir, pkgJsonRel)
    if (existsSync(pkgJsonPath)) {
      const {version} = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
        version?: string
      }
      if (typeof version === 'string') {
        return version.includes('-') ? 'next' : 'main'
      }
    }
  }

  return 'main'
}

const isDirectoryInRoot = (rootDir: string, repoRelPath: string): boolean => {
  try {
    const fullRoot = resolve(rootDir)
    const candidate = resolve(fullRoot, decodeURIComponent(repoRelPath))

    if (candidate !== fullRoot && !candidate.startsWith(`${fullRoot}${sep}`)) {
      return false
    }

    return existsSync(candidate) && statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

const toAbsoluteGithubUrl = (
  rawUrl: string,
  isImage: boolean,
  baseUrl: string,
  ref: string,
  rootDir?: string
): string => {
  if (
    !rawUrl ||
    rawUrl.startsWith('#') ||
    rawUrl.startsWith('//') ||
    schemePattern.test(rawUrl)
  ) {
    return rawUrl
  }

  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const relInput = rawUrl.startsWith('/') ? rawUrl.replace(/^\/+/, '') : rawUrl

  try {
    const parsed = new URL(relInput, 'https://repo.invalid/')
    const repoRelPath = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '')

    if (!repoRelPath) {
      return `${normalizedBase}tree/${ref}${parsed.search}${parsed.hash}`
    }

    const kind = isImage
      ? 'raw'
      : rootDir && isDirectoryInRoot(rootDir, repoRelPath)
        ? 'tree'
        : 'blob'

    return `${normalizedBase}${kind}/${ref}/${repoRelPath}${parsed.search}${parsed.hash}`
  } catch {
    return rawUrl
  }
}

const rewriteTargetToken = (
  token: string,
  isImage: boolean,
  baseUrl: string,
  ref: string,
  rootDir?: string
): string => {
  if (token.startsWith('<') && token.endsWith('>')) {
    const inner = token.slice(1, -1)
    return `<${toAbsoluteGithubUrl(inner, isImage, baseUrl, ref, rootDir)}>`
  }

  return toAbsoluteGithubUrl(token, isImage, baseUrl, ref, rootDir)
}

const outsideFencePattern = new RegExp(
  [
    // 1. Standalone inline code spans: `code` or ``code``
    '(?<!`)(`+)(?!`)[\\s\\S]*?(?<!`)\\1(?!`)',
    // 2. Inline Markdown links and images: [label](dest "optional title")
    '(!?\\[(?:(?<!`)(`+)(?!`)[\\s\\S]*?(?<!`)\\3(?!`)|\\\\.|\\[[^\\]]*\\]|[^\\[\\]\\\\])*\\]\\()(<[^>]+>|(?:[^()\\s]+|\\([^()\\s]*\\))+)((?:\\s+(?:"[^"]*"|\'[^\']*\'|\\([^)]*\\)))?\\))',
    // 3. Reference-style Markdown link definitions: [id]: ./docs/foo.md
    '^([ ]{0,3}\\[(?:\\\\.|[^\\[\\]\\\\])+\\]:[ \\t]*)(<[^>]+>|\\S+)',
    // 4. HTML <a href="..."> and <img src="..."> tags
    '(<(a|A|img|IMG)\\b[^>]*?\\b(?:href|HREF|src|SRC)\\s*=\\s*["\'])([^"\']+)(["\'])'
  ].join('|'),
  'gm'
)

const rewriteOutsideFences = (
  segment: string,
  baseUrl: string,
  ref: string,
  rootDir?: string
): string =>
  segment.replace(
    outsideFencePattern,
    (
      match,
      inlineCodeFence: string | undefined,
      mdLinkPrefix: string | undefined,
      _labelCodeFence: string | undefined,
      mdLinkDest: string | undefined,
      mdLinkSuffix: string | undefined,
      refDefPrefix: string | undefined,
      refDefDest: string | undefined,
      htmlPrefix: string | undefined,
      htmlTag: string | undefined,
      htmlDest: string | undefined,
      htmlSuffix: string | undefined
    ) => {
      if (inlineCodeFence !== undefined) {
        return match
      }

      if (
        mdLinkPrefix !== undefined &&
        mdLinkDest !== undefined &&
        mdLinkSuffix !== undefined
      ) {
        const isImage = mdLinkPrefix.startsWith('!')
        const rewritten = rewriteTargetToken(
          mdLinkDest,
          isImage,
          baseUrl,
          ref,
          rootDir
        )
        return `${mdLinkPrefix}${rewritten}${mdLinkSuffix}`
      }

      if (refDefPrefix !== undefined && refDefDest !== undefined) {
        const rewritten = rewriteTargetToken(
          refDefDest,
          false,
          baseUrl,
          ref,
          rootDir
        )
        return `${refDefPrefix}${rewritten}`
      }

      if (
        htmlPrefix !== undefined &&
        htmlTag !== undefined &&
        htmlDest !== undefined &&
        htmlSuffix !== undefined
      ) {
        const isImage = htmlTag.toLowerCase() === 'img'
        const rewritten = toAbsoluteGithubUrl(
          htmlDest,
          isImage,
          baseUrl,
          ref,
          rootDir
        )
        return `${htmlPrefix}${rewritten}${htmlSuffix}`
      }

      return match
    }
  )

export const rewriteRelativeDocLinks = (
  markdown: string,
  options: RewriteOptions = {}
): string => {
  const baseUrl = options.baseUrl ?? defaultGithubBaseUrl
  const ref = options.ref ?? resolveGitRef(options.rootDir)
  const rootDir = options.rootDir

  const lines = markdown.split('\n')
  const output: string[] = []
  let proseLines: string[] = []
  let activeFence: {char: string; length: number} | null = null

  const flushProse = () => {
    if (proseLines.length === 0) {
      return
    }
    output.push(
      rewriteOutsideFences(proseLines.join('\n'), baseUrl, ref, rootDir)
    )
    proseLines = []
  }

  for (const line of lines) {
    if (activeFence === null) {
      const openMatch = fenceOpenPattern.exec(line)
      const marker = openMatch?.[1]
      const fenceChar = marker?.[0]
      if (
        marker &&
        fenceChar &&
        (fenceChar !== '`' ||
          !line.slice(openMatch.index + marker.length).includes('`'))
      ) {
        flushProse()
        activeFence = {char: fenceChar, length: marker.length}
        output.push(line)
        continue
      }

      proseLines.push(line)
      continue
    }

    output.push(line)
    const trimmedStart = line.replace(/^[ ]{0,3}/, '')
    if (trimmedStart.startsWith(activeFence.char.repeat(activeFence.length))) {
      const rest = trimmedStart.slice(activeFence.length)
      if (new RegExp(`^\\${activeFence.char}*[ \\t]*\\r?$`).test(rest)) {
        activeFence = null
      }
    }
  }

  flushProse()
  return output.join('\n')
}

export const copyReadmes = (options: CopyReadmesOptions = {}): void => {
  const root = options.rootDir ?? defaultRoot
  const baseUrl = options.baseUrl ?? defaultGithubBaseUrl
  const ref = options.ref ?? resolveGitRef(root)
  const log = options.log ?? console.log

  for (const file of filesToCopy) {
    if (!existsSync(join(root, file))) {
      throw new Error(`copy-readmes: missing root ${file}`)
    }
  }

  const transformedMarkdown = new Map<string, string>()
  for (const file of filesToCopy) {
    if (file.endsWith('.md')) {
      const raw = readFileSync(join(root, file), 'utf8')
      transformedMarkdown.set(
        file,
        rewriteRelativeDocLinks(raw, {baseUrl, ref, rootDir: root})
      )
    }
  }

  const packagesDir = join(root, 'packages')

  for (const name of readdirSync(packagesDir)) {
    const pkgDir = join(packagesDir, name)

    if (!statSync(pkgDir).isDirectory()) {
      continue
    }

    if (!existsSync(join(pkgDir, 'package.json'))) {
      continue
    }

    for (const file of filesToCopy) {
      const rewritten = transformedMarkdown.get(file)
      if (rewritten !== undefined) {
        writeFileSync(join(pkgDir, file), rewritten)
      } else {
        copyFileSync(join(root, file), join(pkgDir, file))
      }
      log(`${file} -> packages/${name}/`)
    }
  }
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  try {
    copyReadmes()
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
