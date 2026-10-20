import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

const ENTRY_SCRIPT_RE = /\s*<script type="module" src="\/src\/main\.tsx"><\/script>/;
/**
 * Build-only HTML emitter for the SPA.
 *
 * Vite's built-in HTML plugin transpiles inline module scripts with esbuild,
 * which cannot spawn in the reference sandbox. The build therefore uses
 * `src/main.tsx` as the Rollup entry and this plugin emits `dist/index.html`
 * from the `index.html` template, wiring the hashed entry chunk and CSS assets.
 * The dev server remains the standard Vite HTML pipeline.
 */
export function staticSpaHtmlPlugin(): Plugin {
  let rootDir = process.cwd();

  return {
    name: 'saman:static-spa-html',
    apply: 'build',
    configResolved(config) {
      rootDir = config.root;
    },
    config() {
      // `@vitejs/plugin-react` re-enables esbuild in its own config hook; this
      // plugin is ordered after it and forces the in-process TypeScript
      // transform to be the only source transform.
      return { esbuild: false };
    },
    generateBundle(_options, bundle) {
      const template = readFileSync(resolve(rootDir, 'index.html'), 'utf8');
      const cssFiles: string[] = [];
      let entryFile = 'assets/main.js';

      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type === 'chunk' && output.isEntry) {
          entryFile = fileName;
        } else if (output.type === 'asset' && fileName.endsWith('.css')) {
          cssFiles.push(fileName);
        }
      }

      const styles = cssFiles
        .map((file) => `    <link rel="stylesheet" href="/${file}" />`)
        .join('\n');
      const html = template
        .replace(ENTRY_SCRIPT_RE, '')
        .replace('</head>', `${styles === '' ? '' : `${styles}\n`}  </head>`)
        .replace(
          '</body>',
          `    <script type="module" src="/${entryFile}"></script>\n  </body>`,
        );

      this.emitFile({ type: 'asset', fileName: 'index.html', source: html });
    },
  };
}
