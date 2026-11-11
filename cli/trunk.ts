#!/usr/bin/env bun
// trunk: manage agent databases and let local Postgres clients reach them.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

import { CANCEL_REQUEST, GSSENC_REQUEST, PROTOCOL_V3, SSL_REQUEST, concat, cstring, errorResponse, int32, message, startupParams } from '../src/wire';

const CONFIG_PATH = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'trunk', 'config.json');
const DEFAULT_PORT = 5433;
// Connecting as this user makes the proxy ask for a password and use it as the trunk token.
const AGENT_USER = 'agent';
// AuthenticationCleartextPassword. Fine on loopback; the hop to Cloudflare is TLS.
const ASK_PASSWORD = message('R', new Uint8Array([0, 0, 0, 3]));
// Startup packets are a few hundred bytes; this rejects non-Postgres traffic early.
const MAX_STARTUP_BYTES = 10_000;

const USAGE = `trunk: Postgres databases your agents can't hurt you with

  trunk login <url> <admin-token>     save the Worker URL and admin token
  trunk proxy [--port ${DEFAULT_PORT}]          let local clients connect: psql postgres://localhost:${DEFAULT_PORT}/<db>
                                       agents: postgres://${AGENT_USER}:<agent-token>@localhost:${DEFAULT_PORT}/<db>

  trunk ls                             list databases
  trunk new <db> [--owner <agent>]     create a database (connecting to a new name also creates it)
  trunk fork <db> <new> [--owner <agent>]
  trunk rm <db> [--yes]                delete a database permanently

  trunk checkpoint <db> <label>        save the current state
  trunk checkpoints <db>
  trunk restore <db> <label | 15m | 2h | ISO time>

  trunk agent add <name>               create an MCP token for an agent
  trunk agent ls
  trunk agent rm <name>                revoke all of an agent's tokens

Environment variables TRUNK_URL and TRUNK_TOKEN override the saved login.`;

type Config = { url: string; token: string };

const fail = (message: string): never => {
	console.error(`trunk: ${message}`);
	process.exit(1);
};

function config(): Config {
	let saved: Partial<Config> = {};
	try {
		saved = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
	} catch {
		// not logged in yet
	}
	const url = process.env.TRUNK_URL ?? saved.url;
	const token = process.env.TRUNK_TOKEN ?? saved.token;
	if (!url || !token) return fail('not logged in. Run: trunk login <url> <admin-token>');
	return { url: url.replace(/\/+$/, ''), token };
}

async function api<T = any>(method: string, path: string, body?: unknown, { url, token } = config()): Promise<T> {
	let response: Response;
	try {
		response = await fetch(url + path, {
			method,
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	} catch (error) {
		return fail(`cannot reach ${url} (${error instanceof Error ? error.message : error})`);
	}
	const data = await response.json().catch(() => ({}));
	if (!response.ok) return fail((data as { error?: string }).error ?? `${response.status} ${response.statusText}`);
	return data as T;
}

const dbPath = (name: string, rest = '') => `/v1/databases/${encodeURIComponent(name)}${rest}`;
const need = (value: string | undefined, usage: string): string => value ?? fail(`usage: trunk ${usage}`);
const time = (ms: number) => new Date(ms).toLocaleString();

// --- proxy -----------------------------------------------------------------

// Bun's WebSocket accepts headers; the DOM typings don't know that.
const HeaderWebSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;

function proxy(port: number) {
	const { url, token } = config();
	const wsUrl = url.replace(/^http/, 'ws');
	// Loopback only: the proxy acts with your admin token. "localhost" may resolve to either address.
	for (const host of ['127.0.0.1', '::1']) {
		createServer((socket) => pipe(socket, wsUrl, token))
			.on('error', (error) => (host === '::1' ? console.warn(`trunk: not listening on [::1]: ${error.message}`) : fail(error.message)))
			.listen(port, host, () => {
				if (host === '::1') return;
				console.log(`trunk proxy on localhost:${port} -> ${url}`);
				console.log(`connect with: psql postgres://localhost:${port}/<database>`);
			});
	}
}

/**
 * Answers SSL negotiation locally (the hop to Cloudflare is already TLS), reads the database name from
 * the startup packet, then pipes raw protocol bytes between the client and that database's WebSocket.
 * User "agent" logs in with an agent token as password; any other user acts as you.
 */
// ponytail: no backpressure handling; fine for dev traffic, add pause/resume if huge COPYs ever stall.
function pipe(socket: Socket, wsUrl: string, adminToken: string) {
	let pending = new Uint8Array(0);
	let login: Uint8Array | null = null; // an agent's startup packet, held until its password arrives
	let ws: WebSocket | undefined;
	let received = false;
	const queued: Uint8Array[] = [];
	const reject = (text: string, code?: string) => void socket.end(errorResponse(text, code));

	const open = (packet: Uint8Array, rest: Uint8Array, token: string) => {
		const params = startupParams(packet);
		const database = params.database || params.user;
		console.log(`-> ${database}${token === adminToken ? '' : ' (agent)'}`);
		queued.push(packet, rest);
		ws = new HeaderWebSocket(`${wsUrl}${dbPath(database, '/connect')}`, { headers: { authorization: `Bearer ${token}` } });
		ws.binaryType = 'arraybuffer';
		ws.onopen = () => {
			for (const part of queued.splice(0)) ws!.send(part);
		};
		ws.onmessage = (event) => {
			received = true;
			socket.write(new Uint8Array(event.data as ArrayBuffer));
		};
		ws.onclose = () => {
			if (received) return void socket.end();
			console.error(`   ${database}: connection to trunk failed`);
			reject(`trunk could not connect to database "${database}"; check \`trunk ls\` and your login`);
		};
	};

	socket.on('data', (chunk: Uint8Array) => {
		if (ws) {
			if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
			else queued.push(chunk);
			return;
		}

		pending = concat(pending, chunk);
		if (login) {
			// PasswordMessage: 'p', int32 length, password
			if (pending.length < 5) return;
			const length = int32(pending, 1);
			if (pending[0] !== 0x70 || length < 5 || length > MAX_STARTUP_BYTES) return reject('expected a password message', '28000');
			if (pending.length < 1 + length) return;
			const password = cstring(pending, 5);
			if (!/^[\x21-\x7e]+$/.test(password)) return reject(`user "${AGENT_USER}" needs an agent token as password`, '28P01');
			return open(login, pending.subarray(1 + length), password);
		}

		while (pending.length >= 8) {
			const length = int32(pending, 0);
			if (length < 8 || length > MAX_STARTUP_BYTES) return void socket.end();
			if (pending.length < length) return;
			const code = int32(pending, 4);
			const packet = pending.subarray(0, length);
			pending = pending.subarray(length);
			if (code === SSL_REQUEST || code === GSSENC_REQUEST) {
				socket.write('N');
				continue;
			}
			if (code === CANCEL_REQUEST) return void socket.end(); // ponytail: query cancel unsupported
			if (code !== PROTOCOL_V3) return reject('trunk only speaks Postgres protocol 3.0');
			if (startupParams(packet).user !== AGENT_USER) return open(packet, pending, adminToken);
			login = packet;
			return void socket.write(ASK_PASSWORD);
		}
	});
	socket.on('close', () => ws?.close());
	socket.on('error', () => ws?.close());
}

// --- commands --------------------------------------------------------------

const { positionals, values } = parseArgs({
	allowPositionals: true,
	options: { port: { type: 'string', short: 'p' }, owner: { type: 'string' }, yes: { type: 'boolean', short: 'y' }, help: { type: 'boolean', short: 'h' } },
});
const [command, ...args] = positionals;

switch (values.help ? 'help' : command) {
	case 'login': {
		const url = need(args[0], 'login <url> <admin-token>').replace(/\/+$/, '');
		const token = need(args[1], 'login <url> <admin-token>');
		await api('GET', '/v1/databases', undefined, { url, token });
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, JSON.stringify({ url, token }, null, 2), { mode: 0o600 });
		console.log(`Logged in to ${url}. Saved to ${CONFIG_PATH}`);
		break;
	}
	case 'proxy':
		proxy(Number(values.port ?? DEFAULT_PORT));
		break;
	case 'ls': {
		const databases = await api<{ name: string; owner: string | null; forkedFrom: string | null; createdAt: number; forking?: true }[]>('GET', '/v1/databases');
		if (!databases.length) console.log('No databases yet. Create one with `trunk new <db>` or just connect to a new name.');
		else console.table(databases.map((db) => ({ name: db.forking ? `${db.name} (forking)` : db.name, owner: db.owner ?? 'you', 'forked from': db.forkedFrom ?? '', created: time(db.createdAt) })));
		break;
	}
	case 'new': {
		const name = need(args[0], 'new <db> [--owner <agent>]');
		await api('POST', '/v1/databases', { name, owner: values.owner });
		console.log(`Created ${name}: postgres://localhost:${DEFAULT_PORT}/${name}`);
		break;
	}
	case 'fork': {
		const [source, target] = [need(args[0], 'fork <db> <new>'), need(args[1], 'fork <db> <new>')];
		await api('POST', dbPath(source, '/fork'), { name: target, owner: values.owner });
		console.log(`Forked ${source} -> ${target}${values.owner ? ` (owned by ${values.owner})` : ''}`);
		break;
	}
	case 'rm': {
		const name = need(args[0], 'rm <db> [--yes]');
		if (!values.yes && prompt(`Permanently delete "${name}"? Type its name to confirm:`) !== name) fail('aborted');
		await api('DELETE', dbPath(name));
		console.log(`Deleted ${name}`);
		break;
	}
	case 'checkpoint': {
		const [name, label] = [need(args[0], 'checkpoint <db> <label>'), need(args[1], 'checkpoint <db> <label>')];
		await api('POST', dbPath(name, '/checkpoints'), { label });
		console.log(`Saved checkpoint "${label}" on ${name}`);
		break;
	}
	case 'checkpoints': {
		const checkpoints = await api<{ label: string; createdAt: string }[]>('GET', dbPath(need(args[0], 'checkpoints <db>'), '/checkpoints'));
		if (!checkpoints.length) console.log('No checkpoints. You can still restore to any time in the last 30 days, e.g. `trunk restore <db> 15m`.');
		else console.table(checkpoints.map((c) => ({ label: c.label, created: time(Date.parse(c.createdAt)) })));
		break;
	}
	case 'restore': {
		const [name, to] = [need(args[0], 'restore <db> <label | 15m | ISO time>'), need(args[1], 'restore <db> <label | 15m | ISO time>')];
		const result = await api<{ undo: string }>('POST', dbPath(name, '/restore'), { to });
		console.log(`Restored ${name} to ${to}. Undo with: trunk restore ${name} ${result.undo}`);
		break;
	}
	case 'agent': {
		const [sub, name] = args;
		if (sub === 'add') {
			const { token } = await api<{ token: string }>('POST', '/v1/agents', { name: need(name, 'agent add <name>') });
			const { url } = config();
			console.log(`Token for agent "${name}" (shown once):\n  ${token}\n`);
			console.log(`Add it to Claude Code:\n  claude mcp add --transport http trunk ${url}/mcp --header "Authorization: Bearer ${token}"\n`);
			console.log(`Postgres URL for this agent (through \`trunk proxy\`):\n  postgres://${AGENT_USER}:${token}@localhost:${DEFAULT_PORT}/<db>`);
		} else if (sub === 'ls') {
			console.table(await api('GET', '/v1/agents'));
		} else if (sub === 'rm') {
			const { revokedTokens } = await api<{ revokedTokens: number }>('DELETE', `/v1/agents/${encodeURIComponent(need(name, 'agent rm <name>'))}`);
			console.log(`Revoked ${revokedTokens} token(s) for ${name}. Their databases are kept.`);
		} else {
			fail('usage: trunk agent add|ls|rm <name>');
		}
		break;
	}
	default:
		console.log(USAGE);
		if (command && command !== 'help') process.exit(1);
}
