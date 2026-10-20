import { afterEach } from 'vitest';
import { JSDOM } from 'jsdom';

/**
 * jsdom bootstrap for the `node` Vitest environment.
 *
 * The standard `environment: 'jsdom'` asks Vitest to resolve the `jsdom`
 * package through the repo root, whose package.json is UTF-8-BOM encoded and
 * cannot be JSON-parsed by Vite's resolver in this sandbox. Bootstrapping jsdom
 * directly keeps the same DOM behaviour without that resolution step.
 */
const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body></body></html>', {
  url: 'http://localhost:5173/',
  pretendToBeVisual: true,
});

const jsdomWindow = dom.window;
const target = globalThis as unknown as Record<string, unknown>;

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  writable: true,
  value: jsdomWindow,
});
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  writable: true,
  value: jsdomWindow.document,
});
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  writable: true,
  value: jsdomWindow.navigator,
});

for (const key of Object.getOwnPropertyNames(jsdomWindow)) {
  if (key in globalThis) {
    continue;
  }
  try {
    target[key] = (jsdomWindow as unknown as Record<string, unknown>)[key];
  } catch {
    // Some DOM properties are non-configurable; they are not needed by tests.
  }
}

jsdomWindow.scrollTo = () => undefined;
(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const { cleanup } = await import('@testing-library/react');

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
