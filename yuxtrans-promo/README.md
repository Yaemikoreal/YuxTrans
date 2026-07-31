# YuxTrans Promo (Remotion)

基于 [Remotion 官方文档](https://www.remotion.dev/docs) 搭建的宣传片项目，服务 YuxTrans 浏览器扩展。

## 官方入口

- Fundamentals: https://www.remotion.dev/docs/the-fundamentals  
- Studio: https://www.remotion.dev/docs/cli/studio  
- Render: https://www.remotion.dev/docs/cli/render  

## 合成

| ID | 尺寸 | 时长 | 说明 |
|----|------|------|------|
| `YuxTransPromo` | 1920×1080 | 15s @ 30fps | 横屏主片 |
| `YuxTransPromoSquare` | 1080×1080 | 15s @ 30fps | 方屏裁切 |

时间轴：Logo 开场 → 三点主张 → 划词/Popup 截图 → 收尾 CTA。

静态资源在 `public/`（`logo.png`、样例截图）。

## 命令

```bash
cd yuxtrans-promo
npm i
npm run dev          # Remotion Studio 预览
npx remotion render YuxTransPromo out/yuxtrans-promo.mp4
```

预览默认打开 Studio；无头启动可用：

```bash
npx remotion studio --no-open
```

## 与主仓关系

- 独立 `package.json`，不干扰根目录扩展 `npm test`。
- 建议将 `yuxtrans-promo/node_modules`、`out/` 加入忽略（见根 `.gitignore`）。

## License

Remotion 对团队规模有许可要求，请阅读：https://www.remotion.dev/docs/license  
YuxTrans 本体仍为 MIT。
