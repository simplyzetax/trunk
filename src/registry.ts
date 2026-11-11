import { DurableObject } from 'cloudflare:workers';

/** `ready` is 0 while a fork is still copying data in. */
export type DatabaseInfo = { name: string; id: string; owner: string | null; forkedFrom: string | null; createdAt: number; ready: number };
export type CheckpointInfo = { label: string; bookmark: string; createdAt: number };

const DATABASE_COLUMNS = 'name, id, owner, forked_from as forkedFrom, created_at as createdAt, ready';

/**
 * Tracks databases, agent tokens and checkpoints. Checkpoints live here rather than in the database
 * object so restoring a database never erases the checkpoints taken after that point.
 */
// ponytail: one global registry object; shard by owner if it ever becomes a hot spot.
export class Registry extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(`
			create table if not exists databases (name text primary key, id text not null, owner text, forked_from text, created_at integer not null, ready integer not null default 1);
			create table if not exists tokens (hash text primary key, agent text not null, created_at integer not null);
			create table if not exists checkpoints (db text not null, label text not null, bookmark text not null, created_at integer not null, primary key (db, label));
		`);
	}

	agentForToken(hash: string): string | null {
		return this.#rows<{ agent: string }>('select agent from tokens where hash = ?', hash)[0]?.agent ?? null;
	}

	addToken(agent: string, hash: string): void {
		this.ctx.storage.sql.exec('insert into tokens (hash, agent, created_at) values (?, ?, ?)', hash, agent, Date.now());
	}

	revokeAgent(agent: string): number {
		return this.ctx.storage.sql.exec('delete from tokens where agent = ?', agent).rowsWritten;
	}

	agents(): { agent: string; tokens: number; databases: number }[] {
		return this.#rows(
			'select agent, count(*) as tokens, (select count(*) from databases where owner = tokens.agent) as databases from tokens group by agent order by agent',
		);
	}

	database(name: string): DatabaseInfo | null {
		return this.#rows<DatabaseInfo>(`select ${DATABASE_COLUMNS} from databases where name = ?`, name)[0] ?? null;
	}

	/** All databases, or only those owned by `owner`. */
	databases(owner?: string): DatabaseInfo[] {
		return owner === undefined
			? this.#rows(`select ${DATABASE_COLUMNS} from databases order by name`)
			: this.#rows(`select ${DATABASE_COLUMNS} from databases where owner = ? order by name`, owner);
	}

	/**
	 * Registers a new database backed by a fresh object. A fork stays not ready until `markReady`.
	 * `limit` caps how many databases `owner` may have; checking it here keeps check and insert atomic.
	 */
	createDatabase(name: string, owner: string | null, forkedFrom: string | null, limit?: number): DatabaseInfo | 'taken' | 'limit' {
		if (this.database(name)) return 'taken';
		if (owner && limit !== undefined && this.#rows<{ n: number }>('select count(*) as n from databases where owner = ?', owner)[0].n >= limit) return 'limit';
		this.#insert(name, owner, forkedFrom, forkedFrom ? 0 : 1);
		return this.database(name)!;
	}

	markReady(name: string): void {
		this.ctx.storage.sql.exec('update databases set ready = 1 where name = ?', name);
	}

	/** Admin access to any name: registers it on first use. */
	ensureDatabase(name: string): DatabaseInfo {
		if (!this.database(name)) this.#insert(name, null, null, 1);
		return this.database(name)!;
	}

	// Always a new object, so a deleted name never comes back with old data.
	#insert(name: string, owner: string | null, forkedFrom: string | null, ready: number) {
		this.ctx.storage.sql.exec(
			'insert into databases (name, id, owner, forked_from, created_at, ready) values (?, ?, ?, ?, ?, ?)',
			name,
			this.env.PGLITE_DATABASE.newUniqueId().toString(),
			owner,
			forkedFrom,
			Date.now(),
			ready,
		);
	}

	removeDatabase(name: string): void {
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec('delete from databases where name = ?', name);
			this.ctx.storage.sql.exec('delete from checkpoints where db = ?', name);
		});
	}

	/** Returns false if the label is already used for this database. */
	addCheckpoint(db: string, label: string, bookmark: string): boolean {
		return (
			this.ctx.storage.sql.exec(
				'insert or ignore into checkpoints (db, label, bookmark, created_at) values (?, ?, ?, ?)',
				db,
				label,
				bookmark,
				Date.now(),
			).rowsWritten > 0
		);
	}

	checkpoint(db: string, label: string): CheckpointInfo | null {
		return this.#rows<CheckpointInfo>('select label, bookmark, created_at as createdAt from checkpoints where db = ? and label = ?', db, label)[0] ?? null;
	}

	checkpoints(db: string): CheckpointInfo[] {
		return this.#rows('select label, bookmark, created_at as createdAt from checkpoints where db = ? order by created_at desc', db);
	}

	#rows<T>(query: string, ...bindings: SqlStorageValue[]): T[] {
		return this.ctx.storage.sql.exec(query, ...bindings).toArray() as T[];
	}
}
