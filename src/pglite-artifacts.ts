import initdbWasmModule from '../node_modules/@electric-sql/pglite/dist/initdb.wasm';
import pgliteData from '../node_modules/@electric-sql/pglite/dist/pglite.data';
import pgliteWasmModule from '../node_modules/@electric-sql/pglite/dist/pglite.wasm';

export const pgliteArtifacts = {
	pgliteWasmModule,
	initdbWasmModule,
	fsBundle: new Blob([pgliteData]),
};

export const forcePgliteWorkerRuntime = () => {
	const maybeGlobal = globalThis as {
		process?: { type?: string };
		self?: { location?: { href?: string } };
	};

	if (maybeGlobal.process) {
		maybeGlobal.process.type = 'renderer';
	}

	const selfLike = maybeGlobal.self ?? (maybeGlobal.self = {});
	selfLike.location ??= { href: 'https://pglite.local/' };
	selfLike.location.href ??= 'https://pglite.local/';
};
