// TimelinePanel — Tab 2 of the multi-tab geometry-viewer workspace.
//
// Renders a horizontally-scrolling card flow. Each card = one step in
// `case.debug.stage2_basis_u_timeline`. Each card owns its own
// THREE.WebGLRenderer + PerspectiveCamera so the small-multiples layout
// actually shows N independent viewports (the spec forbids sharing a
// single canvas). All cards share one OrbitControls instance — when the
// reviewer drags one card, the change event propagates the camera
// state (position + quaternion + zoom) to every other card on the same
// animation frame.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { NURBSCurve } from 'three/addons/curves/NURBSCurve.js';

const CARD_WIDTH = 360;
const CANVAS_WIDTH = 344;
const CANVAS_HEIGHT = 220;

// Profile palette — colors cycle through cards so multiple profiles in
// the same step stay distinguishable. Mirrors the existing
// Viewer3D.addNurbs curve color convention (section=black,
// guide=magenta) for visual consistency with the main viewer.
const PROFILE_COLORS = [0x000000, 0xff00ff, 0x008800, 0xff8800, 0x3366ff, 0xaa00ff];

export class TimelinePanel {
    /**
     * @param {HTMLElement} container — full-width horizontally-scrolling div.
     * @param {Object|null} caseData — case JSON; null is allowed (renders the empty-state message).
     */
    constructor(container, caseData) {
        this.container = container;
        this.caseData = caseData || null;
        this.cards = [];
        // One shared controls instance is created lazily on the first
        // card so the OrbitControls "controls.target" stays coherent
        // (every card shares the same world-space target).
        this.sharedControls = null;
        this._syncCameraState = null;
        this._running = true;
        this._build();
        if (this.cards.length > 0) {
            this._startLoop();
        }
    }

    /**
     * Re-render the panel with a new case. Old cards are disposed
     * (Three.js resources released) before the new build runs so we
     * don't leak WebGL contexts across case switches.
     */
    update(caseData) {
        this.dispose(true);
        this.caseData = caseData || null;
        this._running = true;
        this._build();
        if (this.cards.length > 0) {
            this._startLoop();
        }
    }

    _build() {
        // Clear any prior DOM children (the dispose path already removed
        // them, but a fresh build after the initial empty-state needs
        // to wipe the placeholder message).
        while (this.container.firstChild) {
            this.container.removeChild(this.container.firstChild);
        }

        const timeline = this.caseData && this.caseData.debug
            ? this.caseData.debug.stage2_basis_u_timeline
            : null;
        const steps = (timeline && Array.isArray(timeline.steps))
            ? timeline.steps
            : (Array.isArray(timeline) ? timeline : null);

        if (!Array.isArray(steps) || steps.length === 0) {
            this._renderEmptyState();
            return;
        }

        // Seed the shared OrbitControls with the first card's camera so
        // the controls' `target` and damping baseline are reasonable.
        // We construct the first card normally; subsequent cards copy
        // the camera state from the controls each frame.
        steps.forEach((step, idx) => {
            const prev = idx > 0 ? steps[idx - 1] : null;
            const card = this._buildCard(step, prev, idx, steps.length);
            this.cards.push(card);
            this.container.appendChild(card.root);
        });

        // Initialize shared controls on the FIRST card after all cards
        // exist, so subsequent drag events on any card drive the same
        // OrbitControls and the camera-sync propagator can read the
        // latest controls.update() state.
        if (this.cards.length > 0) {
            this.sharedControls = new OrbitControls(
                this.cards[0].camera,
                this.cards[0].renderer.domElement,
            );
            this.sharedControls.enableDamping = true;
            this._wireSharedControls();
        }
    }

    _renderEmptyState() {
        const msg = document.createElement('div');
        msg.className = 'timeline-empty-state';
        msg.textContent = 'No timeline data for this case.';
        this.container.appendChild(msg);
    }

    _buildCard(step, prev, index, total) {
        const root = document.createElement('div');
        root.className = 'timeline-card';
        root.style.width = `${CARD_WIDTH}px`;
        root.dataset.stepIndex = String(index);

        const header = document.createElement('header');
        header.className = 'timeline-card-header';
        const title = document.createElement('div');
        title.className = 'timeline-card-title';
        const curName = step.step_name || `step_${index + 1}`;
        const prevName = prev ? (prev.step_name || `step_${index}`) : null;
        title.textContent = prevName
            ? `${prevName}  →  ${curName}`
            : curName;
        const desc = document.createElement('div');
        desc.className = 'timeline-card-desc';
        desc.textContent = step.description || '';
        header.appendChild(title);
        header.appendChild(desc);
        root.appendChild(header);

        const meta = document.createElement('div');
        meta.className = 'timeline-card-meta';
        const firstProfile = (step.profiles && step.profiles[0]) || null;
        const degree = firstProfile ? (firstProfile.degree ?? '?') : '?';
        const nCPs = firstProfile
            ? (firstProfile.control_points || []).length
            : '?';
        meta.textContent = `step ${index + 1}/${total} · p=${degree} · #CP=${nCPs}`;
        root.appendChild(meta);

        const canvas = document.createElement('canvas');
        canvas.className = 'timeline-card-canvas';
        canvas.width = CANVAS_WIDTH;
        canvas.height = CANVAS_HEIGHT;
        canvas.style.width = `${CANVAS_WIDTH}px`;
        canvas.style.height = `${CANVAS_HEIGHT}px`;
        root.appendChild(canvas);

        const expandHint = document.createElement('div');
        expandHint.className = 'timeline-card-expand-hint';
        expandHint.textContent = 'Click to expand →';
        root.appendChild(expandHint);

        root.addEventListener('click', (ev) => {
            if (ev.target.closest('.timeline-card-canvas, .timeline-card-expand-hint')
                || ev.currentTarget === ev.target) {
                this._expandCard(index);
            }
        });

        const renderer = new THREE.WebGLRenderer({
            canvas,
            antialias: true,
        });
        renderer.setPixelRatio(window.devicePixelRatio || 1);
        renderer.setClearColor(0xf5f7fa, 1.0);

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0xfafafa);
        const ambient = new THREE.AmbientLight(0xffffff, 0.8);
        scene.add(ambient);
        const dir = new THREE.DirectionalLight(0xffffff, 1.0);
        dir.position.set(5, 10, 7.5);
        scene.add(dir);

        const camera = new THREE.PerspectiveCamera(
            45, CANVAS_WIDTH / CANVAS_HEIGHT, 0.1, 1000,
        );
        camera.position.set(5, 5, 10);

        const profiles = Array.isArray(step.profiles) ? step.profiles : [];
        const worldGroup = new THREE.Group();
        scene.add(worldGroup);
        profiles.forEach((p, pIdx) => {
            this._addProfileCurve(worldGroup, p, pIdx);
        });

        const bbox = new THREE.Box3().setFromObject(worldGroup);
        let radius = 5;
        if (!bbox.isEmpty()) {
            const size = bbox.getSize(new THREE.Vector3()).length();
            radius = Math.max(1, size * 0.6);
            const center = bbox.getCenter(new THREE.Vector3());
            camera.position.set(
                center.x + radius,
                center.y + radius,
                center.z + radius,
            );
            camera.lookAt(center);
        }

        return {
            root, canvas, renderer, scene, camera, worldGroup, radius,
            stepIndex: index, step, profiles,
        };
    }

    _addProfileCurve(parent, profile, colorIndex) {
        if (!profile) return;
        const cpsRaw = profile.control_points || [];
        if (!Array.isArray(cpsRaw) || cpsRaw.length === 0) return;
        const color = PROFILE_COLORS[colorIndex % PROFILE_COLORS.length];

        // control_points arrives as an array of {x, y, z, w} objects
        // (see Viewer3D.js _makePolylineFromDescriptor for the same
        // pattern). Map to Vector3 for the control polygon and to
        // Vector4 for the NURBS evaluator.
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
            const cpGeom = new THREE.BufferGeometry().setFromPoints(cpPts);
            const cpMat = new THREE.LineBasicMaterial({
                color: 0x999999,
                transparent: true,
                opacity: 0.5,
            });
            parent.add(new THREE.Line(cpGeom, cpMat));

            const cpPtsGeom = new THREE.BufferGeometry().setFromPoints(cpPts);
            const cpPtsMat = new THREE.PointsMaterial({
                color: 0x888888, size: 3, sizeAttenuation: false,
            });
            parent.add(new THREE.Points(cpPtsGeom, cpPtsMat));
        }

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
            const safePts = pts.map((p) => (
                (isNaN(p.x) || isNaN(p.y) || isNaN(p.z))
                    ? new THREE.Vector3(0, 0, 0)
                    : p
            ));
            const geom = new THREE.BufferGeometry().setFromPoints(safePts);
            const mat = new THREE.LineBasicMaterial({ color });
            parent.add(new THREE.Line(geom, mat));
        } catch (e) {
            console.error('TimelinePanel: failed to build NURBSCurve', e);
        }
    }

    _wireSharedControls() {
        const ctrl = this.sharedControls;
        if (!ctrl) return;
        // When OrbitControls fires 'change' (camera state mutated by
        // user drag/zoom/pan), copy the new state to every card's
        // camera in the same animation frame. This is the
        // small-multiples standard pattern: one set of controls drives
        // N synced cameras.
        this._syncCameraState = () => {
            if (!this._running) return;
            const src = this.cards[0].camera;
            for (let i = 1; i < this.cards.length; i++) {
                const dst = this.cards[i].camera;
                dst.position.copy(src.position);
                dst.quaternion.copy(src.quaternion);
                dst.zoom = src.zoom;
                dst.updateProjectionMatrix();
            }
        };
        ctrl.addEventListener('change', this._syncCameraState);
        // Override each card's pointer events so any pointer-down on
        // any card re-targets the shared controls to that card's
        // renderer.domElement. Without this, dragging card B doesn't
        // activate the controls (they're listening only on card A's
        // canvas).
        this.cards.forEach((card) => {
            const el = card.renderer.domElement;
            el.addEventListener('pointerdown', () => {
                if (!this.sharedControls) return;
                this.sharedControls.dispose();
                this.sharedControls = new OrbitControls(
                    card.camera, card.renderer.domElement,
                );
                this.sharedControls.enableDamping = true;
                this.sharedControls.target.copy(ctrl.target);
                this.sharedControls.addEventListener('change', this._syncCameraState);
                // Sync other cards to this card's camera immediately
                // (otherwise they stay locked to whatever the previous
                // controls dragged).
                for (let i = 0; i < this.cards.length; i++) {
                    if (this.cards[i] === card) continue;
                    this.cards[i].camera.position.copy(card.camera.position);
                    this.cards[i].camera.quaternion.copy(card.camera.quaternion);
                    this.cards[i].camera.zoom = card.camera.zoom;
                    this.cards[i].camera.updateProjectionMatrix();
                }
            });
        });
    }

    _expandCard(stepIndex) {
        const card = this.cards[stepIndex];
        if (!card || this._expandedOverlay) return;

        const overlay = document.createElement('div');
        overlay.className = 'timeline-card-overlay';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'timeline-card-overlay-close';
        closeBtn.textContent = '× Close';
        closeBtn.setAttribute('aria-label', 'Close expanded view');
        overlay.appendChild(closeBtn);

        const titleBar = document.createElement('div');
        titleBar.className = 'timeline-card-overlay-title';
        const total = this.cards.length;
        const prev = stepIndex > 0 ? this.cards[stepIndex - 1].step : null;
        const cur = card.step;
        const curName = cur.step_name || `step_${stepIndex + 1}`;
        const prevName = prev ? (prev.step_name || `step_${stepIndex}`) : null;
        titleBar.textContent = prevName
            ? `${prevName}  →  ${curName}    (step ${stepIndex + 1}/${total})`
            : `${curName}    (step ${stepIndex + 1}/${total})`;
        overlay.appendChild(titleBar);

        const overlayCanvas = document.createElement('canvas');
        overlayCanvas.className = 'timeline-card-overlay-canvas';
        overlay.appendChild(overlayCanvas);

        document.body.appendChild(overlay);
        this._expandedOverlay = overlay;

        // getBoundingClientRect (not clientWidth) because flex children
        // are 0×0 until first paint.
        const computeSize = () => {
            const rect = overlayCanvas.getBoundingClientRect();
            return {
                w: Math.max(320, Math.floor(rect.width || (window.innerWidth - 64))),
                h: Math.max(180, Math.floor(rect.height || (window.innerHeight - 160))),
            };
        };

        let { w, h } = computeSize();
        overlayCanvas.width = w;
        overlayCanvas.height = h;

        const ovRenderer = new THREE.WebGLRenderer({
            canvas: overlayCanvas,
            antialias: true,
        });
        ovRenderer.setPixelRatio(window.devicePixelRatio || 1);
        ovRenderer.setSize(w, h, false);
        ovRenderer.setClearColor(0xfafafa, 1.0);

        const ovScene = new THREE.Scene();
        ovScene.background = new THREE.Color(0xfafafa);
        ovScene.add(new THREE.AmbientLight(0xffffff, 0.8));
        const ovDir = new THREE.DirectionalLight(0xffffff, 1.0);
        ovDir.position.set(5, 10, 7.5);
        ovScene.add(ovDir);

        const ovCamera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);

        const worldGroup = new THREE.Group();
        ovScene.add(worldGroup);
        card.profiles.forEach((p, pIdx) => {
            this._addProfileCurve(worldGroup, p, pIdx);
        });

        // Manual bbox: Box3.setFromObject returns empty for Line / Points
        // because those primitives don't auto-compute boundingBox.
        const manualBbox = new THREE.Box3();
        const tmpV = new THREE.Vector3();
        worldGroup.traverse((obj) => {
            const posAttr = obj.geometry && obj.geometry.attributes
                ? obj.geometry.attributes.position : null;
            if (!posAttr) return;
            obj.updateWorldMatrix(true, false);
            const m = obj.matrixWorld;
            for (let i = 0; i < posAttr.count; i++) {
                tmpV.fromBufferAttribute(posAttr, i).applyMatrix4(m);
                manualBbox.expandByPoint(tmpV);
            }
        });

        let center = new THREE.Vector3(0, 0, 0);
        if (!manualBbox.isEmpty()) {
            center = manualBbox.getCenter(new THREE.Vector3());
            const sizeLen = manualBbox.getSize(new THREE.Vector3()).length();
            const radius = Math.max(1, sizeLen * 0.6);
            ovCamera.position.set(
                center.x + radius,
                center.y + radius,
                center.z + radius,
            );
        } else {
            ovCamera.position.set(5, 5, 10);
        }
        ovCamera.lookAt(center);
        ovCamera.updateProjectionMatrix();

        const ovControls = new OrbitControls(ovCamera, overlayCanvas);
        ovControls.enableDamping = true;
        ovControls.target.copy(center);
        ovControls.update();

        const onResize = () => {
            const { w: nw, h: nh } = computeSize();
            overlayCanvas.width = nw;
            overlayCanvas.height = nh;
            ovCamera.aspect = nw / nh;
            ovCamera.updateProjectionMatrix();
            ovRenderer.setSize(nw, nh, false);
        };
        window.addEventListener('resize', onResize);

        // Re-resize after first paint in case flex layout settled late.
        requestAnimationFrame(() => {
            const { w: nw, h: nh } = computeSize();
            if (nw !== w || nh !== h) {
                overlayCanvas.width = nw;
                overlayCanvas.height = nh;
                ovCamera.aspect = nw / nh;
                ovCamera.updateProjectionMatrix();
                ovRenderer.setSize(nw, nh, false);
            }
        });

        let rafRunning = true;
        const tick = () => {
            if (!rafRunning) return;
            requestAnimationFrame(tick);
            ovControls.update();
            ovRenderer.render(ovScene, ovCamera);
        };
        tick();

        const close = () => {
            rafRunning = false;
            window.removeEventListener('resize', onResize);
            ovControls.dispose();
            worldGroup.traverse((obj) => {
                if (obj.geometry) obj.geometry.dispose();
                if (obj.material) {
                    if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
                    else obj.material.dispose();
                }
            });
            ovRenderer.dispose();
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            this._expandedOverlay = null;
        };

        closeBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            close();
        });
        overlay.addEventListener('click', (ev) => {
            if (ev.target === overlay) close();
        });
        const escHandler = (ev) => {
            if (ev.key === 'Escape') close();
        };
        document.addEventListener('keydown', escHandler);
        overlay._escHandler = escHandler;
    }

    _startLoop() {
        const tick = () => {
            if (!this._running) return;
            this._rafId = requestAnimationFrame(tick);
            if (this.sharedControls) this.sharedControls.update();
            for (const card of this.cards) {
                card.renderer.render(card.scene, card.camera);
            }
        };
        this._rafId = requestAnimationFrame(tick);
    }

    /**
     * Tear down the panel. `keepDom` is true during internal
     * case-switches so the container can be cleared by _build();
     * main.js passes false (default) when switching tabs.
     */
    dispose(keepDom = false) {
        this._running = false;
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
        if (this.sharedControls) {
            this.sharedControls.dispose();
            this.sharedControls = null;
        }
        this._syncCameraState = null;
        if (this._expandedOverlay) {
            if (this._expandedOverlay._escHandler) {
                document.removeEventListener('keydown', this._expandedOverlay._escHandler);
            }
            if (this._expandedOverlay.parentNode) {
                this._expandedOverlay.parentNode.removeChild(this._expandedOverlay);
            }
            this._expandedOverlay = null;
        }
        for (const card of this.cards) {
            if (card.renderer) {
                card.renderer.dispose();
                // dispose() frees the WebGL context but leaves the
                // canvas attached to its parent — we remove the entire
                // card root instead.
            }
            if (card.worldGroup) {
                card.worldGroup.traverse(obj => {
                    if (obj.geometry) obj.geometry.dispose();
                    if (obj.material) {
                        if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
                        else obj.material.dispose();
                    }
                });
            }
            if (card.root && card.root.parentNode && !keepDom) {
                card.root.parentNode.removeChild(card.root);
            }
        }
        this.cards = [];
        if (!keepDom && this.container) {
            while (this.container.firstChild) {
                this.container.removeChild(this.container.firstChild);
            }
        }
    }
}
