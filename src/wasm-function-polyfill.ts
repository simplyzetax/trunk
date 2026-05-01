import i32I32ToI32 from './wasm-function/i32-i32-to-i32.wasm';
import i32ToI32 from './wasm-function/i32-to-i32.wasm';

type WasmValueType = 'i32' | 'i64' | 'f32' | 'f64' | 'externref';

type WasmFunctionType = {
	parameters: WasmValueType[];
	results: WasmValueType[];
};

const wrapperModules = new Map<string, WebAssembly.Module>([
	['i32->i32', i32ToI32],
	['i32,i32->i32', i32I32ToI32],
]);

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
		const wrapperModule = wrapperModules.get(key);

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
