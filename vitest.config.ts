import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';
// Next resolves `server-only` itself; route-handler specs load those modules under Node.
const require = createRequire(import.meta.url);
export default defineConfig({ resolve: { alias: { 'server-only': require.resolve('next/dist/compiled/server-only/empty.js') } }, test: { include: ['tests/**/*.spec.ts'], environment: 'node' } });
