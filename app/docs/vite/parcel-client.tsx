'use client';

import {startTransition, use, useEffect, useState, type ReactNode} from 'react';
import {hydrateRoot} from 'react-dom/client';
import {createFromReadableStream} from '@vitejs/plugin-rsc/browser';
import {rscStream} from 'rsc-html-stream/client';

export async function fetchRSC<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok || !response.body) throw new Error(`RSC request failed (${response.status}) for ${url}`);
  return await createFromReadableStream(response.body);
}

export function hydrate() {
  const initial = createFromReadableStream<ReactNode>(rscStream);
  const callbacks = new Map<ReactNode, () => void>();
  let update: (content: ReactNode) => void;
  function App() {
    const initialContent = use(initial);
    const [content, setContent] = useState(initialContent);
    update = setContent;
    useEffect(() => {
      const callback = callbacks.get(content);
      callbacks.clear();
      callback?.();
    }, [content]);
    return content;
  }
  hydrateRoot(document, <App />);
  return (content: ReactNode, onCommit: () => void) => {
    callbacks.set(content, onCommit);
    startTransition(() => update(content));
  };
}
