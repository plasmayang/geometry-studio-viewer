# App Layer Integration Guide

本项目被设计为通用几何算法框架的“显示外设”。以下是调度层（如 Python 应用）如何与本可视化端集成的建议。

## 1. 数据序列化示例

如果你的应用侧使用的是 NumPy 来管理计算数据，可以使用以下方式导出符合协议的 JSON：

```python
import json
import numpy as np

def export_to_viewer(vertices, normals, indices):
    data = {
        "version": "1.0",
        "geometry": {
            "mesh": {
                "vertices": vertices.flatten().tolist(),
                "normals": normals.flatten().tolist(),
                "indices": indices.flatten().tolist()
            }
        }
    }
    with open("src/mock/rbo_test_case.json", "w") as f:
        json.dump(data, f)
```

## 2. 通信方案建议

### A. 基于文件系统的热重载 (低耦合)
Python 层将结果写入 `src/mock/rbo_test_case.json`。
用户在可视化界面点击 **"Reload Mock Data"**。这是目前 V1.0 支持的最快验证方式。

### B. 基于 Fast API 的实时推送 (动态)
第二层 Python 应用可以使用 FastAPI 启动一个简单的 API 服务，本可视化端通过 AJAX 轮询或 WebSocket 实时获取几何体的最新状态。

## 3. 常见问题 (Tier 2 调试)

- **坐标系转换**：本项目默认采用 Three.js 的右手坐标系（Y 轴向上）。如果 C++ 内核使用的是 Z 轴向上，请在 Python 侧进行坐标交换或在 `Viewer3D.js` 中设置 `grid.rotation`。
- **性能建议**：对于超过 100,000 个面片的大模型，建议 Python 侧在导出 JSON 时进行面片简化，或改用本项目预留的二进制加载接口。
