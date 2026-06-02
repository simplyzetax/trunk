import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/artifacts.test.ts'],
		environment: 'node',
	},
});
