// ManifoldPatchesPanel — Tab 5 (Manifold vs Patches) of the
// geometry-viewer workspace.
//
// Owns its own WebGLRenderer / Scene / PerspectiveCamera /
// OrbitControls. Renders the pre-split theoretical NURBS manifold
// alongside the post-split industrial patches with a blend slider,
// control cage, weights heatmap, split-seam isoparm curves, and
// per-patch distinct colors.
//
// Groups (all live under this.scene):
//   - skeletonShadow   : persistent Profiles / Spine / Guides (provided
//                        by main.js via options.skeletonGroup; rendered
//                        at lower opacity as a faint reference
//                        background).
//   - manifoldGroup    : the pre-split theoretical NURBS surface sampled
//                        via THREE.NURBSSurface (40×40 grid). Hidden
//                        when the case carries no stage4 envelope.
//   - patchesGroup     : the post-split industrial patches (one Mesh
//                        per patch from options.patches). Per-patch
//                        distinct colors when the 'distinct' layer is
//                        on, single default color otherwise.
//   - cageGroup        : Line2 row/col polylines + sphere-per-CP for
//                        the theoretical manifold's control polygon.
//   - seamsGroup       : Line2 isoparm curves for split_u_params +
//                        split_v_params, color 0xff8800.
//
// All dimensions derive from a manual bbox traversal over the
// skeleton / manifold / patches / cage groups — same approach as
// SpineFramesPanel. Scale invariance via L_ref = clamp(bbox.diag *
// 0.018, 0.005, 5.0).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { NURBSSurface } from 'three/addons/curves/NURBSSurface.js';

const COLOR_MANIFOLD = 0x4488aa;
const COLOR_PATCH_DEFAULT = 0xffaa00;
const COLOR_CAGE_LINE = 0x666666;
const COLOR_CAGE_SPHERE = 0x444444;
const COLOR_SEAM = 0xff8800;
const PIECE_PALETTE = [0xffaa00, 0x00aaff, 0x00ff88, 0xff5500, 0xaa00ff, 0x00ffaa,
    0xff66cc, 0x66ccff, 0xccff66, 0xff3366, 0x9966ff, 0x33cc99];

const SAMPLES_U = 40;
const SAMPLES_V = 40;
const SEAM_SAMPLES = 96;

export class ManifoldPatchesPanel {
    /**
     * @param {HTMLElement} container — full-width container below the
     *                                  tab strip. Mounts the panel's
     *                                  internal viewport + side-panel
     *                                  layout inside it.
     * @param {Object|null} caseData  — parsed case JSON.
     * @param {Object} options        — {
     *                                    skeletonGroup,
     *                                    patches,            // optional
     *                                    geometryParser,
     *                                    initialBlend       // 0..1
     *                                  }
     */
    constructor(container, caseData, options = {}) {
        this.container = container;
        this.caseData = caseData || null;
        this.options = options || {};
        this._skeletonGroup = this.options.skeletonGroup || null;
        this._patches = Array.isArray(this.options.patches) ? this.options.patches : [];
        this._parser = this.options.geometryParser || null;

        this._running = false;
        this._rafId = null;

        this._blend = (typeof this.options.initialBlend === 'number')
            ? Math.max(0, Math.min(1, this.options.initialBlend))
            : 0.5;
        this._layerVisible = {
            cage: true,
            weights: false,
            seams: true,
            distinct: true,
        };
        this._weightStats = { w_min: 0, w_max: 1 };

        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.lightsGroup = null;

        this.skeletonShadow = null;
        this.manifoldGroup = null;
        this.patchesGroup = null;
        this.cageGroup = null;
        this.seamsGroup = null;

        this._manifoldMesh = null;
        this._patchMeshes = [];
        this._cageLines = [];
        this._cageSpheres = [];
        this._seamLines = [];
        this._lineMaterials = [];

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
        this._lineMaterials = [];
    }

    setBlend(t) {
        const v = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0.5;
        this._blend = v;
        if (this._manifoldMesh && this._manifoldMesh.material) {
            this._manifoldMesh.material.opacity = 1 - v;
        }
        for (const m of this._patchMeshes) {
            if (m && m.material) m.material.opacity = v;
        }
    }

    setLayerVisible(name, visible) {
        if (!(name in this._layerVisible)) return;
        this._layerVisible[name] = !!visible;
        if (name === 'cage' && this.cageGroup) {
            this.cageGroup.visible = !!visible;
        } else if (name === 'seams' && this.seamsGroup) {
            this.seamsGroup.visible = !!visible;
        } else if (name === 'weights') {
            this._applyCageSphereColors();
        } else if (name === 'distinct') {
            this._applyPatchColors();
        }
    }

    getBlend() { return this._blend; }
    getWeightStats() { return { ...this._weightStats }; }
    getLayerVisible() { return { ...this._layerVisible }; }
    getPatchCount() { return this._patchMeshes.length; }

    // ---- DOM scaffolding -------------------------------------------------

    _buildDom() {
        while (this.container.firstChild) {
            this.container.removeChild(this.container.firstChild);
        }

        const root = document.createElement('div');
        root.className = 'manifold-patches-panel';

        const viewport = document.createElement('div');
        viewport.className = 'manifold-patches-viewport';
        viewport.id = 'manifold-patches-viewport';

        const sidePanel = document.createElement('div');
        sidePanel.className = 'manifold-patches-side-panel';
        sidePanel.id = 'manifold-patches-side-panel';

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
        canvas.className = 'manifold-patches-canvas';
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

        this.manifoldGroup = new THREE.Group();
        this.manifoldGroup.name = 'manifoldPatches.manifold';
        this.scene.add(this.manifoldGroup);

        this.patchesGroup = new THREE.Group();
        this.patchesGroup.name = 'manifoldPatches.patches';
        this.scene.add(this.patchesGroup);

        this.cageGroup = new THREE.Group();
        this.cageGroup.name = 'manifoldPatches.cage';
        this.scene.add(this.cageGroup);

        this.seamsGroup = new THREE.Group();
        this.seamsGroup.name = 'manifoldPatches.seams';
        this.scene.add(this.seamsGroup);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.target.set(0, 0, 0);
        this.controls.update();

        this._applyLayerGroupVisibility();
    }

    _applyLayerGroupVisibility() {
        if (this.cageGroup) this.cageGroup.visible = this._layerVisible.cage;
        if (this.seamsGroup) this.seamsGroup.visible = this._layerVisible.seams;
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
            for (const m of this._lineMaterials) {
                m.resolution.set(w, h);
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

    // ---- data extraction -------------------------------------------------

    _extractManifold(caseData) {
        if (!this._parser || typeof this._parser.parseDebug !== 'function') return null;
        let dbg = null;
        try { dbg = this._parser.parseDebug(caseData); }
        catch (e) { return null; }
        if (!dbg) return null;
        return dbg.stage4_theoretical_manifold || null;
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
        shadow.name = 'manifoldPatches.skeletonShadow';
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
        const env = this._extractManifold(caseData);
        const surface = env && env.surface;
        const splitU = (env && Array.isArray(env.split_u_params)) ? env.split_u_params : [];
        const splitV = (env && Array.isArray(env.split_v_params)) ? env.split_v_params : [];
        if (surface && surface.num_cps_u > 0 && surface.num_cps_v > 0
            && Array.isArray(surface.control_points)
            && surface.control_points.length === surface.num_cps_u * surface.num_cps_v
            && Array.isArray(surface.knots_u) && Array.isArray(surface.knots_v)) {
            this._buildManifold(surface);
            this._buildCage(surface);
            this._buildSeams(surface, splitU, splitV);
            this._computeWeightStats(surface);
        } else {
            this._weightStats = { w_min: 0, w_max: 1 };
        }
        this._buildPatches();
        this._applyPatchColors();
        this._applyCageSphereColors();
        this.setBlend(this._blend);
        this._applyLayerGroupVisibility();
        this._fitCameraToScene();
    }

    _buildManifold(surface) {
        const ns = this._makeNurbsSurface(surface);
        if (!ns) return;
        const uS = this._buildSampleParams(surface.knots_u, surface.degree_u, SAMPLES_U);
        const vS = this._buildSampleParams(surface.knots_v, surface.degree_v, SAMPLES_V);
        const geom = new THREE.BufferGeometry();
        const verts = [];
        const uvs = [];
        const target = new THREE.Vector3();
        for (let j = 0; j < vS.length; j++) {
            for (let i = 0; i < uS.length; i++) {
                ns.getPoint(uS[i], vS[j], target);
                if (!Number.isFinite(target.x) || !Number.isFinite(target.y) || !Number.isFinite(target.z)) {
                    target.set(0, 0, 0);
                }
                verts.push(target.x, target.y, target.z);
                uvs.push(uS[i], vS[j]);
            }
        }
        const indices = [];
        for (let j = 0; j < vS.length - 1; j++) {
            for (let i = 0; i < uS.length - 1; i++) {
                const a = i + j * uS.length;
                const b = i + 1 + j * uS.length;
                const c = i + (j + 1) * uS.length;
                const d = i + 1 + (j + 1) * uS.length;
                indices.push(a, b, d, a, d, c);
            }
        }
        geom.setIndex(indices);
        geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        geom.computeVertexNormals();

        const mat = new THREE.MeshStandardMaterial({
            color: COLOR_MANIFOLD,
            side: THREE.DoubleSide,
            metalness: 0.1,
            roughness: 0.6,
            transparent: true,
            opacity: 1 - this._blend,
            depthWrite: false,
        });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.name = 'manifoldPatches.manifoldMesh';
        this.manifoldGroup.add(mesh);
        this._manifoldMesh = mesh;
    }

    _buildPatches() {
        const patches = this._patches;
        if (!patches || patches.length === 0) return;
        for (let i = 0; i < patches.length; i++) {
            const p = patches[i];
            if (!p) continue;
            const ns = this._buildNurbsFromPatch(p);
            if (!ns) continue;
            const uS = this._buildSampleParams(ns._knotsU, ns._degreeU, SAMPLES_U);
            const vS = this._buildSampleParams(ns._knotsV, ns._degreeV, SAMPLES_V);
            const geom = new THREE.BufferGeometry();
            const verts = [];
            const uvs = [];
            const target = new THREE.Vector3();
            for (let j = 0; j < vS.length; j++) {
                for (let k = 0; k < uS.length; k++) {
                    ns.getPoint(uS[k], vS[j], target);
                    if (!Number.isFinite(target.x) || !Number.isFinite(target.y) || !Number.isFinite(target.z)) {
                        target.set(0, 0, 0);
                    }
                    verts.push(target.x, target.y, target.z);
                    uvs.push(uS[k], vS[j]);
                }
            }
            const indices = [];
            for (let j = 0; j < vS.length - 1; j++) {
                for (let k = 0; k < uS.length - 1; k++) {
                    const a = k + j * uS.length;
                    const b = k + 1 + j * uS.length;
                    const c = k + (j + 1) * uS.length;
                    const d = k + 1 + (j + 1) * uS.length;
                    indices.push(a, b, d, a, d, c);
                }
            }
            geom.setIndex(indices);
            geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
            geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
            geom.computeVertexNormals();
            const mat = new THREE.MeshStandardMaterial({
                color: COLOR_PATCH_DEFAULT,
                side: THREE.DoubleSide,
                metalness: 0.1,
                roughness: 0.6,
                transparent: true,
                opacity: this._blend,
                depthWrite: false,
            });
            const mesh = new THREE.Mesh(geom, mat);
            mesh.name = `manifoldPatches.patchMesh[${i}]`;
            mesh.userData = { kind: 'patch', index: i, label: p.label || `patch_${i}` };
            this.patchesGroup.add(mesh);
            this._patchMeshes.push(mesh);
        }
    }

    _applyPatchColors() {
        for (let i = 0; i < this._patchMeshes.length; i++) {
            const m = this._patchMeshes[i];
            if (!m || !m.material) continue;
            const color = this._layerVisible.distinct
                ? PIECE_PALETTE[i % PIECE_PALETTE.length]
                : COLOR_PATCH_DEFAULT;
            m.material.color.setHex(color);
        }
    }

    _buildCage(surface) {
        const cps = this._collectControlPoints(surface);
        if (cps.length === 0) return;
        const numU = surface.num_cps_u;
        const numV = surface.num_cps_v;
        const lineMat = new THREE.LineBasicMaterial({
            color: COLOR_CAGE_LINE,
            transparent: true,
            opacity: 0.4,
        });
        for (let j = 0; j < numV; j++) {
            const pts = [];
            for (let i = 0; i < numU; i++) {
                const cp = cps[j * numU + i];
                if (!cp) continue;
                pts.push(new THREE.Vector3(cp.x, cp.y, cp.z));
            }
            if (pts.length >= 2) {
                const line = new THREE.Line(
                    new THREE.BufferGeometry().setFromPoints(pts),
                    lineMat,
                );
                this.cageGroup.add(line);
                this._cageLines.push(line);
            }
        }
        for (let i = 0; i < numU; i++) {
            const pts = [];
            for (let j = 0; j < numV; j++) {
                const cp = cps[j * numU + i];
                if (!cp) continue;
                pts.push(new THREE.Vector3(cp.x, cp.y, cp.z));
            }
            if (pts.length >= 2) {
                const line = new THREE.Line(
                    new THREE.BufferGeometry().setFromPoints(pts),
                    lineMat,
                );
                this.cageGroup.add(line);
                this._cageLines.push(line);
            }
        }

        const lDiag = this._computeDiag();
        const sphereRadius = Math.max(0.001, 0.008 * Math.max(0.01, lDiag));
        const sphereGeom = new THREE.SphereGeometry(sphereRadius, 8, 6);
        for (let k = 0; k < cps.length; k++) {
            const cp = cps[k];
            const mat = new THREE.MeshStandardMaterial({
                color: COLOR_CAGE_SPHERE,
                transparent: true,
                opacity: 0.9,
            });
            const mesh = new THREE.Mesh(sphereGeom, mat);
            mesh.position.set(cp.x, cp.y, cp.z);
            mesh.userData = { kind: 'cp_sphere', index: k, weight: cp.w };
            this.cageGroup.add(mesh);
            this._cageSpheres.push(mesh);
        }
    }

    _buildSeams(surface, splitU, splitV) {
        if (splitU.length === 0 && splitV.length === 0) return;
        const ns = this._makeNurbsSurface(surface);
        if (!ns) return;
        const vS = this._buildSampleParams(surface.knots_v, surface.degree_v, SEAM_SAMPLES);
        const lineMat = new THREE.LineBasicMaterial({
            color: COLOR_SEAM,
            transparent: true,
            opacity: 0.95,
        });
        const target = new THREE.Vector3();
        for (const u of splitU) {
            if (!Number.isFinite(u)) continue;
            const pts = [];
            for (let j = 0; j < vS.length; j++) {
                ns.getPoint(u, vS[j], target);
                if (!Number.isFinite(target.x) || !Number.isFinite(target.y) || !Number.isFinite(target.z)) {
                    target.set(0, 0, 0);
                }
                pts.push(new THREE.Vector3(target.x, target.y, target.z));
            }
            if (pts.length >= 2) {
                const line = new THREE.Line(
                    new THREE.BufferGeometry().setFromPoints(pts),
                    lineMat,
                );
                line.userData = { kind: 'seam_u', u_param: u };
                this.seamsGroup.add(line);
                this._seamLines.push(line);
            }
        }
        const uS = this._buildSampleParams(surface.knots_u, surface.degree_u, SEAM_SAMPLES);
        for (const v of splitV) {
            if (!Number.isFinite(v)) continue;
            const pts = [];
            for (let i = 0; i < uS.length; i++) {
                ns.getPoint(uS[i], v, target);
                if (!Number.isFinite(target.x) || !Number.isFinite(target.y) || !Number.isFinite(target.z)) {
                    target.set(0, 0, 0);
                }
                pts.push(new THREE.Vector3(target.x, target.y, target.z));
            }
            if (pts.length >= 2) {
                const line = new THREE.Line(
                    new THREE.BufferGeometry().setFromPoints(pts),
                    lineMat,
                );
                line.userData = { kind: 'seam_v', v_param: v };
                this.seamsGroup.add(line);
                this._seamLines.push(line);
            }
        }
    }

    // ---- helpers ---------------------------------------------------------

    _makeNurbsSurface(surface) {
        if (!surface || !Array.isArray(surface.control_points)
            || surface.control_points.length === 0) return null;
        const cps = this._collectControlPoints(surface);
        if (cps.length === 0) return null;
        const numU = surface.num_cps_u;
        const numV = surface.num_cps_v;
        const controlPoints = [];
        for (let i = 0; i < numU; i++) {
            controlPoints[i] = [];
            for (let j = 0; j < numV; j++) {
                const cp = cps[j * numU + i];
                if (!cp) return null;
                controlPoints[i][j] = new THREE.Vector4(cp.x, cp.y, cp.z, cp.w);
            }
        }
        try {
            return new NURBSSurface(
                surface.degree_u, surface.degree_v,
                Array.from(surface.knots_u), Array.from(surface.knots_v),
                controlPoints,
            );
        } catch (e) {
            console.warn('[ManifoldPatchesPanel] NURBSSurface construction failed:', e.message);
            return null;
        }
    }

    _buildNurbsFromPatch(p) {
        if (!p || typeof p !== 'object') return null;
        const degreeU = (typeof p.p_u === 'number') ? p.p_u : (typeof p.degreeU === 'number' ? p.degreeU : null);
        const degreeV = (typeof p.p_v === 'number') ? p.p_v : (typeof p.degreeV === 'number' ? p.degreeV : null);
        const knotsU = Array.isArray(p.knots_u) ? p.knots_u : (Array.isArray(p.knotsU) ? p.knotsU : null);
        const knotsV = Array.isArray(p.knots_v) ? p.knots_v : (Array.isArray(p.knotsV) ? p.knotsV : null);
        let rawCps = Array.isArray(p.control_points) ? p.control_points
            : (Array.isArray(p.controlPoints) ? p.controlPoints : null);
        if (rawCps == null) return null;
        let cpsFlat = null;
        if (rawCps.length > 0 && typeof rawCps[0] === 'object' && !Array.isArray(rawCps[0])) {
            const flat = [];
            for (const cp of rawCps) {
                const x = (cp && typeof cp.x === 'number') ? cp.x : 0;
                const y = (cp && typeof cp.y === 'number') ? cp.y : 0;
                const z = (cp && typeof cp.z === 'number') ? cp.z : 0;
                const w = (cp && typeof cp.w === 'number') ? cp.w : 1.0;
                flat.push(x, y, z, w);
            }
            cpsFlat = flat;
        } else if (rawCps.length > 0 && Array.isArray(rawCps[0])) {
            const flat = [];
            for (const cp of rawCps) {
                const x = (typeof cp[0] === 'number') ? cp[0] : 0;
                const y = (typeof cp[1] === 'number') ? cp[1] : 0;
                const z = (typeof cp[2] === 'number') ? cp[2] : 0;
                const w = (cp.length >= 4 && typeof cp[3] === 'number') ? cp[3] : 1.0;
                flat.push(x, y, z, w);
            }
            cpsFlat = flat;
        } else {
            cpsFlat = rawCps;
        }
        if (degreeU === null || degreeV === null || !knotsU || !knotsV
            || !cpsFlat || cpsFlat.length === 0) return null;
        const numU = knotsU.length - degreeU - 1;
        const numV = knotsV.length - degreeV - 1;
        if (numU < degreeU + 1 || numV < degreeV + 1) return null;
        const expectedTotal = numU * numV;
        const stride = cpsFlat.length >= expectedTotal * 4 ? 4 : 3;
        const controlPoints = [];
        for (let i = 0; i < numU; i++) {
            controlPoints[i] = [];
            for (let j = 0; j < numV; j++) {
                const idx = (j * numU + i) * stride;
                const x = cpsFlat[idx] || 0;
                const y = cpsFlat[idx + 1] || 0;
                const z = cpsFlat[idx + 2] || 0;
                const w = (stride === 4) ? (cpsFlat[idx + 3] || 1.0) : 1.0;
                controlPoints[i][j] = new THREE.Vector4(x, y, z, w);
            }
        }
        try {
            const ns = new NURBSSurface(degreeU, degreeV,
                Array.from(knotsU), Array.from(knotsV), controlPoints);
            ns._degreeU = degreeU;
            ns._degreeV = degreeV;
            ns._knotsU = knotsU;
            ns._knotsV = knotsV;
            return ns;
        } catch (e) {
            return null;
        }
    }

    _buildSampleParams(knots, p, steps) {
        if (!Array.isArray(knots) || knots.length === 0) return [];
        const min = knots[p];
        const max = knots[knots.length - p - 1];
        const range = max - min;
        const s = [];
        for (let i = 0; i <= steps; i++) s.push(i / steps);
        if (range > 0) {
            for (let i = p; i < knots.length - p; i++) s.push((knots[i] - min) / range);
        }
        s.sort((a, b) => a - b);
        const out = [s[0]];
        for (let i = 1; i < s.length; i++) {
            if (s[i] - out[out.length - 1] > 1e-6) out.push(s[i]);
        }
        return out;
    }

    _collectControlPoints(surface) {
        const cps = surface.control_points;
        if (!Array.isArray(cps)) return [];
        const numU = surface.num_cps_u;
        const numV = surface.num_cps_v;
        const total = numU * numV;
        const out = [];
        for (let k = 0; k < total; k++) {
            const cp = cps[k];
            if (!cp || typeof cp !== 'object') return [];
            const w = (typeof cp.w === 'number') ? cp.w : 1.0;
            if (Math.abs(w - 1.0) < 1e-9) {
                out.push({ x: cp.x, y: cp.y, z: cp.z, w: 1.0 });
            } else {
                out.push({
                    x: cp.x / w,
                    y: cp.y / w,
                    z: cp.z / w,
                    w,
                });
            }
        }
        return out;
    }

    _computeWeightStats(surface) {
        const cps = surface.control_points;
        if (!Array.isArray(cps) || cps.length === 0) {
            this._weightStats = { w_min: 0, w_max: 1 };
            return;
        }
        let wMin = Infinity;
        let wMax = -Infinity;
        for (const cp of cps) {
            if (!cp || typeof cp.w !== 'number') continue;
            if (cp.w < wMin) wMin = cp.w;
            if (cp.w > wMax) wMax = cp.w;
        }
        if (!Number.isFinite(wMin) || !Number.isFinite(wMax)) {
            this._weightStats = { w_min: 0, w_max: 1 };
            return;
        }
        this._weightStats = { w_min: wMin, w_max: wMax };
    }

    _applyCageSphereColors() {
        const stats = this._weightStats;
        const range = Math.max(1e-9, stats.w_max - stats.w_min);
        for (const m of this._cageSpheres) {
            if (!m || !m.material) continue;
            const w = (m.userData && typeof m.userData.weight === 'number')
                ? m.userData.weight : 1.0;
            if (this._layerVisible.weights) {
                const t = Math.max(0, Math.min(1, (w - stats.w_min) / range));
                const c = this._rainbowHeatmap(t);
                m.material.color.setHex(c);
            } else {
                m.material.color.setHex(COLOR_CAGE_SPHERE);
            }
        }
    }

    _rainbowHeatmap(t) {
        const c0 = [0x33, 0x66, 0xcc];
        const c1 = [0x33, 0xcc, 0x66];
        const c2 = [0xcc, 0xcc, 0x33];
        const c3 = [0xcc, 0x33, 0x33];
        const lerp = (a, b, u) => a + (b - a) * u;
        let r, g, b;
        if (t < 1 / 3) {
            const u = t * 3;
            r = lerp(c0[0], c1[0], u);
            g = lerp(c0[1], c1[1], u);
            b = lerp(c0[2], c1[2], u);
        } else if (t < 2 / 3) {
            const u = (t - 1 / 3) * 3;
            r = lerp(c1[0], c2[0], u);
            g = lerp(c1[1], c2[1], u);
            b = lerp(c1[2], c2[2], u);
        } else {
            const u = (t - 2 / 3) * 3;
            r = lerp(c2[0], c3[0], u);
            g = lerp(c2[1], c3[1], u);
            b = lerp(c2[2], c3[2], u);
        }
        return ((Math.round(r) & 0xff) << 16) | ((Math.round(g) & 0xff) << 8) | (Math.round(b) & 0xff);
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
        collect(this.manifoldGroup);
        collect(this.patchesGroup);
        collect(this.cageGroup);
        collect(this.seamsGroup);
        return bbox;
    }

    _computeDiag() {
        const bbox = this._measureSceneBbox();
        if (bbox.isEmpty()) return 1.0;
        const size = new THREE.Vector3().subVectors(bbox.max, bbox.min);
        return Math.max(1e-6, size.length());
    }

    _computeLRef() {
        const diag = this._computeDiag();
        const lRef = diag * 0.018;
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
        this._clearGroup(this.manifoldGroup);
        this._clearGroup(this.patchesGroup);
        this._clearGroup(this.cageGroup);
        this._clearGroup(this.seamsGroup);
        this._manifoldMesh = null;
        this._patchMeshes = [];
        this._cageLines = [];
        this._cageSpheres = [];
        this._seamLines = [];
        for (const m of this._lineMaterials) {
            try { m.dispose(); } catch (e) { /* no-op */ }
        }
        this._lineMaterials = [];
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
