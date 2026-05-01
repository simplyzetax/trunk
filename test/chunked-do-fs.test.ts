import { env, exports } from 'cloudflare:workers';
import { abortAllDurableObjects, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { ChunkedDurableObjectFS } from '../src/chunked-do-fs';
import { Trunk } from '../src/index';

const chunkKeys = (state: DurableObjectState) => [...state.storage.kv.list({ prefix: 'pglite-fs:chunk:' })].map(([key]) => key).sort();

const runWithFs = async (name: string, callback: (fs: ChunkedDurableObjectFS, state: DurableObjectState) => void | Promise<void>) => {
	const id = env.TRUNK.idFromName(name);
	const stub = env.TRUNK.get(id);

	await runInDurableObject(stub, async (instance: Trunk, state) => {
		expect(instance).toBeInstanceOf(Trunk);
		const fs = new ChunkedDurableObjectFS(state.storage, { chunkSize: 4 });
		await callback(fs, state);
	});
};

describe('ChunkedDurableObjectFS in Durable Object storage', () => {
	it('runs PGlite queries through the Durable Object route', async () => {
		const response = await exports.default.fetch('https://example.com/query');
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ rows: [{ ok: 1 }] });
	});

	it('persists PGlite data across Durable Object restarts', async () => {
		const objectName = crypto.randomUUID();
		const stub = env.TRUNK.getByName(objectName);

		await stub.query('create table items (name text primary key)');
		await stub.query("insert into items values ('persisted')");

		await abortAllDurableObjects();

		const restartedStub = env.TRUNK.getByName(objectName);
		const result = (await restartedStub.query('select name from items')) as { rows: { name: string }[] };
		expect(result.rows).toEqual([{ name: 'persisted' }]);
	});

	it('persists files as chunks and reloads them from the same object storage', async () => {
		const objectName = crypto.randomUUID();

		await runWithFs(objectName, async (fs, state) => {
			fs.mkdir('/base');
			fs.writeFile('/base/file', new Uint8Array([1, 2, 3, 4, 5, 6, 7]));
			await fs.syncToFs();

			expect(chunkKeys(state)).toHaveLength(2);
		});

		await runWithFs(objectName, (fs) => {
			const fd = fs.open('/base/file');
			const buffer = new Uint8Array(7);

			expect(fs.read(fd, buffer, 0, buffer.length, 0)).toBe(7);
			expect([...buffer]).toEqual([1, 2, 3, 4, 5, 6, 7]);
			expect(fs.lstat('/base/file').size).toBe(7);
		});
	});

	it('reads into non-Uint8Array views backed by the original buffer', async () => {
		await runWithFs(crypto.randomUUID(), (fs) => {
			fs.writeFile('/file', new Uint8Array([1, 2, 3]));
			const fd = fs.open('/file');
			const heap = new Int8Array(8);

			expect(fs.read(fd, heap as unknown as Uint8Array, 2, 3, 0)).toBe(3);
			expect([...new Uint8Array(heap.buffer).slice(2, 5)]).toEqual([1, 2, 3]);
		});
	});

	it('truncates persisted files and removes discarded chunks', async () => {
		const objectName = crypto.randomUUID();

		await runWithFs(objectName, async (fs, state) => {
			fs.writeFile('/file', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
			await fs.syncToFs();
			expect(chunkKeys(state)).toHaveLength(3);

			fs.truncate('/file', 5);
			await fs.syncToFs();
			expect(chunkKeys(state)).toHaveLength(2);
		});

		await runWithFs(objectName, (fs) => {
			const fd = fs.open('/file');
			const buffer = new Uint8Array(9);

			expect(fs.read(fd, buffer, 0, buffer.length, 0)).toBe(5);
			expect([...buffer.slice(0, 5)]).toEqual([1, 2, 3, 4, 5]);
			expect(fs.lstat('/file').size).toBe(5);
		});
	});

	it('persists rename and unlink metadata changes', async () => {
		const objectName = crypto.randomUUID();

		await runWithFs(objectName, async (fs) => {
			fs.writeFile('/file', new Uint8Array([1, 2, 3, 4, 5]));
			await fs.syncToFs();

			fs.rename('/file', '/renamed');
			await fs.syncToFs();
		});

		await runWithFs(objectName, async (fs, state) => {
			expect(fs.lstat('/renamed').size).toBe(5);
			expect(() => fs.lstat('/file')).toThrow('No such file or directory');

			fs.unlink('/renamed');
			await fs.syncToFs();
			expect(chunkKeys(state)).toHaveLength(0);
		});

		await runWithFs(objectName, (fs) => {
			expect(() => fs.lstat('/renamed')).toThrow('No such file or directory');
		});
	});
});
