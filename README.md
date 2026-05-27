# 深圳活动雷达

一个面向深圳本地活动、演出和公共文化线索的情报面板。

## 功能

- 聚合深圳音乐厅、深圳市文化广电旅游体育局、南山活动日历、深圳活动网等来源。
- 每条活动显示来源、时间、地点、分类、可信度和核验说明。
- 支持按本周、免费、官方来源、分类、区域和关键词筛选。
- GitHub Pages 静态站点读取 `public/data/events.json`。
- GitHub Actions 每小时抓取一次数据并部署 Pages。

## 本地运行

```bash
npm install
npm start
```

打开 `http://localhost:5178`。

## 生成静态数据

```bash
npm run build:data
```

生成结果位于 `public/data/events.json`。
