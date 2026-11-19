import fs from 'node:fs/promises';
import path from 'node:path';
import rsc from '@vitejs/plugin-rsc';
import tailwind from '@tailwindcss/vite';
import {createBuilder} from 'vite';
import {RS, buildWorkspaceAliases, reactSpectrumPlugins} from '../../../shared/plugins.mjs';
import {docsRoot, prepareTypes} from './prepare-types.mjs';
import {pageEntries, spectrumDocs} from './mdx.mjs';

const [directory = 'docs-dist', scope = 'all', filter] = process.argv.slice(2);
const output = path.resolve(directory);
const typeFile = path.join(output, 'docs-types.json');
if (!process.env.VITE_DOCS_TYPES) await prepareTypes(RS, typeFile);
const typeDocs = JSON.parse(await fs.readFile(process.env.VITE_DOCS_TYPES ?? typeFile, 'utf8'));
const macroAssets = new Map();
const workspaceModules = path.join(RS, 'node_modules');
await fs.mkdir(output, {recursive: true});
await fs.writeFile(path.join(output, 'package.json'), '{"type":"module"}\n');
await fs.symlink(workspaceModules, path.join(output, 'node_modules'), 'dir').catch(error => {
  if (error.code !== 'EEXIST') throw error;
});

for (const library of scope === 'all' ? ['s2', 'react-aria'] : [scope]) {
  const entries = await pageEntries(library, filter);
  if (!entries.length) throw new Error(`No pages match ${library} ${filter ?? ''}`);
  const routes = Object.fromEntries(entries.map(file => [
    file.slice(`pages/${library}/`.length), path.join(docsRoot, file)
  ]));
  const clientOut = path.join(output, 'site', library);
  const serverOut = path.join(output, 'server', library);
  const builder = await createBuilder({
    configFile: false,
    root: docsRoot,
    base: `/${library}/`,
    publicDir: false,
    logLevel: 'error',
    define: {
      'process.env.LIBRARY': JSON.stringify(library),
      'process.env.PARCEL_V3': 'undefined',
      'process.env.DOCS_ENV': 'undefined',
      'process.env.PUBLIC_URL': '"/"'
    },
    resolve: {
      conditions: ['source', 'module', 'browser', 'development|production'],
      dedupe: ['react', 'react-dom'],
      alias: [
        {find: 'rsc-html-stream/server', replacement: path.join(workspaceModules, 'rsc-html-stream/server.js')},
        {find: 'rsc-html-stream/client', replacement: path.join(workspaceModules, 'rsc-html-stream/client.js')},
        {find: '@parcel/transformer-js/src/mdx-components', replacement: path.join(workspaceModules, '@parcel/transformer-js/src/mdx-components.jsx')},
        ...buildWorkspaceAliases()
      ]
    },
    css: {postcss: {plugins: []}},
    plugins: [
      spectrumDocs(typeDocs),
      {
        name: 'spectrum-docs-routes',
        resolveId(id) {
          if (id === 'virtual:spectrum-docs-routes') return `\0${id}`;
        },
        load(id) {
          if (id !== '\0virtual:spectrum-docs-routes') return;
          const imports = Object.entries(routes).map(([name, file]) => `${JSON.stringify(name)}: () => import(${JSON.stringify(file)})`);
          return `export default {${imports.join(',\n')}};`;
        }
      },
      ...reactSpectrumPlugins({rscBoundaries: true, macroAssets}),
      tailwind(),
      rsc({
        entries: {
          client: path.join(import.meta.dirname, 'entry.browser.tsx'),
          ssr: path.join(import.meta.dirname, 'entry.ssr.tsx'),
          rsc: path.join(import.meta.dirname, 'entry.rsc.tsx')
        },
        serverHandler: false,
        rscCssTransform: false
      })
    ],
    build: {
      minify: false,
      cssMinify: false,
      sourcemap: true,
      reportCompressedSize: false,
      emptyOutDir: true
    },
    environments: {
      client: {build: {outDir: clientOut}},
      ssr: {
        resolve: {
          conditions: ['source', 'module', 'node', 'development|production'],
          noExternal: ['use-sync-external-store', 'motion', 'framer-motion']
        },
        build: {
          outDir: path.join(serverOut, 'ssr'),
          rolldownOptions: {output: {entryFileNames: '[name].js'}}
        }
      },
      rsc: {
        resolve: {
          conditions: ['react-server', 'source', 'module', 'node', 'development|production'],
          external: ['@parcel/rust', 'tree-sitter-highlight', 'json5', 'globals-docs', 'sharp']
        },
        build: {
          outDir: path.join(serverOut, 'rsc'),
          rolldownOptions: {output: {entryFileNames: '[name].js'}}
        }
      }
    }
  });
  await builder.buildApp();
  console.log(`Bundled ${entries.length} ${library} pages`);
}
