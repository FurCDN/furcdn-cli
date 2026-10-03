import { ApiError } from "./http.js";
import { renderTable } from "./format.js";

// 源站擇優（origin selection）的 domain 級 originPolicy。
// 對照 furcdn-master 的 lib/originPolicy.ts（共享契約 §1）。
//
// CLI 這一層只做「使用者輸入 → 型別/範圍」的前置檢查，讓錯字或超範圍的參數
// 在送請求之前就有清楚的本機錯誤訊息；真正的權威驗證仍在伺服器
// （PUT /api/domains/{id} 會把 originPolicy 淺合併後整體驗證）。

export const ORIGIN_STRATEGIES = [
  "failover",
  "latency",
  "round_robin",
  "weighted",
  "random",
  "ip_hash",
] as const;
export type OriginStrategy = (typeof ORIGIN_STRATEGIES)[number];

export const PROBE_METHODS = ["icmp", "tcp", "http"] as const;
export type ProbeMethod = (typeof PROBE_METHODS)[number];

export const HASH_KEYS = ["client_ip", "uri"] as const;
export type HashKey = (typeof HASH_KEYS)[number];

export interface OriginPolicy {
  strategy: OriginStrategy;
  probeMethod: ProbeMethod;
  probeFallback: boolean;
  probeIntervalSec: number;
  probeTimeoutMs: number;
  probeCount: number;
  probePort: number | null;
  probePath: string;
  probeAlways: boolean;
  scoreWindow: number;
  lossPenaltyMs: number;
  maxLatencyMs: number;
  switchThresholdMs: number;
  minHoldSec: number;
  hashKey: HashKey;
  retryStatuses: number[];
  retryOnError: boolean;
  maxAttempts: number;
}

export const DEFAULT_ORIGIN_POLICY: OriginPolicy = {
  strategy: "failover",
  probeMethod: "icmp",
  probeFallback: true,
  probeIntervalSec: 15,
  probeTimeoutMs: 2000,
  probeCount: 3,
  probePort: null,
  probePath: "/",
  probeAlways: false,
  scoreWindow: 5,
  lossPenaltyMs: 1000,
  maxLatencyMs: 0,
  switchThresholdMs: 20,
  minHoldSec: 30,
  hashKey: "client_ip",
  retryStatuses: [],
  retryOnError: true,
  maxAttempts: 0,
};

export type OriginPolicyKey = keyof OriginPolicy;

type PolicySpec =
  | { kind: "int"; min: number; max: number }
  | { kind: "bool" }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "path" }
  | { kind: "port" }
  | { kind: "intList"; min: number; max: number; maxItems: number };

const POLICY_SPECS: Record<OriginPolicyKey, PolicySpec> = {
  strategy: { kind: "enum", values: ORIGIN_STRATEGIES },
  probeMethod: { kind: "enum", values: PROBE_METHODS },
  probeFallback: { kind: "bool" },
  probeIntervalSec: { kind: "int", min: 5, max: 3600 },
  probeTimeoutMs: { kind: "int", min: 200, max: 10000 },
  probeCount: { kind: "int", min: 1, max: 10 },
  probePort: { kind: "port" },
  probePath: { kind: "path" },
  probeAlways: { kind: "bool" },
  scoreWindow: { kind: "int", min: 1, max: 30 },
  lossPenaltyMs: { kind: "int", min: 0, max: 5000 },
  maxLatencyMs: { kind: "int", min: 0, max: 30000 },
  switchThresholdMs: { kind: "int", min: 0, max: 5000 },
  minHoldSec: { kind: "int", min: 0, max: 3600 },
  hashKey: { kind: "enum", values: HASH_KEYS },
  retryStatuses: { kind: "intList", min: 400, max: 599, maxItems: 20 },
  retryOnError: { kind: "bool" },
  maxAttempts: { kind: "int", min: 0, max: 10 },
};

// 表格顯示/--set 走訪順序＝介面宣告順序（與契約表一致）。
export const POLICY_KEYS = Object.keys(DEFAULT_ORIGIN_POLICY) as OriginPolicyKey[];

// 每個 policy 欄位對應的 CLI 旗標（commander 會把 --foo-bar 存成 opts.fooBar）。
export interface PolicyFlagSpec {
  flag: string;
  key: OriginPolicyKey;
  hint: string;
}

export const POLICY_FLAGS: PolicyFlagSpec[] = [
  {
    flag: "originStrategy",
    key: "strategy",
    hint: `選路策略：${ORIGIN_STRATEGIES.join("/")}，預設 failover`,
  },
  {
    flag: "probeMethod",
    key: "probeMethod",
    hint: `探測方式：${PROBE_METHODS.join("/")}，預設 icmp`,
  },
  { flag: "probeFallback", key: "probeFallback", hint: "ICMP 不可用時退回 tcp connect（預設開）" },
  { flag: "probeInterval", key: "probeIntervalSec", hint: "每輪探測間隔秒數（5~3600，預設 15）" },
  { flag: "probeTimeout", key: "probeTimeoutMs", hint: "單次探測逾時毫秒（200~10000，預設 2000）" },
  { flag: "probeCount", key: "probeCount", hint: "每輪探測包數（1~10，預設 3）" },
  { flag: "probePort", key: "probePort", hint: "tcp/http 探測埠（1~65535，預設依 URL scheme）" },
  { flag: "probePath", key: "probePath", hint: "http 探測路徑，需以 / 開頭（預設 /）" },
  { flag: "probeAlways", key: "probeAlways", hint: "非 latency 策略也持續探測並上報（預設關）" },
  { flag: "scoreWindow", key: "scoreWindow", hint: "分數取最近幾輪 RTT 平均（1~30，預設 5）" },
  { flag: "lossPenalty", key: "lossPenaltyMs", hint: "丟包懲罰毫秒，score += lossRate × 此值（0~5000，預設 1000）" },
  { flag: "maxLatency", key: "maxLatencyMs", hint: "分數高於此值排到最後（0~30000，0＝不啟用）" },
  { flag: "switchThreshold", key: "switchThresholdMs", hint: "遲滯：至少要好這麼多 ms 才切換（0~5000，預設 20）" },
  { flag: "minHold", key: "minHoldSec", hint: "切換後最短維持秒數（0~3600，預設 30）" },
  { flag: "hashKey", key: "hashKey", hint: `ip_hash 的雜湊鍵：${HASH_KEYS.join("/")}，預設 client_ip` },
  { flag: "retryStatus", key: "retryStatuses", hint: "觸發切源的狀態碼，逗號分隔（400~599；空字串＝所有 5xx）" },
  { flag: "retryOnError", key: "retryOnError", hint: "連線/逾時錯誤是否切源（預設開）" },
  { flag: "maxAttempts", key: "maxAttempts", hint: "單請求最多嘗試幾個源站（0~10，0＝不限）" },
];

function rangeText(min: number, max: number): string {
  return `${min}~${max}`;
}

function toNumber(key: string, raw: unknown, min: number, max: number): number {
  let n: number;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string" && raw.trim() !== "") n = Number(raw);
  else {
    throw new ApiError(
      0,
      `${key} 必須是 ${rangeText(min, max)} 的整數，收到：${JSON.stringify(raw)}`,
    );
  }
  if (!Number.isInteger(n)) {
    throw new ApiError(0, `${key} 必須是整數（${rangeText(min, max)}），收到：${raw}`);
  }
  if (n < min || n > max) {
    throw new ApiError(0, `${key} 必須介於 ${rangeText(min, max)}，收到：${n}`);
  }
  return n;
}

// 給 origin set 的 --weight / --latency-bias 等非 policy 數字欄位共用。
export function coerceInt(label: string, raw: unknown, min: number, max: number): number {
  return toNumber(label, raw, min, max);
}

function toBool(key: string, raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new ApiError(0, `${key} 必須是 true/false，收到：${String(raw)}`);
}

function toEnum(key: string, raw: unknown, values: readonly string[]): string {
  if (typeof raw !== "string" || !values.includes(raw)) {
    throw new ApiError(0, `${key} 只能是 ${values.join(" / ")}，收到：${String(raw)}`);
  }
  return raw;
}

function toStatusList(key: string, raw: unknown): number[] {
  let items: unknown[];
  if (Array.isArray(raw)) items = raw;
  else if (typeof raw === "number") items = [raw];
  else if (typeof raw === "string") {
    const trimmed = raw.trim();
    items = trimmed === "" ? [] : trimmed.split(",").map((s) => s.trim()).filter((s) => s !== "");
  } else {
    throw new ApiError(
      0,
      `${key} 必須是逗號分隔的狀態碼清單（400~599），收到：${JSON.stringify(raw)}`,
    );
  }
  if (items.length > 20) {
    throw new ApiError(0, `${key} 最多 20 個狀態碼（收到 ${items.length} 個）`);
  }
  return items.map((v) => toNumber(key, v, 400, 599));
}

// 把單一 policy 欄位的輸入（旗標字串 / --set 字串 / --data 的 JSON 值）轉成型別並檢查範圍。
export function coercePolicyValue(key: string, raw: unknown): unknown {
  const spec = POLICY_SPECS[key as OriginPolicyKey];
  if (!spec) {
    throw new ApiError(
      0,
      `originPolicy 沒有欄位「${key}」，可用欄位：${POLICY_KEYS.join(", ")}`,
    );
  }
  switch (spec.kind) {
    case "int":
      return toNumber(key, raw, spec.min, spec.max);
    case "bool":
      return toBool(key, raw);
    case "enum":
      return toEnum(key, raw, spec.values);
    case "port": {
      if (raw === null || raw === "" || raw === "null") return null;
      return toNumber(key, raw, 1, 65535);
    }
    case "path": {
      if (typeof raw !== "string" || !raw.startsWith("/")) {
        throw new ApiError(0, `probePath 必須是以 / 開頭的字串，收到：${String(raw)}`);
      }
      if (raw.length > 256) {
        throw new ApiError(0, `probePath 長度不可超過 256 字元（收到 ${raw.length}）`);
      }
      return raw;
    }
    case "intList":
      return toStatusList(key, raw);
  }
}

// 驗證一整個 policy 物件（--data / --set 進來的原始物件），每個 key 都做型別/範圍檢查。
export function coercePolicyObject(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = coercePolicyValue(key, value);
  }
  return out;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// commander 解析出的旗標 → originPolicy 部分物件（只帶使用者真的指定的欄位）。
export function buildOriginPolicyFromFlags(
  opts: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of POLICY_FLAGS) {
    const raw = opts[spec.flag];
    if (raw === undefined) continue;
    out[spec.key] = coercePolicyValue(spec.key, raw);
  }
  return out;
}

// `furcdn domain origin policy set --set strategy=latency` 用：
// 允許裸欄位名，也允許 originPolicy.<key> 前綴。
export function parsePolicySetArgs(sets: string[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of sets || []) {
    const idx = s.indexOf("=");
    if (idx < 0) throw new ApiError(0, `--set 格式錯誤，需要 key=value：${s}`);
    let key = s.slice(0, idx).trim();
    const raw = s.slice(idx + 1);
    if (key.startsWith("originPolicy.")) key = key.slice("originPolicy.".length);
    out[key] = coercePolicyValue(key, raw);
  }
  return out;
}

// 從 --data（可能是 { originPolicy: {...} } 或整個物件就是 policy）取出 policy 內容並驗證。
export function policyFromData(data: Record<string, unknown>): Record<string, unknown> {
  const inner = data.originPolicy;
  const source = isPlainObject(inner) ? inner : data;
  return coercePolicyObject(source);
}

export function formatPolicyValue(key: OriginPolicyKey, value: unknown): string {
  if (value === null || value === undefined) {
    return key === "probePort" ? "null（依 URL scheme）" : "null";
  }
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) {
    return value.length ? value.join(", ") : "（空＝所有 5xx）";
  }
  return String(value);
}

// 以表格顯示生效中的 policy；「來源」欄標出該欄位是網域自訂還是沿用預設。
export function renderPolicyTable(policy: Partial<OriginPolicy> | null | undefined): string {
  const stored: Record<string, unknown> = policy ? { ...policy } : {};
  const rows = POLICY_KEYS.map((key) => {
    const custom = Object.prototype.hasOwnProperty.call(stored, key) && stored[key] !== undefined;
    return {
      key,
      value: custom ? stored[key] : DEFAULT_ORIGIN_POLICY[key],
      source: custom ? "自訂" : "預設",
    };
  });
  return renderTable(rows, [
    { header: "欄位", value: (r) => r.key },
    { header: "值", value: (r) => formatPolicyValue(r.key, r.value) },
    { header: "來源", value: (r) => r.source },
  ]);
}

// ---- 節點探測結果（GET /api/domains/{id}/origin-probes）----

export interface OriginProbe {
  url: string;
  method: string;
  rttMs: number;
  lossPct: number;
  ok: boolean;
  selected: boolean;
  ts: number;
}

export interface OriginProbeNode {
  nodeId: number;
  nodeName: string;
  ts: number;
  origins: OriginProbe[];
}

export interface OriginProbesResponse {
  nodes: OriginProbeNode[];
}

// 每個節點 × 每個源站一列。節點還沒回報時給明確訊息，而不是冷冰冰的「(無資料)」。
export function renderOriginProbes(nodes: OriginProbeNode[] | undefined): string {
  const rows = (nodes || []).flatMap((node) =>
    (node.origins || []).map((probe) => ({ node, probe })),
  );
  if (rows.length === 0) return "(尚無探測資料：節點尚未回報，或該網域未啟用探測)";
  return renderTable(rows, [
    { header: "節點", value: (r) => `${r.node.nodeName} #${r.node.nodeId}` },
    { header: "源站", value: (r) => r.probe.url },
    { header: "方式", value: (r) => r.probe.method },
    { header: "RTT(ms)", value: (r) => r.probe.rttMs.toFixed(1) },
    { header: "丟包%", value: (r) => r.probe.lossPct.toFixed(1) },
    { header: "結果", value: (r) => (r.probe.ok ? "OK" : "失敗") },
    { header: "選中", value: (r) => (r.probe.selected ? "是" : "") },
    {
      header: "探測時間",
      value: (r) =>
        Number.isFinite(r.probe.ts) && r.probe.ts > 0
          ? new Date(r.probe.ts).toISOString()
          : "-",
    },
  ]);
}
