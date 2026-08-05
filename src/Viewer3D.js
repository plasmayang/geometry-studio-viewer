import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VertexNormalsHelper } from 'three/addons/helpers/VertexNormalsHelper.js';
import { NURBSCurve } from 'three/addons/curves/NURBSCurve.js';
import { NURBSSurface } from 'three/addons/curves/NURBSSurface.js';
import { ParametricGeometry } from 'three/addons/geometries/ParametricGeometry.js';

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
        this.surfaceGroups = {};
        
        this.scene.add(this.markersGroup);
        this.scene.add(this.nurbsGroup);
        
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
        });

        this.animate();
    }

    animate() {
        requestAnimationFrame(() => this.animate());
        if (this.controls) this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }

    loadMesh(geometry, markers = [], nurbs = null) {
        if (this.mesh) {
            this.scene.remove(this.mesh);
            if (this.normalsHelper) this.scene.remove(this.normalsHelper);
            if (this.mesh.geometry) this.mesh.geometry.dispose();
        }
        
        [this.markersGroup, this.nurbsGroup].forEach(group => {
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

        this.surfaceGroups = {};
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

        if (!bbox.isEmpty()) {
            const center = new THREE.Vector3(); bbox.getCenter(center);
            const offset = center.clone().multiplyScalar(-1);
            this.markersGroup.position.copy(offset);
            this.nurbsGroup.position.copy(offset);
            const size = bbox.getSize(new THREE.Vector3()).length();
            this.camera.position.set(size, size, size);
            this.controls.target.set(0, 0, 0);
            this.controls.update();
        }

        return { surfaceLabels: labels, curveLabels: Object.keys(this.curveGroups || {}) };
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
                        rawCPs.forEach(pt => flat.push(pt.x, pt.y, pt.z));
                        rawCPs = flat;
                        isFlatObj = true;
                    }
                    
                    let curveKnots;
                    let numPts;
                    if (data.knots && data.knots.length > 0) {
                        // Use the knot vector AS-IS. The producer (kernel) emits valid
                        // clamped NURBS knot vectors of the form
                        //   [0]*p ⊕ internal ⊕ [1]*p
                        // matching numCPs + degree + 1. THREE.js's NURBSCurve handles
                        // clamped boundary multiplicity natively; do not strip it.
                        curveKnots = Array.from(data.knots);
                        numPts = curveKnots.length - p - 1;
                    } else {
                        numPts = isFlatObj ? (rawCPs.length / 3) : Math.floor(rawCPs.length / 3);
                        curveKnots = [];
                        for (let k = 0; k <= p; k++) curveKnots.push(0);
                        for (let k = 1; k < numPts - p; k++) curveKnots.push(k);
                        for (let k = 0; k <= p; k++) curveKnots.push(Math.max(1, numPts - p));
                    }

                    const realStride = isFlatObj ? 3 : (rawCPs.length % 3 === 0 ? 3 : 4);
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
                            console.error(`NaN in Curve getPoints! i=${i}`);
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
    'Analytic': 0xffaa00,
    'Variational': 0x00aaff,
    'Default': 0xffaa00,
    'Support Surface': 0x8833ff,
    'Section Support Surface': 0x33aaff,
    'Section Constraint Viz support_surface': 0x33aaff,
    'Section Constraint Viz tangent_ribbon': 0xff8800,
    'Section Constraint Viz curvature_ribbon': 0xaa00ff,
    'Section Constraint Viz torsion_ribbon': 0x00ffaa,
};
            nurbsData.surfaces.forEach(data => {
                try {
                    const label = data.label || 'Default';
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
                        rawCPs.forEach(pt => flat.push(pt.x, pt.y, pt.z));
                        rawCPs = flat;
                        isFlatObj = true;
                    }

                    // Use the knot vectors AS-IS. The producer (kernel) emits valid
                    // clamped NURBS knot vectors. THREE.js's NURBSSurface handles
                    // clamped boundary multiplicity natively; do not strip it.
                    const knotsU = Array.from(data.knotsU || data.knots_u);
                    const knotsV = Array.from(data.knotsV || data.knots_v);

                    // Guard: skip surfaces with empty/malformed data.
                    // The kernel (M4 scheme) emits surfaces with empty
                    // knotsU / knotsV / controlPoints when the scheme
                    // fails (SurfaceType::mark_error() sentinel,
                    // grid_rows = -2). Without this guard, NURBSSurface
                    // computes numU = knotsU.length - degreeU - 1 = -4
                    // and its internal calcSurfacePoint throws
                    // "Cannot read properties of undefined (reading '-4')".
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
                    const stride = isFlatObj ? 3 : Math.max(1, Math.round(rawCPs.length / expectedTotal));
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
                                console.error(`NaN detected in NURBSSurface getPoint! u=${uS[i]}, v=${vS[j]}`);
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

                    const mat = new THREE.MeshStandardMaterial({ color: schemeColors[label] || 0xffaa00, side: THREE.DoubleSide, metalness: 0.3, roughness: 0.4, transparent: true, opacity: label === 'Variational' ? 0.4 : (label === 'Support Surface' ? 0.3 : 0.7) });
                    sGroup.add(new THREE.Mesh(geom, mat));

                    const pMat = new THREE.LineBasicMaterial({ color: schemeColors[label] || 0x999999, transparent: true, opacity: 0.2 });
                    for (let j = 0; j < numV; j++) {
                        const pts = []; for (let i = 0; i < numU; i++) {
                            const idx = (j * realNumU + i) * stride;
                            let x = rawCPs[idx], y = rawCPs[idx+1], z = rawCPs[idx+2];
                            if (isNaN(x) || isNaN(y) || isNaN(z)) {
                                console.error(`NaN in Surface CP Grid (row)! i=${i}, j=${j}, idx=${idx}`);
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
                                console.error(`NaN in Surface CP Grid (col)! i=${i}, j=${j}, idx=${idx}`);
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
}
