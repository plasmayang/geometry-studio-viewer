# Geometry Studio Web Viewer (v1.0) 🖥️

> 一个通用、高性能的几何数据可视化协议与渲染引擎。

## 🎯 项目定位
本项目是一个解耦的**几何可视化终端**。它不绑定于特定的几何内核，而是通过一套标准的 **JSON 几何契约**，为任何计算层（C++, Python, Rust 等）提供实时的 3D 呈现与调试能力。

## 🏗️ 典型三层架构
- **计算层 (The Kernel)**: 负责底层几何计算。
- **调度层 (The App Layer)**: 负责业务逻辑，并将几何对象转化为标准协议数据。
- **显示层 (This Project)**: 负责高性能渲染与交互调试。

## 📜 数据契约规格 (Data Specification v1.0)

本项目通过标准的 JSON 结构接收几何数据。所有数值应遵循右手坐标系（Right-handed system）。

### 1. 核心结构 (The Envelope)
| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `version` | String | 是 | 契约版本，当前为 `"1.0"` |
| `geometry` | Object | 是 | 几何数据主体 |

### 2. 网格定义 (geometry.mesh)
| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `vertices` | Array<Float> | 是 | **展平的坐标数组**：`[x1, y1, z1, x2, y2, z2, ...]`。长度必须是 3 的倍数。 |
| `normals` | Array<Float> | 否 | **展平的法线数组**：与顶点一一对应。若缺失，渲染器将自动计算。 |
| `indices` | Array<Int> | 是 | **面片索引数组**：三个一组定义一个三角形，如 `[0, 1, 2, 2, 3, 0]`。 |

### 3. NURBS 定义 (geometry.nurbs) - *Advanced*
支持原生参数化几何显示，包含控制网格与平滑曲线/曲面。

#### 3.1 NURBS 曲线 (curves)
| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `degree` | Integer | 曲线阶数（如 3 代表三次曲线）。 |
| `knots` | Array<Float> | 节点矢量，长度应为 `controlPoints.length / 3 + degree + 1`。 |
| `controlPoints` | Array<Float> | 展平的控制点坐标：`[x, y, z, (w), ...]`。支持 3D (x,y,z) 或 4D (x,y,z,w)。 |

#### 3.2 NURBS 曲面 (surfaces)
| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `degreeU/V` | Integer | U 和 V 方向的阶数。 |
| `knotsU/V` | Array<Float> | U 和 V 方向的节点矢量。 |
| `controlPoints` | Array<Float> | 展平的控制点网格。布局顺序应与 U/V 步长一致。 |

---

### 4. 调试标记 (geometry.debugMarkers)

### 示例 Python 构造逻辑：
```python
# 核心提示：始终使用一维展平数组以获得 GPU 最佳性能
payload = {
    "version": "1.0",
    "geometry": {
        "mesh": {
            "vertices": mesh.vertices.flatten().tolist(), # [x1, y1, z1, ...]
            "indices": mesh.faces.flatten().tolist()     # [v1, v2, v3, ...]
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
