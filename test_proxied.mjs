import { GeometryParser } from './src/GeometryParser.js';
import { readFileSync } from 'fs';

const json = JSON.parse(readFileSync('/root/workspaces/ws_mathstudio/mathstudio00/30-data/kernel-app/gallery_outputs/vase_three_profiles_three_guides_curved_spine.json', 'utf8'));
const parsed = GeometryParser.parseMesh(json);
const mod = await import('./src/Viewer3D.js');
const v = new mod.Viewer3D();
v.loadMesh(parsed.geometry, parsed.markers, parsed.nurbs, parsed.audit, parsed.extras);
console.log('proxiedGuideLines.length:', v.proxiedGuideLines?.length);
if (v.proxiedGuideLines && v.proxiedGuideLines[0]) {
    const ln = v.proxiedGuideLines[0];
    console.log('first line name:', ln.name);
    console.log('first line visible:', ln.visible);
    console.log('first line geometry attrs:', Object.keys(ln.geometry.attributes));
    const positions = ln.geometry.attributes.position.array;
    console.log('first line pos[0..5]:', positions[0], positions[1], positions[2], positions[3], positions[4], positions[5]);
    console.log('first line pos[63*3..+2]:', positions[63*3], positions[63*3+1], positions[63*3+2]);
}
v.setProxiedGuidesVisibility(true);
console.log('after setVisibility(true), first line visible:', v.proxiedGuideLines?.[0]?.visible);