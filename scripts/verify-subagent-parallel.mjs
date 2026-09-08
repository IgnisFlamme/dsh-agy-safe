// 真实 agy 集成验证（手动运行，不进 npm test）：
//   node scripts/verify-subagent-parallel.mjs [--model <id>] [--agy-path agy]
//
// 复现「子代理并发且轮次很长」的场景：两个不同 sessionId 的 adapter.stream()
// 同时发起，各自发一份带工具规则的长请求（会触发多轮工具/长思考）。
//
// 缺陷形态（0.1.7）：进程空闲计时器只在轮次边界重置，轮次超过 idleTimeoutMs
// 就被 dispose → finish 是插件侧 "process exited unexpectedly" 的 TRANSPORT 错误，
// 请求拿不到任何产出。
// 修复形态：每个事件都会重置空闲计时器，长轮次存活到 agy 自己的 --print-timeout
// 上限；两个并发会话真正重叠执行。
//
// 断言（无兜底文本，任一失败以非零退出码结束）：
//   1. 两个流都拿到终态 finish chunk；
//   2. 没有任何插件侧杀进程的错误（process exited / stream idle / spawn / stdin）；
//   3. 两条流的时间窗重叠（真并发）；
//   4. finish=stop 时必须有可见文本或工具调用产出。
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgyAdapter } from '../lib/adapter.js';
import { DEFAULT_CONFIG } from '../lib/config.js';
import { fetchAgyModelsOutput, parseAgyModelsOutput, groupBaseModels } from '../lib/models.js';

function parseArgs(argv) {
  const args = { agyPath: DEFAULT_CONFIG.agyPath };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model') args.model = argv[++i];
    else if (argv[i] === '--agy-path') args.agyPath = argv[++i];
    else throw new Error(`未知参数：${argv[i]}`);
  }
  return args;
}

async function pickDefaultModel(agyPath) {
  const bases = groupBaseModels(parseAgyModelsOutput(await fetchAgyModelsOutput(agyPath)));
  const candidate = bases.find((b) => /gemini/i.test(b.id) && b.efforts.length > 0);
  if (!candidate) throw new Error('agy models 中没有带档位的 gemini 模型，请用 --model 显式指定');
  return candidate.id;
}

function message(id, role, text) {
  return { id, role, content: [{ type: 'text', text }], source: { kind: 'model', provider: 'agy', model: 'x' } };
}

const SYSTEM_PROMPT = [
  'You are an AI agent powered by DeepSeek Harness.',
  'You are a read-only investigation engineer. Your working directory is the scratch directory; the project you investigate is E:\\AI\\dsh-agy-safe.',
  'Report findings with concrete file paths. Never modify files.',
  'Follow the tool-use rules exactly: act on the environment only through the tool-call text blocks described there.',
].join('\n');

const TOOLS = [
  {
    name: 'read',
    description: 'Read a file from the workspace and return its text content.',
    parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
  },
  {
    name: 'grep',
    description: 'Search file contents in the workspace with a regular expression.',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] },
  },
];

const TASK = [
  '逐个读取 E:\\AI\\dsh-agy-safe\\src 目录下的全部 TypeScript 源文件，并给出每个文件的路径与一句话职责说明。',
  '然后读取 E:\\AI\\dsh-agy-safe\\test 目录下的全部测试文件，说明每个测试文件覆盖了什么。',
  '最后给出一段结论：src 与 test 的模块对应关系是否完整。不要修改任何文件。',
].join('\n');

// 插件侧杀进程/故障的 finish 文案特征：出现任意一条即判定修复未生效
const PLUGIN_SIDE_FAILURES = [
  'process exited unexpectedly',
  'stream idle timeout',
  'Failed to spawn',
  'Failed to write message',
  'Agy process error',
];

async function runOne(adapter, model, sessionId, label) {
  const started = Date.now();
  const chunks = [];
  let finish = null;
  try {
    for await (const chunk of adapter.stream({
      provider: 'agy',
      model,
      reasoningEffort: 'medium',
      sessionId,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: [message(`m-${label}`, 'user', TASK)],
    })) {
      chunks.push({ at: Date.now(), chunk });
      if (chunk.type === 'finish') finish = chunk.reason;
    }
  } catch (err) {
    finish = { kind: 'threw', failure: { message: err instanceof Error ? err.message : String(err) } };
  }
  const ended = Date.now();
  const text = chunks.filter((c) => c.chunk.type === 'text-delta').map((c) => c.chunk.text).join('');
  const toolCalls = chunks.filter((c) => c.chunk.type === 'tool-call-delta').length;
  console.log(`[verify] ${label} sessionId=${sessionId}`);
  console.log(`[verify] ${label} window: +${((started - t0) / 1000).toFixed(1)}s → +${((ended - t0) / 1000).toFixed(1)}s (span ${((ended - started) / 1000).toFixed(1)}s)`);
  console.log(`[verify] ${label} finish: ${JSON.stringify(finish)}`);
  console.log(`[verify] ${label} textLen=${text.length} toolCallDeltas=${toolCalls} chunks=${chunks.length}`);
  return { label, started, ended, finish, text, toolCalls };
}

let t0 = Date.now();

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const model = args.model ?? (await pickDefaultModel(args.agyPath));
  const scratchDir = join(homedir(), '.dsh', 'llm-agy', 'verify-scratch');
  mkdirSync(scratchDir, { recursive: true });

  // idleTimeoutMs 故意压到 20s：轮次只要超过 20s 就会暴露「轮次中途被杀」的缺陷。
  // turnTimeoutMs 给 60s，让 agy 自己的上限先于测试整体超时生效。
  const adapter = new AgyAdapter({
    ...DEFAULT_CONFIG,
    agyPath: args.agyPath,
    scratchDir,
    idleTimeoutMs: 20_000,
    streamIdleTimeoutMs: 120_000,
    turnTimeoutMs: 60_000,
  });

  t0 = Date.now();
  const stamp = Date.now();
  console.log(`[verify] model=${model} idleTimeoutMs=20000 turnTimeoutMs=60000`);

  let results;
  try {
    results = await Promise.all([
      runOne(adapter, model, `parallel-verify-a-${stamp}`, 'A'),
      runOne(adapter, model, `parallel-verify-b-${stamp}`, 'B'),
    ]);
  } finally {
    adapter.dispose();
  }

  const failures = [];
  for (const r of results) {
    if (!r.finish) {
      failures.push(`${r.label} 没有终态 finish chunk`);
      continue;
    }
    const message = r.finish.failure?.message ?? '';
    for (const marker of PLUGIN_SIDE_FAILURES) {
      if (message.includes(marker)) {
        failures.push(`${r.label} finish 是插件侧故障（${marker}）：${message}`);
      }
    }
    if (r.finish.kind === 'stop' && r.text.length === 0 && r.toolCalls === 0) {
      failures.push(`${r.label} finish=stop 但没有任何文本或工具调用产出`);
    }
    if (r.finish.kind === 'threw') {
      failures.push(`${r.label} 迭代器抛错：${message}`);
    }
  }

  const [a, b] = results;
  const maxStart = Math.max(a.started, b.started);
  const minEnd = Math.min(a.ended, b.ended);
  if (!(maxStart < minEnd)) {
    failures.push(`两条流的时间窗不重叠（maxStart=${maxStart} minEnd=${minEnd}），未验证到并发`);
  }
  const spansOverIdle = results.some((r) => r.ended - r.started > 20_000);
  if (!spansOverIdle) {
    failures.push('两条流都短于 20s，未覆盖「轮次超过 idleTimeoutMs」的判别前提');
  }

  if (failures.length > 0) {
    console.error('[verify] FAIL');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('[verify] PASS：并发两路均存活到自身终态，无插件侧杀进程，时间窗重叠');
}

main().catch((err) => {
  console.error(`[verify] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
