// 對照 furcdn-master lib/origins.ts 的 OriginConfig（共享契約 §2）。
// 新欄位（weight/backup/probeHost/latencyBiasMs/probeDisabled）由 master 的
// validateOrigins 保留；CLI 這邊只負責組裝與顯示。

export type OriginType =
  | "http"
  | "aliyun_oss"
  | "aws_s3"
  | "tencent_cos"
  | "pages";

export interface OriginConfig {
  /** pages 源站的 url 由伺服器產生，輸入時只需要 pagesSite。 */
  url?: string;
  type: OriginType;
  /** pages 源站：站點 slug（送出時伺服器會正規化成 pagesSiteId）。 */
  pagesSite?: string;
  /** 伺服器回傳的 pages 源站站點 id。 */
  pagesSiteId?: number;
  sni?: string | null;
  hostOverride?: string | null;
  ossAccessKeyId?: string | null;
  ossAccessKeySecret?: string | null;
  /** weighted/round_robin 權重，1~1000，預設 1。 */
  weight?: number;
  /** true＝備用：只在所有非備用源站都不可用時才用。 */
  backup?: boolean;
  /** ICMP/TCP 探測目標，空＝用 URL host。 */
  probeHost?: string;
  /** 加到分數上的固定偏移（-1000~10000，負值＝偏好）。 */
  latencyBiasMs?: number;
  /** true＝不探測；latency 策略下排在有分數的源站之後。 */
  probeDisabled?: boolean;
}

export interface OriginSetInput {
  url?: string;
  type?: OriginType;
  pagesSite?: string;
  sni?: string;
  hostOverride?: string;
  backup?: boolean;
  weight?: number;
  probeHost?: string;
  latencyBiasMs?: number;
  probeDisabled?: boolean;
}

export function buildOriginConfig(input: OriginSetInput): OriginConfig {
  const isPages = input.type === "pages" || !!input.pagesSite;
  if (isPages && !input.pagesSite) {
    throw new Error("pages 源站需要 pagesSite（站點 slug）");
  }
  if (!isPages && !input.url) {
    throw new Error("非 pages 源站需要 url");
  }
  const next: OriginConfig = isPages
    ? { type: "pages", pagesSite: input.pagesSite }
    : { url: input.url, type: input.type ?? "http" };
  if (input.sni) next.sni = input.sni;
  if (input.hostOverride) next.hostOverride = input.hostOverride;
  if (input.backup) next.backup = true;
  if (input.weight !== undefined) next.weight = input.weight;
  if (input.probeHost) next.probeHost = input.probeHost;
  if (input.latencyBiasMs !== undefined) next.latencyBiasMs = input.latencyBiasMs;
  if (input.probeDisabled !== undefined) next.probeDisabled = input.probeDisabled;
  return next;
}

// append=true（--backup）附加為新備援；否則取代 index 0 主源站（既有行為）。
export function applyOriginSet(
  origins: OriginConfig[],
  next: OriginConfig,
  append: boolean,
): OriginConfig[] {
  const updated = [...origins];
  if (append) {
    updated.push(next);
  } else if (updated.length === 0) {
    updated.push(next);
  } else {
    updated[0] = next;
  }
  return updated;
}

export function renderOriginLine(o: OriginConfig, i: number): string {
  const flags: string[] = [];
  if (o.weight !== undefined && o.weight !== 1) flags.push(`weight=${o.weight}`);
  if (o.backup) flags.push("backup=true");
  if (o.probeHost) flags.push(`probe-host=${o.probeHost}`);
  if (o.latencyBiasMs !== undefined && o.latencyBiasMs !== 0) {
    flags.push(`latency-bias=${o.latencyBiasMs}`);
  }
  if (o.probeDisabled) flags.push("probe=off");
  // 伺服器回傳的 pages origin 會帶正規化後的 url（pages://<siteId>）；
  // 使用者剛輸入、還沒 PUT 的則只有 pagesSite（slug）。
  const label =
    o.type === "pages"
      ? (o.url ??
        (o.pagesSite
          ? `pages://${o.pagesSite}`
          : `pages://#${o.pagesSiteId ?? "?"}`))
      : (o.url ?? "");
  return (
    `[${i}]${i === 0 ? " (主源站)" : " (備援)"} ${label}  type=${o.type}` +
    (o.sni ? `  sni=${o.sni}` : "") +
    (o.hostOverride ? `  host=${o.hostOverride}` : "") +
    (flags.length ? `  ${flags.join("  ")}` : "")
  );
}
