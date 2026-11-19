import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {RS} from '../../../shared/plugins.mjs';
import {docsRoot, typeDocKey} from './prepare-types.mjs';

const requireSpectrum = createRequire(path.join(RS, 'package.json'));
const {transformAsync} = requireSpectrum('@parcel/rust');
const transformer = (await import(path.join(docsRoot, 'MDXTransformer.mjs'))).default;
const preprocess = transformer[Symbol.for('parcel-plugin-config')].transform;
const client = fileURLToPath(new URL('./parcel-client.tsx', import.meta.url));

export function spectrumDocs(typeDocs) {
  const compiled = new Map();
  const examples = new Map();
  const typeIds = new Map();
  return {
    name: 'spectrum-docs-mdx',
    enforce: 'pre',
    resolveId(id, importer) {
      if (examples.has(id)) return id;
      if (id === '@parcel/rsc/client') {
        return this.environment.name === 'ssr' ? '\0spectrum-browser-rsc-transport' : client;
      }
      if (!id.startsWith('docs:')) return;
      const key = typeDocKey(id, importer);
      if (!Object.hasOwn(typeDocs, key)) this.error(`Missing type documentation for ${key}`);
      const virtual = `\0spectrum-type-doc:${key}`;
      typeIds.set(virtual, key);
      return virtual;
    },
    load(id) {
      if (examples.has(id)) return examples.get(id);
      if (id === '\0spectrum-browser-rsc-transport') {
        return 'export function fetchRSC() { throw new Error("RSC navigation requires a browser"); }';
      }
      if (typeIds.has(id)) {
        const serialized = JSON.stringify(typeDocs[typeIds.get(id)]);
        return `export default JSON.parse(${JSON.stringify(serialized)});`;
      }
    },
    transform: {
      order: 'pre',
      async handler(source, id) {
        if (id.endsWith('/src/Layout.tsx') && id.startsWith(docsRoot)) {
          return {code: source.replace("import '../src/client';", ''), map: null};
        }
        if (id.endsWith('/src/CodeBlock.tsx') && id.startsWith(docsRoot)) {
          return {
            code: source
              .replace(/ with \{env: 'react-client'\}/g, '')
              .replace('findPackageJSON(pkg, __filename)', `findPackageJSON(pkg, ${JSON.stringify(id)})`),
            map: null
          };
        }
        if (id.startsWith(docsRoot) && source.includes("import Markdown from 'markdown-to-jsx';")) {
          const code = source.replace(
            "import Markdown from 'markdown-to-jsx';",
            "import MarkdownModule from 'markdown-to-jsx';\nconst Markdown = MarkdownModule.default ?? MarkdownModule;"
          );
          return {code, map: null};
        }
        if (!id.endsWith('.mdx') || !id.startsWith(docsRoot)) return;
        if (!compiled.has(id)) compiled.set(id, compileMdx(source, id, examples));
        const code = await compiled.get(id);
        return {
          code: this.environment.name === 'rsc' ? code : code.replace('import.meta.viteRsc.loadCss()', 'null'),
          map: null,
          moduleType: 'js'
        };
      }
    }
  };
}

async function compileMdx(source, id, examples) {
  await preprocess({asset: {getCode: async () => source, setCode: code => { source = code; }}});
  const result = await transformAsync({
    filename: id,
    code: Buffer.from(source),
    module_id: id,
    project_root: RS,
    inline_fs: false,
    env: {},
    type: 'mdx',
    context: 'react-server',
    automatic_jsx_runtime: true,
    decorators: false,
    use_define_for_class_fields: false,
    is_development: false,
    react_refresh: false,
    source_maps: false,
    scope_hoist: false,
    source_type: 'Module',
    supports_module_workers: true,
    is_library: false,
    is_esm_output: false,
    trace_bailouts: false,
    is_swc_helpers: false,
    standalone: true,
    inline_constants: false
  });
  if (!result.code?.length) throw new Error(`${id}: ${JSON.stringify(result.diagnostics)}`);

  for (const [index, example] of result.mdx_assets.entries()) {
    const exampleId = `${id}.example-${index}.${example.lang}`;
    const code = example.code.replace(
      /^(\s*['"]use client['"];[\s\S]*?)\bexport default (<[\s\S]+);\s*$/,
      `$1import {cloneElement as __cloneExample} from 'react';
export default function DocsExample(props) { return __cloneExample(($2), props); }`
    );
    examples.set(exampleId, code);
  }
  const imports = [];
  // Translate the native MDX compiler's CommonJS wrapper into imports Vite can follow.
  const code = result.code.toString()
    .replace(/require\(("(?:[^"\\]|\\.)+")\)/g, (_, raw) => {
      const source = JSON.parse(raw);
      if (source.startsWith('.') && path.resolve(path.dirname(id), source) === path.join(docsRoot, 'src/client')) {
        return '({})';
      }
      const example = /^mdx-(\d+)$/.exec(source);
      let dependency = source;
      if (example) dependency = `${id}.example-${example[1]}.${result.mdx_assets[Number(example[1])].lang}`;
      if (source.startsWith('/packages/')) dependency = `${RS}${source}`;
      if (source.endsWith('.svg') && !source.includes(':')) dependency += '?react';
      const name = `__viteMdxImport${imports.length}`;
      imports.push(`import * as ${name} from ${JSON.stringify(dependency)};`);
      return `{...${name}, __esModule: true}`;
    })
    .replace(/parcelHelpers\.defineInteropFlag\(exports\);/g, '')
    .replace(/parcelHelpers\.export\(exports, "([\w$]+)",\s*\(\)\s*=>\s*([\w$]+)\);/g, 'export {$2 as $1};')
    .replace(/exports\.default = ([\w$]+);/, `export default function DocsPage(props) {
      return __docsReact.createElement(__docsReact.Fragment, null,
        import.meta.viteRsc.loadCss(), __docsReact.createElement($1, props));
    }`);
  return `import * as __docsReact from 'react';
${imports.join('\n')}
const __filename = ${JSON.stringify(id)};
const __dirname = ${JSON.stringify(path.dirname(id))};
${code}
export const tableOfContents = ${JSON.stringify(result.mdx_toc)};
export const pageExports = ${JSON.stringify(result.mdx_exports)};`;
}

export async function pageEntries(library, filter) {
  const files = [];
  for await (const file of fs.glob(`pages/${library}/**/*.mdx`, {cwd: docsRoot})) {
    if (!filter || file.includes(filter)) files.push(file);
  }
  return files.sort();
}
