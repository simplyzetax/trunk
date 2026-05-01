import { mkdirSync, writeFileSync } from 'node:fs';

const typeCodes = { i: 0x7f, p: 0x7f, j: 0x7e, f: 0x7d, d: 0x7c, e: 0x6f };

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

mkdirSync('src/wasm-function', { recursive: true });
writeFileSync('src/wasm-function/i32-to-i32.wasm', wrapperBytes('ii'));
writeFileSync('src/wasm-function/i32-i32-to-i32.wasm', wrapperBytes('iii'));
