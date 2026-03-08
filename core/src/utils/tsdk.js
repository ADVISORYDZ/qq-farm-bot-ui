const fs = require('node:fs');
const path = require('node:path');

const { ensureDataDir, getResourcePath } = require('../config/runtime-paths');

const TSDK_BUNDLE_MODULE = 'tsdk/tsdk.js';
const APP_ID = '1112386029';
const DEVICE_INFO = {
    pixelRatio: 1,
    model: 'iPhone15,5',
    platform: 'ios',
    system: 'iOS 26.4',
    brand: 'Apple',
};
const MINI_PROGRAM_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile MicroMessenger';

let bundleSource = '';
let bundleModuleCache = new Map();
let tsdkInstance = null;
let tsdkInitPromise = null;
let resolvedWasmPath = '';

function getTsdkBundlePath() {
    return getResourcePath('assets', 'tsdk', 'tsdk.bundle.js');
}

function getTsdkWasmPath() {
    return getResourcePath('assets', 'tsdk', 'tsdk.wasm');
}

function isValidWasmFile(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) return false;
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size < 8) return false;
        const header = fs.readFileSync(filePath).subarray(0, 4);
        return header[0] === 0x00
            && header[1] === 0x61
            && header[2] === 0x73
            && header[3] === 0x6d;
    } catch {
        return false;
    }
}

function findTqapkgPath() {
    const searchRoots = [
        process.cwd(),
        path.resolve(process.cwd(), '..'),
        path.resolve(__dirname, '../../..'),
        path.resolve(__dirname, '../../../..'),
    ];

    for (const root of searchRoots) {
        try {
            const entries = fs.readdirSync(root, { withFileTypes: true });
            const match = entries.find((entry) => entry.isFile() && entry.name.endsWith('.tqapkg'));
            if (match) {
                return path.join(root, match.name);
            }
        } catch {}
    }

    return '';
}

function extractFileFromTqapkg(packagePath, entryName) {
    const buffer = fs.readFileSync(packagePath);
    if (buffer.length < 18 || buffer[0] !== 0xbe || buffer[13] !== 0xed) {
        throw new Error(`无效 tqapkg 头: ${packagePath}`);
    }

    const fileCount = buffer.readUInt32BE(14);
    let cursor = 18;
    for (let i = 0; i < fileCount; i++) {
        const nameLen = buffer.readUInt32BE(cursor);
        cursor += 4;

        const name = buffer.subarray(cursor, cursor + nameLen).toString('utf8');
        cursor += nameLen;

        const offset = buffer.readUInt32BE(cursor);
        cursor += 4;

        const size = buffer.readUInt32BE(cursor);
        cursor += 4;

        if (name === entryName) {
            return buffer.subarray(offset, offset + size);
        }
    }

    throw new Error(`tqapkg 中未找到资源: ${entryName}`);
}

function ensureTsdkWasmPath() {
    if (resolvedWasmPath && isValidWasmFile(resolvedWasmPath)) {
        return resolvedWasmPath;
    }

    const assetPath = getTsdkWasmPath();
    if (isValidWasmFile(assetPath)) {
        resolvedWasmPath = assetPath;
        return resolvedWasmPath;
    }

    const tqapkgPath = findTqapkgPath();
    if (!tqapkgPath) {
        throw new Error(`TSDK wasm 无效且未找到 tqapkg 兜底文件: ${assetPath}`);
    }

    const wasmBuffer = extractFileFromTqapkg(tqapkgPath, '/tsdk/tsdk.wasm');
    const targetPath = path.join(ensureDataDir(), 'tsdk', 'tsdk.wasm');
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, wasmBuffer);

    if (!isValidWasmFile(targetPath)) {
        throw new Error(`从 tqapkg 提取的 TSDK wasm 仍然无效: ${targetPath}`);
    }

    resolvedWasmPath = targetPath;
    return resolvedWasmPath;
}

function readTsdkBundleSource() {
    if (!bundleSource) {
        bundleSource = fs.readFileSync(getTsdkBundlePath(), 'utf8');
    }
    return bundleSource;
}

function getUserDataPath() {
    return ensureDataDir().replace(/\\/g, '/');
}

function resolveReadableFile(filePath) {
    const raw = String(filePath || '');
    const normalized = raw.replace(/\\/g, '/');
    const dataDir = ensureDataDir();
    const wasmPath = ensureTsdkWasmPath();
    const candidates = [
        raw,
        path.isAbsolute(raw) ? raw : path.join(dataDir, raw),
        path.join(dataDir, path.basename(normalized)),
        path.join(path.dirname(wasmPath), path.basename(normalized)),
        path.join(path.dirname(getTsdkBundlePath()), path.basename(normalized)),
    ].filter(Boolean);

    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                return candidate;
            }
        } catch {}
    }
    return null;
}

function moduleVariants(name) {
    return name.endsWith('.js') ? [name] : [name, `${name}.js`];
}

function extractDefineBody(name) {
    const source = readTsdkBundleSource();

    for (const variant of moduleVariants(name)) {
        const marker = `define("${variant}"`;
        const start = source.indexOf(marker);
        if (start < 0) continue;

        const factoryStart = source.indexOf('function(require, module, exports){', start);
        if (factoryStart < 0) continue;

        let cursor = source.indexOf('{', factoryStart);
        let depth = 0;
        let inSingle = false;
        let inDouble = false;
        let inTemplate = false;
        let escape = false;

        for (; cursor < source.length; cursor++) {
            const ch = source[cursor];
            if (escape) {
                escape = false;
                continue;
            }
            if (inSingle) {
                if (ch === '\\') escape = true;
                else if (ch === '\'') inSingle = false;
                continue;
            }
            if (inDouble) {
                if (ch === '\\') escape = true;
                else if (ch === '"') inDouble = false;
                continue;
            }
            if (inTemplate) {
                if (ch === '\\') escape = true;
                else if (ch === '`') inTemplate = false;
                continue;
            }
            if (ch === '\'') {
                inSingle = true;
                continue;
            }
            if (ch === '"') {
                inDouble = true;
                continue;
            }
            if (ch === '`') {
                inTemplate = true;
                continue;
            }
            if (ch === '{') {
                depth++;
            } else if (ch === '}') {
                depth--;
                if (depth === 0) {
                    cursor++;
                    break;
                }
            }
        }

        return source.slice(factoryStart, cursor);
    }

    throw new Error(`未找到 TSDK 模块: ${name}`);
}

function resolveModuleName(from, request) {
    if (!request.startsWith('.')) return request;
    return path.posix.normalize(path.posix.join(path.posix.dirname(from), request));
}

function requireFromBundle(name) {
    if (bundleModuleCache.has(name)) {
        return bundleModuleCache.get(name).exports;
    }

    const module = { exports: {} };
    bundleModuleCache.set(name, module);

    const factory = eval(`(${extractDefineBody(name)})`);
    factory((request) => {
        return requireFromBundle(resolveModuleName(name, request));
    }, module, module.exports);

    return module.exports;
}

function createMiniProgramGlobals() {
    const userDataPath = getUserDataPath();
    const wasmPath = ensureTsdkWasmPath();

    globalThis.window = globalThis;
    globalThis.global = globalThis;
    globalThis.GameGlobal = globalThis;
    globalThis.WeixinJSBridge = globalThis.WeixinJSBridge || {};

    if (!globalThis.navigator || typeof globalThis.navigator !== 'object') {
        globalThis.navigator = { userAgent: MINI_PROGRAM_USER_AGENT };
    } else if (!globalThis.navigator.userAgent || !String(globalThis.navigator.userAgent).includes('MicroMessenger')) {
        globalThis.navigator.userAgent = MINI_PROGRAM_USER_AGENT;
    }

    if (!globalThis.performance || typeof globalThis.performance.now !== 'function') {
        globalThis.performance = { now: () => Date.now() };
    }

    globalThis.WXWebAssembly = {
        CompileError: WebAssembly.CompileError,
        LinkError: WebAssembly.LinkError,
        Memory: WebAssembly.Memory,
        Module: WebAssembly.Module,
        RuntimeError: WebAssembly.RuntimeError,
        Table: WebAssembly.Table,
        instantiate(filePath, imports) {
            const normalized = String(filePath || '').replace(/\\/g, '/');
            const localPath = normalized.endsWith('.wasm')
                ? wasmPath
                : path.join(path.dirname(wasmPath), path.basename(normalized));
            return WebAssembly.instantiate(fs.readFileSync(localPath), imports);
        },
        async instantiateStreaming(source, imports) {
            if (typeof source === 'string') {
                return this.instantiate(source, imports);
            }
            const response = await source;
            if (response && typeof response.arrayBuffer === 'function') {
                const buffer = Buffer.from(await response.arrayBuffer());
                return WebAssembly.instantiate(buffer, imports);
            }
            throw new TypeError('不支持的 instantiateStreaming 输入');
        },
        validate(buffer) {
            return WebAssembly.validate(buffer);
        },
    };

    globalThis.wx = {
        env: { USER_DATA_PATH: userDataPath },
        getSystemInfoSync() {
            return { ...DEVICE_INFO };
        },
        getDeviceInfo() {
            return { ...DEVICE_INFO };
        },
        getAppBaseInfo() {
            return { enableDebug: false };
        },
        getAccountInfoSync() {
            return { miniProgram: { appId: APP_ID } };
        },
        onTouchStart() {},
        onTouchMove() {},
        onTouchEnd() {},
        onGyroscopeChange() {},
        startGyroscope() {
            return {};
        },
        getFileSystemManager() {
            return {
                readFileSync(filePath, encoding) {
                    const readable = resolveReadableFile(filePath);
                    if (!readable) {
                        return encoding ? '' : Buffer.alloc(0);
                    }
                    return fs.readFileSync(readable, encoding || null);
                },
                appendFileSync(filePath, data, encoding) {
                    const raw = String(filePath || '');
                    const target = path.isAbsolute(raw) ? raw : path.join(ensureDataDir(), raw);
                    fs.mkdirSync(path.dirname(target), { recursive: true });
                    fs.appendFileSync(target, data, encoding || undefined);
                },
                statSync(filePath) {
                    const readable = resolveReadableFile(filePath);
                    if (!readable) {
                        throw new Error(`文件不存在: ${filePath}`);
                    }
                    const stat = fs.statSync(readable);
                    return {
                        st_mode: stat.mode,
                        size: stat.size,
                        lastAccessedTime: Math.floor(stat.atimeMs),
                        lastModifiedTime: Math.floor(stat.mtimeMs),
                    };
                },
                writeFileSync(filePath, data, encoding) {
                    const raw = String(filePath || '');
                    const target = path.isAbsolute(raw) ? raw : path.join(ensureDataDir(), raw);
                    fs.mkdirSync(path.dirname(target), { recursive: true });
                    fs.writeFileSync(target, data, encoding || undefined);
                },
            };
        },
        request(options = {}) {
            const fail = typeof options.fail === 'function' ? options.fail : null;
            const complete = typeof options.complete === 'function' ? options.complete : null;
            setImmediate(() => {
                const error = new Error(`wx.request 未实现: ${options.url || ''}`);
                if (fail) fail(error);
                if (complete) complete({ errMsg: error.message });
            });
            return { abort() {} };
        },
    };
}

async function initTsdk() {
    if (tsdkInstance) return tsdkInstance;
    if (tsdkInitPromise) return tsdkInitPromise;

    tsdkInitPromise = (async () => {
        createMiniProgramGlobals();
        bundleModuleCache = new Map();
        const tsdkModule = requireFromBundle(TSDK_BUNDLE_MODULE);
        const instance = await tsdkModule.default({ wasmBinary: fs.readFileSync(ensureTsdkWasmPath()) });
        globalThis.tsdk = instance;
        instance._init_runtime(0, 0);
        tsdkInstance = instance;
        return instance;
    })().catch((error) => {
        tsdkInitPromise = null;
        tsdkInstance = null;
        throw error;
    });

    return tsdkInitPromise;
}

function isTsdkReady() {
    return !!tsdkInstance;
}

function getTsdk() {
    if (!tsdkInstance) {
        throw new Error('TSDK 尚未初始化');
    }
    return tsdkInstance;
}

function transformBuffer(methodName, input) {
    const tsdk = getTsdk();
    const source = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
    if (source.length === 0) return Buffer.alloc(0);

    const ptr = tsdk._create_buffer(source.length);
    try {
        tsdk.HEAPU8.set(source, ptr);
        tsdk[methodName](ptr, source.length);

        const outPtr = typeof tsdk._get_msg === 'function' ? Number(tsdk._get_msg()) : 0;
        const outLen = typeof tsdk._get_msg_len === 'function' ? Number(tsdk._get_msg_len()) : 0;
        if (Number.isInteger(outPtr) && Number.isInteger(outLen) && outPtr > 0 && outLen > 0 && outPtr + outLen <= tsdk.HEAPU8.length) {
            return Buffer.from(tsdk.HEAPU8.subarray(outPtr, outPtr + outLen));
        }

        return Buffer.from(tsdk.HEAPU8.subarray(ptr, ptr + source.length));
    } finally {
        tsdk._destroy_buffer(ptr);
    }
}

function encryptBuffer(input) {
    return transformBuffer('_encrypt_data', input);
}

function decryptBuffer(input) {
    return transformBuffer('_decrypt_data', input);
}

module.exports = {
    initTsdk,
    isTsdkReady,
    getTsdk,
    encryptBuffer,
    decryptBuffer,
};
