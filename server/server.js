// kernel-gallery-viewer-server — WebSocket server.
//
// Runs only when viewer.config.json has mode = "protocol". Started
// either standalone (`node server.js`) or alongside the Vite dev server
// via concurrently (see viewer/package.json's "dev" script).
//
// Two WS endpoints on the same port:
//   - server.viewer_config.server.ingest_path : apps push data here
//   - server.viewer_config.server.viewer_path : browser viewer subscribes
//
// The server is intentionally simple: it does NOT validate the
// message envelope against the protocol_v1 contract. The contract is
// enforced by the producer (kernel-app CI runs the validator before
// publishing). At runtime the server trusts the producer and only
// sanitises inbound JSON by `JSON.parse` — malformed input fails
// closed.

// ---------- Bootstrap ---------------------------------------------------

import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load viewer.config.json. We deliberately re-implement the loader
// here to avoid pulling Node ESM imports from the viewer's config dir
// (the server may be shipped separately). The shape is intentionally
// trivial: just mode + server.

import fs from 'node:fs';
const cfg = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '..', 'viewer.config.json'), 'utf-8'));

if (cfg.mode !== 'protocol') {
    console.error(
        `[server] viewer.config.mode is ${JSON.stringify(cfg.mode)}; expected 'protocol'. ` +
        `Set mode=protocol in viewer.config.json before running this server.`);
    process.exit(1);
}
const s = cfg.server || {};
const HOST = s.host || '127.0.0.1';
const PORT = typeof s.port === 'number' ? s.port : 8090;
const INGEST_PATH = s.ingest_path || '/ingest';
const VIEWER_PATH = s.viewer_path || '/viewer';

// ---------- Session model ----------------------------------------------

// App connection: an app connected at /ingest. Single app_id per
// connection; if the app sends a manifest first, it becomes the
// session's manifest. Subsequent case messages add to the session.
class AppSession {
    constructor({ app_id, socket }) {
        this.app_id = app_id;
        this.socket = socket;
        this.manifest = null;     // {cases: [...]}
        this.cases = new Map();   // file -> {id, name, tags, case}
        this.lastSeen = Date.now();
    }
    ingest(msg) {
        this.lastSeen = Date.now();
        if (msg.type === 'manifest') {
            this.manifest = msg.payload;
            this.cases.clear();   // a fresh manifest replaces previous cases
        } else if (msg.type === 'case') {
            const p = msg.payload;
            this.cases.set(p.file, p);
        }
    }
}

class ServerState {
    constructor() {
        this.appSessions = new Map();   // app_id -> AppSession
        this.viewerClients = new Set(); // Set<WebSocket>
    }
    addApp(socket) {
        // Each ingest socket is bound to a single app_id learned from
        // the first message. We key it by a temporary id until the app
        // announces itself.
        const key = `pending:${this._nextId()}`;
        const s = new AppSession({ app_id: key, socket });
        this.appSessions.set(key, s);
        socket._session = s;
        return s;
    }
    promotePending(socket, app_id) {
        const old = socket._session;
        if (old && old.app_id.startsWith('pending:')) {
            this.appSessions.delete(old.app_id);
            old.app_id = app_id;
            this.appSessions.set(app_id, old);
        }
        return socket._session;
    }
    removeApp(socket) {
        const s = socket._session;
        if (s) this.appSessions.delete(s.app_id);
    }
    addViewer(socket) {
        this.viewerClients.add(socket);
    }
    removeViewer(socket) {
        this.viewerClients.delete(socket);
    }
    broadcast(msg) {
        const json = JSON.stringify(msg);
        for (const c of this.viewerClients) {
            if (c.readyState === 1 /* OPEN */) c.send(json);
        }
    }
    _nextId() {
        this._id = (this._id || 0) + 1;
        return this._id;
    }
    snapshot() {
        const apps = [];
        for (const [app_id, s] of this.appSessions) {
            apps.push({
                app_id,
                manifest: s.manifest,
                cases: Array.from(s.cases.values()),
                last_seen: s.lastSeen,
            });
        }
        return { apps };
    }
}

const state = new ServerState();

// ---------- HTTP + WS server --------------------------------------------

const http = createServer((req, res) => {
    if (req.url === '/health') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
            ok: true,
            mode: 'protocol',
            ingest_path: INGEST_PATH,
            viewer_path: VIEWER_PATH,
            apps: state.appSessions.size,
            viewers: state.viewerClients.size,
        }));
        return;
    }
    res.statusCode = 404;
    res.end('Not found');
});

const wss = new WebSocketServer({ noServer: true });

http.on('upgrade', (req, socket, head) => {
    // Optional ?app_id= query: lets the app pre-announce its id.
    // Otherwise the id is learned from the first manifest.
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === INGEST_PATH) {
        wss.handleUpgrade(req, socket, head, (ws) => {
            const session = state.addApp(ws);
            const appIdHint = url.searchParams.get('app_id');
            if (appIdHint) state.promotePending(ws, appIdHint);
            console.info(`[server] app connected (pending id=${session.app_id})`);
            attachAppHandlers(ws);
        });
    } else if (url.pathname === VIEWER_PATH) {
        wss.handleUpgrade(req, socket, head, (ws) => {
            state.addViewer(ws);
            console.info(`[server] viewer connected (total=${state.viewerClients.size})`);
            // Push current snapshot so the browser can render immediately.
            try {
                ws.send(JSON.stringify({ type: 'snapshot', payload: state.snapshot() }));
            } catch (e) { /* socket may already be closing */ }
            attachViewerHandlers(ws);
        });
    } else {
        socket.destroy();
    }
});

function attachAppHandlers(ws) {
    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch (e) {
            console.warn(`[server] app malformed JSON; dropping (${ws._session.app_id})`);
            return;
        }
        if (!msg || typeof msg !== 'object') return;
        const required = ['schema_version', 'type', 'app_id', 'ts', 'payload'];
        for (const k of required) {
            if (!(k in msg)) {
                console.warn(`[server] app ${ws._session.app_id} missing key ${JSON.stringify(k)}`);
                return;
            }
        }
        const session = ws._session;
        if (session.app_id.startsWith('pending:')) {
            state.promotePending(ws, msg.app_id);
        } else if (msg.app_id !== session.app_id) {
            // Same socket trying to switch app_id — reject.
            console.warn(`[server] app_id mismatch on socket: ${JSON.stringify(msg.app_id)} vs ${JSON.stringify(session.app_id)}`);
            return;
        }
        session.ingest(msg);
        state.broadcast(msg);
    });
    ws.on('close', () => {
        state.removeApp(ws);
        console.info(`[server] app disconnected (total=${state.appSessions.size})`);
    });
    ws.on('error', (err) => {
        console.warn(`[server] app socket error: ${err.message}`);
    });
}

function attachViewerHandlers(ws) {
    ws.on('close', () => {
        state.removeViewer(ws);
        console.info(`[server] viewer disconnected (total=${state.viewerClients.size})`);
    });
    ws.on('error', (err) => {
        console.warn(`[server] viewer socket error: ${err.message}`);
    });
}

http.listen(PORT, HOST, () => {
    console.info(
        `[server] protocol-mode viewer server listening on ` +
        `http://${HOST}:${PORT}\n` +
        `  ingest: ${INGEST_PATH}\n  viewer: ${VIEWER_PATH}\n` +
        `  Apps connect: ws://${HOST}:${PORT}${INGEST_PATH}?app_id=<id>\n` +
        `  Viewers connect: ws://${HOST}:${PORT}${VIEWER_PATH}`
    );
});