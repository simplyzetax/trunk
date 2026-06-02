import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const pgliteWasm = 'src/vendor/pglite/pglite.wasm';
const wrappersPath = 'src/wasm-function-wrappers.ts';
const missing = [];

if (!existsSync(pgliteWasm)) {
	missing.push(pgliteWasm);
}

if (!existsSync(wrappersPath)) {
	missing.push(wrappersPath);
} else {
	const wrappers = readFileSync(wrappersPath, 'utf8');
	const wasmImportPattern = /['"]\.\/wasm-function\/([^'"]+\.wasm)['"]/g;

	for (const match of wrappers.matchAll(wasmImportPattern)) {
		const artifact = join('src/wasm-function', match[1]);
		if (!existsSync(artifact)) {
			missing.push(artifact);
		}
	}
}

if (missing.length > 0) {
	console.error('Missing generated artifacts:');
	for (const artifact of missing) {
		console.error(`- ${artifact}`);
	}
	console.error('Run: bun run setup');
	process.exit(1);
}

const result = spawnSync('bun', ['scripts/verify-pglite-memory.mjs', pgliteWasm, '64'], {
	stdio: 'inherit',
});

process.exit(result.status ?? 1);
