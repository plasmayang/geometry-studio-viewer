import { defineConfig } from 'vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getAllProfiles, getRuntimeConfig } from './config/loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// All configured profiles. The vite plugin registers one middleware
// per profile, so profile switching at runtime is just an URL change.
const profiles = getAllProfiles();
const runtimeConfig = getRuntimeConfig();

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
            allow: [
                path.resolve(__dirname),
                ...Object.values(profiles).map(p => p.data_root)
            ]
        }
    },
    build: {
        outDir: 'dist'
    },
    // Expose the runtime config to the browser so src/main.js can
    // default to the active profile and src/UIController.js can build
    // the profile picker. data_root is stripped; browser sees only
    // url_prefix + manifest_path + description.
    define: {
        '__VIEWER_CONFIG__': JSON.stringify(runtimeConfig)
    },
    plugins: [
        {
            name: 'kernel-data-bridge',
            configureServer(server) {
                console.info(`[kernel-data-bridge] registered ${Object.keys(profiles).length} profiles:`);
                for (const [name, p] of Object.entries(profiles)) {
                    if (!fs.existsSync(p.data_root)) {
                        console.warn(
                            `  [${name}] data_root does not exist: ${p.data_root}\n` +
                            `    Run kernel-app Gallery or pick a different profile.`
                        );
                        continue;
                    }
                    server.middlewares.use(p.url_prefix, makeDataBridge(p));
                    console.info(`  [${name}] ${p.url_prefix} -> ${p.data_root}`);
                }
            }
        }
    ]
});