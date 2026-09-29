import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const packageRoot = join(require.resolve('@xterm/xterm/package.json'), '..')
const css = await readFile(join(packageRoot, 'css', 'xterm.css'), 'utf8')
await writeFile(new URL('../src/xterm-css.generated.ts', import.meta.url), `// Generated from @xterm/xterm/css/xterm.css (MIT).\nexport const xtermCss = ${JSON.stringify(css)}\n`)
