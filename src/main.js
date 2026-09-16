import { Viewer3D } from './Viewer3D.js';
import { GeometryParser } from './GeometryParser.js';
import { UIController } from './UIController.js';
import { ProtocolSource } from './data-sources/ProtocolSource.js';
import { TimelinePanel } from './TimelinePanel.js';
import './timeline.css';

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

function _resolveActiveProfileName() {
    if (typeof window === 'undefined') return VIEWER_CONFIG.profile;
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('profile');
    if (fromUrl && VIEWER_CONFIG.profiles && VIEWER_CONFIG.profiles[fromUrl]) {
        return fromUrl;
    }
    const path = (window.location.pathname || '').toLowerCase();
    if (path.includes('guide-binding')) return 'gluing-guide-to-profile';
    return VIEWER_CONFIG.profile;
}
const ACTIVE_PROFILE_NAME = _resolveActiveProfileName();

class App {
    constructor() {
        this.viewer = new Viewer3D();
        this.mode = VIEWER_CONFIG.mode || 'directory';
        this.manifest = [];
        this.currentCase = null;
        this.dataSourceBase = null;
        this.manifestPath = 'manifest.json';
        this.protocolSource = null;
        this.caseNameFilter = '';
        // 'scene' (Tab 1) | 'coupling' (Tab 2) | 'timeline' (Tab 3)
        this.activeTab = 'scene';
        // Tab-2 side-panel (Stage 1 toggles + diagnostics table)
        this.couplingPanel = null;
        // Tab-3 TimelinePanel (built lazily, recreated on case change)
        this.timelinePanel = null;
        // Persistent skeleton (Profiles/Spine/Guides) shared by Tab 2 + Tab 3;
        // rebuilt only on case change, survives panel swaps.
        this.couplingSceneGroup = null;
        this.currentCaseData = null;
        // Cached audit payload so Tab 2 can rebuild the AuditPanel
        // inside #coupling-container when the user enters the tab,
        // instead of mounting it on document.body at case load.
        this.currentAudit = null;
        this.currentAuditLayers = null;

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
        this._wireTabs();
        await this._initUI();
        if (this.mode === 'directory') {
            await this.refreshGallery();
        } else {
            this.protocolSource.start();
        }
    }

    // ---- tab strip (DOM, NOT Tweakpane) --------------------------------

    _wireTabs() {
        const tabs = document.querySelectorAll('.workspace-tab');
        if (tabs.length === 0) return;
        tabs.forEach(tab => {
            if (tab._wired) return;
            tab._wired = true;
            tab.addEventListener('click', () => {
                const next = tab.dataset.tab || 'scene';
                this._switchTab(next);
            });
        });
    }

    _switchTab(name) {
        if (name !== 'scene' && name !== 'coupling' && name !== 'timeline') return;
        this.activeTab = name;
        const tabs = document.querySelectorAll('.workspace-tab');
        tabs.forEach(t => {
            t.classList.toggle('active', (t.dataset.tab || '') === name);
        });
        const sceneContainer = document.getElementById('app');
        const couplingContainer = document.getElementById('coupling-container');
        const timelineContainer = document.getElementById('timeline-container');
        const infoPanel = document.getElementById('info-panel');
        const showScene = (name === 'scene');
        const showCoupling = (name === 'coupling');
        const showTimeline = (name === 'timeline');
        // Case-selector panel overlays the canvas on Tab 2/3; only keep it
        // visible on the 3D Scene tab.
        if (infoPanel) {
            infoPanel.style.display = showScene ? '' : 'none';
        }
        if (sceneContainer) {
            sceneContainer.style.display = showScene ? '' : 'none';
        }
        if (couplingContainer) {
            couplingContainer.style.display = showCoupling ? 'flex' : 'none';
        }
        if (timelineContainer) {
            timelineContainer.style.display = showTimeline ? 'flex' : 'none';
        }

        if (name === 'coupling') {
            // Order matters: layout must exist before reparenting so
            // #coupling-viewport is queryable.
            this._ensureCouplingPanel();
            this._enterCouplingView();
        } else {
            if (this.couplingPanel) {
                // Switching away from Tab 2 → dispose side-panel widgets
                // so they don't keep tracking state in the background.
                this.couplingPanel.dispose();
                this.couplingPanel = null;
            }
            if (this.ui && this.ui.auditPanel) {
                // AuditPanel was mounted inside #coupling-container for
                // Tab 2; dispose it on Tab 2 exit.
                this.ui.auditPanel.dispose();
                this.ui.auditPanel = null;
            }
            // Restore the canvas to the main #app container so the
            // shared viewer keeps rendering into its original host.
            this._detachCouplingViewport();
        }

        if (name === 'timeline') {
            this._ensureTimelinePanel();
            window.dispatchEvent(new Event('resize'));
        } else if (this.timelinePanel) {
            this.timelinePanel.dispose();
            this.timelinePanel = null;
        }
    }

    _enterCouplingView() {
        if (!this.viewer || !this.viewer.renderer) return;
        // Re-parent the renderer canvas into the Tab 2 viewport so the
        // shared viewer keeps drawing into the now-visible container.
        const couplingViewport = document.getElementById('coupling-viewport');
        if (couplingViewport && this.viewer.renderer.domElement
            && this.viewer.renderer.domElement.parentNode !== couplingViewport) {
            couplingViewport.appendChild(this.viewer.renderer.domElement);
            // Resize the renderer to fit the new container; the next
            // window.resize handler will keep it in sync thereafter.
            this.viewer.handleResize();
        }
        // Hide output surfaces — the coupling view shows only the
        // skeleton (Profiles / Spine / Guides) + Stage 1 overlays.
        this.viewer.hideSurfaces();
        // debug_markers layer can carry surface annotations; force it
        // OFF on Tab 2 entry so it can't override hideSurfaces().
        if (this.viewer.auditLayers && this.viewer.auditLayers.debug_markers) {
            this.viewer.auditLayers.debug_markers.visible = false;
        }
        // Stage 1 overlays default OFF on first entry; the user can
        // toggle them via the side panel.
        this.viewer.setStage1Visibility(false, false, false);
    }

    _detachCouplingViewport() {
        if (!this.viewer || !this.viewer.renderer) return;
        const sceneContainer = document.getElementById('app');
        if (sceneContainer && this.viewer.renderer.domElement
            && this.viewer.renderer.domElement.parentNode !== sceneContainer) {
            sceneContainer.appendChild(this.viewer.renderer.domElement);
            this.viewer.handleResize();
        }
    }

    _ensureCouplingPanel() {
        const container = document.getElementById('coupling-container');
        if (!container) return;
        if (!this.couplingPanel) {
            this.couplingPanel = this.ui ? this.ui.createCouplingPanel(container, {
                onSeamMarkersToggle: (v) => this.viewer.setSeamMarkersVisibility(v),
                onTangentArrowsToggle: (v) => this.viewer.setTangentArrowsVisibility(v),
                onRulingLinesToggle: (v) => this.viewer.setRulingLinesVisibility(v),
            }) : null;
        }
        if (this.couplingPanel && this.currentCaseData) {
            this.couplingPanel.refresh(this.currentCaseData);
        }
        // Build the AuditPanel inside #coupling-container so its
        // "Debug Viz Products (VxDb Markers & Failure Overlays)"
        // toggles ride along with Tab 2 visibility. The panel is
        // recreated on every case load so cached audit data is fresh.
        if (this.ui && this.currentAudit != null) {
            this.ui.updateAuditPanel(
                this.currentAuditLayers,
                this.currentAudit,
                (layerKey, visible) => this.viewer.setAuditLayer(layerKey, visible),
                container,
            );
        }
    }

    _ensureTimelinePanel() {
        const container = document.getElementById('timeline-container');
        if (!container) return;
        if (this.timelinePanel) {
            this.timelinePanel.update(this.currentCaseData);
            return;
        }
        // Worker A owns TimelinePanel signature; we pass the persistent
        // skeleton via options.spineGroup so Tab 3 doesn't re-parse the
        // entire NURBS payload on first entry.
        this.timelinePanel = new TimelinePanel(container, this.currentCaseData, {
            spineGroup: this.couplingSceneGroup,
            geometryParser: GeometryParser,
        });
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
                const activeProfile = ACTIVE_PROFILE_NAME
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
                activeProfileName: ACTIVE_PROFILE_NAME,
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
                onIntermediateToggle: (label, visible) => {
                    if (label === 'v_samples') this.viewer.setVSamplesVisibility(visible);
                    else if (label === 'v_sections') this.viewer.setVSectionsVisibility(visible);
                    else if (label === 'proxied_guides') this.viewer.setProxiedGuidesVisibility(visible);
                    else if (label === 'displacement_vectors') this.viewer.setDisplacementVectorsVisibility(visible);
                },
                onStage1Toggle: (kind, visible) => this._onStage1Toggle(kind, visible),
                onStage2Toggle: (kind, visible) => this._onStage2Toggle(kind, visible),
                onStage3Toggle: (kind, visible) => this._onStage3Toggle(kind, visible),
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
                onStage1Toggle: (kind, visible) => this._onStage1Toggle(kind, visible),
                onStage2Toggle: (kind, visible) => this._onStage2Toggle(kind, visible),
                onStage3Toggle: (kind, visible) => this._onStage3Toggle(kind, visible),
                ...baseCallbacks,
            });
        }
    }

    // ---- Stage 1/2/3 callback dispatchers ----------------------------

    _onStage1Toggle(kind, visible) {
        if (!this.viewer) return;
        if (kind === 'seam_markers') this.viewer.setSeamMarkersVisibility(visible);
        else if (kind === 'tangent_arrows') this.viewer.setTangentArrowsVisibility(visible);
        else if (kind === 'ruling_lines') this.viewer.setRulingLinesVisibility(visible);
    }

    _onStage2Toggle(kind, visible) {
        if (kind === 'basis_timeline_steps' && visible) {
            // Cross-tab signal: jump to Tab 2 when the reviewer ticks
            // the "Open Basis Timeline" checkbox. Toggling OFF does
            // nothing (Tab 2 stays where it is).
            this._switchTab('timeline');
        }
        // global_knots: future feature; toggle is inert for now.
    }

    _onStage3Toggle(kind, visible) {
        // Stub — placeholder for the cp-propagation §3.2 intermediate.
        // Currently the NominalManifold surface toggle lives under
        // Stage 4 (Section Modes), so this hook stays inert.
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

        // Case change → dispose any open Tab 2 / Tab 3 panels so they
        // don't keep stale state alive, and snap back to Tab 1 so the
        // reviewer sees a fresh main viewport first.
        if (this.timelinePanel) {
            this.timelinePanel.dispose();
            this.timelinePanel = null;
        }
        if (this.couplingPanel) {
            this.couplingPanel.dispose();
            this.couplingPanel = null;
        }
        if (this.ui && this.ui.auditPanel) {
            this.ui.auditPanel.dispose();
            this.ui.auditPanel = null;
        }
        if (this.activeTab !== 'scene') {
            this._switchTab('scene');
        }

        // Cache the full envelope so Tab 2 (U-Basis Timeline) can
        // re-render on demand without re-fetching the case JSON.
        this.currentCaseData = jsonData;

        document.getElementById('case-title').innerText = jsonData.caseName || jsonData.name || 'Untitled Case';

        const banner = document.getElementById('known-limitation-banner');
        if (banner) {
            const caseId = (jsonData.caseId || jsonData.id || sourceLabel || '');
            const tags = Array.isArray(jsonData.tags) ? jsonData.tags : [];
            const isGG012 = (caseId === 'TC_LOFT_GGTP_012') || tags.includes('scenario:gg-012');
            banner.classList.toggle('visible', isGG012);
        }

        let infoHtml = `<div style="margin-bottom: 10px; border-bottom: 1px solid #eee; padding-bottom: 5px;"><strong>Summary:</strong><br/>${jsonData.description || 'N/A'}</div>`;
        if (jsonData.tags) {
            infoHtml += `<div style="margin-bottom: 10px;"><strong>Tags:</strong><br/><span style="font-size: 11px;">${jsonData.tags.join(', ')}</span></div>`;
        }

        // INPUT echo — rendered side-by-side with the output report so the
        // reviewer can judge whether the spec-0004 binding is correct.
        if (jsonData.input && ACTIVE_PROFILE_NAME === 'gluing-guide-to-profile') {
            const inp = jsonData.input;
            infoHtml += `<details open style="margin-bottom: 10px;"><summary style="font-weight: 600; cursor: pointer; user-select: none;">Input (full)</summary><div style="margin-top: 4px; font-size: 11px;">`;
            if (inp.expected_metrics) {
                const em = inp.expected_metrics;
                infoHtml += `<div style="margin-bottom: 6px;"><strong>expected_metrics:</strong> `
                    + `<span style="font-family: monospace;">tolerance=${em.tolerance ?? '?'}`
                    + ` | guide_count=${em.guide_count ?? '?'}`
                    + ` | profile_zero_error_rows=[${(em.profile_zero_error_rows || []).join(', ')}]</span></div>`;
            }
            const profs = Array.isArray(inp.profiles) ? inp.profiles : [];
            if (profs.length > 0) {
                infoHtml += `<div style="margin-bottom: 4px;"><strong>Profiles (${profs.length}):</strong></div>`;
                profs.forEach(p => {
                    const cps = Array.isArray(p.control_points) ? p.control_points : [];
                    const cpStr = cps.map(cp => {
                        const arr = Array.isArray(cp) ? cp : [];
                        const w = arr.length >= 4 ? arr[3] : 1;
                        return `(${arr.slice(0, 3).map(v => +v.toFixed(3)).join(', ')}, w=${w})`;
                    }).join(' ');
                    const knots = Array.isArray(p.knots) ? p.knots : [];
                    infoHtml += `<div style="margin: 2px 0 6px 8px; font-family: monospace; font-size: 10px; color: #333;">`
                        + `<strong>${p.label || ('profile_' + p.index)}</strong> &nbsp; p=${p.p} &nbsp; knots=[${knots.map(k => +k.toFixed(2)).join(',')}] &nbsp; n_cp=${cps.length}`
                        + (p.is_periodic ? ' &nbsp; <em>periodic</em>' : '')
                        + `<br/>&nbsp;&nbsp;CPs: ${cpStr}</div>`;
                });
            }
            const gds = Array.isArray(inp.guides) ? inp.guides : [];
            if (gds.length > 0) {
                infoHtml += `<div style="margin-bottom: 4px;"><strong>Guides (${gds.length}):</strong></div>`;
                gds.forEach(g => {
                    const cps = Array.isArray(g.control_points) ? g.control_points : [];
                    const cpStr = cps.map(cp => {
                        const arr = Array.isArray(cp) ? cp : [];
                        return `(${arr.slice(0, 3).map(v => +v.toFixed(3)).join(', ')})`;
                    }).join(' → ');
                    infoHtml += `<div style="margin: 2px 0 6px 8px; font-family: monospace; font-size: 10px; color: #333;">`
                        + `<strong>${g.label || ('guide_' + g.index)}</strong> &nbsp; p=${g.p} &nbsp; n_cp=${cps.length}`
                        + `<br/>&nbsp;&nbsp;CPs: ${cpStr}</div>`;
                });
            }
            if (inp.spine) {
                const sp = inp.spine;
                const spcps = Array.isArray(sp.control_points) ? sp.control_points : [];
                const spcpStr = spcps.map(cp => {
                    const arr = Array.isArray(cp) ? cp : [];
                    return `(${arr.slice(0, 3).map(v => +v.toFixed(3)).join(', ')})`;
                }).join(' → ');
                infoHtml += `<div style="margin: 4px 0 6px 8px;"><strong>Spine (deg=${sp.p}, n_cp=${spcps.length}):</strong> ${spcpStr}</div>`;
            }
            infoHtml += `</div></details>`;
        }

        if (jsonData.guide_binding_report) {
            const r = jsonData.guide_binding_report;
            const mono = r.monotone_check || 'n/a';
            const monoColor = (mono === 'pass') ? '#2e7d32' : '#d32f2f';
            const segs = Array.isArray(r.degenerate_segments) ? r.degenerate_segments : [];
            const segRows = segs.map(s => {
                const uLo = (typeof s.u_lo === 'number') ? s.u_lo.toFixed(2) : '?';
                const uHi = (typeof s.u_hi === 'number') ? s.u_hi.toFixed(2) : '?';
                const touches = `${s.touches_u_min ? '↓' : ' '}${s.touches_u_max ? '↑' : ' '}`;
                return `<div style="font-family: monospace; font-size: 11px;">[${uLo}, ${uHi}] ${touches}</div>`;
            }).join('');
            const res = Array.isArray(r.guide_resolutions) ? r.guide_resolutions : [];
            const resRows = res.map(g => {
                const u = (typeof g.u_param === 'number') ? g.u_param.toFixed(3) : '?';
                const fixed = g.fixed ? 'fixed' : 'free';
                const seg = (g.segment_index !== undefined) ? `seg=${g.segment_index}` : '';
                const tag = (g.guide_id !== undefined) ? g.guide_id : `#${g.guide_index ?? '?'}`;
                const color = g.fixed ? '#d32f2f' : '#1976d2';
                return `<div style="font-family: monospace; font-size: 11px; color: ${color};">${tag}  u=${u}  ${fixed}  ${seg}</div>`;
            }).join('');
            infoHtml += `<div style="margin-bottom: 10px;"><strong>Guide Binding Report:</strong>`
                + `<div style="font-size: 11px;">monotone: <span style="color: ${monoColor};">${mono}</span>`
                + ` | guides: ${r.guide_count ?? res.length}</div>`
                + (segRows ? `<div style="margin-top: 4px;"><strong>Degenerate segments:</strong>${segRows}</div>` : '')
                + (resRows ? `<div style="margin-top: 4px;"><strong>Resolutions:</strong>${resRows}</div>` : '')
                + `</div>`;
        }
        infoHtml += `<div style="margin-bottom: 10px;"><strong>Intent Space:</strong><br/><span style="font-family: monospace; font-size: 11px; white-space: pre-wrap;">${jsonData.intent_space || 'N/A'}</span></div>`;
        infoHtml += `<div><strong>Success Criteria:</strong><br/><span style="color: #2e7d32;">${jsonData.success_criteria || 'N/A'}</span></div>`;

        document.getElementById('case-description').innerHTML = infoHtml;

        // Spec 0004 envelopes (e2e-gluing-guide-to-profile) carry a
        // `guide_binding_report` field. Route those through the
        // dedicated renderer; everything else goes through the
        // generic v1.0 path.
        if (jsonData.guide_binding_report && ACTIVE_PROFILE_NAME === 'gluing-guide-to-profile') {
            const parsed = GeometryParser.parseGuideBinding(jsonData);
            const { surfaceLabels, curveLabels, auditLayers, guideBindingLayers } =
                this.viewer.loadGuideBinding(parsed);
            if (this.ui) {
                this.ui.updateGuideBindingPanel(
                    { surfaceLabels, curveLabels, guideBindingLayers, audit: parsed.audit },
                    {
                        onSurfaceToggle: (label, visible) => this.viewer.setSurfaceVisibility(label, visible),
                        onCurveToggle: (label, visible) => this.viewer.setCurveVisibility(label, visible),
                        onGuideBindingToggle: (layerKey, visible) => this.viewer.setGuideBindingLayer(layerKey, visible),
                        onAuditToggle: (layerKey, visible) => this.viewer.setAuditLayer(layerKey, visible),
                    }
                );
            }
            return;
        }

        const { geometry, markers, nurbs, audit, movingFrame, samplingPlane, debug } = GeometryParser.parseMesh(jsonData);
        // spec 0002: bundle aux-viz arrays; loadMesh builds the
        // groups AFTER bbox is known (scale = 0.1 × bbox_diagonal).
        const extras = { movingFrame, samplingPlane };
        const { surfaceLabels, curveLabels, auditLayers } =
            this.viewer.loadMesh(geometry, markers, nurbs, audit, extras);

        // Extract the persistent skeleton (Profiles + Spine + Guides) so
        // Tab 2 (coupling) and Tab 3 (timeline) can share a stable
        // reference without re-parsing the NURBS payload.
        this.couplingSceneGroup = this.viewer.getPersistentSkeletonGroup();

        // loadMesh built a fresh mesh (visible=true by default); re-apply
        // Tab 2's surface-hide so a case change while on Tab 2 stays clean.
        if (this.activeTab === 'coupling') this.viewer.hideSurfaces();

        // Stage-1 (Profile Coupling) debug overlays — populate the
        // three Groups (seam markers / tangent arrows / ruling lines)
        // from case.debug.stage1_coupling when present. The renderer
        // handles missing input as a no-op + console.info.
        this.viewer.setCouplingDebug(debug ? debug.stage1_coupling : null);
        // Reset Stage-1 + Stage-2 checkboxes on every case change so a
        // reviewer can't be left looking at seam markers from a
        // previous case that the current case doesn't actually carry.
        // Stage 1 toggles now live on Tab 2's coupling panel; Stage 2
        // toggles stay on Tab 1's panel.
        if (this.ui) {
            if (this.couplingPanel && typeof this.couplingPanel.resetStage1Toggles === 'function') {
                this.couplingPanel.resetStage1Toggles();
            }
            if (typeof this.ui.resetStage2Toggles === 'function') this.ui.resetStage2Toggles();
        }

        if (this.ui) {
            // spec 0002: cache envelope BEFORE updateCurveToggles so
            // _buildInputGeometryBucket can detect moving_frame /
            // sampling_plane and inject spine-auxViz siblings.
            this.ui.setEnvelope(jsonData);
            this.ui.updateSurfaceToggles(surfaceLabels, (label, visible) => {
                this.viewer.setSurfaceVisibility(label, visible);
            });
            this.ui.updateCurveToggles(curveLabels, (label, visible) => {
                this.viewer.setCurveVisibility(label, visible);
            });
            this.currentAudit = audit;
            this.currentAuditLayers = auditLayers;
            // AuditPanel is now built lazily inside _ensureCouplingPanel
            // (Tab 2 only), so it follows the tab's container visibility
            // rather than floating on document.body across all tabs.
            if (this.couplingPanel) {
                this.couplingPanel.refresh(this.currentCaseData);
            }
            // Intermediate Geometry (v-samples / v-sections / proxied-guides):
            // only wire when the case actually carries the corresponding
            // data. When absent the folder's checkbox stays inert (no-op
            // toggle).
            const vSamplesData = Array.isArray(nurbs?.vSamples) ? nurbs.vSamples : [];
            const vSectionsData = Array.isArray(nurbs?.vSections) ? nurbs.vSections : [];
            const proxiedGuidesData = Array.isArray(nurbs?.proxiedGuides) ? nurbs.proxiedGuides : [];
            if (vSamplesData.length > 0 || vSectionsData.length > 0 || proxiedGuidesData.length > 0) {
                this.ui.updateIntermediateGeometry((label, visible) => {
                    if (label === 'v_samples') this.viewer.setVSamplesVisibility(visible);
                    else if (label === 'v_sections') this.viewer.setVSectionsVisibility(visible);
                    else if (label === 'proxied_guides') this.viewer.setProxiedGuidesVisibility(visible);
                    else if (label === 'displacement_vectors') this.viewer.setDisplacementVectorsVisibility(visible);
                });
            }
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
if (typeof window !== 'undefined') {
    window.__viewerApp = app;
    import('three').then(m => { window.__THREE_FOR_DEBUG__ = m; });
}