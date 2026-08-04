import { defineConfig } from 'vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
    loadViewerConfig,
    getDirectoryProfile,
    getRuntimeConfig,
} from './config/loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load full config once. The mode determines which data sources
// (none, or one per profile) are wired up below.
const cfg = loadViewerConfig();
const mode = cfg.mode;

// Path-traversal guard: resolved file must stay under DATA_ROOT.
function isUnderRoot(candidate, root) {
    const rel = path.relative(root, candidate);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Shared handler factory. Each profile gets one of these bound to its
// own (url_prefix, data_root) pair.
function makeDataBridge(profile) {
    return function dataBridge(req, res, next) {
        const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
        const target = path.normalize(path.join(profile.data_root, urlPath));

        if (!isUnderRoot(target, profile.data_root)) {
            res.statusCode = 403;
            res.end('Forbidden: path escapes data root');
            return;
        }

        fs.stat(target, (err, stat) => {
            if (err || !stat.isFile()) {
                res.statusCode = 404;
                res.end(`Not found: ${urlPath}`);
                return;
            }
            if (target.endsWith('.json')) {
                res.setHeader('Content-Type', 'application/json');
                // Disable caching so live gallery-test writes show up on reload.
                res.setHeader('Cache-Control', 'no-store');
            }
            fs.createReadStream(target).pipe(res);
        });
    };
}

export default defineConfig({
    server: {
        port: 3000,
        open: true,
        fs: {
            allow: mode === "directory"
                ? [
                    path.resolve(__dirname),
                    ...Object.values(cfg.profiles || {}).map(
                        p => path.resolve(process.cwd(), p.data_root)),
                  ]
                : [path.resolve(__dirname)]
        }
    },
    build: {
        outDir: 'dist'
    },
    // Expose the runtime config to the browser so src/main.js can
    // dispatch on mode. server-side fields (data_root) are stripped.
    define: {
        '__VIEWER_CONFIG__': JSON.stringify(getRuntimeConfig())
    },
    plugins: mode === "directory" ? [
        {
            name: 'kernel-data-bridge',
            configureServer(server) {
                const profile = getDirectoryProfile();
                if (!fs.existsSync(profile.data_root)) {
                    console.warn(
                        `[kernel-data-bridge] data_root does not exist: ${profile.data_root}\n` +
                        `  Run kernel-app Gallery or pick a different profile.`
                    );
                    return;
                }
                server.middlewares.use(profile.url_prefix, makeDataBridge(profile));
                console.info(
                    `[kernel-data-bridge] mode=directory ` +
                    `profile=${profile.name} ${profile.url_prefix} -> ${profile.data_root}`
                );
            }
        }
    ] : [
        {
            name: 'protocol-mode-noop',
            configureServer() {
                console.info(
                    '[viewer] mode=protocol: data sourced via WS server (see server/server.js).\n' +
                    '[viewer] browser will connect to the protocol server; no static data bridge.'
                );
            }
        }
    ]
});