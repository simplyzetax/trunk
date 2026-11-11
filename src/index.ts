import { Hono, type Context } from 'hono';

import { mcpHandler } from './mcp';
import * as ops from './ops';
import { errorResponse } from './wire';

export { PgliteDatabase } from './database';
export { Registry } from './registry';

type App = { Bindings: Env; Variables: { principal: ops.Principal } };
const app = new Hono<App>();

const json = (data: unknown, status = 200) => new Response(ops.toJson(data), { status, headers: { 'content-type': 'application/json' } });

const body = async (c: Context<App>): Promise<Record<string, unknown>> => {
	let parsed: unknown;
	try {
		parsed = await c.req.json();
	} catch {
		throw new ops.HttpError(400, 'Invalid JSON body');
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ops.HttpError(400, 'Expected JSON object body');
	return parsed as Record<string, unknown>;
};

const string = (value: unknown, field: string) => {
	if (typeof value !== 'string') throw new ops.HttpError(400, `Expected JSON body with string field: ${field}`);
	return value;
};

const optionalString = (value: unknown, field: string) => (value === undefined || value === null ? undefined : string(value, field));

app.get('/health', (c) => c.json({ ok: true }));

app.use('/v1/*', async (c, next) => {
	const principal = await ops.authenticate(c.env, c.req.header('authorization'));
	if (!principal) throw new ops.HttpError(401, 'Missing or invalid bearer token');
	c.set('principal', principal);
	await next();
});

app.all('/mcp', async (c) => {
	const principal = await ops.authenticate(c.env, c.req.header('authorization'));
	if (!principal) return c.json({ error: 'Missing or invalid bearer token' }, 401);
	return mcpHandler.fetch(c.req.raw, { authInfo: { token: '', clientId: principal.agent ?? 'admin', scopes: [], extra: { principal } } });
});

app.get('/v1/databases', async (c) => json(await ops.listDatabases(c.env, c.get('principal'))));

app.post('/v1/databases', async (c) => {
	const { name, owner } = await body(c);
	return json(await ops.createDatabase(c.env, c.get('principal'), string(name, 'name'), optionalString(owner, 'owner')), 201);
});

app.delete('/v1/databases/:name', async (c) => json(await ops.deleteDatabase(c.env, c.get('principal'), c.req.param('name'))));

app.post('/v1/databases/:name/query', async (c) => {
	const { sql, params } = await body(c);
	if (params !== undefined && !Array.isArray(params)) throw new ops.HttpError(400, 'Expected params to be an array when provided');
	return json(await ops.query(c.env, c.get('principal'), c.req.param('name'), string(sql, 'sql'), params));
});

app.post('/v1/databases/:name/fork', async (c) => {
	const { name, owner } = await body(c);
	return json(await ops.fork(c.env, c.get('principal'), c.req.param('name'), string(name, 'name'), optionalString(owner, 'owner')), 201);
});

app.get('/v1/databases/:name/checkpoints', async (c) => json(await ops.listCheckpoints(c.env, c.get('principal'), c.req.param('name'))));

app.post('/v1/databases/:name/checkpoints', async (c) => {
	const { label } = await body(c);
	return json(await ops.checkpoint(c.env, c.get('principal'), c.req.param('name'), string(label, 'label')), 201);
});

app.post('/v1/databases/:name/restore', async (c) => {
	const { to } = await body(c);
	return json(await ops.restore(c.env, c.get('principal'), c.req.param('name'), string(to, 'to')));
});

app.get('/v1/databases/:name/connect', (c) => ops.connect(c.env, c.get('principal'), c.req.param('name'), c.req.raw));

app.get('/v1/agents', async (c) => json(await ops.listAgents(c.env, c.get('principal'))));

app.post('/v1/agents', async (c) => {
	const { name } = await body(c);
	return json(await ops.createAgentToken(c.env, c.get('principal'), string(name, 'name')), 201);
});

app.delete('/v1/agents/:name', async (c) => json(await ops.revokeAgent(c.env, c.get('principal'), c.req.param('name'))));

app.onError((error, c) => {
	const status = error instanceof ops.HttpError ? error.status : 500;
	if (status === 500) console.error(error);
	// Postgres clients behind `trunk proxy` only understand protocol messages, so answer with one.
	if (c.req.header('upgrade') === 'websocket') return rejectWebSocket(error.message);
	return json({ error: error.message }, status);
});

function rejectWebSocket(message: string) {
	const { 0: client, 1: server } = new WebSocketPair();
	server.accept();
	server.send(errorResponse(message, '28000'));
	server.close(1008, 'rejected');
	return new Response(null, { status: 101, webSocket: client });
}

export default app;
