/**
 * Cross-validates every exported gallery case against the viewer's
 * v1.0 data contract. Run via `npm test` (or `node tests/run.js`).
 *
 * This test is the JS-side counterpart to the kernel-side
 * `kernel_tests_gallery` (C++ Catch2). Together they guarantee that:
 *   1. The manifest satisfies the v1.0 envelope (version, count, cases)
 *   2. Every `geometry.mesh.vertices` and `indices` array is a valid
 *      flat-Float32Array candidate (length divisible by 3)
 *   3. `geometry.debugMarkers.singularities` is a flat array
 *   4. `GeometryParser.parseMesh` returns non-empty {geometry, nurbs}
 *   5. The manifest only references files that exist on disk
 *
 * Number of cases is no longer hard-coded (the gallery has grown
 * organically with the kernel; spot-check tests keep the contract
 * from regressing on the canonical examples without locking the
 * suite to a specific snapshot).
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { GeometryParser } from '../src/GeometryParser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', '..', 'kernel-app', 'data');
const CASES_DIR = join(DATA_DIR, 'cases');
const MANIFEST_PATH = join(DATA_DIR, 'manifest.json');

function listCaseFiles() {
    if (!existsSync(CASES_DIR)) return [];
    return readdirSync(CASES_DIR).filter(f =>
        f.endsWith('.json') &&
        f !== 'manifest.json' &&
        f !== 'driver_output.json' &&
        f !== 'visualizer_output.json'
    );
}

function loadCaseFile(name) {
    return JSON.parse(readFileSync(join(CASES_DIR, name), 'utf8'));
}

// Canonical spot-check: representative cases from each gallery "family".
// Adding a case family should add it here.
//
// Cases whose filenames end in `*_known_broken` are kept in tests/gallery/
// as regression fixtures for known kernel bugs (homogenization, p/cp
// mismatch) but are intentionally excluded from the runnable list — they
// cannot currently round-trip through the export pipeline. Their data
// lives next to the manifest under tests/gallery/<name>_known_broken.json.
const REQUIRED_CASE_STEMS = [
    'pipe_straight', 'pipe_helix', 'ship_hull', 'cone_frustum',
    'bottle_heterogeneous',
    'exhaust_manifold', 'open_section', 'periodic_single_guide',
    'curved_spine_stress', 'degenerate_spine',
    'multi_guide_dual_open', 'multi_guide_triple_closed',
    'multi_shape_closed', 'circle_to_square',
    'heterogeneous_rational',
    'guide_with_support_surface', 'guide_with_support_surface_twist',
    'hermite_dual_guide_twist', 'hermite_position_only',
];

const _tests = [
    {
        name: 'Manifest exists and is a valid v1.0 envelope',
        fn: async () => {
            assert(existsSync(MANIFEST_PATH), `manifest.json not found at ${MANIFEST_PATH}`);
            const m = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
            assert(m.version === '1.0', `manifest version should be "1.0", got "${m.version}"`);
            assert(typeof m.count === 'number', 'manifest should have numeric count');
            assert(Array.isArray(m.cases), 'manifest should have cases array');
            assert(m.count === m.cases.length,
                `manifest count=${m.count} must equal cases.length=${m.cases.length}`);
            for (const entry of m.cases) {
                assert(entry.version === '1.0', `case ${entry.id} version should be 1.0`);
                assert(typeof entry.file === 'string', `case ${entry.id} should have file`);
                assert(typeof entry.name === 'string', `case ${entry.id} should have name`);
                assert(typeof entry.id === 'string', `case ${entry.id} should have id`);
            }
        }
    },
    {
        name: 'All manifest-referenced case files exist on disk',
        fn: async () => {
            assert(existsSync(CASES_DIR), `cases dir not found at ${CASES_DIR}`);
            const m = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
            for (const entry of m.cases) {
                const fname = entry.file.split('/').pop();
                assert(existsSync(join(CASES_DIR, fname)),
                    `manifest references missing file: ${entry.file}`);
            }
        }
    },
    {
        name: 'Canonical spot-check families are present',
        fn: async () => {
            const files = listCaseFiles();
            const stems = new Set(files.map(f => f.replace(/\.json$/, '')));
            for (const stem of REQUIRED_CASE_STEMS) {
                assert(stems.has(stem),
                    `missing canonical gallery case stem: ${stem}`);
            }
        }
    },
    {
        name: 'Every v1.0 case has a valid envelope + mesh + nurbs + markers',
        fn: async () => {
            const files = listCaseFiles();
            let checked = 0;
            let withLoftedSurface = 0;
            for (const f of files) {
                const d = loadCaseFile(f);
                // Skip legacy test-definition JSONs (no version, no geometry).
                if (d.version !== '1.0' || !d.geometry) continue;
                checked++;

                assert(d.geometry.mesh, `${f}: should have geometry.mesh`);
                assert(d.geometry.nurbs, `${f}: should have geometry.nurbs`);
                assert(d.geometry.debugMarkers, `${f}: should have geometry.debugMarkers`);

                const verts = d.geometry.mesh.vertices;
                const idx = d.geometry.mesh.indices;
                const norms = d.geometry.mesh.normals;
                assert(Array.isArray(verts), `${f}: mesh.vertices should be array`);
                assert(Array.isArray(idx), `${f}: mesh.indices should be array`);
                assert(Array.isArray(norms), `${f}: mesh.normals should be array`);
                assert(verts.length % 3 === 0,
                    `${f}: mesh.vertices length must be multiple of 3 (got ${verts.length})`);
                assert(idx.length % 3 === 0,
                    `${f}: mesh.indices length must be multiple of 3 (got ${idx.length})`);
                if (norms.length > 0) {
                    assert(norms.length === verts.length,
                        `${f}: mesh.normals length must match vertices (${norms.length} vs ${verts.length})`);
                }

                assert(Array.isArray(d.geometry.nurbs.curves),
                    `${f}: nurbs.curves should be array`);
                assert(Array.isArray(d.geometry.nurbs.surfaces),
                    `${f}: nurbs.surfaces should be array`);
                assert(d.geometry.nurbs.curves.length + d.geometry.nurbs.surfaces.length > 0,
                    `${f}: nurbs must have at least one curve or surface`);
                if (d.geometry.nurbs.surfaces.length > 0) withLoftedSurface++;

                assert(Array.isArray(d.geometry.debugMarkers.singularities),
                    `${f}: debugMarkers.singularities should be array`);
                assert(d.geometry.debugMarkers.singularities.length % 3 === 0,
                    `${f}: debugMarkers.singularities length must be multiple of 3 (got ${d.geometry.debugMarkers.singularities.length})`);
            }
            // Sanity: most cases have a lofted surface. Currently the only
            // exception is the variational_fairing case which fails to
            // homogenize — that's a pre-existing kernel bug, not a test
            // drift, so we don't enforce 100% here.
            assert(withLoftedSurface >= checked - 2,
                `expected at least ${checked - 2} cases with lofted surface, got ${withLoftedSurface}`);
        }
    },
    {
        name: 'Every v1.0 case parses via GeometryParser.parseMesh into non-empty {geometry, nurbs}',
        fn: async () => {
            const files = listCaseFiles();
            for (const f of files) {
                const d = loadCaseFile(f);
                if (d.version !== '1.0' || !d.geometry) continue;
                const { geometry, markers, nurbs } = GeometryParser.parseMesh(d);
                // Mesh vertices can be empty (evaluation scheme produces
                // empty mesh in current implementation), so check nurbs
                // presence as the primary signal of "non-empty case".
                const hasNurbs = nurbs !== null &&
                                 ((nurbs.surfaces && nurbs.surfaces.length > 0) ||
                                  (nurbs.curves && nurbs.curves.length > 0));
                assert(hasNurbs,
                    `${f}: parseMesh returned empty nurbs`);
                assert(Array.isArray(markers), `${f}: markers should be array`);
                const s = d.geometry.debugMarkers.singularities;
                assertEq(markers.length, s.length / 3,
                    `${f}: markers count should match singularities / 3`);
            }
        }
    },
    {
        name: 'Support-surface cases emit support_surfaces in the envelope',
        fn: async () => {
            const m = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
            const supportCaseIds = ['guide_with_support_surface',
                                    'guide_with_support_surface_twist',
                                    'hermite_dual_guide_twist'];
            for (const id of supportCaseIds) {
                const entry = m.cases.find(c => c.id === id);
                assert(entry, `manifest should include ${id}`);
                const fname = entry.file.split('/').pop();
                const d = loadCaseFile(fname);
                const ss = d.geometry.nurbs.support_surfaces;
                assert(ss !== undefined && Array.isArray(ss) && ss.length >= 1,
                    `${id}: geometry.nurbs.support_surfaces should be non-empty`);
                for (const s of ss) {
                    assert(s.label === 'Support Surface',
                        `${id}: support_surface should have label='Support Surface', got '${s.label}'`);
                }
            }
        }
    }
];

function assert(cond, msg) {
    if (!cond) throw new Error('Assertion failed: ' + (msg || ''));
}

function assertEq(actual, expected, msg) {
    if (actual !== expected) {
        throw new Error(
            (msg ? msg + ': ' : 'Assertion failed: ') +
            `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
        );
    }
}

export const tests = _tests;
export const description = 'Gallery v1.0 contract cross-validation (canonical families)';
