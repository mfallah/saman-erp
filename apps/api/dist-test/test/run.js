"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Spawn-free test runner (same approach as `@saman/shared`).
 *
 * `npm test` compiles `src` + `test` with `tsc` and runs every compiled `*.spec`
 * file in-process with Node's built-in test runner and Jest's standalone
 * `expect`. `vitest.config.ts` remains for normal CI environments
 * (`pnpm test:vitest`), where esbuild/worker spawning is available.
 */
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const testDirectory = __dirname;
async function main() {
    const specs = (0, node_fs_1.readdirSync)(testDirectory)
        .filter((file) => file.endsWith('.spec.js'))
        .sort();
    for (const spec of specs) {
        await Promise.resolve(`${(0, node_path_1.join)(testDirectory, spec)}`).then(s => __importStar(require(s)));
    }
}
void main();
