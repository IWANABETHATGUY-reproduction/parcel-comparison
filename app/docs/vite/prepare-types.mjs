import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import {RS} from '../../../shared/plugins.mjs';
import {parcelExecutable} from '../../../shared/parcel.mjs';

export const docsRoot = path.join(RS, 'packages/dev/s2-docs');

export function typeDocKey(specifier, importer) {
  const source = specifier.slice('docs:'.length);
  return source.startsWith('.') ? path.resolve(path.dirname(importer), source) : source;
}

export async function prepareTypes(workspace, output) {
  const docs = path.join(workspace, 'packages/dev/s2-docs');
  const scratch = await fs.mkdtemp(path.join(docs, '.vite-type-docs-'));
  try {
    const files = await fg(['pages/**/*.{mdx,js,ts,tsx}', 'src/**/*.{mdx,js,ts,tsx}'], {cwd: docs, absolute: true});
    const names = new Map();
    for (const file of files.sort()) {
      const content = await fs.readFile(file, 'utf8');
      for (const [, specifier] of content.matchAll(/\bfrom\s+['"](docs:[^'"\r\n]+)['"]/g)) {
        const key = typeDocKey(specifier, file);
        names.set(key.startsWith(docs) ? docsRoot + key.slice(docs.length) : key, key);
      }
    }
    const imports = [];
    const entries = [];
    for (const [key, source] of names) {
      const id = `docs${imports.length}`;
      const specifier = path.isAbsolute(source) ? `./${path.relative(scratch, source)}` : source;
      imports.push(`import ${id} from ${JSON.stringify(`docs:${specifier}`)};`);
      entries.push(`${JSON.stringify(key)}:${id}`);
    }
    const entry = path.join(scratch, 'types.mjs');
    const dist = path.join(scratch, 'dist');
    await fs.writeFile(entry, `${imports.join('\n')}\nconsole.log(JSON.stringify({${entries.join(',')}}));\n`);
    execFileSync(parcelExecutable(workspace), ['build', entry, '--config', '.parcelrc-s2-docs-v3', '--dist-dir', dist, '--no-optimize'], {
      cwd: docs,
      stdio: 'inherit'
    });
    const [file] = await fg('**/types.{js,mjs,cjs}', {cwd: dist, absolute: true});
    const result = execFileSync(process.execPath, [file], {cwd: docs, maxBuffer: 64 * 1024 ** 2});
    await fs.mkdir(path.dirname(output), {recursive: true});
    await fs.writeFile(output, result);
    console.log(`Generated API documentation for ${names.size} type sources`);
  } finally {
    await fs.rm(scratch, {recursive: true, force: true});
  }
}

if (process.argv[1] === import.meta.filename) {
  await prepareTypes(process.argv[2] ?? RS, path.resolve(process.argv[3] ?? 'docs-types.json'));
}
