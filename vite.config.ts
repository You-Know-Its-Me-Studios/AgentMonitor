import { defineConfig } from 'vite';
import { typescriptTransform } from './build/typescript-transform.ts';
export default defineConfig({ plugins: [typescriptTransform()], esbuild: false, resolve: { preserveSymlinks: true }, build: { outDir: 'dist/client', minify: false, cssMinify: false }, server: { proxy: { '/api': 'http://127.0.0.1:4317' } } });
