
/**
 * Dependency-free assertion shim with the small subset of the Jest/Vitest
 * `expect` API used by these specs.
 *
 * The sandbox this repo is developed in cannot spawn esbuild/Vitest workers, and
 * pnpm's isolated layout makes Jest's `expect` package unresolvable from symlinked
 * store paths — so tests run on Node's built-in test runner with this shim.
 * The specs stay standard (`describe`/`it`/`expect`) and also run under Vitest in
 * normal CI via `pnpm test:vitest`.
 */

export interface AsymmetricMatcher {
  matches(value: unknown): boolean;
  describe(): string;
}

function isAsymmetric(value: unknown): value is AsymmetricMatcher {
  return (
    typeof value === 'object' &&
    value !== null &&
    'matches' in value &&
    typeof (value as AsymmetricMatcher).matches === 'function'
  );
}

/** Matches an array that contains all given items (in any order). */
export function arrayContaining(sample: readonly unknown[]): AsymmetricMatcher {
  return {
    matches: (value) =>
      Array.isArray(value) &&
      sample.every((item) => (value as unknown[]).some((candidate) => matchesValue(candidate, item))),
    describe: () => `arrayContaining(${JSON.stringify(sample)})`,
  };
}

/** Matches an object whose properties are a superset of `sample`. */
export function objectContaining(sample: Record<string, unknown>): AsymmetricMatcher {
  return {
    matches: (value) => {
      if (typeof value !== 'object' || value === null) return false;
      const record = value as Record<string, unknown>;
      return Object.entries(sample).every(([key, expected]) => matchesValue(record[key], expected));
    },
    describe: () => `objectContaining(${JSON.stringify(sample)})`,
  };
}

function matchesValue(actual: unknown, expected: unknown): boolean {
  if (isAsymmetric(expected)) return expected.matches(actual);
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) => matchesValue(actual[index], item))
    );
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object') return false;
    const actualRecord = actual as Record<string, unknown>;
    const expectedRecord = expected as Record<string, unknown>;
    const expectedKeys = Object.keys(expectedRecord);
    const actualKeys = Object.keys(actualRecord);
    if (expectedKeys.length !== actualKeys.length) return false;
    return expectedKeys.every((key) => matchesValue(actualRecord[key], expectedRecord[key]));
  }
  return Object.is(actual, expected);
}

function format(value: unknown): string {
  if (isAsymmetric(value)) return value.describe();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface Matchers {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toThrow(pattern?: RegExp | string | ErrorConstructor): void;
  toContain(item: unknown): void;
  toHaveLength(length: number): void;
  toBeGreaterThan(value: number): void;
  toBeNull(): void;
  toBeUndefined(): void;
  toHaveProperty(path: string): void;
  toMatch(pattern: RegExp | string): void;
  not: Matchers;
}

function buildMatchers(actual: unknown, negate: boolean, withNot = true): Matchers {
  const check = (passes: boolean, message: string, description: string): void => {
    const ok = negate ? !passes : passes;
    if (!ok) {
      throw new Error(`${negate ? 'NOT ' : ''}${description}: ${message}`);
    }
  };

  const matchers: Matchers = {
    toBe(expected) {
      check(
        Object.is(actual, expected),
        `expected ${format(actual)} to be ${format(expected)}`,
        'toBe',
      );
    },
    toEqual(expected) {
      check(
        matchesValue(actual, expected),
        `expected ${format(actual)} to equal ${format(expected)}`,
        'toEqual',
      );
    },
    toThrow(pattern) {
      let thrown: unknown;
      let didThrow = false;
      try {
        (actual as () => unknown)();
      } catch (error) {
        didThrow = true;
        thrown = error;
      }
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      const matchesPattern =
        pattern === undefined ||
        (pattern instanceof RegExp
          ? pattern.test(message)
          : typeof pattern === 'string'
            ? message.includes(pattern)
            : thrown instanceof pattern);
      const passes = didThrow && matchesPattern;
      check(passes, `expected function ${didThrow ? `to throw ${format(message)}` : 'to throw'}`, 'toThrow');
    },
    toContain(item) {
      const passes =
        typeof actual === 'string'
          ? actual.includes(String(item))
          : Array.isArray(actual) && (actual as unknown[]).some((entry) => matchesValue(entry, item));
      check(passes, `expected ${format(actual)} to contain ${format(item)}`, 'toContain');
    },
    toHaveLength(length) {
      const size = (actual as { length?: unknown }).length;
      check(size === length, `expected length ${String(size)} to be ${length}`, 'toHaveLength');
    },
    toBeGreaterThan(value) {
      check(
        typeof actual === 'number' && actual > value,
        `expected ${format(actual)} to be greater than ${value}`,
        'toBeGreaterThan',
      );
    },
    toBeNull() {
      check(actual === null, `expected ${format(actual)} to be null`, 'toBeNull');
    },
    toBeUndefined() {
      check(actual === undefined, `expected ${format(actual)} to be undefined`, 'toBeUndefined');
    },
    toHaveProperty(path) {
      const segments = path.split('.');
      let cursor: unknown = actual;
      let found = true;
      for (const segment of segments) {
        if (cursor === null || typeof cursor !== 'object' || !(segment in cursor)) {
          found = false;
          break;
        }
        cursor = (cursor as Record<string, unknown>)[segment];
      }
      check(found, `expected ${format(actual)} to have property ${path}`, 'toHaveProperty');
    },
    toMatch(pattern) {
      const source = typeof actual === 'string' ? actual : String(actual);
      const passes = pattern instanceof RegExp ? pattern.test(source) : source.includes(pattern);
      check(passes, `expected ${format(source)} to match ${String(pattern)}`, 'toMatch');
    },
    not: undefined as unknown as Matchers,
  };
  if (withNot) {
    matchers.not = buildMatchers(actual, !negate, false);
  }
  return matchers;
}

/** Creates matchers for `actual`; supports `.not` and the asymmetric helpers above. */
export interface ExpectFn {
  (actual: unknown): Matchers;
  arrayContaining: typeof arrayContaining;
  objectContaining: typeof objectContaining;
}

export const expect: ExpectFn = Object.assign(
  (actual: unknown): Matchers => buildMatchers(actual, false),
  { arrayContaining, objectContaining },
);
