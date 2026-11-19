import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import fg from 'fast-glob';
import postcss from 'postcss';
import {build} from 'vite';
import {RS, reactSpectrumPlugins} from '../../../shared/plugins.mjs';

const packagesRoot = path.join(RS, 'packages');
const requireSpectrum = createRequire(path.join(RS, 'package.json'));
const cssRoot = path.join(packagesRoot, '@adobe/spectrum-css-temp');
const patterns = [
  '@react-{spectrum,aria,stately}/*',
  '@internationalized/{message,string,date,number}',
  'react-aria', 'react-stately', 'react-aria-components', '@adobe/react-spectrum'
];

export const packageDirs = fg.sync(patterns, {cwd: packagesRoot, onlyDirectories: true}).sort();

function spectrumLibraryAssets(pkg) {
  const cssIds = new Map();
  return {
    name: 'spectrum-library-assets',
    enforce: 'pre',
    async resolveId(id, importer) {
      if (id.startsWith('\0library-svg:')) return id;
      if (id.endsWith('.svg') && importer && id.startsWith('.')) {
        const svg = path.resolve(path.dirname(importer), id);
        return `\0library-svg:${svg}`;
      }
      if (pkg !== '@adobe/react-spectrum' || !id.endsWith('.css')) return;
      let file;
      if (id.startsWith('@adobe/spectrum-css-temp/')) {
        file = path.join(cssRoot, id.slice('@adobe/spectrum-css-temp/'.length));
      } else if (id.startsWith('.') && importer?.includes('/@adobe/react-spectrum/src/')) {
        file = path.resolve(path.dirname(importer), id);
      }
      if (!file) return;
      const virtual = file.replace(/\.css$/, '.module.css');
      cssIds.set(virtual, file);
      return virtual;
    },
    async load(id) {
      if (id.startsWith('\0library-svg:')) {
        const file = id.slice('\0library-svg:'.length);
        if (file.includes('/s2wf-icons/')) {
          return `import {createIcon} from '@react-spectrum/s2/Icon';
import Svg from ${JSON.stringify(`${file}?react`)};
export default createIcon(Svg);`;
        }
        return `export {default} from ${JSON.stringify(`${file}?react`)};`;
      }
      const file = cssIds.get(id);
      if (file) {
        const {processors} = requireSpectrum('@spectrum-css/component-builder/css/processors');
        return (await postcss(processors).process(await fs.readFile(file, 'utf8'), {from: file})).css;
      }
    }
  };
}

function outputName(source, target, spec) {
  const ext = target === 'legacy-module' ? '.js' : spec.outputFormat === 'commonjs' ? '.cjs' : '.mjs';
  const name = source.replace(/\.[^.]+$/, '');
  if (target.startsWith('icons-')) return path.basename(name).replace(/^S2_Icon_|_20_N$/g, '') + ext;
  if (target.startsWith('illustrations-')) return name.slice('spectrum-illustrations/'.length) + ext;
  return name + ext;
}

function targets(pkg, dir) {
  const output = [];
  const mainTargets = {
    module: [pkg.module, 'es'],
    main: [pkg.main, 'cjs'],
    import: [pkg.import, 'es']
  };
  for (const [key, [file, format]] of Object.entries(mainTargets)) {
    if (typeof file === 'string' && pkg.targets?.[key] !== false) {
      output.push({dir: path.dirname(file), entries: {[path.basename(file)]: path.join(dir, pkg.source)}, format});
    }
  }
  for (const [key, spec] of Object.entries(pkg.targets ?? {})) {
    if (!spec?.source) continue;
    const sources = fg.sync(spec.source, {cwd: dir}).sort();
    const entries = Object.fromEntries(sources.map(source => {
      const filename = pkg[key] ? path.basename(pkg[key]) : outputName(source, key, spec);
      const input = path.join(dir, source);
      return [filename, source.endsWith('.svg') ? `\0library-svg:${input}` : input];
    }));
    output.push({
      dir: spec.distDir ?? path.dirname(pkg[key]),
      entries,
      format: spec.outputFormat === 'commonjs' ? 'cjs' : 'es',
      legacy: Boolean(spec.engines)
    });
  }
  if (pkg.name === '@react-aria/example-theme') {
    output.push({dir: 'dist', entries: {'index.css': path.join(dir, pkg.source)}, format: 'es', css: true});
  }
  if (output.length === 0) {
    output.push({dir: 'dist', entries: {'index.js': path.join(dir, pkg.source)}, format: 'es'});
  }
  return output;
}

async function buildPackage(name, out, packages) {
  const dir = path.join(packagesRoot, name);
  const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
  const assets = spectrumLibraryAssets(name);
  const plugins = reactSpectrumPlugins({enableReact: false});
  const entries = targets(pkg, dir);
  for (const target of entries) {
    await build({
      configFile: false,
      root: dir,
      logLevel: 'error',
      publicDir: false,
      oxc: {jsx: {runtime: 'automatic'}},
      resolve: {conditions: ['source', 'module', 'browser', 'development|production']},
      css: {postcss: {plugins: []}},
      plugins: [assets, ...plugins],
      build: {
        outDir: path.join(out, name, target.dir),
        emptyOutDir: false,
        sourcemap: true,
        minify: false,
        cssMinify: false,
        reportCompressedSize: false,
        target: target.legacy ? ['chrome79', 'firefox85', 'safari13'] : 'esnext',
        ...(target.css ? {} : {lib: {entry: target.entries, formats: [target.format]}}),
        cssCodeSplit: true,
        rolldownOptions: {
          input: target.entries,
          external(id) {
            if (id.startsWith('node:')) return true;
            if (/^[./\0#]|^(bundle-text:|url:|raw:|data-url:|illustration:|macro-)/.test(id)) return false;
            if (id.startsWith('@adobe/spectrum-css-temp/') && name === '@adobe/react-spectrum') return false;
            return true;
          },
          onwarn(warning, defaultHandler) {
            if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') defaultHandler(warning);
          },
          output: {
            entryFileNames: '[name]',
            chunkFileNames: `chunks/[name]-[hash].${target.format === 'cjs' ? 'cjs' : 'mjs'}`,
            assetFileNames: 'assets/[name]-[hash][extname]'
          }
        }
      }
    });
  }
  packages[name] = entries.reduce((count, target) => count + Object.keys(target.entries).length, 0);
}

if (process.argv[1] === import.meta.filename) {
  const [output = 'library-dist', ...only] = process.argv.slice(2);
  const out = path.resolve(output);
  const packages = {};
  for (const name of only.length ? only : packageDirs) {
    try {
      await buildPackage(name, out, packages);
    } catch (error) {
      throw new Error(`Vite failed to build ${name}`, {cause: error});
    }
  }
  await fs.writeFile(path.join(out, 'entries.json'), JSON.stringify(packages, null, 2) + '\n');
  console.log(`Built ${Object.keys(packages).length} workspace packages`);
}
