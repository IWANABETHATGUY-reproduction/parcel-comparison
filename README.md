# React Spectrum build benchmarks

Each app pairs the Vite and Parcel setups for one workload. Both tools build the same React Spectrum checkout at `7e229ef6139e08d3bf75d2ddb444425108f271ec`. The project uses Vite 8.3.8, Parcel 3.0.0-alpha.3, and Node 24.12.0 on macOS. [Vite release](https://github.com/vitejs/vite/releases/tag/v8.3.8)

## Set up a fresh clone

```sh
git clone --recurse-submodules https://github.com/IWANABETHATGUY-reproduction/parcel-comparison.git
cd parcel-comparison
npm ci
(cd react-spectrum && node .yarn/releases/yarn-4.18.0.cjs install --immutable)
```

For an existing clone, `git submodule update --init --recursive` brings in the pinned React Spectrum source.

## Workloads

| App | Workload | Vite setup | Parcel 3 setup |
| --- | --- | --- | --- |
| `app/storybook` | Spectrum 2 Storybook | [Storybook configuration](app/storybook/vite/.storybook/main.ts) | [Parcel configuration](app/storybook/parcel/.parcelrc-v3) |
| `app/docs` | Spectrum 2 and React Aria docs | [Build and prerender](app/docs/vite/) | [Parcel configuration](app/docs/parcel/.parcelrc-s2-docs-v3) |
| `app/library` | React Spectrum library packages | [Vite build](app/library/vite/build.mjs) | [Parcel configuration](app/library/parcel/.parcelrc-build) |

From the project root, `npm run benchmark` compares all three apps in three trials. This command runs one paired trial of Storybook.

```sh
BENCHMARK_TRIALS=1 npm run benchmark -- storybook
```

From any of the three app directories, `npm run build:vite` runs Vite, `npm run build:parcel` runs Parcel 3, and `npm run benchmark` compares them. The runner prints the paths to output, logs, and results. It creates a disposable React Spectrum checkout for the Parcel arm and installs the selected app's `parcel/` configs there. Use `--checkout <path>` to supply your own disposable checkout, or set `BENCHMARK_RESULTS` to choose where the new results go.

[Original three-trial results and methodology](benchmark-report.md) · [Recorded samples](benchmark-results.json)

The Parcel configs and transformers in `app/` come from the pinned React Spectrum revision. [React Spectrum license](licenses/react-spectrum/LICENSE)
