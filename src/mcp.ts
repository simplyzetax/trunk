import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import type { QueryResult } from './database';
import { env } from 'cloudflare:workers';
import * as z from 'zod/v4';

import * as ops from './ops';

const INSTRUCTIONS = `trunk gives you your own Postgres databases (real Postgres 17 via PGlite), separate from all of the user's other data.
You may do anything inside your databases, including destructive changes: every database keeps 30 days of history.
Before a risky change, call checkpoint; if it goes wrong, call restore. To experiment without touching a database, fork it first.
The user can open your databases with any Postgres client through \`trunk proxy\`.`;

const MAX_ROWS = 200;

const reply = async (run: () => Promise<unknown>): Promise<CallToolResult> => {
	try {
		return { content: [{ type: 'text', text: ops.toJson(await run()) }] };
	} catch (error) {
		return { isError: true, content: [{ type: 'text', text: ops.message(error) }] };
	}
};

// Large result sets would flood the agent's context; show the first rows and the total.
const summarize = (results: QueryResult[]) =>
	results.map(({ rows, fields, affectedRows }) => ({
		columns: fields.map((field) => field.name),
		rows: rows.slice(0, MAX_ROWS),
		rowCount: rows.length,
		...(rows.length > MAX_ROWS && { note: `Showing the first ${MAX_ROWS} rows; add a LIMIT or aggregate.` }),
		// PGlite reports a running total on SELECTs in multi-statement batches, so only show it for writes.
		...(!fields.length && affectedRows !== undefined && { affectedRows }),
	}));

const database = z.string().describe('Database name');
const readOnly = { readOnlyHint: true };

export const mcpHandler = createMcpHandler(({ authInfo }) => {
	// Set by the /mcp route after it verified the bearer token.
	const principal = authInfo?.extra?.principal as ops.Principal;
	const server = new McpServer({ name: 'trunk', version: '0.1.0' }, { instructions: INSTRUCTIONS });

	server.registerTool(
		'list_databases',
		{ description: 'List your databases.', inputSchema: z.object({}), annotations: readOnly },
		() => reply(() => ops.listDatabases(env, principal)),
	);

	server.registerTool(
		'create_database',
		{
			description: 'Create a new empty Postgres database that belongs to you.',
			inputSchema: z.object({ name: z.string().describe('1-63 lowercase letters, digits, "-" or "_"') }),
		},
		({ name }) => reply(() => ops.createDatabase(env, principal, name)),
	);

	server.registerTool(
		'query',
		{
			description:
				'Run SQL. Without params, the SQL may hold several statements separated by semicolons. With params, it must be one statement using $1, $2, …. Each call is its own session: put BEGIN and COMMIT in the same call.',
			inputSchema: z.object({ database, sql: z.string(), params: z.array(z.unknown()).optional() }),
		},
		({ database, sql, params }) => reply(async () => summarize(await ops.query(env, principal, database, sql, params))),
	);

	server.registerTool(
		'describe',
		{ description: 'List the tables and columns of a database.', inputSchema: z.object({ database }), annotations: readOnly },
		({ database }) => reply(() => ops.describe(env, principal, database)),
	);

	server.registerTool(
		'fork',
		{
			description: 'Copy a database into a new database you own, to experiment safely. Copies all data, so large databases take a moment.',
			inputSchema: z.object({ database, new_name: z.string().describe('Name for the copy') }),
		},
		({ database, new_name }) => reply(() => ops.fork(env, principal, database, new_name)),
	);

	server.registerTool(
		'checkpoint',
		{
			description: 'Save the current state of a database under a label, so you can restore it later.',
			inputSchema: z.object({ database, label: z.string().describe('e.g. before-migration') }),
		},
		({ database, label }) => reply(() => ops.checkpoint(env, principal, database, label)),
	);

	server.registerTool(
		'list_checkpoints',
		{ description: 'List the saved checkpoints of a database, newest first.', inputSchema: z.object({ database }), annotations: readOnly },
		({ database }) => reply(() => ops.listCheckpoints(env, principal, database)),
	);

	server.registerTool(
		'restore',
		{
			description:
				'Roll a database back to a checkpoint label, a time ago ("15m", "2h", "3d"), or an ISO timestamp within the last 30 days. Open connections are dropped. The result names a new checkpoint that undoes the restore.',
			inputSchema: z.object({ database, to: z.string() }),
			annotations: { destructiveHint: true },
		},
		({ database, to }) => reply(() => ops.restore(env, principal, database, to)),
	);

	return server;
});
