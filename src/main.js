import { Viewer3D } from './Viewer3D.js';
import { GeometryParser } from './GeometryParser.js';
import { UIController } from './UIController.js';

class App {
    constructor() {
        this.viewer = new Viewer3D();
        this.ui = null;
    }

    async init() {
        const container = document.getElementById('app');
        this.viewer.init(container);

        this.ui = new UIController({
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
            // Using absolute path for Vite
            const response = await fetch('/src/mock/rbo_test_case.json');
            if (!response.ok) throw new Error('Failed to fetch mock data');
            
            const jsonData = await response.json();
            console.log('Kernel Info:', jsonData.kernelInfo);
            
            const geometry = GeometryParser.parseMesh(jsonData);
            this.viewer.loadMesh(geometry);
        } catch (error) {
            console.error('Error loading data:', error);
        }
    }
}

const app = new App();
app.init();
