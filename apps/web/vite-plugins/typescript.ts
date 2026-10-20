import ts from 'typescript';
import type { Plugin } from 'vite';

const TS_FILE_RE = /\.(ts|tsx|mts|cts)$/;
const NON_JS_RE = /\.(html|css|scss|sass|less|styl|json|svg|png|jpe?g|gif|webp|woff2?|ttf|ico|map|wasm)$/;

function isNodeModules(filePath: string): boolean {
  return filePath.includes('/node_modules/') || filePath.includes('\\node_modules\\');
}

/**
 * In-process TypeScript/TSX transform + compile-time env replacement.
 *
 * Why this exists: the reference build environment runs in a sandbox that
 * denies spawning child processes, so Vite's esbuild-based transform cannot
 * start. `typescript.transpileModule` and plain string replacement are pure JS.
 * Replacing `import.meta.env.*` and `process.env.NODE_ENV` here also avoids
 * Vite's `vite:define` plugin, which internally calls esbuild whenever those
 * tokens are present (including inside CJS dependencies such as React).
 */
export function typescriptTransformPlugin(): Plugin {
  let isBuild = true;
  let mode = 'production';
  let apiBase = '/api/v1';

  function replaceEnvTokens(code: string): string {
    if (!code.includes('import.meta.env') && !code.includes('process.env.NODE_ENV')) {
      return code;
    }
    const isProduction = mode === 'production' || isBuild;
    const metaEnv = {
      DEV: !isBuild,
      PROD: isBuild,
      MODE: mode,
      VITE_API_BASE: apiBase,
    };
    let output = code
      .replaceAll('import.meta.env.VITE_API_BASE', JSON.stringify(metaEnv.VITE_API_BASE))
      .replaceAll('import.meta.env.DEV', String(metaEnv.DEV))
      .replaceAll('import.meta.env.PROD', String(metaEnv.PROD))
      .replaceAll('import.meta.env.MODE', JSON.stringify(metaEnv.MODE))
      .replaceAll(
        'process.env.NODE_ENV',
        JSON.stringify(isProduction ? 'production' : 'development'),
      );
    if (output.includes('import.meta.env')) {
      output =
        `const __SAMAN_META_ENV__ = ${JSON.stringify(metaEnv)};\n` +
        output.replaceAll('import.meta.env', '__SAMAN_META_ENV__');
    }
    return output;
  }

  return {
    name: 'saman:typescript-transform',
    enforce: 'pre',
    configResolved(config) {
      isBuild = config.command === 'build';
      mode = config.mode;
      apiBase = process.env['VITE_API_BASE'] ?? '/api/v1';
    },
    transform(code, id) {
      const [filePath] = id.split('?');
      if (filePath === undefined || NON_JS_RE.test(filePath)) {
        return null;
      }

      let output = replaceEnvTokens(code);

      const shouldTranspile = TS_FILE_RE.test(filePath) && !isNodeModules(filePath);
      if (shouldTranspile) {
        const result = ts.transpileModule(output, {
          fileName: filePath,
          reportDiagnostics: false,
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
            jsx: ts.JsxEmit.ReactJSX,
            esModuleInterop: true,
            allowSyntheticDefaultImports: true,
            isolatedModules: true,
            sourceMap: false,
            removeComments: false,
            importHelpers: false,
          },
        });
        output = result.outputText;
      }

      return output === code ? null : { code: output, map: null };
    },
  };
}
