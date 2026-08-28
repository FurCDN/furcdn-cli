# furcdn-cli

FurCDN 官方命令列工具。透過 [FurCDN](https://www.furcdn.us) dashboard 上建立的 API key，
在終端機管理你的網域快取與 SSL 憑證。

## 安裝

```bash
git clone https://github.com/FurCDN/furcdn-cli.git
cd furcdn-cli
npm install
npm run build
npm link   # 全域安裝 `furcdn` 指令；不想全域安裝可用 node dist/index.js 代替
```

## 快速開始

1. 到 FurCDN dashboard 的「API」頁面建立一把 API key（格式 `fck_...`）。
2. 設定 CLI：

   ```bash
   furcdn config set-key fck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

3. 驗證設定：

   ```bash
   $ furcdn config show
   API base : https://www.furcdn.us
   API key  : fck_xxxx…（已設定）
   設定檔   : /home/you/.config/furcdn/config.json
   ```

## 指令

### `furcdn domains list`

```bash
$ furcdn domains list
ID  網域                狀態
--  ------------------  ----
1   example.com         啟用
2   old.example.com     停用
```

加 `--json` 取得機器可讀輸出。

### `furcdn domains purge <id-or-name>`

清除該網域在所屬叢集所有節點的 L1+L2 快取（等同 dashboard「立即刷新緩存」）。

```bash
$ furcdn domains purge example.com
已對 example.com 發送清除快取：3/3 個節點成功。
```

有速率限制：同帳號 5 分鐘內最多 10 次，超過會回傳 429 並提示稍後再試。

### `furcdn ssl upload <id-or-name> --cert <path> --key <path>`

上傳自訂 SSL 憑證並啟用（會關閉該網域的自動續簽）。

```bash
$ furcdn ssl upload example.com --cert ./fullchain.pem --key ./privkey.pem
已為 example.com 上傳並啟用自訂 SSL 憑證。
```

### `furcdn health`

檢查目前 API base URL 是否存活（純 liveness，不代表 API 已就緒）。

```bash
$ furcdn health
OK: ok
```

### `furcdn config set-key <key>` / `furcdn config set-base-url <url>` / `furcdn config show`

管理本機設定（存於 `~/.config/furcdn/config.json`，權限 `0600`）。

也可以用環境變數覆蓋，優先於設定檔，方便 CI 或一次性使用：

```bash
FURCDN_API_KEY=fck_xxx FURCDN_API_BASE=https://staging.example.com furcdn domains list
```

## 目前涵蓋範圍

這個 CLI 目前只包裝 FurCDN **公開、以 API key 鑑權**的端點：

- `GET /api/v1/domains`
- `POST /api/v1/domains/{id}/purge`
- `POST /api/v1/domains/{id}/ssl`
- `GET /api/health`

Dashboard 上的其他功能（帳務、管理員後台、DNS、WAF 規則、工單系統等）目前只走
session cookie 鑑權，沒有對應的公開 API key 端點，因此**刻意不**在 CLI 裡用登入模擬
或爬蟲的方式去操作它們——那既不安全也不是這些端點的設計用途。等 `/api/v1/*`
擴充更多端點後，CLI 會補上對應子命令。

## 開發

```bash
npm run typecheck   # 型別檢查
npm run build       # 編譯到 dist/
npm test            # 跑單元測試（node:test，會先自動 build）
```

## License

MIT
