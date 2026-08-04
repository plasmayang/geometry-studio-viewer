// ProtocolSource: browser-side WebSocket client for protocol mode.
//
// Connects to the viewer-config server at `${server.host}:${server.port}${viewer_path}`.
// Maintains an in-memory snapshot of all app sessions and their cases.
// Emits a callback when the snapshot changes (e.g. new case pushed,
// app reconnected).
//
// The viewer.config.json server block carries the host/port/paths.
// The protocol contract is enforced upstream by the producer; this
// client only trusts the wire format (`schema_version: "1.0"`,
// message types manifest/case/heartbeat/close). Malformed input is
// dropped and logged.

export class ProtocolSource {
    /**
     * @param {{host: string, port: number, viewer_path: string}} serverConfig
     * @param {(snapshot: Snapshot) => void} onChange
     */
    constructor(serverConfig, onChange) {
        this.config = serverConfig;
        this.onChange = onChange || (() => {});
        this.snapshot = { apps: [] };  // { apps: [{app_id, manifest, cases: [...]}, ...] }
        this.ws = null;
        this.connected = false;
        this.shouldRun = false;
    }

    _url() {
        const { host, port, viewer_path } = this.config;
        const path = viewer_path.startsWith('/') ? viewer_path : `/${viewer_path}`;
        return `ws://${host}:${port}${path}`;
    }

    start() {
        if (this.shouldRun) return;
        this.shouldRun = true;
        this._connect();
    }

    stop() {
        this.shouldRun = false;
        if (this.ws) {
            try { this.ws.close(); } catch (_) {}
            this.ws = null;
        }
        this.connected = false;
    }

    _connect() {
        const url = this._url();
        console.info(`[ProtocolSource] connecting to ${url}`);
        let ws;
        try {
            ws = new WebSocket(url);
        } catch (e) {
            console.error(`[ProtocolSource] failed to construct WebSocket:`, e);
            this._scheduleReconnect();
            return;
        }
        this.ws = ws;

        ws.addEventListener('open', () => {
            this.connected = true;
            console.info('[ProtocolSource] connected');
        });
        ws.addEventListener('message', (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch (e) {
                console.warn('[ProtocolSource] dropped malformed JSON');
                return;
            }
            this._handle(msg);
        });
        ws.addEventListener('close', () => {
            this.connected = false;
            this.ws = null;
            console.info('[ProtocolSource] disconnected');
            if (this.shouldRun) this._scheduleReconnect();
        });
        ws.addEventListener('error', (e) => {
            console.warn('[ProtocolSource] socket error:', e && e.message);
        });
    }

    _scheduleReconnect() {
        if (!this.shouldRun) return;
        setTimeout(() => this._connect(), 2000);
    }

    _handle(msg) {
        if (!msg || typeof msg !== 'object') return;

        // Server -> viewer side messages are a superset of protocol_v1.
        // The server also pushes { type: 'snapshot', payload: {...} }
        // on initial connect.
        if (msg.type === 'snapshot') {
            this.snapshot = msg.payload || { apps: [] };
            this.onChange(this.snapshot);
            return;
        }
        if (msg.type === 'manifest' || msg.type === 'case' || msg.type === 'heartbeat') {
            this._applyProtocolMessage(msg);
            this.onChange(this.snapshot);
            return;
        }
        if (msg.type === 'close') {
            this.snapshot = { apps: this.snapshot.apps.filter(a => a.app_id !== msg.app_id) };
            this.onChange(this.snapshot);
            return;
        }
        // Unknown type — ignore but don't drop the socket.
    }

    _applyProtocolMessage(msg) {
        const app_id = msg.app_id;
        if (!app_id) return;
        let app = this.snapshot.apps.find(a => a.app_id === app_id);
        if (!app) {
            app = { app_id, manifest: null, cases: [], last_seen: msg.ts || Date.now() };
            this.snapshot.apps.push(app);
        }
        if (msg.type === 'manifest') {
            app.manifest = msg.payload;
            app.cases = [];
        } else if (msg.type === 'case') {
            const idx = app.cases.findIndex(c => c.file === msg.payload.file);
            if (idx >= 0) app.cases[idx] = msg.payload;
            else app.cases.push(msg.payload);
        }
        app.last_seen = msg.ts || Date.now();
    }

    listApps() {
        return this.snapshot.apps.slice();
    }

    getCasesForApp(app_id) {
        const app = this.snapshot.apps.find(a => a.app_id === app_id);
        return app ? app.cases.slice() : [];
    }

    getManifestForApp(app_id) {
        const app = this.snapshot.apps.find(a => a.app_id === app_id);
        return app ? app.manifest : null;
    }

    isConnected() { return this.connected; }
}