# Geometry Studio Web Viewer (v1.0) 🖥️

> 一个通用、高性能的几何数据可视化协议与渲染引擎。

## 🎯 项目定位
本项目是一个解耦的**几何可视化终端**。它不绑定于特定的几何内核，而是通过一套标准的 **JSON 几何契约**，为任何计算层（C++, Python, Rust 等）提供实时的 3D 呈现与调试能力。

## 🏗️ 典型三层架构
- **计算层 (The Kernel)**: 负责底层几何计算。
- **调度层 (The App Layer)**: 负责业务逻辑，并将几何对象转化为标准协议数据。
- **显示层 (This Project)**: 负责高性能渲染与交互调试。

## 🔗 数据契约 (Universal Contract)
任何能够输出以下格式的系统均可直接连接本项目：

```json
{
  "version": "1.0",
  "geometry": {
    "mesh": {
      "vertices": [...], // Flattened Float32 list
      "normals": [...],  // Flattened Float32 list
      "indices": [...]   // Integer list
    },
    "debugMarkers": {
      "points": [x1, y1, z1, ...], // 调试标记点
      "labels": ["Error A", ...]   // 标记说明
    }
  }
}
```

## 🚀 核心特性
- **协议驱动**：完全基于数据契约，实现计算与显示的彻底解耦。
- **明亮工作室美学**：内置专业灯光与网格系统，专为工程制图审美优化。
- **极速响应**：基于原生 WebGL/Three.js，支持大规模顶点数据的平滑缩放与旋转。
- **交互控制**：集成 Tweakpane，支持线框、法线、颜色及自定义参数的实时调节。

## 🛠️ 快速开始
```bash
npm install
npm run dev
```

---
**Geometry Studio**: Bringing visibility to abstract algorithms.
