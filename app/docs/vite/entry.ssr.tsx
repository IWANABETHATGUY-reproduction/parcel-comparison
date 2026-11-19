import {prerender} from 'react-dom/static.edge';
import {createFromReadableStream, getClientEntryUrl} from '@vitejs/plugin-rsc/ssr';
import {injectRSCPayload} from 'rsc-html-stream/server';

export async function renderHtml(input: ReadableStream, payload: ReadableStream) {
  const content = await createFromReadableStream(input);
  const {prelude} = await prerender(content, {bootstrapModules: [getClientEntryUrl()]});
  return prelude.pipeThrough(injectRSCPayload(payload));
}
