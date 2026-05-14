import { Viewer3D } from './Viewer3D.js';
import { GeometryParser } from './GeometryParser.js';
import { UIController } from './UIController.js';

class App {
    constructor() {
        this.viewer = new Viewer3D();
        this.ui = null;
        this.currentCase = 'case1.json';
    }

    async init() {
        const container = document.getElementById('app');
        this.viewer.init(container);

        this.ui = new UIController({
            onCaseChange: (caseFile) => {
                this.currentCase = caseFile;
                this.loadData();
            },
            onWireframeToggle: (enabled) => this.viewer.setWireframe(enabled),
            onNormalsToggle: (enabled) => this.viewer.showNormals(enabled),
            onGridToggle: (enabled) => this.viewer.setGrid(enabled),
            onColorChange: (color) => this.viewer.setMeshColor(color),
            onReload: () => this.loadData()
        });

        await this.loadData();
    }

    async loadData() {
        try {
            const response = await fetch(`/src/mock/${this.currentCase}`);
            if (!response.ok) throw new Error(`Failed to fetch ${this.currentCase}`);
            
            const jsonData = await response.json();
            console.log('Case Loaded:', jsonData.caseName);
            
            const { geometry, markers, nurbs } = GeometryParser.parseMesh(jsonData);
            this.viewer.loadMesh(geometry, markers, nurbs);
        } catch (error) {
            console.error('Error loading data:', error);
        }
    }
}

const app = new App();
app.init();

