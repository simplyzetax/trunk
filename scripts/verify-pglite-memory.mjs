import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [wasmPathArg, maxMemoryMbArg] = process.argv.slice(2);

if (!wasmPathArg || !maxMemoryMbArg) {
	console.error('Usage: node scripts/verify-pglite-memory.mjs <pglite.wasm> <max-memory-mb>');
	process.exit(1);
}

const wasmPath = resolve(wasmPathArg);
const maxMemoryMb = Number(maxMemoryMbArg);

if (!Number.isFinite(maxMemoryMb) || maxMemoryMb <= 0) {
	console.error(`Invalid max memory: ${maxMemoryMbArg}`);
	process.exit(1);
}

const wasm = readFileSync(wasmPath);
const module = await WebAssembly.compile(wasm);
const imports = WebAssembly.Module.imports(module);

const createImports = (pages) => {
	const importObject = {};

	for (const wasmImport of imports) {
		importObject[wasmImport.module] ??= {};

		if (wasmImport.kind === 'function') {
			importObject[wasmImport.module][wasmImport.name] = () => 0;
		}
	}

	importObject.env ??= {};
	importObject['GOT.mem'] ??= {};
	importObject.env.__memory_base = 0;
	importObject.env.__stack_pointer = new WebAssembly.Global({ value: 'i32', mutable: true }, 0);
	importObject.env.__table_base = 0;
	importObject['GOT.mem'].__heap_base = new WebAssembly.Global({ value: 'i32', mutable: true }, 0);
	importObject.env.__indirect_function_table = new WebAssembly.Table({ initial: 65_536, element: 'anyfunc' });
	importObject.env.memory = new WebAssembly.Memory({ initial: pages, maximum: 32_768 });

	return importObject;
};

const isMemoryImportTooSmall = (message) =>
	(message.includes('memory import has') && message.includes('smaller than the declared initial')) ||
	(message.includes("provided a 'size' that is smaller than") && message.includes("module's declared 'initial' import memory size"));

const canInstantiate = async (pages) => {
	try {
		await WebAssembly.instantiate(module, createImports(pages));
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (isMemoryImportTooSmall(message)) {
			return false;
		}

		throw error;
	}
};

let low = 0;
let high = 1;

while (!(await canInstantiate(high))) {
	high *= 2;
	if (high > 32_768) {
		throw new Error('Unable to find minimum WASM memory below 2GiB');
	}
}

while (high - low > 1) {
	const mid = Math.floor((low + high) / 2);
	if (await canInstantiate(mid)) {
		high = mid;
	} else {
		low = mid;
	}
}

const minPages = high;
const minBytes = minPages * 64 * 1024;
const minMb = minBytes / 1024 / 1024;

console.log(`PGlite WASM minimum memory: ${minPages} pages (${minMb} MiB)`);

if (minMb > maxMemoryMb) {
	console.error(`Expected minimum memory <= ${maxMemoryMb} MiB`);
	process.exit(1);
}
