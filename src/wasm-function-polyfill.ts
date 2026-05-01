import { wasmFunctionWrapperModules } from './wasm-function-wrappers';

type WasmValueType = 'i32' | 'i64' | 'f32' | 'f64' | 'externref';

type WasmFunctionType = {
	parameters: WasmValueType[];
	results: WasmValueType[];
};

const keyForType = (type: WasmFunctionType) => `${type.parameters.join(',')}->${type.results.join(',')}`;

export const installWasmFunctionPolyfill = () => {
	const wasm = WebAssembly as typeof WebAssembly & {
		Function?: new (type: WasmFunctionType, func: (...args: number[]) => number) => (...args: number[]) => number;
	};

	if (typeof wasm.Function === 'function') {
		return;
	}

	wasm.Function = (function WasmFunction(type: WasmFunctionType, func: (...args: number[]) => number) {
		const key = keyForType(type);
		const wrapperModule = wasmFunctionWrapperModules.get(key);

		if (!wrapperModule) {
			throw new Error(`Unsupported WebAssembly.Function signature: ${key}`);
		}

		const instance = new WebAssembly.Instance(wrapperModule, { e: { f: func } });
		const wrapped = instance.exports.f;

		if (typeof wrapped !== 'function') {
			throw new Error(`Invalid WebAssembly.Function wrapper for signature: ${key}`);
		}

		return wrapped as (...args: number[]) => number;
	} as unknown) as new (type: WasmFunctionType, func: (...args: number[]) => number) => (...args: number[]) => number;
};
