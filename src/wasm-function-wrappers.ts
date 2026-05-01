import wrapper_d from './wasm-function/sig-d.wasm';
import wrapper_i from './wasm-function/sig-i.wasm';
import wrapper_ii from './wasm-function/sig-ii.wasm';
import wrapper_iid from './wasm-function/sig-iid.wasm';
import wrapper_iii from './wasm-function/sig-iii.wasm';
import wrapper_iiii from './wasm-function/sig-iiii.wasm';
import wrapper_iiiiiii from './wasm-function/sig-iiiiiii.wasm';
import wrapper_iiijj from './wasm-function/sig-iiijj.wasm';
import wrapper_iij from './wasm-function/sig-iij.wasm';
import wrapper_iijip from './wasm-function/sig-iijip.wasm';
import wrapper_iijji from './wasm-function/sig-iijji.wasm';
import wrapper_iijp from './wasm-function/sig-iijp.wasm';
import wrapper_iipii from './wasm-function/sig-iipii.wasm';
import wrapper_iipiii from './wasm-function/sig-iipiii.wasm';
import wrapper_iippjp from './wasm-function/sig-iippjp.wasm';
import wrapper_ipiiijpp from './wasm-function/sig-ipiiijpp.wasm';
import wrapper_ipipipii from './wasm-function/sig-ipipipii.wasm';
import wrapper_ippiiij from './wasm-function/sig-ippiiij.wasm';
import wrapper_jp from './wasm-function/sig-jp.wasm';
import wrapper_v from './wasm-function/sig-v.wasm';
import wrapper_vi from './wasm-function/sig-vi.wasm';
import wrapper_vjp from './wasm-function/sig-vjp.wasm';
import wrapper_vpi from './wasm-function/sig-vpi.wasm';
import wrapper_vppip from './wasm-function/sig-vppip.wasm';
import wrapper_vppp from './wasm-function/sig-vppp.wasm';

export const wasmFunctionWrapperModules = new Map<string, WebAssembly.Module>([
	['->f64', wrapper_d],
	['->i32', wrapper_i],
	['i32->i32', wrapper_ii],
	['i32,f64->i32', wrapper_iid],
	['i32,i32->i32', wrapper_iii],
	['i32,i32,i32->i32', wrapper_iiii],
	['i32,i32,i32,i32,i32,i32->i32', wrapper_iiiiiii],
	['i32,i32,i64,i64->i32', wrapper_iiijj],
	['i32,i64->i32', wrapper_iij],
	['i32,i64,i32,i32->i32', wrapper_iijip],
	['i32,i64,i64,i32->i32', wrapper_iijji],
	['i32,i64,i32->i32', wrapper_iijp],
	['i32,i32,i32,i32->i32', wrapper_iipii],
	['i32,i32,i32,i32,i32->i32', wrapper_iipiii],
	['i32,i32,i32,i64,i32->i32', wrapper_iippjp],
	['i32,i32,i32,i32,i64,i32,i32->i32', wrapper_ipiiijpp],
	['i32,i32,i32,i32,i32,i32,i32->i32', wrapper_ipipipii],
	['i32,i32,i32,i32,i32,i64->i32', wrapper_ippiiij],
	['i32->i64', wrapper_jp],
	['->', wrapper_v],
	['i32->', wrapper_vi],
	['i64,i32->', wrapper_vjp],
	['i32,i32->', wrapper_vpi],
	['i32,i32,i32,i32->', wrapper_vppip],
	['i32,i32,i32->', wrapper_vppp],
]);
