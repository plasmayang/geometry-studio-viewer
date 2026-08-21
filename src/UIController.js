import { Pane } from 'tweakpane';
import { AuditPanel } from './AuditPanel.js';

export class UIController {
    constructor(callbacks) {
        this.callbacks = callbacks;
        this.mode = callbacks.mode || 'directory';

        this.pane = new Pane({
            title: 'Geometry Studio',
            expanded: true,
        });

        // Profile picker only makes sense in directory mode.
        this.profileBinding = null;
        this.dataSourceBinding = null;
        if (this.mode === 'directory') {
            const profiles = callbacks.profiles || {};
            const activeProfileName = callbacks.activeProfileName
                || Object.keys(profiles)[0] || null;
            this.params = {
                profile: activeProfileName,
                dataSource: callbacks.dataSource,
                wireframe: false,
                showControlPolygon: true,
                showNormals: false,
                grid: true,
                color: '#4488ff',
            };
        } else {
            this.params = {
                wireframe: false,
                showControlPolygon: true,
                showNormals: false,
                grid: true,
                color: '#4488ff',
            };
        }

        this.init(callbacks);
    }

    init(callbacks) {
        const configFolder = this.pane.addFolder({
            title: 'Data Configuration',
            expanded: false
        });

        if (this.mode === 'directory') {
            const profiles = callbacks.profiles || {};
            const profileOptions = Object.entries(profiles).map(([k, v]) => ({
                text: `${k}${v.description ? '  ' + v.description : ''}`,
                value: k,
            }));
            if (profileOptions.length > 0) {
                this.profileBinding = configFolder.addBinding(this.params, 'profile', {
                    label: 'Profile',
                    options: profileOptions,
                }).on('change', (ev) => {
                    const next = profiles[ev.value];
                    if (!next) return;
                    this.params.dataSource = next.url_prefix;
                    if (this.dataSourceBinding) this.dataSourceBinding.refresh();
                    if (this.profileBinding) this.profileBinding.refresh();
                    callbacks.onProfileChange(ev.value, next);
                });
            }
            this.dataSourceBinding = configFolder.addBinding(this.params, 'dataSource', {
                label: 'Source Path'
            }).on('change', (ev) => callbacks.onSourceChange(ev.value));
            configFolder.addButton({
                title: 'Refresh Gallery',
            }).on('click', () => callbacks.onSourceChange(this.params.dataSource));
        } else {
            // protocol-mode: show server URL + connection state
            const server = callbacks.server || {};
            this.serverParams = { url: `ws://${server.host}:${server.port}${server.viewer_path}` };
            const urlBinding = configFolder.addBinding(this.serverParams, 'url', {
                label: 'Server URL',
                readonly: true,
            });
            this.connectionStatus = { connected: false };
            configFolder.addBinding(this.connectionStatus, 'connected', {
                label: 'Connected',
                readonly: true,
            });
            this.connectionStatusBinding = configFolder;
            this.urlBinding = urlBinding;
            this.connectionField = configFolder;
            if (callbacks.protocolSource) {
                const update = () => {
                    this.connectionStatus.connected = callbacks.protocolSource.isConnected();
                    this.connectionStatusBinding.refresh();
                };
                this._protocolStatusUpdate = update;
                update();
            }
        }

        this.surfaceFolder = this.pane.addFolder({
            title: 'Lofted Surface (3 modes)',
            expanded: true
        });

        this.curveFolder = this.pane.addFolder({
            title: 'Curves',
            expanded: false
        });

        const displayFolder = this.pane.addFolder({
            title: 'Visuals',
        });

        displayFolder.addBinding(this.params, 'wireframe', { label: 'Wireframe' })
            .on('change', (ev) => callbacks.onWireframeToggle(ev.value));

        displayFolder.addBinding(this.params, 'showControlPolygon', { label: 'Control Polygon' })
            .on('change', (ev) => callbacks.onControlPolygonToggle(ev.value));

        displayFolder.addBinding(this.params, 'showNormals', { label: 'Show Normals' })
            .on('change', (ev) => callbacks.onNormalsToggle(ev.value));

        displayFolder.addBinding(this.params, 'grid', { label: 'Show Grid' })
            .on('change', (ev) => callbacks.onGridToggle(ev.value));

        displayFolder.addBinding(this.params, 'color', { label: 'Mesh Color' })
            .on('change', (ev) => callbacks.onColorChange(ev.value));

        const actionsFolder = this.pane.addFolder({
            title: 'Actions',
        });

        actionsFolder.addButton({
            title: 'Reload Current',
        }).on('click', () => {
            callbacks.onReload();
        });
    }

    /**
     * Update the panel after the manifest has changed (e.g. profile
     * switch in directory mode, or new case pushed in protocol mode).
     * The actual case-list rendering is in src/main.js, which has
     * direct access to App state. UIController only re-syncs the
     * Tweakpane-side bindings (e.g. connection status).
     */
    updateManifest(manifest) {
        if (this.mode === 'protocol' && this._protocolStatusUpdate) {
            this._protocolStatusUpdate();
        }
    }

    updateSurfaceToggles(surfaces, onToggle) {
        // Clear existing surface bindings
        this.surfaceFolder.children.forEach(c => c.dispose());

        surfaces.forEach(label => {
            const params = { visible: true };
            this.surfaceFolder.addBinding(params, 'visible', {
                label: label
            }).on('change', (ev) => onToggle(label, ev.value));
        });
    }
    updateCurveToggles(curves, onToggle) {
        this.curveFolder.children.forEach(c => c.dispose());

        curves.forEach(label => {
            const params = { visible: true };
            this.curveFolder.addBinding(params, 'visible', {
                label: label
            }).on('change', (ev) => onToggle(label, ev.value));
        });
    }

    /**
     * Wire the v1.1 audit panel. If the case carries no
     * process_audit / intermediate_products, show a single-line
     * "v1.0 case — no audit data" placeholder so the reviewer knows
     * the absence is meaningful (older producer), not a bug.
     */
    updateAuditPanel(layerKeys, audit, onToggleLayer) {
        if (this.auditPanel) this.auditPanel.dispose();
        this.auditPanel = new AuditPanel({
            audit,
            onToggleLayer: (layerKey, visible) => onToggleLayer(layerKey, visible),
        });
    }
}