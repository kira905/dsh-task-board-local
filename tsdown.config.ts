/**
 * Standalone build config for the self-maintained task board plugin.
 *
 * Forked from the upstream dsh-web preset (shared/tsdown.client.ts) and
 * trimmed to what this package actually needs on the DSH 0.1.1-rc.2 line:
 *   - node half:  lib/index.js  (ESM, external @deepseek-ai/cordis + schemastery;
 *     @deepseek-ai/dsh-settings stays external because the legacy settings
 *     wiring is reached through a runtime `import()` guarded by a probe — it
 *     must NOT be inlined, or the browser-independent probe would bundle a copy)
 *   - browser half: lib/client.js (closure-factory for window.__ModuleLoader__,
 *     externals react / react-dom / react-jsx-runtime; the plugin's runtime
 *     faces live in src/client/client-faces.ts, so no dsh-* package is required
 *     at browser runtime)
 */
import { readFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve as resolvePath, sep } from 'node:path'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

/**
 * Plugin id stamped into the __ModuleLoader__.load handoff and style tags.
 *
 * 🔴 This MUST equal the published package name: the 0.2.0 host's
 * `dsh-client-modules` looks the registered factory up by **entry id = package
 * name** (`graphRow(id /* package name *\/)`), so an id that differs from the
 * installed package name serves HTTP 200 and still fails with `loaded without
 * registering … via __ModuleLoader__.load` — the plugin then never mounts
 * (measured in the S16 isolated install). Keep it in sync with `package.json#name`.
 */
const ID = '@kira905/dsh-task-board-local'

/** Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline. */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/**
 * Package-relative, POSIX-style id for a physical CSS path.
 *
 * The virtual id is what rollup prints into the bundle (`//#region <id>`) and
 * what the injected `<style data-plugin-css>` tag is keyed by, so it must not
 * carry a build-machine absolute path — a published bundle otherwise leaks the
 * developer's directory layout. Paths outside the package root fall back to the
 * absolute form (better a correct build than a leaking one, and the packaging
 * checks catch it).
 */
function cssSourceId(physical: string): string {
  const rel = relative(process.cwd(), physical).split(sep).join('/')
  return rel === '' || rel.startsWith('..') ? physical.split(sep).join('/') : rel
}

/** Browser module table entries the client bundle resolves through require. */
const CLIENT_EXTERNALS: readonly string[] = [
  'react',
  'react-dom/client',
  'react/jsx-runtime',
  // 【adapter P3 · 2026-09-25】客户端适配层包：**必须保持 external**（rollup 只保留 require，
  // 不 inline）。否则常量会被打进 bundle ⇒ 字面量又回到 lib/client.js（R4 复现），
  // 且与宿主侧 `dsh.client.external` 声明的模块名对不上。配套声明见 package.json。
  // 【B13 · 2026-11-09】两个候选名都列上：scoped 是发布包名的注册 id（主路），裸名是私有树
  // 旧环境的 fallback（见 src/client/index.ts 的 loadHostAdapter）。任一方存在都能外部化。
  '@kira905/dsh-host-adapter-client',
  'dsh-host-adapter-client',
]

/**
 * Node-half externals resolved from the dsh profile tree at runtime.
 * `@deepseek-ai/dsh-settings` is here for the legacy-probe `import()` only —
 * keeping it external is what lets the probe be a dynamic import of a package
 * that may no longer export the symbol (or exist) on the newer main line.
 *
 * `host-adapter.js` (the local copy of the single adapter source) is external
 * for a different reason: it must stay a *runtime* import so the shipped
 * `lib/index.js` consumes the synced copy instead of inlining it (P1 收敛
 * 2026-09-15). Inlining would put the host vocabulary back into the bundle and
 * make the copy unverifiable (R5 compares the file, not an ingested copy).
 */
const LIB_EXTERNALS: readonly (string | RegExp)[] = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-settings',
  'schemastery',
  /host-adapter\.js$/,
]

/** Package version stamped into the browser bundle, read from package.json so the two cannot drift. */
const VERSION = (JSON.parse(readFileSync(resolvePath(process.cwd(), 'package.json'), 'utf8')) as { version: string }).version

function clientLibraryConfig(): UserConfig {
  return {
    name: ID,
    entry: ['src/index.ts', 'src/invariant.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    external: [...LIB_EXTERNALS],
  }
}

function clientConfig(): UserConfig {
  const hasClient = existsSync(resolvePath(process.cwd(), 'src/client/index.ts'))
  return {
    name: `${ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
      __DSH_PKG_VERSION__: JSON.stringify(VERSION),
    },
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    plugins: [{
      name: 'dsh-css-modules-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.module.css')) return null
        const abs = importer !== undefined ? resolvePath(dirname(importer), source) : source
        return CSS_VIRTUAL_PREFIX + cssSourceId(abs) + CSS_VIRTUAL_SUFFIX
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
        const sourceId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        const physical = isAbsolute(sourceId) ? sourceId : resolvePath(process.cwd(), sourceId)
        this.addWatchFile(physical)
        const source = await readFile(physical)
        // lightningcss keeps the absolute filename on purpose: the CSS-module
        // hash is derived from it, so a stable filename keeps generated class
        // names stable across rebuilds. The filename is never emitted.
        const { code, exports: cssExports } = transform({
          filename: physical,
          code: source,
          cssModules: { pattern: '[hash]_[local]' },
          minify: true,
        })
        const classMap: Record<string, string> = {}
        for (const [local, exp] of Object.entries(cssExports ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
          classMap[local] = exp.name
        }
        return [
          `const css = ${JSON.stringify(code.toString())};`,
          `const tagId = ${JSON.stringify(`${ID}/${sourceId}`)};`,
          'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
          '  const tag = document.createElement(\'style\');',
          `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
          '  tag.dataset.pluginCss = tagId;',
          '  tag.textContent = css;',
          '  document.head.appendChild(tag);',
          '}',
          `export default ${JSON.stringify(classMap)};`,
        ].join('\n')
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}

export default (): UserConfig[] => {
  const hasClient = existsSync(resolvePath(process.cwd(), 'src/client/index.ts'))
  const node = [clientLibraryConfig()]
  return hasClient ? [...node, clientConfig()] : node
}
