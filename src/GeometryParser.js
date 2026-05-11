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
        const normals = new Float32Array(meshData.normals);
        const indices = new Uint16Array(meshData.indices);

        geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));

        return geometry;
    }
}
