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
                const numU = s.knotsU.length - s.degreeU - 1;
                const numV = s.knotsV.length - s.degreeV - 1;
                const stride = s.controlPoints.length / (numU * numV);
                for (let i = 0; i < s.controlPoints.length; i += stride) {
                    bbox.expandByPoint(new THREE.Vector3(s.controlPoints[i], s.controlPoints[i+1], s.controlPoints[i+2]));
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

        return labels;
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
            nurbsData.curves.forEach(data => {
                try {
                    const p = data.degree;
                    const cps = [];
                    // Rational Stride detection
                    const numPts = (data.knots && data.knots.length > 0) ? (data.knots.length - p - 1) : (data.controlPoints.length / 3);
                    const stride = data.controlPoints.length / numPts;
                    for (let i = 0; i < data.controlPoints.length; i += stride) {
                        cps.push(new THREE.Vector4(data.controlPoints[i], data.controlPoints[i+1], data.controlPoints[i+2], (stride === 4) ? data.controlPoints[i+3] : 1.0));
                    }
                    const curveKnots = (data.knots && data.knots.length > 0) ? data.knots : (function() {
                        const ks = [];
                        for (let k = 0; k <= p; k++) ks.push(0);
                        for (let k = 1; k < numPts - p; k++) ks.push(k);
                        for (let k = 0; k <= p; k++) ks.push(Math.max(1, numPts - p));
                        return ks;
                    })();
                    const curve = new NURBSCurve(p, curveKnots, cps);
                    const geometry = new THREE.BufferGeometry().setFromPoints(curve.getPoints(100));
                    const color = data.type === 'section' ? 0x000000 : (data.type === 'guide' ? 0xff00ff : 0x008800);
                    this.nurbsGroup.add(new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, linewidth: 2 })));
                } catch (e) { console.error(e); }
            });
        }

        if (nurbsData.surfaces) {
            const schemeColors = { 'Analytic': 0xffaa00, 'Variational': 0x00aaff, 'Default': 0xffaa00 };
            nurbsData.surfaces.forEach(data => {
                try {
                    const label = data.label || 'Default';
                    labels.push(label);
                    const sGroup = new THREE.Group();
                    this.surfaceGroups[label] = sGroup;
                    this.nurbsGroup.add(sGroup);

                    const numU = data.knotsU.length - data.degreeU - 1;
                    const numV = data.knotsV.length - data.degreeV - 1;
                    const stride = data.controlPoints.length / (numU * numV);
                    const controlPoints = [];
                    for (let i = 0; i < numU; i++) {
                        controlPoints[i] = [];
                        for (let j = 0; j < numV; j++) {
                            const idx = (j * numU + i) * stride;
                            controlPoints[i][j] = new THREE.Vector4(data.controlPoints[idx], data.controlPoints[idx+1], data.controlPoints[idx+2], (stride === 4) ? data.controlPoints[idx+3] : 1.0);
                        }
                    }

                    const ns = new NURBSSurface(data.degreeU, data.degreeV, data.knotsU, data.knotsV, controlPoints);
                    const getSamples = (knots, p, steps) => {
                        const min = knots[p], max = knots[knots.length - p - 1], range = max - min;
                        let s = []; for (let i = 0; i <= steps; i++) s.push(i / steps);
                        for (let i = p; i < knots.length - p; i++) if (range > 0) s.push((knots[i] - min) / range);
                        s.sort((a, b) => a - b);
                        let u = [s[0]]; for (let i = 1; i < s.length; i++) if (s[i] - u[u.length-1] > 1e-6) u.push(s[i]);
                        return u;
                    };

                    const uS = getSamples(data.knotsU, data.degreeU, 40), vS = getSamples(data.knotsV, data.degreeV, 40);
                    const geom = new THREE.BufferGeometry();
                    const verts = [], uvs = [], idxs = [];
                    const target = new THREE.Vector3();
                    for (let j = 0; j < vS.length; j++) {
                        for (let i = 0; i < uS.length; i++) {
                            ns.getPoint(uS[i], vS[j], target);
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

                    const mat = new THREE.MeshStandardMaterial({ color: schemeColors[label] || 0xffaa00, side: THREE.DoubleSide, metalness: 0.3, roughness: 0.4, transparent: true, opacity: label === 'Variational' ? 0.4 : 0.7 });
                    sGroup.add(new THREE.Mesh(geom, mat));

                    const pMat = new THREE.LineBasicMaterial({ color: schemeColors[label] || 0x999999, transparent: true, opacity: 0.2 });
                    for (let j = 0; j < numV; j++) {
                        const pts = []; for (let i = 0; i < numU; i++) {
                            const idx = (j * numU + i) * stride;
                            pts.push(new THREE.Vector3(data.controlPoints[idx], data.controlPoints[idx+1], data.controlPoints[idx+2]));
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

    setWireframe(enabled) { this.nurbsGroup.traverse(c => { if (c.material) c.material.wireframe = enabled; }); }
    setControlPolygon(enabled) { this.nurbsGroup.traverse(c => { if (c.type === 'Line' && c.material && c.material.opacity < 0.5) c.visible = enabled; }); }
    setGrid(enabled) { if (this.grid) this.grid.visible = enabled; if (this.gridXZ) this.gridXZ.visible = enabled; }
    setMeshColor(color) { this.material.color.set(color); }
}
