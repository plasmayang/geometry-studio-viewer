import { Viewer3D } from './Viewer3D.js';
import { GeometryParser } from './GeometryParser.js';
import { UIController } from './UIController.js';
import { ProtocolSource } from './data-sources/ProtocolSource.js';

// Runtime config injected at build time by vite.config.js. Vite's
// `define` option replaces the bare identifier with the JSON string
// literal, so we read it directly (NOT via window.__VIEWER_CONFIG__).
const VIEWER_CONFIG = typeof __VIEWER_CONFIG__ !== 'undefined' ? __VIEWER_CONFIG__ : {
    $schema_version: '1.0',
    mode: 'directory',
    profile: 'gallery-tests',
    profiles: {
        'gallery-tests': {
            description: 'Visualize kernel-app Gallery outputs via data directory.',
            url_prefix: '/kernel-data',
            manifest_path: 'manifest.json'
        }
    }
};

class App {
    constructor() {
        this.viewer = new Viewer3D();
        this.mode = VIEWER_CONFIG.mode || 'directory';
        this.manifest = [];                 // flat case list (mode-dependent shape)
        this.currentCase = null;            // mode-specific reference
        this.dataSourceBase = null;         // directory-mode only
        this.manifestPath = 'manifest.json';
        this.protocolSource = null;         // protocol-mode only
        this.caseNameFilter = '';           // user-typed case-name substring (CJK-safe)

        if (this.mode === 'protocol') {
            this.protocolSource = new ProtocolSource(
                VIEWER_CONFIG.server,
                (snapshot) => this._onProtocolUpdate(snapshot)
            );
        }
    }

    async init() {
        const container = document.getElementById('app');
        this.viewer.init(container);
        await this._initUI();
        if (this.mode === 'directory') {
            await this.refreshGallery();
        } else {
            this.protocolSource.start();
        }
    }

    // ---- UI init (shared) -------------------------------------------------

    async _initUI() {
        const baseCallbacks = {
            onWireframeToggle: (enabled) => this.viewer.setWireframe(enabled),
            onControlPolygonToggle: (enabled) => this.viewer.setControlPolygon(enabled),
            onNormalsToggle: (enabled) => this.viewer.showNormals(enabled),
            onGridToggle: (enabled) => this.viewer.setGrid(enabled),
            onColorChange: (color) => this.viewer.setMeshColor(color),
            onReload: () => this.loadData(),
        };
        if (this.mode === 'directory') {
            // directory-mode: existing UI
            const urlParams = new URLSearchParams(window.location.search);
            if (urlParams.has('data')) {
                this.dataSourceBase = urlParams.get('data');
            } else {
                const activeProfile = VIEWER_CONFIG.profile
                    || Object.keys(VIEWER_CONFIG.profiles || {})[0]
                    || null;
                const p = activeProfile ? VIEWER_CONFIG.profiles[activeProfile] : null;
                this.dataSourceBase = (p && p.url_prefix) || '/kernel-data';
                this.manifestPath = (p && p.manifest_path) || 'manifest.json';
            }
            this.ui = new UIController({
                mode: 'directory',
                manifest: this.manifest,
                dataSource: this.dataSourceBase,
                profiles: VIEWER_CONFIG.profiles,
                activeProfileName: VIEWER_CONFIG.profile,
                onCaseChange: (caseFile) => {
                    this.currentCase = { source: 'directory', file: caseFile };
                    this.loadData();
                },
                onProfileChange: (profileName, profile) => {
                    this.dataSourceBase = profile.url_prefix;
                    this.manifestPath = profile.manifest_path || 'manifest.json';
                    this.refreshGallery();
                },
                onSourceChange: (newPath) => {
                    this.dataSourceBase = newPath;
                    this.refreshGallery();
                },
                onSectionModeChange: (mode, visible) => {
                    if (this.viewer.surfaceGroups && this.viewer.surfaceGroups[mode]) {
                        this.viewer.surfaceGroups[mode].visible = visible;
                    }
                },
                ...baseCallbacks,
            });
        } else {
            // protocol-mode: protocol-panel UI
            this.ui = new UIController({
                mode: 'protocol',
                manifest: this.manifest,
                server: VIEWER_CONFIG.server,
                protocolSource: this.protocolSource,
                onCaseChange: (caseRef) => {
                    this.currentCase = { source: 'protocol', ...caseRef };
                    this.loadData();
                },
                ...baseCallbacks,
            });
        }
    }

    // ---- directory mode: refresh manifest from disk -------------------

    async refreshGallery() {
        try {
            const response = await fetch(`${this.dataSourceBase}/${this.manifestPath}`);
            if (!response.ok) throw new Error(
                `Manifest not found at ${this.dataSourceBase}/${this.manifestPath}. ` +
                `Set active profile or check that the gallery test has run.`);
            const rawManifest = await response.json();
            const items = Array.isArray(rawManifest)
                ? rawManifest
                : (Array.isArray(rawManifest?.cases) ? rawManifest.cases : []);
            this.manifest = items.map(it => ({ tags: [], ...it }));

            if (this.manifest.length > 0) {
                this.currentCase = { source: 'directory', file: this.manifest[0].file };
            }
            this._renderManifest();
            this._renderTagCloud();
            this._wireFilterInput();
            this._wireCaseNameFilter();
            if (this.ui) this.ui.updateManifest(this.manifest);
            if (this.currentCase) await this.loadData();
        } catch (error) {
            console.error('Initialization Error:', error);
            this.showError(error.message);
        }
    }

    // ---- protocol mode: WS-driven update --------------------------------

    _onProtocolUpdate(snapshot) {
        // Flatten the snapshot into a single case list for the UI.
        const items = [];
        for (const app of snapshot.apps) {
            for (const c of app.cases) {
                items.push({ ...c, app_id: app.app_id, tags: c.tags || [] });
            }
        }
        this.manifest = items;
        if (this.ui) this.ui.updateManifest(items);
        if (!this.currentCase && items.length > 0) {
            this.currentCase = { source: 'protocol', app_id: items[0].app_id, file: items[0].file };
            this.loadData();
        }
    }

    // ---- shared: render a case to 3D viewport ---------------------------

    async loadData() {
        if (this.mode === 'directory') {
            await this._loadDataDirectory();
        } else {
            await this._loadDataProtocol();
        }
    }

    async _loadDataDirectory() {
        if (!this.currentCase) return;
        try {
            const url = `${this.dataSourceBase}/${this.currentCase.file}`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Failed to fetch case: ${this.currentCase.file}`);
            const jsonData = await response.json();
            this._renderCaseIntoViewport(jsonData, this.currentCase.file);
        } catch (error) {
            console.error('Error loading directory data:', error);
        }
    }

    async _loadDataProtocol() {
        if (!this.currentCase) return;
        const app = this.protocolSource.snapshot.apps
            .find(a => a.app_id === this.currentCase.app_id);
        if (!app) return;
        const c = app.cases.find(x => x.file === this.currentCase.file);
        if (!c) return;
        // Case payload already carries the full case JSON (validated by
        // protocol_v1 contract). Render directly.
        this._renderCaseIntoViewport(c.case, c.file);
    }

    _renderCaseIntoViewport(jsonData, sourceLabel) {
        const isSTP = sourceLabel && (sourceLabel.toLowerCase().endsWith('.stp')
            || sourceLabel.toLowerCase().endsWith('.step'));
        if (isSTP) {
            return;
        }
        console.log('Case Loaded:', jsonData.caseName);

        document.getElementById('case-title').innerText = jsonData.caseName || jsonData.name || 'Untitled Case';

        let infoHtml = `<div style="margin-bottom: 10px; border-bottom: 1px solid #eee; padding-bottom: 5px;"><strong>Summary:</strong><br/>${jsonData.description || 'N/A'}</div>`;
        if (jsonData.tags) {
            infoHtml += `<div style="margin-bottom: 10px;"><strong>Tags:</strong><br/><span style="font-size: 11px;">${jsonData.tags.join(', ')}</span></div>`;
        }
        infoHtml += `<div style="margin-bottom: 10px;"><strong>Intent Space:</strong><br/><span style="font-family: monospace; font-size: 11px; white-space: pre-wrap;">${jsonData.intent_space || 'N/A'}</span></div>`;
        infoHtml += `<div><strong>Success Criteria:</strong><br/><span style="color: #2e7d32;">${jsonData.success_criteria || 'N/A'}</span></div>`;

        document.getElementById('case-description').innerHTML = infoHtml;

        const { geometry, markers, nurbs, audit } = GeometryParser.parseMesh(jsonData);
        const { surfaceLabels, curveLabels, auditLayers } =
            this.viewer.loadMesh(geometry, markers, nurbs, audit);

        if (this.ui) {
            this.ui.updateSurfaceToggles(surfaceLabels, (label, visible) => {
                this.viewer.setSurfaceVisibility(label, visible);
            });
            this.ui.updateCurveToggles(curveLabels, (label, visible) => {
                this.viewer.setCurveVisibility(label, visible);
            });
            this.ui.updateAuditPanel(auditLayers, audit, (layerKey, visible) => {
                this.viewer.setAuditLayer(layerKey, visible);
            });
        }
    }

    // ---- directory-only: tag cloud + case list + filter input --------

    _renderManifest() {
        // Render via UIController (mode=directory keeps the
        // legacy DOM rendering as a fallback / dev convenience).
        this.renderCaseList('');
    }

    _renderTagCloud() {
        this.renderTagCloud();
    }

    _wireFilterInput() {
        const input = document.getElementById('tag-filter');
        if (!input || input._wired) return;
        input._wired = true;
        input.addEventListener('input', (e) => {
            this.renderCaseList(e.target.value.toLowerCase());
            this.syncButtonsFromInput();
        });
    }

    /**
     * Wire the dedicated case-name search box. Combined with the tag
     * filter via AND inside renderCaseList — both must pass for a case
     * to appear.
     */
    _wireCaseNameFilter() {
        const input = document.getElementById('case-name-filter');
        const clearBtn = document.getElementById('case-name-filter-clear');
        if (!input || input._wired) return;
        input._wired = true;

        const apply = (value) => {
            this.caseNameFilter = value || '';
            this.renderCaseList(
                document.getElementById('tag-filter')?.value?.toLowerCase() || ''
            );
        };

        input.addEventListener('input', (e) => {
            apply(e.target.value);
        });

        if (clearBtn && !clearBtn._wired) {
            clearBtn._wired = true;
            clearBtn.addEventListener('click', () => {
                input.value = '';
                apply('');
                input.focus();
            });
        }
    }

    renderTagCloud() {
        const allTags = new Set();
        this.manifest.forEach(item => {
            if (item.tags) item.tags.forEach(t => allTags.add(t));
        });
        const tagCloud = document.getElementById('tag-cloud');
        if (!tagCloud) return;
        tagCloud.innerHTML = '';
        const sortedTags = Array.from(allTags).sort();
        sortedTags.forEach(tag => {
            const btn = document.createElement('button');
            btn.dataset.tag = tag;
            btn.innerText = tag;
            btn.dataset.state = '0';
            btn.style.border = '1px solid #ccc';
            btn.style.borderRadius = '12px';
            btn.style.padding = '3px 8px';
            btn.style.fontSize = '11px';
            btn.style.cursor = 'pointer';
            btn.style.backgroundColor = '#f0f0f0';
            btn.style.color = '#333';
            btn.style.transition = 'all 0.2s';
            btn.onclick = () => {
                let state = parseInt(btn.dataset.state);
                state = (state + 1) % 3;
                btn.dataset.state = state;
                this.updateFilterFromButtons();
            };
            tagCloud.appendChild(btn);
        });
        const countEl = document.getElementById('tag-cloud-count');
        if (countEl) countEl.textContent = String(sortedTags.length);
        this._wireTagCloudToggle();
        this.syncButtonsFromInput();
    }

    _wireTagCloudToggle() {
        const header = document.getElementById('tag-cloud-header');
        if (!header || header._wired) return;
        header._wired = true;
        header.addEventListener('click', () => this._toggleTagCloud());
    }

    _toggleTagCloud() {
        const tagCloud = document.getElementById('tag-cloud');
        const chevron = document.getElementById('tag-cloud-chevron');
        if (!tagCloud || !chevron) return;
        const expanded = tagCloud.style.display !== 'none';
        tagCloud.style.display = expanded ? 'none' : 'flex';
        chevron.style.transform = expanded ? 'rotate(0deg)' : 'rotate(90deg)';
    }

    updateFilterFromButtons() {
        const btns = document.querySelectorAll('#tag-cloud button');
        const input = document.getElementById('tag-filter');
        if (!input) return;
        const currentTerms = input.value.toLowerCase().split(/\s+/).filter(t => t.length > 0);
        const allTagsList = Array.from(btns).map(b => b.dataset.tag);
        let newTerms = currentTerms.filter(t => {
            const tCore = t.startsWith('-') ? t.substring(1) : t;
            return !allTagsList.includes(tCore);
        });
        btns.forEach(btn => {
            const state = parseInt(btn.dataset.state);
            const tag = btn.dataset.tag;
            if (state === 1) newTerms.push(tag);
            else if (state === 2) newTerms.push('-' + tag);
        });
        input.value = newTerms.join(' ');
        this.renderCaseList(input.value.toLowerCase());
        this.syncButtonsFromInput();
    }

    syncButtonsFromInput() {
        const input = document.getElementById('tag-filter');
        if (!input) return;
        const terms = input.value.toLowerCase().split(/\s+/).filter(t => t.length > 0);
        const btns = document.querySelectorAll('#tag-cloud button');
        btns.forEach(btn => {
            const tag = btn.dataset.tag;
            if (terms.includes(tag)) {
                btn.dataset.state = '1';
                btn.style.backgroundColor = '#1976d2';
                btn.style.color = 'white';
                btn.style.borderColor = '#1976d2';
            } else if (terms.includes('-' + tag)) {
                btn.dataset.state = '2';
                btn.style.backgroundColor = '#d32f2f';
                btn.style.color = 'white';
                btn.style.borderColor = '#d32f2f';
            } else {
                btn.dataset.state = '0';
                btn.style.backgroundColor = '#f0f0f0';
                btn.style.color = '#333';
                btn.style.borderColor = '#ccc';
            }
        });
    }

    renderCaseList(filterText) {
        const listDiv = document.getElementById('case-list');
        if (!listDiv) return;
        listDiv.innerHTML = '';
        const total = this.manifest.length;
        const countEl = document.getElementById('case-list-count');
        const totalEl = document.getElementById('case-list-total');
        const emptyEl = document.getElementById('case-name-filter-empty');
        const nameFilter = (this.caseNameFilter || '').toLowerCase().trim();
        const terms = filterText ? filterText.toLowerCase().split(/\s+/).filter(t => t.length > 0) : [];

        const passesName = (item) => {
            if (nameFilter.length === 0) return true;
            return (item.name || '').toLowerCase().includes(nameFilter);
        };

        const filtered = this.manifest.filter(item => {
            if (!passesName(item)) return false;
            if (terms.length === 0) return true;
            for (const term of terms) {
                if (term.startsWith('-')) {
                    const negTerm = term.substring(1);
                    if (negTerm.length === 0) continue;
                    const textMatch = item.name.toLowerCase().includes(negTerm);
                    const tagMatch = item.tags && item.tags.some(tag => tag.toLowerCase().includes(negTerm));
                    if (textMatch || tagMatch) return false;
                } else {
                    const textMatch = item.name.toLowerCase().includes(term);
                    const tagMatch = item.tags && item.tags.some(tag => tag.toLowerCase().includes(term));
                    if (!textMatch && !tagMatch) return false;
                }
            }
            return true;
        });

        if (countEl) countEl.textContent = String(filtered.length);
        if (totalEl) totalEl.textContent = String(total);
        if (emptyEl) emptyEl.style.display = filtered.length === 0 ? 'inline' : 'none';
        filtered.forEach(item => {
            const div = document.createElement('div');
            div.style.padding = '8px';
            div.style.marginBottom = '5px';
            div.style.backgroundColor = (this.currentCase && this.currentCase.file === item.file) ? '#e3f2fd' : '#fafafa';
            div.style.border = (this.currentCase && this.currentCase.file === item.file) ? '1px solid #90caf9' : '1px solid #ddd';
            div.style.borderRadius = '4px';
            div.style.cursor = 'pointer';
            let html = `<div style="font-weight: bold; font-size: 13px; color: #333;">${item.name}</div>`;
            if (this.mode === 'protocol' && item.app_id) {
                html += `<div style="font-size: 10px; color: #666; margin-top: 2px;">app: ${item.app_id}</div>`;
            }
            if (item.tags && item.tags.length > 0) {
                html += `<div style="margin-top: 5px; display: flex; flex-wrap: wrap; gap: 4px;">`;
                item.tags.forEach(tag => {
                    let color = '#757575';
                    const prefix = tag.split(':')[0];
                    if (prefix === 'profile') color = '#1976d2';
                    else if (prefix === 'shape')   color = '#0288d1';
                    else if (prefix === 'guide')   color = '#e65100';
                    else if (prefix === 'continuity') color = '#f57c00';
                    else if (prefix === 'scheme')  color = '#7b1fa2';
                    else if (prefix === 'compatibility') color = '#5e35b1';
                    else if (prefix === 'topology') color = '#d32f2f';
                    else if (prefix === 'feature') color = '#00897b';
                    html += `<span style="font-size: 10px; padding: 2px 6px; border-radius: 10px; background-color: ${color}; color: white;">${tag}</span>`;
                });
                html += `</div>`;
            }
            div.innerHTML = html;
            div.onclick = () => {
                if (this.currentCase && this.currentCase.file === item.file) return;
                const ref = { source: this.mode, file: item.file };
                if (this.mode === 'protocol') ref.app_id = item.app_id;
                this.currentCase = ref;
                this.renderCaseList(document.getElementById('tag-filter')?.value?.toLowerCase() || '');
                this.loadData();
            };
            listDiv.appendChild(div);
        });
    }

    showError(msg) {
        document.getElementById('case-title').innerText = 'Data Source Error';
        document.getElementById('case-description').innerText =
            msg + '\n\nTry providing a path relative to the server root (e.g. /src/mock/data_source)';

        if (!this.ui) {
            this.ui = new UIController({
                mode: this.mode,
                manifest: [],
                dataSource: this.dataSourceBase,
                server: VIEWER_CONFIG.server,
                protocolSource: this.protocolSource,
                onCaseChange: () => {},
                onProfileChange: () => {},
                onSourceChange: () => {}
            });
        }
    }
}

const app = new App();
app.init();