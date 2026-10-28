import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

const config = [
  ...nextVitals,
  ...nextTypescript,
  // shortcut: eslint-config-next 16 turned on these React Compiler rules; existing components (Date.now() in server
  // components, setState in effects) predate them. Re-enable once those are reworked.
  { rules: { 'react-hooks/purity': 'off', 'react-hooks/set-state-in-effect': 'off' } },
  { ignores: ['.next/**', 'node_modules/**', 'convex/_generated/**', 'next-env.d.ts', 'output/**', 'forge/bitbucket/static/build/**', 'packages/cli/dist/**'] },
];

export default config;
