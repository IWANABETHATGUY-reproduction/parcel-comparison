# React Spectrum build benchmark

The benchmark uses the `react-spectrum` checkout at commit `7e229ef6139e08d3bf75d2ddb444425108f271ec`. It compares Vite 8.3.8 and Parcel 3.0.0-alpha.3 on macOS. The recorded runs use Node 24.12.0. [React Spectrum commit](https://github.com/adobe/react-spectrum/commit/7e229ef6139e08d3bf75d2ddb444425108f271ec) · [Vite release](https://github.com/vitejs/vite/releases/tag/v8.3.8) · [Parcel alpha announcement](https://v3.parceljs.org/blog/v3-alpha/)

## Results

Medians across three trials on an Apple M3 Max with 14 cores and 36 GiB RAM. Peak memory is sampled process-tree RSS.

| Workload | Parcel wall time | Vite wall time | Parcel peak RSS | Vite peak RSS |
| --- | ---: | ---: | ---: | ---: |
| Spectrum 2 Storybook | 2.33 s | 9.88 s | 1.82 GiB | 3.72 GiB |
| Docs bundle and prerender | 18.95 s | 40.82 s | 6.47 GiB | 5.43 GiB |
| Library build | 2.24 s | 12.72 s | 1.22 GiB | 2.01 GiB |

Both Storybook builds indexed the same 460 entries from 91 source files. Both docs pipelines emitted 334 HTML pages and 334 RSC payloads. Docs bundling took 1.47 s on Parcel and 26.59 s on Vite. Prerendering took 17.26 s on Parcel and 14.65 s on Vite. Each median is computed per trial, so the stage medians can differ from the median total.

The raw samples are in `benchmark-results.json`.

## Methodology

The runner uses three sequential trials per workload, alternating which tool goes first. Each trial launches new build processes and writes fresh outputs. OS file caches are warm after the first read. The raw JSON records wall time, user and system CPU time, macOS process memory, sampled process-tree RSS, and output counts. Process-tree RSS is sampled every 100 ms and can count shared pages in more than one process. [Run the benchmarks](README.md)

- **Storybook** uses the complete static manager and preview build, with Storybook 10.3.5 on both sides. Both arms use the original S2 and AI stories, MDX pages, and addons.
- **Docs** builds the Spectrum 2 and React Aria sites with minification off. The Vite build reuses React Spectrum's existing native MDX compiler and Parcel's TypeScript documentation generator. Their work is included in the Vite bundling time. HTML and React Server Component prerendering run as a separate timed stage.
- **Library** builds the 159 packages selected by React Spectrum's Makefile, with minification off and source maps enabled. The Vite port builds package and format targets individually. It emits Vite chunks and CSS assets, so distribution file layout differs. The timed stage covers JavaScript and CSS bundling. The Makefile's declaration generation and publishing steps sit outside this stage. [Package selection and build recipe](https://github.com/adobe/react-spectrum/blob/7e229ef6139e08d3bf75d2ddb444425108f271ec/Makefile#L110-L130)
