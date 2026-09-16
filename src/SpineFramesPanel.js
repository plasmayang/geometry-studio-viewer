// SpineFramesPanel — Tab 4 (Spine & Moving Frames) of the
// geometry-viewer workspace.
//
// Owns its own WebGLRenderer / Scene / PerspectiveCamera /
// OrbitControls. Renders four overlays over a shared skeleton:
//
//   - skeletonGroup  : Profiles + Spine + Guides (provided by main.js
//                      via options.skeletonGroup; rendered at lower
//                      opacity as a faint reference background).
//   - stationsGroup  : one small sphere at each frame.origin; visible
//                      by default. Highlight dimming is implemented by
//                      multiplying opacity per-station when a single
//                      station is selected.
//   - framesGroup    : three ArrowHelpers per station (T red, N green,
//                      B blue); visible by default.
//   - planesGroup    : one rectangle per station in the N-B plane;
//                      visible by default. Scales uniformly with the
//                      plane-scale slider.
//   - ribbonGroup    : continuous triangle-strip connecting
//                      (origin_k ± d * N_k) → (origin_{k+1} ± d * N_{k+1})
//                      using the normal direction as the twist ribbon;
//                      visible by default.
//
// All dimensions derive from `L_ref`, a scale-invariant base length
// computed from the scene bbox so the visualization reads correctly
// on millimeter- and meter-scale cases alike.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const COLOR_T = 0xff3344;
const COLOR_N = 0x33cc66;
const COLOR_B = 0x3366ff;
const COLOR_PLANE = 0xeeeeee;
const COLOR_PLANE_EDGE = 0x666666;
const COLOR_RIBBON = 0x00aa88;
const COLOR_STATION = 0x222222;
const NON_HIGHLIGHTED_OPACITY = 0.15;

export class SpineFramesPanel {
    /**
     * @param {HTMLElement} container — full-width container below the
     *                                  tab strip. Mounts the panel's
     *                                  internal viewport + side-panel
     *                                  layout inside it.
     * @param {Object|null} caseData  — parsed case JSON (any shape);
     *                                  SpineFramesPanel only reads
     *                                  `case.debug.stage3_spine_frames`.
     * @param {Object} options        — { skeletonGroup, geometryParser }.
     *                                  skeletonGroup may be null (panel
     *                                  still works, just renders no
     *                                  reference skeleton).
     */
    constructor(container, caseData, options = {}) {
        this.container = container;
        this.caseData = caseData || null;
        this.options = options || {};
        this._skeletonGroup = (this.options.skeletonGroup) || null;
        this._parser = this.options.geometryParser || null;

        this._running = false;
        this._rafId = null;

        this._layerVisible = {
            frames: true,
            planes: true,
            ribbon: true,
            stations: true,
        };
        this._planeScale = 1.0;
        this._highlightedStation = null;

        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.lightsGroup = null;

        this.stationsGroup = null;
        this.framesGroup = null;
        this.planesGroup = null;
        this.ribbonGroup = null;
        this.skeletonShadow = null;

        this._frames = [];
        this._stationMeshes = [];
        this._frameArrows = [];
        this._planeMeshes = [];
        this._planeOutlines = [];
        this._planeGrids = [];
        this._ribbonMesh = null;

        this._buildDom();
        this._initThree();
        this._refreshSkeleton();
        this._applyData(this.caseData);
        this._wireResize();
        this._startLoop();
    }

    // ---- public API ------------------------------------------------------

    update(newCaseData) {
        this.caseData = newCaseData || null;
        this._highlightedStation = null;
        this._applyData(this.caseData);
    }

    dispose() {
        this._running = false;
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
        this._unwireResize();
        this._clearVizGroups();
        if (this.skeletonShadow) {
            this._disposeObject3D(this.skeletonShadow);
            this.scene.remove(this.skeletonShadow);
            this.skeletonShadow = null;
        }
        if (this.renderer) {
            this.renderer.dispose();
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
        this._stationMeshes = [];
        this._frameArrows = [];
        this._planeMeshes = [];
        this._planeOutlines = [];
        this._planeGrids = [];
        this._ribbonMesh = null;
        this._frames = [];
    }

    setStationHighlight(idx) {
        if (idx === null || idx === undefined) {
            this._highlightedStation = null;
        } else if (typeof idx === 'number' && idx >= 0 && idx < this._stationMeshes.length) {
            this._highlightedStation = idx;
        } else {
            return;
        }
        this._applyHighlight();
    }

    setPlaneScale(multiplier) {
        const m = Number.isFinite(multiplier) ? multiplier : 1.0;
        this._planeScale = m;
        this._rebuildPlanes();
        this._applyHighlight();
    }

    toggleLayer(name, visible) {
        if (!(name in this._layerVisible)) return;
        this._layerVisible[name] = !!visible;
        if (this.stationsGroup) this.stationsGroup.visible = this._layerVisible.stations;
        if (this.framesGroup) this.framesGroup.visible = this._layerVisible.frames;
        if (this.planesGroup) this.planesGroup.visible = this._layerVisible.planes;
        if (this.ribbonGroup) this.ribbonGroup.visible = this._layerVisible.ribbon;
    }

    getFrameCount() {
        return this._frames.length;
    }

    // ---- DOM scaffolding -------------------------------------------------

    _buildDom() {
        while (this.container.firstChild) {
            this.container.removeChild(this.container.firstChild);
        }

        const root = document.createElement('div');
        root.className = 'spine-frames-panel';

        const viewport = document.createElement('div');
        viewport.className = 'spine-frames-viewport';
        viewport.id = 'spine-frames-viewport';

        const sidePanel = document.createElement('div');
        sidePanel.className = 'spine-frames-side-panel';
        sidePanel.id = 'spine-frames-side-panel';

        root.appendChild(viewport);
        root.appendChild(sidePanel);

        root.style.width = '100%';
        root.style.height = '100%';
        root.style.display = 'flex';
        root.style.flexDirection = 'row';
        viewport.style.flex = '1 1 auto';
        viewport.style.position = 'relative';
        viewport.style.minWidth = '0';
        viewport.style.minHeight = '0';
        sidePanel.style.flex = '0 0 320px';
        sidePanel.style.maxWidth = '320px';

        this.container.appendChild(root);
        this._dom = { root, viewport, sidePanel };
    }

    // ---- Three.js scaffolding --------------------------------------------

    _initThree() {
        const wrap = this._dom.viewport;
        const rect = wrap.getBoundingClientRect();
        const w = Math.max(320, Math.floor(rect.width || window.innerWidth));
        const h = Math.max(240, Math.floor(rect.height || window.innerHeight - 140));

        const canvas = document.createElement('canvas');
        canvas.className = 'spine-frames-canvas';
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

        this.stationsGroup = new THREE.Group();
        this.stationsGroup.name = 'spineFrames.stations';
        this.scene.add(this.stationsGroup);

        this.framesGroup = new THREE.Group();
        this.framesGroup.name = 'spineFrames.frames';
        this.scene.add(this.framesGroup);

        this.planesGroup = new THREE.Group();
        this.planesGroup.name = 'spineFrames.planes';
        this.scene.add(this.planesGroup);

        this.ribbonGroup = new THREE.Group();
        this.ribbonGroup.name = 'spineFrames.ribbon';
        this.scene.add(this.ribbonGroup);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.target.set(0, 0, 0);
        this.controls.update();
    }

    _wireResize() {
        this._onResize = () => {
            if (!this.renderer || !this.camera || !this._dom) return;
            const wrap = this._dom.viewport;
            const rect = wrap.getBoundingClientRect();
            const w = Math.max(320, Math.floor(rect.width || window.innerWidth));
            const h = Math.max(240, Math.floor(rect.height || window.innerHeight - 140));
            this.camera.aspect = w / h;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(w, h, false);
        };
        window.addEventListener('resize', this._onResize);
    }

    _unwireResize() {
        if (this._onResize) {
            window.removeEventListener('resize', this._onResize);
            this._onResize = null;
        }
    }

    // ---- data extraction -------------------------------------------------

    _extractFrames(caseData) {
        if (!this._parser || typeof this._parser.parseDebug !== 'function') return [];
        let dbg = null;
        try {
            dbg = this._parser.parseDebug(caseData);
        } catch (e) {
            return [];
        }
        const env = (dbg && dbg.stage3_spine_frames) ? dbg.stage3_spine_frames : null;
        if (!env || !Array.isArray(env.frames)) return [];
        const out = [];
        for (const f of env.frames) {
            if (!f) continue;
            const origin = Array.isArray(f.origin) ? f.origin : null;
            const tangent = Array.isArray(f.tangent) ? f.tangent : null;
            const normal = Array.isArray(f.normal) ? f.normal : null;
            const binormal = Array.isArray(f.binormal) ? f.binormal : null;
            if (!origin || !tangent || !normal || !binormal) continue;
            if (![origin, tangent, normal, binormal].every(
                (v) => Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2])
            )) continue;
            out.push({
                v: (typeof f.v === 'number') ? f.v : out.length,
                origin, tangent, normal, binormal,
            });
        }
        return out;
    }

    // ---- skeleton (persistent reference background) ----------------------

    _refreshSkeleton() {
        if (this.skeletonShadow) {
            this._disposeObject3D(this.skeletonShadow);
            this.scene.remove(this.skeletonShadow);
            this.skeletonShadow = null;
        }
        const provided = this._skeletonGroup;
        if (!provided || !provided.children || provided.children.length === 0) return;
        const shadow = new THREE.Group();
        shadow.name = 'spineFrames.skeletonShadow';
        for (const child of provided.children) {
            shadow.add(child.clone(true));
        }
        shadow.traverse((obj) => {
            if (!obj.material) return;
            const apply = (m) => {
                if (!m) return;
                if ('opacity' in m) {
                    m.transparent = true;
                    m.opacity = 0.35;
                    m.depthWrite = false;
                }
            };
            if (Array.isArray(obj.material)) obj.material.forEach(apply);
            else apply(obj.material);
        });
        this.skeletonShadow = shadow;
        this.scene.add(shadow);
    }

    // ---- data → visualization --------------------------------------------

    _applyData(caseData) {
        this._clearVizGroups();
        const frames = this._extractFrames(caseData);
        this._frames = frames;
        if (frames.length === 0) {
            this._fitCameraToFallback();
            return;
        }

        const lRef = this._computeLRef();
        const sphereRadius = lRef * 0.3;
        const sphereGeom = new THREE.SphereGeometry(sphereRadius, 12, 10);
        const sphereMat = new THREE.MeshBasicMaterial({
            color: COLOR_STATION,
            transparent: true,
            opacity: 0.9,
        });

        frames.forEach((f, idx) => {
            const sphere = new THREE.Mesh(sphereGeom, sphereMat);
            sphere.position.set(f.origin[0], f.origin[1], f.origin[2]);
            sphere.userData = { kind: 'spine_station', idx };
            this.stationsGroup.add(sphere);
            this._stationMeshes.push(sphere);

            this._addFrameArrows(f, lRef);
        });

        this._rebuildPlanes();
        this._rebuildRibbon();

        this._applyLayerVisibility();
        this._fitCameraToScene();
        this._applyHighlight();
    }

    _addFrameArrows(frame, lRef) {
        const origin = new THREE.Vector3(frame.origin[0], frame.origin[1], frame.origin[2]);
        const tangentV = new THREE.Vector3(frame.tangent[0], frame.tangent[1], frame.tangent[2]);
        const normalV = new THREE.Vector3(frame.normal[0], frame.normal[1], frame.normal[2]);
        const binormalV = new THREE.Vector3(frame.binormal[0], frame.binormal[1], frame.binormal[2]);

        const tangentDir = tangentV.clone().normalize();
        const normalDir = normalV.clone().normalize();
        const binormalDir = binormalV.clone().normalize();

        const tArrow = new THREE.ArrowHelper(tangentDir, origin, lRef * 1.0, COLOR_T, lRef * 0.2, lRef * 0.1);
        const nArrow = new THREE.ArrowHelper(normalDir, origin, lRef * 0.8, COLOR_N, lRef * 0.16, lRef * 0.08);
        const bArrow = new THREE.ArrowHelper(binormalDir, origin, lRef * 0.8, COLOR_B, lRef * 0.16, lRef * 0.08);
        this.framesGroup.add(tArrow);
        this.framesGroup.add(nArrow);
        this.framesGroup.add(bArrow);
        this._frameArrows.push({ t: tArrow, n: nArrow, b: bArrow });
    }

    _rebuildPlanes() {
        for (const m of this._planeMeshes) {
            this.planesGroup.remove(m);
            this._disposeObject3D(m);
        }
        for (const ls of this._planeOutlines) {
            this.planesGroup.remove(ls);
            this._disposeObject3D(ls);
        }
        for (const lg of this._planeGrids) {
            this.planesGroup.remove(lg);
            this._disposeObject3D(lg);
        }
        this._planeMeshes = [];
        this._planeOutlines = [];
        this._planeGrids = [];

        if (this._frames.length === 0) return;

        const lRef = this._computeLRef();
        const halfW = lRef * this._planeScale;
        const halfH = lRef * this._planeScale;
        const planeGeom = new THREE.PlaneGeometry(halfW * 2, halfH * 2);

        const planeMat = new THREE.MeshBasicMaterial({
            color: COLOR_PLANE,
            transparent: true,
            opacity: 0.25,
            side: THREE.DoubleSide,
        });

        const edgeMat = new THREE.LineBasicMaterial({ color: COLOR_PLANE_EDGE });

        this._frames.forEach((f, idx) => {
            const origin = new THREE.Vector3(f.origin[0], f.origin[1], f.origin[2]);
            const nDir = new THREE.Vector3(f.normal[0], f.normal[1], f.normal[2]).normalize();
            const bDir = new THREE.Vector3(f.binormal[0], f.binormal[1], f.binormal[2]).normalize();

            const plane = new THREE.Mesh(planeGeom, planeMat);
            plane.position.copy(origin);
            // PlaneGeometry lies in the XY plane; rotate so its surface
            // spans the N-B plane. Use a quaternion from the default
            // (0,0,1) toward N.
            const defaultNormal = new THREE.Vector3(0, 0, 1);
            const quat = new THREE.Quaternion().setFromUnitVectors(defaultNormal, nDir);
            plane.quaternion.copy(quat);
            plane.userData = { kind: 'sampling_plane', idx };
            this.planesGroup.add(plane);
            this._planeMeshes.push(plane);

            const outlineGeom = new THREE.BufferGeometry();
            const corners = [
                -halfW * bDir.x - halfH * nDir.x,
                -halfW * bDir.y - halfH * nDir.y,
                -halfW * bDir.z - halfH * nDir.z,
                halfW * bDir.x - halfH * nDir.x,
                halfW * bDir.y - halfH * nDir.y,
                halfW * bDir.z - halfH * nDir.z,
                halfW * bDir.x + halfH * nDir.x,
                halfW * bDir.y + halfH * nDir.y,
                halfW * bDir.z + halfH * nDir.z,
                -halfW * bDir.x + halfH * nDir.x,
                -halfW * bDir.y + halfH * nDir.y,
                -halfW * bDir.z + halfH * nDir.z,
                -halfW * bDir.x - halfH * nDir.x,
                -halfW * bDir.y - halfH * nDir.y,
                -halfW * bDir.z - halfH * nDir.z,
            ];
            outlineGeom.setAttribute(
                'position',
                new THREE.Float32BufferAttribute(corners, 3)
            );
            const outline = new THREE.LineSegments(outlineGeom, edgeMat);
            outline.position.copy(origin);
            outline.userData = { kind: 'plane_outline', idx };
            this.planesGroup.add(outline);
            this._planeOutlines.push(outline);

            const gridPositions = [];
            const gridDivisions = 4;
            const stepW = (halfW * 2) / gridDivisions;
            const stepH = (halfH * 2) / gridDivisions;
            for (let i = 1; i < gridDivisions; i++) {
                const t = -halfW + i * stepW;
                for (let s = -halfH; s < halfH; s += halfH * 0.5) {
                    gridPositions.push(
                        t * bDir.x + s * nDir.x + origin.x,
                        t * bDir.y + s * nDir.y + origin.y,
                        t * bDir.z + s * nDir.z + origin.z,
                        t * bDir.x + (s + halfH * 0.5) * nDir.x + origin.x,
                        t * bDir.y + (s + halfH * 0.5) * nDir.y + origin.y,
                        t * bDir.z + (s + halfH * 0.5) * nDir.z + origin.z,
                    );
                }
            }
            for (let i = 1; i < gridDivisions; i++) {
                const s = -halfH + i * stepH;
                for (let t = -halfW; t < halfW; t += halfW * 0.5) {
                    gridPositions.push(
                        t * bDir.x + s * nDir.x + origin.x,
                        t * bDir.y + s * nDir.y + origin.y,
                        t * bDir.z + s * nDir.z + origin.z,
                        (t + halfW * 0.5) * bDir.x + s * nDir.x + origin.x,
                        (t + halfW * 0.5) * bDir.y + s * nDir.y + origin.y,
                        (t + halfW * 0.5) * bDir.z + s * nDir.z + origin.z,
                    );
                }
            }
            if (gridPositions.length > 0) {
                const gridGeom = new THREE.BufferGeometry();
                gridGeom.setAttribute(
                    'position',
                    new THREE.Float32BufferAttribute(gridPositions, 3)
                );
                const grid = new THREE.LineSegments(
                    gridGeom,
                    new THREE.LineBasicMaterial({ color: 0xaaaaaa, transparent: true, opacity: 0.35 })
                );
                grid.userData = { kind: 'plane_grid', idx };
                this.planesGroup.add(grid);
                this._planeGrids.push(grid);
            }
        });
    }

    _rebuildRibbon() {
        if (this._ribbonMesh) {
            this.ribbonGroup.remove(this._ribbonMesh);
            this._disposeObject3D(this._ribbonMesh);
            this._ribbonMesh = null;
        }
        if (this._frames.length < 2) return;

        const lRef = this._computeLRef();
        const halfD = lRef * 0.5;

        const positions = [];
        const indices = [];
        const stations = this._frames.length;
        for (let k = 0; k < stations; k++) {
            const f = this._frames[k];
            const o = new THREE.Vector3(f.origin[0], f.origin[1], f.origin[2]);
            const n = new THREE.Vector3(f.normal[0], f.normal[1], f.normal[2]).normalize();
            const pPlus = o.clone().addScaledVector(n, halfD);
            const pMinus = o.clone().addScaledVector(n, -halfD);
            positions.push(pPlus.x, pPlus.y, pPlus.z);
            positions.push(pMinus.x, pMinus.y, pMinus.z);
        }
        for (let k = 0; k < stations - 1; k++) {
            const a = k * 2;
            const b = k * 2 + 1;
            const c = (k + 1) * 2;
            const d = (k + 1) * 2 + 1;
            indices.push(a, b, c);
            indices.push(b, d, c);
        }

        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geom.setIndex(indices);
        geom.computeVertexNormals();
        const mat = new THREE.MeshBasicMaterial({
            color: COLOR_RIBBON,
            transparent: true,
            opacity: 0.5,
            side: THREE.DoubleSide,
        });
        this._ribbonMesh = new THREE.Mesh(geom, mat);
        this._ribbonMesh.name = 'spineFrames.twistRibbon';
        this.ribbonGroup.add(this._ribbonMesh);
    }

    // ---- bbox / scale ----------------------------------------------------

    _measureSceneBbox() {
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
        collect(this.skeletonShadow);
        collect(this.stationsGroup);
        collect(this.framesGroup);
        collect(this.planesGroup);
        collect(this.ribbonGroup);
        return bbox;
    }

    _computeLRef() {
        const bbox = this._measureSceneBbox();
        if (bbox.isEmpty()) return 0.1;
        const size = new THREE.Vector3().subVectors(bbox.max, bbox.min);
        const diagonal = Math.max(1e-6, size.length());
        const lRef = diagonal * 0.018;
        return Math.max(0.005, Math.min(5.0, lRef));
    }

    _fitCameraToScene() {
        if (!this.camera || !this.controls) return;
        const bbox = this._measureSceneBbox();
        if (bbox.isEmpty()) {
            this._fitCameraToFallback();
            return;
        }
        const center = bbox.getCenter(new THREE.Vector3());
        const size = new THREE.Vector3().subVectors(bbox.max, bbox.min);
        const radius = Math.max(0.5, size.length() * 0.6);
        const dir = new THREE.Vector3(1, 0.8, 1.4).normalize();
        this.camera.position.copy(center).addScaledVector(dir, radius);
        this.camera.near = Math.max(0.001, radius / 1000);
        this.camera.far = Math.max(100, radius * 200);
        this.camera.updateProjectionMatrix();
        this.controls.target.copy(center);
        this.controls.update();
    }

    _fitCameraToFallback() {
        if (!this.camera || !this.controls) return;
        this.camera.position.set(8, 6, 12);
        this.camera.near = 0.1;
        this.camera.far = 5000;
        this.camera.updateProjectionMatrix();
        this.controls.target.set(0, 0, 0);
        this.controls.update();
    }

    // ---- highlight / visibility -----------------------------------------

    _applyHighlight() {
        const idx = this._highlightedStation;
        for (let k = 0; k < this._stationMeshes.length; k++) {
            const m = this._stationMeshes[k];
            if (!m || !m.material) continue;
            m.material.opacity = (idx === null || idx === k) ? 0.9 : NON_HIGHLIGHTED_OPACITY;
            m.material.transparent = true;
        }
        for (let k = 0; k < this._frameArrows.length; k++) {
            const arrows = this._frameArrows[k];
            if (!arrows) continue;
            const visible = (idx === null || idx === k);
            const setVis = (a) => {
                if (!a) return;
                a.visible = visible;
                if (a.line) {
                    a.line.material.transparent = true;
                    a.line.material.opacity = visible ? 1.0 : NON_HIGHLIGHTED_OPACITY;
                }
                if (a.cone) {
                    a.cone.material.transparent = true;
                    a.cone.material.opacity = visible ? 1.0 : NON_HIGHLIGHTED_OPACITY;
                }
            };
            setVis(arrows.t);
            setVis(arrows.n);
            setVis(arrows.b);
        }
        for (let k = 0; k < this._planeMeshes.length; k++) {
            const p = this._planeMeshes[k];
            if (!p || !p.material) continue;
            p.material.opacity = (idx === null || idx === k) ? 0.25 : NON_HIGHLIGHTED_OPACITY;
            p.material.transparent = true;
        }
    }

    _applyLayerVisibility() {
        if (this.stationsGroup) this.stationsGroup.visible = this._layerVisible.stations;
        if (this.framesGroup) this.framesGroup.visible = this._layerVisible.frames;
        if (this.planesGroup) this.planesGroup.visible = this._layerVisible.planes;
        if (this.ribbonGroup) this.ribbonGroup.visible = this._layerVisible.ribbon;
    }

    // ---- render loop -----------------------------------------------------

    _startLoop() {
        this._running = true;
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

    _clearVizGroups() {
        this._clearGroup(this.stationsGroup);
        this._clearGroup(this.framesGroup);
        this._clearGroup(this.planesGroup);
        this._clearGroup(this.ribbonGroup);
        this._stationMeshes = [];
        this._frameArrows = [];
        this._planeMeshes = [];
        this._planeOutlines = [];
        this._planeGrids = [];
        this._ribbonMesh = null;
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