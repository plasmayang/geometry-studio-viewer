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

        // Stage 1: Profile Coupling. Three overlays driven by
        // case.debug.stage1_coupling: seam markers, tangent arrows,
        // ruling lines. Defaults OFF; main.js wires the toggles to the
        // Viewer3D groups built in setCouplingDebug().
        this.stage1Folder = this.pane.addFolder({
            title: 'Stage 1: Profile Coupling',
            expanded: false,
        });
        this.stage1Params = {
            showSeamMarkers: false,
            showTangentArrows: false,
            showRulingLines: false,
        };
        this.stage1Folder.addBinding(this.stage1Params, 'showSeamMarkers', {
            label: 'Seam Markers'
        }).on('change', (ev) => {
            const cb = callbacks.onStage1Toggle || (() => {});
            cb('seam_markers', ev.value);
        });
        this.stage1Folder.addBinding(this.stage1Params, 'showTangentArrows', {
            label: 'Tangent Arrows'
        }).on('change', (ev) => {
            const cb = callbacks.onStage1Toggle || (() => {});
            cb('tangent_arrows', ev.value);
        });
        this.stage1Folder.addBinding(this.stage1Params, 'showRulingLines', {
            label: 'Ruling Lines'
        }).on('change', (ev) => {
            const cb = callbacks.onStage1Toggle || (() => {});
            cb('ruling_lines', ev.value);
        });

        // Stage 2: Universal Basis U. Global knot markers are a future
        // feature — the toggle stays inert until setGlobalKnotsVisibility
        // lands on Viewer3D. "Show Basis Timeline" is a cross-tab signal
        // dispatched by main.js (it switches the workspace to Tab 2 when
        // the user ticks this box).
        this.stage2Folder = this.pane.addFolder({
            title: 'Stage 2: Universal Basis U',
            expanded: false,
        });
        this.stage2Params = {
            showGlobalKnots: false,
            showBasisTimelineSteps: false,
        };
        this.stage2Folder.addBinding(this.stage2Params, 'showGlobalKnots', {
            label: 'Global Knots (stub)'
        }).on('change', (ev) => {
            const cb = callbacks.onStage2Toggle || (() => {});
            cb('global_knots', ev.value);
        });
        this.stage2Folder.addBinding(this.stage2Params, 'showBasisTimelineSteps', {
            label: 'Open Basis Timeline →',
        }).on('change', (ev) => {
            const cb = callbacks.onStage2Toggle || (() => {});
            cb('basis_timeline_steps', ev.value);
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
     * Reset Stage-1 toggles to OFF and refresh. Called by main.js
     * whenever a new case loads so the reviewer can't be left looking
     * at seam markers from a previous case that aren't in the current
     * one.
     */
    resetStage1Toggles() {
        if (!this.stage1Params) return;
        this.stage1Params.showSeamMarkers = false;
        this.stage1Params.showTangentArrows = false;
        this.stage1Params.showRulingLines = false;
        if (this.pane) this.pane.refresh();
    }

    /**
     * Reset Stage-2 toggles. Same rationale as resetStage1Toggles.
     */
    resetStage2Toggles() {
        if (!this.stage2Params) return;
        this.stage2Params.showGlobalKnots = false;
        this.stage2Params.showBasisTimelineSteps = false;
        if (this.pane) this.pane.refresh();
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
    updateAuditPanel(layerKeys, audit, onToggleLayer) {
        if (this.auditPanel) this.auditPanel.dispose();
        this.auditPanel = new AuditPanel({
            audit,
            onToggleLayer: (layerKey, visible) => onToggleLayer(layerKey, visible),
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