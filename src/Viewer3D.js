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
        this.auditGroup = new THREE.Group();
        this.surfaceGroups = {};
        this.auditLayers = {};

        this.scene.add(this.markersGroup);
        this.scene.add(this.nurbsGroup);
        this.scene.add(this.auditGroup);

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

    loadMesh(geometry, markers = [], nurbs = null, audit = null) {
        if (this.mesh) {
            this.scene.remove(this.mesh);
            if (this.normalsHelper) this.scene.remove(this.normalsHelper);
            if (this.mesh.geometry) this.mesh.geometry.dispose();
        }

        [this.markersGroup, this.nurbsGroup, this.auditGroup].forEach(group => {
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

        // v1.1 audit data — only the heatmap layer survives here; the
        // 2D nominal manifold is rendered as a regular surface (see
        // GeometryParser.parseNurbs) so it shares the FreeBlend3D /
        // AffineTransport toggle rail.
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

        if (!bbox.isEmpty()) {
            const center = new THREE.Vector3(); bbox.getCenter(center);
            const offset = center.clone().multiplyScalar(-1);
            this.markersGroup.position.copy(offset);
            this.nurbsGroup.position.copy(offset);
            this.auditGroup.position.copy(offset);
            const size = bbox.getSize(new THREE.Vector3()).length();
            this.camera.position.set(size, size, size);
            this.controls.target.set(0, 0, 0);
            this.controls.update();
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
                        rawCPs.forEach(pt => flat.push(pt.x, pt.y, pt.z));
                        rawCPs = flat;
                        isFlatObj = true;
                    }

                    let curveKnots;
                    let numPts;
                    if (data.knots && data.knots.length > 0) {
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
                        rawCPs.forEach(pt => flat.push(pt.x, pt.y, pt.z));
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
                rawCPs.forEach(pt => flat.push(pt.x, pt.y, pt.z));
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

