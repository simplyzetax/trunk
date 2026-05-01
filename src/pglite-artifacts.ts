import initdbWasmModule from '../node_modules/@electric-sql/pglite/dist/initdb.wasm';
import prepopulatedFs from '../node_modules/@electric-sql/pglite-prepopulatedfs/dist/prepopulatedfs.tgz';
import pgliteData from '../node_modules/@electric-sql/pglite/dist/pglite.data';
import pgliteWasmModule from '../node_modules/@electric-sql/pglite/dist/pglite.wasm';

import { installWasmFunctionPolyfill } from './wasm-function-polyfill';

export const pgliteArtifacts = {
	pgliteWasmModule,
	initdbWasmModule,
	fsBundle: new Blob([pgliteData]),
};

export const pglitePrepopulatedDataDir = new Blob([prepopulatedFs]);

export const forcePgliteWorkerRuntime = () => {
	installWasmFunctionPolyfill();

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
