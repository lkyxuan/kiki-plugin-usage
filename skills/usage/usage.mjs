#!/usr/bin/env node
// 用量宝的脚本：交给 ccusage（MIT，github.com/ryoppippi/ccusage）读本机各编程 agent 的会话记录，算 token 和钱。
// 它认识二十多个工具（Claude Code、Codex、OpenCode、Gemini CLI、Hermes、Grok、pi……），格式变了由它跟进。只用 Node 自带的东西。
//
//   node skills/usage/usage.mjs install          下载锁定版本的 ccusage 到 bin/（校验 sha512），打开后台读用量（Kiki 自带这个宝时后台程序自己会下载，一般不用跑）
//   node skills/usage/usage.mjs loop             后台程序（run.sh 调）：每分钟读今天、每 30 分钟读 30 天，写卡片，报最后活动时间
//   node skills/usage/usage.mjs once             马上读一次 30 天
//   node skills/usage/usage.mjs report [天数]     过去几天（默认 7，最多 30）按工具合计，给人看的一段话
//   node skills/usage/usage.mjs hide|show <工具>  某个工具不算进来 / 重新算
//   node skills/usage/usage.mjs off|on           关掉 / 打开后台读用量
//
// 规矩：
// - 只在本机读、不上传。数据都在 data/（导出宝不带）。
// - 读到的每段会话的最后活动时间报给 Kiki（POST /api/coders/touch），没装 hook 的工具也能在外部 Agent 面板里看出在不在干活。
// - 钱数按公开价格估算，订阅制（比如 Claude Max）不是真实账单。
import { createHash } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const CCUSAGE_VERSION = "20.0.48";
/** npm 上 @ccusage/ccusage-<平台> 这个版本的 sha512（dist.integrity），升级要一起改 */
export const CCUSAGE_SHA512 = {
  "darwin-arm64": "5nF3wIFO6IfJsVI3mc0/8iZtcfN8TEN4Dw1JyhToPQVBLVoaxbnBpNR16RWLQvS1yNcVVQfjeCDblmHe/Wt6/A==",
  "darwin-x64": "7P4dV2jPb3jyzfRncDyAyEnix50trmXYBnHxzhNzao69Rw4MEPGwlU5mkjwYX3/kTACQ5MDoomxHhFQ9Y8+Avg==",
  "linux-x64": "ThF2FNVmn8TnzTl94ns980AM2kcMUKBp0zS3LybXlPTV7qeIEhG5U9WbqrpuWvnSOOMM6fEV2Mw1dFoDRLyE9w==",
  "linux-arm64": "dSh53ih6BEZrHsk/Cywu7TEK2xF+NT266Dy+iarcqX/GF4/rhuNnukV4UZR+JgYZTbf1LGHGO8VDrELC//AP9w==",
};

/** ccusage 里的工具名 → 给人看的名字 */
export const AGENT_NAMES = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  amp: "Amp",
  droid: "Droid",
  codebuff: "Codebuff",
  hermes: "Hermes",
  pi: "pi",
  goose: "Goose",
  kilo: "Kilo",
  copilot: "Copilot CLI",
  gemini: "Gemini CLI",
  antigravity: "Antigravity",
  kimi: "Kimi",
  qwen: "Qwen Code",
  openclaw: "OpenClaw",
  grok: "Grok",
  zcode: "ZCode",
};
export const agentName = (a) => AGENT_NAMES[a] ?? a;
/** ccusage 的工具名 → Kiki 外部 Agent 面板的工具名（Claude Code 靠 hook 报，名字沿用） */
export const coderToolOf = (a) => (a === "claude" ? "claude-code" : a);

const HERE = dirname(fileURLToPath(import.meta.url));
const BAO = process.env.KIKI_BAO_DIR || resolve(HERE, "..", "..");
const DATA = join(BAO, "data");
const p = (...x) => join(DATA, ...x);
const BIN = () => process.env.CCUSAGE_BIN || join(BAO, "bin", "ccusage");
const kikiUrl = () => process.env.KIKI_URL || "http://127.0.0.1:4567";
const run = promisify(execFile);

const readJson = (f, d) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return d;
  }
};
const writeAtomic = (f, text) => {
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, f);
};

const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
const tokensOf = (r) => num(r?.totalTokens) || num(r?.inputTokens) + num(r?.outputTokens) + num(r?.cacheCreationTokens) + num(r?.cacheReadTokens);

/** 解析 `ccusage --sections daily,session --by-agent --json` 的输出。认不出来就抛错 */
export function parseReport(raw) {
  const j = JSON.parse(raw);
  if (!j || typeof j !== "object" || (!Array.isArray(j.daily) && !Array.isArray(j.session))) throw new Error("ccusage 输出里没有 daily / session");
  const days = (Array.isArray(j.daily) ? j.daily : [])
    .filter((d) => typeof d?.period === "string")
    .map((d) => ({
      date: d.period,
      tokens: tokensOf(d),
      cost: num(d.totalCost),
      agents: (Array.isArray(d.agents) ? d.agents : []).filter((a) => typeof a?.agent === "string").map((a) => ({ agent: a.agent, tokens: tokensOf(a), cost: num(a.totalCost) })),
    }));
  const sessions = (Array.isArray(j.session) ? j.session : [])
    .filter((s) => typeof s?.agent === "string" && typeof s?.period === "string")
    .map((s) => ({ agent: s.agent, id: s.period, tokens: tokensOf(s), cost: num(s.totalCost), last: typeof s.metadata?.lastActivity === "string" ? s.metadata.lastActivity : undefined }));
  return { days, sessions };
}

const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

/** 最近 days 天按工具合计（hidden 里的不算）。按本地日期分天，和 ccusage 一致 */
export function totals(state, days = 7, now = new Date()) {
  const from = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1))).replace(/^(\d{4})(\d{2})/, "$1-$2-");
  const hidden = state.hidden ?? [];
  const by = new Map();
  for (const d of state.days ?? [])
    if (d.date >= from)
      for (const a of d.agents) {
        if (hidden.includes(a.agent)) continue;
        const r = by.get(a.agent) ?? { agent: a.agent, tokens: 0, cost: 0 };
        r.tokens += a.tokens;
        r.cost += a.cost;
        by.set(a.agent, r);
      }
  const rows = [...by.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
  return { rows, tokens: rows.reduce((s, r) => s + r.tokens, 0), cost: rows.reduce((s, r) => s + r.cost, 0) };
}

export const fmtTokens = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)));
const money = (x) => `$${(x || 0).toFixed(2)}`;

/** 给人看的一段话 */
export function reportText(state, days = 7) {
  const t = totals(state, days);
  const head = `过去 ${days} 天外部 Agent 共用 ${fmtTokens(t.tokens)} token，约 ${money(t.cost)}（按公开价格估算，订阅制不是真实账单）。`;
  const rows = t.rows.map((r) => `- ${agentName(r.agent)}：${fmtTokens(r.tokens)} token，约 ${money(r.cost)}`);
  const hidden = state.hidden ?? [];
  const tail = [hidden.length ? `（已隐藏：${hidden.map(agentName).join("、")}）` : "", state.error ? `（${state.error}）` : "", state.updated ? `更新于 ${state.updated.slice(5, 16).replace("T", " ")}，ccusage ${CCUSAGE_VERSION}` : "还没读到过"].filter(Boolean);
  return [head, ...(rows.length ? rows : ["- 这段时间没有记录"]), ...tail].join("\n");
}

/** 总览卡片：大字今天，小字 7 天，下面最多 4 个工具（7 天） */
export function cardFor(state) {
  if (state.error && !state.updated) return { title: "外部 Agent 用量", value: "读不出来", sub: state.error, lines: [], tone: "err" };
  const today = totals(state, 1), week = totals(state, 7);
  return {
    title: "外部 Agent 用量",
    value: `今天 ${money(today.cost)}`,
    sub: `7 天约 ${money(week.cost)}，${fmtTokens(week.tokens)} token · 按公开价格估算${state.error ? ` · ${state.error}` : ""}`,
    lines: week.rows.slice(0, 4).map((r) => ({ label: agentName(r.agent), value: money(r.cost) })),
    ...(state.error ? { tone: "warn" } : {}),
  };
}

/** 读回来的合进旧的：quick 只换今天那天和这次读到的会话 */
export function merge(state, r, quick) {
  const s = { ...state };
  if (quick) {
    const today = r.days[0];
    if (today) s.days = [today, ...(s.days ?? []).filter((d) => d.date !== today.date)];
    const ids = new Set(r.sessions.map((x) => `${x.agent}:${x.id}`));
    s.sessions = [...r.sessions, ...(s.sessions ?? []).filter((x) => !ids.has(`${x.agent}:${x.id}`))];
  } else {
    s.days = r.days;
    s.sessions = r.sessions;
  }
  s.days = [...s.days].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30);
  s.sessions = [...s.sessions].sort((a, b) => String(b.last ?? "").localeCompare(String(a.last ?? ""))).slice(0, 300);
  return s;
}

/** 给 Kiki 设置「用量」页看的：今天、7 天、30 天合计，7 天按工具（名字已换成给人看的） */
export function summaryFor(state, now = new Date()) {
  const sum = (days) => {
    const t = totals(state, days, now);
    return { tokens: t.tokens, cost: t.cost, rows: t.rows.map((r) => ({ agent: r.agent, name: agentName(r.agent), tokens: r.tokens, cost: r.cost })) };
  };
  return { version: CCUSAGE_VERSION, updated: state.updated ?? null, error: state.error ?? null, hidden: (state.hidden ?? []).map(agentName), today: sum(1), week: sum(7), month: sum(30) };
}

const load = () => ({ days: [], sessions: [], hidden: [], ...readJson(p("usage.json"), {}) });
function save(state) {
  writeAtomic(p("usage.json"), JSON.stringify(state) + "\n");
  writeAtomic(p("card.json"), JSON.stringify({ ...cardFor(state), at: new Date().toISOString() }) + "\n");
  writeAtomic(p("summary.json"), JSON.stringify(summaryFor(state)) + "\n");
}

/** 跑一次 ccusage：quick 只读今天，否则 30 天 */
async function readOnce(quick) {
  const d = new Date();
  const since = ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (quick ? 0 : 29)));
  const { stdout } = await run(BIN(), ["--sections", "daily,session", "--by-agent", "--json", "--since", since], { timeout: 120_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } });
  return parseReport(stdout);
}

/** 读一次，存下来，把这次读到的会话的最后活动时间报给 Kiki */
export async function refresh(quick = false) {
  let state;
  try {
    const r = await readOnce(quick);
    // ccusage 跑完才读旧数据：等它的这段时间里 hide / show 改过的隐藏名单不能被盖回去（读和写之间全是同步代码，没有空档）
    state = merge(load(), r, quick);
    state.updated = new Date().toISOString();
    delete state.error;
    save(state);
    const rows = r.sessions.filter((s) => s.last && !state.hidden.includes(s.agent)).map((s) => ({ tool: coderToolOf(s.agent), session: s.id, name: agentName(s.agent), last: s.last }));
    if (rows.length) await fetch(`${kikiUrl()}/api/coders/touch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rows }) }).catch(() => {});
  } catch (e) {
    state = load();
    state.error = `读用量失败：${String(e?.message ?? e).split("\n")[0].slice(0, 120)}`;
    save(state);
  }
  return state;
}

async function service(action) {
  try {
    await fetch(`${kikiUrl()}/api/bao/services`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: basename(BAO), service: "usage", action }) });
  } catch {} // Kiki 每 30 秒也会自己看一眼
}

/** 下载锁定版本的 ccusage 到 bin/ccusage（校验 sha512），已经有就不下 */
async function ensureBin() {
  if (existsSync(BIN())) return;
  const plat = `${process.platform}-${process.arch}`;
  const want = CCUSAGE_SHA512[plat];
  if (!want) throw new Error(`这个平台（${plat}）没有 ccusage`);
  const url = `https://registry.npmjs.org/@ccusage/ccusage-${plat}/-/ccusage-${plat}-${CCUSAGE_VERSION}.tgz`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`下载失败：HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const sum = createHash("sha512").update(buf).digest("base64");
  if (sum !== want) throw new Error("下载的文件校验不对，没装");
  const tmp = join(BAO, "bin", ".tmp");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  writeFileSync(join(tmp, "a.tgz"), buf);
  const t = spawnSync("tar", ["xzf", "a.tgz"], { cwd: tmp });
  if (t.status !== 0) throw new Error(`解压失败：${t.stderr}`);
  const exe = join(tmp, "package", "bin", "ccusage");
  if (!existsSync(exe)) throw new Error("压缩包里没找到 ccusage");
  chmodSync(exe, 0o755);
  renameSync(exe, join(BAO, "bin", "ccusage"));
  rmSync(tmp, { recursive: true, force: true });
}

async function install() {
  await ensureBin();
  try {
    chmodSync(join(HERE, "run.sh"), 0o755); // .bao 导入不带执行权限；有了执行权限 Kiki 才会开后台程序
  } catch {}
  await refresh();
  await service("start");
  console.log(`装好了：ccusage ${CCUSAGE_VERSION}，后台每分钟读一次。\n\n${reportText(load())}`);
}

/** 后台程序：没有 ccusage 先下载（Kiki 自带这个宝，装好就开），然后每分钟读今天，每 30 分钟读 30 天 */
async function loop() {
  let n = 0;
  const tick = async () => {
    if (!existsSync(BIN())) {
      try {
        await ensureBin();
      } catch (e) {
        const state = load();
        state.error = `下载 ccusage 失败：${String(e?.message ?? e).slice(0, 100)}，过一分钟再试`;
        save(state);
        return;
      }
      return refresh();
    }
    return refresh(n++ % 30 !== 0);
  };
  await tick();
  setInterval(() => void tick(), 60_000);
}

function setHidden(agent, hide) {
  const a = String(agent ?? "").trim().toLowerCase();
  const key = Object.keys(AGENT_NAMES).find((k) => k === a || AGENT_NAMES[k].toLowerCase() === a) ?? a;
  if (!key) throw new Error("要写工具名");
  const state = load();
  const h = new Set(state.hidden);
  if (hide) h.add(key);
  else h.delete(key);
  state.hidden = [...h];
  save(state);
  console.log(`${agentName(key)} ${hide ? "不再算进用量" : "重新算进用量"}了。`);
}

async function main(argv) {
  const [cmd, a] = argv;
  if (cmd === "install") return install();
  if (cmd === "loop") return loop();
  if (cmd === "once") return console.log(reportText(await refresh()));
  if (cmd === "report") return console.log(reportText(load(), Math.min(Math.max(Number(a) || 7, 1), 30)));
  if (cmd === "hide" || cmd === "show") return setHidden(a, cmd === "hide");
  if (cmd === "off") return service("stop").then(() => console.log("关掉了，不再读各工具的会话记录。"));
  if (cmd === "on") return service("start").then(() => console.log("打开了，后台每分钟读一次。"));
  throw new Error("用法：install | loop | once | report [天数] | hide <工具> | show <工具> | off | on");
}

// Mac 的 /var 是 /private/var 的软链接，import.meta.url 是解开后的真路径，两边都解开再比
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
