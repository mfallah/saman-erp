import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom gaps used by TanStack Router / Recharts in tests.
if (typeof window !== 'undefined') {
  window.scrollTo = () => undefined;
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
