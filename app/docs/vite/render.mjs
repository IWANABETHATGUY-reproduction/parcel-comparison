import fs from 'node:fs/promises';
import {availableParallelism} from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pathToFileURL} from 'node:url';
import {isMainThread, Worker, workerData} from 'node:worker_threads';
import {docsRoot} from './prepare-types.mjs';

const [directory = 'docs-dist', scope = 'all'] = process.argv.slice(2);
const output = path.resolve(directory);
process.env.NODE_ENV ??= 'production';
if (isMainThread) process.chdir(docsRoot);

for (const library of scope === 'all' ? ['s2', 'react-aria'] : [scope]) {
  const bundle = path.join(output, 'server', library, 'rsc/index.js');
  const {pages, renderPage} = await import(pathToFileURL(bundle).href);
  if (isMainThread) {
    const count = Math.min(availableParallelism(), pages.length);
    const results = await Promise.allSettled(Array.from({length: count}, (_, index) => new Promise((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), {
        argv: [output, library],
        workerData: pages.slice(Math.floor(index * pages.length / count), Math.floor((index + 1) * pages.length / count))
      });
      worker.once('error', reject);
      worker.once('exit', code => code ? reject(new Error(`Render worker exited ${code}`)) : resolve());
    })));
    if (results.some(result => result.status === 'rejected')) {
      console.error(`One or more ${library} pages failed to render`);
      process.exitCode = 1;
    } else {
      console.log(`Rendered ${pages.length} ${library} HTML and RSC page pairs`);
    }
    continue;
  }
  const failed = [];
  for (const page of workerData) {
    try {
      const {html, rsc} = await renderPage(page);
      const file = path.join(output, 'site', library, page.replace(/\.mdx$/, ''));
      await fs.mkdir(path.dirname(file), {recursive: true});
      await Promise.all([
        fs.writeFile(`${file}.html`, Readable.fromWeb(html)),
        fs.writeFile(`${file}.rsc`, Readable.fromWeb(rsc))
      ]);
    } catch (error) {
      failed.push(page);
      console.error(`${library}/${page}`, (error.errors ?? [error]).map(cause => cause?.message).filter(Boolean).join('\n'));
    }
  }
  if (failed.length) process.exitCode = 1;
}
