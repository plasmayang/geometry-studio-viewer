import { Pane } from 'tweakpane';
import { AuditPanel } from './AuditPanel.js';

export class UIController {
    constructor(callbacks) {
        this.callbacks = callbacks;
        this.mode = callbacks.mode || 'directory';

        // Tweakpane defaults to document.body; explicit #app container keeps
        // it visible only when the 3D Scene tab is active.
        const tab1Container = (typeof document !== 'undefined')
            ? document.getElementById('app') : null;
        this.pane = new Pane({
            title: 'Geometry Studio',
            expanded: true,
            container: tab1Container,
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

        // ----------------------------------------------------------------
        // Pipeline stage folders (Stages 0-4). The previous flat layout
        // (Output Surfaces / Intermediate Geometry / Input Geometries /
        // Visuals) is reorganized into stage-keyed folders so a reviewer
        // can walk the kernel pipeline top-down: raw inputs → coupling
        // → basis → theoretical → output.
        // ----------------------------------------------------------------

        // Stage 0: Inputs. Profile / spine / guide visibility toggles are
        // populated per-case (see updateCurveToggles). Global mesh
        // display toggles (wireframe / control polygon / grid / color /
        // normals) live here too — they're inputs to how the geometry
        // is *presented*, regardless of which stage produced it.
        this.stage0InputsFolder = this.pane.addFolder({
            title: 'Stage 0: Inputs',
            expanded: true,
        });
        this.surfaceFolder = this.stage0InputsFolder.addFolder({
            title: 'Profiles & Guides',
            expanded: true,
        });
        this.curveFolder = this.stage0InputsFolder.addFolder({
            title: 'Curves',
            expanded: false,
        });
        this.stage0VisualsFolder = this.stage0InputsFolder.addFolder({
            title: 'Display',
            expanded: false,
        });
        this.stage0VisualsFolder.addBinding(this.params, 'wireframe', { label: 'Wireframe' })
            .on('change', (ev) => callbacks.onWireframeToggle(ev.value));
        this.stage0VisualsFolder.addBinding(this.params, 'showControlPolygon', { label: 'Control Polygon' })
            .on('change', (ev) => callbacks.onControlPolygonToggle(ev.value));
        this.stage0VisualsFolder.addBinding(this.params, 'showNormals', { label: 'Show Normals' })
            .on('change', (ev) => callbacks.onNormalsToggle(ev.value));
        this.stage0VisualsFolder.addBinding(this.params, 'grid', { label: 'Show Grid' })
            .on('change', (ev) => callbacks.onGridToggle(ev.value));
        this.stage0VisualsFolder.addBinding(this.params, 'color', { label: 'Mesh Color' })
            .on('change', (ev) => callbacks.onColorChange(ev.value));

        // Stage 1: Profile Coupling. The seam-marker / tangent-arrow /
        // ruling-line toggles have moved to the dedicated Tab 2 side
        // panel (see createCouplingPanel). Tab 1 keeps the folder as a
        // breadcrumb so the stage numbering still reads top-down.
        this.stage1Folder = this.pane.addFolder({
            title: 'Stage 1: Profile Coupling (see Tab 2)',
            expanded: false,
        });
        this.stage1Params = null;

        // Stage 2: Universal Basis U. Global knot markers are a future
        // feature — the toggle stays inert until setGlobalKnotsVisibility
        // lands on Viewer3D. The "Open Basis Timeline" cross-link has
        // been retired now that Tab 3 is a real workspace tab.
        this.stage2Folder = this.pane.addFolder({
            title: 'Stage 2: Universal Basis U',
            expanded: false,
        });
        this.stage2Params = {
            showGlobalKnots: false,
        };
        this.stage2Folder.addBinding(this.stage2Params, 'showGlobalKnots', {
            label: 'Global Knots (stub)'
        }).on('change', (ev) => {
            const cb = callbacks.onStage2Toggle || (() => {});
            cb('global_knots', ev.value);
        });

        // Stage 3: Theoretical Manifold. Placeholder for the
        // cp-propagation §3.2 nominal-flow intermediate; the v1.2
        // NominalManifold surface already lives under Stage 4's Output
        // Surfaces, so this folder only carries forward-looking toggles
        // for now. The single stub toggle reads from the case envelope
        // when present and stays inert otherwise.
        this.stage3Folder = this.pane.addFolder({
            title: 'Stage 3: Theoretical Manifold',
            expanded: false,
        });
        this.stage3Params = { showNominalSurface: true };
        this.stage3Folder.addBinding(this.stage3Params, 'showNominalSurface', {
            label: 'Nominal Surface (stub)'
        }).on('change', (ev) => {
            const cb = callbacks.onStage3Toggle || (() => {});
            cb('nominal_surface', ev.value);
        });

        // Stage 4: Output Surfaces — preserves the original
        // FreeBlend3D / AffineTransport / NominalManifold section-mode
        // toggles. Intermediate Geometry (v-samples / v-sections /
        // proxied-guides / displacement-vectors) moves into a nested
        // folder under Stage 4, mirroring the previous two-folder pair.
        this.stage4Folder = this.pane.addFolder({
            title: 'Stage 4: Output Surfaces',
            expanded: true,
        });
        this.sectionModeFolder = this.stage4Folder.addFolder({
            title: 'Section Modes',
            expanded: true,
        });
        this.sectionModeParams = { freeblend3d: true, affinetransport: true, nominalmanifold: true };
        this.sectionModeFolder.addBinding(this.sectionModeParams, 'freeblend3d', {
            label: 'FreeBlend3D'
        }).on('change', (ev) => {
            if (callbacks.onSectionModeChange) {
                callbacks.onSectionModeChange('FreeBlend3D', ev.value);
            }
        });
        this.sectionModeFolder.addBinding(this.sectionModeParams, 'affinetransport', {
            label: 'AffineTransport'
        }).on('change', (ev) => {
            if (callbacks.onSectionModeChange) {
                callbacks.onSectionModeChange('AffineTransport', ev.value);
            }
        });
        this.sectionModeFolder.addBinding(this.sectionModeParams, 'nominalmanifold', {
            label: 'Nominal Manifold'
        }).on('change', (ev) => {
            if (callbacks.onSectionModeChange) {
                callbacks.onSectionModeChange('NominalManifold', ev.value);
            }
        });
        this.intermediateGeometryFolder = this.stage4Folder.addFolder({
            title: 'Intermediate Geometry',
            expanded: true,
        });
        this.intermediateGeometryParams = { vSamples: false, vSections: false, displacementVectors: false, proxiedGuides: false };
        this.intermediateGeometryFolder.addBinding(this.intermediateGeometryParams, 'vSamples', {
            label: 'v-samples'
        }).on('change', (ev) => {
            const cb = this._onIntermediateToggle || callbacks.onIntermediateToggle;
            if (cb) cb('v_samples', ev.value);
        });
        this.intermediateGeometryFolder.addBinding(this.intermediateGeometryParams, 'vSections', {
            label: 'v-sections'
        }).on('change', (ev) => {
            const cb = this._onIntermediateToggle || callbacks.onIntermediateToggle;
            if (cb) cb('v_sections', ev.value);
        });
        this.intermediateGeometryFolder.addBinding(this.intermediateGeometryParams, 'proxiedGuides', {
            label: 'proxied guides'
        }).on('change', (ev) => {
            const cb = this._onIntermediateToggle || callbacks.onIntermediateToggle;
            if (cb) cb('proxied_guides', ev.value);
        });
        this.intermediateGeometryFolder.addBinding(this.intermediateGeometryParams, 'displacementVectors', {
            label: 'displacement vectors'
        }).on('change', (ev) => {
            const cb = this._onIntermediateToggle || callbacks.onIntermediateToggle;
            if (cb) cb('displacement_vectors', ev.value);
        });

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
     * Wire the per-stage callbacks into the UIController so the
     * previously-floating bindings (Stage 1 / 2 / 3 toggles) can
     * dispatch their changes through main.js. Stored as instance
     * references so updateStage1/2/3* can refresh the checkbox state
     * after data loads (e.g. force the seam-markers toggle OFF if the
     * new case lacks stage1_coupling data).
     */
    setStage1Callback(cb) {
        this._onStage1Toggle = cb;
    }
    setStage2Callback(cb) {
        this._onStage2Toggle = cb;
    }
    setStage3Callback(cb) {
        this._onStage3Toggle = cb;
    }

    /**
     * Reset Stage-2 toggles. Stage 1 toggles now live on the Tab 2
     * coupling panel and are reset via couplingPanel.resetStage1Toggles().
     */
    resetStage2Toggles() {
        if (!this.stage2Params) return;
        this.stage2Params.showGlobalKnots = false;
        if (this.pane) this.pane.refresh();
    }

    /**
     * Build (lazily) the dedicated Tab 2 side panel: a separate
     * Tweakpane instance mounted inside #coupling-container (NOT the
     * main #app pane), with Stage 1 overlay toggles and a per-profile
     * diagnostics table. The returned object exposes refresh(caseData),
     * dispose() and resetStage1Toggles() so main.js can drive it from
     * outside.
     *
     * The diagnostics table reads the optional `is_closed`,
     * `phase_shift`, and `is_flipped` fields off each seam entry —
     * these are optional on the producer side, so missing values render
     * as '—' rather than throwing.
     */
    createCouplingPanel(container, callbacks) {
        if (!container) return null;
        container.innerHTML = '';
        const layout = document.createElement('div');
        layout.style.display = 'flex';
        layout.style.flexDirection = 'row';
        layout.style.width = '100%';
        layout.style.height = '100%';
        const viewport = document.createElement('div');
        viewport.id = 'coupling-viewport';
        viewport.style.flex = '1 1 auto';
        viewport.style.position = 'relative';
        viewport.style.minWidth = '0';
        layout.appendChild(viewport);
        const sidePanelRoot = document.createElement('div');
        sidePanelRoot.id = 'coupling-side-panel';
        sidePanelRoot.style.flex = '0 0 320px';
        sidePanelRoot.style.maxWidth = '320px';
        sidePanelRoot.style.height = '100%';
        sidePanelRoot.style.background = 'rgba(255,255,255,0.85)';
        sidePanelRoot.style.backdropFilter = 'blur(10px)';
        sidePanelRoot.style.borderLeft = '1px solid #e0e0e0';
        sidePanelRoot.style.boxSizing = 'border-box';
        sidePanelRoot.style.overflowY = 'auto';
        layout.appendChild(sidePanelRoot);
        container.appendChild(layout);

        const sidePane = new Pane({
            container: sidePanelRoot,
            title: 'Profile Coupling (Tab 2)',
            expanded: true,
        });
        const params = {
            showSeamMarkers: false,
            showTangentArrows: false,
            showRulingLines: false,
        };
        const stage1Folder = sidePane.addFolder({
            title: 'Stage 1 Overlays',
            expanded: true,
        });
        stage1Folder.addBinding(params, 'showSeamMarkers', { label: 'Seam Markers' })
            .on('change', (ev) => callbacks.onSeamMarkersToggle && callbacks.onSeamMarkersToggle(ev.value));
        stage1Folder.addBinding(params, 'showTangentArrows', { label: 'Tangent Arrows' })
            .on('change', (ev) => callbacks.onTangentArrowsToggle && callbacks.onTangentArrowsToggle(ev.value));
        stage1Folder.addBinding(params, 'showRulingLines', { label: 'Ruling Lines' })
            .on('change', (ev) => callbacks.onRulingLinesToggle && callbacks.onRulingLinesToggle(ev.value));

        const diagFolder = sidePane.addFolder({
            title: 'Diagnostics (per profile)',
            expanded: true,
        });
        const diagBody = document.createElement('div');
        diagBody.style.fontFamily = 'monospace';
        diagBody.style.fontSize = '11px';
        diagBody.style.lineHeight = '1.5';
        diagBody.style.padding = '4px 6px';
        diagBody.style.color = '#333';
        diagFolder.element.appendChild(diagBody);

        const renderTable = (caseData) => {
            diagBody.innerHTML = '';
            const seams = (caseData && caseData.debug
                && caseData.debug.stage1_coupling
                && Array.isArray(caseData.debug.stage1_coupling.seams))
                ? caseData.debug.stage1_coupling.seams
                : [];
            if (seams.length === 0) {
                diagBody.innerHTML = '<div style="color:#888;">No stage1_coupling data for this case.</div>';
                return;
            }
            const header = document.createElement('div');
            header.style.display = 'grid';
            header.style.gridTemplateColumns = '60px 70px 80px 70px';
            header.style.gap = '4px';
            header.style.fontWeight = '600';
            header.style.borderBottom = '1px solid #ccc';
            header.style.paddingBottom = '4px';
            header.style.marginBottom = '4px';
            header.innerHTML = '<span>profile</span><span>closed</span><span>phase°</span><span>flipped</span>';
            diagBody.appendChild(header);
            seams.forEach((seam) => {
                const row = document.createElement('div');
                row.style.display = 'grid';
                row.style.gridTemplateColumns = '60px 70px 80px 70px';
                row.style.gap = '4px';
                row.style.borderBottom = '1px dashed #eee';
                row.style.padding = '2px 0';
                const idx = (typeof seam.profile_index === 'number') ? seam.profile_index : '?';
                const closed = (typeof seam.is_closed === 'boolean')
                    ? (seam.is_closed ? 'yes' : 'no')
                    : '—';
                let phase = '—';
                if (typeof seam.phase_shift === 'number' && !isNaN(seam.phase_shift)) {
                    phase = (seam.phase_shift * 180 / Math.PI).toFixed(1);
                }
                const flipped = (typeof seam.is_flipped === 'boolean')
                    ? (seam.is_flipped ? 'YES' : 'no')
                    : '—';
                const flippedColor = (seam.is_flipped === true) ? '#d32f2f' : '#333';
                row.innerHTML = `
                    <span>${idx}</span>
                    <span>${closed}</span>
                    <span>${phase}</span>
                    <span style="color:${flippedColor};">${flipped}</span>
                `;
                diagBody.appendChild(row);
            });
        };

        const api = {
            pane: sidePane,
            viewportEl: viewport,
            params,
            refresh(caseData) {
                renderTable(caseData);
            },
            resetStage1Toggles() {
                params.showSeamMarkers = false;
                params.showTangentArrows = false;
                params.showRulingLines = false;
                sidePane.refresh();
            },
            dispose() {
                if (sidePane) sidePane.dispose();
                if (container) container.innerHTML = '';
            },
        };
        return api;
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

    /**
     * Build (lazily) the dedicated Tab 4 side panel: a Tweakpane
     * instance mounted inside the Tab 4 viewport (NOT the main #app
     * pane), with layer toggles, a plane-scale slider, and a station
     * list. The returned object exposes refresh(caseData), dispose(),
     * setStationHighlight(idx) and resetStationHighlight() so
     * main.js can drive it from outside.
     */
    createSpineFramesPanel(container, callbacks) {
        if (!container) return null;
        const sidePanelRoot = container.querySelector('#spine-frames-side-panel');
        if (!sidePanelRoot) return null;
        // Keep the panel pane scoped to its own side-panel root; any
        // previous Tweakpane instance on this container is disposed so
        // callers can re-enter Tab 4 safely.
        if (sidePanelRoot._tpInstance) {
            try { sidePanelRoot._tpInstance.dispose(); } catch (e) { /* no-op */ }
            sidePanelRoot._tpInstance = null;
        }
        while (sidePanelRoot.firstChild) {
            sidePanelRoot.removeChild(sidePanelRoot.firstChild);
        }

        const sidePane = new Pane({
            container: sidePanelRoot,
            title: 'Spine & Frames (Tab 4)',
            expanded: true,
        });
        sidePanelRoot._tpInstance = sidePane;

        const params = {
            showFrames: true,
            showPlanes: true,
            showRibbon: true,
            showStations: true,
            planeScale: 1.0,
        };

        const layersFolder = sidePane.addFolder({
            title: 'Layers',
            expanded: true,
        });
        layersFolder.addBinding(params, 'showFrames', { label: 'Frames (T/N/B)' })
            .on('change', (ev) => callbacks.onLayerToggle && callbacks.onLayerToggle('frames', ev.value));
        layersFolder.addBinding(params, 'showPlanes', { label: 'Sampling Planes' })
            .on('change', (ev) => callbacks.onLayerToggle && callbacks.onLayerToggle('planes', ev.value));
        layersFolder.addBinding(params, 'showRibbon', { label: 'Twist Ribbon' })
            .on('change', (ev) => callbacks.onLayerToggle && callbacks.onLayerToggle('ribbon', ev.value));
        layersFolder.addBinding(params, 'showStations', { label: 'Station Spheres' })
            .on('change', (ev) => callbacks.onLayerToggle && callbacks.onLayerToggle('stations', ev.value));

        const scaleFolder = sidePane.addFolder({
            title: 'Plane Scale',
            expanded: true,
        });
        scaleFolder.addBinding(params, 'planeScale', {
            label: 'Scale',
            min: 0.2,
            max: 5.0,
            step: 0.05,
        }).on('change', (ev) => callbacks.onPlaneScaleChange && callbacks.onPlaneScaleChange(ev.value));

        const stationFolder = sidePane.addFolder({
            title: 'Stations',
            expanded: true,
        });
        const stationBody = document.createElement('div');
        stationBody.className = 'spine-frames-station-list';
        stationBody.style.fontFamily = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace';
        stationBody.style.fontSize = '11px';
        stationBody.style.lineHeight = '1.5';
        stationBody.style.padding = '4px 6px';
        stationBody.style.maxHeight = '240px';
        stationBody.style.overflowY = 'auto';
        stationBody.style.color = '#333';
        stationFolder.element.appendChild(stationBody);

        let stationEntries = [];
        let activeStationIdx = null;
        const onStationClick = (callbacks && callbacks.onStationClick) || (() => {});

        const renderStations = (caseData) => {
            stationBody.innerHTML = '';
            stationEntries = [];
            const dbg = (caseData && caseData.debug && caseData.debug.stage3_spine_frames) || null;
            const frames = (dbg && Array.isArray(dbg.frames)) ? dbg.frames : [];
            if (frames.length === 0) {
                const empty = document.createElement('div');
                empty.style.color = '#888';
                empty.textContent = 'No stage3_spine_frames for this case.';
                stationBody.appendChild(empty);
                activeStationIdx = null;
                return;
            }
            frames.forEach((f, idx) => {
                const row = document.createElement('div');
                row.className = 'spine-frames-station-row';
                row.style.display = 'flex';
                row.style.justifyContent = 'space-between';
                row.style.alignItems = 'center';
                row.style.padding = '3px 6px';
                row.style.marginBottom = '2px';
                row.style.borderRadius = '3px';
                row.style.cursor = 'pointer';
                row.style.border = '1px solid #e0e0e0';
                row.style.background = '#fafafa';
                const v = (typeof f.v === 'number') ? f.v.toFixed(3) : '?';
                row.innerHTML = `<span>Station ${idx}</span><span style="color:#555;">v=${v}</span>`;
                row.addEventListener('click', () => {
                    setActiveStation(idx);
                    onStationClick(idx);
                });
                stationBody.appendChild(row);
                stationEntries.push(row);
            });
        };

        const setActiveStation = (idx) => {
            if (idx === null || idx === undefined) {
                activeStationIdx = null;
                stationEntries.forEach((el) => el.classList.remove('active'));
                return;
            }
            activeStationIdx = idx;
            stationEntries.forEach((el, k) => {
                el.classList.toggle('active', k === idx);
            });
        };

        const api = {
            pane: sidePane,
            params,
            refresh(caseData) {
                renderStations(caseData);
            },
            setStationHighlight(idx) {
                setActiveStation(idx);
            },
            resetStationHighlight() {
                setActiveStation(null);
            },
            dispose() {
                if (sidePane) {
                    try { sidePane.dispose(); } catch (e) { /* no-op */ }
                }
                if (sidePanelRoot._tpInstance === sidePane) {
                    sidePanelRoot._tpInstance = null;
                }
                while (sidePanelRoot.firstChild) {
                    sidePanelRoot.removeChild(sidePanelRoot.firstChild);
                }
            },
        };
        return api;
    }

    /**
     * Build (lazily) the dedicated Tab 5 side panel: a Tweakpane
     * instance mounted inside #manifold-patches-side-panel, with a
     * blend slider, four layer checkboxes (cage / weights / seams /
     * distinct), a read-only w_min / w_max monitor, and a per-patch
     * color chip list. The returned object exposes refresh(caseData),
     * dispose(), setBlend(t), toggleLayer(name, visible), and
     * resetBlend() so main.js can drive it from outside.
     */
    createManifoldPatchesPanel(container, callbacks) {
        if (!container) return null;
        const sidePanelRoot = container.querySelector('#manifold-patches-side-panel');
        if (!sidePanelRoot) return null;
        if (sidePanelRoot._tpInstance) {
            try { sidePanelRoot._tpInstance.dispose(); } catch (e) { /* no-op */ }
            sidePanelRoot._tpInstance = null;
        }
        while (sidePanelRoot.firstChild) {
            sidePanelRoot.removeChild(sidePanelRoot.firstChild);
        }

        const sidePane = new Pane({
            container: sidePanelRoot,
            title: 'Manifold vs Patches (Tab 5)',
            expanded: true,
        });
        sidePanelRoot._tpInstance = sidePane;

        const params = {
            blend: 0.5,
            showCage: true,
            showWeights: false,
            showSeams: true,
            showDistinct: true,
        };
        const weightMonitor = { w_min: 0, w_max: 1 };

        const blendFolder = sidePane.addFolder({
            title: 'Blend',
            expanded: true,
        });
        blendFolder.addBinding(params, 'blend', {
            label: '0%=Manifold → 100%=Patches',
            min: 0,
            max: 1,
            step: 0.01,
        }).on('change', (ev) => {
            if (callbacks && typeof callbacks.onBlendChange === 'function') {
                callbacks.onBlendChange(ev.value);
            }
        });

        const layersFolder = sidePane.addFolder({
            title: 'Layers',
            expanded: true,
        });
        layersFolder.addBinding(params, 'showCage', { label: 'Control Cage' })
            .on('change', (ev) => {
                if (callbacks && typeof callbacks.onLayerToggle === 'function') {
                    callbacks.onLayerToggle('cage', ev.value);
                }
            });
        layersFolder.addBinding(params, 'showWeights', { label: 'Weights Heatmap' })
            .on('change', (ev) => {
                if (callbacks && typeof callbacks.onLayerToggle === 'function') {
                    callbacks.onLayerToggle('weights', ev.value);
                }
            });
        layersFolder.addBinding(params, 'showSeams', { label: 'Split Seams' })
            .on('change', (ev) => {
                if (callbacks && typeof callbacks.onLayerToggle === 'function') {
                    callbacks.onLayerToggle('seams', ev.value);
                }
            });
        layersFolder.addBinding(params, 'showDistinct', { label: 'Patch Distinct Colors' })
            .on('change', (ev) => {
                if (callbacks && typeof callbacks.onLayerToggle === 'function') {
                    callbacks.onLayerToggle('distinct', ev.value);
                }
            });

        const monitorFolder = sidePane.addFolder({
            title: 'Weights (theoretical surface)',
            expanded: true,
        });
        monitorFolder.addBinding(weightMonitor, 'w_min', {
            label: 'w_min', readonly: true, format: (v) => v.toFixed(4),
        });
        monitorFolder.addBinding(weightMonitor, 'w_max', {
            label: 'w_max', readonly: true, format: (v) => v.toFixed(4),
        });

        const patchListFolder = sidePane.addFolder({
            title: 'Patches (distinct colors)',
            expanded: true,
        });
        const patchListBody = document.createElement('div');
        patchListBody.className = 'manifold-patches-patch-list';
        patchListFolder.element.appendChild(patchListBody);

        const renderPatchList = (caseData) => {
            patchListBody.innerHTML = '';
            const patches = (caseData && caseData._manifoldPatchesRef
                && Array.isArray(caseData._manifoldPatchesRef)) ? caseData._manifoldPatchesRef : [];
            if (patches.length === 0) {
                const empty = document.createElement('div');
                empty.style.color = '#888';
                empty.textContent = 'No post-split patches in case.nurbs.surfaces[]';
                patchListBody.appendChild(empty);
                return;
            }
            patches.forEach((p, i) => {
                const row = document.createElement('div');
                row.className = 'manifold-patches-patch-row';
                const swatch = document.createElement('span');
                swatch.className = 'manifold-patches-patch-swatch';
                const palette = [0xffaa00, 0x00aaff, 0x00ff88, 0xff5500, 0xaa00ff, 0x00ffaa,
                    0xff66cc, 0x66ccff, 0xccff66, 0xff3366, 0x9966ff, 0x33cc99];
                const hex = '#' + palette[i % palette.length].toString(16).padStart(6, '0');
                swatch.style.backgroundColor = hex;
                const label = document.createElement('span');
                label.textContent = p.label || `patch_${i}`;
                row.appendChild(swatch);
                row.appendChild(label);
                patchListBody.appendChild(row);
            });
        };

        const api = {
            pane: sidePane,
            params,
            refresh(caseData) {
                const stats = (caseData && caseData._manifoldWeightsRef) || null;
                if (stats) {
                    weightMonitor.w_min = stats.w_min;
                    weightMonitor.w_max = stats.w_max;
                } else {
                    weightMonitor.w_min = 0;
                    weightMonitor.w_max = 1;
                }
                sidePane.refresh();
                renderPatchList(caseData);
            },
            setBlend(t) {
                const v = (typeof t === 'number') ? Math.max(0, Math.min(1, t)) : 0.5;
                params.blend = v;
                sidePane.refresh();
            },
            toggleLayer(name, visible) {
                if (name === 'cage') params.showCage = !!visible;
                else if (name === 'weights') params.showWeights = !!visible;
                else if (name === 'seams') params.showSeams = !!visible;
                else if (name === 'distinct') params.showDistinct = !!visible;
                sidePane.refresh();
            },
            resetBlend() {
                params.blend = 0.5;
                if (callbacks && typeof callbacks.onBlendChange === 'function') {
                    callbacks.onBlendChange(0.5);
                }
                sidePane.refresh();
            },
            dispose() {
                if (sidePane) {
                    try { sidePane.dispose(); } catch (e) { /* no-op */ }
                }
                if (sidePanelRoot._tpInstance === sidePane) {
                    sidePanelRoot._tpInstance = null;
                }
                while (sidePanelRoot.firstChild) {
                    sidePanelRoot.removeChild(sidePanelRoot.firstChild);
                }
            },
        };
        return api;
    }

    updateSurfaceToggles(surfaces, onSurfaceToggle) {
        // Cache the latest surface list so the subsequent
        // updateCurveToggles call can build the complete bucket
        // (sections/guides need both their curve label and any
        // support-surface / tangent-ribbon child label).
        const HANDLED_BY_OUTPUT_SURFACES = new Set([
            'FreeBlend3D', 'AffineTransport', 'NominalManifold',
        ]);
        this._lastInputGeometrySurfaces = surfaces.filter(
            l => !HANDLED_BY_OUTPUT_SURFACES.has(l)
        );
        this._lastSurfaceToggle = onSurfaceToggle;
    }

    /**
     * spec 0002: cache envelope so _buildInputGeometryBucket can
     * detect moving_frame / sampling_plane and inject spine-auxViz
     * siblings. v1.1 envelopes (no envelope / no such keys) leave
     * the Spine folder rendering exactly as today.
     */
    setEnvelope(envelope) {
        this._lastEnvelope = envelope || null;
    }

    updateCurveToggles(curves, onCurveToggle) {
        this.curveFolder.children.forEach(c => c.dispose());
        this._renderInputGeometryFolders(
            this._buildInputGeometryBucket(
                this._lastInputGeometrySurfaces || [],
                curves,
            ),
            {
                curve: onCurveToggle,
                surface: this._lastSurfaceToggle || onCurveToggle,
                keyVector: this._lastSurfaceToggle || onCurveToggle,
            },
        );
    }

    /**
     * Wire the Intermediate Geometry folder's v-samples checkbox
     * callback. Called by main.js after each case-render; if the case
     * has no v_samples data main.js skips this call and the toggle
     * is a no-op (the folder stays present but inert).
     */
    updateIntermediateGeometry(callback) {
        this._onIntermediateToggle = callback;
        if (this.intermediateGeometryParams) {
            this.intermediateGeometryParams.vSamples = false;
            this.intermediateGeometryParams.vSections = false;
            this.intermediateGeometryParams.proxiedGuides = false;
        }
    }

    /**
     * Build the per-case data model. Each section_x / guide_x entry is
     * `{ idx, curve, auxViz: { 'Support Surface': label, 'Tangent Ribbon': label } }`.
     * Curve labels (from curves[]) always seed a section_x / guide_x entry.
     * Surface labels (from surfaces[]) attach as aux-viz children by index
     * when an index suffix is present, or fall back to index 0 when not.
     *
     * Currently routed aux-viz kinds:
     *   - 'Support Surface'  ← Section Continuity Support #<i>,
     *                           Loose Section Support #<i>,
     *                           Section Support Surface,
     *                           Guide Support Surface #<i>,
     *                           Section Constraint Viz support_surface
     *   - 'Tangent Ribbon'   ← Section Constraint Viz tangent_ribbon [#<i>]
     *
     * Not routed (per current scope):
     *   - Section Constraint Viz curvature_ribbon / torsion_ribbon
     */
    _buildInputGeometryBucket(surfaces, curves) {
        const sections = new Map();
        const guides   = new Map();
        let spineLabel = null;

        const newSection = (idx) => sections.get(idx) || (sections.set(idx, { idx, curve: null, auxViz: {} }), sections.get(idx));
        const newGuide   = (idx) => guides.get(idx)   || (guides.set(idx,   { idx, curve: null, auxViz: {} }), guides.get(idx));

        for (const label of curves) {
            const sm = label.match(/^section_(\d+)$/);
            if (sm) { const idx = parseInt(sm[1], 10); newSection(idx).curve = label; continue; }
            const gm = label.match(/^guide_(\d+)$/);
            if (gm) { const idx = parseInt(gm[1], 10); newGuide(idx).curve = label; continue; }
            if (label === 'spine') { spineLabel = label; }
        }

        const attach = (entry, kind, label) => {
            if (!entry.auxViz[kind]) entry.auxViz[kind] = label;
        };

        for (const label of surfaces) {
            let m = label.match(/^Section Continuity Support #(\d+)$/);
            if (m) { attach(newSection(parseInt(m[1], 10)), 'Support Surface', label); continue; }
            m = label.match(/^Loose Section Support #(\d+)$/);
            if (m) { attach(newSection(parseInt(m[1], 10)), 'Support Surface', label); continue; }
            if (label === 'Section Support Surface') {
                attach(newSection(0), 'Support Surface', label); continue;
            }
            m = label.match(/^Guide Support Surface #(\d+)$/);
            if (m) { attach(newGuide(parseInt(m[1], 10)), 'Support Surface', label); continue; }

            // support_surface label as emitted by gallery_loader.cpp has no
            // #<i> suffix — fall back to section_0. Future producers that
            // want index-routing should append ` #<i>`.
            if (label === 'Section Constraint Viz support_surface') {
                attach(newSection(0), 'Support Surface', label); continue;
            }
            m = label.match(/^Section Constraint Viz support_surface #(\d+)$/);
            if (m) { attach(newSection(parseInt(m[1], 10)), 'Support Surface', label); continue; }

            m = label.match(/^Section Constraint Viz tangent_ribbon #(\d+)$/);
            if (m) { attach(newSection(parseInt(m[1], 10)), 'Tangent Ribbon', label); continue; }
            if (label === 'Section Constraint Viz tangent_ribbon') {
                attach(newSection(0), 'Tangent Ribbon', label); continue;
            }
            // curvature_ribbon / torsion_ribbon intentionally not routed
            // yet — extend this block when they need UI toggles.
        }

        // spec 0002 (v1.2): spine-auxViz siblings — rendered inside
        // the Spine category folder alongside the spine Curve toggle
        // when the envelope carries moving_frame / sampling_plane.
        // v1.1 envelopes (no envelope cached, or no such keys) yield
        // an empty object and the Spine folder renders as before.
        const spineAuxViz = {};
        if (this._lastEnvelope) {
            const mf = this._lastEnvelope.moving_frame;
            const sp = this._lastEnvelope.sampling_plane;
            if (Array.isArray(mf) && mf.length > 0) spineAuxViz['Moving Frame'] = 'Moving Frame';
            if (Array.isArray(sp) && sp.length > 0) spineAuxViz['Sampling Plane'] = 'Sampling Plane';
        }

        return {
            sections: Array.from(sections.values()).sort((a, b) => a.idx - b.idx),
            guides:   Array.from(guides.values()).sort((a, b) => a.idx - b.idx),
            spineLabel,
            spineAuxViz,
        };
    }

    _rebuildInputGeometryFolders() {
        if (this._inputGeometrySubFolders) {
            this._inputGeometrySubFolders.forEach(f => f.dispose());
        }
        this._inputGeometrySubFolders = [];
        this._inputGeometryCategoryFolders = {};
    }

    _getCategoryFolder(category) {
        if (!this._inputGeometryCategoryFolders) {
            this._inputGeometryCategoryFolders = {};
        }
        let folder = this._inputGeometryCategoryFolders[category];
        if (!folder) {
            folder = this.surfaceFolder.addFolder({
                title: category,
                expanded: true,
            });
            this._inputGeometryCategoryFolders[category] = folder;
            this._inputGeometrySubFolders.push(folder);
        }
        return folder;
    }

    _addToggleToFolder(folder, displayLabel, controlKey, onToggle) {
        const key = controlKey.replace(/[^A-Za-z0-9_]/g, '_');
        const params = { [key]: true };
        folder.addBinding(params, key, { label: displayLabel })
            .on('change', (ev) => onToggle(controlKey, ev.value));
    }

    /**
     * Back-compat 3-arg form: displayLabel === controlKey. Used for the
     * Curve toggle (section_0/1/2, guide_0/1/2, spine) where the label is
     * already viewer-friendly.
     */
    _addToggleByLabel(folder, label, onToggle) {
        this._addToggleToFolder(folder, label, label, onToggle);
    }

    _renderInputGeometryFolders(bucket, callbacks) {
        this._rebuildInputGeometryFolders();

        const addItemSubfolder = (parent, itemLabel, entry) => {
            const sub = parent.addFolder({ title: itemLabel, expanded: false });
            this._inputGeometrySubFolders.push(sub);
            if (entry.curve) this._addToggleByLabel(sub, entry.curve, callbacks.curve);
            for (const [kind, rawLabel] of Object.entries(entry.auxViz)) {
                this._addToggleToFolder(sub, kind, rawLabel, callbacks.surface);
            }
        };

        if (bucket.sections.length > 0) {
            const sectionsFolder = this._getCategoryFolder('Sections');
            bucket.sections.forEach(entry => {
                addItemSubfolder(sectionsFolder, `section_${entry.idx}`, entry);
            });
        }

        if (bucket.guides.length > 0) {
            const guidesFolder = this._getCategoryFolder('Guides');
            bucket.guides.forEach(entry => {
                addItemSubfolder(guidesFolder, `guide_${entry.idx}`, entry);
            });
        }

        if (bucket.spineLabel) {
            const spineFolder = this._getCategoryFolder('Spine');
            this._addToggleByLabel(spineFolder, bucket.spineLabel, callbacks.curve);
            // spec 0002 (v1.2): auxViz siblings below the spine curve
            // toggle. Routed through callbacks.surface (= setSurfaceVisibility),
            // NOT callbacks.curve — that's the previous-bug fix this
            // session locked in.
            for (const [kind, rawLabel] of Object.entries(bucket.spineAuxViz || {})) {
                this._addToggleToFolder(spineFolder, kind, rawLabel, callbacks.surface);
            }
        }
    }

    /**
     * Wire the v1.1 audit panel. If the case carries no
     * process_audit / intermediate_products, show a single-line
     * "v1.0 case — no audit data" placeholder so the reviewer knows
     * the absence is meaningful (older producer), not a bug.
     */
    updateAuditPanel(layerKeys, audit, onToggleLayer, container) {
        if (this.auditPanel) this.auditPanel.dispose();
        this.auditPanel = new AuditPanel({
            audit,
            onToggleLayer: (layerKey, visible) => onToggleLayer(layerKey, visible),
            container: container || undefined,
        });
    }

    /**
     * Guide-binding (spec 0004) panel: surfaces, curves, and the
     * three guide-binding layers (degenerate_segments,
     * attachment_spheres, attachment_labels) as independent toggles.
     * Audit layers (heatmaps / couplings / debug_markers) are wired
     * through the existing AuditPanel so the reviewer has a single
     * place to control them.
     */
    updateGuideBindingPanel(payload, callbacks) {
        const { surfaceLabels, curveLabels, guideBindingLayers, audit } = payload;
        const { onSurfaceToggle, onCurveToggle, onGuideBindingToggle, onAuditToggle } = callbacks;

        this.surfaceFolder.children.forEach(c => c.dispose());
        surfaceLabels.forEach(label => {
            const key = label.replace(/[^A-Za-z0-9_]/g, '_');
            const params = { [key]: true };
            this.surfaceFolder.addBinding(params, key, { label })
                .on('change', (ev) => onSurfaceToggle(label, ev.value));
        });

        this.curveFolder.children.forEach(c => c.dispose());
        curveLabels.forEach(label => {
            const key = label.replace(/[^A-Za-z0-9_]/g, '_');
            const params = { [key]: true };
            this.curveFolder.addBinding(params, key, { label })
                .on('change', (ev) => onCurveToggle(label, ev.value));
        });

        if (this.guideBindingFolder) {
            this.guideBindingFolder.dispose();
        }
        this.guideBindingFolder = this.pane.addFolder({
            title: 'Guide Binding (spec 0004)',
            expanded: true,
        });
        const layerState = {};
        guideBindingLayers.forEach(layerKey => {
            layerState[layerKey] = true;
            this.guideBindingFolder.addBinding(layerState, layerKey, {
                label: layerKey.replace(/_/g, ' ')
            }).on('change', (ev) => onGuideBindingToggle(layerKey, ev.value));
        });

        if (audit) {
            if (this.auditPanel) this.auditPanel.dispose();
            this.auditPanel = new AuditPanel({
                audit,
                onToggleLayer: (layerKey, visible) => onAuditToggle(layerKey, visible),
            });
        } else if (this.auditPanel) {
            this.auditPanel.dispose();
            this.auditPanel = null;
        }
    }
}