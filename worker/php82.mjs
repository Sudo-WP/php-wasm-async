/**
 * php-wasm-async — PHP 8.2 per-version Worker entry (Session 14, ADR-0024).
 * Imports exactly one binary; deployed via `wrangler --env php82`.
 * Apache-2.0.
 */
import PHP from './build/php8.2-worker.mjs';
import phpWasm from './build/php8.2-worker.mjs.wasm';
import trampolineVP from './build/trampoline-vp.wasm';
import { createHandler } from './run-php.mjs';

export default createHandler({ factory: PHP, wasm: phpWasm, trampolineVP, version: '8.2' });
