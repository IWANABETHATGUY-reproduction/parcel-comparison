import {createElement} from 'react';
import {renderToReadableStream} from '@vitejs/plugin-rsc/rsc';
import routes from 'virtual:spectrum-docs-routes';

export const pages = Object.keys(routes);

export async function renderPage(name: string) {
  const {default: Page, tableOfContents, pageExports} = await routes[name]();
  const pagePath = name.replace(/\.mdx$/, '');
  const root = createElement(Page, {
    currentPage: {
      name: `${pagePath}.html`,
      url: `/${pagePath}`,
      tableOfContents,
      exports: pageExports
    }
  });
  const errors: unknown[] = [];
  const stream = renderToReadableStream(root, {onError(error) { errors.push(error); }});
  const [htmlInput, wire] = stream.tee();
  const [inject, rsc] = wire.tee();
  const ssr = await import.meta.viteRsc.loadModule<typeof import('./entry.ssr')>('ssr', 'index');
  let html;
  try {
    html = await ssr.renderHtml(htmlInput, inject);
  } catch (error) {
    throw new AggregateError([...errors, error], `HTML rendering failed for ${name}`);
  }
  if (errors.length) throw new AggregateError(errors, `RSC rendering failed for ${name}`);
  return {html, rsc};
}
