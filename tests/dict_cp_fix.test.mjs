/**
 * Test that the dict-to-flat CP fix preserves z values for profiles
 * and proxied guides.
 */
import { GeometryParser } from '/root/workspaces/ws_mathstudio/mathstudio00/20-self-maintained/02-tools/geometry-viewer/src/GeometryParser.js';
import { readFileSync } from 'fs';

const json = JSON.parse(readFileSync(
    '/root/workspaces/ws_mathstudio/mathstudio00/30-data/kernel-app/gallery_outputs/vase_three_profiles_three_guides_curved_spine.json',
    'utf8'
));

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); console.log(`  ✓ ${name}`); pass++; }
    catch (e) { console.log(`  ✗ ${name}: ${e.message}`); fail++; }
}

const result = GeometryParser.parseMesh(json);
console.log('result keys:', Object.keys(result));

const curves = result.nurbs && result.nurbs.curves ? result.nurbs.curves : [];
const proxiedGuides = result.proxiedGuides || [];

console.log('curves count:', curves.length);
console.log('proxiedGuides count:', proxiedGuides.length);
console.log('curve labels:', curves.map(c => c.label));

check('parseMesh returns 7 curves', () => {
    if (curves.length !== 7) throw new Error('expected 7, got ' + curves.length);
});

check('parseMesh returns 3 proxiedGuides', () => {
    if (proxiedGuides.length !== 3) throw new Error('expected 3, got ' + proxiedGuides.length);
});

check('section_0 controlPoints is flat number array (after fix)', () => {
    const p0 = curves.find(c => c.label === 'section_0');
    if (!p0) throw new Error('section_0 not found');
    const cps = p0.controlPoints;
    if (typeof cps[0] !== 'number') throw new Error(`cps[0] should be number, got ${typeof cps[0]}`);
});

check('section_0 z values are all 0 (profile_0 lies on z=0 plane)', () => {
    const cps = curves.find(c => c.label === 'section_0').controlPoints;
    const zs = [];
    for (let i = 0; i < 15; i++) zs.push(cps[i*4+2]);
    console.log('  section_0 z values:', zs);
    for (const z of zs) {
        if (z !== 0) throw new Error('expected z=0, got ' + z);
    }
});

check('section_1 z values are all 1 (profile_1 lies on z=1 plane)', () => {
    const cps = curves.find(c => c.label === 'section_1').controlPoints;
    const zs = [];
    for (let i = 0; i < 15; i++) zs.push(cps[i*4+2]);
    console.log('  section_1 z values:', zs);
    for (const z of zs) {
        if (z !== 1) throw new Error('expected z=1, got ' + z);
    }
});

check('section_2 z values are all 2 (profile_2 lies on z=2 plane)', () => {
    const cps = curves.find(c => c.label === 'section_2').controlPoints;
    const zs = [];
    for (let i = 0; i < 15; i++) zs.push(cps[i*4+2]);
    console.log('  section_2 z values:', zs);
    for (const z of zs) {
        if (z !== 2) throw new Error('expected z=2, got ' + z);
    }
});

check('proxiedGuide 0 cp[0] is (-0.5, 0, 0) [profile_0 left endpoint]', () => {
    const cps = proxiedGuides[0].controlPoints;
    if (cps[0] !== -0.5) throw new Error('cp[0].x=' + cps[0]);
    if (cps[1] !== 0) throw new Error('cp[0].y=' + cps[1]);
    if (cps[2] !== 0) throw new Error('cp[0].z=' + cps[2]);
});

check('proxiedGuide 0 cp[66] is (-0.5, 0, 2) [profile_2 left endpoint]', () => {
    const cps = proxiedGuides[0].controlPoints;
    if (cps[264] !== -0.5) throw new Error('cp[66].x=' + cps[264]);
    if (cps[265] !== 0) throw new Error('cp[66].y=' + cps[265]);
    if (cps[266] !== 2) throw new Error('cp[66].z=' + cps[266]);
});

check('proxiedGuide 2 cp[0] is (0.5, 0, 0) [profile_0 right endpoint]', () => {
    const cps = proxiedGuides[2].controlPoints;
    if (cps[0] !== 0.5) throw new Error('cp[0].x=' + cps[0]);
    if (cps[1] !== 0) throw new Error('cp[0].y=' + cps[1]);
    if (cps[2] !== 0) throw new Error('cp[0].z=' + cps[2]);
});

check('proxiedGuide 2 cp[66] is (0.5, 0, 2) [profile_2 right endpoint]', () => {
    const cps = proxiedGuides[2].controlPoints;
    if (cps[264] !== 0.5) throw new Error('cp[66].x=' + cps[264]);
    if (cps[265] !== 0) throw new Error('cp[66].y=' + cps[265]);
    if (cps[266] !== 2) throw new Error('cp[66].z=' + cps[266]);
});

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
