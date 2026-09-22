# wan

个人工具箱仓库，放一些自己用的小工具。

| 项目 | 说明 |
|---|---|
| [`freetoken-radar/`](freetoken-radar/) | **免费大模型额度雷达** —— 自动汇总国内大模型厂商的免费 Token 额度 |
| [`shopify-scout-cn/`](shopify-scout-cn/) | **选品侦探** —— Shopify 店铺侦察浏览器扩展（中文版） |

两个项目互不依赖，各自有独立的 README 和用法说明。

---

## freetoken-radar

从上游 [DaBinBinah/free-LLM](https://github.com/DaBinBinah/free-LLM)（MIT）拉取国内大模型厂商的**免费额度**信息，生成可读清单与结构化数据。

```bash
cd freetoken-radar
node sync.mjs
```

产出：

- `免费额度清单.md` —— 按免费类型分组的可读清单
- `data/offers.json` —— 结构化数据

**零依赖，不需要 `npm install`。运行成本 ¥0**（不调用任何大模型）。

关键点：上游是**人工维护**的，脚本会如实标注数据新鲜度（`fresh` / `aging` / `stale`），不粉饰。

详见 [`freetoken-radar/README.md`](freetoken-radar/README.md)。

---

## shopify-scout-cn

一键拆解任意 Shopify 店铺：主题、已装应用、追踪像素、销量排行榜、店铺变化。**完全离线运行，不向任何服务器发送数据。**

安装：`chrome://extensions` → 开发者模式 → 加载已解压的扩展 → 选 `shopify-scout-cn/shopify-scout-cn/`。

```bash
cd shopify-scout-cn/shopify-scout-cn
npm run check     # 自检 + 单元测试
```

目录：

| 路径 | 内容 |
|---|---|
| `shopify-scout-cn/` | 扩展本体（MV3，零构建） |
| `docs/` | 拆解报告、技术架构、上架材料 |
| `dist/` | 打包好的 zip |
| `store/` | 上架素材（截图、宣传图、隐私政策） |

详见 [`shopify-scout-cn/README.md`](shopify-scout-cn/README.md)。

---

## 说明

- 两个项目都不含任何 API Key、令牌或凭据。
- 各自的数据来源与许可见对应子目录的 README。