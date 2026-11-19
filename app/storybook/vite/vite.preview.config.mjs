import path from 'node:path';
import {defineConfig} from 'vite';
import mdx from '@mdx-js/rollup';
import remarkGfm from 'remark-gfm';
import {buildWorkspaceAliases, reactSpectrumPlugins} from '../../../shared/plugins.mjs';

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'storybook')
  },
  resolve: {
    conditions: ['source', 'import', 'module', 'default'],
    extensions: ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json', '.svg'],
    alias: buildWorkspaceAliases()
  },
  css: {
    postcss: {plugins: []}
  },
  plugins: reactSpectrumPlugins({
    extraPlugins: [
      {
        enforce: 'pre',
        ...mdx({
          remarkPlugins: [remarkGfm],
          providerImportSource: '@mdx-js/react'
        })
      }
    ]
  }),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    sourcemap: true,
    cssMinify: 'lightningcss',
    rolldownOptions: {
      moduleTypes: {
        '.js': 'jsx'
      },
      output: {
        codeSplitting: {
          groups: [
            {
              name: 's2-styles',
              test: /@react-spectrum\/s2\/.*\.css$|macro-.*\.css$/
            }
          ]
        }
      }
    }
  }
});
