// Postgres wire protocol helpers shared by the Durable Object and the local `trunk proxy`.

export const PROTOCOL_V3 = 196608;
export const SSL_REQUEST = 80877103;
export const GSSENC_REQUEST = 80877104;
export const CANCEL_REQUEST = 80877102;

// One message may not exceed this; the Durable Object only has 128 MB in total.
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const int32 = (bytes: Uint8Array, at: number) => new DataView(bytes.buffer, bytes.byteOffset + at, 4).getInt32(0);

export const concat = (...parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
};

/**
 * Splits complete messages off the front of `buf`. When `startup` is true the first message is
 * the untyped startup packet (length-prefixed, no type byte) that opens every connection.
 */
export function splitMessages(buf: Uint8Array, startup: boolean): { messages: Uint8Array[]; rest: Uint8Array } {
	const messages: Uint8Array[] = [];
	let at = 0;
	for (;;) {
		const typed = !(startup && messages.length === 0);
		const lengthAt = typed ? at + 1 : at;
		if (buf.length < lengthAt + 4) break;
		const length = int32(buf, lengthAt);
		if (length < 4 || length > MAX_MESSAGE_BYTES) throw new Error(`invalid message length ${length}`);
		const end = lengthAt + length;
		if (buf.length < end) break;
		messages.push(buf.subarray(at, end));
		at = end;
	}
	return { messages, rest: buf.subarray(at) };
}

export function startupParams(packet: Uint8Array): Record<string, string> {
	const parts = decoder.decode(packet.subarray(8)).split('\0');
	const params: Record<string, string> = {};
	for (let i = 0; i + 1 < parts.length && parts[i]; i += 2) params[parts[i]] = parts[i + 1];
	return params;
}

export const cstr = (text: string) => concat(encoder.encode(text), new Uint8Array([0]));

/** A typed protocol message: type byte, int32 length, body. */
export function message(type: string, ...parts: Uint8Array[]): Uint8Array {
	const body = concat(...parts);
	const out = new Uint8Array(5 + body.length);
	out[0] = type.charCodeAt(0);
	new DataView(out.buffer).setInt32(1, 4 + body.length);
	out.set(body, 5);
	return out;
}

export const SYNC = message('S');
export const simpleQuery = (sql: string) => message('Q', cstr(sql));
export const closeStatement = (name: string) => message('C', new Uint8Array([0x53]), cstr(name));
export const commandComplete = (tag: string) => message('C', cstr(tag));
export const readyForQuery = (status: string) => message('Z', encoder.encode(status));

/** A FATAL ErrorResponse, so clients like psql show our message instead of a bare disconnect. */
export const errorResponse = (text: string, code = '08006') => message('E', encoder.encode(`SFATAL\0VFATAL\0C${code}\0M${text}\0\0`));

/** Transaction status of a trailing ReadyForQuery: 'I' idle, 'T' in a transaction, 'E' failed transaction. */
export function readyStatus(tail: Uint8Array): string | null {
	const z = tail.length - 6;
	return z >= 0 && tail[z] === 0x5a && int32(tail, z + 1) === 5 ? String.fromCharCode(tail[z + 5]) : null;
}

export function cstring(msg: Uint8Array, at: number): string {
	const end = msg.indexOf(0, at);
	return end < 0 ? '' : decoder.decode(msg.subarray(at, end));
}

/**
 * Prefixes named prepared statements and portals with `prefix`. All clients of one database share a
 * single PGlite session, so pooled drivers that all prepare e.g. "s0" (Prisma, pgx, JDBC) would collide.
 */
export function namespaceMessage(msg: Uint8Array, prefix: string): Uint8Array {
	switch (msg[0]) {
		case 0x50: // Parse: statement
		case 0x45: // Execute: portal
			return prefixNames(msg, 5, 1, prefix);
		case 0x42: // Bind: portal, statement
			return prefixNames(msg, 5, 2, prefix);
		case 0x44: // Describe: kind byte, name
		case 0x43: // Close: kind byte, name
			return prefixNames(msg, 6, 1, prefix);
		default:
			return msg;
	}
}

function prefixNames(msg: Uint8Array, start: number, count: number, prefix: string): Uint8Array {
	const prefixBytes = encoder.encode(prefix);
	const parts = [msg.subarray(0, start)];
	let at = start;
	for (let i = 0; i < count; i++) {
		const end = msg.indexOf(0, at);
		if (end < 0) return msg; // malformed; let Postgres reject it
		if (end > at) parts.push(prefixBytes);
		parts.push(msg.subarray(at, end + 1));
		at = end + 1;
	}
	parts.push(msg.subarray(at));
	const out = concat(...parts);
	new DataView(out.buffer).setInt32(1, out.length - 1);
	return out;
}
