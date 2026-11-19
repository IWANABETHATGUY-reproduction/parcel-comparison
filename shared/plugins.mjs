import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import fg from 'fast-glob';
import json5 from 'json5';
import macros from 'unplugin-parcel-macros';
import react from '@vitejs/plugin-react';
import svgr from 'vite-plugin-svgr';
import {transformWithOxc} from 'vite';

export const RS = path.resolve(import.meta.dirname, '../react-spectrum');
export const S2_DIR = path.join(RS, 'packages/@react-spectrum/s2');

const rsRequire = createRequire(path.join(RS, 'package.json'));
let compileStrings;
try {
  ({compileStrings} = rsRequire('@internationalized/string-compiler'));
} catch {
  compileStrings = null;
}

// Retain shared CSS when the macro plugin invalidates one of its importers.
function parcelMacros(assets = new Map()) {
  const plugin = macros.vite();
  return {
    ...plugin,
    async transform(code, id) {
      const result = await plugin.transform.call(this, code, id);
      for (const [, asset] of result?.code.matchAll(/import "(macro-[\da-f]+\.css)";/g) ?? []) {
        if (plugin.loadInclude(asset)) assets.set(asset, plugin.load.call(this, asset));
      }
      return result;
    },
    resolveId(id) {
      return assets.has(id) ? id : plugin.resolveId.call(this, id);
    },
    loadInclude(id) {
      return assets.has(id) || plugin.loadInclude(id);
    },
    load(id) {
      return assets.get(id) ?? plugin.load.call(this, id);
    }
  };
}

export function buildWorkspaceAliases() {
  const aliases = [
    {find: /^@react-spectrum\/s2\/illustrations\/(.*)/, replacement: path.join(S2_DIR, 'spectrum-illustrations/$1.tsx')},
    {find: /^@react-spectrum\/s2\/Icon$/, replacement: path.join(S2_DIR, 'src/Icon.tsx')},
    {find: /^@react-spectrum\/s2\/style\/runtime$/, replacement: path.join(S2_DIR, 'style/runtime.ts')},
    {find: /^@react-spectrum\/s2\/style$/, replacement: path.join(S2_DIR, 'style/index.ts')},
    {find: /^@react-spectrum\/s2\/page\.css$/, replacement: path.join(S2_DIR, 'page.css')},
    {find: /^tailwind-starter\/(.*)/, replacement: path.join(RS, 'starters/tailwind/src/$1')},
    {find: /^vanilla-starter\/(.*)/, replacement: path.join(RS, 'starters/docs/src/$1')},
    {find: /^hooks-starter\/(.*)/, replacement: path.join(RS, 'starters/hooks/src/$1')},
    {find: /^~\/src\/(.*)/, replacement: path.join(S2_DIR, 'src/$1')}
  ];
  return aliases;
}

/**
 * Handles Parcel-specific import schemes:
 *  - url:..., data-url:..., raw:..., bundle-text:...
 *  - illustration:*.svg
 *  - @react-spectrum/s2/icons/*
 *  - docs:*
 *  - ../intl/*.json glob imports
 */
export function reactSpectrumPlugins({enableSvgr = true, enableMacros = true, enableReact = true, rscBoundaries = false, macroAssets, extraPlugins = []} = {}) {
  const clientDirective = rscBoundaries ? "'use client';\n" : '';
  const iconsDir = path.join(S2_DIR, 's2wf-icons');
  const iconMap = new Map();
  if (fs.existsSync(iconsDir)) {
    for (const file of fs.readdirSync(iconsDir)) {
      const m = file.match(/^S2_Icon_(.+)_20_N\.svg$/);
      if (m) iconMap.set(m[1], path.join(iconsDir, file));
    }
  }

  const s2IconPlugin = {
    name: 'rs-s2-icons',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source.startsWith('\0s2-icon-file:')) {
        return source;
      }
      if (source.startsWith('illustration:')) {
        const svgRel = source.slice('illustration:'.length);
        const abs = importer ? path.resolve(path.dirname(importer), svgRel) : path.resolve(S2_DIR, svgRel);
        return '\0s2-illustration:' + abs;
      }
      const m = source.match(/(?:@react-spectrum\/s2|[\\/]exports)[\\/]icons[\\/](.+)$/);
      if (m) {
        const name = m[1].replace(/\.(js|mjs|cjs|tsx?)$/, '');
        if (iconMap.has(name)) {
          return '\0s2-icon:' + name;
        }
      }
      // Handle direct relative imports of s2wf-icons/*.svg inside @react-spectrum/s2
      if (source.endsWith('.svg') && importer && source.includes('s2wf-icons')) {
        const abs = path.resolve(path.dirname(importer), source);
        if (fs.existsSync(abs)) {
          return '\0s2-icon-file:' + abs;
        }
      }
      return null;
    },
    load(id) {
      if (id.startsWith('\0s2-illustration:')) {
        const svgPath = id.slice('\0s2-illustration:'.length).replaceAll('\\', '/');
        return [
          `${clientDirective}import {createIllustration} from '${path.join(S2_DIR, 'src/Icon.tsx')}';`,
          `import SvgComponent from '${svgPath}?react';`,
          `export default /*#__PURE__*/ createIllustration(SvgComponent);`
        ].join('\n');
      }
      if (id.startsWith('\0s2-icon:')) {
        const name = id.slice('\0s2-icon:'.length);
        const svgPath = iconMap.get(name).replaceAll('\\', '/');
        return [
          `${clientDirective}import {createIcon} from '${path.join(S2_DIR, 'src/Icon.tsx')}';`,
          `import SvgComponent from '${svgPath}?react';`,
          `export default /*#__PURE__*/ createIcon(SvgComponent);`
        ].join('\n');
      }
      if (id.startsWith('\0s2-icon-file:')) {
        const svgPath = id.slice('\0s2-icon-file:'.length).replaceAll('\\', '/');
        return [
          `${clientDirective}import {createIcon} from '${path.join(S2_DIR, 'src/Icon.tsx')}';`,
          `import SvgComponent from '${svgPath}?react';`,
          `export default /*#__PURE__*/ createIcon(SvgComponent);`
        ].join('\n');
      }
      return null;
    }
  };

  const parcelProtocolsPlugin = {
    name: 'rs-parcel-protocols',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (source.startsWith('docs:') || source.startsWith('docs-json:')) {
        return '\0virtual-docs:' + source;
      }
      if (source.startsWith('url:') && source.includes('*') && importer) {
        return `\0virtual-glob:${JSON.stringify({baseDir: path.dirname(importer), pattern: source.slice(4), asUrl: true})}`;
      }
      if (source.startsWith('url:')) {
        const target = source.slice('url:'.length);
        const resolved = await this.resolve(target, importer, {skipSelf: true});
        if (resolved) return resolved.id + '?url';
        if (importer) return path.resolve(path.dirname(importer), target) + '?url';
      }
      if (source.startsWith('data-url:')) {
        const target = source.slice('data-url:'.length);
        const resolved = await this.resolve(target, importer, {skipSelf: true});
        if (resolved) return resolved.id + '?inline';
        if (importer) return path.resolve(path.dirname(importer), target) + '?inline';
      }
      if (source.startsWith('raw:') || source.startsWith('bundle-text:')) {
        const target = source.replace(/^(?:raw|bundle-text):/, '');
        const resolved = await this.resolve(target, importer, {skipSelf: true});
        if (resolved) return resolved.id + '?raw';
        if (importer) return path.resolve(path.dirname(importer), target) + '?raw';
      }
      // Handle ../intl/*.json and ../intl/<subpath>/*.json glob imports
      if (importer && /\/intl\/.*\*.json$/.test(source)) {
        const intlDir = path.resolve(path.dirname(importer), source.replace('*.json', ''));
        return '\0virtual-intl:' + intlDir;
      }
      // Handle generic Parcel glob imports (e.g. ./pages/**/*.mdx?async=true&flat=true, ../s2wf-icons/*.svg, etc.)
      if (importer && source.includes('*') && !source.startsWith('\0')) {
        const [patternPart, queryPart = ''] = source.split('?');
        const baseDir = path.dirname(importer);
        const params = new URLSearchParams(queryPart);
        const isAsync = params.get('async') === 'true';
        const isFlat = params.get('flat') === 'true';
        return `\0virtual-glob:${JSON.stringify({baseDir, pattern: patternPart, isAsync, isFlat})}`;
      }
      return null;
    },
    load(id) {
      if (id.startsWith('\0virtual-glob:')) {
        const {baseDir, pattern, isAsync, isFlat, asUrl} = JSON.parse(id.slice('\0virtual-glob:'.length));
        const matches = fg.sync(pattern, {cwd: baseDir, dot: false}).sort();
        if (isAsync) {
          const entries = matches.map(m => {
            const rel = m.startsWith('.') ? m : './' + m;
            const abs = path.resolve(baseDir, m).replaceAll('\\', '/');
            return `${JSON.stringify(rel)}: () => import(${JSON.stringify(abs)})`;
          });
          return `export default {${entries.join(',\n')}};\n`;
        }
        // Build nested or flat object matching @parcel/resolver-glob
        const imports = [];
        const obj = {};
        matches.forEach((m, idx) => {
          const abs = path.resolve(baseDir, m).replaceAll('\\', '/');
          const ident = `_g${idx}`;
          const spec = asUrl ? `${abs}?url` : abs.includes('/s2wf-icons/') && abs.endsWith('.svg') ? `\0s2-icon-file:${abs}` : abs;
          imports.push(`import ${ident} from ${JSON.stringify(spec)};`);
          if (isFlat) {
            obj[m] = ident;
          } else {
            // Strip leading ../ and extension segments similar to Parcel glob
            const clean = m.replace(asUrl ? /^(\.\.\/)+pages\// : /^(\.\.\/)+/, '');
            const parts = asUrl ? clean.split(/[/.]/) : clean.replace(/\.[^.]+$/, '').split('/');
            let cur = obj;
            for (let i = 0; i < parts.length - 1; i++) {
              cur[parts[i]] ??= {};
              cur = cur[parts[i]];
            }
            cur[parts[parts.length - 1]] = ident;
          }
        });
        const serializeObj = o =>
          '{' +
          Object.entries(o)
            .map(([k, v]) => `${JSON.stringify(k)}: ${typeof v === 'string' ? v : serializeObj(v)}`)
            .join(',') +
          '}';
        return `${imports.join('\n')}\nexport default ${serializeObj(obj)};\n`;
      }
      if (id.startsWith('\0virtual-docs:')) {
        return `
const emptyProxy = new Proxy({exports: {}, links: {}, description: '', props: {}, properties: {}}, {
  get(target, prop) {
    if (prop in target) return target[prop];
    return emptyProxy;
  }
});
export default emptyProxy;
`;
      }
      if (id.startsWith('\0virtual-intl:')) {
        const intlDir = id.slice('\0virtual-intl:'.length);
        if (!fs.existsSync(intlDir)) return 'export default {};';
        const files = fs.readdirSync(intlDir).filter(f => f.endsWith('.json'));
        const messages = {};
        for (const f of files) {
          const locale = path.basename(f, '.json');
          messages[locale] = JSON.parse(fs.readFileSync(path.join(intlDir, f), 'utf8'));
        }
        return `export default ${JSON.stringify(messages)};`;
      }
      return null;
    }
  };

  // Compile individual intl/*.json files (when imported directly rather than via glob)
  const intlSingleFilePlugin = {
    name: 'rs-intl-json-file',
    enforce: 'pre',
    transform(code, id) {
      if (compileStrings && /\/packages\/.*\/intl\/.*\.json$/.test(id)) {
        try {
          const json = JSON.parse(code);
          return {code: compileStrings(json, {format: 'esm'}), map: null};
        } catch {
          return null;
        }
      }
      return null;
    }
  };

  // Expand <ExampleSwitcher type="component" examples={[...]}> like s2-docs/MDXTransformer.mjs
  // and avoid MDX v3 MDXLayout identifier collision.
  const mdxExampleSwitcherPlugin = {
    name: 'rs-mdx-example-switcher',
    enforce: 'pre',
    transform: {order: 'pre', async handler(code, id) {
      if (id.includes('.storybook-s2/') && id.endsWith('.js')) {
        const res = await transformWithOxc(code, id + 'x', {jsx: {runtime: 'automatic'}});
        return {code: res.code, map: res.map};
      }
      if (id.endsWith('/.storybook-s2/preview.tsx')) {
        return {code: code.replace(/new URL\('raw:(logo(?:-dark)?\.svg)'/g, "new URL('./$1'"), map: null};
      }
      if (id.includes('.storybook-s2/docs/') && code.includes('H2, H3, H3')) {
        return {code: code.replace('H2, H3, H3', 'H2, H3'), map: null};
      }
      if (!id.endsWith('.mdx')) return null;
      let out = code;
      let replaced = false;
      if (out.includes('import {MDXLayout}')) {
        out = out
          .replace(/import \{MDXLayout\} from (['"][^'"]+['"]);?/g, 'import {MDXLayout as _StoryMDXLayout} from $1;')
          .replace(/export default MDXLayout;?/g, 'export default _StoryMDXLayout;');
        replaced = true;
      }
      out = out.replace(
        /(<ExampleSwitcher type="component" examples={(\[.*?\])}>)((?:.|\n)*?)<\/ExampleSwitcher>/g,
        (m, start, examples, inner) => {
          if (inner.includes('COMPONENT')) {
            replaced = true;
            const components = json5.parse(examples);
            const expanded = components.map(c => inner.replace(/COMPONENT/g, c)).join('\n\n');
            return start + expanded + '</ExampleSwitcher>';
          }
          return m;
        }
      );
      return replaced ? {code: out, map: null} : null;
    }}
  };

  const list = [];
  if (enableMacros) list.push(parcelMacros(macroAssets));
  list.push(parcelProtocolsPlugin);
  list.push(s2IconPlugin);
  list.push(intlSingleFilePlugin);
  list.push(mdxExampleSwitcherPlugin);
  if (enableSvgr) {
    list.push(
      svgr({
        include: ['**/*.svg?react', '**/ui-icons/**/*.svg', '**/spectrum-illustrations/**/*.svg'],
        exclude: ['**/node_modules/**'],
        svgrOptions: {
          ref: true,
          typescript: false,
          svgoConfig: {
            plugins: [
              {
                name: 'preset-default',
                params: {overrides: {removeViewBox: false}}
              }
            ]
          }
        }
      })
    );
  }
  list.push(...extraPlugins);
  if (enableReact) list.push(react());
  return list;
}
