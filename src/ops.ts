// Everything a caller can do, shared by the HTTP API (CLI) and the MCP server.
// Access rules live here: the admin (you) can reach every database; an agent only its own.
import { copiesFromStdin, resetsSession, type QueryResult } from './database';

import type { DatabaseInfo } from './registry';

/** `agent: null` is the admin, authenticated with TRUNK_ADMIN_TOKEN. */
export type Principal = { agent: string | null };

export class HttpError extends Error {
	constructor(
		readonly status: 400 | 401 | 403 | 404 | 409 | 501,
		message: string,
	) {
		super(message);
	}
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const LABEL = /^[\w.:-]{1,80}$/;
const MAX_DATABASES_PER_AGENT = 25;
const PITR_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

const registry = (env: Env) => env.REGISTRY.getByName('main');
const stub = (env: Env, info: DatabaseInfo) => env.PGLITE_DATABASE.get(env.PGLITE_DATABASE.idFromString(info.id));

const sha256 = async (text: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

export async function authenticate(env: Env, header: string | undefined): Promise<Principal | null> {
	const token = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
	if (!token) return null;
	const hash = await sha256(token);
	if (env.TRUNK_ADMIN_TOKEN && crypto.subtle.timingSafeEqual(hash, await sha256(env.TRUNK_ADMIN_TOKEN))) return { agent: null };
	const agent = await registry(env).agentForToken(hex(hash));
	return agent ? { agent } : null;
}

function checkName(name: string, what = 'database') {
	if (!NAME.test(name)) throw new HttpError(400, `Invalid ${what} name "${name}": use 1-63 lowercase letters, digits, "-" or "_".`);
}

function requireAdmin(principal: Principal) {
	if (principal.agent !== null) throw new HttpError(403, 'Only the trunk admin can do this.');
}

/** Resolves a database the principal may use. Admin access to an unknown name creates it. */
async function open(env: Env, principal: Principal, name: string) {
	checkName(name);
	const info = principal.agent === null ? await registry(env).ensureDatabase(name) : await registry(env).database(name);
	// Same 404 as a missing name: an agent never sees another owner's database or its data.
	if (!info || (principal.agent !== null && info.owner !== principal.agent)) {
		throw new HttpError(404, `Database "${name}" not found. Use list_databases or create_database.`);
	}
	if (!info.ready) throw new HttpError(409, `Database "${name}" is still being forked; try again in a moment. If this lasts, the fork failed: \`trunk rm ${name}\`.`);
	return stub(env, info);
}

/** A Durable Object that calls abort() rejects its caller with this flag; anything else is a real failure. */
const ignoreReset = (error: unknown) => {
	if (!(error as { durableObjectReset?: boolean } | null)?.durableObjectReset) throw error;
};

/** PITR only exists on deployed Durable Objects, not in `wrangler dev`. */
async function pitr<T>(promise: Promise<T>): Promise<T> {
	try {
		return await promise;
	} catch (error) {
		throw new HttpError(501, `Point-in-time recovery failed (${message(error)}). Checkpoints and restore only work on the deployed Worker, not in wrangler dev.`);
	}
}

export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const toJson = (value: unknown) => JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item));

// The object id is internal; callers address databases by name.
const publicInfo = ({ id: _id, ready, ...info }: DatabaseInfo) => (ready ? info : { ...info, forking: true });

export const listDatabases = async (env: Env, principal: Principal) => (await registry(env).databases(principal.agent ?? undefined)).map(publicInfo);

export const createDatabase = async (env: Env, principal: Principal, name: string, owner?: string | null) =>
	publicInfo(await register(env, principal, name, owner, null));

async function register(env: Env, principal: Principal, name: string, owner: string | null | undefined, forkedFrom: string | null) {
	checkName(name);
	if (owner) checkName(owner, 'agent');
	const limit = principal.agent === null ? undefined : MAX_DATABASES_PER_AGENT;
	const info = await registry(env).createDatabase(name, principal.agent ?? owner ?? null, forkedFrom, limit);
	if (info === 'taken') throw new HttpError(409, `Database "${name}" already exists.`);
	if (info === 'limit') throw new HttpError(409, `You already have ${MAX_DATABASES_PER_AGENT} databases, the limit. Ask the user to delete some with \`trunk rm\`.`);
	return info;
}

export async function deleteDatabase(env: Env, principal: Principal, name: string) {
	requireAdmin(principal);
	const info = await registry(env).database(name);
	if (!info) throw new HttpError(404, `Database "${name}" not found.`);
	// Unregister first, so nobody can open the name while its data is being wiped.
	await registry(env).removeDatabase(name);
	await stub(env, info).destroy().catch(ignoreReset);
	return { deleted: name };
}

export async function query(env: Env, principal: Principal, name: string, sql: string, params?: unknown[]): Promise<QueryResult[]> {
	if (copiesFromStdin(sql)) throw new HttpError(400, 'COPY FROM STDIN needs a Postgres client: use INSERT here, or psql \\copy through `trunk proxy`.');
	if (resetsSession(sql)) throw new HttpError(400, 'DISCARD ALL and DEALLOCATE ALL would affect every connection to this database, so they only work from a Postgres client.');
	const db = await open(env, principal, name);
	try {
		return params ? [await db.query(sql, params)] : await db.exec(sql);
	} catch (error) {
		throw new HttpError(400, message(error));
	}
}

export async function describe(env: Env, principal: Principal, name: string) {
	const [result] = await query(
		env,
		principal,
		name,
		`select table_schema as schema, table_name as table,
			string_agg(column_name || ' ' || data_type || case when is_nullable = 'NO' then ' not null' else '' end, ', ' order by ordinal_position) as columns
		from information_schema.columns
		where table_schema not in ('pg_catalog', 'information_schema')
		group by 1, 2 order by 1, 2`,
		[],
	);
	return result.rows;
}

export async function fork(env: Env, principal: Principal, source: string, target: string, owner?: string | null) {
	const db = await open(env, principal, source);
	const info = await register(env, principal, target, owner, source);
	try {
		await db.forkTo(info.id);
	} catch (error) {
		await registry(env).removeDatabase(target);
		await stub(env, info).destroy().catch(() => {}); // best effort: drop the partial copy
		throw new HttpError(400, `Fork failed: ${message(error)}`);
	}
	await registry(env).markReady(target);
	return publicInfo(info);
}

export async function checkpoint(env: Env, principal: Principal, name: string, label: string) {
	if (!LABEL.test(label)) throw new HttpError(400, 'Checkpoint labels are 1-80 letters, digits, "_", "-", "." or ":".');
	const db = await open(env, principal, name);
	const bookmark = await pitr(db.bookmark());
	if (!(await registry(env).addCheckpoint(name, label, bookmark))) throw new HttpError(409, `Checkpoint "${label}" already exists on "${name}".`);
	return { database: name, checkpoint: label };
}

export async function listCheckpoints(env: Env, principal: Principal, name: string) {
	await open(env, principal, name);
	return (await registry(env).checkpoints(name)).map(({ label, createdAt }) => ({ label, createdAt: new Date(createdAt).toISOString() }));
}

/** `to` is a checkpoint label, a duration ago ("15m", "2h", "3d"), or an ISO timestamp. */
export function parseRestorePoint(to: string, now = Date.now()): { label: string } | { time: number } {
	const ago = to.trim().match(/^(\d+)\s*([smhd])(?:\s+ago)?$/);
	if (ago) return { time: now - Number(ago[1]) * UNITS[ago[2]] };
	if (/^\d{4}-\d{2}-\d{2}/.test(to) && !Number.isNaN(Date.parse(to))) return { time: Date.parse(to) };
	return { label: to };
}

export async function restore(env: Env, principal: Principal, name: string, to: string) {
	const db = await open(env, principal, name);
	const point = parseRestorePoint(to);
	let bookmark: string;
	if ('label' in point) {
		const saved = await registry(env).checkpoint(name, point.label);
		if (!saved) throw new HttpError(404, `No checkpoint "${point.label}" on "${name}". Use a label from list_checkpoints, "15m", "2h", or an ISO time.`);
		bookmark = saved.bookmark;
	} else {
		if (point.time > Date.now() || point.time < Date.now() - PITR_WINDOW_MS) throw new HttpError(400, 'Restore time must be within the last 30 days.');
		bookmark = await pitr(db.bookmark(point.time));
	}
	const undo = await pitr(db.armRestore(bookmark));
	// Saved before the restart, so the undo point exists even if the restart call fails.
	const undoLabel = `before-restore-${new Date().toISOString()}`;
	try {
		await registry(env).addCheckpoint(name, undoLabel, undo);
	} finally {
		// Restart even if saving the label failed: an armed restore must not apply at some random later restart.
		await db.restart('database restored').catch(ignoreReset);
	}
	return { database: name, restoredTo: to, undo: undoLabel };
}

export async function connect(env: Env, principal: Principal, name: string, request: Request) {
	return (await open(env, principal, name)).fetch(request);
}

export async function createAgentToken(env: Env, principal: Principal, agent: string) {
	requireAdmin(principal);
	checkName(agent, 'agent');
	const token = `trk_${hex(crypto.getRandomValues(new Uint8Array(24)))}`;
	await registry(env).addToken(agent, hex(await sha256(token)));
	return { agent, token };
}

export async function revokeAgent(env: Env, principal: Principal, agent: string) {
	requireAdmin(principal);
	const revokedTokens = await registry(env).revokeAgent(agent);
	// Tokens are only checked when a connection opens, so close the agent's open ones too.
	const owned = await registry(env).databases(agent);
	await Promise.all(owned.map((info) => stub(env, info).disconnect('agent access revoked')));
	return { agent, revokedTokens };
}

export async function listAgents(env: Env, principal: Principal) {
	requireAdmin(principal);
	return registry(env).agents();
}
