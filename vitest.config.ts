import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';
// Next resolves `server-only` itself; route-handler specs load those modules under Node.
const require = createRequire(import.meta.url);
// tsconfig keeps jsx: preserve for Next; specs that import dashboard components need it compiled.
export default defineConfig({ oxc: { jsx: { runtime: 'automatic' } }, resolve: { alias: { 'server-only': require.resolve('next/dist/compiled/server-only/empty.js') } }, test: { include: ['tests/**/*.spec.ts'], environment: 'node' } });
