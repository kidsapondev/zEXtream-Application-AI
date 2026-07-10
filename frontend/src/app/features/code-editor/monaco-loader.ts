// Classic AMD-loader integration (no monaco-editor-webpack-plugin, since Angular's
// esbuild `application` builder doesn't support webpack plugins). The `vs` folder is
// copied into the build output via angular.json's assets config, served at
// /assets/monaco-vs. This is the same approach most raw (non-webpack) Monaco
// integrations use.

type MonacoNamespace = typeof import('monaco-editor');

declare global {
  interface Window {
    require: {
      config: (options: { paths: Record<string, string> }) => void;
      (deps: string[], callback: () => void): void;
    };
    monaco: MonacoNamespace;
  }
}

const BASE_URL = '/assets/monaco-vs';

let loadPromise: Promise<MonacoNamespace> | null = null;

export function loadMonaco(): Promise<MonacoNamespace> {
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    (self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
      getWorkerUrl: () =>
        `data:text/javascript;charset=utf-8,${encodeURIComponent(`
          self.MonacoEnvironment = { baseUrl: '${BASE_URL}' };
          importScripts('${BASE_URL}/base/worker/workerMain.js');
        `)}`,
    };

    const script = document.createElement('script');
    script.src = `${BASE_URL}/loader.js`;
    script.onload = () => {
      window.require.config({ paths: { vs: BASE_URL } });
      window.require(['vs/editor/editor.main'], () => resolve(window.monaco));
    };
    script.onerror = () => reject(new Error('Failed to load Monaco loader.js'));
    document.body.appendChild(script);
  });

  return loadPromise;
}
