import * as THREE from 'three';

export class GeometryParser {
    /**
     * Parses the mesh data from the kernel JSON.
     * @param {Object} jsonData 
     * @returns {THREE.BufferGeometry}
     */
    static parseMesh(jsonData) {
        const meshData = jsonData.geometry.mesh;
        const geometry = new THREE.BufferGeometry();

        const vertices = new Float32Array(meshData.vertices);
        const indices = new Uint16Array(meshData.indices);

        geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        
        if (meshData.normals && meshData.normals.length > 0) {
            const normals = new Float32Array(meshData.normals);
            geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
        } else {
            geometry.computeVertexNormals();
        }

        geometry.setIndex(new THREE.BufferAttribute(indices, 1));

        // Parse Markers
        const markers = [];
        if (jsonData.geometry.debugMarkers && jsonData.geometry.debugMarkers.singularities) {
            const s = jsonData.geometry.debugMarkers.singularities;
            for (let i = 0; i < s.length; i += 3) {
                markers.push({
                    type: 'singularity',
                    position: [s[i], s[i+1], s[i+2]]
                });
            }
        }

        return { geometry, markers, nurbs: this.parseNurbs(jsonData) };
    }

    static parseNurbs(jsonData) {
        if (!jsonData.geometry.nurbs) return null;
        return jsonData.geometry.nurbs;
    }
}
