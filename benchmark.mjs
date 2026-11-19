import {spawn, execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {RS} from './shared/plugins.mjs';
import {parcelExecutable} from './shared/parcel.mjs';
import {packageDirs} from './app/library/vite/build.mjs';

const bench = import.meta.dirname;
const parcelConfigFiles = {
  storybook: {'.parcelrc-v3': '.storybook-s2/.parcelrc-v3'},
  docs: {
    '.parcelrc-s2-docs-v3': 'packages/dev/s2-docs/.parcelrc-s2-docs-v3',
    'MDXTransformer.mjs': 'packages/dev/s2-docs/MDXTransformer.mjs'
  },
  library: {
    '.parcelrc-build': 'parcel-v3/.parcelrc-build',
    'PostCSSTransformer.mjs': 'parcel-v3/PostCSSTransformer.mjs'
  }
};
const {values, positionals} = parseArgs({
  allowPositionals: true,
  options: {
    arm: {type: 'string'},
    checkout: {type: 'string'},
    help: {type: 'boolean', short: 'h'}
  }
});
const suite = Object.keys(parcelConfigFiles);
const usage = `Usage: node benchmark.mjs [${suite.join('|')} ...] [--arm vite|parcel] [--checkout <disposable checkout>]`;
if (values.help) {
  console.log(usage);
  process.exit(0);
}
if (positionals.some(name => !suite.includes(name)) || (values.arm && !['vite', 'parcel'].includes(values.arm))) {
  throw new Error(usage);
}
const names = positionals.length ? [...new Set(positionals)] : suite;
const usesParcel = values.arm !== 'vite';
const trials = Number(process.env.BENCHMARK_TRIALS ?? (values.arm ? 1 : 3));
if (!Number.isInteger(trials) || trials < 1) throw new Error('BENCHMARK_TRIALS must be a positive integer');
const head = cwd => execFileSync('git', ['rev-parse', 'HEAD'], {cwd, encoding: 'utf8'}).trim();
const commit = head(RS);
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'vite-parcel-builds-'));
const resultsPath = path.resolve(process.env.BENCHMARK_RESULTS ?? path.join(scratch, 'results.json'));
const appPath = (name, ...parts) => path.join(bench, 'app', name, ...parts);
let parcel = RS;
if (usesParcel) {
  parcel = values.checkout ? await fs.realpath(values.checkout) : path.join(scratch, 'react-spectrum');
  if (parcel === await fs.realpath(RS)) throw new Error('Use a disposable copy for the Parcel builds');
  if (!values.checkout) {
    console.log('Preparing a disposable React Spectrum checkout for Parcel');
    execFileSync('git', ['clone', '--quiet', '--no-checkout', '--', RS, parcel]);
    // Copy installed dependencies and source files, including when the source is a submodule.
    const files = (await fs.readdir(RS)).filter(file => file !== '.git').map(file => path.join(RS, file));
    execFileSync('/bin/cp', ['-cR', ...files, parcel]);
    execFileSync('git', ['read-tree', 'HEAD'], {cwd: parcel});
  }
  if (head(parcel) !== commit) throw new Error('The checkouts must use the same commit');
  for (const name of names) {
    for (const [file, target] of Object.entries(parcelConfigFiles[name])) {
      await fs.copyFile(appPath(name, 'parcel', file), path.join(parcel, target));
    }
  }
  console.log(`Parcel checkout: ${parcel}`);
}
const parcelBin = path.join(parcel, 'node_modules', '.bin');
const docs = path.join(parcel, 'packages/dev/s2-docs');
const docsPages = {};
for (const library of ['s2', 'react-aria']) {
  const pages = await fs.readdir(path.join(docs, 'pages', library), {recursive: true});
  docsPages[library] = pages.filter(page => page.endsWith('.mdx')).length;
}
const parcel3 = parcelExecutable(parcel);
const nativeTools = path.join(scratch, 'bin');
await fs.mkdir(nativeTools);
await fs.symlink(parcel3, path.join(nativeTools, 'parcel3'));
const node = process.execPath;
const libOutputs = packageDirs.map(dir => path.join(parcel, 'packages', dir, 'dist'));
for (const dir of ['icons', 'illustrations', 'style/dist']) {
  libOutputs.push(path.join(parcel, 'packages/@react-spectrum/s2', dir));
}

const packageVersion = async (root, name) =>
  JSON.parse(await fs.readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
const results = {
  createdAt: new Date().toISOString(),
  commit,
  machine: {cpu: os.cpus()[0].model, cores: os.availableParallelism(), memoryBytes: os.totalmem(), os: os.release()},
  node: process.version,
  vite: await packageVersion(bench, 'vite'),
  parcel: await packageVersion(parcel, '@parcel/parcel3'),
  storybook: await packageVersion(bench, 'storybook'),
  logs: scratch,
  parcelCheckout: usesParcel ? parcel : undefined,
  samples: []
};

function treeRss(root) {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss='], {encoding: 'utf8'});
  const children = new Map();
  for (const line of rows.trim().split('\n')) {
    const [pid, parent, rss] = line.trim().split(/\s+/).map(Number);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push([pid, rss]);
  }
  function sum(pid) {
    return (children.get(pid) ?? []).reduce((total, [child, rss]) => total + rss + sum(child), 0);
  }
  return sum(root) * 1024;
}

async function measure(label, trial, command, args, cwd, extraEnv = {}) {
  const log = path.join(scratch, `${label}-${trial}.log`);
  const stream = createWriteStream(log);
  const env = {...process.env, PATH: `${path.dirname(node)}:${nativeTools}:${parcelBin}:${process.env.PATH}`, ...extraEnv};
  const start = performance.now();
  const child = spawn('/usr/bin/time', ['-l', command, ...args], {cwd, env, stdio: ['ignore', 'pipe', 'pipe']});
  child.stdout.pipe(stream, {end: false});
  child.stderr.pipe(stream, {end: false});
  let tail = '';
  child.stderr.on('data', data => { tail = (tail + data).slice(-8000); });
  let peakTreeRssBytes = 0;
  const sampler = setInterval(() => { peakTreeRssBytes = Math.max(peakTreeRssBytes, treeRss(child.pid)); }, 100);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
  } finally {
    clearInterval(sampler);
    await new Promise(resolve => stream.end(resolve));
  }
  if (code !== 0) throw new Error(`${label} failed (${code}). See ${log}\n${tail.slice(-4500)}`);
  const [realSeconds, userSeconds, sysSeconds] = tail.match(/([\d.]+)\s+real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys/)?.slice(1).map(Number) ?? [];
  if (realSeconds === undefined) throw new Error(`Missing /usr/bin/time -l output for ${log}`);
  const kernel = label => Number(tail.match(new RegExp(`(\\d+)\\s+${label}`))?.[1] ?? 0);
  const sample = {
    label, trial, realSeconds, userSeconds, sysSeconds,
    elapsedMs: Math.round(performance.now() - start),
    peakTreeRssBytes,
    maxRssBytes: kernel('maximum resident set size'),
    peakFootprintBytes: kernel('peak memory footprint'),
    log
  };
  results.samples.push(sample);
  console.log(`${label} ${trial}: ${realSeconds.toFixed(2)}s, peak tree RSS ${(peakTreeRssBytes / 1024 ** 3).toFixed(2)} GiB`);
  await save();
  return {log, sample};
}

async function save() {
  await fs.writeFile(resultsPath, JSON.stringify(results, null, 2) + '\n');
}

async function fileStats(roots) {
  const result = {files: 0, bytes: 0, html: 0, rsc: 0};
  for (const root of roots) {
    const files = await fs.readdir(root, {recursive: true, withFileTypes: true}).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const file of files) {
      if (!file.isFile()) continue;
      result.files++;
      result.bytes += (await fs.stat(path.join(file.parentPath, file.name))).size;
      if (file.name.endsWith('.html')) result.html++;
      if (file.name.endsWith('.rsc')) result.rsc++;
    }
  }
  return result;
}

const run = {
  async storybook(arm, trial, output) {
    const cwd = arm === 'vite' ? bench : parcel;
    const config = arm === 'vite' ? appPath('storybook', 'vite', '.storybook') : '.storybook-s2';
    const cli = path.join(cwd, 'node_modules/.bin/storybook');
    if (arm === 'parcel') {
      await fs.rm(path.join(parcel, 'packages/dev/storybook-builder-parcel/generated-entries'), {recursive: true, force: true});
    }
    const {sample} = await measure(`storybook-${arm}`, trial, cli, [
      'build', '-c', config, '-o', output, '--disable-telemetry', '--quiet'
    ], cwd, {NODE_ENV: 'storybook', PARCEL_V3: arm === 'parcel' ? '1' : ''});
    const index = JSON.parse(await fs.readFile(path.join(output, 'index.json'), 'utf8'));
    sample.artifacts = {
      ...await fileStats([output]),
      storyIndex: Object.keys(index.entries).sort(),
      sourceFiles: new Set(Object.values(index.entries).map(entry => entry.importPath)).size
    };
  },
  async library(arm, trial, output) {
    let artifacts;
    if (arm === 'vite') {
      const {sample} = await measure('library-vite', trial, node, [appPath('library', 'vite', 'build.mjs'), output], bench);
      const coverage = JSON.parse(await fs.readFile(path.join(output, 'entries.json'), 'utf8'));
      if (Object.keys(coverage).length !== packageDirs.length || Object.values(coverage).some(count => count === 0)) {
        throw new Error('Vite library build omitted a package');
      }
      artifacts = {...await fileStats([output]), packages: Object.keys(coverage).length, targetEntries: Object.values(coverage).reduce((a, b) => a + b, 0)};
      sample.artifacts = artifacts;
    } else {
      await Promise.all(libOutputs.map(dir => fs.rm(dir, {recursive: true, force: true})));
      execFileSync(node, ['scripts/generateS2IconIndex.js'], {cwd: parcel, env: {...process.env, PARCEL_V3: '1'}});
      const {sample} = await measure('library-parcel', trial, parcel3, [
        'build', ...packageDirs.map(dir => `packages/${dir}`), '--no-optimize', '--config', 'parcel-v3/.parcelrc-build'
      ], parcel, {PARCEL_V3: '1'});
      sample.artifacts = {...await fileStats(libOutputs), packages: packageDirs.length};
    }
  },
  async docs(arm, trial, output) {
    if (arm === 'vite') {
      const {sample} = await measure('docs-vite-bundle', trial, node, [appPath('docs', 'vite', 'build.mjs'), output], bench);
      sample.artifacts = await fileStats([path.join(output, 'site'), path.join(output, 'server')]);
      const {sample: render} = await measure('docs-vite-render', trial, node, [appPath('docs', 'vite', 'render.mjs'), output], bench);
      render.artifacts = await fileStats([path.join(output, 'site')]);
      const pages = Object.values(docsPages).reduce((total, count) => total + count, 0);
      if (render.artifacts.html !== pages || render.artifacts.rsc !== pages) {
        throw new Error(`Vite generated ${render.artifacts.html} HTML and ${render.artifacts.rsc} RSC output files for ${pages} routes`);
      }
    } else {
      // Use the style macro source, as in a checkout before the library build.
      await fs.rm(path.join(parcel, 'packages/@react-spectrum/s2/style/dist'), {recursive: true, force: true});
      for (const library of ['s2', 'react-aria']) {
        const stage = path.join('dist', `vite-benchmark-${path.basename(scratch)}-${trial}-${library}`);
        const {sample} = await measure(`docs-parcel-bundle-${library}`, trial, parcel3, [
          'build', `ssg-${library}.tsx`, '--no-optimize', '--config', '.parcelrc-s2-docs-v3', '--dist-dir', stage
        ], docs, {LIBRARY: library, PARCEL_V3: '1', PUBLIC_URL: '/'});
        sample.artifacts = await fileStats([path.join(docs, stage)]);
        await fs.rm(path.join(docs, 'dist', library), {recursive: true, force: true});
        const entry = `ssg-${library}.js`;
        const candidates = [path.join(stage, entry), path.join(stage, 'server', entry)];
        const available = await Promise.all(candidates.map(file => fs.access(path.join(docs, file)).then(() => true, () => false)));
        const script = candidates[available.indexOf(true)];
        if (!script) throw new Error(`Missing Parcel prerender entry for ${library}`);
        const {sample: render} = await measure(`docs-parcel-render-${library}`, trial, node, [script], docs, {LIBRARY: library, PUBLIC_URL: '/'});
        render.artifacts = await fileStats([path.join(docs, 'dist', library)]);
        if (render.artifacts.html !== docsPages[library] || render.artifacts.rsc !== docsPages[library]) {
          throw new Error(`Parcel generated ${render.artifacts.html} HTML and ${render.artifacts.rsc} RSC output files for ${docsPages[library]} ${library} routes`);
        }
      }
    }
  }
};

console.log(`Benchmark logs and build artifacts: ${scratch}`);
for (const name of names) {
  for (let trial = 1; trial <= trials; trial++) {
    const arms = values.arm ? [values.arm] : trial % 2 ? ['parcel', 'vite'] : ['vite', 'parcel'];
    for (const arm of arms) {
      await run[name](arm, trial, path.join(scratch, `${name}-${arm}-${trial}`));
      await save();
    }
  }
}
console.log(`Results: ${resultsPath}`);
