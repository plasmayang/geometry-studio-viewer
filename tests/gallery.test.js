/**
 * Cross-validates all 16 exported gallery cases against the viewer's
 * v1.0 data contract. Run via `npm test` (or `node tests/run.js`).
 *
 * This test is the JS-side counterpart to the kernel-side
 * `kernel_tests_gallery` (C++ Catch2). Together they guarantee that:
 *   1. Every gallery export satisfies the v1.0 envelope (version, geometry)
 *   2. Every mesh.vertices array is a valid flat Float32Array candidate
 *   3. Every geometry.debugMarkers.singularities is a valid flat array
 *   4. GeometryParser.parseMesh returns non-empty {geometry, markers, nurbs}
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

const _tests = [
    {
        name: 'Manifest exists and is a valid v1.0 envelope',
        fn: async () => {
            assert(existsSync(MANIFEST_PATH), `manifest.json not found at ${MANIFEST_PATH}`);
            const m = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
            assert(m.version === '1.0', `manifest version should be "1.0", got "${m.version}"`);
            assert(typeof m.count === 'number', 'manifest should have numeric count');
            assert(m.count === 16, `manifest count should be 16, got ${m.count}`);
            assert(Array.isArray(m.cases), 'manifest should have cases array');
            assert(m.cases.length === 16, `manifest should have 16 cases, got ${m.cases.length}`);
            for (const entry of m.cases) {
                assert(entry.version === '1.0', `case ${entry.id} version should be 1.0`);
                assert(typeof entry.file === 'string', `case ${entry.id} should have file`);
                assert(typeof entry.name === 'string', `case ${entry.id} should have name`);
            }
        }
    },
    {
        name: 'All 16 gallery case files exist on disk',
        fn: async () => {
            assert(existsSync(CASES_DIR), `cases dir not found at ${CASES_DIR}`);
            const files = listCaseFiles();
            assert(files.length >= 16, `expected >= 16 case files, got ${files.length}`);
            // Spot-check the canonical 16 (12 numbered + 4 special).
            const required = [
                '01_pipe_straight.json', '02_pipe_helix.json', '03_ship_hull.json',
                '04_ramp.json', '05_bottle.json', '06_propeller_blade.json',
                '07_wing_skin.json', '08_exhaust_manifold.json', '09_open_section.json',
                '10_periodic.json', '11_curved_spine.json', '12_degenerate.json',
                'catia_coupling.json', 'mutation_data_driven.json',
                'mutation_sharp.json', 'variational_fairing.json'
            ];
            for (const f of required) {
                assert(files.includes(f), `missing canonical gallery case: ${f}`);
            }
        }
    },
    {
        name: 'Every v1.0 case has valid envelope + mesh + nurbs + markers',
        fn: async () => {
            const files = listCaseFiles();
            let checked = 0;
            for (const f of files) {
                const d = loadCaseFile(f);
                // Skip legacy test-definition JSONs (no version, no geometry).
                if (d.version !== '1.0' || !d.geometry) continue;
                checked++;

                assert(d.geometry.mesh, `${f}: should have geometry.mesh`);
                assert(d.geometry.nurbs, `${f}: should have geometry.nurbs`);
                assert(d.geometry.debugMarkers, `${f}: should have geometry.debugMarkers`);

                // mesh invariants
                const verts = d.geometry.mesh.vertices;
                const idx = d.geometry.mesh.indices;
                const norms = d.geometry.mesh.normals;
                assert(Array.isArray(verts), `${f}: mesh.vertices should be array`);
                assert(Array.isArray(idx), `${f}: mesh.indices should be array`);
                assert(verts.length > 0, `${f}: mesh.vertices should be non-empty`);
                assert(idx.length > 0, `${f}: mesh.indices should be non-empty`);
                assert(verts.length % 3 === 0,
                    `${f}: mesh.vertices length must be multiple of 3 (got ${verts.length})`);
                assert(idx.length % 3 === 0,
                    `${f}: mesh.indices length must be multiple of 3 (got ${idx.length})`);
                if (Array.isArray(norms) && norms.length > 0) {
                    assert(norms.length === verts.length,
                        `${f}: mesh.normals length must match vertices (${norms.length} vs ${verts.length})`);
                }

                // nurbs invariants
                assert(Array.isArray(d.geometry.nurbs.curves),
                    `${f}: nurbs.curves should be array`);
                assert(Array.isArray(d.geometry.nurbs.surfaces),
                    `${f}: nurbs.surfaces should be array`);
                assert(d.geometry.nurbs.curves.length + d.geometry.nurbs.surfaces.length > 0,
                    `${f}: nurbs must have at least one curve or surface`);

                // markers invariants
                assert(Array.isArray(d.geometry.debugMarkers.singularities),
                    `${f}: debugMarkers.singularities should be array`);
                assert(d.geometry.debugMarkers.singularities.length % 3 === 0,
                    `${f}: debugMarkers.singularities length must be multiple of 3 (got ${d.geometry.debugMarkers.singularities.length})`);
            }
            assert(checked === 16,
                `expected to validate exactly 16 v1.0 cases, validated ${checked}`);
        }
    },
    {
        name: 'Every v1.0 case parses via GeometryParser.parseMesh into non-empty {geometry, nurbs}',
        fn: async () => {
            const files = listCaseFiles();
            for (const f of files) {
                const d = loadCaseFile(f);
                if (d.version !== '1.0' || !d.geometry) continue;  // skip legacy
                const { geometry, markers, nurbs } = GeometryParser.parseMesh(d);
                const hasMesh = geometry.attributes.position !== undefined &&
                                geometry.attributes.position.array.length > 0;
                const hasNurbs = nurbs !== null &&
                                 ((nurbs.surfaces && nurbs.surfaces.length > 0) ||
                                  (nurbs.curves && nurbs.curves.length > 0));
                assert(hasMesh || hasNurbs,
                    `${f}: parseMesh returned empty {geometry, nurbs}`);
                assert(Array.isArray(markers), `${f}: markers should be array`);
                // Markers count must match singularities in source (3 floats per marker).
                const s = d.geometry.debugMarkers.singularities;
                assertEq(markers.length, s.length / 3,
                    `${f}: markers count should match singularities / 3`);
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
export const description = 'Gallery v1.0 contract cross-validation (16 cases)';
