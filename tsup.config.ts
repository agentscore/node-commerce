import { readFileSync } from 'fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/core.ts',
    'src/identity/express.ts',
    'src/identity/hono.ts',
    'src/identity/web.ts',
    'src/identity/nextjs.ts',
    'src/identity/fastify.ts',
    'src/payment/index.ts',
    'src/discovery/index.ts',
    'src/challenge/index.ts',
    'src/stripe-multichain/index.ts',
    'src/api/index.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  define: { __VERSION__: JSON.stringify(version) },
});
