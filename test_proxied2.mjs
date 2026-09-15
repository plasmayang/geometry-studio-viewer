import { GeometryParser } from './src/GeometryParser.js';
import { readFileSync } from 'fs';

const json = JSON.parse(readFileSync('/root/workspaces/ws_mathstudio/mathstudio00/30-data/kernel-app/gallery_outputs/vase_three_profiles_three_guides_curved_spine.json', 'utf8'));
const parsed = GeometryParser.parseMesh(json);
const curves = parsed.nurbs.proxiedGuides;
console.log('curves count:', curves?.length);

for (let i = 0; i < curves.length; i++) {
    const c = curves[i];
    console.log('---');
    console.log('entry', i, 'label:', c.label);
    console.log('  p_v:', c.p_v, 'is number:', typeof c.p_v === 'number');
    console.log('  knots_v len:', c.knots_v?.length, 'isArray:', Array.isArray(c.knots_v));
    console.log('  control_points len:', c.control_points?.length, 'isArray:', Array.isArray(c.control_points));
    console.log('  control_points[0]:', c.control_points?.[0], 'typeof:', typeof c.control_points?.[0]);
    console.log('  dim:', c.dim);
    console.log('  v_min:', c.v_min, 'v_max:', c.v_max);

    const p = c.p_v;
    const knots = c.knots_v;
    let rawCPs = c.control_points;
    let isFlatObj = false;
    if (rawCPs && rawCPs.length > 0 && typeof rawCPs[0] === 'object') {
        isFlatObj = true;
    }
    if (p === null || knots === null || rawCPs === null) { console.log('  SKIP: null'); continue; }
    if (knots.length < p + 2 || rawCPs.length === 0) { console.log('  SKIP: empty'); continue; }
    const dim = c.dim || 3;
    const rational = (dim === 4);
    const stride = isFlatObj ? 4 : (rational ? 4 : 3);
    const numCPs = Math.floor(rawCPs.length / stride);
    if (numCPs < p + 1) { console.log('  SKIP: numCPs<'+ (p+1)); continue; }
    const vMin = (typeof c.v_min === 'number') ? c.v_min : knots[p];
    const vMax = (typeof c.v_max === 'number') ? c.v_max : knots[knots.length - p - 1];
    if (!(vMax > vMin)) { console.log('  SKIP: vmax<=vmin'); continue; }
    console.log('  PASS: numCPs=', numCPs, 'stride=', stride, 'vMin=', vMin, 'vMax=', vMax);
}