# 自动采集点播源（多端订阅）

> 本分支由 GitHub Actions 自动生成，每天更新一次（北京时间 12:17 左右），请勿手动修改。

## 订阅地址

### LibreTV
设置 → 源管理 → 数据源订阅，粘贴：

```
https://raw.githubusercontent.com/zhimiann/myTV/source-list/source-list.latest.json
```

### FongMi TV / TVBox
设置 → 配置地址，粘贴：

```
https://raw.githubusercontent.com/zhimiann/myTV/source-list/tvbox.latest.json
```

### Selene-TV
设置 → 订阅地址，粘贴：

```
https://raw.githubusercontent.com/zhimiann/myTV/source-list/selene.latest.txt
```

## 文件说明

- `source-list.latest.json` — LibreTV 格式（探活通过、按耗时升序的 top-N 活源）
- `tvbox.latest.json` — TVBox/FongMi 格式（sites 直连 CMS 接口）
- `selene.latest.txt` — Selene-TV 格式（Base58 编码的 api_site/lives）
- `source-list.latest.report.json` — 完整探活报告（每个源的耗时、失败原因）
