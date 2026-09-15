/**
 * Test that the dict-format control_points fix correctly preserves
 * x, y, z values for the 3 profiles. Before the fix, the viewer
 * read cps[idx] as a dict (e.g. {x,y,z,w}) instead of a number,
 * causing all 3 profiles to render at z=0.
 *
 * Pass criteria: flattenControlPoints converts dict array to flat
 * [x, y, z, w, x, y, z, w, ...] array preserving all coordinates.
 */
import { GeometryParser } from '/root/workspaces/ws_mathstudio/mathstudio00/20-self-maintained/02-tools/geometry-viewer/src/GeometryParser.js';
import { readFileSync } from 'fs';

const json = JSON.parse(readFileSync(
    '/root/workspaces/ws_mathstudio/mathstudio00/30-data/kernel-app/gallery_outputs/vase_three_profiles_three_guides_curved_spine.json',
    'utf8'
));

const _tests = [
    {
        name: 'parseMesh returns curves with flat CPs (profile_0 z=0)',
        fn: () => {
            const { nurbs } = GeometryParser.parseMesh(json);
            const p0 = nurbs.curves.find(c => c.label === 'section_0');
            assert(p0, 'section_0 curve not found');
            const cp0 = p0.controlPoints;
            assert(Array.isArray(cp0), 'controlPoints should be array');
            assert(typeof cp0[0] === 'number', `cp0[0] should be number, got ${typeof cp0[0]}`);
            assert(cp0[2] === 0, `profile_0 z should be 0, got ${cp0[2]}`);
            const cps0 = [];
            for (let i = 0; i < 5; i++) {
                cps0.push(`(${cp0[i*4].toFixed(2)},${cp0[i*4+1].toFixed(2)},${cp0[i*4+2].toFixed(2)})`);
            }
            console.log(`    profile_0 first 5 CPs: ${cps0.join(' ')}`);
        }
    },
    {
        name: 'parseMesh returns curves with flat CPs (profile_1 z=1)',
        fn: () => {
            const { nurbs } = GeometryParser.parseMesh(json);
            const p1 = nurbs.curves.find(c => c.label === 'section_1');
            assert(p1, 'section_1 curve not found');
            const cp1 = p1.controlPoints;
            assert(Array.isArray(cp1), 'controlPoints should be array');
            assert(typeof cp1[0] === 'number', `cp1[0] should be number, got ${typeof cp1[0]}`);
            assert(cp1[2] === 1, `profile_1 z should be 1, got ${cp1[2]}`);
            const cps1 = [];
            for (let i = 0; i < 5; i++) {
                cps1.push(`(${cp1[i*4].toFixed(2)},${cp1[i*4+1].toFixed(2)},${cp1[i*4+2].toFixed(2)})`);
            }
            console.log(`    profile_1 first 5 CPs: ${cps1.join(' ')}`);
        }
    },
    {
        name: 'parseMesh returns curves with flat CPs (profile_2 z=2)',
        fn: () => {
            const { nurbs } = GeometryParser.parseMesh(json);
            const p2 = nurbs.curves.find(c => c.label === 'section_2');
            assert(p2, 'section_2 curve not found');
            const cp2 = p2.controlPoints;
            assert(Array.isArray(cp2), 'controlPoints should be array');
            assert(typeof cp2[0] === 'number', `cp2[0] should be number, got ${typeof cp2[0]}`);
            assert(cp2[2] === 2, `profile_2 z should be 2, got ${cp2[2]}`);
            const cps2 = [];
            for (let i = 0; i < 5; i++) {
                cps2.push(`(${cp2[i*4].toFixed(2)},${cp2[i*4+1].toFixed(2)},${cp2[i*4+2].toFixed(2)})`);
            }
            console.log(`    profile_2 first 5 CPs: ${cps2.join(' ')}`);
        }
    },
    {
        name: 'proxiedGuides parsed with flat CPs (boundary CPs at correct z)',
        fn: () => {
            const parsed = GeometryParser.parseMesh(json);
            const pg = parsed.proxiedGuides;
            assert(Array.isArray(pg) && pg.length === 3, 'expect 3 proxied guides');
            for (let k = 0; k < 3; k++) {
                const cps = pg[k].controlPoints;
                assert(Array.isArray(cps), `pg[${k}].controlPoints should be array`);
                assert(typeof cps[0] === 'number',
                    `pg[${k}].cps[0] should be number, got ${typeof cps[0]}`);
                assert(cps[0*4+2] === 0, `pg[${k}] first CP z=0, got ${cps[0*4+2]}`);
                assert(cps[66*4+2] === 2, `pg[${k}] last CP z=2, got ${cps[66*4+2]}`);
                const summary = `cp[0]=(${cps[0].toFixed(2)},${cps[1].toFixed(2)},${cps[2].toFixed(2)}) cp[66]=(${cps[264].toFixed(2)},${cps[265].toFixed(2)},${cps[266].toFixed(2)})`;
                console.log(`    pg[${k}]: ${summary}`);
            }
        }
    }
];

function assert(cond, msg) {
    if (!cond) throw new Error('Assertion failed: ' + (msg || ''));
}

export const tests = _tests;
export const description = 'Dict-to-flat CP fix verification (3 profiles + 3 proxied guides)';
