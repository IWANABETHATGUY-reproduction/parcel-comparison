import {execSync, spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const RS = path.join(ROOT, 'react-spectrum');
const P2_BIN = path.join(RS, 'node_modules/.bin/parcel');
const P3_BIN = path.join(RS, 'node_modules/.bin/parcel3');

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
  if (rssM) res.maxRssGB = Number((Number(rssM[1]) / 1024 ** 3).toFixed(3));
  const fpM = stderr.match(/(\d+)\s+peak memory footprint/);
  if (fpM) res.peakFootprintGB = Number((Number(fpM[1]) / 1024 ** 3).toFixed(3));
  const insM = stderr.match(/(\d+)\s+instructions retired/);
  if (insM) res.instructionsBillions = Number((Number(insM[1]) / 1e9).toFixed(2));
  return res;
}

function runCmd(name, cmd, args, cwd, env = {}) {
  return new Promise(resolve => {
    console.log(`\n>>> [${name}]...`);
    const t0 = performance.now();
    const phases = [];
    let out = '';
    let err = '';
    let builtIn = null;
    const child = spawn('/usr/bin/time', ['-l', cmd, ...args], {
      cwd,
      env: {...process.env, ...env},
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const check = text => {
      const elapsed = Math.round(performance.now() - t0);
      for (const [label, rx] of [
        ['Building', /Building\.\.\./],
        ['Bundling', /Bundling\.\.\./],
        ['Packaging & Optimizing', /Packaging & Optimizing\.\.\./],
        ['Built in', /Built in ([0-9.]+(?:ms|s))/i]
      ]) {
        const m = text.match(rx);
        if (m && !phases.some(p => p.phase === label)) {
          phases.push({phase: label, atMs: elapsed, detail: m[1] || undefined});
          console.log(`  [${(elapsed / 1000).toFixed(2)}s] ${label}${m[1] ? ': ' + m[1] : ''}`);
          if (label === 'Built in') builtIn = m[1];
        }
      }
    };
    child.stdout.on('data', d => { const s = d.toString(); out += s; if (out.length > 40000) out = out.slice(-20000); check(s); });
    child.stderr.on('data', d => { const s = d.toString(); err += s; if (err.length > 40000) err = err.slice(-20000); check(s); });
    child.on('close', code => {
      const rusage = parseTimeL(err);
      const wallMs = Math.round(performance.now() - t0);
      console.log(`  DONE [${name}] code=${code} wall=${wallMs}ms builtIn=${builtIn} footprint=${rusage.peakFootprintGB}GB cores=${rusage.effectiveCores}`);
      resolve({name, code, wallMs, builtIn, phases, rusage, errTail: code !== 0 ? (out + err).slice(-800) : undefined});
    });
  });
}

async function main() {
  const out = {};

  // Ablation 1: Library Parcel 2 with --no-cache (isolates LMDB cache write overhead)
  const entries = execSync(
    'ls -d packages/@react-{spectrum,aria,stately}/*/ packages/@internationalized/{message,string,date,number}/ packages/{react-aria,react-stately,react-aria-components,@adobe/react-spectrum}',
    {cwd: RS, shell: '/bin/bash', encoding: 'utf8'}
  ).trim().split('\n').filter(Boolean);
  execSync(
    'rm -rf .parcel-cache packages/*/*/dist packages/{react-aria,react-aria-components,react-stately}/dist packages/@react-spectrum/s2/style/dist packages/@react-spectrum/s2/icons packages/@react-spectrum/s2/illustrations',
    {cwd: RS, shell: '/bin/bash'}
  );
  out.libraryP2NoCache = await runCmd(
    'library-p2-no-cache',
    P2_BIN,
    ['build', ...entries, '--no-optimize', '--no-cache', '--config', '.parcelrc-build'],
    RS
  );

  // Ablation 2: Docs Parcel 3 FULL SSG (build + node prerender for both s2 and react-aria)
  const docsDir = path.join(RS, 'packages/dev/s2-docs');
  fs.rmSync(path.join(docsDir, 'dist/ssg-s2'), {recursive: true, force: true});
  fs.rmSync(path.join(docsDir, 'dist/ssg-ra'), {recursive: true, force: true});

  out.docsP3BuildS2 = await runCmd(
    'docs-p3-build-ssg-s2',
    P3_BIN,
    ['build', 'ssg-s2.tsx', '--no-optimize', '--config', '.parcelrc-s2-docs-v3', '--dist-dir', 'dist/ssg-s2'],
    docsDir,
    {LIBRARY: 's2', PARCEL_V3: '1', PUBLIC_URL: '/'}
  );
  if (out.docsP3BuildS2.code === 0) {
    out.docsP3RenderS2 = await runCmd(
      'docs-p3-render-ssg-s2',
      'node',
      ['dist/ssg-s2/server/ssg-s2.js'],
      docsDir,
      {LIBRARY: 's2'}
    );
  }

  out.docsP3BuildRA = await runCmd(
    'docs-p3-build-ssg-ra',
    P3_BIN,
    ['build', 'ssg-react-aria.tsx', '--no-optimize', '--config', '.parcelrc-s2-docs-v3', '--dist-dir', 'dist/ssg-ra'],
    docsDir,
    {LIBRARY: 'react-aria', PARCEL_V3: '1', PUBLIC_URL: '/'}
  );
  if (out.docsP3BuildRA.code === 0) {
    out.docsP3RenderRA = await runCmd(
      'docs-p3-render-ssg-ra',
      'node',
      ['dist/ssg-ra/server/ssg-react-aria.js'],
      docsDir,
      {LIBRARY: 'react-aria'}
    );
  }

  // Ablation 3: Parcel 3 Library build WITH --optimize (minification enabled)
  execSync('PARCEL_V3=1 node scripts/generateS2IconIndex.js', {cwd: RS});
  execSync(
    'rm -rf packages/*/*/dist packages/{react-aria,react-aria-components,react-stately}/dist packages/@react-spectrum/s2/style/dist packages/@react-spectrum/s2/icons packages/@react-spectrum/s2/illustrations',
    {cwd: RS, shell: '/bin/bash'}
  );
  out.libraryP3Optimized = await runCmd(
    'library-p3-optimized',
    P3_BIN,
    ['build', ...entries, '--config', 'parcel-v3/.parcelrc-build'],
    RS,
    {PARCEL_V3: '1'}
  );

  // Restore clean git state in react-spectrum
  execSync('git checkout -- packages/@react-spectrum/s2', {cwd: RS});

  fs.writeFileSync(path.join(ROOT, 'ablation.json'), JSON.stringify(out, null, 2));
  console.log('\n=== ABLATIONS COMPLETE ===');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
