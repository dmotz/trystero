import {copyFileSync, existsSync, readdirSync, statSync} from 'node:fs'
import {join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const root = resolve(fileURLToPath(import.meta.url), '../..')
const readmePath = join(root, 'README.md')

if (!existsSync(readmePath)) {
  console.error('copy-readmes: missing root README.md')
  process.exit(1)
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

  copyFileSync(readmePath, join(pkgDir, 'README.md'))
  console.log(`README.md -> packages/${name}/`)
}
