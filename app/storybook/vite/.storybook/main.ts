import path from 'node:path';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {mergeConfig, transformWithOxc} from 'vite';
import upstream from '../../../../react-spectrum/.storybook-s2/main.ts';
import {RS, buildWorkspaceAliases, reactSpectrumPlugins} from '../../../../shared/plugins.mjs';

const requireUpstream = createRequire(path.join(RS, 'package.json'));
const source = path.join(RS, '.storybook-s2');

export default {
  ...upstream,
  stories: upstream.stories!.map((pattern: string) =>
    path.relative(import.meta.dirname, path.resolve(source, pattern))
  ),
  addons: upstream.addons!.map((addon: string) =>
    path.isAbsolute(addon) ? addon : path.dirname(requireUpstream.resolve(`${addon}/package.json`))
  ),
  framework: {
    name: '@storybook/react-vite',
    options: {}
  },
  typescript: {reactDocgen: false},
  previewHead: (head: string) => `${head}\n${readFileSync(path.join(source, 'preview-head.html'), 'utf8')}`,
  managerHead: (head: string) => `${head}\n${readFileSync(path.join(source, 'manager-head.html'), 'utf8')}`,
  viteFinal(config) {
    return mergeConfig(config, {
      resolve: {
        conditions: ['source', 'module', 'browser', 'development|production'],
        extensions: ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json', '.svg'],
        alias: buildWorkspaceAliases(),
        dedupe: ['react', 'react-dom', 'storybook']
      },
      css: {postcss: {plugins: []}},
      plugins: [
        ...reactSpectrumPlugins({enableReact: false}),
        {
          name: 'spectrum-storybook-transpile',
          async transform(code, id) {
            if (id.startsWith(`${RS}/`) && !id.includes('/node_modules/') && /\.[jt]sx?$/.test(id)) {
              return transformWithOxc(code, id, {jsx: {runtime: 'automatic'}});
            }
          }
        }
      ],
      build: {
        sourcemap: true,
        reportCompressedSize: false,
        rolldownOptions: {
          moduleTypes: {'.js': 'jsx'},
          output: {
            codeSplitting: {
              groups: [{name: 's2-styles', test: /@react-spectrum\/s2\/.*\.css$|macro-.*\.css$/}]
            }
          }
        }
      }
    });
  }
};
