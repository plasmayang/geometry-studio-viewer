import { Pane } from 'tweakpane';

export class UIController {
    constructor(callbacks) {
        this.pane = new Pane({
            title: 'Geometry Inspector',
            expanded: true,
        });

        this.params = {
            case: 'case1.json',
            wireframe: false,
            showNormals: false,
            grid: true,
            color: '#4488ff',
        };

        this.init(callbacks);
    }

    init(callbacks) {
        const scenarioFolder = this.pane.addFolder({
            title: 'Scenarios',
        });

        scenarioFolder.addBinding(this.params, 'case', {
            label: 'Test Case',
            options: {
                '1. Square Column': 'case1.json',
                '2. Square Twist 45': 'case2.json',
                '3. Scaling Up': 'case3.json',
                '4. Barrel': 'case4.json',
                '5. Hourglass': 'case5.json',
                '6. Progressive Twist': 'case6.json',
                '7. Linear Shift': 'case7.json',
                '8. Twist & Scale': 'case8.json',
                '9. S-Curve': 'case9.json',
                '10. Tapered Twist': 'case10.json',
            }
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

