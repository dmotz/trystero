import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {
  copyReadmes,
  defaultGithubBaseUrl,
  resolveGitRef,
  rewriteRelativeDocLinks
} from '../../scripts/copy-readmes.ts'
import test from './test.ts'

const repoRoot = resolve(fileURLToPath(import.meta.url), '../../..')

void test('rewriteRelativeDocLinks converts relative doc links to GitHub URLs and preserves external, anchor, and code-block content', () => {
  const input = [
    '# Heading',
    '',
    '- [State guide](./docs/state.md)',
    '- [Bare path](docs/identity.md)',
    '- [Root-relative](/docs/roles.md)',
    '- [Anchor & title](./docs/api.md#joinroom "API Reference")',
    '- [Angle brackets](<./MIGRATION.md>)',
    '- [`arr[0]` code label](./docs/actions.md)',
    '- [Docs directory](./docs)',
    '- ![Diagram](./docs/diagram.svg)',
    '- [External](https://trystero.dev)',
    '- [Mail](mailto:dan@oxism.com)',
    '- [In-page anchor](#quickstart)',
    '- Inline code `[not a link](./docs/state.md)` stays intact',
    '- HTML <a href="./docs/media.md">media</a> and <img src="./docs/arch.png" alt="arch" />',
    '',
    '[ref-link]: ./docs/scaling.md "Scaling"',
    '[ext-ref]: https://oxism.com',
    '',
    '```md',
    '[Inside fenced code](./docs/state.md)',
    '[also-inside]: ./MIGRATION.md',
    '```',
    '',
    '~~~html',
    '<a href="./docs/signaling.md">inside tilde fence</a>',
    '~~~'
  ].join('\n')

  const actual = rewriteRelativeDocLinks(input, {
    baseUrl: 'https://github.com/dmotz/trystero/',
    ref: 'main',
    rootDir: repoRoot
  })

  const expected = [
    '# Heading',
    '',
    '- [State guide](https://github.com/dmotz/trystero/blob/main/docs/state.md)',
    '- [Bare path](https://github.com/dmotz/trystero/blob/main/docs/identity.md)',
    '- [Root-relative](https://github.com/dmotz/trystero/blob/main/docs/roles.md)',
    '- [Anchor & title](https://github.com/dmotz/trystero/blob/main/docs/api.md#joinroom "API Reference")',
    '- [Angle brackets](<https://github.com/dmotz/trystero/blob/main/MIGRATION.md>)',
    '- [`arr[0]` code label](https://github.com/dmotz/trystero/blob/main/docs/actions.md)',
    '- [Docs directory](https://github.com/dmotz/trystero/tree/main/docs)',
    '- ![Diagram](https://github.com/dmotz/trystero/raw/main/docs/diagram.svg)',
    '- [External](https://trystero.dev)',
    '- [Mail](mailto:dan@oxism.com)',
    '- [In-page anchor](#quickstart)',
    '- Inline code `[not a link](./docs/state.md)` stays intact',
    '- HTML <a href="https://github.com/dmotz/trystero/blob/main/docs/media.md">media</a> and <img src="https://github.com/dmotz/trystero/raw/main/docs/arch.png" alt="arch" />',
    '',
    '[ref-link]: https://github.com/dmotz/trystero/blob/main/docs/scaling.md "Scaling"',
    '[ext-ref]: https://oxism.com',
    '',
    '```md',
    '[Inside fenced code](./docs/state.md)',
    '[also-inside]: ./MIGRATION.md',
    '```',
    '',
    '~~~html',
    '<a href="./docs/signaling.md">inside tilde fence</a>',
    '~~~'
  ].join('\n')

  assert.equal(actual, expected)
})

void test('resolveGitRef prefers release tag in CI and maps prerelease vs stable versions locally', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'trystero-ref-test-'))

  try {
    mkdirSync(join(tmp, 'packages/trystero'), {recursive: true})
    writeFileSync(
      join(tmp, 'packages/trystero/package.json'),
      JSON.stringify({name: 'trystero', version: '0.27.0-beta1'})
    )

    assert.equal(resolveGitRef(tmp, {}), 'next')
    assert.equal(
      resolveGitRef(tmp, {
        GITHUB_REF_TYPE: 'tag',
        GITHUB_REF_NAME: '0.27.0-beta1'
      }),
      '0.27.0-beta1'
    )
    assert.equal(
      resolveGitRef(tmp, {
        GITHUB_REF_TYPE: 'branch',
        GITHUB_REF_NAME: '123/merge'
      }),
      'next'
    )

    writeFileSync(
      join(tmp, 'packages/trystero/package.json'),
      JSON.stringify({name: 'trystero', version: '0.27.0'})
    )
    assert.equal(resolveGitRef(tmp, {}), 'main')
  } finally {
    rmSync(tmp, {recursive: true, force: true})
  }
})

void test('copyReadmes writes rewritten README.md and verbatim LICENSE into every publishable package without mutating root README.md', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'trystero-copy-readmes-'))

  try {
    const rootReadme = [
      '# Trystero',
      'See [State](./docs/state.md) and [Migration](./MIGRATION.md).'
    ].join('\n')
    const rootLicense = 'MIT License\n'

    writeFileSync(join(tmp, 'README.md'), rootReadme)
    writeFileSync(join(tmp, 'LICENSE'), rootLicense)
    writeFileSync(
      join(tmp, 'package.json'),
      JSON.stringify({version: '0.27.0'})
    )

    mkdirSync(join(tmp, 'packages/alpha'), {recursive: true})
    writeFileSync(
      join(tmp, 'packages/alpha/package.json'),
      JSON.stringify({name: 'alpha', version: '0.27.0'})
    )

    mkdirSync(join(tmp, 'packages/beta'), {recursive: true})
    writeFileSync(
      join(tmp, 'packages/beta/package.json'),
      JSON.stringify({name: 'beta', version: '0.27.0'})
    )

    // Directory without package.json and plain file should be ignored
    mkdirSync(join(tmp, 'packages/not-a-pkg'), {recursive: true})
    writeFileSync(join(tmp, 'packages/stray.txt'), 'ignore')

    const logs: string[] = []
    copyReadmes({rootDir: tmp, log: msg => logs.push(msg)})

    const expectedCopiedReadme = [
      '# Trystero',
      `See [State](${defaultGithubBaseUrl}blob/main/docs/state.md) and [Migration](${defaultGithubBaseUrl}blob/main/MIGRATION.md).`
    ].join('\n')

    assert.equal(readFileSync(join(tmp, 'README.md'), 'utf8'), rootReadme)
    for (const pkg of ['alpha', 'beta']) {
      assert.equal(
        readFileSync(join(tmp, 'packages', pkg, 'README.md'), 'utf8'),
        expectedCopiedReadme
      )
      assert.equal(
        readFileSync(join(tmp, 'packages', pkg, 'LICENSE'), 'utf8'),
        rootLicense
      )
    }
    assert.equal(existsSync(join(tmp, 'packages/not-a-pkg/README.md')), false)
    assert.equal(logs.length, 4)
  } finally {
    rmSync(tmp, {recursive: true, force: true})
  }
})

void test('Root README.md relative links all resolve to existing repo files and rewrite cleanly to GitHub URLs', () => {
  const rootReadme = readFileSync(join(repoRoot, 'README.md'), 'utf8')
  const rewritten = rewriteRelativeDocLinks(rootReadme, {
    ref: 'main',
    rootDir: repoRoot
  })

  // No relative markdown links remain in the rewritten README
  const remainingRelative = [...rewritten.matchAll(/\]\((\.?\.?\/[^)]+)\)/g)]
  assert.deepEqual(remainingRelative, [])

  const githubBlobPrefix = `${defaultGithubBaseUrl}blob/main/`
  const rewrittenTargets = [
    ...rewritten.matchAll(
      new RegExp(
        `\\]\\((${githubBlobPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^)#\\s]+)`,
        'g'
      )
    )
  ].map(m => m[1]!)

  assert.ok(
    rewrittenTargets.length > 0,
    'expected rewritten GitHub doc links in root README.md'
  )

  for (const url of rewrittenTargets) {
    const relPath = url.slice(githubBlobPrefix.length)
    assert.equal(
      existsSync(join(repoRoot, relPath)),
      true,
      `README.md links to missing file: ${relPath}`
    )
  }
})
