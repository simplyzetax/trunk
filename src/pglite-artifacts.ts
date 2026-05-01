import prepopulatedFs from '../node_modules/@electric-sql/pglite-prepopulatedfs/dist/prepopulatedfs.tgz';
import pgliteData from '../node_modules/@electric-sql/pglite/dist/pglite.data';
import pgliteWasmModule from '../node_modules/@electric-sql/pglite/dist/pglite.wasm';

import { installWasmFunctionPolyfill } from './wasm-function-polyfill';

export const pgliteArtifacts = {
	pgliteWasmModule,
	// This Worker always uses a prepopulated PGDATA or existing storage, so initdb
	// must never run. PGlite still checks this option to skip an internal URL
	// prefetch that Wrangler dev cannot resolve.
	initdbWasmModule: pgliteWasmModule,
	fsBundle: new Blob([pgliteData]),
};

export const pglitePrepopulatedDataDir = new Blob([prepopulatedFs]);

const installPgliteUrlFallback = () => {
	const maybeGlobal = globalThis as typeof globalThis & { URL: typeof URL; __pgliteUrlFallbackInstalled?: boolean };
	if (maybeGlobal.__pgliteUrlFallbackInstalled) {
		return;
	}

	const NativeURL = URL;
	maybeGlobal.URL = class PgliteURL extends NativeURL {
		constructor(url: string | URL, base?: string | URL) {
			try {
				super(url, base);
			} catch (error) {
				if (typeof url === 'string' && url.startsWith('../release/')) {
					super(url.replace('../release/', 'https://pglite.local/release/'));
					return;
				}
				if (typeof url === 'string' && ['pglite.wasm', 'initdb.wasm', 'pglite.data'].includes(url.replace(/^\.\//, ''))) {
					super(`https://pglite.local/release/${url.replace(/^\.\//, '')}`);
					return;
				}

				throw error;
			}
		}
	} as typeof URL;

	maybeGlobal.__pgliteUrlFallbackInstalled = true;
};

export const forcePgliteWorkerRuntime = () => {
	installWasmFunctionPolyfill();
	installPgliteUrlFallback();

	const maybeGlobal = globalThis as {
		process?: { type?: string };
		location?: { href?: string; pathname?: string };
		self?: { location?: { href?: string; pathname?: string } };
		window?: { encodeURIComponent?: typeof encodeURIComponent; location?: { href?: string; pathname?: string } };
	};

	if (maybeGlobal.process) {
		maybeGlobal.process.type = 'renderer';
	}

	maybeGlobal.location ??= { href: 'https://pglite.local/worker.js', pathname: '/worker.js' };
	maybeGlobal.location.href ??= 'https://pglite.local/worker.js';
	maybeGlobal.location.pathname ??= '/worker.js';

	const selfLike = maybeGlobal.self ?? (maybeGlobal.self = {});
	selfLike.location ??= maybeGlobal.location;
	selfLike.location.href ??= maybeGlobal.location.href;
	selfLike.location.pathname ??= maybeGlobal.location.pathname;

	const windowLike = maybeGlobal.window ?? (maybeGlobal.window = {});
	windowLike.location ??= maybeGlobal.location;
	windowLike.location.href ??= maybeGlobal.location.href;
	windowLike.location.pathname ??= maybeGlobal.location.pathname;
	windowLike.encodeURIComponent ??= encodeURIComponent;
};
