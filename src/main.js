import { Viewer3D } from './Viewer3D.js';
import { GeometryParser } from './GeometryParser.js';
import { UIController } from './UIController.js';
import { STPImporter } from './STPImporter.js';

class App {
    constructor() {
        this.viewer = new Viewer3D();
        this.ui = null;
        this.currentCase = null;
        this.manifest = [];
        this.dataSourceBase = '/src/mock/data_source'; // Point directly to the gallery data
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
            this.manifest = manifest;
            
            if (manifest.length > 0) {
                this.currentCase = manifest[0].file;
            }
            
            this.renderCaseList('');
            this.renderTagCloud();
            
            document.getElementById('tag-filter').addEventListener('input', (e) => {
                this.renderCaseList(e.target.value.toLowerCase());
                this.syncButtonsFromInput();
            });

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
                onControlPolygonToggle: (enabled) => this.viewer.setControlPolygon(enabled),
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

    renderTagCloud() {
        const allTags = new Set();
        this.manifest.forEach(item => {
            if (item.tags) item.tags.forEach(t => allTags.add(t));
        });
        
        const tagCloud = document.getElementById('tag-cloud');
        tagCloud.innerHTML = '';
        Array.from(allTags).sort().forEach(tag => {
            const btn = document.createElement('button');
            btn.dataset.tag = tag;
            btn.innerText = tag;
            btn.dataset.state = '0';
            btn.style.border = '1px solid #ccc';
            btn.style.borderRadius = '12px';
            btn.style.padding = '3px 8px';
            btn.style.fontSize = '11px';
            btn.style.cursor = 'pointer';
            btn.style.backgroundColor = '#f0f0f0';
            btn.style.color = '#333';
            btn.style.transition = 'all 0.2s';
            
            btn.onclick = () => {
                let state = parseInt(btn.dataset.state);
                state = (state + 1) % 3;
                btn.dataset.state = state;
                this.updateFilterFromButtons();
            };
            tagCloud.appendChild(btn);
        });
        this.syncButtonsFromInput();
    }

    updateFilterFromButtons() {
        const btns = document.querySelectorAll('#tag-cloud button');
        const input = document.getElementById('tag-filter');
        const currentTerms = input.value.toLowerCase().split(/\s+/).filter(t => t.length > 0);
        
        const allTagsList = Array.from(btns).map(b => b.dataset.tag);
        let newTerms = currentTerms.filter(t => {
            const tCore = t.startsWith('-') ? t.substring(1) : t;
            return !allTagsList.includes(tCore);
        });
        
        btns.forEach(btn => {
            const state = parseInt(btn.dataset.state);
            const tag = btn.dataset.tag;
            if (state === 1) newTerms.push(tag);
            else if (state === 2) newTerms.push('-' + tag);
        });
        
        input.value = newTerms.join(' ');
        this.renderCaseList(input.value.toLowerCase());
        this.syncButtonsFromInput();
    }

    syncButtonsFromInput() {
        const input = document.getElementById('tag-filter');
        const terms = input.value.toLowerCase().split(/\s+/).filter(t => t.length > 0);
        
        const btns = document.querySelectorAll('#tag-cloud button');
        btns.forEach(btn => {
            const tag = btn.dataset.tag;
            if (terms.includes(tag)) {
                btn.dataset.state = '1';
                btn.style.backgroundColor = '#1976d2';
                btn.style.color = 'white';
                btn.style.borderColor = '#1976d2';
            } else if (terms.includes('-' + tag)) {
                btn.dataset.state = '2';
                btn.style.backgroundColor = '#d32f2f';
                btn.style.color = 'white';
                btn.style.borderColor = '#d32f2f';
            } else {
                btn.dataset.state = '0';
                btn.style.backgroundColor = '#f0f0f0';
                btn.style.color = '#333';
                btn.style.borderColor = '#ccc';
            }
        });
    }

    renderCaseList(filterText) {
        const listDiv = document.getElementById('case-list');
        listDiv.innerHTML = '';
        
        const terms = filterText ? filterText.toLowerCase().split(/\s+/).filter(t => t.length > 0) : [];
        
        const filtered = this.manifest.filter(item => {
            if (terms.length === 0) return true;
            
            for (const term of terms) {
                if (term.startsWith('-')) {
                    const negTerm = term.substring(1);
                    if (negTerm.length === 0) continue;
                    const textMatch = item.name.toLowerCase().includes(negTerm);
                    const tagMatch = item.tags && item.tags.some(tag => tag.toLowerCase().includes(negTerm));
                    if (textMatch || tagMatch) return false; // Exclude if negative term matches
                } else {
                    const textMatch = item.name.toLowerCase().includes(term);
                    const tagMatch = item.tags && item.tags.some(tag => tag.toLowerCase().includes(term));
                    if (!textMatch && !tagMatch) return false; // Require all positive terms to match
                }
            }
            return true;
        });

        filtered.forEach(item => {
            const div = document.createElement('div');
            div.style.padding = '8px';
            div.style.marginBottom = '5px';
            div.style.backgroundColor = this.currentCase === item.file ? '#e3f2fd' : '#fafafa';
            div.style.border = this.currentCase === item.file ? '1px solid #90caf9' : '1px solid #ddd';
            div.style.borderRadius = '4px';
            div.style.cursor = 'pointer';
            
            let html = `<div style="font-weight: bold; font-size: 13px; color: #333;">${item.name}</div>`;
            if (item.tags && item.tags.length > 0) {
                html += `<div style="margin-top: 5px; display: flex; flex-wrap: wrap; gap: 4px;">`;
                item.tags.forEach(tag => {
                    // color code tags
                    let color = '#757575';
                    if (tag.startsWith('profile')) color = '#1976d2';
                    if (tag.startsWith('guide') || tag.startsWith('constraint')) color = '#e65100';
                    if (tag.startsWith('topology')) color = '#d32f2f';
                    if (tag.startsWith('scheme')) color = '#7b1fa2';
                    html += `<span style="font-size: 10px; padding: 2px 6px; border-radius: 10px; background-color: ${color}; color: white;">${tag}</span>`;
                });
                html += `</div>`;
            }
            div.innerHTML = html;
            
            div.onclick = () => {
                this.currentCase = item.file;
                this.renderCaseList(document.getElementById('tag-filter').value.toLowerCase()); // re-render to update selection style
                this.loadData();
            };
            
            listDiv.appendChild(div);
        });
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
                
                document.getElementById('case-title').innerText = jsonData.caseName || jsonData.name || 'Untitled Case';
                
                let infoHtml = `<div style="margin-bottom: 10px; border-bottom: 1px solid #eee; padding-bottom: 5px;"><strong>Summary:</strong><br/>${jsonData.description || 'N/A'}</div>`;
                if (jsonData.tags) {
                    infoHtml += `<div style="margin-bottom: 10px;"><strong>Tags:</strong><br/><span style="font-size: 11px;">${jsonData.tags.join(', ')}</span></div>`;
                }
                infoHtml += `<div style="margin-bottom: 10px;"><strong>Intent Space:</strong><br/><span style="font-family: monospace; font-size: 11px; white-space: pre-wrap;">${jsonData.intent_space || 'N/A'}</span></div>`;
                infoHtml += `<div><strong>Success Criteria:</strong><br/><span style="color: #2e7d32;">${jsonData.success_criteria || 'N/A'}</span></div>`;
                
                document.getElementById('case-description').innerHTML = infoHtml;

                const { geometry, markers, nurbs } = GeometryParser.parseMesh(jsonData);
                const surfaceLabels = this.viewer.loadMesh(geometry, markers, nurbs);
                
                this.ui.updateSurfaceToggles(surfaceLabels, (label, visible) => {
                    this.viewer.setSurfaceVisibility(label, visible);
                });
            }
        } catch (error) {
            console.error('Error loading data:', error);
        }
    }
}

const app = new App();
app.init();

export { app };