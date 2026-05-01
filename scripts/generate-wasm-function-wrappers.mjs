import { mkdirSync, writeFileSync } from 'node:fs';

const signatures = [
	'd',
	'i',
	'ii',
	'iid',
	'iii',
	'iiii',
	'iiiiiii',
	'iiijj',
	'iiip',
	'iij',
	'iijip',
	'iijji',
	'iijp',
	'iip',
	'iipi',
	'iipii',
	'iipiii',
	'iipip',
	'iipp',
	'iippi',
	'iippiii',
	'iippipp',
	'iippjp',
	'iippp',
	'iipppp',
	'ip',
	'ipi',
	'ipiiijpp',
	'ipip',
	'ipipipii',
	'ipj',
	'ipp',
	'ippiiij',
	'ippp',
	'ipppp',
	'jp',
	'p',
	'pp',
	'pppp',
	'v',
	'vi',
	'vjp',
	'vp',
	'vpi',
	'vppip',
	'vppp',
	'vpppp',
];

const typeCodes = { i: 0x7f, p: 0x7f, j: 0x7e, f: 0x7d, d: 0x7c, e: 0x6f };
const typeNames = { i: 'i32', p: 'i32', j: 'i64', f: 'f32', d: 'f64', e: 'externref' };

const uleb128Encode = (value, target) => {
	if (value < 128) {
		target.push(value);
		return;
	}

	target.push((value % 128) | 128, value >> 7);
};

const generateFuncType = (sig, target) => {
	const sigRet = sig.slice(0, 1);
	const sigParam = sig.slice(1);

	target.push(0x60);
	uleb128Encode(sigParam.length, target);

	for (const param of sigParam) {
		target.push(typeCodes[param]);
	}

	if (sigRet === 'v') {
		target.push(0);
	} else {
		target.push(1, typeCodes[sigRet]);
	}
};

const wrapperBytes = (sig) => {
	const typeSectionBody = [1];
	generateFuncType(sig, typeSectionBody);

	const bytes = [0, 97, 115, 109, 1, 0, 0, 0, 1];
	uleb128Encode(typeSectionBody.length, bytes);
	bytes.push(...typeSectionBody);
	bytes.push(2, 7, 1, 1, 101, 1, 102, 0, 0, 7, 5, 1, 1, 102, 0, 0);

	return Uint8Array.from(bytes);
};

const keyForSignature = (sig) => {
	const result = sig[0] === 'v' ? [] : [typeNames[sig[0]]];
	const parameters = [...sig.slice(1)].map((type) => typeNames[type]);
	return `${parameters.join(',')}->${result.join(',')}`;
};

const uniqueWrappers = new Map();
for (const sig of signatures) {
	const key = keyForSignature(sig);
	if (!uniqueWrappers.has(key)) {
		uniqueWrappers.set(key, sig);
	}
}

mkdirSync('src/wasm-function', { recursive: true });

const imports = [];
const entries = [];
for (const [key, sig] of uniqueWrappers) {
	const name = `wrapper_${sig}`;
	const file = `sig-${sig}.wasm`;
	writeFileSync(`src/wasm-function/${file}`, wrapperBytes(sig));
	imports.push(`import ${name} from './wasm-function/${file}';`);
	entries.push(`\t['${key}', ${name}],`);
}

writeFileSync(
	'src/wasm-function-wrappers.ts',
	`${imports.join('\n')}\n\nexport const wasmFunctionWrapperModules = new Map<string, WebAssembly.Module>([\n${entries.join('\n')}\n]);\n`,
);
