# furcdn-cli

FurCDN 官方命令列工具。支援兩種鑑權方式，各自服務不同的端點群，CLI 內部依指令
自動決定要用哪一種，不需要使用者自己選：

- **Session 登入**（`furcdn login`，OAuth device flow）：`/api/domains`、`/api/user/**` 等
  一般帳號的 dashboard 功能，對應 `furcdn domain` / `furcdn account` / `furcdn pages`。
  **推薦的日常登入方式**——密碼只在瀏覽器輸入，終端機/shell history 完全看不到密碼。
- **API Key**（`furcdn config set-key`）：`/api/v1/**`（`furcdn domains` / `furcdn ssl` /
  `furcdn pages`），保留給舊版 v1 相容端點、CI 或第三方整合腳本使用。

> **管理後台（admin）操作不在這支 CLI 的範圍內，即使你的帳號是 admin 也一樣**——
> 這是刻意的設計決策，不是還沒做完。管理後台請直接用瀏覽器登入 dashboard。
> 詳見下方「為什麼沒有 admin 指令」。

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
   API base : https://cdn.taipei
   API key  : fck_xxxx…（已設定）
   設定檔   : /home/you/.config/furcdn/config.json
   ```

## 登入（OAuth device flow）

`furcdn domain` / `furcdn account` 這兩組指令需要先登入。CLI **不會**向你要密碼——
帳密只在瀏覽器裡輸入，走的是 [OAuth 2.0 Device Authorization Grant](https://datatracker.ietf.org/doc/html/rfc8628)
風格的流程：

```bash
$ furcdn login
請在瀏覽器開啟以下網址完成授權：
  https://cdn.taipei/oauth/device?user_code=ABCD-1234

或前往 https://cdn.taipei/oauth/device 手動輸入代碼：ABCD-1234

等待授權中...
...
已登入：alice（alice@example.com）

$ furcdn whoami
帳號：alice（alice@example.com）
角色：user

$ furcdn logout
已登出。
```

流程：`furcdn login` 先呼叫 `/api/oauth/device/code` 拿到 `user_code`，接著會嘗試
自動開啟瀏覽器（偵測不到 GUI 或桌面環境時靜默 fallback，網址一樣印在終端機上，
用 `--no-browser` 可以直接跳過嘗試）；瀏覽器裡登入並核准後，CLI 依伺服器指定的
`interval` 輪詢 `/api/oauth/device/token`，拿到 token 就存進
`~/.config/furcdn/session.json`（權限 `0600`，比照 SSH key / `gh auth login` 的做法）。
也可以用 `FURCDN_SESSION_TOKEN` 環境變數覆蓋。核准逾時（10 分鐘沒人操作）或在瀏覽器
按拒絕，CLI 會印出清楚的錯誤並中止，重新執行 `furcdn login` 即可。

`furcdn logout` 只清本機的 `session.json`——CLI 拿到的 token 存在本機檔案，不是
瀏覽器 cookie，伺服器端 `/api/auth/logout` 本質上只是清 HTTP response 的
`Set-Cookie` header，對「本機檔案」沒有實際作用，所以不必特地打這支 API。

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

### `furcdn pages`（靜態網站託管，內測）

把一個資料夾變成靜態網站：`https://<slug>.pages.furcdn.top`。目前為內測，
所有 Pages API 都要先兌換內測碼（未解鎖時回 `403 pages_beta_required`）。

```bash
furcdn pages beta redeem PGB-XXXX-XXXX-XXXX   # 解鎖（已解鎖者再兌換不會消耗碼）
furcdn pages beta status
furcdn pages list
furcdn pages create my-blog --production-branch main
furcdn pages deploy ./dist --site my-blog --branch main --message "first deploy"
furcdn pages deploy ./dist --site my-blog --create   # 站點不存在時一併建立
furcdn pages deployments my-blog
furcdn pages activate my-blog 12          # rollback / promote
furcdn pages rm-deployment my-blog 11     # 不能刪目前上線中的版本
furcdn pages delete my-blog
furcdn pages usage
```

鑑權自動選擇：有設定 API key（`FURCDN_API_KEY` 或 `furcdn config set-key`）就走
`/api/v1/pages`，否則用 `furcdn login` 的 session 走 `/api/pages`。所有讀取類
指令都支援 `--json`；`delete` 與 `rm-deployment` 會要求互動確認，腳本可用
`-y/--yes` 跳過。非互動環境（CI、stdin 被關閉）下沒有 `--yes` 會直接報錯
「非互動環境請加 --yes」，不會卡住等輸入。

`deploy` 會在本機先把資料夾打包成 tar.gz，並做與伺服器一致的預檢：根目錄必須有
`index.html`、解壓後總和 ≤ 20MB、檔案數 ≤ 2000、路徑 ≤ 255 字元；自動忽略
`.git`、`node_modules`、`.DS_Store`，也不會跟隨指到資料夾外面的符號連結。
分支等於站點的生產分支時會自動上線，其他分支只產生預覽網址
（`https://<slug>--<previewKey>.pages.furcdn.top`）。內容掃描判定需要人工審核時，
版本會停在 `held`，核准前不會上線；掃描原因會一併印出。Pages 流量併入套餐的
每月流量計算，超過額度或沒有有效套餐時站點會顯示「服務已停用」。

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
| `furcdn domain` | Session | 完整版網域管理：CRUD、`origin`（回源/SNI/Host override，主源站+備援，含源站擇優 `policy`/`probes`）、`tls`（force-https/http2/ech 一覽與切換）、`ssl`（request/status/upload/delete）、`cache-rules`、`waf`（含 `ip-check`）、`dns-check`、`logs` |
| `furcdn account` | Session | `balance`/`topup`/`redeem`/`discount-preview`、`change-password`/`change-email`/`settings`/`audit-log`、`notify`、`oauth`、`passkeys`（僅管理既有列表）、`api-keys`、`plan`（usage/history/auto-renew/buy/renew/upgrade）、`stats`、`alipay-verify`、`tickets` |
| `furcdn pages` | 自動（API Key 或 Session） | Pages 靜態託管：`list`/`create`/`deploy`/`deployments`/`activate`/`rm-deployment`/`delete`/`usage`/`beta redeem`/`beta status` |
| `furcdn mcp` | 依 tool 而定 | 見下方 MCP 章節 |

危險操作（刪除網域/passkey、改密碼等）一律要求 `--verify-code`（伺服器端的
email 二次驗證，先用 `furcdn account send-code` 索取）和/或互動確認
（可用 `-y/--yes` 在腳本中跳過）。

`furcdn domain` 底下 WAF/快取/回源/TLS 這四類設定各有明確命名的子指令，不需要
自己猜 JSON 欄位名：

| 設定類別 | 指令 |
| --- | --- |
| WAF | `furcdn domain waf list/create/update/delete/defaults/ip-check` |
| 快取規則 | `furcdn domain cache-rules list/create/update/delete/defaults` |
| 回源 / SNI | `furcdn domain origin list/set/remove` |
| 源站擇優 | `furcdn domain origin policy get/set`、`furcdn domain origin probes` |
| TLS / HTTP | `furcdn domain tls status/set`（force-https、http2、ech） |
| SSL 憑證 | `furcdn domain ssl request/status/upload/delete` |

`furcdn domain origin set` 預設取代主源站（陣列 index 0），加 `--backup` 則
附加一個備援；`furcdn domain origin remove --index <n>` 只能刪備援（index ≥1），
底層都是先讀現有 `origins` 陣列、本地修改後整批 `PUT` 回去，跟 dashboard 的
行為一致（OSS secret 等敏感欄位伺服器端會自動用 URL 比對還原，不會被清空）。

### 源站擇優（origin selection）

多源站時，可以讓**每個節點**從自己的網路位置對各源站做 ICMP/TCP/HTTP 探測，
再由節點本地挑出延遲最低的源站（不是 master 集中決定）。設定存在網域的
`originPolicy`，只要把 `strategy` 設成 `latency` 就會啟用擇優：

```bash
# 建立時直接指定
furcdn domain create --domain example.com --cluster-id 1 \
  --origin-strategy latency --probe-method icmp --switch-threshold 20

# 既有網域：只帶要改的欄位，伺服器會淺合併保留其餘設定
furcdn domain update example.com --origin-strategy latency --min-hold 60

# 等價寫法（--set 可用裸欄位名，也可加 originPolicy. 前綴）
furcdn domain origin policy set example.com --set strategy=latency --set retryStatuses=502,503

# 檢視生效中的完整設定（未自訂欄位標為「預設」）
furcdn domain origin policy get example.com
furcdn domain origin policy get example.com --json

# 重置為全部預設（送出 originPolicy: null）
furcdn domain origin policy set example.com --reset
```

每個源站另有權重/備用/探測目標等欄位，`origin set` 有對應旗標：

```bash
furcdn domain origin set example.com --url http://a.example --weight 3
furcdn domain origin set example.com --url http://b.example --backup --probe-host 1.2.3.4
furcdn domain origin set example.com --url http://c.example --latency-bias -50 --no-probe
furcdn domain origin list example.com          # 一併顯示 weight/backup/probe-host 等
```

查各節點最近的探測結果（RTT、丟包、該節點選中的源站）：

```bash
furcdn domain origin probes example.com
furcdn domain origin probes example.com --json
```

可用策略：`failover`（預設，依序失敗才切）、`latency`（擇優）、`round_robin`、
`weighted`（用 `origin.weight`）、`random`、`ip_hash`（`--hash-key client_ip|uri`）。
完整欄位、範圍、預設值與遲滯行為見官方文檔的「源站擇優」章節。

## 作為 MCP Server 使用

`furcdn mcp` 會以 stdio 啟動一個 [MCP](https://modelcontextprotocol.io) server，
把常用的網域操作包成 MCP tools（清單見下表）。鑑權沿用本機既有設定（`furcdn config set-key`
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
| `furcdn_domains_origin_policy_get` | 查詢源站擇優設定 | `domain` | Session |
| `furcdn_domains_origin_policy_set` | 設定源站擇優（只帶要改的欄位；`reset` 重置） | `domain`、`strategy?`、`probeMethod?`、`probeFallback?`、`probeIntervalSec?`、`probeTimeoutMs?`、`probeCount?`、`probePort?`、`probePath?`、`probeAlways?`、`scoreWindow?`、`lossPenaltyMs?`、`maxLatencyMs?`、`switchThresholdMs?`、`minHoldSec?`、`hashKey?`、`retryStatuses?`、`retryOnError?`、`maxAttempts?`、`reset?` | Session |
| `furcdn_domains_origin_probes` | 查詢各節點源站探測結果 | `domain` | Session |
| `furcdn_domains_origin_set` | 新增/設定單一源站（含權重/備用/探測欄位） | `domain`、`url`、`type?`、`sni?`、`hostOverride?`、`backup?`、`weight?`、`probeHost?`、`latencyBiasMs?`、`probeDisabled?` | Session |
| `furcdn_pages_list` | 列出 Pages 站點與用量 | 無 | API Key 或 Session（自動） |
| `furcdn_pages_create` | 建立 Pages 站點 | `slug`、`productionBranch?` | 同上 |
| `furcdn_pages_deploy` | 打包本機資料夾並部署 | `site`、`dir`、`branch?`、`message?`、`create?` | 同上 |
| `furcdn_pages_deployments` | 列出站點部署版本 | `site` | 同上 |
| `furcdn_pages_activate` | 切換上線版本 | `site`、`id` | 同上 |
| `furcdn_pages_delete` | 刪除站點（不可逆） | `site` | 同上 |
| `furcdn_pages_beta_redeem` | 兌換 Pages 內測碼 | `code` | 同上 |
| `furcdn_health` | 檢查 API 存活狀態 | 無 | 無 |

MCP server 啟動時會分別檢查本機是否已設定 API key / 已登入 session，缺哪一種
只會影響對應的 tool，不會擋住其他 tool 或啟動流程本身。任何底層 API 錯誤都會
轉成 MCP tool 的 `isError` 回應（附錯誤訊息），不會讓 server process 中斷。

其餘 `furcdn account` / `furcdn domain` 底下的指令目前**沒有**包成 MCP tool
（數量太大，見下方「涵蓋範圍」）；需要透過 MCP 呼叫時，可以請 MCP client 改用
具備 shell 執行能力的方式直接呼叫 CLI 本身。MCP tools 裡**沒有、也不會有**任何
管理後台操作，理由同下方「為什麼沒有 admin 指令」。

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

## 為什麼沒有 admin 指令

`furcdn-cli` **刻意不提供任何管理後台（admin）操作**，即使你的帳號是 admin 角色也
一樣。原因：

1. **設計決策，不是缺功能。** 管理後台涉及使用者資料、餘額調整、批次刪除等高風險
   操作，這類操作應該在瀏覽器裡以完整的 UI 上下文（確認對話框、審計介面、即時
   資料）進行，不適合塞進終端機腳本。
2. **伺服器端也這麼認為，而且是雙重防線。** `furcdn login`（OAuth device flow）核發
   的 token 會被標記 `src="cli"`；後端 `requireAdmin()` 看到這個標記一律直接拒絕，
   不管操作者的帳號角色是不是 admin。就算 CLI 這端出於某種 bug 送出了 admin 請求，
   伺服器也會擋下來——CLI 這邊的 `furcdn api /api/admin/...` 提前擋掉只是給更清楚
   的錯誤訊息，不是唯一的防線。
3. 需要管理後台功能時，請直接用瀏覽器登入 `https://cdn.taipei` 的 dashboard。

## 目前涵蓋範圍

`app/api/**` 底下約 130 支 route（不含 `/api/admin/**`，理由見上），這支 CLI 的
涵蓋策略：

- **有專屬子指令、欄位對照過原始碼**：`furcdn domains`/`furcdn ssl`（v1，API Key）、
  `furcdn info`、`furcdn domain`（完整版 CRUD、origin 與源站擇優 policy/probes、
  tls、cache-rules、waf、ssl、dns-check、logs）、`furcdn account`（帳務、安全、通知、oauth、passkeys
  列表/刪除、api-keys、plan、stats、alipay 實名認證、tickets）、
  `furcdn pages`（靜態網站部署、版本管理、用量與內測碼）、
  `furcdn login`/`logout`/`whoami`。
- **完全沒有專屬指令，但可用 `furcdn api <method> <path> --data <json>` 呼叫**：任何
  上面沒覆蓋到的、或未來新增的一般使用者 `/api/**` route（`/api/admin/**` 被明確
  擋掉，見上）。這支通用指令會依路徑前綴自動判斷該用 API Key 還是 session
  （可用 `--auth` 覆蓋），是刻意設計的逃生艙口，不是半途而廢的替代品。

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

**尚未做，但技術上可行、之後可以補**（TODO）：

- `furcdn mcp` 只包了 18 個最常用工具（v1 4 個 + 完整版網域 create/update/delete 與
  `origin_policy_get/set`、`origin_probes`、`origin_set` + Pages 7 個），
  `furcdn account` 底下的指令尚未包成 MCP tool（`furcdn admin` 不會有，見上）。
- `furcdn api` 目前只認 `key`/`session`/`none` 三種鑑權模式，若未來 API 出現第三種
  鑑權方式需要另外擴充；`/api/admin/**` 已在這支指令裡明確擋掉，不受此項影響。

## 開發

```bash
npm run typecheck   # 型別檢查
npm run build       # 編譯到 dist/
npm test            # 跑單元測試（node:test，會先自動 build）
```

## License

MIT
