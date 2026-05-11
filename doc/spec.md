# 🚀 产品需求文档 (PRD)

## 1. 产品定位与目标
*   **产品名称**：Geometry Studio Web Viewer
*   **核心目标**：提供一个极简、高性能的浏览器 3D 渲染环境，用于解析和可视化独立几何内核生成的静态网格数据，从而验证几何算法的正确性。
*   **当前阶段 (v1.0)**：通用协议沙箱阶段。脱离特定后端，通过标准 JSON 协议打通数据解析到 3D 渲染的完整链路。

## 2. 核心用户故事 (User Stories)
*   **US-1：数据解析**。作为一个底层算法工程师，我需要前端能够精确读取预先定义好的 JSON 格式数据（包含顶点、法线、索引），以便我能确认数据通信协议没有发生精度丢失或结构错误。
*   **US-2：几何渲染**。作为一个内核开发者，我需要屏幕中央能以 3D 形式展示网格表面，支持鼠标拖拽旋转、缩放、平移，以便我能全方位检查曲面拓扑是否正确。
*   **US-3：调试控制台**。作为一个测试者，我需要在页面侧边栏有一个参数面板（Tweakpane），允许我一键切换“线框模式 (Wireframe)”、“实体模式 (Solid)”和“显示法线 (Normals)”，以便我检查曲面的法向量朝向和网格剖分密度。

## 3. 非功能性需求
*   **技术栈锁定**：Vanilla JS (ES6+) + Vite + Three.js + Tweakpane。拒绝使用重量级框架（无 React/Vue）。

---

# 🛠️ 技术规格书 (Technical Spec)

## 1. 架构设计与目录结构
项目采用极简的模块化划分，确保职责分离：

```text
geometry-studio-viewer/
├── index.html            // 唯一入口文件
├── package.json          // 依赖清单 (three, tweakpane)
├── vite.config.js        // 简单的 Vite 配置
├── src/
│   ├── main.js           // 应用主控逻辑，初始化各模块
│   ├── Viewer3D.js       // Three.js 核心：场景、相机、渲染器、灯光
│   ├── UIController.js   // Tweakpane 面板配置与事件绑定
│   ├── GeometryParser.js // 解析 JSON 契约，生成 THREE.BufferGeometry
│   └── mock/
│       └── rbo_test_case.json // [核心] 伪造的契约数据

```

## 2. 数据契约 (Data Contract) - `rbo_test_case.json`

这是第一阶段最重要的产物。它定义了调度层接口必须返回的严格数据格式。

```json
{
  "version": "1.0",
  "geometry": {
    "type": "TriangularMesh",
    "mesh": {
      "vertices": [
        0.0, 0.0, 0.0,   1.0, 0.0, 0.0,   0.0, 1.0, 0.0,
        1.0, 0.0, 0.0,   1.0, 1.0, 0.0,   0.0, 1.0, 0.0
      ], 
      "normals": [
        0.0, 0.0, 1.0,   0.0, 0.0, 1.0,   0.0, 0.0, 1.0,
        0.0, 0.0, 1.0,   0.0, 0.0, 1.0,   0.0, 0.0, 1.0
      ],
      "indices": [0, 1, 2, 3, 4, 5]
    },
    "debugMarkers": {
      "singularities": [0.5, 0.5, 0.0] 
    }
  }
}

```

*规格说明*：

* `vertices` 和 `normals` 必须展平为 1D 数组（`[x1, y1, z1, x2, y2, z2...]`），这能让前端最快地将其转化为 `Float32Array` 并推入 GPU。
* 保留了 `debugMarkers` 节点，专门用于标记内核识别出的奇异点或特征线。

## 3. 核心模块接口定义 (Interfaces)

### 3.1 `Viewer3D.js`

负责与 WebGL 打交道。

* `init(canvasElement)`: 初始化场景。
* `loadMesh(bufferGeometry)`: 清理旧网格，将新网格加入场景，自动居中并缩放相机以适应包围盒 (Bounding Box)。
* `setWireframe(boolean)`: 切换线框显示。
* `showNormals(boolean)`: 渲染法线辅助线 (VertexNormalsHelper)。

### 3.2 `GeometryParser.js`

纯数据转换层。

* `parseMesh(jsonData)`: 提取 `jsonData.geometry.mesh`，利用 `new THREE.BufferAttribute` 将数组转换为 GPU 可读格式。

### 3.3 `UIController.js`

利用 Tweakpane 构建交互控制台。
