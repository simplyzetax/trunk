import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const runBun = (args: string[], cwd: string) =>
	new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
		const child = spawn('bun', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk) => (stdout += String(chunk)));
		child.stderr.on('data', (chunk) => (stderr += String(chunk)));
		child.on('close', (code) => resolve({ code, stdout, stderr }));
	});

describe('artifact checks', () => {
	it('fails with setup instructions when the wrapper manifest is missing', async () => {
		const root = await mkdtemp(join(tmpdir(), 'pglite-template-'));
		await mkdir(join(root, 'scripts'), { recursive: true });
		await mkdir(join(root, 'src'), { recursive: true });
		await writeFile(join(root, 'scripts', 'check-artifacts.mjs'), await readFile('scripts/check-artifacts.mjs', 'utf8'));

		const result = await runBun(['scripts/check-artifacts.mjs'], root);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('Missing generated artifacts');
		expect(result.stderr).toContain('src/wasm-function-wrappers.ts');
		expect(result.stderr).toContain('bun run setup');
	});

	it('fails with setup instructions when generated artifacts are missing', async () => {
		const root = await mkdtemp(join(tmpdir(), 'pglite-template-'));
		await mkdir(join(root, 'scripts'), { recursive: true });
		await mkdir(join(root, 'src'), { recursive: true });
		await writeFile(join(root, 'scripts', 'check-artifacts.mjs'), await readFile('scripts/check-artifacts.mjs', 'utf8'));
		await writeFile(join(root, 'src', 'wasm-function-wrappers.ts'), "import wrapper_i from './wasm-function/sig-i.wasm';\n");

		const result = await runBun(['scripts/check-artifacts.mjs'], root);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('Missing generated artifacts');
		expect(result.stderr).toContain('src/vendor/pglite/pglite.wasm');
		expect(result.stderr).toContain('src/wasm-function/sig-i.wasm');
		expect(result.stderr).toContain('bun run setup');
	});

	it('verifies wasm memory imports when run with Bun', async () => {
		const root = await mkdtemp(join(tmpdir(), 'pglite-template-'));
		await mkdir(join(root, 'scripts'), { recursive: true });
		await writeFile(join(root, 'scripts', 'verify-pglite-memory.mjs'), await readFile('scripts/verify-pglite-memory.mjs', 'utf8'));
		await writeFile(
			join(root, 'pglite.wasm'),
			Uint8Array.from([
				0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x02, 0x12, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x06,
				0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x01, 0x02, 0x80, 0x80, 0x02,
			]),
		);

		const result = await runBun(['scripts/verify-pglite-memory.mjs', 'pglite.wasm', '64'], root);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain('PGlite WASM minimum memory: 2 pages');
	});
});
