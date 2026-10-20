/**
 * Minimal type declaration for the `jsdom` package (used by the Vitest setup).
 * `@types/jsdom` is intentionally not a dependency: only the tiny surface used
 * by the test bootstrap needs typing.
 */
declare module 'jsdom' {
  export interface JSDOMOptions {
    readonly url?: string;
    readonly pretendToBeVisual?: boolean;
    readonly runScripts?: 'dangerously' | 'outside-only';
  }

  export class JSDOM {
    constructor(html?: string, options?: JSDOMOptions);
    readonly window: Window & typeof globalThis;
  }
}
