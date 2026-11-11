import { DurableObject } from 'cloudflare:workers';
import { PGlite, type Results } from '@electric-sql/pglite';

import { ChunkedDurableObjectFS } from './chunked-do-fs';
import { forcePgliteWorkerRuntime, pgliteArtifacts, pglitePrepopulatedDataDir } from './pglite-artifacts';
import {
	closeStatement,
	commandComplete,
	concat,
	cstring,
	errorResponse,
	message,
	namespaceMessage,
	readyForQuery,
	readyStatus,
	simpleQuery,
	splitMessages,
	SYNC,
} from './wire';

export const PGLITE_FS_PREFIX = 'pglite-fs:';
// Keep Postgres shared buffers well below the Workers 128MB isolate limit.
const PGLITE_START_PARAMS = [...PGlite.defaultStartParams, '-c', 'shared_buffers=4MB'];
// Filesystem chunks are 64 KiB, so a fork moves about 4 MiB per RPC call.
const FORK_PAGE_SIZE = 64;
// How long an HTTP/MCP query waits for a wire-protocol client to finish its open transaction.
const QUERY_WAIT_MS = 15_000;
const ROLLBACK = simpleQuery('rollback');
const FLUSH = message('H');
// CopyInResponse: text format, column count 0 (clients don't need it for text COPY).
const COPY_IN_RESPONSE = message('G', new Uint8Array(3));
const COMMENTS = /\/\*[\s\S]*?\*\/|--[^\n]*/g;
const stripComments = (sql: string) => sql.replace(COMMENTS, ' ');
export const copiesFromStdin = (sql: string) => /(?:^|;)\s*copy\s[^;]*\bfrom\s+stdin\b/i.test(stripComments(sql));
/** DISCARD ALL / DEALLOCATE ALL anywhere in `sql`; in the shared session they would hit every client. */
export const resetsSession = (sql: string) => /\b(?:discard\s+all|deallocate\s+(?:prepare\s+)?all)\b/i.test(stripComments(sql));
// ponytail: COPY rows are buffered in memory; stream them in slices if bigger imports are needed.
const MAX_COPY_BYTES = 16 * 1024 * 1024;
const RESET_ALL = /^\s*(deallocate\s+(?:prepare\s+)?all|discard\s+all)\s*;?\s*$/i;
const DEALLOCATE = /^\s*deallocate\s+(?:prepare\s+)?(?:"((?:[^"]|"")+)"|([a-z_][\w$]*))\s*;?\s*$/i;
const RESTART_REASON = 'Postgres exited after a fatal error; trunk restarted the database. Committed data is safe, reconnect and retry.';

// Client messages after which the server answers with ReadyForQuery: startup (0), Query, Sync, CopyDone, CopyFail.
const ENDS_WITH_READY = new Set([0, 0x51, 0x53, 0x63, 0x66]);
// Extended-protocol messages (Parse, Bind, Execute, Describe, Close) open a cycle that only Sync closes.
const OPENS_CYCLE = new Set([0x50, 0x42, 0x45, 0x44, 0x43]);

/** PGlite results minus the COPY blob, which can't cross RPC. */
export type QueryResult<T = Record<string, unknown>> = Pick<Results<T>, 'rows' | 'fields' | 'affectedRows'>;
const plain = <T>({ rows, fields, affectedRows }: Results<T>): QueryResult<T> => ({ rows, fields, affectedRows });

/** Bind (portal name, then statement name) or Describe of a statement, naming the unnamed statement. */
const usesUnnamedStatement = (msg: Uint8Array) =>
	(msg[0] === 0x42 && cstring(msg, msg.indexOf(0, 5) + 1) === '') || (msg[0] === 0x44 && msg[5] === 0x53 && cstring(msg, 6) === '');

/** A FATAL Postgres error ends the WASM program; that PGlite instance can't be used again. */
const exited = (error: unknown) => (error as { name?: string } | null)?.name === 'ExitStatus' || error instanceof WebAssembly.RuntimeError;

type Session = {
	id: number;
	ws: WebSocket;
	/** Prefix for this connection's prepared statement and portal names. */
	prefix: string;
	buf: Uint8Array;
	started: boolean;
	statements: Set<string>;
	/** Transaction status from the last ReadyForQuery: 'I' idle, 'T' in a transaction, 'E' failed. */
	status: string;
	/** Extended-protocol messages were sent and no Sync has answered them yet. */
	cycleOpen: boolean;
	/** This client's last Parse of the unnamed statement, replayed if another client replaced it since. */
	unnamed: Uint8Array | null;
	/** Messages of a COPY FROM STDIN in progress, starting with its Query. */
	copy: Uint8Array[] | null;
	copyBytes: number;
};
type Job = { session: Session | null; run: () => Promise<void>; cancel?: (error: Error) => void };

/**
 * One Postgres database. PGlite runs a single Postgres session, so every client of this database
 * shares it: jobs run one at a time, and a client inside a transaction, an extended-protocol cycle
 * or a COPY keeps the session until it is idle again.
 */
export class PgliteDatabase extends DurableObject<Env> {
	private db?: Promise<PGlite>;
	#sessions = new Set<Session>();
	#nextSessionId = 1;
	#jobs: Job[] = [];
	#owner: Session | null = null;
	#pumping = false;
	/** Whose Parse the shared unnamed statement holds; null after anything else may have replaced it. */
	#unnamedOwner: Session | null = null;

	/** Runs one statement, with optional `$1` params. */
	async query<T = Record<string, unknown>>(sql = 'select 1 as ok', params?: unknown[]): Promise<QueryResult<T>> {
		return this.#schedule(async (db) => plain(await db.query<T>(sql, params)));
	}

	/** Runs one or more statements separated by semicolons. */
	async exec(sql: string): Promise<QueryResult[]> {
		return this.#schedule(async (db) => (await db.exec(sql)).map(plain));
	}

	/** Copies this database's files into the database object `targetId`, which nobody uses yet. */
	async forkTo(targetId: string): Promise<void> {
		await this.#schedule(async (db) => {
			await db.syncToFs();
			const target = this.env.PGLITE_DATABASE.get(this.env.PGLITE_DATABASE.idFromString(targetId));
			await target.resetStorage();
			let startAfter: string | undefined;
			for (;;) {
				const page = [...this.ctx.storage.kv.list({ prefix: PGLITE_FS_PREFIX, startAfter, limit: FORK_PAGE_SIZE })];
				if (!page.length) return;
				await target.importEntries(page);
				startAfter = page[page.length - 1][0];
			}
		});
	}

	async resetStorage(): Promise<void> {
		this.#closeAll('database replaced');
		this.db = undefined;
		await this.ctx.storage.deleteAll();
	}

	async importEntries(entries: [string, unknown][]): Promise<void> {
		this.ctx.storage.transactionSync(() => {
			for (const [key, value] of entries) this.ctx.storage.kv.put(key, value);
		});
	}

	/** Point-in-time recovery bookmark for now, or for `at` (ms since epoch, within 30 days). */
	async bookmark(at?: number): Promise<string> {
		return at === undefined ? this.ctx.storage.getCurrentBookmark() : this.ctx.storage.getBookmarkForTime(at);
	}

	/** Arms a restore to `bookmark` for the next restart; returns a bookmark that undoes it. */
	async armRestore(bookmark: string): Promise<string> {
		return this.ctx.storage.onNextSessionRestoreBookmark(bookmark);
	}

	/** Resets the object so an armed restore applies. The caller's promise always rejects. */
	async restart(reason: string): Promise<void> {
		this.#closeAll(reason);
		this.ctx.abort(reason);
	}

	/** Wipes all data and resets the object. The caller's promise always rejects. */
	async destroy(): Promise<void> {
		this.#closeAll('database deleted');
		this.db = undefined;
		await this.ctx.storage.deleteAll();
		this.ctx.abort('database deleted');
	}

	/** Drops every client connection; open transactions are rolled back. */
	async disconnect(reason: string): Promise<void> {
		for (const session of [...this.#sessions]) this.#fail(session, reason);
	}

	/** Postgres wire protocol over a WebSocket: one socket per client connection. */
	async fetch(request: Request): Promise<Response> {
		if (request.headers.get('upgrade') !== 'websocket') {
			return new Response('Expected a WebSocket upgrade', { status: 426 });
		}

		const { 0: client, 1: ws } = new WebSocketPair();
		// Plain accept(), not hibernation: hibernating would drop the PGlite session under an open connection.
		ws.accept();
		ws.binaryType = 'arraybuffer'; // the default at this compatibility date is Blob
		const id = this.#nextSessionId++;
		const session: Session = {
			id,
			ws,
			prefix: `${id.toString(36)}_`,
			buf: new Uint8Array(0),
			started: false,
			statements: new Set(),
			status: 'I',
			cycleOpen: false,
			unnamed: null,
			copy: null,
			copyBytes: 0,
		};
		this.#sessions.add(session);
		ws.addEventListener('message', (event) => this.#onData(session, event.data));
		ws.addEventListener('close', () => this.#endSession(session));
		ws.addEventListener('error', () => this.#endSession(session));
		return new Response(null, { status: 101, webSocket: client });
	}

	#onData(session: Session, data: string | ArrayBuffer) {
		if (!this.#sessions.has(session)) return;
		if (typeof data === 'string') return this.#fail(session, 'trunk expects binary Postgres protocol frames');

		const startup = !session.started;
		let messages: Uint8Array[];
		try {
			({ messages, rest: session.buf } = splitMessages(concat(session.buf, new Uint8Array(data)), startup));
		} catch (error) {
			return this.#fail(session, error instanceof Error ? error.message : 'invalid message');
		}
		if (!messages.length) return;
		session.started = true;
		this.#push({ session, run: () => this.#execMessages(session, messages, startup) });
	}

	async #execMessages(session: Session, messages: Uint8Array[], startup: boolean): Promise<void> {
		let db: PGlite;
		try {
			db = await this.getDb();
		} catch (error) {
			console.error('PGlite failed to start', error);
			return this.#fail(session, 'trunk could not start the database');
		}

		let tail: Uint8Array = new Uint8Array(0);
		const send = (data: Uint8Array) => {
			if (!data.length) return;
			tail = data.length >= 6 ? data.subarray(-6) : concat(tail, data).subarray(-6);
			try {
				session.ws.send(data);
			} catch {
				// Client went away; its close event queues the cleanup.
			}
		};
		const run = (bytes: Uint8Array) => db.runExclusive(() => db.execProtocolRawStream(bytes, { onRawData: send }));

		let batch: Uint8Array[] = [];
		let lastType = -1;
		// Runs the queued messages and records the transaction status the server reports.
		const flush = async () => {
			if (!batch.length) return;
			const bytes = concat(...batch);
			batch = [];
			await run(bytes);
			if (ENDS_WITH_READY.has(lastType)) session.status = readyStatus(tail) ?? session.status;
		};

		try {
			for (const [index, msg] of messages.entries()) {
				const type = startup && index === 0 ? 0 : msg[0];

				if (session.copy) {
					session.copy.push(msg);
					session.copyBytes += msg.length;
					if (session.copyBytes > MAX_COPY_BYTES) {
						return this.#fail(session, `COPY data over ${MAX_COPY_BYTES >> 20} MB; split the import into smaller files`);
					}
					if (type === 0x63 || type === 0x66) {
						// CopyDone / CopyFail: PGlite needs the rows in the same call as the COPY, so run it all now.
						const copy = concat(...session.copy);
						session.copy = null;
						await this.#runCopy(db, copy, send);
						session.status = readyStatus(tail) ?? session.status;
					}
					continue;
				}

				if (type === 0x58) {
					// Terminate
					await flush();
					session.ws.close(1000, 'terminated');
					return this.#endSession(session);
				}

				if (type === 0x51) {
					this.#unnamedOwner = null; // a simple query destroys the unnamed statement
					const sql = cstring(msg, 5);
					if (copiesFromStdin(sql)) {
						// The client waits for CopyInResponse before sending rows, so answer it ourselves.
						await flush();
						session.copy = [msg];
						session.copyBytes = msg.length;
						send(COPY_IN_RESPONSE);
						continue;
					}
					const reset = stripComments(sql).match(RESET_ALL);
					if (reset) {
						// Would wipe every client's statements in the shared session; only drop this client's.
						await flush();
						await this.#closeStatements(db, session);
						send(concat(commandComplete(/^discard/i.test(reset[1]) ? 'DISCARD ALL' : 'DEALLOCATE ALL'), readyForQuery(session.status)));
						lastType = type;
						continue;
					}
					batch.push(this.#namespaceDeallocate(session, sql) ?? msg);
					lastType = type;
					continue;
				}

				if (OPENS_CYCLE.has(type)) session.cycleOpen = true;
				if (type === 0x53) session.cycleOpen = false;
				if (type === 0x50 && !cstring(msg, 5)) {
					session.unnamed = msg;
					this.#unnamedOwner = session;
				} else if (session.unnamed && this.#unnamedOwner !== session && usesUnnamedStatement(msg)) {
					await flush();
					await this.#replayUnnamed(db, session, send);
				}
				const namespaced = type === 0 ? msg : namespaceMessage(msg, session.prefix);
				this.#trackStatement(session, namespaced);
				batch.push(namespaced);
				lastType = type;
				// PGlite answers the startup packet on its own call; it ignores the user and database names.
				if (type === 0) await flush();
			}
			await flush();
		} catch (error) {
			this.#restartIfExited(error);
			console.error('PGlite failed on a client message', error);
			this.#fail(session, 'internal error in trunk');
		}
	}

	/** Runs a buffered COPY and drops PGlite's CopyInResponse, which the client already got from us. */
	async #runCopy(db: PGlite, copy: Uint8Array, send: (data: Uint8Array) => void) {
		const out: Uint8Array[] = [];
		await db.runExclusive(() => db.execProtocolRawStream(copy, { onRawData: (data) => out.push(data) }));
		const replies = splitMessages(concat(...out), false).messages;
		const own = replies.findIndex((reply) => reply[0] === 0x47);
		if (own >= 0) replies.splice(own, 1);
		send(concat(...replies));
	}

	/**
	 * The unnamed statement is shared by all clients, and drivers like Go's lib/pq parse it in one round
	 * trip and bind it in the next. If another client replaced it in between, parse this client's again.
	 */
	async #replayUnnamed(db: PGlite, session: Session, send: (data: Uint8Array) => void) {
		const out: Uint8Array[] = [];
		await db.runExclusive(() => db.execProtocolRawStream(concat(session.unnamed!, FLUSH), { onRawData: (data) => out.push(data) }));
		const reply = concat(...out);
		// A lone ParseComplete is ours to swallow; an error (say the table is gone) belongs to the client.
		if (reply.length === 5 && reply[0] === 0x31) this.#unnamedOwner = session;
		else send(reply);
	}

	/** SQL `DEALLOCATE name` for a statement this client prepared over the protocol must use the namespaced name. */
	#namespaceDeallocate(session: Session, sql: string): Uint8Array | null {
		const match = sql.match(DEALLOCATE);
		if (!match) return null;
		const name = session.prefix + (match[1]?.replaceAll('""', '"') ?? match[2].toLowerCase());
		if (!session.statements.delete(name)) return null;
		return simpleQuery(`deallocate "${name.replaceAll('"', '""')}"`);
	}

	#trackStatement(session: Session, msg: Uint8Array) {
		if (msg[0] === 0x50) {
			const name = cstring(msg, 5);
			if (name) session.statements.add(name);
		} else if (msg[0] === 0x43 && msg[5] === 0x53) {
			session.statements.delete(cstring(msg, 6));
		}
	}

	/** Protocol Close rather than SQL DEALLOCATE: closing a missing statement is not an error. */
	async #closeStatements(db: PGlite, session: Session) {
		if (!session.statements.size) return;
		const closes = [...session.statements].map(closeStatement);
		session.statements.clear();
		await this.#quiet(db, concat(...closes, SYNC));
	}

	#quiet(db: PGlite, bytes: Uint8Array) {
		return db.runExclusive(() => db.execProtocolRawStream(bytes, { onRawData: () => {} }));
	}

	/** Whether this client must keep the shared session: mid-transaction, mid-cycle or mid-COPY. */
	#holds(session: Session) {
		return session.copy !== null || session.cycleOpen || session.status !== 'I';
	}

	#fail(session: Session, text: string) {
		try {
			session.ws.send(errorResponse(text));
			session.ws.close(1011, text.slice(0, 120));
		} catch {
			// already closed
		}
		this.#endSession(session, true);
	}

	/** Like Postgres, runs what a client sent before it hung up, unless trunk is the one dropping it. */
	#endSession(session: Session, dropQueued = false) {
		if (!this.#sessions.delete(session)) return;
		if (dropQueued) this.#jobs = this.#jobs.filter((job) => job.session !== session);
		// Always queue cleanup: a job still running for this session may leave it holding the session.
		this.#push({
			session,
			run: async () => {
				if (!this.#holds(session) && !session.statements.size) return;
				try {
					const db = await this.getDb();
					if (this.#holds(session)) {
						this.#unnamedOwner = null;
						// Abort like Postgres does on disconnect. Sync alone would commit a half-sent batch.
						await this.#quiet(db, ROLLBACK); // ends an implicit or explicit transaction (ignored after an error...)
						await this.#quiet(db, SYNC); // ...until this Sync, which aborts the failed implicit one
						if (db.isInTransaction()) await this.#quiet(db, ROLLBACK); // failed explicit transaction
					}
					await this.#closeStatements(db, session);
				} catch (error) {
					this.#restartIfExited(error);
					console.warn('session cleanup failed', error);
				}
				session.status = 'I';
				session.cycleOpen = false;
				session.copy = null;
			},
		});
	}

	/** After PGlite exits, reset the object so the next request starts a fresh instance from storage. */
	#restartIfExited(error: unknown) {
		if (!exited(error)) return;
		console.error('PGlite exited; restarting the database object', error);
		this.#closeAll(RESTART_REASON);
		this.ctx.abort(RESTART_REASON);
	}

	#closeAll(reason: string) {
		for (const session of this.#sessions) {
			try {
				session.ws.send(errorResponse(reason, '57P01'));
				session.ws.close(1012, reason.slice(0, 120));
			} catch {
				// already closed
			}
		}
		for (const job of this.#jobs) job.cancel?.(new Error(reason));
		this.#sessions.clear();
		this.#jobs = [];
		this.#owner = null;
	}

	/** Runs `fn` between client transactions. It must not leave a transaction open. */
	#schedule<T>(fn: (db: PGlite) => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const job: Job = {
				session: null,
				cancel: (error) => {
					clearTimeout(timer);
					reject(error);
				},
				run: async () => {
					clearTimeout(timer);
					this.#unnamedOwner = null; // PGlite's query() and exec() replace or destroy the unnamed statement
					try {
						const db = await this.getDb();
						let result: T | undefined;
						let error: unknown;
						let failed = false;
						try {
							result = await fn(db);
						} catch (caught) {
							if (exited(caught)) reject(new Error(RESTART_REASON));
							this.#restartIfExited(caught);
							[error, failed] = [caught, true];
						}
						if (db.isInTransaction()) {
							await db.exec('rollback');
							if (!failed) {
								[error, failed] = [new Error('Transaction left open, so it was rolled back. Send BEGIN and COMMIT in the same request.'), true];
							}
						}
						if (failed) reject(error);
						else resolve(result as T);
					} catch (caught) {
						reject(caught);
					}
				},
			};
			// ponytail: wire clients wait without a timeout; add one if a stuck client ever blocks others in practice.
			const timer = setTimeout(() => {
				const index = this.#jobs.indexOf(job);
				if (index < 0) return;
				this.#jobs.splice(index, 1);
				reject(new Error('Database busy: another connection has had a transaction open for over 15 seconds.'));
			}, QUERY_WAIT_MS);
			this.#push(job);
		});
	}

	#push(job: Job) {
		this.#jobs.push(job);
		void this.#pump();
	}

	async #pump() {
		if (this.#pumping) return;
		this.#pumping = true;
		try {
			for (;;) {
				const index = this.#owner ? this.#jobs.findIndex((job) => job.session === this.#owner) : this.#jobs.length ? 0 : -1;
				if (index < 0) return; // idle, or waiting for the owner's next message
				const [job] = this.#jobs.splice(index, 1);
				await job.run().catch((error) => console.error('trunk job failed', error));
				const session = job.session;
				// A closed session stays owner only until its queued cleanup runs; #closeAll leaves none.
				const live = session && (this.#sessions.has(session) || this.#jobs.some((queued) => queued.session === session));
				this.#owner = live && this.#holds(session) ? session : null;
			}
		} finally {
			this.#pumping = false;
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
