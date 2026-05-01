declare module '*.wasm' {
	const module: WebAssembly.Module;
	export default module;
}

declare module '*.data' {
	const data: ArrayBuffer;
	export default data;
}
