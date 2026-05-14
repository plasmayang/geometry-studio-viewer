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
            specular: 0x111111
        });
    }

    init(container) {
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.shadowMap.enabled = true;
        container.appendChild(this.renderer.domElement);

        this.scene.background = new THREE.Color(0xf5f7fa);

        // --- Lighting: Studio Setup ---
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
        this.scene.add(ambientLight);

        const hemisphereLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
        this.scene.add(hemisphereLight);

        const mainLight = new THREE.DirectionalLight(0xffffff, 0.8);
        mainLight.position.set(5, 10, 7.5);
        this.scene.add(mainLight);

        const fillLight = new THREE.PointLight(0xffffff, 0.3);
        fillLight.position.set(-5, -5, 5);
        this.scene.add(fillLight);

        // --- Helpers ---
        this.grid = new THREE.GridHelper(20, 20, 0xbbbbbb, 0xdddddd);
        this.grid.rotation.x = Math.PI / 2; // XY Plane
        this.scene.add(this.grid);

        // Add a second grid for XZ Plane
        this.gridXZ = new THREE.GridHelper(20, 20, 0xcccccc, 0xeeeeee);
        this.scene.add(this.gridXZ);

        this.axesHelper = new THREE.AxesHelper(5);
        this.scene.add(this.axesHelper);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
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
            this.mesh.geometry.dispose();
        }
        
        // Clear groups
        [this.markersGroup, this.nurbsGroup].forEach(group => {
            while(group.children.length > 0) {
                const child = group.children[0];
                if (child.geometry) child.geometry.dispose();
                if (child.material) child.material.dispose();
                group.remove(child);
            }
        });

        this.mesh = new THREE.Mesh(geometry, this.material);
        this.scene.add(this.mesh);

        this.addMarkers(markers);
        if (nurbs) this.addNurbs(nurbs);

        // Auto-center and zoom (only if mesh exists)
        if (geometry.attributes.position.count > 0) {
            geometry.computeBoundingBox();
            const center = new THREE.Vector3();
            geometry.boundingBox.getCenter(center);
            this.mesh.position.copy(center).multiplyScalar(-1);

            // Also adjust groups
            this.markersGroup.position.copy(this.mesh.position);
            this.nurbsGroup.position.copy(this.mesh.position);
        }

        // Removed the hard-coded camera reset to allow persistent OrbitControls state
        // if (this.params && this.params.showNormals) {
        //     this.showNormals(true);
        // }
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
        // --- NURBS Curves ---
        if (nurbsData.curves) {
            nurbsData.curves.forEach((data, index) => {
                const cps = [];
                for (let i = 0; i < data.controlPoints.length; i += 3) {
                    cps.push(new THREE.Vector4(data.controlPoints[i], data.controlPoints[i+1], data.controlPoints[i+2], 1));
                }
                const curve = new NURBSCurve(data.degree, data.knots, cps);
                const geometry = new THREE.BufferGeometry().setFromPoints(curve.getPoints(100));
                
                // Color Logic:
                // 0: Spine (Red)
                // 1-3: Sections (Blue)
                // 4+: Guides (Gray/Green)
                let color = 0x000000;
                let linewidth = 2;

                if (index === 0) {
                    color = 0xff3333; // Spine: Red
                    linewidth = 4;
                } else if (index >= 1 && index <= 3) {
                    color = 0x3366ff; // Sections: Blue
                    linewidth = 3;
                } else {
                    color = 0x33cc33; // Guides: Green
                    linewidth = 1;
                }

                const material = new THREE.LineBasicMaterial({ color: color, linewidth: linewidth });
                const line = new THREE.Line(geometry, material);
                this.nurbsGroup.add(line);

                // Optional: Show control points for spine/sections
                if (index <= 3) {
                    const hullGeom = new THREE.BufferGeometry().setFromPoints(cps.map(p => new THREE.Vector3(p.x, p.y, p.z)));
                    const hullMat = new THREE.LineDashedMaterial({ color: 0x999999, dashSize: 0.1, gapSize: 0.1 });
                    const hull = new THREE.Line(hullGeom, hullMat);
                    hull.computeLineDistances();
                    this.nurbsGroup.add(hull);
                }
            });
        }

        // --- NURBS Surfaces ---
        if (nurbsData.surfaces) {
            nurbsData.surfaces.forEach(data => {
                try {
                    const numU = data.knotsU.length - data.degreeU - 1;
                    const numV = data.knotsV.length - data.degreeV - 1;
                    const controlPoints = [];
                    
                    // Validate data size
                    const expectedTotal = numU * numV * 3;
                    if (data.controlPoints.length < expectedTotal) {
                        console.warn(`Surface data mismatch: expected ${expectedTotal}, got ${data.controlPoints.length}`);
                        return;
                    }

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

                    const surface = new NURBSSurface(data.degreeU, data.degreeV, data.knotsU, data.knotsV, controlPoints);
                    const getSurfacePoint = (u, v, target) => {
                        surface.getPoint(u, v, target);
                    };
                    const geometry = new ParametricGeometry(getSurfacePoint, 32, 32);
                    const material = new THREE.MeshPhongMaterial({ 
                        color: 0xffaa00, 
                        side: THREE.DoubleSide, 
                        transparent: true, 
                        opacity: 0.8,
                        shininess: 50
                    });
                    this.nurbsGroup.add(new THREE.Mesh(geometry, material));
                } catch (e) {
                    console.error("Error rendering NURBS surface:", e);
                }
            });
        }
    }

    setWireframe(enabled) {
        this.material.wireframe = enabled;
    }

    setGrid(enabled) {
        if (this.grid) this.grid.visible = enabled;
        if (this.gridXZ) this.gridXZ.visible = enabled;
        if (this.axesHelper) this.axesHelper.visible = enabled;
    }

    setMeshColor(color) {
        this.material.color.set(color);
    }

    showNormals(enabled) {
        if (this.normalsHelper) {
            this.scene.remove(this.normalsHelper);
            this.normalsHelper = null;
        }

        if (enabled && this.mesh) {
            this.normalsHelper = new VertexNormalsHelper(this.mesh, 0.15, 0xff3366);
            this.scene.add(this.normalsHelper);
        }
    }
}
