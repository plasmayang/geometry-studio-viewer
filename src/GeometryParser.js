import * as THREE from 'three';

export class GeometryParser {
    /**
     * Parses the mesh data from the kernel JSON.
     * @param {Object} jsonData
     * @returns {THREE.BufferGeometry}
     */
    static parseMesh(jsonData) {
        let geometry = new THREE.BufferGeometry();
        const meshData = jsonData.geometry ? jsonData.geometry.mesh : null;

        if (meshData && meshData.vertices && meshData.vertices.length > 0) {
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
        }

        // Parse Markers
        const markers = [];
        if (jsonData.geometry && jsonData.geometry.debugMarkers && jsonData.geometry.debugMarkers.singularities) {
            const s = jsonData.geometry.debugMarkers.singularities;
            for (let i = 0; i < s.length; i += 3) {
                markers.push({
                    type: 'singularity',
                    position: [s[i], s[i+1], s[i+2]]
                });
            }
        }

        return {
            geometry,
            markers,
            nurbs: this.parseNurbs(jsonData),
            audit: this.parseAudit(jsonData),
            // spec 0002 (v1.2): null when absent so v1.1 envelopes
            // bypass the aux-viz pass and skip the toggle injection.
            movingFrame: this.parseMovingFrame(jsonData),
            samplingPlane: this.parseSamplingPlane(jsonData),
        };
    }

    /** spec 0002: top-level `moving_frame[]` (one per spine v-station). */
    static parseMovingFrame(jsonData) {
        const arr = jsonData?.moving_frame;
        if (!Array.isArray(arr) || arr.length === 0) return null;
        return arr;
    }

    /** spec 0002: top-level `sampling_plane[]`, index-aligned with moving_frame. */
    static parseSamplingPlane(jsonData) {
        const arr = jsonData?.sampling_plane;
        if (!Array.isArray(arr) || arr.length === 0) return null;
        return arr;
    }

    /**
     * Parse a spec 0004 (e2e-gluing-guide-to-profile) envelope into
     * the shape Viewer3D.loadGuideBinding() expects:
     *   {
     *     sec0: NURBS curve descriptor for the degenerate profile,
     *     sec1: NURBS curve descriptor for the regular profile (may be null),
     *     guides: [NURBS curve descriptor, ...] for every guide curve,
     *     report: { u_bounds, degenerate_segments, guide_resolutions, monotone_check, guide_count },
     *     audit: existing audit fields (process / intermediate / debug_markers) when present
     *   }
     *
     * Falls back gracefully: if sec0/sec1/guides are missing the
     * corresponding field is null / []; Viewer3D renders what it can.
     */
    static parseGuideBinding(jsonData) {
        const curves = (jsonData?.geometry?.nurbs?.curves) || [];
        let sec0 = null;
        let sec1 = null;
        const guides = [];
        for (const c of curves) {
            if (!c || !c.label) continue;
            if (c.label === 'section_0' || c.label.startsWith('section_0')) {
                sec0 = c;
            } else if (c.label === 'section_1' || c.label.startsWith('section_1')) {
                sec1 = c;
            } else if (c.label.startsWith('guide')) {
                guides.push(c);
            }
        }
        const report = (jsonData.guide_binding_report && typeof jsonData.guide_binding_report === 'object')
            ? jsonData.guide_binding_report
            : null;
        const audit = this.parseAudit(jsonData);
        return { sec0, sec1, guides, report, audit };
    }

    static parseNurbs(jsonData) {
        if (jsonData.surfaces || jsonData.surface || jsonData.curves || jsonData.support_surfaces || jsonData.constraint_visualizations) {
            const surfaces = [];
            // iter-review-25 §3.3.1: prefer the plural 'surfaces' array
            // (one entry per SectionMode selected by the 'section_mode' JSON key —
            // FreeBlend3D or AffineTransport). Fall back to singular
            // 'surface' for pre-iter-review-25 envelopes.
            const surfaceStream = Array.isArray(jsonData.surfaces)
                ? jsonData.surfaces
                : (jsonData.surface ? [jsonData.surface] : []);
            surfaceStream.forEach(s => surfaces.push(s));
            if (jsonData.support_surfaces) {
                jsonData.support_surfaces.forEach(s => {
                    surfaces.push(s);
                });
            }
            if (jsonData.constraint_visualizations) {
                jsonData.constraint_visualizations.forEach(s => {
                    surfaces.push(s);
                });
            }
            // v1.1: synthesize the 2D nominal manifold s_norm^{2D}(u,v)
            // (the cp-propagation §3.2 intermediate) as a regular surface
            // entry so it shares the FreeBlend3D / AffineTransport toggle
            // rail in UIController.updateSurfaceToggles().
            if (jsonData.intermediate_products
                && jsonData.intermediate_products.s_norm_cp) {
                const s = jsonData.intermediate_products.s_norm_cp;
                surfaces.push({
                    label: 'NominalManifold',
                    p_u: s.p_u,
                    p_v: s.p_v,
                    knots_u: s.knots_u,
                    knots_v: s.knots_v,
                    control_points: s.control_points,
                });
            }
            return {
                surfaces: surfaces,
                curves: jsonData.curves || []
            };
        }
        if (!jsonData.geometry || !jsonData.geometry.nurbs) return null;
        return jsonData.geometry.nurbs;
    }

    /**
     * Parse the v1.1 audit fields. Returns null if neither
     * process_audit nor intermediate_products is present so callers
     * can detect "this case was generated by an older producer and
     * carries no review data" without checking the JSON keys themselves.
     *
     * v1.2: also parses intermediate_products.coupling_relationships
     * into a flat list of straight-line connectors (each with two
     * endpoints + metadata) so Viewer3D can render them as the
     * "Coupling Relationships" overlay toggled by the AuditPanel.
     */
    static parseAudit(jsonData) {
        const hasProcess = jsonData.process_audit && typeof jsonData.process_audit === 'object';
        const hasIntermediate = jsonData.intermediate_products && typeof jsonData.intermediate_products === 'object';
        const hasDebugMarkers = Array.isArray(jsonData.debug_markers) && jsonData.debug_markers.length > 0;
        if (!hasProcess && !hasIntermediate && !hasDebugMarkers) return null;
        return {
            process: hasProcess ? jsonData.process_audit : null,
            intermediate: hasIntermediate ? jsonData.intermediate_products : null,
            couplingRelationships: this.parseCouplingRelationships(jsonData),
            debugMarkers: hasDebugMarkers ? jsonData.debug_markers : [],
            schemaVersion: jsonData.schema_version || '1.0',
        };
    }

    /**
     * Parse intermediate_products.coupling_relationships into a flat
     * list of straight-line connector descriptors. Each entry has:
     *   { id, kind, endpoints: [{profile_index, u_param, position:[x,y,z]}, ...], metadata }
     * Empty list (or null on older envelopes) is the no-op default;
     * the renderer treats it identically to "layer hidden".
     */
    static parseCouplingRelationships(jsonData) {
        const list = jsonData?.intermediate_products?.coupling_relationships;
        if (!Array.isArray(list)) return [];
        const out = [];
        for (const raw of list) {
            if (!raw || typeof raw !== 'object') continue;
            const endpointsRaw = Array.isArray(raw.endpoints) ? raw.endpoints : [];
            if (endpointsRaw.length < 2) continue;
            const endpoints = [];
            for (const e of endpointsRaw) {
                if (!e || !Array.isArray(e.position) || e.position.length < 3) continue;
                endpoints.push({
                    profile_index: (typeof e.profile_index === 'number') ? e.profile_index : -1,
                    u_param: (typeof e.u_param === 'number') ? e.u_param : 0,
                    position: [e.position[0], e.position[1], e.position[2]],
                });
            }
            if (endpoints.length < 2) continue;
            out.push({
                id: (typeof raw.id === 'string') ? raw.id : '',
                kind: (typeof raw.kind === 'string') ? raw.kind : 'guide_induced',
                endpoints,
                metadata: raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {},
            });
        }
        return out;
    }
}
