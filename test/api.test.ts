import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { parseRestorePoint } from '../src/ops';
import { concat, int32, namespaceMessage, PROTOCOL_V3, splitMessages } from '../src/wire';

const ADMIN = 'Bearer test-admin-token';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const unique = () => `t-${crypto.randomUUID().slice(0, 8)}`;

const api = (path: string, { method = 'GET', body, token = ADMIN }: { method?: string; body?: unknown; token?: string } = {}) =>
	exports.default.fetch(`https://trunk.test${path}`, {
		method,
		headers: { authorization: token, 'content-type': 'application/json' },
		body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
	});

const sql = async (db: string, query: string, params?: unknown[], token = ADMIN) => {
	const response = await api(`/v1/databases/${db}/query`, { method: 'POST', body: { sql: query, params }, token });
	return { status: response.status, body: (await response.json()) as any };
};

const newAgent = async (name = unique()) => {
	const response = await api('/v1/agents', { method: 'POST', body: { name } });
	expect(response.status).toBe(201);
	const { token } = (await response.json()) as { token: string };
	return { name, auth: `Bearer ${token}` };
};

// --- minimal Postgres frontend for the wire-protocol tests ---

const cstr = (text: string) => concat(encoder.encode(text), new Uint8Array([0]));
const message = (type: string, ...parts: Uint8Array[]) => {
	const body = concat(...parts);
	const out = new Uint8Array(5 + body.length);
	out[0] = type.charCodeAt(0);
	new DataView(out.buffer).setInt32(1, 4 + body.length);
	out.set(body, 5);
	return out;
};
const startup = () => {
	const body = concat(cstr('user'), cstr('me'), cstr('database'), cstr('whatever'), new Uint8Array([0]));
	const out = new Uint8Array(8 + body.length);
	new DataView(out.buffer).setInt32(0, out.length);
	new DataView(out.buffer).setInt32(4, PROTOCOL_V3);
	out.set(body, 8);
	return out;
};
const Q = (text: string) => message('Q', cstr(text));
const parse = (name: string, text: string) => message('P', cstr(name), cstr(text), new Uint8Array(2));
const bind = (statement: string) => message('B', cstr(''), cstr(statement), new Uint8Array(6));
const execute = () => message('E', cstr(''), new Uint8Array(4));
const describeStatement = (name: string) => message('D', encoder.encode('S'), cstr(name));
const SYNC = message('S');

/** `types` lists the message types received, e.g. '2DCZ' for BindComplete, DataRow, CommandComplete, ReadyForQuery. */
type Reply = { status: string; rows: (string | null)[][]; types: string; error?: string };

async function connect(db: string, token = ADMIN) {
	const response = await exports.default.fetch(`https://trunk.test/v1/databases/${db}/connect`, { headers: { upgrade: 'websocket', authorization: token } });
	const ws = response.webSocket!;
	ws.accept();
	ws.binaryType = 'arraybuffer';
	let buf: Uint8Array = new Uint8Array(0);
	let current: Reply = { status: '', rows: [], types: '' };
	const replies: Reply[] = [];
	const waiting: ((reply: Reply) => void)[] = [];
	ws.addEventListener('message', (event) => {
		const split = splitMessages(concat(buf, new Uint8Array(event.data as ArrayBuffer)), false);
		buf = split.rest;
		for (const msg of split.messages) {
			const type = String.fromCharCode(msg[0]);
			current.types += type;
			if (type === 'D') {
				const row: (string | null)[] = [];
				let at = 7;
				for (let i = 0; i < new DataView(msg.buffer, msg.byteOffset).getInt16(5); i++) {
					const length = int32(msg, at);
					row.push(length < 0 ? null : decoder.decode(msg.subarray(at + 4, at + 4 + length)));
					at += 4 + Math.max(length, 0);
				}
				current.rows.push(row);
			} else if (type === 'E') {
				current.error = decoder.decode(msg.subarray(5)).split('\0').find((field) => field.startsWith('M'))?.slice(1);
				if (decoder.decode(msg.subarray(5)).includes('SFATAL')) finish('closed');
			} else if (type === 'Z') {
				finish(String.fromCharCode(msg[5]));
			}
		}
	});
	ws.addEventListener('close', () => finish('closed'));
	const finish = (status: string) => {
		const reply = { ...current, status };
		current = { status: '', rows: [], types: '' };
		const waiter = waiting.shift();
		if (waiter) waiter(reply);
		else replies.push(reply);
	};
	const next = () => (replies.length ? Promise.resolve(replies.shift()!) : new Promise<Reply>((resolve) => waiting.push(resolve)));
	return {
		send: (...messages: Uint8Array[]) => ws.send(concat(...messages)),
		next,
		query: (text: string) => (ws.send(Q(text)), next()),
		close: () => ws.close(1000),
		hasPending: () => replies.length > 0,
	};
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('HTTP API', () => {
	it('returns health status', async () => {
		const response = await exports.default.fetch('https://trunk.test/health');
		expect(await response.json()).toEqual({ ok: true });
	});

	it('requires a valid bearer token', async () => {
		expect((await api('/v1/databases', { token: '' })).status).toBe(401);
		expect((await api('/v1/databases', { token: 'Bearer nope' })).status).toBe(401);
	});

	it('runs SQL with params and registers the database for the admin', async () => {
		const db = unique();
		expect(await sql(db, 'select $1::text as value', ['hello'])).toMatchObject({ status: 200, body: [{ rows: [{ value: 'hello' }] }] });
		const list = (await (await api('/v1/databases')).json()) as { name: string; owner: string | null }[];
		expect(list).toContainEqual(expect.objectContaining({ name: db, owner: null }));
	});

	it('runs several statements without params', async () => {
		const { body } = await sql(unique(), 'create table t (n int); insert into t values (1), (2); select sum(n)::int as total from t');
		expect(body.at(-1).rows).toEqual([{ total: 3 }]);
	});

	it('validates request bodies', async () => {
		const db = unique();
		const post = async (body: unknown) => (await api(`/v1/databases/${db}/query`, { method: 'POST', body })).json();
		expect(await post('{')).toEqual({ error: 'Invalid JSON body' });
		expect(await post('null')).toEqual({ error: 'Expected JSON object body' });
		expect(await post({ params: [] })).toEqual({ error: 'Expected JSON body with string field: sql' });
		expect(await post({ sql: 'select 1', params: {} })).toEqual({ error: 'Expected params to be an array when provided' });
	});

	it('returns SQL errors as small 400 bodies', async () => {
		const { status, body } = await sql(unique(), 'select * from missing_table');
		expect(status).toBe(400);
		expect(body.error).toContain('missing_table');
		expect(body.stack).toBeUndefined();
	});

	it('rolls back a transaction a request leaves open', async () => {
		const db = unique();
		await sql(db, 'create table t (n int)');
		const { status, body } = await sql(db, 'begin; insert into t values (1)');
		expect(status).toBe(400);
		expect(body.error).toContain('rolled back');
		expect((await sql(db, 'select count(*)::int as n from t')).body[0].rows).toEqual([{ n: 0 }]);
	});

	it('refuses COPY FROM STDIN and session resets, which need a Postgres client', async () => {
		const { status, body } = await sql(unique(), 'copy t from stdin');
		expect(status).toBe(400);
		expect(body.error).toContain('trunk proxy');
		expect((await sql(unique(), '/* hidden */ copy t from stdin')).status).toBe(400);
		expect((await sql(unique(), 'select 1; discard all')).status).toBe(400);
	});

	it('rejects invalid database names', async () => {
		expect((await sql('Bad Name', 'select 1')).status).toBe(400);
	});

	it('saves checkpoints locally but explains that restore needs the deployed Worker', async () => {
		const db = unique();
		await sql(db, 'select 1');
		expect((await api(`/v1/databases/${db}/checkpoints`, { method: 'POST', body: { label: 'before' } })).status).toBe(201);
		expect((await api(`/v1/databases/${db}/checkpoints`, { method: 'POST', body: { label: 'before' } })).status).toBe(409);
		expect(await (await api(`/v1/databases/${db}/checkpoints`)).json()).toEqual([{ label: 'before', createdAt: expect.any(String) }]);

		const response = await api(`/v1/databases/${db}/restore`, { method: 'POST', body: { to: 'before' } });
		expect(response.status).toBe(501);
		expect(((await response.json()) as { error: string }).error).toContain('deployed Worker');
	});
});

describe('agents', () => {
	it('only see and use their own databases', async () => {
		const admin = unique();
		await sql(admin, 'create table secrets (s text)');
		const agent = await newAgent();
		const mine = unique();

		expect((await api('/v1/databases', { method: 'POST', body: { name: mine }, token: agent.auth })).status).toBe(201);
		expect((await sql(mine, 'create table t (n int)', undefined, agent.auth)).status).toBe(200);
		expect((await sql(admin, 'select * from secrets', undefined, agent.auth)).status).toBe(404);

		const list = (await (await api('/v1/databases', { token: agent.auth })).json()) as { name: string }[];
		expect(list.map(({ name }) => name)).toEqual([mine]);
	});

	it('cannot mint tokens or delete databases', async () => {
		const agent = await newAgent();
		expect((await api('/v1/agents', { method: 'POST', body: { name: 'x' }, token: agent.auth })).status).toBe(403);
		expect((await api(`/v1/databases/${unique()}`, { method: 'DELETE', token: agent.auth })).status).toBe(403);
	});

	it('lose access and open connections when revoked', async () => {
		const agent = await newAgent();
		const db = unique();
		await api('/v1/databases', { method: 'POST', body: { name: db }, token: agent.auth });
		const pg = await connect(db, agent.auth);
		pg.send(startup());
		await pg.next();

		expect((await api(`/v1/agents/${agent.name}`, { method: 'DELETE' })).status).toBe(200);
		expect((await api('/v1/databases', { token: agent.auth })).status).toBe(401);
		expect((await pg.next()).status).toBe('closed');
	});
});

describe('fork and delete', () => {
	it('fork copies data into an independent database', async () => {
		const source = unique();
		const copy = unique();
		await sql(source, "create table t (s text); insert into t values ('original')");
		expect((await api(`/v1/databases/${source}/fork`, { method: 'POST', body: { name: copy } })).status).toBe(201);

		await sql(copy, "insert into t values ('only in copy')");
		expect((await sql(copy, 'select count(*)::int as n from t')).body[0].rows).toEqual([{ n: 2 }]);
		expect((await sql(source, 'select count(*)::int as n from t')).body[0].rows).toEqual([{ n: 1 }]);
	});

	it('keeps a fork closed until its data is copied', async () => {
		const name = unique();
		await env.REGISTRY.getByName('main').createDatabase(name, null, 'some-source'); // a fork in progress
		expect(await sql(name, 'select 1')).toMatchObject({ status: 409, body: { error: expect.stringContaining('still being forked') } });
		expect(await (await api('/v1/databases')).json()).toContainEqual(expect.objectContaining({ name, forking: true }));
	});

	it('delete wipes the data', async () => {
		const db = unique();
		await sql(db, 'create table t (n int)');
		expect((await api(`/v1/databases/${db}`, { method: 'DELETE' })).status).toBe(200);
		expect((await sql(db, 'select * from t')).status).toBe(400);
	});
});

describe('Postgres wire protocol over WebSocket', () => {
	it('answers startup and simple queries', async () => {
		const pg = await connect(unique());
		pg.send(startup());
		expect((await pg.next()).status).toBe('I');
		expect(await pg.query('select 1 + 1 as two')).toMatchObject({ status: 'I', rows: [['2']] });
		pg.close();
	});

	it('makes other clients wait while one is inside a transaction', async () => {
		const db = unique();
		await sql(db, 'create table t (n int)');
		const a = await connect(db);
		const b = await connect(db);
		a.send(startup());
		b.send(startup());
		await a.next();
		await b.next();

		expect((await a.query('begin; insert into t values (1)')).status).toBe('T');
		b.send(Q('select count(*) from t'));
		await sleep(200);
		expect(b.hasPending()).toBe(false);

		expect((await a.query('commit')).status).toBe('I');
		expect((await b.next()).rows).toEqual([['1']]);
		a.close();
		b.close();
	});

	it('keeps named prepared statements of different clients apart', async () => {
		const db = unique();
		const a = await connect(db);
		const b = await connect(db);
		a.send(startup());
		b.send(startup());
		await a.next();
		await b.next();

		a.send(parse('s0', "select 'a'"), SYNC);
		b.send(parse('s0', "select 'b'"), SYNC);
		expect((await a.next()).error).toBeUndefined();
		expect((await b.next()).error).toBeUndefined();

		a.send(bind('s0'), execute(), SYNC);
		b.send(bind('s0'), execute(), SYNC);
		expect((await a.next()).rows).toEqual([['a']]);
		expect((await b.next()).rows).toEqual([['b']]);
		a.close();
		b.close();
	});

	it('rolls back the transaction of a client that disconnects', async () => {
		const db = unique();
		await sql(db, 'create table t (n int)');
		const a = await connect(db);
		a.send(startup());
		await a.next();
		await a.query('begin; insert into t values (1)');
		a.close();

		expect((await sql(db, 'select count(*)::int as n from t')).body[0].rows).toEqual([{ n: 0 }]);
	});

	it('discards a half-sent batch of a client that disconnects', async () => {
		const db = unique();
		await sql(db, 'create table t (n int)');
		const a = await connect(db);
		a.send(startup());
		await a.next();
		a.send(parse('', 'insert into t values (1)'), bind(''), execute()); // no Sync, so not committed
		await sleep(100);
		a.close();

		expect((await sql(db, 'select count(*)::int as n from t')).body[0].rows).toEqual([{ n: 0 }]);
	});

	it('scopes DEALLOCATE and DISCARD ALL to the client that sends them', async () => {
		const db = unique();
		const a = await connect(db);
		const b = await connect(db);
		a.send(startup());
		b.send(startup());
		await a.next();
		await b.next();
		a.send(parse('s1', "select 'a'"), SYNC);
		b.send(parse('s1', "select 'b'"), SYNC);
		await a.next();
		await b.next();

		expect((await a.query('deallocate s1')).error).toBeUndefined();
		a.send(parse('s1', "select 'a2'"), SYNC); // the name is free again
		expect((await a.next()).error).toBeUndefined();

		expect(await a.query('discard all')).toMatchObject({ status: 'I', rows: [] });
		a.send(bind('s1'), execute(), SYNC);
		expect((await a.next()).error).toContain('does not exist');
		b.send(bind('s1'), execute(), SYNC);
		expect((await b.next()).rows).toEqual([['b']]);
		a.close();
		b.close();
	});

	it("keeps each client's unnamed statement between round trips", async () => {
		const db = unique();
		const a = await connect(db);
		const b = await connect(db);
		a.send(startup());
		b.send(startup());
		await a.next();
		await b.next();

		// Like Go's lib/pq: parse and describe, then bind in a second round trip.
		a.send(parse('', "select 'a'"), describeStatement(''), SYNC);
		await a.next();
		b.send(parse('', "select 'b'"), bind(''), execute(), SYNC);
		expect((await b.next()).rows).toEqual([['b']]);
		await sql(db, 'select 1'); // HTTP queries replace the unnamed statement too
		a.send(bind(''), execute(), SYNC);
		expect(await a.next()).toMatchObject({ rows: [['a']], types: '2DCZ' });
		a.close();
		b.close();
	});

	it('still runs what a client sent right before hanging up', async () => {
		const db = unique();
		await sql(db, 'create table t (n int)');
		const a = await connect(db);
		const b = await connect(db);
		a.send(startup());
		b.send(startup());
		await a.next();
		await b.next();
		await b.query('begin'); // so a's insert waits in the queue
		a.send(Q('insert into t values (1)'));
		a.close();
		await sleep(100);
		await b.query('commit');

		expect((await sql(db, 'select count(*)::int as n from t')).body[0].rows).toEqual([{ n: 1 }]);
		b.close();
	});

	it('supports COPY FROM STDIN', async () => {
		const db = unique();
		await sql(db, 'create table t (s text)');
		const pg = await connect(db);
		pg.send(startup());
		await pg.next();
		pg.send(Q('copy t from stdin'));
		await sleep(50); // the client waits for CopyInResponse before sending rows
		pg.send(message('d', encoder.encode('a\nb\n')), message('c'));
		const reply = await pg.next();
		expect(reply.error).toBeUndefined();
		expect(reply.status).toBe('I');
		expect(await pg.query('select count(*) from t')).toMatchObject({ rows: [['2']] });
		pg.close();
	});

	it('restarts the database when Postgres exits, keeping committed data', async () => {
		const db = unique();
		await sql(db, "create table t (s text); insert into t values ('kept')");
		const pg = await connect(db);
		pg.send(startup());
		await pg.next();
		// COPY through the extended protocol isn't intercepted, so PGlite hits end of input and exits.
		pg.send(parse('', 'copy t from stdin'), bind(''), execute(), SYNC);
		expect((await pg.next()).status).toBe('closed');

		expect((await sql(db, 'select s from t')).body[0].rows).toEqual([{ s: 'kept' }]);
	});

	it('rejects agents with a Postgres error message', async () => {
		const agent = await newAgent();
		const pg = await connect(unique(), agent.auth);
		expect((await pg.next()).error).toContain('not found');
	});
});

describe('MCP server', () => {
	const call = async (token: string, method: string, params: unknown = {}) => {
		const response = await exports.default.fetch('https://trunk.test/mcp', {
			method: 'POST',
			headers: { authorization: token, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
		});
		const text = await response.text();
		const data = text.trimStart().startsWith('{') ? text : text.split('\n').find((line) => line.startsWith('data:'))!.slice(5);
		return JSON.parse(data);
	};
	const tool = async (token: string, name: string, args: Record<string, unknown>) => {
		const { result } = await call(token, 'tools/call', { name, arguments: args });
		return { isError: Boolean(result.isError), data: result.isError ? result.content[0].text : JSON.parse(result.content[0].text) };
	};

	it('requires a token', async () => {
		const response = await exports.default.fetch('https://trunk.test/mcp', { method: 'POST', body: '{}' });
		expect(response.status).toBe(401);
	});

	it('lists the database tools', async () => {
		const agent = await newAgent();
		const { result } = await call(agent.auth, 'tools/list');
		expect(result.tools.map((t: { name: string }) => t.name).sort()).toEqual(
			['checkpoint', 'create_database', 'describe', 'fork', 'list_checkpoints', 'list_databases', 'query', 'restore'].sort(),
		);
	});

	it('lets an agent create, change and inspect its own database', async () => {
		const agent = await newAgent();
		const db = unique();
		expect((await tool(agent.auth, 'create_database', { name: db })).isError).toBe(false);
		await tool(agent.auth, 'query', { database: db, sql: "create table notes (body text not null); insert into notes values ('hi')" });

		const { data } = await tool(agent.auth, 'query', { database: db, sql: 'select body from notes where body = $1', params: ['hi'] });
		expect(data[0]).toMatchObject({ columns: ['body'], rows: [{ body: 'hi' }], rowCount: 1 });
		expect((await tool(agent.auth, 'describe', { database: db })).data).toEqual([{ schema: 'public', table: 'notes', columns: 'body text not null' }]);
	});

	it("keeps agents out of other databases", async () => {
		const other = unique();
		await sql(other, 'select 1');
		const agent = await newAgent();
		const result = await tool(agent.auth, 'query', { database: other, sql: 'select 1' });
		expect(result).toMatchObject({ isError: true });
		expect(result.data).toContain('not found');
	});
});

describe('helpers', () => {
	it('parses restore points', () => {
		const now = Date.UTC(2026, 0, 2);
		expect(parseRestorePoint('15m', now)).toEqual({ time: now - 15 * 60_000 });
		expect(parseRestorePoint('2h ago', now)).toEqual({ time: now - 2 * 3_600_000 });
		expect(parseRestorePoint('2026-01-01T00:00:00Z', now)).toEqual({ time: Date.UTC(2026, 0, 1) });
		expect(parseRestorePoint('before-migration', now)).toEqual({ label: 'before-migration' });
	});

	it('namespaces statement and portal names but leaves unnamed ones alone', () => {
		const named = namespaceMessage(bind('s0'), 't1_');
		expect(decoder.decode(named.subarray(5)).split('\0').slice(0, 2)).toEqual(['', 't1_s0']);
		expect(int32(named, 1)).toBe(named.length - 1);
		expect(namespaceMessage(parse('', 'select 1'), 't1_')).toEqual(parse('', 'select 1'));
	});
});
