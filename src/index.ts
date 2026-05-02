import { DurableObject } from 'cloudflare:workers';
import { PGlite, type Results } from '@electric-sql/pglite';
import { Hono } from 'hono';

import { ChunkedDurableObjectFS } from './chunked-do-fs';
import { forcePgliteWorkerRuntime, pgliteArtifacts, pglitePrepopulatedDataDir } from './pglite-artifacts';

const app = new Hono<{ Bindings: Env }>();
const PGLITE_FS_PREFIX = 'pglite-fs:';

export class Trunk extends DurableObject<Env> {
	private db?: Promise<PGlite>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	public async query<T = Record<string, unknown>>(sql = 'select 1 as ok'): Promise<Results<T>> {
		const db = await this.getDb();
		return db.query<T>(sql);
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
				...(hasPersistedDb ? {} : { loadDataDir: pglitePrepopulatedDataDir }),
			}).catch((error) => {
				this.db = undefined;
				throw error;
			});
		}

		return this.db;
	}
}

app.get('/query', async (c) => {
	const stub = c.env.TRUNK.getByName('foo');
	return c.json(await stub.query());
});

export default app;
