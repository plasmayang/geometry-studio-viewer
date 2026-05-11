import { Pane } from 'tweakpane';

export class UIController {
    constructor(callbacks) {
        // Tweakpane Light Theme is applied via CSS or property
        this.pane = new Pane({
            title: 'Geometry Inspector',
            expanded: true,
        });

        this.params = {
            wireframe: false,
            showNormals: false,
            grid: true,
            color: '#4488ff',
        };

        this.init(callbacks);
    }

    init(callbacks) {
        const displayFolder = this.pane.addFolder({
            title: 'Visuals',
        });

        displayFolder.addBinding(this.params, 'wireframe', { label: 'Wireframe' })
            .on('change', (ev) => callbacks.onWireframeToggle(ev.value));

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
            title: 'Reload Mock Data',
        }).on('click', () => {
            callbacks.onReload();
        });
    }
}
