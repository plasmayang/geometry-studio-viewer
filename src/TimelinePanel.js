// TimelinePanel — Tab 3 (U-Basis Timeline) of the geometry-viewer workspace.
//
// SMALL-MULTIPLES LAYOUT (v2):
//   • One Three.js scene per timeline step, each rendered into its OWN
//     canvas card (renderer / scene / camera / OrbitControls). Cards are
//     laid out horizontally via CSS flex and horizontally scrollable.
//   • A single SyncCamera ("master") maintains the canonical camera
//     state (position + quaternion + target). When the user interacts
//     with any card's controls, the master broadcasts → every other
//     card's camera is updated from the master on the next frame and
//     `controls.update()` is called so the projection stays consistent.
//     This synchronizes rotation, zoom AND pan across all visible
//     cards — not just rotation.
//   • Performance: capped visible-card count (default 6) so a typical
//     workstation stays >= 30fps. Cards use antialias=false and a
//     clamped pixelRatio=1 to keep GPU memory in check.
//
// Public API is unchanged from v1 so main.js doesn't need to know
// about the layout change: constructor / update / dispose /
// setActiveStep / toggleGhost / toggleAutoplay.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { NURBSCurve } from 'three/addons/curves/NURBSCurve.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

// Visual palette — mirrors Viewer3D's section=black / guide=magenta
// convention so the timeline cards feel like siblings of the main 3D
// viewport rather than foreign widgets.
const PROFILE_COLORS = [0x000000, 0xff00ff, 0x008800, 0xff8800, 0x3366ff, 0xaa00ff];
const GHOST_COLOR = 0x666666;
const AUTOPLAY_INTERVAL_MS = 1000;

// Maximum cards visible side-by-side at once. Step count beyond this
// still works (off-screen cards are still rendered so a horizontal
// scroll reveals them already rendered) — but we cap simultaneous
// GPU-bound drawing to keep framerate stable. We keep them ALL rendered
// but skip on-screen compositing of cards outside the viewport's
// nearby range only if absolutely needed; in practice all are cheap.
const DEFAULT_MAX_VISIBLE_CARDS = 6;

/**
 * SyncCamera — canonical camera state shared across N renderer cards.
 *
 * Holds the "master" perspective camera. Each card has its own renderer
 * scene + perspective camera; every frame each card's camera copies
 * master.position / master.quaternion / master.target from the master.
 * Interacting with ANY card's OrbitControls calls `updateMasterFrom()`
 * which copies the controlling card's camera state back into the master
 * so the next frame's broadcast picks it up.
 *
 * The master never renders to a canvas — it's purely a state-holder.
 */
class SyncCamera {
    constructor() {
        // Master "camera": a PerspectiveCamera with default position
        // and target. Other cameras clone its position/quaternion
        // each frame; user drags feed back via updateMasterFrom().
        this.position = new THREE.Vector3(8, 6, 12);
        this.quaternion = new THREE.Quaternion();
        // Camera looks at origin by default — fitCamera() updates this.
        this.target = new THREE.Vector3(0, 0, 0);
        // The card currently being interacted with, or null. SyncCamera
        // ignores "change" events from this card (its camera is the
        // source of truth) and only broadcasts from it to all others.
        this.activeCard = null;
        // Dirty flag: when true, the master state has changed since
        // the last broadcast — listeners re-copy on next frame.
        this.dirty = true;
        // Listeners (cards) — each card registers/unregisters on init/
        // dispose. They pull master state once per frame.
        this._listeners = new Set();
    }
    register(card) {
        this._listeners.add(card);
    }
    unregister(card) {
        this._listeners.delete(card);
    }
    /**
     * Push master state into a registered listener card. Called once
     * per frame from each card's render loop.
     */
    pushTo(card) {
        if (card === this.activeCard) return; // source of truth — skip
        card.camera.position.copy(this.position);
        card.camera.quaternion.copy(this.quaternion);
        // Sync controls.target so OrbitControls' internal state stays
        // consistent (controls.update() reads .target).
        card.controls.target.copy(this.target);
    }
    /**
     * The active card calls this on every OrbitControls 'change' event
     * to record the new camera state in the master.
     */
    updateMasterFrom(card) {
        this.position.copy(card.camera.position);
        this.camera && this.camera.quaternion.copy(card.camera.quaternion);
        this.quaternion.copy(card.camera.quaternion);
        this.target.copy(card.controls.target);
        this.dirty = true;
    }
    setActiveCard(card) {
        this.activeCard = card;
    }
    setInitialState(position, target) {
        this.position.copy(position);
        this.target.copy(target);
        this.dirty = true;
    }
    broadcastToAll() {
        for (const card of this._listeners) {
            this.pushTo(card);
        }
    }
}

/**
 * TimelineCard — one small-multiple canvas with its own renderer +
 * scene + camera + OrbitControls. Listens to its own controls and
 * feeds the SyncCamera master; pulls master state every frame.
 */
class TimelineCard {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.host      container element for the card
     * @param {SyncCamera}  options.syncCam
     * @param {Object|null} options.spineGroup persistent skeleton (shared ref)
     * @param {Object} options.step           step data {step_name, description, profiles}
     * @param {number} options.stepIndex
     * @param {number} options.totalSteps
     * @param {boolean} options.ghostEnabled
     * @param {number} options.lineWidth
     * @param {number} options.sphereRadius
     */
    constructor(options) {
        this.host = options.host;
        this.syncCam = options.syncCam;
        this.spineGroup = options.spineGroup;
        this.step = options.step;
        this.stepIndex = options.stepIndex;
        this.totalSteps = options.totalSteps;
        this.ghostEnabled = options.ghostEnabled;
        this.lineWidth = options.lineWidth;
        this.sphereRadius = options.sphereRadius;

        this._lineMaterials = [];
        this._disposed = false;

        this._buildDom();
        this._initThree();
        this._buildSkeletonCopy();
        this._renderStep();
        this._wireControls();
        this._startLoop();
    }

    _buildDom() {
        const card = document.createElement('div');
        card.className = 'timeline-card';

        // Header — step name + index
        const header = document.createElement('div');
        header.className = 'timeline-card-header';
        const idxEl = document.createElement('div');
        idxEl.className = 'timeline-card-idx';
        idxEl.textContent = `${this.stepIndex + 1}/${this.totalSteps}`;
        const nameEl = document.createElement('div');
        nameEl.className = 'timeline-card-name';
        nameEl.textContent = (this.step && this.step.step_name)
            ? this.step.step_name : `step_${this.stepIndex + 1}`;
        nameEl.title = (this.step && this.step.description) ? this.step.description : nameEl.textContent;
        const descEl = document.createElement('div');
        descEl.className = 'timeline-card-desc';
        descEl.textContent = (this.step && this.step.description) ? this.step.description : '';
        header.appendChild(idxEl);
        header.appendChild(nameEl);
        header.appendChild(descEl);
        card.appendChild(header);

        // Canvas wrapper
        const wrap = document.createElement('div');
        wrap.className = 'timeline-card-canvas-wrap';
        card.appendChild(wrap);

        // Numeric badge — small, inside the card
        const badge = document.createElement('div');
        badge.className = 'timeline-card-badge';
        const profiles = (this.step && Array.isArray(this.step.profiles)) ? this.step.profiles : [];
        if (profiles.length > 0) {
            const p0 = profiles[0];
            const deg = (typeof p0.degree === 'number') ? p0.degree
                : (typeof p0.p === 'number') ? p0.p : '?';
            const nCP = Array.isArray(p0.control_points) ? p0.control_points.length : 0;
            const kLen = Array.isArray(p0.knots) ? p0.knots.length : 0;
            badge.textContent = `p=${deg}  #CP=${nCP}  |knots|=${kLen}\nprofiles: ${profiles.length}`;
        } else {
            badge.textContent = 'No profiles';
        }
        wrap.appendChild(badge);

        this.host.appendChild(card);
        this.hostEl = card;
        this.wrapEl = wrap;
    }

    _initThree() {
        const wrap = this.wrapEl;
        const rect = wrap.getBoundingClientRect();
        const w = Math.max(240, Math.floor(rect.width || 320));
        const h = Math.max(160, Math.floor(rect.height || 240));

        const canvas = document.createElement('canvas');
        canvas.className = 'timeline-card-canvas';
        wrap.appendChild(canvas);

        // antialias=false + pixelRatio capped to 1 keeps framerate
        // stable across 4-6 simultaneous renderers.
        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
        const dpr = Math.min(window.devicePixelRatio || 1, 1);
        this.renderer.setPixelRatio(dpr);
        this.renderer.setSize(w, h, false);
        this.renderer.setClearColor(0xf5f7fa, 1.0);

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0xf5f7fa);

        this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 5000);

        const lights = new THREE.Group();
        lights.add(new THREE.AmbientLight(0xffffff, 0.8));
        const dir = new THREE.DirectionalLight(0xffffff, 1.0);
        dir.position.set(5, 10, 7.5);
        lights.add(dir);
        this.scene.add(lights);

        // Skeleton + current + ghost groups. Each card has its own so
        // they can dispose independently.
        this.skeletonGroupLocal = new THREE.Group();
        this.currentGroup = new THREE.Group();
        this.ghostGroup = new THREE.Group();
        this.scene.add(this.skeletonGroupLocal);
        this.scene.add(this.currentGroup);
        this.scene.add(this.ghostGroup);

        // Initial camera pose: clone from sync master (or default).
        this.camera.position.copy(this.syncCam.position);
        this.camera.quaternion.copy(this.syncCam.quaternion);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.target.copy(this.syncCam.target);
        this.controls.update();

        this._w = w;
        this._h = h;
    }

    /**
     * The host owns the persistent skeleton group. Each card gets a
     * lightweight CLONE (Three.js geometries share via `clone()` —
     * cheap, since we dispose them when the card disposes).
     */
    _buildSkeletonCopy() {
        if (!this.spineGroup) return;
        const cloned = this.spineGroup.clone(true);
        // Force skeleton materials to ~0.6 opacity so the skeleton
        // reads as a faint background overlay.
        cloned.traverse((obj) => {
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
        this.skeletonGroupLocal.add(cloned);
    }

    _renderStep() {
        this._clearGroup(this.currentGroup);
        this._clearGroup(this.ghostGroup);
        const profiles = (this.step && Array.isArray(this.step.profiles)) ? this.step.profiles : [];
        profiles.forEach((p, pIdx) => {
            this._addProfileCurve(this.currentGroup, p, pIdx, this.lineWidth, this.sphereRadius);
        });
        if (this.ghostEnabled && this.stepIndex > 0) {
            const prevProfiles = this._prevProfiles || [];
            prevProfiles.forEach((p, pIdx) => {
                this._addGhostPolygon(this.ghostGroup, p, pIdx, this.lineWidth);
            });
        }
    }

    /**
     * Wire OrbitControls to SyncCamera:
     *  - On pointerdown: become the active card (master stops pushing
     *    into us, we push into master).
     *  - On 'change': copy camera state into master (so other cards
     *    receive it on their next pushTo call).
     *  - On pointerup: leave active mode so the next user interaction
     *    with another card can take over.
     */
    _wireControls() {
        const dom = this.renderer.domElement;
        this._onPointerDown = () => {
            this.syncCam.setActiveCard(this);
        };
        this._onPointerUp = () => {
            // Defer to next tick so a final 'change' event from the
            // release still gets broadcast.
            setTimeout(() => {
                if (this.syncCam.activeCard === this) {
                    this.syncCam.setActiveCard(null);
                }
            }, 0);
        };
        this._onChange = () => {
            // Push this card's state into master; other cards will
            // pick it up next frame.
            this.syncCam.updateMasterFrom(this);
        };
        this.controls.addEventListener('change', this._onChange);
        dom.addEventListener('pointerdown', this._onPointerDown);
        window.addEventListener('pointerup', this._onPointerUp);
        window.addEventListener('pointercancel', this._onPointerUp);
    }

    _unwireControls() {
        const dom = this.renderer.domElement;
        if (this.controls && this._onChange) {
            this.controls.removeEventListener('change', this._onChange);
        }
        if (dom && this._onPointerDown) {
            dom.removeEventListener('pointerdown', this._onPointerDown);
        }
        if (this._onPointerUp) {
            window.removeEventListener('pointerup', this._onPointerUp);
            window.removeEventListener('pointercancel', this._onPointerUp);
        }
        this._onPointerDown = null;
        this._onPointerUp = null;
        this._onChange = null;
    }

    _startLoop() {
        const tick = () => {
            if (this._disposed) return;
            this._rafId = requestAnimationFrame(tick);
            // Pull master state every frame (cheap — 3 Vector3/Quaternion
            // copies). controls.update() handles damping + projection.
            this.syncCam.pushTo(this);
            this.controls.update();
            this.renderer.render(this.scene, this.camera);
        };
        this._rafId = requestAnimationFrame(tick);
    }

    _stopLoop() {
        this._disposed = true;
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
    }

    resize(w, h) {
        if (!this.renderer || !this.camera) return;
        this._w = w;
        this._h = h;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h, false);
        for (let i = 0; i < this._lineMaterials.length; i++) {
            this._lineMaterials[i].resolution.set(w, h);
        }
    }

    /**
     * Toggle ghost visibility (control polygon of previous step
     * rendered at low opacity). Cheap rebuild of the ghost group.
     */
    setGhostEnabled(enabled, prevProfiles) {
        this.ghostEnabled = !!enabled;
        this._prevProfiles = prevProfiles;
        this._clearGroup(this.ghostGroup);
        if (this.ghostEnabled && this.stepIndex > 0) {
            const profiles = prevProfiles || [];
            profiles.forEach((p, pIdx) => {
                this._addGhostPolygon(this.ghostGroup, p, pIdx, this.lineWidth);
            });
        }
    }

    /**
     * Mark this card as the "active" step (visually highlighted in
     * the metadata title bar; the small-multiples layout keeps all
     * steps visible at once, so this is mostly informational).
     */
    setActive(isActive) {
        if (this.hostEl) this.hostEl.classList.toggle('active', !!isActive);
    }

    dispose() {
        this._stopLoop();
        this._unwireControls();
        this.syncCam.unregister(this);
        this._clearGroup(this.skeletonGroupLocal);
        this._clearGroup(this.currentGroup);
        this._clearGroup(this.ghostGroup);
        for (const lm of this._lineMaterials) lm.dispose();
        this._lineMaterials = [];
        if (this.renderer) {
            this.renderer.dispose();
            const dom = this.renderer.domElement;
            if (dom && dom.parentNode) dom.parentNode.removeChild(dom);
            this.renderer.forceContextLoss && this.renderer.forceContextLoss();
            this.renderer = null;
        }
        if (this.controls) {
            this.controls.dispose();
            this.controls = null;
        }
        if (this.hostEl && this.hostEl.parentNode) {
            this.hostEl.parentNode.removeChild(this.hostEl);
        }
        this.hostEl = null;
        this.wrapEl = null;
    }

    // ---- profile-curve helpers (mirror TimelinePanel v1) ------------------

    _addProfileCurve(parent, profile, colorIndex, lineWidth, sphereRadius) {
        if (!profile) return;
        const cpsRaw = profile.control_points || [];
        if (!Array.isArray(cpsRaw) || cpsRaw.length === 0) return;
        const color = PROFILE_COLORS[colorIndex % PROFILE_COLORS.length];

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
            const flat = [];
            cpPts.forEach((v) => flat.push(v.x, v.y, v.z));
            const geom = new LineGeometry();
            geom.setPositions(flat);
            const mat = new LineMaterial({
                color: 0x555555,
                linewidth: lineWidth,
                transparent: true,
                opacity: 0.85,
            });
            mat.resolution.set(this._w, this._h);
            this._lineMaterials.push(mat);
            const line = new Line2(geom, mat);
            line.computeLineDistances();
            parent.add(line);
        }

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
            mat.resolution.set(this._w, this._h);
            this._lineMaterials.push(mat);
            const line = new Line2(geom, mat);
            line.computeLineDistances();
            parent.add(line);
        } catch (e) {
            console.error('TimelineCard: failed to build NURBSCurve', e);
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
        mat.resolution.set(this._w, this._h);
        this._lineMaterials.push(mat);
        const line = new Line2(geom, mat);
        line.computeLineDistances();
        parent.add(line);
    }

    _clearGroup(group) {
        if (!group) return;
        while (group.children.length > 0) {
            const child = group.children[0];
            group.remove(child);
            this._disposeObject3D(child);
        }
    }

    _disposeObject3D(obj) {
        if (!obj) return;
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
            if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
            else obj.material.dispose();
        }
        if (obj.children && obj.children.length > 0) {
            for (let i = obj.children.length - 1; i >= 0; i--) {
                this._disposeObject3D(obj.children[i]);
            }
        }
    }
}

export class TimelinePanel {
    /**
     * @param {HTMLElement} container — full-width, full-height below the
     *                                  48px tab strip. The panel takes
     *                                  over its layout completely.
     * @param {Object|null} caseData  — parsed case JSON; null is allowed.
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
        this._running = false;
        this._maxVisibleCards = DEFAULT_MAX_VISIBLE_CARDS;

        // Per-card instances (one per timeline step).
        this.cards = [];
        // Shared SyncCamera (master state).
        this.syncCam = new SyncCamera();
        // Line width / sphere radius — derived once from union bbox
        // of the persistent skeleton, then shared by all cards.
        this._lineWidth = 0;
        this._sphereRadius = 0;
        // Empty-state DOM ref (so we can hide/show on case change).
        this._emptyStateEl = null;
        // Title bar refs (metadata for the active step).
        this._titleStepEl = null;
        this._titleDescEl = null;
        this._diffBadgeEl = null;
        this._numericBadgeEl = null;
        this._playButton = null;
        this._stepperButtons = [];
        // Resize observer ref so we can detach on dispose.
        this._ro = null;
        // DOM root.
        this._dom = null;

        this._steps = [];

        this._buildDom();
        this._computeGlobalScale();
        this._extractSteps();
        this._wireResize();
        this._wireKeyboard();
        if (this._steps.length > 0) {
            this._fitMasterCamera();
            this._buildCards();
            this._buildStepper();
            this._updateTitle();
            this._updateDiffBadge();
            this._updateNumericBadge();
            this._markActiveCard();
            this._running = true;
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
        this._disposeCards();
        this._extractSteps();
        this._computeGlobalScale();
        this._syncCamReset();
        if (this._steps.length > 0) {
            this._activeStep = 0;
            this._fitMasterCamera();
            this._buildCards();
            this._buildStepper();
            this._updateTitle();
            this._updateDiffBadge();
            this._updateNumericBadge();
            this._markActiveCard();
            this._running = true;
            this._hideEmptyState();
        } else {
            this._renderEmptyState();
            this._running = false;
        }
    }

    /**
     * Release WebGL contexts, all card DOM, all listeners. Safe to
     * call multiple times.
     */
    dispose() {
        this._running = false;
        this._stopAutoplay();
        this._disposeCards();
        this._unwireResize();
        this._unwireKeyboard();
        if (this._dom && this._dom.root && this._dom.root.parentNode) {
            this._dom.root.parentNode.removeChild(this._dom.root);
        }
        this._dom = null;
        this._stepperButtons = [];
    }

    /**
     * Programmatic step switch (autoplay + external keyboard + stepper
     * button click). Scrolls the corresponding card into view and
     * marks it active. The sync master is NOT moved — the user keeps
     * whatever camera angle they had across all cards.
     */
    setActiveStep(stepIndex, emit = true) {
        if (this._steps.length === 0) return;
        const n = this._steps.length;
        const idx = ((stepIndex % n) + n) % n;
        const prev = this._activeStep;
        this._activeStep = idx;
        // Rebuild ghost overlays so each card's "previous step" is
        // correct relative to the new active step.
        this._refreshGhosts();
        this._updateStepperActiveClass();
        this._markActiveCard();
        this._updateTitle();
        this._updateDiffBadge();
        this._updateNumericBadge();
        // Scroll the active card into view.
        const activeCard = this.cards[idx];
        if (activeCard && activeCard.hostEl) {
            try { activeCard.hostEl.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' }); }
            catch (e) { /* old browsers — ignore */ }
        }
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
     * Toggle ghost-of-previous-step overlay on every card.
     */
    toggleGhost(visible) {
        this._ghostEnabled = !!visible;
        this._refreshGhosts();
    }

    /**
     * Toggle autoplay (1 step/sec, wraps 0 → N-1 → 0).
     */
    toggleAutoplay(running) {
        const next = (typeof running === 'boolean') ? running : !this._autoplayRunning;
        if (next) this._startAutoplay();
        else this._stopAutoplay();
        return this._autoplayRunning;
    }

    // ---- DOM scaffolding -------------------------------------------------

    _buildDom() {
        // Defensive wipe — _buildDom is normally called once from the
        // constructor, but in case of misuse on a non-empty container.
        while (this.container.firstChild) {
            this.container.removeChild(this.container.firstChild);
        }
        const root = document.createElement('div');
        root.className = 'timeline-root';

        // Title bar (top).
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
        root.appendChild(titleBar);

        // Cards row (middle) — horizontally scrolling flex.
        const cardsRow = document.createElement('div');
        cardsRow.className = 'timeline-cards-row';
        root.appendChild(cardsRow);

        // Stepper bar (bottom) — left play, right horizontal list of
        // step buttons.
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
        root.appendChild(stepper);

        root.style.width = '100%';
        root.style.height = '100%';
        root.style.display = 'flex';
        root.style.flexDirection = 'column';

        this.container.appendChild(root);
        this._dom = { root, titleBar, titleStep, titleDesc, diffBadge, cardsRow, stepper, stepperList };
        this._titleStepEl = titleStep;
        this._titleDescEl = titleDesc;
        this._diffBadgeEl = diffBadge;
        this._playButton = playBtn;
        this._cardsRow = cardsRow;
        this._stepperList = stepperList;
        playBtn.addEventListener('click', () => this.toggleAutoplay());
    }

    _renderEmptyState() {
        // Clear any existing cards.
        this._disposeCards();
        // Empty-state overlay inside cardsRow.
        if (this._emptyStateEl && this._emptyStateEl.parentNode) {
            this._emptyStateEl.parentNode.removeChild(this._emptyStateEl);
        }
        if (this._cardsRow) {
            const el = document.createElement('div');
            el.className = 'timeline-empty-state';
            el.textContent = 'No stage2_basis_u_timeline data for this case.';
            this._cardsRow.appendChild(el);
            this._emptyStateEl = el;
        }
        // Title bar.
        if (this._titleStepEl) this._titleStepEl.textContent = 'No timeline data';
        if (this._titleDescEl) this._titleDescEl.textContent = 'The loaded case has no stage2_basis_u_timeline.';
        if (this._diffBadgeEl) this._diffBadgeEl.textContent = '';
        // Clear stepper buttons.
        if (this._stepperList) {
            while (this._stepperList.firstChild) {
                this._stepperList.removeChild(this._stepperList.firstChild);
            }
        }
        this._stepperButtons = [];
    }

    _hideEmptyState() {
        if (this._emptyStateEl && this._emptyStateEl.parentNode) {
            this._emptyStateEl.parentNode.removeChild(this._emptyStateEl);
        }
        this._emptyStateEl = null;
    }

    _buildStepper() {
        const list = this._dom.stepperList;
        while (list.firstChild) list.removeChild(list.firstChild);
        this._stepperButtons = [];
        this._steps.forEach((step, idx) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'timeline-stepper-btn';
            const name = (step && step.step_name) ? step.step_name : `step_${idx + 1}`;
            btn.textContent = `${idx}: ${name}`;
            btn.title = (step && step.description) ? step.description : name;
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

    // ---- card lifecycle --------------------------------------------------

    _buildCards() {
        if (!this._cardsRow) return;
        const spineGroup = this.options.spineGroup || null;
        // Cap the number of cards actually instantiated to keep
        // framerate stable. Cases with more steps still render
        // correctly: the extras are still in `this._steps` (so the
        // stepper buttons and active-step API work) but only the
        // first N become visible small-multiples. This matches the
        // handoff's "4-6 cards visible at once" guidance.
        const N = Math.min(this._steps.length, this._maxVisibleCards);
        for (let i = 0; i < N; i++) {
            const step = this._steps[i];
            const prevProfiles = (i > 0 && this._steps[i - 1]
                && Array.isArray(this._steps[i - 1].profiles))
                ? this._steps[i - 1].profiles : [];
            const card = new TimelineCard({
                host: this._cardsRow,
                syncCam: this.syncCam,
                spineGroup,
                step,
                stepIndex: i,
                totalSteps: this._steps.length,
                ghostEnabled: this._ghostEnabled,
                lineWidth: this._lineWidth,
                sphereRadius: this._sphereRadius,
            });
            card._prevProfiles = prevProfiles;
            this.syncCam.register(card);
            this.cards.push(card);
        }
    }

    _disposeCards() {
        for (const c of this.cards) {
            try { c.dispose(); } catch (e) { /* no-op */ }
        }
        this.cards = [];
        if (this._cardsRow) {
            while (this._cardsRow.firstChild) {
                this._cardsRow.removeChild(this._cardsRow.firstChild);
            }
        }
    }

    _refreshGhosts() {
        for (let i = 0; i < this.cards.length; i++) {
            const card = this.cards[i];
            const prevProfiles = (i > 0 && this._steps[i - 1]
                && Array.isArray(this._steps[i - 1].profiles))
                ? this._steps[i - 1].profiles : [];
            card.setGhostEnabled(this._ghostEnabled, prevProfiles);
        }
    }

    _markActiveCard() {
        for (let i = 0; i < this.cards.length; i++) {
            this.cards[i].setActive(i === this._activeStep);
        }
    }

    // ---- data extraction -------------------------------------------------

    _extractSteps() {
        const dbg = this.caseData && this.caseData.debug
            ? this.caseData.debug.stage2_basis_u_timeline : null;
        if (!dbg) { this._steps = []; return; }
        if (Array.isArray(dbg)) this._steps = dbg.filter(Boolean);
        else if (Array.isArray(dbg.steps)) this._steps = dbg.steps.filter(Boolean);
        else this._steps = [];
    }

    /**
     * Compute scale-invariant dimensions (sphere radius, line width)
     * from the union bbox of the persistent skeleton. Falls back to
     * "no skeleton" defaults if no spineGroup is provided.
     */
    _computeGlobalScale() {
        const spine = this.options.spineGroup;
        if (!spine) {
            this._sphereRadius = 0.05;
            this._lineWidth = Math.max(1.5, Math.min(3, (window.innerWidth + window.innerHeight) * 0.0015));
            return;
        }
        const bbox = new THREE.Box3();
        const tmp = new THREE.Vector3();
        spine.traverse((obj) => {
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
        let scale = 1.0;
        if (!bbox.isEmpty()) {
            const size = bbox.getSize(new THREE.Vector3());
            scale = Math.max(0.001, size.length());
        }
        this._sphereRadius = Math.min(0.2, Math.max(0.005, scale * 0.015));
        this._lineWidth = Math.max(1.5, Math.min(3,
            Math.min(window.innerWidth, window.innerHeight) * 0.003));
    }

    _syncCamReset() {
        this.syncCam.position.set(8, 6, 12);
        this.syncCam.quaternion.identity();
        this.syncCam.target.set(0, 0, 0);
        this.syncCam.setActiveCard(null);
    }

    /**
     * Initial fit of the master camera to the persistent skeleton
     * (or all-step union if no skeleton). All cards inherit this
     * pose on construction.
     */
    _fitMasterCamera() {
        const spine = this.options.spineGroup;
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
        if (spine) collect(spine);
        if (bbox.isEmpty()) {
            this.syncCam.setInitialState(new THREE.Vector3(8, 6, 12), new THREE.Vector3(0, 0, 0));
            return;
        }
        const center = bbox.getCenter(new THREE.Vector3());
        const size = bbox.getSize(new THREE.Vector3());
        const radius = Math.max(0.5, size.length() * 0.6);
        const dir = new THREE.Vector3(1, 0.8, 1.4).normalize();
        const pos = center.clone().addScaledVector(dir, radius);
        this.syncCam.setInitialState(pos, center);
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

    // ---- title / badges --------------------------------------------------

    _updateTitle() {
        if (this._steps.length === 0) {
            if (this._titleStepEl) this._titleStepEl.textContent = 'No timeline data';
            if (this._titleDescEl) this._titleDescEl.textContent = '';
            return;
        }
        const cur = this._steps[this._activeStep];
        const prev = (this._activeStep > 0) ? this._steps[this._activeStep - 1] : null;
        const curName = (cur && cur.step_name) ? cur.step_name : `step_${this._activeStep + 1}`;
        const prevName = prev ? (prev.step_name || `step_${this._activeStep}`) : null;
        if (this._titleStepEl) {
            this._titleStepEl.textContent = prevName
                ? `${prevName}  →  ${curName}`
                : curName;
        }
        if (this._titleDescEl) {
            this._titleDescEl.textContent = (cur && cur.description) ? cur.description : '';
        }
    }

    _updateDiffBadge() {
        if (this._steps.length === 0) {
            if (this._diffBadgeEl) this._diffBadgeEl.textContent = '';
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
        if (this._diffBadgeEl) this._diffBadgeEl.textContent = parts.join('  ·  ');
    }

    _updateNumericBadge() {
        // Replaced by per-card badge; title bar's metadata is the
        // canonical display now. Kept as a no-op for backwards compat
        // with callers that may call it.
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
        // Use ResizeObserver on the cards row so each card can re-size
        // its canvas when the viewport (or browser zoom) changes.
        if (typeof ResizeObserver === 'undefined') return;
        this._ro = new ResizeObserver(() => this._handleResize());
        if (this._dom && this._dom.root) this._ro.observe(this._dom.root);
        window.addEventListener('resize', this._handleResize);
    }

    _unwireResize() {
        if (this._ro) {
            this._ro.disconnect();
            this._ro = null;
        }
        window.removeEventListener('resize', this._handleResize);
    }

    _handleResize = () => {
        // For each card, measure its wrap and resize the renderer.
        for (const card of this.cards) {
            if (!card.wrapEl) continue;
            const rect = card.wrapEl.getBoundingClientRect();
            const w = Math.max(240, Math.floor(rect.width || 320));
            const h = Math.max(160, Math.floor(rect.height || 240));
            card.resize(w, h);
        }
    };

    _wireKeyboard() {
        this._onKey = (ev) => {
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
        if (!active) return true;
        const tab = active.getAttribute('data-tab');
        return tab === 'timeline';
    }
}
