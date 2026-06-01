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

        // --- Lighting: Studio Setup ---
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
        this.scene.add(ambientLight);

        const mainLight = new THREE.DirectionalLight(0xffffff, 1.0);
        mainLight.position.set(5, 10, 7.5);
        this.scene.add(mainLight);

        // --- Helpers ---
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
        
        // Clear groups
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

        // Ensure geometry is a valid THREE.BufferGeometry before creating Mesh
        if (geometry && geometry.isBufferGeometry) {
            this.mesh = new THREE.Mesh(geometry, this.material);
            this.scene.add(this.mesh);
        } else {
            console.warn("No valid mesh geometry provided, skipping mesh creation.");
            this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
        }

        this.addMarkers(markers);
        if (nurbs) this.addNurbs(nurbs);

        // Auto-center with robust fallback
        const bbox = new THREE.Box3();
        
        // 1. Check Mesh Geometry
        if (this.mesh && this.mesh.geometry && this.mesh.geometry.attributes && this.mesh.geometry.attributes.position) {
            this.mesh.geometry.computeBoundingBox();
            bbox.expandByObject(this.mesh);
        }
        
        // 2. Fallback to NURBS Curves
        if (nurbs && nurbs.curves) {
            nurbs.curves.forEach(c => {
                if (c.controlPoints) {
                    for (let i = 0; i < c.controlPoints.length; i += 3) {
                        bbox.expandByPoint(new THREE.Vector3(c.controlPoints[i], c.controlPoints[i+1], c.controlPoints[i+2]));
                    }
                }
            });
        }

        // 3. Fallback to NURBS Surfaces
        if (nurbs && nurbs.surfaces) {
            nurbs.surfaces.forEach(s => {
                if (s.controlPoints) {
                    for (let i = 0; i < s.controlPoints.length; i += 3) {
                        bbox.expandByPoint(new THREE.Vector3(s.controlPoints[i], s.controlPoints[i+1], s.controlPoints[i+2]));
                    }
                }
            });
        }

        if (!bbox.isEmpty()) {
            const center = new THREE.Vector3();
            bbox.getCenter(center);
            const offset = center.clone().multiplyScalar(-1);
            
            if (this.mesh) this.mesh.position.copy(offset);
            this.markersGroup.position.copy(offset);
            this.nurbsGroup.position.copy(offset);
            
            // Adjust camera to fit
            const size = bbox.getSize(new THREE.Vector3()).length();
            const camDist = Math.max(size * 1.2, 5);
            this.camera.position.set(camDist, camDist, camDist);
            this.controls.target.set(0, 0, 0);
            this.controls.update();
        }
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
        console.log("Processing NURBS Data:", nurbsData);
        if (nurbsData.curves) {
            nurbsData.curves.forEach((data, index) => {
                try {
                    const p = data.degree;
                    const cps = [];
                    for (let i = 0; i < data.controlPoints.length; i += 3) {
                        cps.push(new THREE.Vector4(data.controlPoints[i], data.controlPoints[i+1], data.controlPoints[i+2], 1));
                    }

                    // Handle periodic curves: data provider often omits the wrapped control points
                    if (data.isPeriodic) {
                        for (let i = 0; i < p; i++) {
                            cps.push(cps[i].clone());
                        }
                    }
                    
                    let knots = data.knots;
                    if (!knots || knots.length === 0) {
                        const n_ext = cps.length - 1;
                        knots = [];
                        if (data.isPeriodic) {
                            // For periodic, we need a uniform knot vector to support the wrapped points
                            for (let i = 0; i <= n_ext + p + 1; i++) {
                                knots.push(i);
                            }
                        } else {
                            // Generate default uniform clamped knots if missing
                            for (let i = 0; i <= p; i++) knots.push(0);
                            for (let i = 1; i < n_ext - p + 1; i++) knots.push(i / (n_ext - p + 1));
                            for (let i = 0; i <= p; i++) knots.push(1);
                        }
                    }

                    const curve = new NURBSCurve(p, knots, cps);
                    let curvePoints;
                    if (data.isPeriodic) {
                        curvePoints = [];
                        const divisions = 200;
                        const kStart = knots[p];
                        const kEnd = knots[cps.length];
                        const kMin = knots[0];
                        const kMax = knots[knots.length - 1];
                        for (let i = 0; i <= divisions; i++) {
                            const t = i / divisions;
                            const u = kStart + t * (kEnd - kStart);
                            const tNorm = (u - kMin) / (kMax - kMin);
                            curvePoints.push(curve.getPoint(tNorm));
                        }
                    } else {
                        curvePoints = curve.getPoints(200);
                    }
                    const geometry = new THREE.BufferGeometry().setFromPoints(curvePoints);
                    
                    let color = 0x3366ff; // Default Blue
                    if (data.type === 'section') color = 0xff3333; // Red
                    if (data.type === 'guide') color = 0x33cc33; // Green
                    if (data.type === 'spine') color = 0x8800ff; // Purple

                    const material = new THREE.LineBasicMaterial({ color: color, linewidth: 2 });
                    const line = new THREE.Line(geometry, material);
                    this.nurbsGroup.add(line);

                    // Add Spatial Label
                    if (data.label) {
                        const midPoint = curve.getPoint(0.5);
                        this.addLabel(data.label, midPoint, color);
                    }
                } catch (e) {
                    console.error("Curve Render Error:", e, data);
                }
            });
        }

        if (nurbsData.surfaces) {
            nurbsData.surfaces.forEach(data => {
                try {
                    const numU = data.knotsU.length - data.degreeU - 1;
                    const numV = data.knotsV.length - data.degreeV - 1;
                    console.log(`Rendering Surface: U(${numU}, deg ${data.degreeU}), V(${numV}, deg ${data.degreeV})`);
                    
                    const controlPoints = [];
                    for (let i = 0; i < numU; i++) {
                        controlPoints[i] = [];
                        for (let j = 0; j < numV; j++) {
                            const idx = (j * numU + i) * 3;
                            controlPoints[i][j] = new THREE.Vector4(
                                data.controlPoints[idx], 
                                data.controlPoints[idx+1], 
                                data.controlPoints[idx+2], 
                                1
                            );
                        }
                    }

                    const ns = new NURBSSurface(data.degreeU, data.degreeV, data.knotsU, data.knotsV, controlPoints);
                    // Increased sampling from 64 to 256 to minimize linear interpolation error at knots
                    const geometry = new ParametricGeometry((u, v, target) => ns.getPoint(u, v, target), 256, 256);
                    const material = new THREE.MeshStandardMaterial({ 
                        color: 0xffaa00, 
                        side: THREE.DoubleSide,
                        metalness: 0.3,
                        roughness: 0.4,
                        transparent: true,
                        opacity: 0.7
                    });
                    const sMesh = new THREE.Mesh(geometry, material);
                    this.nurbsGroup.add(sMesh);
                    console.log("Surface mesh added to scene.");

                    // --- Control Polygon Rendering ---
                    const polyGroup = new THREE.Group();
                    const polyMaterial = new THREE.LineBasicMaterial({ color: 0x999999, transparent: true, opacity: 0.4 });
                    
                    // Lines along U
                    for (let j = 0; j < numV; j++) {
                        const pts = [];
                        for (let i = 0; i < numU; i++) {
                            const p = controlPoints[i][j];
                            pts.push(new THREE.Vector3(p.x, p.y, p.z));
                        }
                        const polyGeom = new THREE.BufferGeometry().setFromPoints(pts);
                        polyGroup.add(new THREE.Line(polyGeom, polyMaterial));
                    }
                    // Lines along V
                    for (let i = 0; i < numU; i++) {
                        const pts = [];
                        for (let j = 0; j < numV; j++) {
                            const p = controlPoints[i][j];
                            pts.push(new THREE.Vector3(p.x, p.y, p.z));
                        }
                        const polyGeom = new THREE.BufferGeometry().setFromPoints(pts);
                        polyGroup.add(new THREE.Line(polyGeom, polyMaterial));
                    }
                    polyGroup.name = "controlPolygon";
                    this.nurbsGroup.add(polyGroup);
                } catch (e) {
                    console.error("NURBS Surface Error:", e);
                }
            });
        }
    }

    addLabel(text, position, color) {
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        // Double resolution for sharper text with larger font
        canvas.width = 512;
        canvas.height = 128;

        context.fillStyle = 'rgba(255, 255, 255, 0.9)';
        context.fillRect(0, 0, 512, 128);
        context.lineWidth = 8;
        context.strokeStyle = '#' + new THREE.Color(color).getHexString();
        context.strokeRect(0, 0, 512, 128);

        context.font = 'Bold 48px Arial';
        context.fillStyle = '#1a1a1a';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(text, 256, 64);

        const texture = new THREE.CanvasTexture(canvas);
        const spriteMaterial = new THREE.SpriteMaterial({ map: texture, transparent: true });
        const sprite = new THREE.Sprite(spriteMaterial);
        
        sprite.position.copy(position);
        sprite.position.y += 0.5; // Offset slightly above
        sprite.scale.set(3, 0.75, 1); // Scaled for better visibility
        
        this.nurbsGroup.add(sprite);
    }

    setControlPolygon(enabled) {
        this.nurbsGroup.traverse(child => {
            if (child.name === "controlPolygon") {
                child.visible = enabled;
            }
        });
    }

    setWireframe(enabled) { this.material.wireframe = enabled; }
    setGrid(enabled) { [this.grid, this.gridXZ, this.axesHelper].forEach(h => h.visible = enabled); }
    setMeshColor(color) { this.material.color.set(color); }
    showNormals(enabled) { /* omitted for brevity */ }
}