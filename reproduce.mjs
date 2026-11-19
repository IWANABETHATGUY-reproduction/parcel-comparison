import {spawn, execFileSync, execSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const RS = path.join(ROOT, 'react-spectrum');
const P2_BIN = path.join(RS, 'node_modules/.bin/parcel');
const P3_BIN = path.join(RS, 'node_modules/.bin/parcel3');

function expandBuildEntries() {
  const out = execSync(
    'ls -d packages/@react-{spectrum,aria,stately}/*/ packages/@internationalized/{message,string,date,number}/ packages/{react-aria,react-stately,react-aria-components,@adobe/react-spectrum}',
    {cwd: RS, shell: '/bin/bash', encoding: 'utf8'}
  );
  return out.trim().split('\n').filter(Boolean);
}

function rmSafe(paths) {
  for (const p of paths) {
    fs.rmSync(p, {recursive: true, force: true});
  }
}

function dirStats(dirs) {
  let files = 0;
  let bytes = 0;
  function walk(d) {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, {withFileTypes: true})) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        files++;
        bytes += fs.statSync(full).size;
      }
    }
  }
  for (const d of dirs) walk(d);
  return {files, bytes, mb: Number((bytes / (1024 * 1024)).toFixed(2))};
}

function sampleProcessTree(rootPid) {
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,pcpu=,comm='], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });
    const children = new Map();
    const procs = new Map();
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      procs.set(pid, {pid, ppid, rssKb: Number(m[3]), pcpu: Number(m[4]), comm: m[5]});
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(pid);
    }
    if (!procs.has(rootPid)) return null;
    let totalRssKb = 0;
    let totalCpu = 0;
    let count = 0;
    const childPids = [];
    const queue = [rootPid];
    const visited = new Set();
    while (queue.length > 0) {
      const p = queue.shift();
      if (visited.has(p)) continue;
      visited.add(p);
      const info = procs.get(p);
      if (info) {
        totalRssKb += info.rssKb;
        totalCpu += info.pcpu;
        count++;
        if (p !== rootPid) childPids.push(p);
      }
      const kids = children.get(p);
      if (kids) for (const k of kids) queue.push(k);
    }
    return {totalRssKb, totalCpu, count, childPids};
  } catch {
    return null;
  }
}

function parseTimeL(stderr) {
  const res = {};
  const realM = stderr.match(/([\d.]+)\s+real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys/);
  if (realM) {
    res.realSec = Number(realM[1]);
    res.userSec = Number(realM[2]);
    res.sysSec = Number(realM[3]);
    res.effectiveCores = res.realSec > 0 ? Number(((res.userSec + res.sysSec) / res.realSec).toFixed(2)) : 0;
  }
  const rssM = stderr.match(/(\d+)\s+maximum resident set size/);
  if (rssM) res.maxRssGB = Number((Number(rssM[1]) / (1024 ** 3)).toFixed(3));
  const fpM = stderr.match(/(\d+)\s+peak memory footprint/);
  if (fpM) res.peakFootprintGB = Number((Number(fpM[1]) / (1024 ** 3)).toFixed(3));
  const insM = stderr.match(/(\d+)\s+instructions retired/);
  if (insM) res.instructionsBillions = Number((Number(insM[1]) / 1e9).toFixed(2));
  const cycM = stderr.match(/(\d+)\s+cycles elapsed/);
  if (cycM) res.cyclesBillions = Number((Number(cycM[1]) / 1e9).toFixed(2));
  if (res.instructionsBillions && res.cyclesBillions) {
    res.ipc = Number((res.instructionsBillions / res.cyclesBillions).toFixed(2));
  }
  const prM = stderr.match(/(\d+)\s+page reclaims/);
  if (prM) res.pageReclaims = Number(prM[1]);
  const vcsM = stderr.match(/(\d+)\s+voluntary context switches/);
  if (vcsM) res.voluntaryCtxSwitches = Number(vcsM[1]);
  const icsM = stderr.match(/(\d+)\s+involuntary context switches/);
  if (icsM) res.involuntaryCtxSwitches = Number(icsM[1]);
  return res;
}

function runMeasured({name, cmd, args, cwd, env = {}, stopOnBuiltIn = false, timeoutMs = 420000}) {
  return new Promise((resolve, reject) => {
    console.log(`\n>>> Running [${name}]...`);
    const start = performance.now();
    const phases = [];
    let builtIn = null;
    let builtAtMs = null;
    let peakTreeRssKb = 0;
    let peakTreeCpu = 0;
    let peakTreeProcs = 0;
    let samples = 0;
    let allOut = '';
    let allErr = '';
    let stopTriggered = false;

    // Run under /usr/bin/time -l so we get kernel rusage even when terminating child on Built in
    const child = spawn('/usr/bin/time', ['-l', cmd, ...args], {
      cwd,
      env: {...process.env, ...env},
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const interval = setInterval(() => {
      const s = sampleProcessTree(child.pid);
      if (s) {
        samples++;
        if (s.totalRssKb > peakTreeRssKb) peakTreeRssKb = s.totalRssKb;
        if (s.totalCpu > peakTreeCpu) peakTreeCpu = s.totalCpu;
        if (s.count > peakTreeProcs) peakTreeProcs = s.count;
      }
    }, 100);

    const timer = setTimeout(() => {
      clearInterval(interval);
      const s = sampleProcessTree(child.pid);
      if (s) for (const p of s.childPids) { try { process.kill(p, 'SIGKILL'); } catch {} }
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`Timeout after ${timeoutMs}ms for ${name}\nOUT:\n${allOut.slice(-1000)}\nERR:\n${allErr.slice(-1000)}`));
    }, timeoutMs);

    const phasePatterns = [
      ['Building', /Building\.\.\./],
      ['Bundling', /Bundling\.\.\./],
      ['Packaging & Optimizing', /Packaging & Optimizing\.\.\./],
      ['Writing cache', /Writing cache to disk/],
      ['Build failed', /Build failed/i],
      ['Built in', /Built in ([0-9.]+(?:ms|s))/i]
    ];

    function checkLines(text) {
      const elapsed = Math.round(performance.now() - start);
      for (const [label, rx] of phasePatterns) {
        const m = text.match(rx);
        if (m) {
          if (!phases.some(p => p.phase === label)) {
            phases.push({phase: label, atMs: elapsed, detail: m[1] || undefined});
            console.log(`  [${(elapsed / 1000).toFixed(2)}s] ${label}${m[1] ? ': ' + m[1] : ''}`);
          }
          if (label === 'Build failed' && stopOnBuiltIn && !stopTriggered) {
            stopTriggered = true;
            setTimeout(() => {
              const s = sampleProcessTree(child.pid);
              if (s) for (const p of s.childPids) { try { process.kill(p, 'SIGTERM'); } catch {} }
            }, 500);
          }
          if (label === 'Built in' && !builtIn) {
            builtIn = m[1];
            builtAtMs = elapsed;
            if (stopOnBuiltIn && !stopTriggered) {
              stopTriggered = true;
              // Wait 300ms for Parcel 2 cache flush message if any, or kill direct children cleanly so /usr/bin/time -l reports rusage
              setTimeout(() => {
                const s = sampleProcessTree(child.pid);
                if (s) {
                  if (s.totalRssKb > peakTreeRssKb) peakTreeRssKb = s.totalRssKb;
                  if (s.count > peakTreeProcs) peakTreeProcs = s.count;
                  // Kill descendants (the parcel process) so /usr/bin/time -l catches exit and prints rusage
                  for (const p of s.childPids) {
                    try { process.kill(p, 'SIGTERM'); } catch {}
                  }
                  setTimeout(() => {
                    const s2 = sampleProcessTree(child.pid);
                    if (s2) for (const p of s2.childPids) { try { process.kill(p, 'SIGKILL'); } catch {} }
                  }, 4000);
                }
              }, 500);
            }
          }
        }
      }
    }

    child.stdout.on('data', chunk => {
      const text = chunk.toString('utf8');
      allOut += text;
      if (allOut.length > 50000) allOut = allOut.slice(-25000);
      checkLines(text);
    });

    child.stderr.on('data', chunk => {
      const text = chunk.toString('utf8');
      allErr += text;
      if (allErr.length > 50000) allErr = allErr.slice(-25000);
      checkLines(text);
    });

    child.on('close', code => {
      clearInterval(interval);
      clearTimeout(timer);
      const totalWallMs = Math.round(performance.now() - start);
      const rusage = parseTimeL(allErr);
      const result = {
        name,
        exitCode: stopOnBuiltIn && builtIn ? 0 : code,
        builtIn,
        builtAtMs: builtAtMs ?? totalWallMs,
        totalWallMs,
        phases,
        rusage,
        psSampled: {
          samples,
          peakTreeRssGB: Number((peakTreeRssKb / (1024 * 1024)).toFixed(3)),
          peakTreeCpuPct: Math.round(peakTreeCpu),
          peakTreeProcs
        }
      };
      if (!builtIn && code !== 0) {
        result.errorTail = (allOut + '\n' + allErr).slice(-1500);
        console.log('  ERROR TAIL:\n' + result.errorTail);
      }
      console.log(`  DONE [${name}]: builtIn=${result.builtIn}, wall=${result.builtAtMs}ms, footprint=${rusage.peakFootprintGB}GB, psRSS=${result.psSampled.peakTreeRssGB}GB, procs=${result.psSampled.peakTreeProcs}, cores=${rusage.effectiveCores}`);
      resolve(result);
    });
  });
}

function cleanLibraryDist() {
  const dirs = execSync(
    'ls -d packages/*/*/dist packages/{react-aria,react-aria-components,react-stately}/dist packages/@react-spectrum/s2/style/dist packages/@react-spectrum/s2/icons packages/@react-spectrum/s2/illustrations 2>/dev/null || true',
    {cwd: RS, shell: '/bin/bash', encoding: 'utf8'}
  ).trim().split('\n').filter(Boolean).map(d => path.join(RS, d));
  rmSafe(dirs);
}

function getLibraryDistStats() {
  const dirs = execSync(
    'ls -d packages/*/*/dist packages/{react-aria,react-aria-components,react-stately}/dist packages/@react-spectrum/s2/style/dist packages/@react-spectrum/s2/icons packages/@react-spectrum/s2/illustrations 2>/dev/null || true',
    {cwd: RS, shell: '/bin/bash', encoding: 'utf8'}
  ).trim().split('\n').filter(Boolean).map(d => path.join(RS, d));
  return dirStats(dirs);
}

async function main() {
  const only = process.argv.slice(2);
  const want = k => only.length === 0 || only.includes(k);
  const resultsPath = path.join(ROOT, 'results.json');
  let results = fs.existsSync(resultsPath) ? JSON.parse(fs.readFileSync(resultsPath, 'utf8')) : {};
  const PATH_WITH_BIN = `${path.join(RS, 'node_modules/.bin')}:${process.env.PATH}`;

  // --- 1. STORYBOOK S2 (dev builds via real storybook dev) ---
  const SB_BIN = path.join(RS, 'node_modules/.bin/storybook');
  if (want('storybook')) {
    // Parcel 3 dev
    rmSafe([path.join(RS, 'packages/dev/storybook-builder-parcel/generated-entries')]);
    const r3 = await runMeasured({
      name: 'storybook-p3-dev',
      cmd: SB_BIN,
      args: ['dev', '-p', '6006', '--ci', '-c', '.storybook-s2', '--no-open'],
      cwd: RS,
      env: {NODE_ENV: 'storybook', PARCEL_V3: '1', PATH: PATH_WITH_BIN},
      stopOnBuiltIn: true
    });
    results['storybook-p3-dev'] = r3;
    fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));

    // Parcel 2 dev (cold)
    rmSafe([
      path.join(RS, 'packages/dev/storybook-builder-parcel/generated-entries'),
      path.join(RS, '.parcel-cache'),
      path.join(RS, 'node_modules/.cache/docgen')
    ]);
    const r2Cold = await runMeasured({
      name: 'storybook-p2-dev-cold',
      cmd: SB_BIN,
      args: ['dev', '-p', '6006', '--ci', '-c', '.storybook-s2', '--no-open'],
      cwd: RS,
      env: {NODE_ENV: 'storybook', NODE_OPTIONS: '--max-old-space-size=16384', PATH: PATH_WITH_BIN},
      stopOnBuiltIn: true
    });
    r2Cold.cacheSize = dirStats([path.join(RS, '.parcel-cache')]);
    results['storybook-p2-dev-cold'] = r2Cold;
    fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));

    // Parcel 2 dev (warm - reusing .parcel-cache)
    const r2Warm = await runMeasured({
      name: 'storybook-p2-dev-warm',
      cmd: SB_BIN,
      args: ['dev', '-p', '6006', '--ci', '-c', '.storybook-s2', '--no-open'],
      cwd: RS,
      env: {NODE_ENV: 'storybook', NODE_OPTIONS: '--max-old-space-size=16384', PATH: PATH_WITH_BIN},
      stopOnBuiltIn: true
    });
    results['storybook-p2-dev-warm'] = r2Warm;
    fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  }

  // --- 2. DOCS WEBSITE (dev builds) ---
  const docsDir = path.join(RS, 'packages/dev/s2-docs');
  if (want('docs')) {
    // Parcel 3 dev
    rmSafe([path.join(docsDir, 'dist/bench-p3')]);
    const r3 = await runMeasured({
      name: 'docs-p3-dev',
      cmd: P3_BIN,
      args: ['watch', 'server.tsx', '--config', '.parcelrc-s2-docs-v3', '--dist-dir', 'dist/bench-p3'],
      cwd: docsDir,
      env: {PARCEL_V3: '1', DOCS_ENV: 'dev'},
      stopOnBuiltIn: true
    });
    r3.output = dirStats([path.join(docsDir, 'dist/bench-p3')]);
    results['docs-p3-dev'] = r3;
    fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));

    // Parcel 2 dev (cold)
    rmSafe([path.join(docsDir, 'dist/bench-p2'), path.join(docsDir, '.parcel-cache'), path.join(RS, '.parcel-cache')]);
    const r2Cold = await runMeasured({
      name: 'docs-p2-dev-cold',
      cmd: P2_BIN,
      args: ['watch', 'pages/**/*.mdx', '--config', '.parcelrc-s2-docs', '--dist-dir', 'dist/bench-p2', '--cache-dir', '.parcel-cache'],
      cwd: docsDir,
      env: {DOCS_ENV: 'dev'},
      stopOnBuiltIn: true
    });
    r2Cold.output = dirStats([path.join(docsDir, 'dist/bench-p2')]);
    r2Cold.cacheSize = dirStats([path.join(docsDir, '.parcel-cache')]);
    results['docs-p2-dev-cold'] = r2Cold;
    fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));

    // Parcel 2 dev (warm)
    rmSafe([path.join(docsDir, 'dist/bench-p2')]);
    const r2Warm = await runMeasured({
      name: 'docs-p2-dev-warm',
      cmd: P2_BIN,
      args: ['watch', 'pages/**/*.mdx', '--config', '.parcelrc-s2-docs', '--dist-dir', 'dist/bench-p2', '--cache-dir', '.parcel-cache'],
      cwd: docsDir,
      env: {DOCS_ENV: 'dev'},
      stopOnBuiltIn: true
    });
    r2Warm.output = dirStats([path.join(docsDir, 'dist/bench-p2')]);
    results['docs-p2-dev-warm'] = r2Warm;
    fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  }

  // --- 3. LIBRARY BUILD (~159 packages, --no-optimize) ---
  if (want('library')) {
    const entries = expandBuildEntries();

    // Parcel 3 library build
    execSync('PARCEL_V3=1 node scripts/generateS2IconIndex.js', {cwd: RS, stdio: 'inherit'});
    cleanLibraryDist();
    const r3 = await runMeasured({
      name: 'library-p3-cold',
      cmd: P3_BIN,
      args: ['build', ...entries, '--no-optimize', '--config', 'parcel-v3/.parcelrc-build'],
      cwd: RS,
      env: {PARCEL_V3: '1'},
      stopOnBuiltIn: false
    });
    r3.output = getLibraryDistStats();
    results['library-p3-cold'] = r3;
    fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));

    // Restore clean s2 icon files for Parcel 2
    execSync('git checkout -- packages/@react-spectrum/s2', {cwd: RS, stdio: 'inherit'});
    cleanLibraryDist();
    rmSafe([path.join(RS, '.parcel-cache')]);

    // Parcel 2 library build (cold)
    const r2Cold = await runMeasured({
      name: 'library-p2-cold',
      cmd: P2_BIN,
      args: ['build', ...entries, '--no-optimize', '--config', '.parcelrc-build', '--cache-dir', '.parcel-cache'],
      cwd: RS,
      env: {},
      stopOnBuiltIn: false
    });
    r2Cold.output = getLibraryDistStats();
    r2Cold.cacheSize = dirStats([path.join(RS, '.parcel-cache')]);
    results['library-p2-cold'] = r2Cold;
    fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));

    // Parcel 2 library build (warm)
    cleanLibraryDist();
    const r2Warm = await runMeasured({
      name: 'library-p2-warm',
      cmd: P2_BIN,
      args: ['build', ...entries, '--no-optimize', '--config', '.parcelrc-build', '--cache-dir', '.parcel-cache'],
      cwd: RS,
      env: {},
      stopOnBuiltIn: false
    });
    r2Warm.output = getLibraryDistStats();
    results['library-p2-warm'] = r2Warm;
    fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  }

  console.log('\n=== ALL REQUESTED BENCHMARKS COMPLETE ===');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
