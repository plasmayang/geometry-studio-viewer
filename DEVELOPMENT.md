# Architecture & Development Guide

本项目采用 **数据与渲染分离** 的架构模型。以下是为“第二层”开发者准备的模块说明：

## 🏗️ 模块职能
1. **`src/GeometryParser.js` (数据层)**
   - **职责**：作为数据契约的唯一解释器。
   - **扩展建议**：如果你需要支持 PLY、OBJ 或自定义的二进制格式（如 FlatBuffers），应在此处增加新的 `parseXXX` 方法。它必须返回标准的 `THREE.BufferGeometry`。

2. **`src/Viewer3D.js` (表现层)**
   - **职责**：封装所有 WebGL/Three.js 细节。
   - **扩展建议**：
     - 若要增加材质（如 Zebra Stripes），在 `constructor` 中定义新的 `THREE.ShaderMaterial`。
     - 若要增加诊断辅助物（如显示 Bounding Box），在此处增加对应的 `setXXX` 方法。

3. **`src/UIController.js` (交互层)**
   - **职责**：基于 Tweakpane 的轻量级 UI。
   - **扩展建议**：项目使用回调模式 (`callbacks`) 与主逻辑解耦。增加新的控制项时，只需在 `params` 中添加属性并在 `init` 中绑定。

4. **`src/main.js` (调度层)**
   - **职责**：生命周期管理、I/O 调度。
   - **扩展建议**：此处目前是静态 Fetch。若要改为实时监听 WebSocket，应修改 `loadData` 方法。

## 💡 开发哲学
- **Keep it Vanilla**：不要引入复杂的 UI 框架。对于工具软件，可靠性和启动速度高于一切。
- **Typed Arrays**：始终使用 `Float32Array` 处理顶点，以保证 GPU 传输性能。
- **Disposal**：在 `loadMesh` 时必须显式调用 `geometry.dispose()`，防止 C++ 算法频繁重绘导致的浏览器内存泄漏。
