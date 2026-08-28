# furcdn-cli

FurCDN 官方命令列工具。支援兩種鑑權方式，各自服務不同的端點群，CLI 內部依指令
自動決定要用哪一種，不需要使用者自己選：

- **API Key**（`furcdn config set-key`）：`/api/v1/**`（`furcdn domains` / `furcdn ssl`），
  適合唯讀清單 + 刷新快取 + 上傳憑證的自動化場景。
- **Session 登入**（`furcdn login`）：`/api/domains`、`/api/user/**`、`/api/admin/**` 等
  幾乎全部 dashboard 功能，對應 `furcdn domain` / `furcdn account` / `furcdn admin`。

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

## 登入（session 鑑權）

`furcdn domain` / `furcdn account` / `furcdn admin` 這三組指令需要先登入：

```bash
furcdn login                       # 互動輸入帳號密碼
furcdn login -u alice -p 'hunter2' # 或直接帶參數（注意 shell history）
furcdn whoami
furcdn logout
```

登入成功會把 `furcdn_token`（httpOnly session cookie 的值）存進
`~/.config/furcdn/session.json`（權限 `0600`，比照 SSH key / `gh auth login` 的做法），
之後這三組指令會自動帶上。也可以用 `FURCDN_SESSION_TOKEN` 環境變數覆蓋。

**已知限制：Cloudflare Turnstile。** 正式站 `www.furcdn.us` 的登入介面啟用了
Turnstile 人機驗證，登入 API 需要一個有效的 Turnstile token 才會放行。這個 token
只能透過瀏覽器渲染 Turnstile widget 並完成挑戰取得，CLI 在終端機裡**無法自動完成
這個步驟**——這是目前唯一沒有自動化掉的部分。`furcdn login --cf-token <token>`
留了帶入口，如果你有辦法透過瀏覽器手動取得 token（例如自架、關閉 Turnstile 的
測試環境，或未來取得瀏覽器輔助登入的授權 token）可以帶入；對正式站的日常使用，
建議改用 API Key（`furcdn config set-key`，不受 Turnstile 影響）。

## 指令

指令很多，這裡先列常用的幾支；完整清單見下方「指令總表」與 `furcdn <group> --help`。

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

## 指令總表

每一列是一個指令群組，執行 `furcdn <指令> --help` 看該群組下所有子指令與參數。
建立/更新類指令欄位很多時，統一用 `--data '<json>'` 或 `--data @file.json` 帶完整
body（欄位名稱已對照後端 `route.ts` 原始碼核對過），常用欄位另外提供對應 flag。

| 群組 | 鑑權 | 涵蓋內容 |
| --- | --- | --- |
| `furcdn login` / `logout` / `whoami` | — | session 登入生命週期 |
| `furcdn config` | — | 本機設定（API key / API base URL） |
| `furcdn health` | 無 | liveness 檢查 |
| `furcdn api <method> <path>` | 自動判斷 | 逃生艙口：對任何 route 送請求，見下方「涵蓋範圍」 |
| `furcdn domains` / `furcdn ssl` | API Key | v1 精簡版：list / purge / ssl upload |
| `furcdn info` | Session（`plans`/`origin-ips` 無需登入） | 叢集、公開方案、回源 IP 白名單、情報庫查詢、內建文檔 |
| `furcdn domain` | Session | 完整版網域管理：CRUD、`ssl`（request/status/upload/delete）、`cache-rules`、`waf`（含 `ip-check`）、`dns-check`、`logs` |
| `furcdn account` | Session | `balance`/`topup`/`redeem`/`discount-preview`、`change-password`/`change-email`/`settings`/`audit-log`、`notify`、`oauth`、`passkeys`（僅管理既有列表）、`api-keys`、`plan`（usage/history/auto-renew/buy/renew/upgrade）、`stats`、`alipay-verify`、`tickets` |
| `furcdn admin` | Session + admin 角色 | `users`（含 balance/grant/bulk-delete）、`domains`、`plans`、`clusters`、`discount-codes`、`codes`、`analytics-plans`、`origin-ips`、`failover`、`invites`（+ config）、`ech`（+ keys）、`nodes`（含 deploy/pause/resume/sync-dns/token/errors）、`tickets`、`email-domains`、`email-templates`（+ test）、`alipay-config`、`dns-config`、`templates`、`analytics-config`、`geo`、`audit-log`、`notify`、`stats`、`threat-ips`（+ refresh） |
| `furcdn mcp` | 依 tool 而定 | 見下方 MCP 章節 |

危險操作（刪除網域/使用者/passkey、批次刪除、餘額調整、改密碼等）一律要求
`--verify-code`（伺服器端的 email 二次驗證，先用 `furcdn account send-code` 索取）
和/或互動確認（可用 `-y/--yes` 在腳本中跳過）。

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

| Tool 名稱 | 說明 | 參數 | 鑑權 |
| --- | --- | --- | --- |
| `furcdn_domains_list` | 列出帳號下所有網域 | 無 | API Key |
| `furcdn_domains_purge` | 刷新指定網域快取 | `domain`（id 或網域名稱） | API Key |
| `furcdn_ssl_upload` | 上傳並啟用自訂 SSL 憑證 | `domain`、`cert`（PEM）、`key`（PEM） | API Key |
| `furcdn_domains_create` | 建立新網域（完整版） | `domain`、`clusterId`、`origin?`、`originType?` | Session（需先 `furcdn login`） |
| `furcdn_domains_update` | 更新網域簡單欄位 | `domain`、`fields`（key/value） | Session |
| `furcdn_domains_delete` | 刪除網域（不可逆） | `domain`、`verifyCode` | Session |
| `furcdn_health` | 檢查 API 存活狀態 | 無 | 無 |

MCP server 啟動時會分別檢查本機是否已設定 API key / 已登入 session，缺哪一種
只會影響對應的 tool，不會擋住其他 tool 或啟動流程本身。任何底層 API 錯誤都會
轉成 MCP tool 的 `isError` 回應（附錯誤訊息），不會讓 server process 中斷。

其餘 `furcdn admin` / `furcdn account` / `furcdn domain` 底下的指令目前**沒有**
包成 MCP tool（數量太大，見下方「涵蓋範圍」）；需要透過 MCP 呼叫時，可以請
MCP client 改用具備 shell 執行能力的方式直接呼叫 CLI 本身。

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

`app/api/**` 底下約 130 支 route，這支 CLI 的涵蓋策略：

- **有專屬子指令、欄位對照過原始碼**：`furcdn domains`/`furcdn ssl`（v1，API Key）、
  `furcdn info`、`furcdn domain`（完整版 CRUD、cache-rules、waf、ssl、dns-check、logs）、
  `furcdn account`（帳務、安全、通知、oauth、passkeys 列表/刪除、api-keys、plan、
  stats、alipay 實名認證、tickets）、`furcdn login`/`logout`/`whoami`。
- **有專屬子指令、body 走 `--data` JSON（不是逐欄位手刻 flag）**：`furcdn admin` 底下
  絕大部分資源。這些 route 欄位多且部分巢狀（例如 WAF 規則的 conditions），
  逐一刻成 flag 維護成本過高；`--data` 仍然對應正確的 method/path，只是輸入方式
  統一，伺服器端本來就會做完整驗證。
- **完全沒有專屬指令，但可用 `furcdn api <method> <path> --data <json>` 呼叫**：任何
  上面兩類沒覆蓋到的、或未來新增的 `/api/**` route。這支通用指令會依路徑前綴
  自動判斷該用 API Key 還是 session（可用 `--auth` 覆蓋），是刻意設計的逃生艙口，
  不是半途而廢的替代品。

**明確跳過、不會有 CLI 指令**（原因如下，非遺漏）：

- `app/api/auth/github/**`：OAuth redirect flow，本質上需要瀏覽器導向，CLI 無法模擬。
- `app/api/pay/payssion/notify`：支付平台的 webhook callback，只給 Payssion 打，不是給使用者呼叫的端點。
- `app/api/telegram/webhook`：Telegram Bot 的 webhook callback，同上。
- `app/api/acme/[token]`：ACME HTTP-01 challenge，CDN 節點對憑證機構用的內部協議。
- `app/api/node/**`（`binary`/`config`/`heartbeat`/`threat-ips`/`watch`）：這是
  `furcdn-node`（邊緣節點 agent）自己跟 master 對話的協議，鑑權是節點 token，不是
  使用者操作介面。
- `app/api/logo/[variant]`：純靜態資源。
- `app/api/analytics/enrich`：內部用途（分析數據豐富化管線），不是使用者操作端點。
- **Passkey 註冊 / 用 passkey 登入**：WebAuthn 的 attestation/assertion 挑戰需要瀏覽器
  + 平台 authenticator（Touch ID / Windows Hello / 安全金鑰）互動，CLI 環境做不到。
  已支援的是「管理既有 passkey」：`furcdn account passkeys list/delete`。

**已知限制（非設計選擇，是真的卡住）**：

- **`furcdn login` 在正式站需要手動取得 Turnstile token**（見上方「登入」章節）。
  這是目前唯一沒辦法完全自動化的核心流程；不影響 API Key 鑑權的指令。

**尚未做，但技術上可行、之後可以補**（TODO）：

- `furcdn mcp` 只包了 7 個最常用工具（v1 4 個 + 完整版網域 create/update/delete），
  `furcdn account`/`furcdn admin` 底下的指令尚未包成 MCP tool。
- `furcdn admin` 底下多數 create/update 走 `--data`，尚未像 `furcdn domain create`
  那樣為常用欄位補上個別 flag（例如 `furcdn admin plans create --name --price ...`）。
- `furcdn api` 目前只認 `key`/`session`/`none` 三種鑑權模式，若未來 API 出現第三種
  鑑權方式（例如 OAuth Bearer）需要另外擴充。

## 開發

```bash
npm run typecheck   # 型別檢查
npm run build       # 編譯到 dist/
npm test            # 跑單元測試（node:test，會先自動 build）
```

## License

MIT
