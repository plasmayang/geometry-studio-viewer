import { Viewer3D } from './Viewer3D.js';
import { GeometryParser } from './GeometryParser.js';
import { UIController } from './UIController.js';
import { STPImporter } from './STPImporter.js';

class App {
    constructor() {
        this.viewer = new Viewer3D();
        this.ui = null;
        this.currentCase = null;
        this.dataSourceBase = '/src/mock/data_source'; // Reverted to root to avoid pathing issues
    }

    async init() {
        const container = document.getElementById('app');
        this.viewer.init(container);
        // Load initially from default or URL param
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.has('data')) {
            this.dataSourceBase = urlParams.get('data');
        }

        await this.refreshGallery();
    }

    async refreshGallery() {
        try {
            // 1. Fetch Manifest from current source
            const response = await fetch(`${this.dataSourceBase}/manifest.json`);
            if (!response.ok) throw new Error(`Manifest not found at ${this.dataSourceBase}. Check path/symlink.`);
            
            const manifest = await response.json();
            
            if (manifest.length > 0) {
                this.currentCase = manifest[0].file;
            }
            // (Re)init UI
            if (this.ui) {
                window.location.reload();
                return;
            }
            this.ui = new UIController({
                manifest: manifest,
                dataSource: this.dataSourceBase,
                onCaseChange: (caseFile) => {
                    this.currentCase = caseFile;
                    this.loadData();
                },
                onSourceChange: (newPath) => {
                    this.dataSourceBase = newPath;
                    this.refreshGallery();
                },
                onWireframeToggle: (enabled) => this.viewer.setWireframe(enabled),
                onNormalsToggle: (enabled) => this.viewer.showNormals(enabled),
                onGridToggle: (enabled) => this.viewer.setGrid(enabled),
                onColorChange: (color) => this.viewer.setMeshColor(color),
                onReload: () => this.loadData()
            });

            if (this.currentCase) await this.loadData();

        } catch (error) {
            console.error('Initialization Error:', error);
            this.showError(error.message);
        }
    }

    showError(msg) {
        document.getElementById('case-title').innerText = 'Data Source Error';
        document.getElementById('case-description').innerText = msg + '\n\nTry providing a path relative to the server root (e.g. /src/mock/data_source)';
        
        if (!this.ui) {
            this.ui = new UIController({
                manifest: [],
                dataSource: this.dataSourceBase,
                onSourceChange: (newPath) => {
                    this.dataSourceBase = newPath;
                    this.refreshGallery();
                }
            });
        }
    }

    async loadData() {
        try {
            const url = `${this.dataSourceBase}/${this.currentCase}`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Failed to fetch case: ${this.currentCase}`);

            const isSTP = this.currentCase.toLowerCase().endsWith('.stp')
                       || this.currentCase.toLowerCase().endsWith('.step');

            if (isSTP) {
                const buffer = await response.arrayBuffer();
                const parsed = STPImporter.parseBuffer(buffer);
                const geometry = STPImporter.toBufferGeometry(parsed);
                this.viewer.loadMesh(geometry, [], null);
                document.getElementById('case-title').innerText = this.currentCase;
                document.getElementById('case-description').innerText = 'STEP file loaded via STPImporter';
            } else {
                const jsonData = await response.json();
                console.log('Case Loaded:', jsonData.caseName);
                
                document.getElementById('case-title').innerText = jsonData.caseName || 'Untitled Case';
                
                let infoHtml = `<strong>Design Intent:</strong><br/>${jsonData.design_intent || jsonData.description || 'N/A'}<br/><br/>`;
                infoHtml += `<strong>Success Criteria:</strong><br/>${jsonData.success_criteria || 'N/A'}`;
                
                document.getElementById('case-description').innerHTML = infoHtml;

                const { geometry, markers, nurbs } = GeometryParser.parseMesh(jsonData);
                this.viewer.loadMesh(geometry, markers, nurbs);
            }
        } catch (error) {
            console.error('Error loading data:', error);
        }
    }
}

const app = new App();
app.init();

export { app };