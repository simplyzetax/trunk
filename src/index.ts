import { DurableObject } from 'cloudflare:workers';
import { PGlite, type Results } from '@electric-sql/pglite';
import { Hono } from 'hono';

import { ChunkedDurableObjectFS } from './chunked-do-fs';
import { forcePgliteWorkerRuntime, pgliteArtifacts, pglitePrepopulatedDataDir } from './pglite-artifacts';

const app = new Hono<{ Bindings: Env }>();
const PGLITE_FS_PREFIX = 'pglite-fs:';
// Keep Postgres shared buffers well below the Workers 128MB isolate limit.
const PGLITE_START_PARAMS = [...PGlite.defaultStartParams, '-c', 'shared_buffers=4MB'];

export class PgliteDatabase extends DurableObject<Env> {
	private db?: Promise<PGlite>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	public async query<T = Record<string, unknown>>(sql = 'select 1 as ok', params?: unknown[]): Promise<Results<T>> {
		const db = await this.getDb();
		return db.query<T>(sql, params);
	}

	public async queryForHttp<T = Record<string, unknown>>(
		sql: string,
		params?: unknown[],
	): Promise<{ ok: true; result: Results<T> } | { ok: false; error: string }> {
		try {
			return { ok: true, result: await this.query<T>(sql, params) };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : 'Query failed' };
		}
	}

	private getDb(): Promise<PGlite> {
		if (!this.db) {
			forcePgliteWorkerRuntime();
			const fs = new ChunkedDurableObjectFS(this.ctx.storage, { prefix: PGLITE_FS_PREFIX });
			let hasPersistedDb = false;
			try {
				fs.lstat('/PG_VERSION');
				hasPersistedDb = true;
			} catch {
				hasPersistedDb = false;
			}

			this.db = PGlite.create({
				...pgliteArtifacts,
				fs,
				initialMemory: 64 * 1024 * 1024,
				startParams: PGLITE_START_PARAMS,
				...(hasPersistedDb ? {} : { loadDataDir: pglitePrepopulatedDataDir }),
			}).catch((error) => {
				this.db = undefined;
				throw error;
			});
		}

		return this.db;
	}
}

app.get('/health', (c) => c.json({ ok: true }));

app.get('/query/:id', async (c) => {
	const stub = c.env.PGLITE_DATABASE.getByName(c.req.param('id'));
	return c.json(await stub.query());
});

app.post('/query/:id', async (c) => {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		return c.json({ error: 'Expected JSON object body' }, 400);
	}

	const { sql, params } = body as { sql?: unknown; params?: unknown };

	if (typeof sql !== 'string') {
		return c.json({ error: 'Expected JSON body with string field: sql' }, 400);
	}

	if (params !== undefined && !Array.isArray(params)) {
		return c.json({ error: 'Expected params to be an array when provided' }, 400);
	}

	const stub = c.env.PGLITE_DATABASE.getByName(c.req.param('id'));
	const result = (await stub.queryForHttp(sql, params)) as Awaited<ReturnType<PgliteDatabase['queryForHttp']>>;
	if (result.ok) {
		return c.json(result.result);
	}

	return c.json({ error: result.error }, 400);
});

export default app;
