import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VertexNormalsHelper } from 'three/addons/helpers/VertexNormalsHelper.js';
import { NURBSCurve } from 'three/addons/curves/NURBSCurve.js';
import { NURBSSurface } from 'three/addons/curves/NURBSSurface.js';
import { ParametricGeometry } from 'three/addons/geometries/ParametricGeometry.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

export class Viewer3D {
    constructor() {
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.controls = null;
        this.mesh = null;
        this.normalsHelper = null;
        this.grid = null;
        this.markersGroup = new THREE.Group();
        this.nurbsGroup = new THREE.Group();
        this.auditGroup = new THREE.Group();
        // Stage-1 (Profile Coupling) debug overlays — all hidden by
        // default; toggled via setCouplingDebug + setSeamMarkersVisibility
        // / setTangentArrowsVisibility / setRulingLinesVisibility.
        this.seamMarkersGroup = new THREE.Group();
        this.tangentArrowsGroup = new THREE.Group();
        this.rulingLinesGroup = new THREE.Group();
        this.seamMarkersGroup.visible = false;
        this.tangentArrowsGroup.visible = false;
        this.rulingLinesGroup.visible = false;
        this.surfaceGroups = {};
        this.auditLayers = {};
        this.vSamplesPoints = null;
        this.displacementVectors = [];
        this.vSectionLines = [];
        this.proxiedGuideLines = [];
        // Cached Stage-1 scene bbox: recomputed by setCouplingDebug on
        // every case load. Holds Vector3 min/max/center and a scalar
        // diagonal. Empty scenes fall back to diagonal=1 so scale
        // formulas don't divide by zero.
        this.stage1BBox = {
            min: new THREE.Vector3(-0.5, -0.5, -0.5),
            max: new THREE.Vector3(0.5, 0.5, 0.5),
            center: new THREE.Vector3(0, 0, 0),
            diagonal: 1.0,
        };

        this.scene.add(this.markersGroup);
        this.scene.add(this.nurbsGroup);
        this.scene.add(this.auditGroup);
        this.scene.add(this.seamMarkersGroup);
        this.scene.add(this.tangentArrowsGroup);
        this.scene.add(this.rulingLinesGroup);

        this.material = new THREE.MeshPhongMaterial({
            color: 0x4488ff,
            side: THREE.DoubleSide,
            flatShading: false,
            shininess: 30,
            specular: 0x111111,
            transparent: true,
            opacity: 0.6
        });
    }

    init(container) {
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.shadowMap.enabled = true;
        container.appendChild(this.renderer.domElement);

        this.scene.background = new THREE.Color(0xf5f7fa);

        const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
        this.scene.add(ambientLight);

        const mainLight = new THREE.DirectionalLight(0xffffff, 1.0);
        mainLight.position.set(5, 10, 7.5);
        this.scene.add(mainLight);

        this.grid = new THREE.GridHelper(20, 20, 0xbbbbbb, 0xdddddd);
        this.grid.rotation.x = Math.PI / 2;
        this.scene.add(this.grid);

        this.gridXZ = new THREE.GridHelper(20, 20, 0xcccccc, 0xeeeeee);
        this.scene.add(this.gridXZ);

        this.axesHelper = new THREE.AxesHelper(5);
        this.scene.add(this.axesHelper);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.camera.position.set(5, 5, 10);
        this.controls.update();

        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
            // LineMaterial.resolution must track viewport or world-space line
            // width breaks after a resize.
            if (this.rulingLinesGroup) {
                this.rulingLinesGroup.traverse((obj) => {
                    if (obj.userData && obj.userData.material
                        && obj.userData.material.resolution) {
                        obj.userData.material.resolution.set(
                            window.innerWidth, window.innerHeight,
                        );
                    }
                });
            }
        });

        this.animate();
    }

    animate() {
        requestAnimationFrame(() => this.animate());
        if (this.controls) this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }

    loadMesh(geometry, markers = [], nurbs = null, audit = null, extras = null) {
        if (this.mesh) {
            this.scene.remove(this.mesh);
            if (this.normalsHelper) this.scene.remove(this.normalsHelper);
            if (this.mesh.geometry) this.mesh.geometry.dispose();
        }

        [this.markersGroup, this.nurbsGroup, this.auditGroup,
         this.seamMarkersGroup, this.tangentArrowsGroup, this.rulingLinesGroup].forEach(group => {
            while(group.children.length > 0) {
                const child = group.children[0];
                if (child.geometry) child.geometry.dispose();
                if (child.material) {
                    if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
                    else child.material.dispose();
                }
                group.remove(child);
            }
        });

        // vSamplesPoints (added to nurbsGroup) is disposed by the loop
        // above; null the reference so callers don't touch the disposed object.
        this.vSamplesPoints = null;
        // displacementVectors (children of nurbsGroup) follow the same
        // disposal path; clear the cache so callers don't toggle
        // disposed objects.
        this.displacementVectors = [];
        // vSectionLines (children of nurbsGroup) follow the same disposal
        // path; clear the cache so callers don't toggle disposed objects.
        this.vSectionLines = [];
        // proxiedGuideLines (children of nurbsGroup) follow the same
        // disposal path; clear the cache so callers don't toggle
        // disposed objects.
        this.proxiedGuideLines = [];

        this.surfaceGroups = {};
        this.auditLayers = {};
        const labels = [];

        if (geometry && geometry.attributes.position) {
            this.mesh = new THREE.Mesh(geometry, this.material);
            this.scene.add(this.mesh);
        }

        this.addMarkers(markers);
        if (nurbs) {
            const surfaceLabels = this.addNurbs(nurbs);
            labels.push(...surfaceLabels);
        }
        if (nurbs && Array.isArray(nurbs.vSamples) && nurbs.vSamples.length > 0) {
            this.addVSamplesPoints(nurbs.vSamples);
            this.addDisplacementVectors(nurbs.vSamples);
        }
        if (nurbs && Array.isArray(nurbs.vSections) && nurbs.vSections.length > 0) {
            this.addVSectionsCurves(nurbs.vSections);
        }
        if (nurbs && Array.isArray(nurbs.proxiedGuides) && nurbs.proxiedGuides.length > 0) {
            this.addProxiedGuidesCurves(nurbs.proxiedGuides);
        }

        // v1.1 audit data — only the heatmap layer survives here; the
        // 2D nominal manifold is rendered as a regular surface (see
        // GeometryParser.parseNurbs) so its visibility is controlled
        // by the NominalManifold toggle in the Output Surfaces panel.
        if (audit && audit.process) {
            this._addAuditHeatmaps(audit.process);
        }
        // v1.2 coupling overlay: straight lines for every coupling kind
        // emitted by loft14::inspect::extract_coupling_relationships.
        if (audit && Array.isArray(audit.couplingRelationships)
            && audit.couplingRelationships.length > 0) {
            this._addCouplingRelationships(audit.couplingRelationships);
        }
        // VxLoft14 visualization debug products overlay (scenarios 2..9 markers)
        if (audit && Array.isArray(audit.debugMarkers)
            && audit.debugMarkers.length > 0) {
            this._addDebugMarkers(audit.debugMarkers);
        }
        // Audit layers default hidden; toggled externally via setAuditLayer.
        // `couplings` and `debug_markers` auto-display by default;
        // the rest stay hidden until the reviewer clicks them.
        Object.keys(this.auditLayers).forEach(k => {
            this.auditLayers[k].visible = (k === 'couplings' || k === 'debug_markers');
        });

        const bbox = new THREE.Box3();
        if (this.mesh && this.mesh.geometry && this.mesh.geometry.attributes.position) {
            bbox.expandByObject(this.mesh);
        }
        if (nurbs && nurbs.surfaces) {
            nurbs.surfaces.forEach(s => {
                const degreeU = s.degreeU !== undefined ? s.degreeU : s.p_u;
                const degreeV = s.degreeV !== undefined ? s.degreeV : s.p_v;
                const knotsU = s.knotsU || s.knots_u;
                const knotsV = s.knotsV || s.knots_v;
                let rawCPs = s.controlPoints || s.controlPoints;
                let isFlatObj = false;
                if (rawCPs && rawCPs.length > 0 && typeof rawCPs[0] === 'object') {
                    const flat = [];
                    rawCPs.forEach(pt => flat.push(pt.x, pt.y, pt.z));
                    rawCPs = flat;
                    isFlatObj = true;
                }
                if (!knotsU || !knotsV || !rawCPs) return;

                const expectedTotal = (s.n_u !== undefined ? s.n_u + 1 : (knotsU.length - degreeU - 1)) *
                                      (s.n_v !== undefined ? s.n_v + 1 : (knotsV.length - degreeV - 1));
                const stride = isFlatObj ? 3 : Math.max(1, Math.round(rawCPs.length / expectedTotal));

                for (let i = 0; i < rawCPs.length; i += stride) {
                    if (!isNaN(rawCPs[i]) && !isNaN(rawCPs[i+1]) && !isNaN(rawCPs[i+2])) {
                        bbox.expandByPoint(new THREE.Vector3(rawCPs[i], rawCPs[i+1], rawCPs[i+2]));
                    }
                }
            });
        }
        bbox.expandByObject(this.auditGroup);
        if (this.vSamplesPoints && this.vSamplesPoints.geometry
            && this.vSamplesPoints.geometry.attributes.position) {
            bbox.expandByObject(this.vSamplesPoints);
        }
        if (Array.isArray(this.displacementVectors) && this.displacementVectors.length > 0) {
            for (const ln of this.displacementVectors) {
                if (ln && ln.geometry && ln.geometry.attributes.position) {
                    bbox.expandByObject(ln);
                }
            }
        }
        if (Array.isArray(this.vSectionLines) && this.vSectionLines.length > 0) {
            for (const ln of this.vSectionLines) {
                if (ln && ln.geometry && ln.geometry.attributes.position) {
                    bbox.expandByObject(ln);
                }
            }
        }
        if (Array.isArray(this.proxiedGuideLines) && this.proxiedGuideLines.length > 0) {
            for (const ln of this.proxiedGuideLines) {
                if (ln && ln.geometry && ln.geometry.attributes.position) {
                    bbox.expandByObject(ln);
                }
            }
        }
        // Sections / guides / spine polylines live under nurbsGroup;
        // without this, the bbox is dominated by the surface CPs and
        // the offset can push every profile away from the world grids.
        if (this.nurbsGroup && this.nurbsGroup.children.length > 0) {
            bbox.expandByObject(this.nurbsGroup);
        }

        // spec 0002: fold station origins into the bbox so open envelopes
        // (spine outside the mesh) still get a sane per-axis scale.
        const auxStations = [
            ...((extras && Array.isArray(extras.movingFrame)) ? extras.movingFrame : []),
            ...((extras && Array.isArray(extras.samplingPlane)) ? extras.samplingPlane : []),
        ];
        for (const st of auxStations) {
            if (st && Array.isArray(st.origin) && st.origin.length >= 3
                && !isNaN(st.origin[0]) && !isNaN(st.origin[1]) && !isNaN(st.origin[2])) {
                bbox.expandByPoint(new THREE.Vector3(st.origin[0], st.origin[1], st.origin[2]));
            }
        }

        let bboxDiagonal = 0;
        if (!bbox.isEmpty()) {
            const center = new THREE.Vector3(); bbox.getCenter(center);
            const offset = center.clone().multiplyScalar(-1);
            this.markersGroup.position.copy(offset);
            this.nurbsGroup.position.copy(offset);
            this.auditGroup.position.copy(offset);
            // Move the world grids + axes by the same offset so the
            // XY / XZ planes remain visually anchored to the data.
            this.grid && this.grid.position.copy(offset);
            this.gridXZ && this.gridXZ.position.copy(offset);
            this.axesHelper && this.axesHelper.position.copy(offset);
            const size = bbox.getSize(new THREE.Vector3()).length();
            bboxDiagonal = size;
            this.camera.position.set(size, size, size);
            this.controls.target.set(0, 0, 0);
            this.controls.update();
        }

        // spec 0002: aux-viz must be built AFTER bboxDiagonal is known
        // (scale = 0.1 × bboxDiagonal, per spec). Parent groups live in
        // surfaceGroups so the existing setSurfaceVisibility toggle path
        // drives visibility — no new callback wiring needed.
        const auxScale = 0.1 * bboxDiagonal;
        if (extras && Array.isArray(extras.movingFrame) && extras.movingFrame.length > 0) {
            this.addMovingFrame(extras.movingFrame, auxScale);
            labels.push('Moving Frame');
        }
        if (extras && Array.isArray(extras.samplingPlane) && extras.samplingPlane.length > 0) {
            this.addSamplingPlane(extras.samplingPlane, auxScale);
            labels.push('Sampling Plane');
        }

        return {
            surfaceLabels: labels,
            curveLabels: Object.keys(this.curveGroups || {}),
            auditLayers: Object.keys(this.auditLayers),
        };
    }

    addMarkers(markers) {
        const sphereGeom = new THREE.SphereGeometry(0.05, 16, 16);
        const singularityMat = new THREE.MeshBasicMaterial({ color: 0xff3366 });
        markers.forEach(marker => {
            if (marker.type === 'singularity') {
                const sphere = new THREE.Mesh(sphereGeom, singularityMat);
                sphere.position.set(...marker.position);
                this.markersGroup.add(sphere);
            }
        });
    }

    addNurbs(nurbsData) {
        const labels = [];
        if (nurbsData.curves) {
            this.curveGroups = {};
            nurbsData.curves.forEach(data => {
                const curveLabel = data.label;
                if (curveLabel) {
                    this.curveGroups[curveLabel] = new THREE.Group();
                    this.nurbsGroup.add(this.curveGroups[curveLabel]);
                }
                try {
                    const p = data.degree !== undefined ? data.degree : data.p;
                    let rawCPs = data.controlPoints || data.control_points;
                    let isFlatObj = false;
                    if (rawCPs && rawCPs.length > 0 && typeof rawCPs[0] === 'object') {
                        const flat = [];
                        rawCPs.forEach(pt => flat.push(pt.x, pt.y, pt.z, (typeof pt.w === 'number') ? pt.w : 1));
                        rawCPs = flat;
                        isFlatObj = true;
                    }

                    let curveKnots;
                    let numPts;
                    if (data.knots && data.knots.length > 0) {
                        curveKnots = Array.from(data.knots);
                        numPts = curveKnots.length - p - 1;
                    } else {
                        numPts = isFlatObj ? (rawCPs.length / 4) : Math.floor(rawCPs.length / 4);
                        curveKnots = [];
                        for (let k = 0; k <= p; k++) curveKnots.push(0);
                        for (let k = 1; k < numPts - p; k++) curveKnots.push(k);
                        for (let k = 0; k <= p; k++) curveKnots.push(Math.max(1, numPts - p));
                    }

                    const dataDim = (typeof data.dim === 'number') ? data.dim : null;
                    const realStride = isFlatObj
                        ? 4
                        : ((dataDim === 3 && rawCPs.length % 3 === 0) ? 3 : 4);
                    const numCPsProvided = Math.floor(rawCPs.length / realStride);
                    const cps = [];
                    for (let i = 0; i < numPts; i++) {
                        const idx = (i % numCPsProvided) * realStride;
                        cps.push(new THREE.Vector4(rawCPs[idx], rawCPs[idx+1], rawCPs[idx+2], (realStride === 4) ? rawCPs[idx+3] : 1.0));
                    }

                    const curve = new NURBSCurve(p, curveKnots, cps);
                    const pts = curve.getPoints(100);
                    pts.forEach((pt, i) => {
                        if (isNaN(pt.x) || isNaN(pt.y) || isNaN(pt.z)) {
                            pt.set(0, 0, 0);
                        }
                    });
                    const geometry = new THREE.BufferGeometry().setFromPoints(pts);
                    const color = data.type === 'section' ? 0x000000
                        : data.type === 'guide' ? 0xff00ff
                        : data.type === 'section_target' ? 0xff8800
                        : 0x008800;
                    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, linewidth: 2 }));
                    if (curveLabel && this.curveGroups[curveLabel]) {
                        this.curveGroups[curveLabel].add(line);
                    } else {
                        this.nurbsGroup.add(line);
                    }
                } catch (e) { console.error(e); }
            });
        }

        if (nurbsData.surfaces) {
            const schemeColors = {
    'FreeBlend3D': 0xffaa00,
    'AffineTransport': 0x00aaff,
    'Analytic': 0xffaa00,
    'Variational': 0x00aaff,
    'Default': 0xffaa00,
    'VxLoft14': 0xffaa00,
    'Support Surface': 0x8833ff,
    'Section Support Surface': 0x33aaff,
    'Section Constraint Viz support_surface': 0x33aaff,
    'Section Constraint Viz tangent_ribbon': 0xff8800,
    'Section Constraint Viz curvature_ribbon': 0xaa00ff,
    'Section Constraint Viz torsion_ribbon': 0x00ffaa,
    'NominalManifold': 0x00ff88,
};
            function colorForLabel(label) {
                if (schemeColors[label] !== undefined) return schemeColors[label];
                if (label.startsWith('Guide Support Surface #')) return 0x8833ff;
                if (label.startsWith('Section Continuity Support #')) return 0x33aaff;
                if (label.startsWith('Loose Section Support #')) return 0x4488cc;
                return null;
            }
            const piecePalette = [0xffaa00, 0x00aaff, 0x00ff88, 0xff5500, 0xaa00ff, 0x00ffaa];
            nurbsData.surfaces.forEach((data, s_idx) => {
                try {
                    const label = data.label || 'Default';
                    const sColor = colorForLabel(label) ?? piecePalette[s_idx % piecePalette.length];
                    labels.push(label);
                    const sGroup = new THREE.Group();
                    this.surfaceGroups[label] = sGroup;
                    this.nurbsGroup.add(sGroup);

                    const degreeU = data.degreeU !== undefined ? data.degreeU : data.p_u;
                    const degreeV = data.degreeV !== undefined ? data.degreeV : data.p_v;
                    let rawCPs = data.controlPoints || data.control_points;
                    let isFlatObj = false;
                    if (rawCPs && rawCPs.length > 0 && typeof rawCPs[0] === 'object') {
                        const flat = [];
                        rawCPs.forEach(pt => flat.push(pt.x, pt.y, pt.z, (typeof pt.w === 'number') ? pt.w : 1));
                        rawCPs = flat;
                        isFlatObj = true;
                    }

                    const knotsU = Array.from(data.knotsU || data.knots_u);
                    const knotsV = Array.from(data.knotsV || data.knots_v);

                    if (knotsU.length === 0 || knotsV.length === 0
                        || !rawCPs || rawCPs.length === 0
                        || knotsU.length < degreeU + 1
                        || knotsV.length < degreeV + 1) {
                        console.warn(
                            `Viewer3D: skipping NURBS surface '${label}' — `
                            + `empty/malformed data (knotsU.length=${knotsU.length}, `
                            + `knotsV.length=${knotsV.length}, degreeU=${degreeU}, `
                            + `degreeV=${degreeV}, rawCPs.length=${rawCPs ? rawCPs.length : 0}). `
                            + `Likely the kernel M4 scheme returned mark_error().`
                        );
                        return;
                    }

                    const numU = knotsU.length - degreeU - 1;
                    const numV = knotsV.length - degreeV - 1;

                    const expectedTotal = (data.n_u !== undefined ? data.n_u + 1 : numU) *
                                          (data.n_v !== undefined ? data.n_v + 1 : numV);
                    const stride = isFlatObj
                        ? 4
                        : Math.max(1, Math.round(rawCPs.length / expectedTotal));
                    const realNumU = data.n_u !== undefined ? data.n_u + 1 : numU;
                    const realNumV = data.n_v !== undefined ? data.n_v + 1 : numV;

                    const controlPoints = [];
                    for (let i = 0; i < numU; i++) {
                        controlPoints[i] = [];
                        for (let j = 0; j < numV; j++) {
                            const mapI = i % realNumU;
                            const mapJ = j % realNumV;
                            const idx = (mapJ * realNumU + mapI) * stride;
                            controlPoints[i][j] = new THREE.Vector4(rawCPs[idx], rawCPs[idx+1], rawCPs[idx+2], (stride === 4) ? rawCPs[idx+3] : 1.0);
                        }
                    }

                    const ns = new NURBSSurface(degreeU, degreeV, knotsU, knotsV, controlPoints);
                    const getSamples = (knots, p, steps) => {
                        const min = knots[p], max = knots[knots.length - p - 1], range = max - min;
                        let s = []; for (let i = 0; i <= steps; i++) s.push(i / steps);
                        for (let i = p; i < knots.length - p; i++) if (range > 0) s.push((knots[i] - min) / range);
                        s.sort((a, b) => a - b);
                        let u = [s[0]]; for (let i = 1; i < s.length; i++) if (s[i] - u[u.length-1] > 1e-6) u.push(s[i]);
                        return u;
                    };

                    const uS = getSamples(knotsU, degreeU, 40), vS = getSamples(knotsV, degreeV, 40);
                    const geom = new THREE.BufferGeometry();
                    const verts = [], uvs = [], idxs = [];
                    const target = new THREE.Vector3();
                    for (let j = 0; j < vS.length; j++) {
                        for (let i = 0; i < uS.length; i++) {
                            ns.getPoint(uS[i], vS[j], target);
                            if (isNaN(target.x) || isNaN(target.y) || isNaN(target.z)) {
                                target.set(0, 0, 0);
                            }
                            verts.push(target.x, target.y, target.z); uvs.push(uS[i], vS[j]);
                        }
                    }
                    for (let j = 0; j < vS.length - 1; j++) {
                        for (let i = 0; i < uS.length - 1; i++) {
                            const a = i + j * uS.length, b = i + 1 + j * uS.length, c = i + (j + 1) * uS.length, d = i + 1 + (j + 1) * uS.length;
                            idxs.push(a, b, d, a, d, c);
                        }
                    }
                    geom.setIndex(idxs);
                    geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
                    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
                    geom.computeVertexNormals();

                    // NominalManifold is the 2D nominal-flow cp-propagation
                    // §3.2 intermediate; render it semi-translucent with
                    // depthWrite disabled so the underlying FreeBlend3D /
                    // AffineTransport surfaces stay readable.
                    const isNominal = label === 'NominalManifold';
                    const mat = new THREE.MeshStandardMaterial({
                        color: sColor,
                        side: THREE.DoubleSide,
                        metalness: 0.3,
                        roughness: 0.4,
                        transparent: true,
                        opacity: isNominal ? 0.25 : (label === 'Variational' ? 0.4 : (label === 'Support Surface' ? 0.3 : 0.7)),
                        depthWrite: !isNominal,
                    });
                    sGroup.add(new THREE.Mesh(geom, mat));

                    const pMat = new THREE.LineBasicMaterial({ color: sColor, transparent: true, opacity: 0.2 });
                    for (let j = 0; j < numV; j++) {
                        const pts = []; for (let i = 0; i < numU; i++) {
                            const idx = (j * realNumU + i) * stride;
                            let x = rawCPs[idx], y = rawCPs[idx+1], z = rawCPs[idx+2];
                            if (isNaN(x) || isNaN(y) || isNaN(z)) {
                                x = y = z = 0;
                            }
                            pts.push(new THREE.Vector3(x, y, z));
                        }
                        sGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), pMat));
                    }
                    for (let i = 0; i < numU; i++) {
                        const pts = []; for (let j = 0; j < numV; j++) {
                            const idx = (j * realNumU + i) * stride;
                            let x = rawCPs[idx], y = rawCPs[idx+1], z = rawCPs[idx+2];
                            if (isNaN(x) || isNaN(y) || isNaN(z)) {
                                x = y = z = 0;
                            }
                            pts.push(new THREE.Vector3(x, y, z));
                        }
                        sGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), pMat));
                    }
                } catch (e) { console.error(e); }
            });
        }
        return labels;
    }

    // ---- spec 0002 (v1.2): spine moving-frame / sampling-plane viz ----

    /**
     * Per-station 3 line segments: origin → origin + scale * {T, N, B}.
     * Colors per spec: tangent=red(0xff3366), normal=green(0x33ff66),
     * binormal=blue(0x3366ff). Stations with non-array origin / axes
     * are silently skipped (defensive against malformed envelopes).
     */
    addMovingFrame(movingFrame, bboxDiagonal) {
        if (!Array.isArray(movingFrame) || movingFrame.length === 0) return;
        const scale = bboxDiagonal;
        const colors = { tangent: 0xff3366, normal: 0x33ff66, binormal: 0x3366ff };
        const parent = new THREE.Group();
        parent.name = 'Moving Frame';
        this.surfaceGroups['Moving Frame'] = parent;
        this.nurbsGroup.add(parent);

        for (const station of movingFrame) {
            if (!station || !Array.isArray(station.origin) || station.origin.length < 3) continue;
            const origin = new THREE.Vector3(station.origin[0], station.origin[1], station.origin[2]);
            for (const axis of ['tangent', 'normal', 'binormal']) {
                const dir = station[axis];
                if (!Array.isArray(dir) || dir.length < 3) continue;
                const end = origin.clone().addScaledVector(
                    new THREE.Vector3(dir[0], dir[1], dir[2]), scale);
                const geom = new THREE.BufferGeometry().setFromPoints([origin, end]);
                parent.add(new THREE.Line(geom, new THREE.LineBasicMaterial({ color: colors[axis] })));
            }
        }
    }

    /**
     * Per-station rectangle line-loop: 4 vertices = origin, origin+u,
     * origin+u+v, origin+v, back to origin. Color: orange 0xff8800
     * (matches the existing "tangent_ribbon" convention). Skip
     * stations whose axis_u or axis_v is the zero vector (degenerate
     * spine tangent → per spec field rule §5).
     */
    addSamplingPlane(samplingPlane, bboxDiagonal) {
        if (!Array.isArray(samplingPlane) || samplingPlane.length === 0) return;
        const scale = bboxDiagonal;
        const mat = new THREE.LineBasicMaterial({ color: 0xff8800 });
        const parent = new THREE.Group();
        parent.name = 'Sampling Plane';
        this.surfaceGroups['Sampling Plane'] = parent;
        this.nurbsGroup.add(parent);

        for (const station of samplingPlane) {
            if (!station) continue;
            const u = station.axis_u, v = station.axis_v;
            if (!Array.isArray(u) || u.length < 3 || !Array.isArray(v) || v.length < 3) continue;
            if (u[0]*u[0] + u[1]*u[1] + u[2]*u[2] < 1e-12) continue;
            if (v[0]*v[0] + v[1]*v[1] + v[2]*v[2] < 1e-12) continue;
            if (!Array.isArray(station.origin) || station.origin.length < 3) continue;
            const o = new THREE.Vector3(station.origin[0], station.origin[1], station.origin[2]);
            const du = new THREE.Vector3(u[0], u[1], u[2]).multiplyScalar(scale);
            const dv = new THREE.Vector3(v[0], v[1], v[2]).multiplyScalar(scale);
            const a = o.clone();
            const b = o.clone().add(du);
            const c = o.clone().add(du).add(dv);
            const d = o.clone().add(dv);
            const geom = new THREE.BufferGeometry().setFromPoints([a, b, c, d]);
            parent.add(new THREE.LineLoop(geom, mat));
        }
    }

    /**
     * Build a THREE.Points cloud from `intermediate_products.v_samples`
     * records (each `{x, y, z}`). Stored in `this.vSamplesPoints` and
     * parented to nurbsGroup so the standard bbox-offset pass keeps it
     * aligned with the rest of the geometry. Hidden by default; toggled
     * via setVSamplesVisibility. Color: magenta 0xff00ff (matches the
     * guide curve color so the points visually associate with their
     * parent guides). Size 3px with sizeAttenuation off so the dots stay
     * legible regardless of camera distance.
     */
    addVSamplesPoints(points) {
        if (!Array.isArray(points) || points.length === 0) return;
        const positions = new Float32Array(points.length * 3);
        let writeIdx = 0;
        for (const p of points) {
            if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) continue;
            positions[writeIdx++] = p.x;
            positions[writeIdx++] = p.y;
            positions[writeIdx++] = p.z;
        }
        if (writeIdx === 0) return;
        const trimmed = writeIdx === positions.length
            ? positions
            : positions.slice(0, writeIdx);
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(trimmed, 3));
        const mat = new THREE.PointsMaterial({
            color: 0xff00ff,
            size: 3,
            sizeAttenuation: false,
        });
        const pts = new THREE.Points(geom, mat);
        pts.name = 'v_samples';
        pts.visible = false;
        this.vSamplesPoints = pts;
        this.nurbsGroup.add(pts);
    }

    /**
     * Build THREE.Line objects (one per v-station) from NURBS curve
     * descriptors stored in `intermediate_products.v_sections[]`.
     * Each curve is resampled at 64 points along [u_min, u_max] using
     * Cox-de-Boor B-spline basis evaluation; rational curves (dim=4)
     * divide by the homogeneous weight sum. Color: cyan 0x00ffff to
     * contrast with magenta v_samples (0xff00ff) and sampling-plane
     * orange (0xff8800). Hidden by default; toggled via
     * setVSectionsVisibility. Malformed descriptors (missing knots_u /
     * control_points / p_u, or empty CPs) are silently skipped.
     */
    addVSectionsCurves(curves) {
        if (!Array.isArray(curves) || curves.length === 0) return;
        const SAMPLES = 64;
        const mat = new THREE.LineBasicMaterial({ color: 0x00ffff, linewidth: 1 });
        for (const c of curves) {
            if (!c || typeof c !== 'object') continue;
            const p = (typeof c.p_u === 'number') ? c.p_u : null;
            const knots = Array.isArray(c.knots_u) ? c.knots_u : null;
            let cps = Array.isArray(c.control_points) ? c.control_points : null;
            if (cps && cps.length > 0 && typeof cps[0] === 'object' && cps[0] !== null && !Array.isArray(cps[0])) {
                cps = cps.map(cp => [cp.x, cp.y, cp.z, cp.w !== undefined ? cp.w : 1]);
            }
            const dim = (typeof c.dim === 'number') ? c.dim : 3;
            if (p === null || knots === null || cps === null) continue;
            if (knots.length < p + 2 || cps.length === 0) continue;
            const rational = (dim === 4);
            const stride = rational ? 4 : 3;
            const numCPs = Math.floor(cps.length / stride);
            if (numCPs < p + 1) continue;
            const uMin = (typeof c.u_min === 'number') ? c.u_min : knots[p];
            const uMax = (typeof c.u_max === 'number') ? c.u_max : knots[knots.length - p - 1];
            if (!(uMax > uMin)) continue;
            const positions = new Float32Array(SAMPLES * 3);
            for (let s = 0; s < SAMPLES; s++) {
                const t = uMin + (uMax - uMin) * (s / (SAMPLES - 1));
                const pt = this._evalBSplineCurve(t, p, knots, cps, numCPs, stride, rational);
                positions[s * 3]     = pt[0];
                positions[s * 3 + 1] = pt[1];
                positions[s * 3 + 2] = pt[2];
            }
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            const line = new THREE.Line(geom, mat);
            const idxLabel = (typeof c.v_index === 'number') ? c.v_index : '?';
            line.name = `v_section_${idxLabel}`;
            line.userData.label = `v_section v_index=${idxLabel} v=${(typeof c.v === 'number') ? c.v.toFixed(3) : '?'}`;
            line.userData.kind = 'v_section';
            line.visible = false;
            this.vSectionLines.push(line);
            this.nurbsGroup.add(line);
        }
    }

    /**
     * Build THREE.Line objects (one per entry) from NURBS curve
     * descriptors stored in `intermediate_products.proxied_guides[]`.
     * Each curve is resampled at 64 points along [v_min, v_max] using
     * Cox-de-Boor B-spline basis evaluation; rational curves (dim=4)
     * divide by the homogeneous weight sum. The curve is evaluated
     * along v (knots_v + p_v) since the proxy replaces an original
     * guide curve. Color: red 0xff2222 with a dashed material so the
     * proxy visually contrasts with the magenta original guide
     * (0xff00ff) and the green spine default (0x008800). Hidden by
     * default; toggled via setProxiedGuidesVisibility. Malformed
     * descriptors (missing knots_v / control_points / p_v, or empty
     * CPs) are silently skipped. Control points accept both the flat
     * `[x,y,z,w,...]` form (with optional stride=3 or 4) and the
     * object form `[{x,y,z,w}, ...]`, mirroring addNurbs curve
     * handling.
     */
    addProxiedGuidesCurves(curves) {
        if (!Array.isArray(curves) || curves.length === 0) return;
        const SAMPLES = 64;
        const mat = new THREE.LineBasicMaterial({ color: 0xff2222, linewidth: 2 });
        for (const c of curves) {
            if (!c || typeof c !== 'object') continue;
            const p = (typeof c.p_v === 'number') ? c.p_v : null;
            const knots = Array.isArray(c.knots_v) ? c.knots_v : null;
            let rawCPs = Array.isArray(c.control_points) ? c.control_points : null;
            let isFlatObj = false;
            if (rawCPs && rawCPs.length > 0 && typeof rawCPs[0] === 'object') {
                const flat = [];
                rawCPs.forEach(pt => flat.push(pt.x, pt.y, pt.z, (typeof pt.w === 'number') ? pt.w : 1.0));
                rawCPs = flat;
                isFlatObj = true;
            }
            if (p === null || knots === null || rawCPs === null) continue;
            if (knots.length < p + 2 || rawCPs.length === 0) continue;
            const dim = (typeof c.dim === 'number') ? c.dim : 3;
            const rational = (dim === 4);
            const stride = isFlatObj ? 4 : (rational ? 4 : 3);
            const numCPs = Math.floor(rawCPs.length / stride);
            if (numCPs < p + 1) continue;
            const vMin = (typeof c.v_min === 'number') ? c.v_min : knots[p];
            const vMax = (typeof c.v_max === 'number') ? c.v_max : knots[knots.length - p - 1];
            if (!(vMax > vMin)) continue;
            const positions = new Float32Array(SAMPLES * 3);
            for (let s = 0; s < SAMPLES; s++) {
                const t = vMin + (vMax - vMin) * (s / (SAMPLES - 1));
                const pt = this._evalBSplineCurve(t, p, knots, rawCPs, numCPs, stride, rational);
                positions[s * 3]     = pt[0];
                positions[s * 3 + 1] = pt[1];
                positions[s * 3 + 2] = pt[2];
            }
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            const line = new THREE.Line(geom, mat);
            const idxLabel = c.label || `${this.proxiedGuideLines.length}`;
            line.name = `proxied_guide_${idxLabel}`;
            line.userData.label = `proxied_guide: ${c.label || idxLabel}`;
            line.userData.kind = 'proxied_guide';
            line.visible = false;
            this.proxiedGuideLines.push(line);
            this.nurbsGroup.add(line);
        }
    }

    /**
     * Build one THREE.Line per v-sample that carries a valid
     * `nominal_position` (i.e. `hasNominal === true`). Each line goes
     * from the nominal manifold point Q_k = (nx, ny, nz) to the
     * anchor G_k = (x, y, z); together they visualize how far the
     * cross-section intersection drifted away from the ideal
     * free-form path. Color: lime green 0x00ff00 for high contrast
     * with the magenta v_samples (0xff00ff). Hidden by default;
     * toggled via setDisplacementVectorsVisibility. Records with
     * NaN/Infinity in any of the 6 coords are silently skipped
     * (defensive against malformed envelope entries).
     */
    addDisplacementVectors(samples) {
        if (!Array.isArray(samples) || samples.length === 0) return;
        const mat = new THREE.LineBasicMaterial({ color: 0x00ff00 });
        for (const s of samples) {
            if (!s || s.hasNominal !== true) continue;
            if (!Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(s.z)) continue;
            if (!Number.isFinite(s.nx) || !Number.isFinite(s.ny) || !Number.isFinite(s.nz)) continue;
            const geom = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(s.nx, s.ny, s.nz),
                new THREE.Vector3(s.x, s.y, s.z),
            ]);
            const line = new THREE.Line(geom, mat);
            line.name = 'displacement_vector';
            line.userData.label = 'displacement_vector';
            line.userData.kind = 'displacement_vector';
            line.visible = false;
            this.displacementVectors.push(line);
            this.nurbsGroup.add(line);
        }
    }

    /**
     * Cox-de-Boor evaluation of a (possibly rational) B-spline curve at
     * parameter `t`. Returns a 3-component array [x, y, z]. Algorithm:
     *   1. Find span s.t. knots[s] <= t < knots[s+1]; clamp to last
     *      valid span when t == u_max (the standard edge case).
     *   2. Compute p+1 non-zero B-spline basis values via the
     *      de-Boor recursion table.
     *   3. For rational curves, divide the weighted CP sum by the
     *      sum of weights; for non-rational curves, take the direct
     *      linear combination over CPs [s-p..s].
     */
    _evalBSplineCurve(t, p, knots, cps, numCPs, stride, rational) {
        const n = knots.length - 1;
        let s = 0;
        for (let i = p; i < n - p; i++) {
            if (knots[i] <= t && t < knots[i + 1]) { s = i; break; }
            if (i === n - p - 1 && t >= knots[i + 1]) s = i;
        }
        const basis = this._bSplineBasis(p, t, s, knots);
        const offset = (s - p) * stride;
        let x, y, z, w;
        if (rational) {
            let wx = 0, wy = 0, wz = 0, wsum = 0;
            for (let j = 0; j <= p; j++) {
                const idx = offset + j * stride;
                w = cps[idx + 3];
                wx += basis[j] * cps[idx]     * w;
                wy += basis[j] * cps[idx + 1] * w;
                wz += basis[j] * cps[idx + 2] * w;
                wsum += basis[j] * w;
            }
            if (Math.abs(wsum) < 1e-12) { x = y = z = 0; }
            else { x = wx / wsum; y = wy / wsum; z = wz / wsum; }
        } else {
            x = y = z = 0;
            for (let j = 0; j <= p; j++) {
                const idx = offset + j * stride;
                x += basis[j] * cps[idx];
                y += basis[j] * cps[idx + 1];
                z += basis[j] * cps[idx + 2];
            }
        }
        return [x, y, z];
    }

    /**
     * Standard Cox-de-Boor recursion: returns an array of length p+1
     * containing the non-zero basis values N_{s-p, p}(t) .. N_{s, p}(t)
     * at parameter `t` for span index `s`. Uses left/right temporary
     * arrays (the "The NURBS Book" Algorithm A2.2 formulation).
     */
    _bSplineBasis(p, t, s, knots) {
        const N = new Float64Array(p + 1);
        const left = new Float64Array(p + 1);
        const right = new Float64Array(p + 1);
        N[0] = 1.0;
        for (let i = 1; i <= p; i++) {
            left[i]  = t - knots[s + 1 - i];
            right[i] = knots[s + i] - t;
            let saved = 0.0;
            for (let j = 0; j < i; j++) {
                const denom = right[j + 1] + left[i - j];
                const term = (Math.abs(denom) < 1e-12) ? 0.0 : N[j] / denom;
                N[j] = saved + right[j + 1] * term;
                saved = left[i - j] * term;
            }
            N[i] = saved;
        }
        const out = new Array(p + 1);
        for (let k = 0; k <= p; k++) out[k] = N[k];
        return out;
    }

    // ---- v1.1 audit-data overlay renderers --------------------------------

    // Per-profile / per-guide deviation heatmap: color a small sphere
    // placed at each profile/guide position with a heat color
    // (green -> yellow -> red) so the reviewer can spot outliers at
    // a glance. The sphere size scales with the deviation magnitude.
    _addAuditHeatmaps(process) {
        const grp = new THREE.Group();
        grp.name = 'heatmaps';
        if (process.profile_attachment) {
            process.profile_attachment.forEach(rep => {
                this._addAdhesionSphere(grp, rep, 0xff3366, 'profile_attachment');
            });
        }
        if (process.guide_attachment) {
            process.guide_attachment.forEach(rep => {
                this._addAdhesionSphere(grp, rep, 0x3366ff, 'guide_attachment');
            });
        }
        if (process.surface_bounds) {
            const b = process.surface_bounds;
            const tag = b.out_of_bounds_cps > 0
                ? `bounds: ${b.out_of_bounds_cps} OOB`
                : `bounds: OK (z=[${b.z_min?.toFixed?.(3)}, ${b.z_max?.toFixed?.(3)}])`;
            grp.userData.textAnnotations = grp.userData.textAnnotations || [];
            grp.userData.textAnnotations.push({ text: tag, color: b.out_of_bounds_cps > 0 ? 0xff3366 : 0x44ff44 });
        }
        this.auditGroup.add(grp);
        this.auditLayers['heatmaps'] = grp;
    }

    _addAdhesionSphere(parent, rep, baseColor, kind) {
        if (!rep || rep.max_distance === undefined || rep.max_distance === null) return;
        if (rep.v_param === undefined) return;
        const d = rep.max_distance;
        const heat = this._heatColor(d, kind === 'guide_attachment' ? 0.1 : 0.01);
        const sphereSize = Math.min(0.1, 0.02 + d * 2);
        const geom = new THREE.SphereGeometry(sphereSize, 12, 12);
        const mat = new THREE.MeshBasicMaterial({ color: heat, transparent: true, opacity: 0.8 });
        const sphere = new THREE.Mesh(geom, mat);
        sphere.position.set(rep.v_param * 10 - 5, 5, 0);
        sphere.userData.label = `${kind} #${rep.profile_index ?? rep.guide_index ?? '?'}: ${d.toExponential(2)}`;
        sphere.userData.kind = kind;
        parent.add(sphere);
    }

    _heatColor(value, scale) {
        const t = Math.min(1.0, Math.max(0.0, value / scale));
        if (t < 0.5) {
            const u = t * 2;
            const r = Math.round(0x44 + (0xff - 0x44) * u);
            const g = Math.round(0xff);
            const b = Math.round(0x44 + (0x44 - 0x44) * u);
            return (r << 16) | (g << 8) | b;
        }
        const u = (t - 0.5) * 2;
        const r = Math.round(0xff);
        const g = Math.round(0xff + (0x44 - 0xff) * u);
        const b = Math.round(0x44);
        return (r << 16) | (g << 8) | b;
    }

    // ---- v1.2 coupling-relationships overlay renderer --------------------

    _couplingKindColor(kind) {
        switch (kind) {
            case 'guide_induced':   return 0x007fff;
            case 'user_specified':  return 0xffaa00;
            case 'phase_alignment': return 0x00cc66;
            case 'topology_group':  return 0x9933ff;
            default:                return 0xffffff;
        }
    }

    _addCouplingRelationships(couplings) {
        const grp = new THREE.Group();
        grp.name = 'couplings';
        couplings.forEach(rel => {
            if (!rel || !Array.isArray(rel.endpoints) || rel.endpoints.length < 2) return;
            const color = this._couplingKindColor(rel.kind);
            const mat = new THREE.LineBasicMaterial({
                color,
                transparent: true,
                opacity: 0.9,
            });
            const pts = rel.endpoints.slice(0, 2).map(e => new THREE.Vector3(
                e.position[0], e.position[1], e.position[2]
            ));
            // Skip degenerate lines but keep the endpoint marker (user_specified
            // collapses both endpoints onto the same point).
            if (pts[0].distanceToSquared(pts[1]) > 1e-12) {
                const geom = new THREE.BufferGeometry().setFromPoints(pts);
                const line = new THREE.Line(geom, mat);
                line.userData.label = rel.id;
                line.userData.kind = rel.kind;
                line.userData.metadata = rel.metadata || {};
                grp.add(line);
            }
            const sphereGeom = new THREE.SphereGeometry(0.04, 8, 8);
            const sphereMat = new THREE.MeshBasicMaterial({
                color,
                transparent: true,
                opacity: 0.9,
            });
            pts.forEach((p, idx) => {
                const sphere = new THREE.Mesh(sphereGeom, sphereMat);
                sphere.position.copy(p);
                sphere.userData.label = `${rel.id}#ep${idx}`;
                sphere.userData.kind = rel.kind;
                grp.add(sphere);
            });
        });
        this.auditGroup.add(grp);
        this.auditLayers['couplings'] = grp;
    }

    // ---- VxLoft14 visualization debug overlay renderer ------------------

    _debugMarkerColor(colorCode, defaultColor = 0xff0055) {
        switch (colorCode) {
            case 1: return 0xff2222; // red (Guide attach fail)
            case 2: return 0x22cc22; // green
            case 3: return 0xffaa00; // yellow / orange (Profile attach/adhesion fail)
            case 4: return 0x2288ff; // blue
            case 5: return 0xee00ee; // magenta (Surface bounds fail)
            case 6: return 0x00eeee; // cyan (Continuity fail)
            default: return defaultColor;
        }
    }

    // Render a short text label as a THREE.Sprite using a CanvasTexture.
    // size is the OD_real VxDbAnnoDisp font-size hint (typically 1.0);
    // we scale the sprite by it so multi-line annotations are visually
    // proportional across the gallery.
    _makeAnnoSprite(text, color, size = 1.0) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const basePx = 36;  // ~0.5 world-unit at scale=1; we scale by size
        const fontPx = Math.max(10, Math.round(basePx * Math.max(0.25, size) * dpr));
        const padding = 4 * dpr;
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        ctx.font = `${fontPx}px sans-serif`;
        const metrics = ctx.measureText(text);
        const w = Math.ceil(metrics.width) + 2 * padding;
        const h = fontPx + 2 * padding;
        canvas.width = w;
        canvas.height = h;
        // Re-apply font after canvas resize (browser resets the context).
        ctx.font = `${fontPx}px sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#000000cc';   // dark backing for legibility
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
        ctx.fillText(text, w / 2, h / 2);
        const tex = new THREE.CanvasTexture(canvas);
        tex.needsUpdate = true;
        const mat = new THREE.SpriteMaterial({
            map: tex,
            transparent: true,
            depthTest: false
        });
        const sprite = new THREE.Sprite(mat);
        // Match canvas aspect; scale by the requested size.
        sprite.scale.set(w / h * 0.2 * size, 0.2 * size, 1);
        return sprite;
    }

    _addDebugMarkers(markers) {
        const grp = new THREE.Group();
        grp.name = 'debug_markers';

        markers.forEach(m => {
            if (!m) return;
            if (m.kind === 'point') {
                const pts = m.data || [];
                if (pts.length >= 3) {
                    // Sphere radius scales with m.data[3] when present (anno
                    // marker reuses this path for text-annotation points via
                    // the "point" kind; we leave the data[3] interpretation
                    // to the anno branch below). For plain point markers
                    // data[3] is undefined and we use the default size.
                    const sphereGeom = new THREE.SphereGeometry(0.06, 12, 12);
                    const sphereMat = new THREE.MeshBasicMaterial({
                        color: this._debugMarkerColor(m.color, 0xff0044),
                        transparent: true,
                        opacity: 0.95
                    });
                    const sphere = new THREE.Mesh(sphereGeom, sphereMat);
                    sphere.position.set(pts[0], pts[1], pts[2]);
                    sphere.userData.label = m.label || 'Debug Point';
                    grp.add(sphere);
                }
            } else if (m.kind === 'anno') {
                // Text annotation: m.data is [x, y, z, size]; m.label is the
                // text content. Render with THREE.Sprite + canvas texture so
                // the label stays readable regardless of camera distance.
                const pts = m.data || [];
                if (pts.length >= 4) {
                    const [x, y, z, size] = pts;
                    const text = m.label || '';
                    if (text.length === 0) return;
                    const sprite = this._makeAnnoSprite(text,
                        this._debugMarkerColor(m.color, 0xffffff),
                        size);
                    sprite.position.set(x, y, z);
                    sprite.userData.label = text;
                    grp.add(sprite);
                }
            } else if (m.kind === 'curve') {
                const raw = m.data || [];
                if (raw.length >= 6) {
                    const pts = [];
                    const stride = (raw.length % 3 === 0) ? 3 : 4;
                    for (let i = 0; i < raw.length; i += stride) {
                        pts.push(new THREE.Vector3(raw[i], raw[i+1], raw[i+2]));
                    }
                    const geom = new THREE.BufferGeometry().setFromPoints(pts);
                    const lineMat = new THREE.LineBasicMaterial({
                        color: this._debugMarkerColor(m.color, 0xff00aa),
                        linewidth: 2,
                        transparent: true,
                        opacity: 0.9
                    });
                    const line = new THREE.Line(geom, lineMat);
                    line.userData.label = m.label || 'Debug Curve';
                    grp.add(line);
                }
            } else if (m.kind === 'surface' || m.kind === 'surface_color') {
                try {
                    const meta = (m.failure_kind || '').split(',');
                    if (meta.length >= 7) {
                        const degU = parseInt(meta[0], 10);
                        const degV = parseInt(meta[1], 10);
                        const nRows = parseInt(meta[2], 10);
                        const nCols = parseInt(meta[3], 10);
                        const nKnotsU = parseInt(meta[4], 10);
                        const nKnotsV = parseInt(meta[5], 10);
                        const dim = parseInt(meta[6], 10);

                        const totalCpCoords = nRows * nCols * dim;
                        const raw = m.data || [];
                        if (raw.length >= totalCpCoords + nKnotsU + nKnotsV) {
                            const knotsU = raw.slice(totalCpCoords, totalCpCoords + nKnotsU);
                            const knotsV = raw.slice(totalCpCoords + nKnotsU, totalCpCoords + nKnotsU + nKnotsV);

                            const controlPoints = [];
                            for (let i = 0; i < nCols; i++) {
                                controlPoints[i] = [];
                                for (let j = 0; j < nRows; j++) {
                                    const idx = (j * nCols + i) * dim;
                                    controlPoints[i][j] = new THREE.Vector4(
                                        raw[idx], raw[idx+1], raw[idx+2],
                                        dim >= 4 ? raw[idx+3] : 1.0
                                    );
                                }
                            }
                            const ns = new NURBSSurface(degU, degV, knotsU, knotsV, controlPoints);
                            const getSamples = (knots, p, steps) => {
                                const min = knots[p], max = knots[knots.length - p - 1], range = max - min;
                                let s = []; for (let step = 0; step <= steps; step++) s.push(step / steps);
                                for (let step = p; step < knots.length - p; step++) if (range > 0) s.push((knots[step] - min) / range);
                                s.sort((a, b) => a - b);
                                let u = [s[0]]; for (let step = 1; step < s.length; step++) if (s[step] - u[u.length-1] > 1e-6) u.push(s[step]);
                                return u;
                            };
                            const uS = getSamples(knotsU, degU, 25), vS = getSamples(knotsV, degV, 25);
                            const geom = new THREE.BufferGeometry();
                            const verts = [], uvs = [], idxs = [];
                            const target = new THREE.Vector3();
                            for (let j = 0; j < vS.length; j++) {
                                for (let i = 0; i < uS.length; i++) {
                                    ns.getPoint(uS[i], vS[j], target);
                                    verts.push(target.x, target.y, target.z);
                                    uvs.push(uS[i], vS[j]);
                                }
                            }
                            for (let j = 0; j < vS.length - 1; j++) {
                                for (let i = 0; i < uS.length - 1; i++) {
                                    const a = i + j * uS.length, b = i + 1 + j * uS.length,
                                          c = i + (j + 1) * uS.length, d = i + 1 + (j + 1) * uS.length;
                                    idxs.push(a, b, d, a, d, c);
                                }
                            }
                            geom.setIndex(idxs);
                            geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
                            geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
                            geom.computeVertexNormals();

                            const srfColor = this._debugMarkerColor(m.color, 0xff0044);
                            const mat = new THREE.MeshPhongMaterial({
                                color: srfColor,
                                wireframe: false,
                                transparent: true,
                                opacity: 0.45,
                                side: THREE.DoubleSide
                            });
                            const mesh = new THREE.Mesh(geom, mat);
                            mesh.userData.label = m.label || 'Debug Surface';
                            grp.add(mesh);
                        }
                    }
                } catch (e) {
                    console.warn('Viewer3D: failed to parse debug NURBS surface', e);
                }
            }
        });

        this.auditGroup.add(grp);
        this.auditLayers['debug_markers'] = grp;
    }

    setAuditLayer(layerKey, visible) {
        if (this.auditLayers[layerKey]) {
            this.auditLayers[layerKey].visible = visible;
        }
    }

    // ---- Stage-1 (Profile Coupling) debug overlay API --------------------

    /**
     * Build the Stage-1 visualization (seam markers + tangent arrows +
     * ruling lines) from a parsed `case.debug.stage1_coupling` envelope.
     * The three Three.js Groups are populated; their visibility is
     * driven by the separate setters below. Defensive against missing
     * input (legacy envelopes): toggles the groups invisible and
     * console-logs a one-liner.
     *
     * Stage-1 marker sizes are bbox-relative (scale invariance): the
     * scene bbox is computed from the union of currently-loaded
     * geometries (mesh + nurbs + audit + skeleton + Stage 1 markers),
     * and seam-sphere radius / tangent-arrow length are fractions of
     * that diagonal with hard clamps so they remain readable on
     * millimeter-scale and meter-scale cases alike.
     */
    setCouplingDebug(coupling) {
        this._recomputeStage1BBox();

        if (!coupling || typeof coupling !== 'object') {
            console.info('Viewer3D: no stage1_coupling debug data — overlays hidden.');
            if (this.seamMarkersGroup) this.seamMarkersGroup.visible = false;
            if (this.tangentArrowsGroup) this.tangentArrowsGroup.visible = false;
            if (this.rulingLinesGroup) this.rulingLinesGroup.visible = false;
            return;
        }
        const seams = Array.isArray(coupling.seams) ? coupling.seams : [];
        const rulingLines = Array.isArray(coupling.ruling_lines) ? coupling.ruling_lines : [];

        // Scale-invariant dimensions (clamped). All ratios come from the
        // spec's "Scale Invariance" clause (Task B §4 Viewer3D.js).
        const diagonal = this.stage1BBox.diagonal;
        const seamRadius = Math.max(0.005, Math.min(0.2, diagonal * 0.015));
        const tangentLength = Math.max(0.05, Math.min(1.5, diagonal * 0.06));
        const tangentHeadLen = Math.max(0.02, Math.min(0.6, diagonal * 0.014));
        const tangentHeadWidth = Math.max(0.01, Math.min(0.4, diagonal * 0.009));
        const rulingEndRadius = seamRadius;

        // Seam markers: one sphere + label sprite per seam.
        for (const seam of seams) {
            if (!seam || !Array.isArray(seam.start_point) || seam.start_point.length < 3) continue;
            const [x, y, z] = seam.start_point;
            const colorHex = this._hexFromColorString(seam.color, 0xff8844);
            const sphereGeom = new THREE.SphereGeometry(seamRadius, 16, 16);
            const sphereMat = new THREE.MeshBasicMaterial({ color: colorHex });
            const sphere = new THREE.Mesh(sphereGeom, sphereMat);
            sphere.position.set(x, y, z);
            sphere.userData.label = seam.label
                || `seam_p${seam.profile_index ?? '?'}`;
            sphere.userData.kind = 'seam_marker';
            this.seamMarkersGroup.add(sphere);

            if (seam.label) {
                try {
                    const sprite = this._makeAnnoSprite(seam.label, colorHex, 0.5);
                    sprite.position.set(x, y + seamRadius * 1.6, z);
                    sprite.userData.label = seam.label;
                    this.seamMarkersGroup.add(sprite);
                } catch (e) { /* label sprites are best-effort */ }
            }
        }

        // Tangent arrows: one ArrowHelper per seam.
        // Producers may emit the tangent vector under either `tangent`
        // (current gallery-output convention) or `tangent_vector`
        // (legacy debug envelope) — accept both for backwards compat.
        for (const seam of seams) {
            if (!seam) continue;
            if (!Array.isArray(seam.start_point) || seam.start_point.length < 3) continue;
            const tangentRaw = (Array.isArray(seam.tangent) && seam.tangent.length >= 3)
                ? seam.tangent
                : (Array.isArray(seam.tangent_vector) && seam.tangent_vector.length >= 3)
                    ? seam.tangent_vector : null;
            if (!tangentRaw) continue;
            const [x, y, z] = seam.start_point;
            const [tx, ty, tz] = tangentRaw;
            const tangent = new THREE.Vector3(tx, ty, tz);
            const len = tangent.length();
            if (len < 1e-9) continue;
            const dir = tangent.clone().multiplyScalar(1 / len);
            const origin = new THREE.Vector3(x, y, z);
            const colorHex = this._hexFromColorString(seam.color, 0xff8844);
            const arrow = new THREE.ArrowHelper(
                dir, origin, tangentLength, colorHex, tangentHeadLen, tangentHeadWidth
            );
            arrow.userData.label = seam.label || `tangent_p${seam.profile_index ?? '?'}`;
            arrow.userData.kind = 'tangent_arrow';
            this.tangentArrowsGroup.add(arrow);
        }

        // Ruling lines: thick Line2 (linewidth works in world space,
        // unlike LineBasicMaterial) per ruling-line entry. Small endpoint
        // spheres make the line-to-profile intersection visually obvious.
        const screenSize = () => Math.max(1, Math.min(window.innerWidth, window.innerHeight));
        const rulingWidthPx = Math.max(2, Math.min(4, screenSize() * 0.003));
        for (const rl of rulingLines) {
            if (!rl) continue;
            if (!Array.isArray(rl.from) || rl.from.length < 3) continue;
            if (!Array.isArray(rl.to) || rl.to.length < 3) continue;
            const fromV = new THREE.Vector3(rl.from[0], rl.from[1], rl.from[2]);
            const toV = new THREE.Vector3(rl.to[0], rl.to[1], rl.to[2]);
            const colorHex = this._hexFromColorString(rl.color, 0xff6633);
            const lineGeom = new LineGeometry();
            lineGeom.setPositions([fromV.x, fromV.y, fromV.z, toV.x, toV.y, toV.z]);
            const lineMat = new LineMaterial({
                color: colorHex,
                linewidth: rulingWidthPx,
                transparent: true,
                opacity: 0.9,
                worldUnits: false,
            });
            lineMat.resolution.set(window.innerWidth, window.innerHeight);
            const line = new Line2(lineGeom, lineMat);
            line.computeLineDistances();
            line.userData.label = 'ruling_line';
            line.userData.kind = 'ruling_line';
            line.userData.material = lineMat;
            this.rulingLinesGroup.add(line);

            const endSphereGeom = new THREE.SphereGeometry(rulingEndRadius, 12, 12);
            const endSphereMat = new THREE.MeshBasicMaterial({ color: colorHex });
            this.rulingLinesGroup.add(new THREE.Mesh(endSphereGeom, endSphereMat).translateX(fromV.x).translateY(fromV.y).translateZ(fromV.z));
            this.rulingLinesGroup.add(new THREE.Mesh(endSphereGeom, endSphereMat).translateX(toV.x).translateY(toV.y).translateZ(toV.z));
        }

        console.info(
            `Viewer3D: stage1_coupling built (seams=${seams.length}, `
            + `ruling_lines=${rulingLines.length}, diagonal=${diagonal.toFixed(3)}).`
        );
    }

    /**
     * Recompute the Stage-1 scene bbox from the union of all currently
     * loaded geometries (mesh + nurbsGroup + auditGroup + markers).
     * Caches the result in `this.stage1BBox` and is called by
     * setCouplingDebug on every case load. Empty scenes fall back to
     * a unit diagonal so callers can divide safely.
     */
    _recomputeStage1BBox() {
        const bbox = new THREE.Box3();
        if (this.mesh && this.mesh.geometry && this.mesh.geometry.attributes.position) {
            bbox.expandByObject(this.mesh);
        }
        if (this.nurbsGroup) bbox.expandByObject(this.nurbsGroup);
        if (this.auditGroup) bbox.expandByObject(this.auditGroup);
        if (this.markersGroup) bbox.expandByObject(this.markersGroup);

        const min = new THREE.Vector3();
        const max = new THREE.Vector3();
        const center = new THREE.Vector3();
        let diagonal = 1.0;
        if (!bbox.isEmpty()) {
            min.copy(bbox.min);
            max.copy(bbox.max);
            center.copy(bbox.getCenter(new THREE.Vector3()));
            const size = new THREE.Vector3().subVectors(max, min);
            diagonal = Math.max(1e-6, size.length());
        }
        this.stage1BBox = { min, max, center, diagonal };
    }

    /**
     * Public accessor for the cached Stage-1 scene bbox. Returns a
     * fresh object so callers can't mutate internal state. Diagonal is
     * 1 for empty scenes.
     */
    getStage1SceneBBox() {
        return {
            min: this.stage1BBox.min.clone(),
            max: this.stage1BBox.max.clone(),
            center: this.stage1BBox.center.clone(),
            diagonal: this.stage1BBox.diagonal,
        };
    }

    /**
     * Toggle visibility on all output surfaces (FreeBlend3D /
     * AffineTransport / NominalManifold / etc.). Used by Tab 2 to
     * strip the output surfaces from the coupling viewport.
     */
    hideSurfaces() {
        // Hide both render paths: tessellated mesh + NURBS surfaceGroups.
        if (this.mesh) this.mesh.visible = false;
        if (this.normalsHelper) this.normalsHelper.visible = false;
        if (this.wireframeMesh) this.wireframeMesh.visible = false;
        if (!this.surfaceGroups) return;
        for (const g of Object.values(this.surfaceGroups)) {
            if (g) g.visible = false;
        }
    }

    showSurfaces() {
        if (this.mesh) this.mesh.visible = true;
        if (this.normalsHelper) this.normalsHelper.visible = true;
        if (this.wireframeMesh) this.wireframeMesh.visible = true;
        if (!this.surfaceGroups) return;
        for (const g of Object.values(this.surfaceGroups)) {
            if (g) g.visible = true;
        }
    }

    /**
     * Return a Three.js Group containing every NURBS curve currently
     * in the scene (Profiles + Spine + Guides), but NOT surfaces.
     * The reference is stable across panel swaps and survives until
     * loadMesh clears the nurbsGroup on the next case change.
     */
    getPersistentSkeletonGroup() {
        const skeleton = new THREE.Group();
        skeleton.name = 'persistentSkeleton';
        if (!this.curveGroups) return skeleton;
        for (const label of Object.keys(this.curveGroups)) {
            const g = this.curveGroups[label];
            if (!g) continue;
            const wrapper = new THREE.Group();
            wrapper.name = label;
            for (const child of g.children) wrapper.add(child.clone(true));
            skeleton.add(wrapper);
        }
        return skeleton;
    }

    /**
     * Bulk toggle for Stage-1 overlays. Equivalent to calling the three
     * setSeamMarkersVisibility / setTangentArrowsVisibility /
     * setRulingLinesVisibility setters in sequence.
     */
    setStage1Visibility(seam, tangent, ruling) {
        this.setSeamMarkersVisibility(!!seam);
        this.setTangentArrowsVisibility(!!tangent);
        this.setRulingLinesVisibility(!!ruling);
    }

    /**
     * Force a renderer resize to the current container. Called after
     * the canvas is re-parented (e.g. when swapping between Tab 1 and
     * Tab 2 viewports) so the WebGL viewport + LineMaterial.resolution
     * stay in sync.
     */
    handleResize() {
        if (!this.renderer || !this.camera) return;
        const parent = this.renderer.domElement && this.renderer.domElement.parentNode;
        if (parent) {
            const w = parent.clientWidth || window.innerWidth;
            const h = parent.clientHeight || window.innerHeight;
            this.renderer.setSize(w, h, false);
            this.camera.aspect = w / h;
            this.camera.updateProjectionMatrix();
        } else {
            this.renderer.setSize(window.innerWidth, window.innerHeight);
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
        }
        if (this.rulingLinesGroup) {
            this.rulingLinesGroup.traverse((obj) => {
                if (obj.userData && obj.userData.material
                    && obj.userData.material.resolution) {
                    obj.userData.material.resolution.set(
                        window.innerWidth, window.innerHeight,
                    );
                }
            });
        }
    }

    /**
     * Convert a CSS color string ('#ff8844' or 'rgb(...)') into a 24-bit
     * integer hex (0xff8844). Falls back to the supplied default when
     * parsing fails. Defensive against malformed color values in the
     * case.debug envelope.
     */
    _hexFromColorString(colorStr, fallback) {
        if (typeof colorStr !== 'string') return fallback;
        const s = colorStr.trim();
        if (s.startsWith('#') && (s.length === 7 || s.length === 4)) {
            let hex = (s.length === 4)
                ? '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]
                : s;
            const n = parseInt(hex.slice(1), 16);
            if (!Number.isNaN(n)) return n;
        }
        // Try the browser's CSS color parser — works in Chromium under
        // Vite dev. Cheap, no canvas needed for the value extraction.
        if (typeof document !== 'undefined') {
            try {
                const probe = document.createElement('div');
                probe.style.color = s;
                document.body.appendChild(probe);
                const rgb = getComputedStyle(probe).color;
                document.body.removeChild(probe);
                const m = rgb.match(/rgb\((\d+),\s*(\d+),\s*(\d+)/);
                if (m) return (parseInt(m[1], 10) << 16)
                              | (parseInt(m[2], 10) << 8)
                              | parseInt(m[3], 10);
            } catch (e) { /* fall through */ }
        }
        return fallback;
    }

    setSeamMarkersVisibility(visible) {
        if (this.seamMarkersGroup) this.seamMarkersGroup.visible = visible;
    }

    setTangentArrowsVisibility(visible) {
        if (this.tangentArrowsGroup) this.tangentArrowsGroup.visible = visible;
    }

    setRulingLinesVisibility(visible) {
        if (this.rulingLinesGroup) this.rulingLinesGroup.visible = visible;
    }

    setVSamplesVisibility(visible) {
        if (this.vSamplesPoints) this.vSamplesPoints.visible = visible;
    }

    setDisplacementVectorsVisibility(visible) {
        if (!Array.isArray(this.displacementVectors)) return;
        for (const ln of this.displacementVectors) {
            if (ln) ln.visible = visible;
        }
    }

    setVSectionsVisibility(visible) {
        if (!Array.isArray(this.vSectionLines)) return;
        for (const ln of this.vSectionLines) {
            if (ln) ln.visible = visible;
        }
    }

    setProxiedGuidesVisibility(visible) {
        if (!Array.isArray(this.proxiedGuideLines)) return;
        for (const ln of this.proxiedGuideLines) {
            if (ln) ln.visible = visible;
        }
    }

    setSurfaceVisibility(label, visible) {
        if (this.surfaceGroups[label]) this.surfaceGroups[label].visible = visible;
    }

    setCurveVisibility(label, visible) {
        if (this.curveGroups && this.curveGroups[label]) {
            this.curveGroups[label].visible = visible;
        }
    }

    setWireframe(enabled) { this.nurbsGroup.traverse(c => { if (c.material) c.material.wireframe = enabled; }); }
    setControlPolygon(enabled) { this.nurbsGroup.traverse(c => { if (c.type === 'Line' && c.material && c.material.opacity < 0.5) c.visible = enabled; }); }
    setGrid(enabled) { if (this.grid) this.grid.visible = enabled; if (this.gridXZ) this.gridXZ.visible = enabled; }
    setMeshColor(color) { this.material.color.set(color); }

    _makeNurbsCurveFromDescriptor(data) {
        if (!data) return null;
        try {
            const p = (data.degree !== undefined) ? data.degree : data.p;
                    let rawCPs = data.controlPoints || data.control_points;
                    let isFlatObj = false;
                    if (rawCPs && rawCPs.length > 0 && typeof rawCPs[0] === 'object') {
                        const flat = [];
                        rawCPs.forEach(pt => flat.push(pt.x, pt.y, pt.z, pt.w !== undefined ? pt.w : 1));
                        rawCPs = flat;
                        isFlatObj = true;
                    }
            if (!rawCPs || rawCPs.length === 0) return null;

            let curveKnots;
            let numPts;
            if (data.knots && data.knots.length > 0) {
                curveKnots = Array.from(data.knots);
                numPts = curveKnots.length - p - 1;
            } else {
                numPts = isFlatObj ? (rawCPs.length / 4) : Math.floor(rawCPs.length / 4);
                curveKnots = [];
                for (let k = 0; k <= p; k++) curveKnots.push(0);
                for (let k = 1; k < numPts - p; k++) curveKnots.push(k);
                for (let k = 0; k <= p; k++) curveKnots.push(Math.max(1, numPts - p));
            }
            const dataDim = (typeof data.dim === 'number') ? data.dim : null;
            const realStride = isFlatObj
                ? 4
                : ((dataDim === 3 && rawCPs.length % 3 === 0) ? 3 : 4);
            const numCPsProvided = Math.floor(rawCPs.length / realStride);
            const cps = [];
            for (let i = 0; i < numPts; i++) {
                const idx = (i % numCPsProvided) * realStride;
                cps.push(new THREE.Vector4(
                    rawCPs[idx], rawCPs[idx + 1], rawCPs[idx + 2],
                    realStride === 4 ? rawCPs[idx + 3] : 1.0
                ));
            }
            return new NURBSCurve(p, curveKnots, cps);
        } catch (e) {
            console.error('Viewer3D: failed to build NURBSCurve from descriptor', e);
            return null;
        }
    }

    _makePolylineFromDescriptor(data, samples = 100) {
        const curve = this._makeNurbsCurveFromDescriptor(data);
        if (!curve) return null;
        const pts = curve.getPoints(samples);
        for (const p of pts) {
            if (isNaN(p.x) || isNaN(p.y) || isNaN(p.z)) p.set(0, 0, 0);
        }
        return { curve, pts };
    }

    _addGuideBindingPolylines(parsed) {
        const layers = {
            sec0_polyline: null,
            sec1_polyline: null,
            guides_polylines: null,
        };

        const grpSec0 = new THREE.Group(); grpSec0.name = 'guide_binding_sec0';
        const grpSec1 = new THREE.Group(); grpSec1.name = 'guide_binding_sec1';
        const grpGuides = new THREE.Group(); grpGuides.name = 'guide_binding_guides';
        this.guideBindingGroup = new THREE.Group();
        this.guideBindingGroup.name = 'guide_binding';
        this.guideBindingGroup.add(grpSec0, grpSec1, grpGuides);
        this.scene.add(this.guideBindingGroup);

        const sec0Res = this._makePolylineFromDescriptor(parsed.sec0, 240);
        if (sec0Res) {
            const lineGeom = new THREE.BufferGeometry().setFromPoints(sec0Res.pts);
            const sec0Mat = new THREE.LineBasicMaterial({
                color: 0xff1744,
                linewidth: 3,
                transparent: false,
                depthTest: true,
            });
            const line = new THREE.Line(lineGeom, sec0Mat);
            line.userData.label = 'sec[0] (degenerate profile)';
            grpSec0.add(line);

            const ctrlGeom = new THREE.BufferGeometry().setFromPoints(
                (parsed.sec0.control_points || parsed.sec0.controlPoints || []).map(p => {
                    if (Array.isArray(p)) return new THREE.Vector3(p[0], p[1], p[2]);
                    return new THREE.Vector3(p.x, p.y, p.z);
                })
            );
            const ctrlMat = new THREE.LineDashedMaterial({
                color: 0xff1744,
                dashSize: 0.05,
                gapSize: 0.05,
                transparent: true,
                opacity: 0.55,
            });
            const ctrlLine = new THREE.Line(ctrlGeom, ctrlMat);
            ctrlLine.computeLineDistances();
            ctrlLine.userData.label = 'sec[0] control polygon';
            grpSec0.add(ctrlLine);
            layers.sec0_polyline = grpSec0;
            this._guideBinding_sec0Curve = sec0Res.curve;
        } else {
            this._guideBinding_sec0Curve = null;
        }

        const sec1Res = this._makePolylineFromDescriptor(parsed.sec1, 240);
        if (sec1Res) {
            const lineGeom = new THREE.BufferGeometry().setFromPoints(sec1Res.pts);
            const sec1Mat = new THREE.LineBasicMaterial({
                color: 0x6b6b6b,
                linewidth: 1,
                transparent: true,
                opacity: 0.45,
                depthTest: true,
            });
            const line = new THREE.Line(lineGeom, sec1Mat);
            line.userData.label = 'sec[1] (regular profile)';
            grpSec1.add(line);
            layers.sec1_polyline = grpSec1;
        }

        parsed.guides.forEach((g, idx) => {
            const guideRes = this._makePolylineFromDescriptor(g, 80);
            if (!guideRes) return;
            const lineGeom = new THREE.BufferGeometry().setFromPoints(guideRes.pts);
            const guideMat = new THREE.LineBasicMaterial({
                color: 0xff00ff,
                linewidth: 1,
                transparent: true,
                opacity: 0.7,
            });
            const line = new THREE.Line(lineGeom, guideMat);
            line.userData.label = g.label || `guide_${idx}`;
            grpGuides.add(line);
        });
        if (grpGuides.children.length > 0) layers.guides_polylines = grpGuides;

        return layers;
    }

    _addGuideBindingResolutions(parsed) {
        const grp = new THREE.Group();
        grp.name = 'guide_binding_resolutions';
        const labels = [];
        const sec0Curve = this._guideBinding_sec0Curve;
        const report = parsed.report;
        if (!report || !Array.isArray(report.guide_resolutions)) {
            this.guideBindingGroup.add(grp);
            this._guideBinding_resolutionLayers = { attachment_spheres: grp, attachment_labels: null };
            return { attachment_spheres: grp, attachment_labels: null };
        }

        const sphereGeom = new THREE.SphereGeometry(0.07, 16, 16);
        const labelGroup = new THREE.Group();
        labelGroup.name = 'guide_binding_resolution_labels';

        for (const r of report.guide_resolutions) {
            if (!r) continue;
            const uParam = (typeof r.u_param === 'number') ? r.u_param : null;
            if (uParam === null) continue;
            let pos = null;
            if (Array.isArray(r.original_3d_attachment) && r.original_3d_attachment.length >= 3) {
                pos = new THREE.Vector3(
                    r.original_3d_attachment[0],
                    r.original_3d_attachment[1],
                    r.original_3d_attachment[2]
                );
            }
            if (!pos && sec0Curve) {
                const t = sec0Curve.getPoint(Math.max(0, Math.min(1, uParam)));
                if (t && !isNaN(t.x) && !isNaN(t.y) && !isNaN(t.z)) pos = t.clone();
            }
            if (!pos) pos = new THREE.Vector3(0, 0, 0);

            const isFixed = !!r.fixed;
            const color = isFixed ? 0xff1744 : 0x00aaff;
            const mat = new THREE.MeshBasicMaterial({
                color,
                transparent: true,
                opacity: 0.95,
            });
            const sphere = new THREE.Mesh(sphereGeom, mat);
            sphere.position.copy(pos);
            sphere.userData.label = `Guide #${r.guide_index ?? '?'} u=${uParam.toFixed(3)} ${isFixed ? 'FIXED' : 'FREE'}`;
            sphere.userData.kind = isFixed ? 'fixed' : 'free';
            grp.add(sphere);

            const curveIdx = (r.segment_index !== undefined) ? r.segment_index : (r.curve_index ?? r.guide_index ?? '?');
            const tag = `(${curveIdx}, ${uParam.toFixed(2)}, ${isFixed ? 'fixed' : 'free'})`;
            const sprite = this._makeAnnoSprite(tag, isFixed ? 0xff1744 : 0x00aaff, 1.0);
            sprite.position.set(pos.x, pos.y + 0.18, pos.z);
            sprite.userData.label = tag;
            labelGroup.add(sprite);
        }

        this.guideBindingGroup.add(grp);
        this.guideBindingGroup.add(labelGroup);
        labels.push('attachment_spheres', 'attachment_labels');
        this._guideBinding_resolutionLayers = {
            attachment_spheres: grp,
            attachment_labels: labelGroup,
        };
        return this._guideBinding_resolutionLayers;
    }

    _addGuideBindingSegments(parsed) {
        const grp = new THREE.Group();
        grp.name = 'guide_binding_degenerate_segments';
        const report = parsed.report;
        if (!report || !Array.isArray(report.degenerate_segments) || !parsed.sec0) {
            this.guideBindingGroup.add(grp);
            this._guideBinding_segmentLayer = grp;
            return grp;
        }
        const sec0Curve = this._guideBinding_sec0Curve;
        const samples = 200;
        const fullPolyline = sec0Curve ? sec0Curve.getPoints(samples) : null;
        if (!fullPolyline) {
            this.guideBindingGroup.add(grp);
            this._guideBinding_segmentLayer = grp;
            return grp;
        }
        const lineMat = new THREE.LineBasicMaterial({
            color: 0xffeb3b,
            linewidth: 4,
            transparent: true,
            opacity: 0.85,
        });
        for (const seg of report.degenerate_segments) {
            if (!seg) continue;
            const uLo = (typeof seg.u_lo === 'number') ? seg.u_lo : 0;
            const uHi = (typeof seg.u_hi === 'number') ? seg.u_hi : 1;
            const loIdx = Math.max(0, Math.min(samples, Math.round(uLo * samples)));
            const hiIdx = Math.max(loIdx + 1, Math.min(samples, Math.round(uHi * samples)));
            const pts = fullPolyline.slice(loIdx, hiIdx + 1);
            if (pts.length < 2) continue;
            const geom = new THREE.BufferGeometry().setFromPoints(pts);
            const line = new THREE.Line(geom, lineMat);
            line.userData.label = `degenerate [${uLo.toFixed(2)}, ${uHi.toFixed(2)}]`;
            grp.add(line);
        }
        this.guideBindingGroup.add(grp);
        this._guideBinding_segmentLayer = grp;
        return grp;
    }

    /**
     * Spec 0004 renderer: sec[0] highlighted + dashed control polygon,
     * sec[1] dimmed, guide curves in magenta, degenerate-segment highlight
     * strips along sec[0], and per-resolution spheres (red=fixed, cyan=free)
     * with `(curve_idx, u_param, fixed/free)` sprite labels.
     */
    loadGuideBinding(parsed) {
        if (this.guideBindingGroup) {
            this.scene.remove(this.guideBindingGroup);
            this.guideBindingGroup.traverse(c => {
                if (c.geometry) c.geometry.dispose();
                if (c.material) {
                    if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
                    else c.material.dispose();
                }
            });
        }
        this._guideBinding_sec0Curve = null;
        this._guideBinding_segmentLayer = null;
        this._guideBinding_resolutionLayers = null;

        const polylineLayers = this._addGuideBindingPolylines(parsed);
        const segmentLayer = this._addGuideBindingSegments(parsed);
        const resolutionLayers = this._addGuideBindingResolutions(parsed);

        const bbox = new THREE.Box3();
        if (this.guideBindingGroup) bbox.expandByObject(this.guideBindingGroup);

        if (!bbox.isEmpty()) {
            const center = new THREE.Vector3(); bbox.getCenter(center);
            const offset = center.clone().multiplyScalar(-1);
            this.guideBindingGroup.position.copy(offset);
            this.markersGroup.position.copy(offset);
            this.nurbsGroup.position.copy(offset);
            this.auditGroup.position.copy(offset);
            const size = bbox.getSize(new THREE.Vector3()).length();
            this.camera.position.set(size, size, size);
            this.controls.target.set(0, 0, 0);
            this.controls.update();
        }

        const surfaceLabels = [];
        const curveLabels = [];
        if (polylineLayers.sec0_polyline) curveLabels.push('sec[0] (degenerate)');
        if (polylineLayers.sec1_polyline) curveLabels.push('sec[1] (regular)');
        if (polylineLayers.guides_polylines) curveLabels.push('guides');
        const guideBindingLayers = [
            'degenerate_segments',
            'attachment_spheres',
            'attachment_labels',
        ];
        const auditLayers = parsed.audit ? ['heatmaps', 'couplings', 'debug_markers'] : [];
        return { surfaceLabels, curveLabels, guideBindingLayers, auditLayers };
    }

    setGuideBindingLayer(layerKey, visible) {
        const layers = this._guideBinding_resolutionLayers || {};
        const segLayer = this._guideBinding_segmentLayer;
        if (layerKey === 'degenerate_segments' && segLayer) {
            segLayer.visible = visible;
        } else if (layerKey === 'attachment_spheres' && layers.attachment_spheres) {
            layers.attachment_spheres.visible = visible;
        } else if (layerKey === 'attachment_labels' && layers.attachment_labels) {
            layers.attachment_labels.visible = visible;
        }
    }
}

