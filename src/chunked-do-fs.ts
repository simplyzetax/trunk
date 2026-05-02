import { BaseFilesystem, ERRNO_CODES, type FsStats } from '@electric-sql/pglite/basefs';

type DurableStorage = Pick<DurableObjectStorage, 'kv' | 'transactionSync'>;

type NodeType = 'directory' | 'file';

type BaseNode = {
	type: NodeType;
	mode: number;
	atime: number;
	mtime: number;
	ctime: number;
};

type DirectoryNode = BaseNode & {
	type: 'directory';
	children: Record<string, Node>;
};

type FileNode = BaseNode & {
	type: 'file';
	id: string;
	size: number;
};

type Node = DirectoryNode | FileNode;

type PersistedState = {
	version: 1;
	nextFileId: number;
	root: DirectoryNode;
};

export type ChunkedDurableObjectFSOptions = {
	chunkSize?: number;
	prefix?: string;
	debug?: boolean;
};

const DEFAULT_CHUNK_SIZE = 64 * 1024;
const TYPE_MASK = 0o170000;
const PERMISSION_MASK = 0o7777;
const DIRECTORY_TYPE = 0o040000;
const FILE_TYPE = 0o100000;
const DIR_MODE = DIRECTORY_TYPE | 0o777;
const FILE_MODE = FILE_TYPE | 0o666;
const BLOCK_SIZE = 4096;

export class ChunkedDurableObjectFS extends BaseFilesystem {
	readonly chunkSize: number;
	readonly prefix: string;

	#storage: DurableStorage;
	#state: PersistedState;
	#files = new Map<string, FileNode>();
	#openFiles = new Map<number, string>();
	#nextFd = 1;
	#chunks = new Map<string, Uint8Array>();
	#deletedChunks = new Set<string>();
	#openFileRefs = new Map<string, number>();
	#unlinkedOpenFiles = new Set<string>();
	#stateChunkCount = 0;
	#dirtyState = false;

	constructor(storage: DurableStorage, { chunkSize = DEFAULT_CHUNK_SIZE, prefix = 'pglite-fs:', debug = false }: ChunkedDurableObjectFSOptions = {}) {
		super(undefined, { debug });
		this.#storage = storage;
		this.chunkSize = chunkSize;
		this.prefix = prefix;
		this.#state = this.#loadState();
		this.#indexFiles();
	}

	async syncToFs(): Promise<void> {
		if (!this.#dirtyState && this.#deletedChunks.size === 0) {
			return;
		}

		this.#storage.transactionSync(() => {
			for (const key of this.#deletedChunks) {
				this.#storage.kv.delete(key);
			}

			if (this.#dirtyState) {
				this.#writeState();
			}
		});

		this.#dirtyState = false;
		this.#deletedChunks.clear();
	}

	chmod(path: string, mode: number): void {
		const node = this.#resolve(path);
		node.mode = this.#modeFor(node.type, mode);
		this.#touch(node, Date.now());
	}

	close(fd: number): void {
		const fileId = this.#openFiles.get(fd);
		if (!fileId) {
			throw new FsError('EBADF', 'Bad file descriptor');
		}

		this.#openFiles.delete(fd);
		this.#releaseFileRef(fileId);
	}

	fstat(fd: number): FsStats {
		return this.#stats(this.#fileFromFd(fd));
	}

	lstat(path: string): FsStats {
		return this.#stats(this.#resolve(path));
	}

	mkdir(path: string, options?: { recursive?: boolean; mode?: number }): void {
		const normalizedPath = this.#normalize(path);
		if (normalizedPath === '/') {
			return;
		}

		const parts = this.#pathParts(normalizedPath);
		const name = parts.pop();
		if (!name) {
			return;
		}

		const parent = this.#resolveParent(parts, options?.recursive);
		if (parent.children[name]) {
			throw new FsError('EEXIST', 'File exists');
		}

		const now = Date.now();
		parent.children[name] = {
			type: 'directory',
			mode: this.#modeFor('directory', options?.mode),
			atime: now,
			mtime: now,
			ctime: now,
			children: {},
		};
		this.#touch(parent, now);
	}

	open(path: string, flags?: string, mode?: number): number {
		let node: Node;
		let created = false;
		try {
			node = this.#resolve(path);
		} catch (error) {
			if (this.#isCreateFlag(flags)) {
				this.writeFile(path, new Uint8Array(), { mode });
				node = this.#resolve(path);
				created = true;
			} else {
				throw error;
			}
		}

		if (node.type !== 'file') {
			throw new FsError('EISDIR', 'Is a directory');
		}

		if (flags?.includes('x') && !created) {
			throw new FsError('EEXIST', 'File exists');
		}

		if (flags?.includes('w')) {
			this.truncate(path, 0);
		}

		const fd = this.#nextFd++;
		this.#openFiles.set(fd, node.id);
		this.#retainFileRef(node.id);
		return fd;
	}

	readdir(path: string): string[] {
		const node = this.#resolve(path);
		if (node.type !== 'directory') {
			throw new FsError('ENOTDIR', 'Not a directory');
		}

		return Object.keys(node.children);
	}

	read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number {
		const file = this.#fileFromFd(fd);
		if (position >= file.size || length === 0) {
			return 0;
		}

		const bytesToRead = Math.min(length, file.size - position);
		const target = this.#targetView(buffer, offset, bytesToRead);
		let bytesRead = 0;

		while (bytesRead < bytesToRead) {
			const absolutePosition = position + bytesRead;
			const chunkIndex = Math.floor(absolutePosition / this.chunkSize);
			const chunkOffset = absolutePosition % this.chunkSize;
			const chunk = this.#readChunk(file.id, chunkIndex);
			const readLength = Math.min(bytesToRead - bytesRead, this.chunkSize - chunkOffset);

			target.fill(0, bytesRead, bytesRead + readLength);
			if (chunk) {
				target.set(chunk.subarray(chunkOffset, chunkOffset + readLength), bytesRead);
			}
			bytesRead += readLength;
		}

		file.atime = Date.now();
		return bytesRead;
	}

	rename(oldPath: string, newPath: string): void {
		const normalizedOldPath = this.#normalize(oldPath);
		const normalizedNewPath = this.#normalize(newPath);
		if (normalizedOldPath === normalizedNewPath) {
			return;
		}

		const oldParts = this.#pathParts(oldPath);
		const oldName = oldParts.pop();
		if (!oldName) {
			throw new FsError('EINVAL', 'Invalid path');
		}

		const oldParent = this.#resolveParent(oldParts, false);
		const node = oldParent.children[oldName];
		if (!node) {
			throw new FsError('ENOENT', 'No such file or directory');
		}

		if (node.type === 'directory' && normalizedNewPath.startsWith(`${normalizedOldPath}/`)) {
			throw new FsError('EINVAL', 'Invalid path');
		}

		const newParts = this.#pathParts(newPath);
		const newName = newParts.pop();
		if (!newName) {
			throw new FsError('EINVAL', 'Invalid path');
		}

		const newParent = this.#resolveParent(newParts, false);
		const existing = newParent.children[newName];
		if (existing) {
			if (node.type === 'file' && existing.type === 'directory') {
				throw new FsError('EISDIR', 'Is a directory');
			}

			if (node.type === 'directory' && existing.type === 'file') {
				throw new FsError('ENOTDIR', 'Not a directory');
			}

			if (existing.type === 'directory' && Object.keys(existing.children).length > 0) {
				throw new FsError('ENOTEMPTY', 'Directory not empty');
			}

			this.#deleteNodeChunks(existing);
		}

		delete oldParent.children[oldName];
		newParent.children[newName] = node;
		const now = Date.now();
		this.#touch(oldParent, now);
		this.#touch(newParent, now);
		this.#dirtyState = true;
	}

	rmdir(path: string): void {
		const { parent, name, node } = this.#resolveChild(path);
		if (node.type !== 'directory') {
			throw new FsError('ENOTDIR', 'Not a directory');
		}

		if (Object.keys(node.children).length > 0) {
			throw new FsError('ENOTEMPTY', 'Directory not empty');
		}

		delete parent.children[name];
		this.#touch(parent, Date.now());
	}

	truncate(path: string, len = 0): void {
		const node = this.#resolve(path);
		if (node.type !== 'file') {
			throw new FsError('EISDIR', 'Is a directory');
		}

		this.#truncateFile(node, len);
	}

	unlink(path: string): void {
		const { parent, name, node } = this.#resolveChild(path);
		if (node.type !== 'file') {
			throw new FsError('EISDIR', 'Is a directory');
		}

		this.#deleteNodeChunks(node);
		delete parent.children[name];
		this.#touch(parent, Date.now());
	}

	utimes(path: string, atime: number, mtime: number): void {
		const node = this.#resolve(path);
		node.atime = atime;
		node.mtime = mtime;
		node.ctime = Date.now();
		this.#dirtyState = true;
	}

	writeFile(path: string, data: string | Uint8Array, options?: { encoding?: string; mode?: number; flag?: string }): void {
		const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
		const file = this.#ensureFile(path, options?.mode);
		this.#truncateFile(file, 0);
		this.#writeToFile(file, bytes, 0, bytes.length, 0);
	}

	write(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number {
		return this.#writeToFile(this.#fileFromFd(fd), buffer, offset, length, position);
	}

	#loadState(): PersistedState {
		const meta = this.#storage.kv.get<{ chunks: number }>(this.#stateMetaKey());
		if (meta) {
			this.#stateChunkCount = meta.chunks;
			const chunks: Uint8Array[] = [];
			let byteLength = 0;

			for (let index = 0; index < meta.chunks; index++) {
				const stored = this.#storage.kv.get<Uint8Array | ArrayBuffer>(this.#stateChunkKey(index));
				if (!stored) {
					throw new FsError('EINVAL', 'Filesystem metadata is incomplete');
				}

				const chunk = stored instanceof Uint8Array ? stored : new Uint8Array(stored);
				chunks.push(chunk);
				byteLength += chunk.byteLength;
			}

			const encoded = new Uint8Array(byteLength);
			let offset = 0;
			for (const chunk of chunks) {
				encoded.set(chunk, offset);
				offset += chunk.byteLength;
			}

			return JSON.parse(new TextDecoder().decode(encoded)) as PersistedState;
		}

		const legacyState = this.#storage.kv.get<PersistedState>(this.#legacyStateKey());
		if (legacyState) {
			this.#dirtyState = true;
			return structuredClone(legacyState);
		}

		const now = Date.now();
		return {
			version: 1,
			nextFileId: 1,
			root: {
				type: 'directory',
				mode: DIR_MODE,
				atime: now,
				mtime: now,
				ctime: now,
				children: {},
			},
		};
	}

	#writeState(): void {
		const encoded = new TextEncoder().encode(JSON.stringify(this.#state));
		const chunkCount = Math.ceil(encoded.byteLength / this.chunkSize);

		for (let index = 0; index < chunkCount; index++) {
			this.#storage.kv.put(this.#stateChunkKey(index), encoded.slice(index * this.chunkSize, (index + 1) * this.chunkSize));
		}

		for (let index = chunkCount; index < this.#stateChunkCount; index++) {
			this.#storage.kv.delete(this.#stateChunkKey(index));
		}

		this.#storage.kv.delete(this.#legacyStateKey());
		this.#storage.kv.put(this.#stateMetaKey(), { chunks: chunkCount });
		this.#stateChunkCount = chunkCount;
	}

	#indexFiles(): void {
		this.#files.clear();
		const walk = (node: Node) => {
			if (node.type === 'file') {
				this.#files.set(node.id, node);
				return;
			}

			for (const child of Object.values(node.children)) {
				walk(child);
			}
		};

		walk(this.#state.root);
	}

	#ensureFile(path: string, mode = FILE_MODE): FileNode {
		try {
			const node = this.#resolve(path);
			if (node.type !== 'file') {
				throw new FsError('EISDIR', 'Is a directory');
			}
			return node;
		} catch (error) {
			if (!(error instanceof FsError) || error.code !== ERRNO_CODES.ENOENT) {
				throw error;
			}
		}

		const parts = this.#pathParts(path);
		const name = parts.pop();
		if (!name) {
			throw new FsError('EINVAL', 'Invalid path');
		}

		const parent = this.#resolveParent(parts, false);
		const now = Date.now();
		const file: FileNode = {
			type: 'file',
			id: `file-${this.#state.nextFileId++}`,
			mode: this.#modeFor('file', mode),
			size: 0,
			atime: now,
			mtime: now,
			ctime: now,
		};

		parent.children[name] = file;
		this.#files.set(file.id, file);
		this.#touch(parent, now);
		return file;
	}

	#writeToFile(file: FileNode, buffer: Uint8Array, offset: number, length: number, position: number): number {
		if (length === 0) {
			return 0;
		}

		const source = this.#sourceView(buffer, offset, length);
		let bytesWritten = 0;

		while (bytesWritten < length) {
			const absolutePosition = position + bytesWritten;
			const chunkIndex = Math.floor(absolutePosition / this.chunkSize);
			const chunkOffset = absolutePosition % this.chunkSize;
			const writeLength = Math.min(length - bytesWritten, this.chunkSize - chunkOffset);
			const chunk = this.#getChunk(file.id, chunkIndex);

			chunk.set(source.subarray(bytesWritten, bytesWritten + writeLength), chunkOffset);
			this.#writeChunk(file.id, chunkIndex, chunk);
			bytesWritten += writeLength;
		}

		file.size = Math.max(file.size, position + bytesWritten);
		this.#touch(file, Date.now());
		return bytesWritten;
	}

	#truncateFile(file: FileNode, len: number): void {
		if (len < 0) {
			throw new FsError('EINVAL', 'Invalid length');
		}

		const previousLastChunk = file.size === 0 ? -1 : Math.floor((file.size - 1) / this.chunkSize);
		const nextLastChunk = len === 0 ? -1 : Math.floor((len - 1) / this.chunkSize);

		for (let chunkIndex = nextLastChunk + 1; chunkIndex <= previousLastChunk; chunkIndex++) {
			this.#deleteChunk(file.id, chunkIndex);
		}

		if (len > 0 && len < file.size) {
			const chunk = this.#getChunk(file.id, nextLastChunk);
			const keepBytes = len % this.chunkSize || this.chunkSize;
			chunk.fill(0, keepBytes);
			this.#writeChunk(file.id, nextLastChunk, chunk);
		}

		file.size = len;
		this.#touch(file, Date.now());
	}

	#deleteNodeChunks(node: Node): void {
		if (node.type === 'file') {
			const keepOpenHandle = (this.#openFileRefs.get(node.id) ?? 0) > 0;
			const lastChunk = node.size === 0 ? -1 : Math.floor((node.size - 1) / this.chunkSize);
			for (let chunkIndex = 0; chunkIndex <= lastChunk; chunkIndex++) {
				if (keepOpenHandle) {
					this.#getChunk(node.id, chunkIndex);
				}

				this.#deleteChunk(node.id, chunkIndex, keepOpenHandle);
			}

			if (keepOpenHandle) {
				this.#unlinkedOpenFiles.add(node.id);
			} else {
				this.#files.delete(node.id);
			}
			return;
		}

		for (const child of Object.values(node.children)) {
			this.#deleteNodeChunks(child);
		}
	}

	#deleteChunk(fileId: string, chunkIndex: number, keepCache = false): void {
		const key = this.#chunkKey(fileId, chunkIndex);
		if (!keepCache) {
			this.#chunks.delete(key);
		}
		this.#deletedChunks.add(key);
	}

	#readChunk(fileId: string, chunkIndex: number): Uint8Array | undefined {
		const key = this.#chunkKey(fileId, chunkIndex);
		const cached = this.#chunks.get(key);
		if (cached) {
			return cached;
		}
		if (this.#deletedChunks.has(key)) {
			return undefined;
		}

		const stored = this.#storage.kv.get<Uint8Array | ArrayBuffer>(key);
		if (!stored) {
			return undefined;
		}

		return stored instanceof Uint8Array ? stored : new Uint8Array(stored);
	}

	#getChunk(fileId: string, chunkIndex: number): Uint8Array {
		const key = this.#chunkKey(fileId, chunkIndex);
		const cached = this.#chunks.get(key);
		if (cached) {
			return cached;
		}

		const stored = this.#storage.kv.get<Uint8Array | ArrayBuffer>(key);
		const chunk = new Uint8Array(this.chunkSize);
		if (stored && !this.#deletedChunks.has(key)) {
			const source = stored instanceof Uint8Array ? stored : new Uint8Array(stored);
			chunk.set(source.subarray(0, this.chunkSize));
		}

		this.#chunks.set(key, chunk);
		return chunk;
	}

	#writeChunk(fileId: string, chunkIndex: number, chunk: Uint8Array): void {
		const key = this.#chunkKey(fileId, chunkIndex);
		if (this.#unlinkedOpenFiles.has(fileId)) {
			this.#chunks.set(key, chunk);
			this.#deletedChunks.add(key);
			return;
		}

		this.#persistChunk(fileId, chunkIndex, chunk);
		this.#chunks.delete(key);
	}

	#persistChunk(fileId: string, chunkIndex: number, chunk: Uint8Array): void {
		const key = this.#chunkKey(fileId, chunkIndex);
		this.#storage.kv.put(key, chunk.slice());
		this.#deletedChunks.delete(key);
	}

	#fileFromFd(fd: number): FileNode {
		const fileId = this.#openFiles.get(fd);
		const file = fileId ? this.#files.get(fileId) : undefined;
		if (!file) {
			throw new FsError('EBADF', 'Bad file descriptor');
		}

		return file;
	}

	#retainFileRef(fileId: string): void {
		this.#openFileRefs.set(fileId, (this.#openFileRefs.get(fileId) ?? 0) + 1);
	}

	#releaseFileRef(fileId: string): void {
		const count = (this.#openFileRefs.get(fileId) ?? 0) - 1;
		if (count > 0) {
			this.#openFileRefs.set(fileId, count);
			return;
		}

		this.#openFileRefs.delete(fileId);
		if (this.#unlinkedOpenFiles.delete(fileId)) {
			const file = this.#files.get(fileId);
			const lastChunk = !file || file.size === 0 ? -1 : Math.floor((file.size - 1) / this.chunkSize);
			for (let chunkIndex = 0; chunkIndex <= lastChunk; chunkIndex++) {
				this.#chunks.delete(this.#chunkKey(fileId, chunkIndex));
			}
			this.#files.delete(fileId);
		}
	}

	#resolve(path: string): Node {
		const parts = this.#pathParts(path);
		let node: Node = this.#state.root;

		for (const part of parts) {
			if (node.type !== 'directory') {
				throw new FsError('ENOTDIR', 'Not a directory');
			}

			const next: Node | undefined = node.children[part];
			if (!next) {
				throw new FsError('ENOENT', 'No such file or directory');
			}

			node = next;
		}

		return node;
	}

	#resolveChild(path: string): { parent: DirectoryNode; name: string; node: Node } {
		const parts = this.#pathParts(path);
		const name = parts.pop();
		if (!name) {
			throw new FsError('EINVAL', 'Invalid path');
		}

		const parent = this.#resolveParent(parts, false);
		const node = parent.children[name];
		if (!node) {
			throw new FsError('ENOENT', 'No such file or directory');
		}

		return { parent, name, node };
	}

	#resolveParent(parts: string[], create: boolean | undefined): DirectoryNode {
		let node = this.#state.root;

		for (const part of parts) {
			let next = node.children[part];
			if (!next) {
				if (!create) {
					throw new FsError('ENOENT', 'No such file or directory');
				}

				const now = Date.now();
				next = {
					type: 'directory',
					mode: DIR_MODE,
					atime: now,
					mtime: now,
					ctime: now,
					children: {},
				};
				node.children[part] = next;
				this.#touch(node, now);
			}

			if (next.type !== 'directory') {
				throw new FsError('ENOTDIR', 'Not a directory');
			}

			node = next;
		}

		return node;
	}

	#stats(node: Node): FsStats {
		const size = node.type === 'file' ? node.size : 0;
		return {
			dev: 0,
			ino: 0,
			mode: node.mode,
			nlink: 1,
			uid: 0,
			gid: 0,
			rdev: 0,
			size,
			blksize: BLOCK_SIZE,
			blocks: Math.ceil(size / BLOCK_SIZE),
			atime: node.atime,
			mtime: node.mtime,
			ctime: node.ctime,
		};
	}

	#touch(node: Node, time: number): void {
		node.mtime = time;
		node.ctime = time;
		this.#dirtyState = true;
	}

	#sourceView(buffer: ArrayBuffer | ArrayBufferView, offset: number, length: number): Uint8Array {
		if (buffer instanceof ArrayBuffer) {
			return new Uint8Array(buffer, offset, length);
		}

		return new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
	}

	#targetView(buffer: ArrayBuffer | ArrayBufferView, offset: number, length: number): Uint8Array {
		if (buffer instanceof ArrayBuffer) {
			return new Uint8Array(buffer, offset, length);
		}

		return new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
	}

	#isCreateFlag(flags?: string): boolean {
		return flags?.startsWith('w') || flags?.startsWith('a') || false;
	}

	#modeFor(type: NodeType, mode?: number): number {
		const nodeType = type === 'directory' ? DIRECTORY_TYPE : FILE_TYPE;
		const permissions = mode === undefined ? (type === 'directory' ? 0o777 : 0o666) : mode & PERMISSION_MASK;

		return nodeType | permissions;
	}

	#normalize(path: string): string {
		const normalized = `/${path}`.replace(/\/+/g, '/');
		return normalized.length > 1 ? normalized.replace(/\/$/, '') : normalized;
	}

	#pathParts(path: string): string[] {
		return this.#normalize(path).split('/').filter(Boolean);
	}

	#legacyStateKey(): string {
		return `${this.prefix}state`;
	}

	#stateMetaKey(): string {
		return `${this.prefix}state:meta`;
	}

	#stateChunkKey(index: number): string {
		return `${this.prefix}state:chunk:${index.toString().padStart(12, '0')}`;
	}

	#chunkKey(fileId: string, chunkIndex: number): string {
		return `${this.prefix}chunk:${fileId}:${chunkIndex.toString().padStart(12, '0')}`;
	}
}

class FsError extends Error {
	readonly code?: number;

	constructor(code: keyof typeof ERRNO_CODES, message: string) {
		super(message);
		this.code = ERRNO_CODES[code];
	}
}
