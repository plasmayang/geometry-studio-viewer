import { defineConfig } from 'vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default: gallery test data root (sibling of viewer/).
// Override at launch time: `KERNEL_VIEWER_DATA_ROOT=/some/path npm run dev`
const DEFAULT_DATA_ROOT = path.resolve(__dirname, '../kernel-app/data');
const DATA_ROOT = process.env.KERNEL_VIEWER_DATA_ROOT || DEFAULT_DATA_ROOT;
const DATA_URL_PREFIX = '/kernel-data';

// Path-traversal guard: resolved file must stay under DATA_ROOT.
function isUnderRoot(candidate, root) {
    const rel = path.relative(root, candidate);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export default defineConfig({
    server: {
        port: 3000,
        open: true,
        fs: {
            allow: [
                path.resolve(__dirname),
                DATA_ROOT
            ]
        }
    },
    build: {
        outDir: 'dist'
    },
    plugins: [
        {
            name: 'kernel-data-bridge',
            configureServer(server) {
                if (!fs.existsSync(DATA_ROOT)) {
                    console.warn(
                        `[kernel-data-bridge] data root does not exist: ${DATA_ROOT}\n` +
                        `  Set KERNEL_VIEWER_DATA_ROOT or create the directory.`
                    );
                    return;
                }

                server.middlewares.use(DATA_URL_PREFIX, (req, res, next) => {
                    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
                    const target = path.normalize(path.join(DATA_ROOT, urlPath));

                    if (!isUnderRoot(target, DATA_ROOT)) {
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
                });
            }
        }
    ]
});