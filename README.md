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

## 作為 MCP Server 使用

`furcdn mcp` 會以 stdio 啟動一個 [MCP](https://modelcontextprotocol.io) server，
把上面四個操作包成 MCP tools。鑑權沿用本機既有設定（`furcdn config set-key`
或 `FURCDN_API_KEY` 環境變數）——MCP tool 的參數裡**不需要**、也不應該傳 API key。

先確保已經 `npm run build`（或已 `npm link`），再把它加進你的 MCP client 設定：

**Claude Code：**

```bash
claude mcp add furcdn -- furcdn mcp
# 或還沒 npm link 過，直接指到編譯產物：
claude mcp add furcdn -- node /path/to/furcdn-cli/dist/index.js mcp
```

**`.mcp.json` / Claude Desktop 設定：**

```json
{
  "mcpServers": {
    "furcdn": {
      "command": "furcdn",
      "args": ["mcp"]
    }
  }
}
```

提供的 tools：

| Tool 名稱 | 說明 | 參數 |
| --- | --- | --- |
| `furcdn_domains_list` | 列出帳號下所有網域 | 無 |
| `furcdn_domains_purge` | 刷新指定網域快取 | `domain`（id 或網域名稱） |
| `furcdn_ssl_upload` | 上傳並啟用自訂 SSL 憑證 | `domain`、`cert`（PEM）、`key`（PEM） |
| `furcdn_health` | 檢查 API 存活狀態 | 無 |

任何底層 API 錯誤都會轉成 MCP tool 的 `isError` 回應（附錯誤訊息），不會讓
server process 中斷。

## 作為 Claude Code Skill 使用

`skills/furcdn/SKILL.md` 是一份純文件型的 [Claude Code skill](https://docs.claude.com/claude-code)，
教 Claude 怎麼用這支 CLI 完成「列出網域／刷新快取／上傳 SSL」等常見任務，
不含額外程式碼。要在自己的專案啟用，把整個目錄複製或 symlink 進
`.claude/skills/furcdn`：

```bash
mkdir -p .claude/skills
ln -s /path/to/furcdn-cli/skills/furcdn .claude/skills/furcdn
# 或直接複製一份：
cp -r /path/to/furcdn-cli/skills/furcdn .claude/skills/furcdn
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
