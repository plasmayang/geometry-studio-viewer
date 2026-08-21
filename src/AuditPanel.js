import { Pane } from 'tweakpane';

const AUDIT_LAYER_LABELS = {
    frames:    'Chord vs Real Frames (per v_station)',
    s_norm:    '2D Nominal Manifold s_norm^{2D}',
    u_knots:   'U-knot Pre vs Post Alignment Overlay',
    heatmaps:  'Profile/Guide Attachment Heatmap',
};

const PSI_SERIES_COLORS = [
    '#1976d2', '#d32f2f', '#388e3c', '#f57c00',
    '#7b1fa2', '#00838f', '#5d4037', '#c2185b',
];

export class AuditPanel {
    constructor({ audit, onToggleLayer, onSelectPsiSample }) {
        this.audit = audit;
        this.onToggleLayer = onToggleLayer;
        this.onSelectPsiSample = onSelectPsiSample || (() => {});
        this.pane = new Pane({
            title: 'Audit & Intermediate Products',
            expanded: true,
        });
        this.layerParams = {};
        this._build();
    }

    _build() {
        const folder = this.pane.addFolder({
            title: 'Process Audit',
            expanded: true,
        });
        const process = this.audit && this.audit.process;
        if (!process) {
            folder.addBinding({ state: 'no audit data — v1.0 case' }, 'state', { readonly: true });
            return;
        }
        if (process.profile_attachment) {
            const paFolder = folder.addFolder({ title: 'Profile Attachment', expanded: true });
            process.profile_attachment.forEach((rep, idx) => {
                const txt = `p${rep.profile_index ?? idx}: ${(rep.max_distance ?? 0).toExponential(2)}`;
                paFolder.addBinding({ val: txt }, 'val', { readonly: true, label: `p${rep.profile_index ?? idx}` });
            });
        }
        if (process.guide_attachment) {
            const gaFolder = folder.addFolder({ title: 'Guide Attachment', expanded: true });
            process.guide_attachment.forEach((rep, idx) => {
                const txt = `g${rep.guide_index ?? idx}: ${(rep.max_distance ?? 0).toExponential(2)}`;
                gaFolder.addBinding({ val: txt }, 'val', { readonly: true, label: `g${rep.guide_index ?? idx}` });
            });
        }
        if (process.surface_bounds) {
            const b = process.surface_bounds;
            const txt = b.out_of_bounds_cps > 0
                ? `${b.out_of_bounds_cps} OOB CPs`
                : `OK z=[${(b.z_min ?? 0).toFixed(3)}, ${(b.z_max ?? 0).toFixed(3)}]`;
            folder.addBinding({ val: txt }, 'val', { readonly: true, label: 'bounds' });
        }
        if (process.psi_kronecker_residual !== undefined) {
            folder.addBinding(
                { val: process.psi_kronecker_residual.toExponential(2) },
                'val', { readonly: true, label: 'Ψ-Kronecker' }
            );
        }
        if (process.psi_identity_residual !== undefined) {
            folder.addBinding(
                { val: process.psi_identity_residual.toExponential(2) },
                'val', { readonly: true, label: 'Ψ-identity' }
            );
        }

        const layersFolder = this.pane.addFolder({
            title: 'Intermediate Overlays (v1.1)',
            expanded: true,
        });
        Object.keys(AUDIT_LAYER_LABELS).forEach(layerKey => {
            this.layerParams[layerKey] = { visible: false };
            layersFolder.addBinding(this.layerParams[layerKey], 'visible', {
                label: AUDIT_LAYER_LABELS[layerKey],
            }).on('change', (ev) => this.onToggleLayer(layerKey, ev.value));
        });

        const intermediate = this.audit && this.audit.intermediate;
        if (intermediate) {
            const uKnot = intermediate.u_global_post;
            const vKnot = intermediate.v_knots;
            const vStat = intermediate.v_stations;
            const stats = [];
            if (uKnot) stats.push(`u_global_post: ${uKnot.length} knots`);
            if (vKnot) stats.push(`v_knots: ${vKnot.length} knots`);
            if (vStat) stats.push(`v_stations: ${vStat.length}`);
            if (stats.length > 0) {
                const txt = stats.join(' | ');
                layersFolder.addBinding({ val: txt }, 'val', { readonly: true, label: 'topology' });
            }

            if (intermediate.psi_basis && intermediate.psi_basis.samples) {
                const psiFolder = this.pane.addFolder({
                    title: 'Ψ Operator Basis Plot',
                    expanded: false,
                });
                this._buildPsiMicroCanvas(psiFolder, intermediate.psi_basis);
            }
        }
    }

    _buildPsiMicroCanvas(folder, psiBasis) {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 220;
        canvas.style.cssText = 'display:block;background:#fafafa;border:1px solid #ddd;border-radius:4px;margin:6px 0;';
        folder.addBinding({ canvas }, 'canvas', {
            view: 'canvas',
            label: 'Ψ basis',
        });
        const ctx = canvas.getContext('2d');
        const v_grid = psiBasis.v_grid || [];
        const samples = psiBasis.samples || [];
        if (v_grid.length === 0 || samples.length === 0) return;
        const W = canvas.width, H = canvas.height;
        const padL = 24, padR = 6, padT = 6, padB = 18;
        const plotW = W - padL - padR, plotH = H - padT - padB;
        ctx.clearRect(0, 0, W, H);
        ctx.strokeStyle = '#ccc';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + plotH);
        ctx.lineTo(padL + plotW, padT + plotH);
        ctx.stroke();
        ctx.fillStyle = '#444';
        ctx.font = '10px sans-serif';
        ctx.fillText('0', padL - 8, padT + plotH + 12);
        ctx.fillText('1', padL + plotW - 4, padT + plotH + 12);
        ctx.fillText('1', 4, padT + 8);
        ctx.fillText('0', 4, padT + plotH);
        let yMin = 0, yMax = 1;
        samples.forEach(s => {
            (s.values || []).forEach(v => {
                if (typeof v === 'number') {
                    if (v < yMin) yMin = v;
                    if (v > yMax) yMax = v;
                }
            });
        });
        const yRange = Math.max(1e-9, yMax - yMin);
        samples.forEach((s, idx) => {
            const values = s.values || [];
            if (values.length === 0) return;
            const color = PSI_SERIES_COLORS[idx % PSI_SERIES_COLORS.length];
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            for (let i = 0; i < values.length; ++i) {
                const v = values[i];
                if (typeof v !== 'number') continue;
                const t = i / Math.max(1, values.length - 1);
                const x = padL + t * plotW;
                const y = padT + plotH - ((v - yMin) / yRange) * plotH;
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.stroke();
            const tx = padL + 8;
            const ty = padT + 12 + idx * 12;
            ctx.fillStyle = color;
            ctx.fillText(`Ψ_{p${s.anchor ?? idx}}^{(${s.d ?? 0})}`, tx, ty);
        });
    }

    setLayerVisible(layerKey, visible) {
        if (this.layerParams[layerKey]) {
            this.layerParams[layerKey].visible = visible;
            this.pane.refresh();
        }
    }

    dispose() {
        if (this.pane) this.pane.dispose();
    }
}
