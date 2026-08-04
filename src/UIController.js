import { Pane } from 'tweakpane';

export class UIController {
    constructor(callbacks) {
        this.callbacks = callbacks;

        this.pane = new Pane({
            title: 'Geometry Studio',
            expanded: true,
        });

        // Profiles exposed at build-time by vite.config.js.
        const profiles = callbacks.profiles || {};
        const activeProfileName = callbacks.activeProfileName
            || Object.keys(profiles)[0] || null;
        const activeProfile = activeProfileName ? profiles[activeProfileName] : null;

        this.params = {
            profile: activeProfileName,
            dataSource: callbacks.dataSource,
            wireframe: false,
            showControlPolygon: true,
            showNormals: false,
            grid: true,
            color: '#4488ff',
        };

        this.init(callbacks);
    }

    init(callbacks) {
        const profiles = callbacks.profiles || {};
        const configFolder = this.pane.addFolder({
            title: 'Data Configuration',
            expanded: false
        });

        // Profile picker: drives both url_prefix and source path.
        if (Object.keys(profiles).length > 0) {
            const profileOptions = Object.entries(profiles).map(([k, v]) => ({
                text: `${k}${v.description ? '  ' + v.description : ''}`,
                value: k,
            }));
            this.profileBinding = configFolder.addBinding(this.params, 'profile', {
                label: 'Profile',
                options: profileOptions,
            }).on('change', (ev) => {
                const next = profiles[ev.value];
                if (!next) return;
                this.params.dataSource = next.url_prefix;
                if (this.dataSourceBinding) this.dataSourceBinding.refresh();
                if (this.profileBinding) this.profileBinding.refresh();
                callbacks.onProfileChange(ev.value, next);
            });
        }

        this.dataSourceBinding = configFolder.addBinding(this.params, 'dataSource', {
            label: 'Source Path'
        }).on('change', (ev) => callbacks.onSourceChange(ev.value));

        configFolder.addButton({
            title: 'Refresh Gallery',
        }).on('click', () => callbacks.onSourceChange(this.params.dataSource));

        const galleryFolder = this.pane.addFolder({
            title: 'Visual Test Gallery (Dynamic)',
        });

        const displayFolder = this.pane.addFolder({
            title: 'Visuals',
        });

        this.surfaceFolder = this.pane.addFolder({
            title: 'Lofted Surface (3 modes)',
            expanded: true
        });

        this.curveFolder = this.pane.addFolder({
            title: 'Curves',
            expanded: false
        });

        displayFolder.addBinding(this.params, 'wireframe', { label: 'Wireframe' })
            .on('change', (ev) => callbacks.onWireframeToggle(ev.value));

        displayFolder.addBinding(this.params, 'showControlPolygon', { label: 'Control Polygon' })
            .on('change', (ev) => callbacks.onControlPolygonToggle(ev.value));

        displayFolder.addBinding(this.params, 'showNormals', { label: 'Show Normals' })
            .on('change', (ev) => callbacks.onNormalsToggle(ev.value));

        displayFolder.addBinding(this.params, 'grid', { label: 'Show Grid' })
            .on('change', (ev) => callbacks.onGridToggle(ev.value));

        displayFolder.addBinding(this.params, 'color', { label: 'Mesh Color' })
            .on('change', (ev) => callbacks.onColorChange(ev.value));

        const actionsFolder = this.pane.addFolder({
            title: 'Actions',
        });

        actionsFolder.addButton({
            title: 'Reload Current',
        }).on('click', () => {
            callbacks.onReload();
        });
    }

    updateSurfaceToggles(surfaces, onToggle) {
        // Clear existing surface bindings
        this.surfaceFolder.children.forEach(c => c.dispose());

        surfaces.forEach(label => {
            const params = { visible: true };
            this.surfaceFolder.addBinding(params, 'visible', {
                label: label
            }).on('change', (ev) => onToggle(label, ev.value));
        });
    }

    updateCurveToggles(curves, onToggle) {
        this.curveFolder.children.forEach(c => c.dispose());
        curves.forEach(label => {
            const params = { visible: true };
            this.curveFolder.addBinding(params, 'visible', {
                label: label
            }).on('change', (ev) => onToggle(label, ev.value));
        });
    }
}