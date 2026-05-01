import { DurableObject } from 'cloudflare:workers';
import { PGlite } from '@electric-sql/pglite';
import { Hono } from 'hono';

import { ChunkedDurableObjectFS } from './chunked-do-fs';
import { forcePgliteWorkerRuntime, pgliteArtifacts } from './pglite-artifacts';

const app = new Hono<{ Bindings: Env }>();

export class Trunk extends DurableObject<Env> {
	private db?: Promise<PGlite>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	public async query(sql = 'select 1 as ok') {
		const db = await this.getDb();
		return db.query(sql);
	}

	private getDb(): Promise<PGlite> {
		forcePgliteWorkerRuntime();
		this.db ??= PGlite.create({
			...pgliteArtifacts,
			fs: new ChunkedDurableObjectFS(this.ctx.storage),
			initialMemory: 128 * 1024 * 1024,
		});

		return this.db;
	}
}

app.get('/query', async (c) => {
	const stub = c.env.TRUNK.getByName('foo');
	return c.json(await stub.query());
});

export default app;
