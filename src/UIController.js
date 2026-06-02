import { Pane } from 'tweakpane';

export class UIController {
    constructor(callbacks) {
        this.pane = new Pane({
            title: 'Geometry Studio',
            expanded: true,
        });

        this.params = {
            case: callbacks.manifest.length > 0 ? callbacks.manifest[0].file : '',
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
        const configFolder = this.pane.addFolder({
            title: 'Data Configuration',
            expanded: false
        });

        configFolder.addBinding(this.params, 'dataSource', {
            label: 'Source Path'
        }).on('change', (ev) => callbacks.onSourceChange(ev.value));

        configFolder.addButton({
            title: 'Refresh Gallery',
        }).on('click', () => callbacks.onSourceChange(this.params.dataSource));

        const galleryFolder = this.pane.addFolder({
            title: 'Visual Test Gallery (Dynamic)',
        });

        const caseOptions = {};
        callbacks.manifest.forEach(item => {
            caseOptions[item.name] = item.file;
        });

        galleryFolder.addBinding(this.params, 'case', {
            label: 'Select Case',
            options: caseOptions
        }).on('change', (ev) => callbacks.onCaseChange(ev.value));

        const displayFolder = this.pane.addFolder({
            title: 'Visuals',
        });

        this.surfaceFolder = this.pane.addFolder({
            title: 'Surfaces',
            expanded: true
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
}
