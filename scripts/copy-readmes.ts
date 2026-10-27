import {copyFileSync, existsSync, readdirSync, statSync} from 'node:fs'
import {join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const root = resolve(fileURLToPath(import.meta.url), '../..')
const filesToCopy = ['README.md', 'LICENSE']

for (const file of filesToCopy) {
  if (!existsSync(join(root, file))) {
    console.error(`copy-readmes: missing root ${file}`)
    process.exit(1)
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
    copyFileSync(join(root, file), join(pkgDir, file))
    console.log(`${file} -> packages/${name}/`)
  }
}
