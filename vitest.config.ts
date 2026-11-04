import { defineConfig } from 'vitest/config';
import { typescriptTransform } from './build/typescript-transform.ts';
export default defineConfig({ esbuild: false, resolve: { preserveSymlinks: true }, plugins: [typescriptTransform()], test: { pool: 'threads', minWorkers: 1, maxWorkers: 1, include: ['tests/**/*.test.ts'], testTimeout: 20000, fileParallelism: false } });
