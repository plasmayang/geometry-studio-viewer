import * as THREE from 'three';

function flattenControlPoints(cps) {
    if (!Array.isArray(cps) || cps.length === 0) return cps;
    if (typeof cps[0] === 'object' && cps[0] !== null && !Array.isArray(cps[0])) {
        const flat = [];
        cps.forEach(cp => {
            const w = (cp && typeof cp.w === 'number') ? cp.w : 1;
            flat.push(cp.x, cp.y, cp.z, w);
        });
        return flat;
    }
    return cps;
}

function decorateCurves(curves) {
    if (!Array.isArray(curves)) return curves;
    return curves.map(c => {
        if (!c || typeof c !== 'object') return c;
        const src = c.control_points;
        const flat = flattenControlPoints(src);
        const dictFormat = Array.isArray(src) && src.length > 0
            && typeof src[0] === 'object' && src[0] !== null;
        const dimKnown = (typeof c.dim === 'number') ? c.dim : null;
        const isRational = dimKnown === 4
            || (dictFormat)
            || (typeof c.is_rational === 'boolean' && c.is_rational);
        const out = { ...c };
        if (Array.isArray(flat)) out.controlPoints = flat;
        out.dim = isRational ? 4 : 3;
        return out;
    });
}

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

        const nurbs = this.parseNurbs(jsonData);
        return {
            geometry,
            markers,
            nurbs: nurbs,
            audit: this.parseAudit(jsonData),
            movingFrame: this.parseMovingFrame(jsonData),
            samplingPlane: this.parseSamplingPlane(jsonData),
            // Mirrors `nurbs.proxiedGuides` so direct consumers (tests,
            // ad-hoc UIs) do not have to dig through `nurbs.*`.
            proxiedGuides: Array.isArray(nurbs?.proxiedGuides) ? nurbs.proxiedGuides : [],
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
        // v1.2: include guide-curve × sampling-plane intersection points
        // (see parseVSamples for the contract). Always present (possibly
        // empty) so consumers can rely on the key.
        const vSamples = this.parseVSamples(jsonData);
        // v1.2: include v-section profile NURBS curves
        // (see parseVSections for the contract). Always present (possibly
        // empty) so consumers can rely on the key.
        const vSections = this.parseVSections(jsonData);
        // proxied_guides (e2e-gallery PsiBasisFit debug): same shape as
        // a curve entry but with type "proxied_guide" and only knots_v
        // populated. Always present (possibly empty) so consumers can
        // rely on the key.
        const proxiedGuides = this.parseProxiedGuides(jsonData);
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
                    control_points: flattenControlPoints(s.control_points),
                });
            }
            return {
                surfaces: surfaces,
                curves: decorateCurves(jsonData.curves || []),
                vSamples: vSamples,
                vSections: vSections,
                proxiedGuides: proxiedGuides,
            };
        }
        if (!jsonData.geometry || !jsonData.geometry.nurbs) {
            return {
                surfaces: [],
                curves: [],
                vSamples: vSamples,
                vSections: vSections,
                proxiedGuides: proxiedGuides,
            };
        }
        const legacy = jsonData.geometry.nurbs;
        return {
            ...legacy,
            vSamples: vSamples,
            vSections: vSections,
            proxiedGuides: proxiedGuides,
            curves: decorateCurves(legacy.curves || []),
        };
    }

    /**
     * Parse `intermediate_products.v_samples[]` (e2e-gallery writer
     * output) into a flat list of point records. Each input entry
     * carries `{guide_index, v_index, v_param, u_param,
     * position: [x, y, z], nominal_position: [nx, ny, nz],
     * is_nominal_position_valid: bool}` — `position` is the anchor
     * G_k = guide ∩ plane, `nominal_position` is Q_k = nominal manifold
     * point; the displacement vector Q_k → G_k is rendered only when
     * `is_nominal_position_valid === true`.
     *
     * Records with malformed/missing positions are silently dropped
     * (defensive against producer edge cases). Records whose
     * `nominal_position` is not a 3-array, or contains NaN/Infinity, are
     * still kept but flagged with `hasNominal: false` so the renderer
     * can skip them. Returns [] when `intermediate_products` or
     * `v_samples` is absent.
     */
    static parseVSamples(jsonData) {
        const list = jsonData?.intermediate_products?.v_samples;
        if (!Array.isArray(list) || list.length === 0) return [];
        const out = [];
        for (const raw of list) {
            if (!raw || !Array.isArray(raw.position) || raw.position.length < 3) continue;
            const x = raw.position[0], y = raw.position[1], z = raw.position[2];
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;

            // nominal_position may be absent on older envelopes; treat
            // undefined/missing as "no nominal" so renderer skips it.
            let hasNominal = false;
            let nx = 0, ny = 0, nz = 0;
            if (Array.isArray(raw.nominal_position) && raw.nominal_position.length >= 3
                && raw.is_nominal_position_valid === true) {
                const cx = raw.nominal_position[0];
                const cy = raw.nominal_position[1];
                const cz = raw.nominal_position[2];
                if (Number.isFinite(cx) && Number.isFinite(cy) && Number.isFinite(cz)) {
                    nx = cx; ny = cy; nz = cz;
                    hasNominal = true;
                }
            }

            out.push({ x, y, z, nx, ny, nz, hasNominal });
        }
        return out;
    }

    /**
     * Parse `intermediate_products.v_sections[]` into an array of NURBS
     * curve descriptors (one per v-station). Each descriptor carries
     * `{v, v_index, p_u, knots_u, control_points, dim, is_rational,
     * u_min, u_max, is_periodic_u}`; Viewer3D re-evaluates the curve at
     * fine u-resolution to draw it as a polyline. Records missing the
     * required NURBS fields (knots_u, control_points, p_u) are silently
     * dropped. Returns [] when `intermediate_products` or `v_sections`
     * is absent.
     */
    static parseVSections(jsonData) {
        const list = jsonData?.intermediate_products?.v_sections;
        if (!Array.isArray(list) || list.length === 0) return [];
        const out = [];
        for (const raw of list) {
            if (!raw || typeof raw !== 'object') continue;
            const p_u = (typeof raw.p_u === 'number') ? raw.p_u : null;
            const knots_u = Array.isArray(raw.knots_u) ? raw.knots_u : null;
            const control_points = Array.isArray(raw.control_points) ? flattenControlPoints(raw.control_points) : null;
            if (p_u === null || knots_u === null || control_points === null) continue;
            if (knots_u.length === 0 || control_points.length === 0) continue;
            out.push({
                v: (typeof raw.v === 'number') ? raw.v : 0,
                v_index: (typeof raw.v_index === 'number') ? raw.v_index : -1,
                p_u,
                knots_u,
                control_points,
                dim: (typeof raw.dim === 'number') ? raw.dim : 3,
                is_rational: !!raw.is_rational,
                u_min: (typeof raw.u_min === 'number') ? raw.u_min : knots_u[p_u],
                u_max: (typeof raw.u_max === 'number') ? raw.u_max : knots_u[knots_u.length - p_u - 1],
                is_periodic_u: !!raw.is_periodic_u,
            });
        }
        return out;
    }

    /**
     * Parse `intermediate_products.proxied_guides[]` (e2e-gallery
     * PsiBasisFit loft-mode debug) into an array of NURBS curve
     * descriptors. Each entry mirrors a curve shape with
     * `type === "proxied_guide"`; only knots_v is populated
     * (knots_u empty), so the curve is evaluated along the v
     * direction (knots_v + p_v). Viewer3D re-evaluates each
     * descriptor at fine v-resolution to draw it as a polyline.
     * Records missing the required NURBS fields (knots_v /
     * control_points / p_v) are silently dropped. Returns []
     * when `intermediate_products` or `proxied_guides` is absent.
     */
    static parseProxiedGuides(jsonData) {
        const list = jsonData?.intermediate_products?.proxied_guides;
        if (!Array.isArray(list) || list.length === 0) return [];
        const out = [];
        for (const raw of list) {
            if (!raw || typeof raw !== 'object') continue;
            const p_v = (typeof raw.p_v === 'number') ? raw.p_v : null;
            const knots_v = Array.isArray(raw.knots_v) ? raw.knots_v : null;
            const control_points = Array.isArray(raw.control_points)
                ? flattenControlPoints(raw.control_points)
                : null;
            if (p_v === null || knots_v === null || control_points === null) continue;
            if (knots_v.length === 0 || control_points.length === 0) continue;
            const dim = (typeof raw.dim === 'number') ? raw.dim : 3;
            out.push({
                label: (typeof raw.label === 'string') ? raw.label : '',
                p_v,
                knots_v,
                control_points,
                controlPoints: control_points,
                dim: dim,
                is_rational: !!raw.is_rational,
                v_min: (typeof raw.v_min === 'number') ? raw.v_min : knots_v[p_v],
                v_max: (typeof raw.v_max === 'number') ? raw.v_max : knots_v[knots_v.length - p_v - 1],
                is_periodic_v: !!raw.is_periodic_v,
            });
        }
        return out;
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
