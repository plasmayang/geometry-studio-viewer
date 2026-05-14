import { Pane } from 'tweakpane';

export class UIController {
    constructor(callbacks) {
        this.pane = new Pane({
            title: 'Geometry Inspector',
            expanded: true,
        });

        this.params = {
            case: 'cases100/case1.json',
            wireframe: false,
            showNormals: false,
            grid: true,
            color: '#4488ff',
        };

        this.init(callbacks);
    }

    init(callbacks) {
        const scenarioFolder = this.pane.addFolder({
            title: 'Scenarios (100 Cases)',
        });

        const caseOptions = {};
        for (let i = 1; i <= 100; i++) {
            caseOptions[`Case ${i}`] = `cases100/case${i}.json`;
        }

        scenarioFolder.addBinding(this.params, 'case', {
            label: 'Select Case',
            options: caseOptions
        }).on('change', (ev) => callbacks.onCaseChange(ev.value));

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
            title: 'Reload Current',
        }).on('click', () => {
            callbacks.onReload();
        });
    }
}

