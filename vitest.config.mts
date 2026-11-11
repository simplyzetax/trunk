import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc' },
			miniflare: { bindings: { TRUNK_ADMIN_TOKEN: 'test-admin-token' } },
		}),
	],
	test: {
		include: ['test/**/*.test.ts'],
		exclude: ['test/artifacts.test.ts'],
		testTimeout: 60_000,
	},
});
