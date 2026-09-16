// TimelinePanel — Tab 3 (U-Basis Timeline) of the geometry-viewer workspace.
//
// Single full-screen 3D canvas + bottom Stepper Bar. ONE THREE.WebGLRenderer,
// ONE THREE.Scene shared between three groups:
//
//   - skeletonGroup  : persistent Spine + Guides passed in via
//                      options.spineGroup (extracted once by Viewer3D;
//                      opacity clamped to ~0.6 so it reads as a faint
//                      background overlay).
//   - currentGroup   : per-step NURBS profiles + control polygons + CP
//                      spheres for the active step. Rebuilt on every
//                      setActiveStep().
//   - ghostGroup     : previous step's control polygon rendered grey
//                      with opacity 0.25 (toggleable). Rebuilt on every
//                      setActiveStep() when activeStep > 0.
//
// Scale invariance: bbox.diagonal computed from the union of all three
// groups (or the current-group bbox when no skeleton). CP sphere radius
// = clamp(bbox.diag * 0.015, 0.005, 0.2). Control polygon line width
// uses Line2 / LineMaterial so the line width survives resize.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { NURBSCurve } from 'three/addons/curves/NURBSCurve.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

// Visual palette — mirrors Viewer3D's section=black / guide=magenta
// convention so the timeline canvas feels like a sibling of the main
// 3D viewport rather than a foreign widget.
const PROFILE_COLORS = [0x000000, 0xff00ff, 0x008800, 0xff8800, 0x3366ff, 0xaa00ff];
const GHOST_COLOR = 0x666666;
const AUTOPLAY_INTERVAL_MS = 1000;

export class TimelinePanel {
    /**
     * @param {HTMLElement} container — full-width, full-height below the
     *                                  48px tab strip. The panel takes
     *                                  over its layout completely.
     * @param {Object|null} caseData  — parsed case JSON; null is allowed
     *                                  (renders the empty-state).
     * @param {Object} options        — { spineGroup, geometryParser,
     *                                  onStepChange }.
     */
    constructor(container, caseData, options = {}) {
        this.container = container;
        this.caseData = caseData || null;
        this.options = options || {};
        this._onStepChange = (typeof this.options.onStepChange === 'function')
            ? this.options.onStepChange : null;

        // Lifecycle / state.
        this._activeStep = 0;
        this._ghostEnabled = true;
        this._autoplayRunning = false;
        this._autoplayTimer = null;
        this._rafId = null;
        this._running = false;

        // Scene-graph owned by this panel.
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.skeletonGroup = null;
        this.currentGroup = null;
        this.ghostGroup = null;
        this.lightsGroup = null;

        // Tracked LineMaterial instances so we can update their
        // `resolution` on every window resize.
        this._lineMaterials = [];

        // DOM handles — populated by _buildDom().
        this._dom = null;
        // stepper button refs (for fast active-class toggle).
        this._stepperButtons = [];
        this._playButton = null;
        this._titleBarEl = null;
        this._titleStepEl = null;
        this._titleDescEl = null;
        this._diffBadgeEl = null;
        this._numericBadgeEl = null;

        // Cached timeline data extracted from caseData.
        this._steps = [];
        this._stepperShortLabel = (i, step) => {
            const name = (step && step.step_name) ? step.step_name : `step_${i + 1}`;
            return `${i}: ${name}`;
        };

        this._buildDom();
        this._initThree();
        this._extractSteps();
        this._wireResize();
        this._wireKeyboard();
        this._refreshSkeleton();
        if (this._steps.length > 0) {
            this._renderStepper();
            this.setActiveStep(0, /* emit */ false);
            this._running = true;
            this._startLoop();
        } else {
            this._renderEmptyState();
        }
    }

    // ---- public API ------------------------------------------------------

    /**
     * Re-render the panel with a new case. Old resources disposed first.
     */
    update(caseData) {
        this.caseData = caseData || null;
        this._stopAutoplay();
        this._disposeSceneResources();
        this._refreshSkeleton();
        this._extractSteps();
        if (this._steps.length > 0) {
            this._activeStep = 0;
            this._renderActiveStep(/* emit */ false);
            this._renderStepper();
            this._updateTitle();
            this._updateDiffBadge();
            this._updateNumericBadge();
            this._running = true;
            this._startLoop();
        } else {
            this._renderEmptyState();
        }
    }

    /**
     * Release WebGL context, stepper DOM, all listeners. Safe to call
     * multiple times.
     */
    dispose() {
        this._running = false;
        this._stopAutoplay();
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
        this._unwireResize();
        this._unwireKeyboard();
        this._disposeSceneResources();
        if (this.renderer) {
            this.renderer.dispose();
            // Detach the canvas so the host can swap containers freely.
            if (this.renderer.domElement && this.renderer.domElement.parentNode) {
                this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
            }
            this.renderer.forceContextLoss && this.renderer.forceContextLoss();
            this.renderer = null;
        }
        if (this.controls) {
            this.controls.dispose();
            this.controls = null;
        }
        if (this._dom && this._dom.root && this._dom.root.parentNode) {
            this._dom.root.parentNode.removeChild(this._dom.root);
        }
        this._dom = null;
        this._stepperButtons = [];
        this._lineMaterials = [];
    }

    /**
     * Programmatic step switch (autoplay + external keyboard).
     */
    setActiveStep(stepIndex, emit = true) {
        if (this._steps.length === 0) return;
        const n = this._steps.length;
        // Wrap-around for autoplay friendliness.
        const idx = ((stepIndex % n) + n) % n;
        const prev = this._activeStep;
        this._activeStep = idx;
        this._renderActiveStep(emit);
        this._updateStepperActiveClass();
        this._updateTitle();
        this._updateDiffBadge();
        this._updateNumericBadge();
        if (emit && this._onStepChange) {
            const diff = this._computeDiff(prev, idx);
            try {
                this._onStepChange({ stepIndex: idx, totalSteps: n, diff });
            } catch (e) {
                console.error('TimelinePanel: onStepChange callback threw', e);
            }
        }
    }

    getActiveStep() {
        return this._activeStep;
    }

    /**
     * Toggle the ghost-of-previous-step overlay.
     */
    toggleGhost(visible) {
        this._ghostEnabled = !!visible;
        if (!this._ghostEnabled) {
            this._clearGroup(this.ghostGroup);
        } else if (this._steps.length > 0) {
            // Re-render ghost if there's a previous step.
            this._renderActiveStep(/* emit */ false);
        }
    }

    /**
     * Toggle autoplay (1 step/sec, wraps 0 → N-1 → 0).
     * Calling with no argument flips the current state.
     */
    toggleAutoplay(running) {
        const next = (typeof running === 'boolean') ? running : !this._autoplayRunning;
        if (next) this._startAutoplay();
        else this._stopAutoplay();
        return this._autoplayRunning;
    }

    // ---- DOM scaffolding --------------------------------------------------

    _buildDom() {
        // Tear down any prior DOM (defensive — _buildDom is normally
        // called once from the constructor, but a defensive wipe keeps
        // the code robust to a misuse like "new TimelinePanel on a
        // non-empty container").
        while (this.container.firstChild) {
            this.container.removeChild(this.container.firstChild);
        }

        const root = document.createElement('div');
        root.className = 'timeline-root';

        const titleBar = document.createElement('div');
        titleBar.className = 'timeline-titlebar';
        const titleStep = document.createElement('div');
        titleStep.className = 'timeline-titlebar-step';
        const titleDesc = document.createElement('div');
        titleDesc.className = 'timeline-titlebar-desc';
        titleBar.appendChild(titleStep);
        titleBar.appendChild(titleDesc);
        const diffBadge = document.createElement('div');
        diffBadge.className = 'timeline-diff-badge';
        titleBar.appendChild(diffBadge);

        const canvasWrap = document.createElement('div');
        canvasWrap.className = 'timeline-canvas-wrap';

        const numericBadge = document.createElement('div');
        numericBadge.className = 'timeline-numeric-badge';
        canvasWrap.appendChild(numericBadge);

        const stepper = document.createElement('div');
        stepper.className = 'timeline-stepper';
        const playBtn = document.createElement('button');
        playBtn.type = 'button';
        playBtn.className = 'timeline-stepper-play';
        playBtn.textContent = '▶ Play';
        playBtn.setAttribute('aria-label', 'Toggle autoplay');
        stepper.appendChild(playBtn);
        const stepperList = document.createElement('div');
        stepperList.className = 'timeline-stepper-list';
        stepper.appendChild(stepperList);

        root.appendChild(titleBar);
        root.appendChild(canvasWrap);
        root.appendChild(stepper);

        // Inject default empty container styling so the panel occupies
        // the full viewport below the tab strip — main.js is expected
        // to give us a container that already fills that space, but if
        // it doesn't we still want the canvas to be visible.
        root.style.width = '100%';
        root.style.height = '100%';
        root.style.display = 'flex';
        root.style.flexDirection = 'column';
        canvasWrap.style.flex = '1 1 auto';
        canvasWrap.style.position = 'relative';
        canvasWrap.style.minHeight = '0';

        this.container.appendChild(root);
        this._dom = {
            root, titleBar, titleStep, titleDesc, diffBadge,
            canvasWrap, numericBadge, stepper, stepperList,
        };
        this._titleBarEl = titleBar;
        this._titleStepEl = titleStep;
        this._titleDescEl = titleDesc;
        this._diffBadgeEl = diffBadge;
        this._numericBadgeEl = numericBadge;
        this._playButton = playBtn;
        playBtn.addEventListener('click', () => this.toggleAutoplay());
    }

    _renderEmptyState() {
        this._titleStepEl.textContent = 'No timeline data';
        this._titleDescEl.textContent = 'The loaded case has no stage2_basis_u_timeline.';
        this._diffBadgeEl.textContent = '';
        this._numericBadgeEl.textContent = '';
        // Clear stepper buttons.
        while (this._dom.stepperList.firstChild) {
            this._dom.stepperList.removeChild(this._dom.stepperList.firstChild);
        }
        this._stepperButtons = [];
        this._clearGroup(this.currentGroup);
        this._clearGroup(this.ghostGroup);
    }

    _renderStepper() {
        const list = this._dom.stepperList;
        while (list.firstChild) list.removeChild(list.firstChild);
        this._stepperButtons = [];
        this._steps.forEach((step, idx) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'timeline-stepper-btn';
            btn.textContent = this._stepperShortLabel(idx, step);
            btn.title = step.description || step.step_name || '';
            btn.addEventListener('click', () => this.setActiveStep(idx));
            list.appendChild(btn);
            this._stepperButtons.push(btn);
        });
        this._updateStepperActiveClass();
    }

    _updateStepperActiveClass() {
        const i = this._activeStep;
        for (let k = 0; k < this._stepperButtons.length; k++) {
            this._stepperButtons[k].classList.toggle('active', k === i);
        }
    }

    // ---- Three.js scaffolding --------------------------------------------

    _initThree() {
        const wrap = this._dom.canvasWrap;
        const rect = wrap.getBoundingClientRect();
        const w = Math.max(320, Math.floor(rect.width || window.innerWidth));
        const h = Math.max(240, Math.floor(rect.height || window.innerHeight - 140));

        const canvas = document.createElement('canvas');
        canvas.className = 'timeline-canvas';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.display = 'block';
        wrap.appendChild(canvas);

        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
        this.renderer.setPixelRatio(window.devicePixelRatio || 1);
        this.renderer.setSize(w, h, false);
        this.renderer.setClearColor(0xf5f7fa, 1.0);

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0xf5f7fa);

        this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 5000);
        this.camera.position.set(8, 6, 12);

        this.lightsGroup = new THREE.Group();
        this.lightsGroup.add(new THREE.AmbientLight(0xffffff, 0.8));
        const dir = new THREE.DirectionalLight(0xffffff, 1.0);
        dir.position.set(5, 10, 7.5);
        this.lightsGroup.add(dir);
        this.scene.add(this.lightsGroup);

        this.skeletonGroup = new THREE.Group();
        this.skeletonGroup.name = 'timeline.skeletonGroup';
        this.scene.add(this.skeletonGroup);

        this.currentGroup = new THREE.Group();
        this.currentGroup.name = 'timeline.currentGroup';
        this.scene.add(this.currentGroup);

        this.ghostGroup = new THREE.Group();
        this.ghostGroup.name = 'timeline.ghostGroup';
        this.scene.add(this.ghostGroup);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.target.set(0, 0, 0);
        this.controls.update();
    }

    _refreshSkeleton() {
        this._clearGroup(this.skeletonGroup);
        const provided = this.options.spineGroup;
        if (!provided) return; // graceful degrade: no skeleton
        // We don't own the group — the host (Viewer3D) reuses it across
        // panels. To keep the world tidy we re-parent: clone via add()
        // does NOT move (Three.js mutates parent), so we need to either
        // (a) move the original or (b) traverse+clone. The contract
        // says "persistent skeleton (Spine + Guides) ... the panel
        // only handles the EVOLVING parts"; moving the original is the
        // safe option because the host keeps a reference and we never
        // mutate it.
        while (provided.children.length > 0) {
            const child = provided.children[0];
            this.skeletonGroup.add(child);
        }
        // Force every material under the skeleton to ~0.6 opacity so
        // the persistent skeleton reads as a transparent overlay.
        this.skeletonGroup.traverse((obj) => {
            if (!obj.material) return;
            const setOp = (m) => {
                if (!m) return;
                if ('opacity' in m) {
                    m.transparent = true;
                    m.opacity = 0.6;
                    m.depthWrite = false;
                }
            };
            if (Array.isArray(obj.material)) obj.material.forEach(setOp);
            else setOp(obj.material);
        });
    }

    // ---- data extraction -------------------------------------------------

    _extractSteps() {
        const dbg = this.caseData && this.caseData.debug
            ? this.caseData.debug.stage2_basis_u_timeline : null;
        if (!dbg) {
            this._steps = [];
            return;
        }
        // The parser already returns an array of steps (or an object
        // with `steps` depending on caller). Accept both shapes.
        if (Array.isArray(dbg)) {
            this._steps = dbg.filter(Boolean);
        } else if (Array.isArray(dbg.steps)) {
            this._steps = dbg.steps.filter(Boolean);
        } else {
            this._steps = [];
        }
    }

    _computeDiff(prevIdx, currIdx) {
        const prev = (prevIdx >= 0 && prevIdx < this._steps.length) ? this._steps[prevIdx] : null;
        const curr = (currIdx >= 0 && currIdx < this._steps.length) ? this._steps[currIdx] : null;
        const f = (step) => {
            if (!step || !Array.isArray(step.profiles) || step.profiles.length === 0) {
                return { degree: null, nCP: 0, knotsLen: 0 };
            }
            const p0 = step.profiles[0];
            return {
                degree: (typeof p0.degree === 'number') ? p0.degree
                    : (typeof p0.p === 'number') ? p0.p : null,
                nCP: Array.isArray(p0.control_points) ? p0.control_points.length : 0,
                knotsLen: Array.isArray(p0.knots) ? p0.knots.length : 0,
            };
        };
        const a = f(prev);
        const b = f(curr);
        return {
            degree_prev: a.degree,
            degree_curr: b.degree,
            nCP_prev: a.nCP,
            nCP_curr: b.nCP,
            knots_len_prev: a.knotsLen,
            knots_len_curr: b.knotsLen,
        };
    }

    // ---- per-step rendering ----------------------------------------------

    _renderActiveStep(emit) {
        this._clearGroup(this.currentGroup);
        this._clearGroup(this.ghostGroup);
        if (this._steps.length === 0) return;
        const step = this._steps[this._activeStep];
        const profiles = Array.isArray(step.profiles) ? step.profiles : [];

        // Bbox must be measured AFTER skeleton is added but BEFORE we
        // build current-step geometry (otherwise the bbox of the
        // current group would be self-referential). Re-measure every
        // step because the persistent skeleton is constant but the
        // union grows as ghost toggles.
        const baseBbox = this._measureSceneBbox(/* includeCurrent */ false,
                                                /* includeGhost */ false);
        let scale = 1.0;
        if (!baseBbox.isEmpty()) {
            const size = baseBbox.getSize(new THREE.Vector3());
            scale = Math.max(0.001, size.length());
        }
        const sphereRadius = Math.min(0.2, Math.max(0.005, scale * 0.015));
        const lineWidth = Math.min(window.innerWidth, window.innerHeight) * 0.003;

        profiles.forEach((p, pIdx) => {
            this._addProfileCurve(this.currentGroup, p, pIdx, lineWidth, sphereRadius);
        });

        // Ghost: previous step's control polygon only (cheap — no
        // curve re-evaluation).
        if (this._ghostEnabled && this._activeStep > 0) {
            const prev = this._steps[this._activeStep - 1];
            const prevProfiles = Array.isArray(prev.profiles) ? prev.profiles : [];
            prevProfiles.forEach((p, pIdx) => {
                this._addGhostPolygon(this.ghostGroup, p, pIdx, lineWidth);
            });
        }

        // Fit the camera to the union of all visible geometry (first
        // active step only — subsequent steps keep the user-controlled
        // camera so reviewers don't lose context).
        if (!emit || this._activeStep === 0) {
            this._fitCameraToScene();
        }
    }

    _addProfileCurve(parent, profile, colorIndex, lineWidth, sphereRadius) {
        if (!profile) return;
        const cpsRaw = profile.control_points || [];
        if (!Array.isArray(cpsRaw) || cpsRaw.length === 0) return;
        const color = PROFILE_COLORS[colorIndex % PROFILE_COLORS.length];

        // control_points arrives as [{x, y, z, w}] (Vector4-shaped
        // dicts). Mirror Viewer3D._addProfileCurve's coercion: Vector3
        // for the polygon, Vector4 for the NURBS evaluator.
        const toVec3 = (p) => {
            if (Array.isArray(p)) return new THREE.Vector3(p[0] || 0, p[1] || 0, p[2] || 0);
            return new THREE.Vector3(p.x || 0, p.y || 0, p.z || 0);
        };
        const toVec4 = (p) => {
            if (Array.isArray(p)) {
                return new THREE.Vector4(p[0] || 0, p[1] || 0, p[2] || 0, (p[3] != null) ? p[3] : 1);
            }
            return new THREE.Vector4(p.x || 0, p.y || 0, p.z || 0, (p.w != null) ? p.w : 1);
        };

        const cpPts = cpsRaw.map(toVec3);
        if (cpPts.length >= 2) {
            // Control polygon — Line2 for screen-space line width.
            const flat = [];
            cpPts.forEach((v) => flat.push(v.x, v.y, v.z));
            const cpGeom = new LineGeometry();
            cpGeom.setPositions(flat);
            const cpMat = new LineMaterial({
                color: 0x555555,
                linewidth: lineWidth,
                transparent: true,
                opacity: 0.85,
            });
            cpMat.resolution.set(window.innerWidth, window.innerHeight);
            this._lineMaterials.push(cpMat);
            const cpLine = new Line2(cpGeom, cpMat);
            cpLine.computeLineDistances();
            parent.add(cpLine);
        }

        // CP spheres — one small mesh per control point.
        const sphereGeom = new THREE.SphereGeometry(sphereRadius, 12, 10);
        const sphereMat = new THREE.MeshBasicMaterial({
            color: 0x222222,
            transparent: true,
            opacity: 0.9,
        });
        cpPts.forEach((p) => {
            const s = new THREE.Mesh(sphereGeom, sphereMat);
            s.position.copy(p);
            parent.add(s);
        });

        // NURBS curve evaluation.
        const degree = (typeof profile.degree === 'number') ? profile.degree : 3;
        let knots = Array.isArray(profile.knots) ? Array.from(profile.knots) : null;
        const numCPs = cpPts.length;
        if (!knots || knots.length === 0) {
            knots = [];
            for (let k = 0; k <= degree; k++) knots.push(0);
            for (let k = 1; k < numCPs - degree; k++) knots.push(k);
            for (let k = 0; k <= degree; k++) knots.push(Math.max(1, numCPs - degree));
        }
        try {
            const cps = cpsRaw.map(toVec4);
            const curve = new NURBSCurve(degree, knots, cps);
            const pts = curve.getPoints(80);
            const safe = pts.map((p) => (
                (isNaN(p.x) || isNaN(p.y) || isNaN(p.z))
                    ? new THREE.Vector3(0, 0, 0) : p
            ));
            const flat = [];
            safe.forEach((v) => flat.push(v.x, v.y, v.z));
            const geom = new LineGeometry();
            geom.setPositions(flat);
            const mat = new LineMaterial({
                color,
                linewidth: lineWidth * 1.4,
            });
            mat.resolution.set(window.innerWidth, window.innerHeight);
            this._lineMaterials.push(mat);
            const line = new Line2(geom, mat);
            line.computeLineDistances();
            parent.add(line);
        } catch (e) {
            console.error('TimelinePanel: failed to build NURBSCurve', e);
        }
    }

    _addGhostPolygon(parent, profile, _colorIndex, lineWidth) {
        if (!profile) return;
        const cpsRaw = profile.control_points || [];
        if (!Array.isArray(cpsRaw) || cpsRaw.length < 2) return;
        const toVec3 = (p) => {
            if (Array.isArray(p)) return new THREE.Vector3(p[0] || 0, p[1] || 0, p[2] || 0);
            return new THREE.Vector3(p.x || 0, p.y || 0, p.z || 0);
        };
        const cpPts = cpsRaw.map(toVec3);
        const flat = [];
        cpPts.forEach((v) => flat.push(v.x, v.y, v.z));
        const geom = new LineGeometry();
        geom.setPositions(flat);
        const mat = new LineMaterial({
            color: GHOST_COLOR,
            linewidth,
            transparent: true,
            opacity: 0.25,
        });
        mat.resolution.set(window.innerWidth, window.innerHeight);
        this._lineMaterials.push(mat);
        const line = new Line2(geom, mat);
        line.computeLineDistances();
        parent.add(line);
    }

    // ---- bbox / camera ---------------------------------------------------

    _measureSceneBbox(includeCurrent, includeGhost) {
        const bbox = new THREE.Box3();
        const tmp = new THREE.Vector3();
        const collect = (group) => {
            if (!group || !group.visible) return;
            group.traverse((obj) => {
                if (!obj.geometry) return;
                const pos = obj.geometry.attributes && obj.geometry.attributes.position;
                if (!pos) return;
                obj.updateWorldMatrix(true, false);
                const m = obj.matrixWorld;
                for (let i = 0; i < pos.count; i++) {
                    tmp.fromBufferAttribute(pos, i).applyMatrix4(m);
                    if (Number.isFinite(tmp.x) && Number.isFinite(tmp.y) && Number.isFinite(tmp.z)) {
                        bbox.expandByPoint(tmp);
                    }
                }
            });
        };
        collect(this.skeletonGroup);
        if (includeCurrent) collect(this.currentGroup);
        if (includeGhost) collect(this.ghostGroup);
        return bbox;
    }

    _fitCameraToScene() {
        if (!this.camera || !this.controls) return;
        const bbox = this._measureSceneBbox(true, true);
        if (bbox.isEmpty()) {
            this.camera.position.set(8, 6, 12);
            this.controls.target.set(0, 0, 0);
            this.controls.update();
            return;
        }
        const center = bbox.getCenter(new THREE.Vector3());
        const size = bbox.getSize(new THREE.Vector3());
        const radius = Math.max(0.5, size.length() * 0.6);
        const dir = new THREE.Vector3(1, 0.8, 1.4).normalize();
        this.camera.position.copy(center).addScaledVector(dir, radius);
        this.camera.near = Math.max(0.001, radius / 1000);
        this.camera.far = Math.max(100, radius * 200);
        this.camera.updateProjectionMatrix();
        this.controls.target.copy(center);
        this.controls.update();
    }

    // ---- title / badges --------------------------------------------------

    _updateTitle() {
        if (this._steps.length === 0) {
            this._titleStepEl.textContent = 'No timeline data';
            this._titleDescEl.textContent = '';
            return;
        }
        const cur = this._steps[this._activeStep];
        const prev = (this._activeStep > 0) ? this._steps[this._activeStep - 1] : null;
        const curName = (cur && cur.step_name) ? cur.step_name : `step_${this._activeStep + 1}`;
        const prevName = prev ? (prev.step_name || `step_${this._activeStep}`) : null;
        this._titleStepEl.textContent = prevName
            ? `${prevName}  →  ${curName}`
            : curName;
        this._titleDescEl.textContent = (cur && cur.description) ? cur.description : '';
    }

    _updateDiffBadge() {
        if (this._steps.length === 0) {
            this._diffBadgeEl.textContent = '';
            return;
        }
        const diff = this._computeDiff(this._activeStep - 1, this._activeStep);
        const fmt = (v) => (v === null || v === undefined) ? '?' : String(v);
        const arrow = (a, b) => (a === b) ? `${fmt(a)}` : `${fmt(a)} → ${fmt(b)}`;
        const nCPDelta = (typeof diff.nCP_curr === 'number' && typeof diff.nCP_prev === 'number')
            ? diff.nCP_curr - diff.nCP_prev : null;
        const nCPBadge = (nCPDelta && nCPDelta > 0)
            ? `N_CP: ${arrow(diff.nCP_prev, diff.nCP_curr)} (Δ+${nCPDelta})`
            : `N_CP: ${arrow(diff.nCP_prev, diff.nCP_curr)}`;
        const parts = [
            `p: ${arrow(diff.degree_prev, diff.degree_curr)}`,
            nCPBadge,
            `knots.len: ${arrow(diff.knots_len_prev, diff.knots_len_curr)}`,
        ];
        this._diffBadgeEl.textContent = parts.join('  ·  ');
    }

    _updateNumericBadge() {
        if (this._steps.length === 0) {
            this._numericBadgeEl.textContent = '';
            return;
        }
        const cur = this._steps[this._activeStep];
        const profiles = Array.isArray(cur.profiles) ? cur.profiles : [];
        if (profiles.length === 0) {
            this._numericBadgeEl.textContent = 'No profiles';
            return;
        }
        const diff = this._computeDiff(this._activeStep - 1, this._activeStep);
        const lines = [];
        lines.push(`step ${this._activeStep + 1} / ${this._steps.length}`);
        lines.push(`profiles: ${profiles.length}`);
        lines.push(`p=${diff.degree_curr}  #CP=${diff.nCP_curr}  |knots|=${diff.knots_len_curr}`);
        if (this._ghostEnabled && this._activeStep > 0) {
            const dn = (diff.nCP_curr - diff.nCP_prev);
            const dk = (diff.knots_len_curr - diff.knots_len_prev);
            lines.push(`ghost Δ: #CP ${dn >= 0 ? '+' : ''}${dn}  |knots| ${dk >= 0 ? '+' : ''}${dk}`);
        }
        this._numericBadgeEl.textContent = lines.join('\n');
    }

    // ---- autoplay --------------------------------------------------------

    _startAutoplay() {
        if (this._autoplayRunning) return;
        if (this._steps.length === 0) return;
        this._autoplayRunning = true;
        if (this._playButton) {
            this._playButton.classList.add('playing');
            this._playButton.textContent = '❚❚ Pause';
        }
        this._autoplayTimer = setInterval(() => {
            const next = (this._activeStep + 1) % this._steps.length;
            this.setActiveStep(next);
        }, AUTOPLAY_INTERVAL_MS);
    }

    _stopAutoplay() {
        if (!this._autoplayRunning) return;
        this._autoplayRunning = false;
        if (this._autoplayTimer) {
            clearInterval(this._autoplayTimer);
            this._autoplayTimer = null;
        }
        if (this._playButton) {
            this._playButton.classList.remove('playing');
            this._playButton.textContent = '▶ Play';
        }
    }

    // ---- resize / keyboard ----------------------------------------------

    _wireResize() {
        this._onResize = () => {
            if (!this.renderer || !this.camera || !this._dom) return;
            const wrap = this._dom.canvasWrap;
            const rect = wrap.getBoundingClientRect();
            const w = Math.max(320, Math.floor(rect.width || window.innerWidth));
            const h = Math.max(240, Math.floor(rect.height || window.innerHeight - 140));
            this.camera.aspect = w / h;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(w, h, false);
            for (let i = 0; i < this._lineMaterials.length; i++) {
                this._lineMaterials[i].resolution.set(w, h);
            }
        };
        window.addEventListener('resize', this._onResize);
    }

    _unwireResize() {
        if (this._onResize) {
            window.removeEventListener('resize', this._onResize);
            this._onResize = null;
        }
    }

    _wireKeyboard() {
        this._onKey = (ev) => {
            // Only act when the timeline tab is the active workspace
            // tab. main.js toggles a CSS class on the tab strip; we
            // also accept the legacy 'timeline' data-tab as a fallback.
            if (!this._isTabActive()) return;
            if (this._steps.length === 0) return;
            if (ev.key === 'ArrowLeft') {
                this.setActiveStep(this._activeStep - 1);
                ev.preventDefault();
            } else if (ev.key === 'ArrowRight') {
                this.setActiveStep(this._activeStep + 1);
                ev.preventDefault();
            } else if (ev.key === ' ' || ev.code === 'Space') {
                this.toggleAutoplay();
                ev.preventDefault();
            }
        };
        window.addEventListener('keydown', this._onKey);
    }

    _unwireKeyboard() {
        if (this._onKey) {
            window.removeEventListener('keydown', this._onKey);
            this._onKey = null;
        }
    }

    _isTabActive() {
        if (typeof document === 'undefined') return true;
        const active = document.querySelector('.workspace-tab.active');
        if (!active) return true; // no tab strip → assume visible
        const tab = active.getAttribute('data-tab');
        return tab === 'timeline';
    }

    // ---- render loop -----------------------------------------------------

    _startLoop() {
        const tick = () => {
            if (!this._running) return;
            this._rafId = requestAnimationFrame(tick);
            if (this.controls) this.controls.update();
            if (this.renderer && this.scene && this.camera) {
                this.renderer.render(this.scene, this.camera);
            }
        };
        this._rafId = requestAnimationFrame(tick);
    }

    // ---- disposal helpers ------------------------------------------------

    _clearGroup(group) {
        if (!group) return;
        while (group.children.length > 0) {
            const child = group.children[0];
            group.remove(child);
            this._disposeObject3D(child);
        }
    }

    _disposeSceneResources() {
        // Clear per-step / ghost groups (the skeleton group is rebuilt
        // from options.spineGroup on _refreshSkeleton, so we just clear
        // it — _refreshSkeleton re-parents the host's children back in).
        this._clearGroup(this.currentGroup);
        this._clearGroup(this.ghostGroup);
        this._clearGroup(this.skeletonGroup);
        // Drop every LineMaterial we tracked so resolution handlers
        // don't keep references to disposed GPU resources.
        for (const lm of this._lineMaterials) lm.dispose();
        this._lineMaterials = [];
    }

    _disposeObject3D(obj) {
        if (!obj) return;
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
            if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
            else obj.material.dispose();
        }
        // Recurse (rare — most children are leaves).
        if (obj.children && obj.children.length > 0) {
            for (let i = obj.children.length - 1; i >= 0; i--) {
                this._disposeObject3D(obj.children[i]);
            }
        }
    }
}
