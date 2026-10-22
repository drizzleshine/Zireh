import { observePayments } from "./audit.ts";
import { randomId, randomSalt } from "@zireh/crypto";
import { newCircuitTag, type Transport } from "@zireh/tor";
import { RelayCallError, type RelayClient } from "@zireh/inference";
import type { Ledger } from "@zireh/ledger";
import type { ChatModel } from "@zireh/llm";
import { redactText } from "@zireh/redact";
import { PrivacyLevel, Pseudonym, TopupQuote, type DaemonStatus } from "@zireh/schema";
import { Envelope, SyncClient, SyncError } from "@zireh/sync";
import { InsufficientFunds, type Wallet } from "@zireh/wallet";
import { z } from "zod";
import { runResearch, type ResearchEvent } from "./research.ts";

export interface DaemonDeps {
  readonly local: ChatModel;
  readonly relay: RelayClient;
  readonly ledger: Ledger;
  readonly wallet: Wallet;
  readonly transport: Transport;
  readonly syncUrl: string;
  readonly torState: () => { ready: boolean; progress: number };
  readonly localModelOk: () => Promise<boolean>;
  /** Origins allowed to call the API (the daemon's own UI and the Vite dev server). */
  readonly allowedOrigins: readonly string[];
  /** Bearer key for OpenAI-compatible clients (agents, editors) on this computer. */
  readonly localApiKey: string;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const ResearchBody = z.object({
  reviewBeforeSend: z.boolean().optional(),
  task: z.string().trim().min(3).max(4000),
  context: z.array(z.string().max(20_000)).max(20).default([]),
  level: PrivacyLevel,
  table: z.array(Pseudonym).max(500).default([]),
  salt: z.string().regex(/^[0-9a-f]{64}$/),
  model: z.string().optional(),
  caseId: z.string().regex(/^[0-9a-f]{32}$/).optional(),
});

/**
 * The daemon's localhost API. Only the user's own UI may call it: requests must carry the
 * `x-zireh` header (forcing a CORS preflight that foreign sites never pass), come from an
 * allowed Origin, and address the daemon by a loopback Host (blocks DNS rebinding).
 */
export function createDaemon(deps: DaemonDeps): (req: Request) => Promise<Response> {
  observePayments(deps.relay, deps.ledger);
  const activeRuns = new Map<string, AbortController>();
  const approvals = new Map<string, () => void>();
  const sync = () => new SyncClient(deps.syncUrl, deps.transport.fetchFor(newCircuitTag()));

  async function cloudModel(requested?: string): Promise<string> {
    const { prices } = await deps.relay.info();
    if (requested) {
      if (prices.some((p) => p.model === requested)) return requested;
      throw new Error(`unknown relay model: ${requested}`);
    }
    if (!prices[0]) throw new Error("the relay offers no models");
    return prices[0].model;
  }

  /**
   * OpenAI-compatible chat for local tools: the whole conversation goes through the privacy
   * pipeline and comes back as one assistant message. Level via `x-zireh-level` (default
   * standard). No case: the pseudonym table lives only for this request.
   */
  async function openAiChat(req: Request): Promise<Response> {
    const body = z
      .object({ model: z.string().optional(), messages: z.array(z.object({ role: z.string(), content: z.string() })).min(1), max_tokens: z.number().int().positive().max(4000).optional() })
      .parse(await req.json());
    const modelLevel = body.model?.startsWith("zireh/") ? PrivacyLevel.parse(body.model.slice(7)) : undefined;
    const header = req.headers.get("x-zireh-level");
    const headerLevel = header === null ? undefined : PrivacyLevel.parse(header);
    if (modelLevel && headerLevel && modelLevel !== headerLevel) return json(400, { error: { message: "model and privacy header disagree", type: "bad_request" } });
    const level = headerLevel ?? modelLevel ?? "standard";
    const last = body.messages.at(-1)!;
    const earlier = body.messages.slice(0, -1).map((m) => `${m.role}: ${m.content}`);
    const requested = modelLevel ? undefined : body.model;
    // Local mode never queries the relay, including for model discovery.
    if (requested && level === "local") return json(400, { error: { message: "use zireh/local for local inference", type: "bad_request" } });
    let model = deps.local.id;
    if (level !== "local") {
      const { prices } = await deps.relay.info();
      if (requested && !prices.some((p) => p.model === requested)) return json(400, { error: { message: "unknown model", type: "bad_request" } });
      model = await cloudModel(requested);
    }
    let answer = "";
    let error: string | undefined;
    await runResearch(deps, { task: last.content, context: earlier.length ? [earlier.join("\n")] : [], level, table: [], salt: randomSalt(), model, ...(body.max_tokens ? { maxTokens: body.max_tokens } : {}) }, (e) => {
      if (e.type === "done") answer = e.outcome.answer;
      if (e.type === "error") error = e.message;
    });
    if (error) return json(502, { error: { message: error, type: "zireh_error" } });
    return json(200, {
      id: `chatcmpl-${randomId()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: `zireh/${level}`,
      choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, // real costs are in the privacy log
    });
  }

  const routes: Record<string, (req: Request, url: URL) => Promise<Response>> = {
    "POST /v1/chat/completions": openAiChat,
    "GET /v1/models": async () =>
      json(200, { object: "list", data: PrivacyLevel.options.map((l) => ({ id: `zireh/${l}`, object: "model", owned_by: "zireh" })) }),

    "GET /api/status": async () => {
      let relay: DaemonStatus["relay"];
      try {
        const info = await deps.relay.info(true);
        relay = { ok: true, network: info.network, models: info.prices.map((p) => p.model), search: info.searchEnabled };
      } catch (err) {
        relay = { ok: false, models: [], error: (err as Error).message };
      }
      const status: DaemonStatus = {
        transport: deps.transport.kind,
        tor: deps.torState(),
        localModel: { id: deps.local.id, ok: await deps.localModelOk() },
        relay,
        balance: deps.wallet.balance,
        pendingCalls: deps.relay.pending.list().length,
      };
      return json(200, status);
    },

    "POST /api/wallet/quote": async (req) => {
      const { credits } = z.object({ credits: z.number().int().positive().max(100_000_000) }).parse(await req.json());
      return json(200, await deps.relay.quote(credits));
    },

    "POST /api/wallet/simulate-payment": async (req) => {
      const { quoteId } = z.object({ quoteId: z.string() }).parse(await req.json());
      await deps.relay.simulatePayment(quoteId);
      return json(200, { ok: true });
    },

    "POST /api/wallet/redeem": async (req) => {
      const quote = TopupQuote.parse(await req.json());
      return json(200, { balance: await deps.relay.redeemTopup(quote) });
    },

    "POST /api/wallet/recover": async () => {
      const { recovered, failed, topups } = await deps.relay.recover();
      return json(200, { recovered: recovered.length + topups, failed: failed.map((f) => f.message), balance: deps.wallet.balance });
    },

    "GET /api/receipts": async (_req, url) => {
      const caseId = url.searchParams.get("caseId") ?? undefined;
      const receipts = deps.ledger.receipts().filter((r) => !caseId || r.caseId === caseId);
      return json(200, { receipts, summary: deps.ledger.summary(caseId), disputes: deps.relay.pending.list().filter((call) => call.status === "disputed").map((call) => ({ requestId: call.requestId, reason: call.dispute })) });
    },

    /** Server-sent events: each pipeline stage as it happens, then the final answer. */
    "POST /api/research": async (req) => {
      const body = ResearchBody.parse(await req.json());
      const model = body.level === "local" ? deps.local.id : await cloudModel(body.model);
      const runId = randomId();
      const cancellation = new AbortController();
      const needsReview = body.reviewBeforeSend ?? body.level === "paranoid";
      let approve!: () => void;
      const approval = new Promise<void>((resolve) => { approve = resolve; });
      const cancel = () => cancellation.abort();
      req.signal.addEventListener("abort", cancel, { once: true });
      if (req.signal.aborted) cancel();
      activeRuns.set(runId, cancellation);
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          // Stop scheduling on disconnect; already submitted calls still settle safely.
          let open = true;
          const emit = (e: ResearchEvent) => {
            if (e.type === "prepared") approvals.set(runId, approve);
            if (!open) return;
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
            } catch {
              open = false;
              cancel();
            }
          };
          try {
            await runResearch(deps, { ...body, model, runId, signal: cancellation.signal, ...(needsReview ? { waitForApproval: () => approval } : {}) }, emit);
          } catch (err) {
            emit({ type: "error", message: (err as Error).message });
          } finally {
            activeRuns.delete(runId);
            approvals.delete(runId);
            req.signal.removeEventListener("abort", cancel);
            if (open) controller.close();
          }
        },
        cancel,
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
    },

    /** Find identifying values in texts with the local model, extending the case table. Nothing is sent. */
    "POST /api/redact": async (req) => {
      const body = z.object({ texts: z.array(z.string().max(20_000)).min(1).max(100), table: z.array(Pseudonym).default([]) }).parse(await req.json());
      let table = body.table;
      for (const text of body.texts) if (text.trim()) table = (await redactText(deps.local, text, table)).table;
      deps.ledger.record({ destination: "local", role: "real", payload: `Local redaction of ${body.texts.length} text(s) for publishing` });
      return json(200, { table });
    },

    "POST /api/search": async (req) => {
      const body = z.object({ query: z.string().trim().min(2).max(400), table: z.array(Pseudonym).default([]), caseId: z.string().regex(/^[0-9a-f]{32}$/).optional() }).parse(await req.json());
      const red = await redactText(deps.local, body.query, body.table);
      const call = await deps.relay.prepareSearch(red.text, 5, { role: "real", ...(body.caseId ? { caseId: body.caseId } : {}) });
      const circuit = newCircuitTag();
      const result = await deps.relay.send(call, circuit);
      if (result.kind !== "search") throw new Error("unexpected result kind");
      return json(200, { redactedQuery: red.text, hits: result.hits, table: red.table, charged: result.charged });
    },

    "POST /api/sync/push": async (req) => {
      const body = z.object({ caseId: z.string().regex(/^[0-9a-f]{32}$/), token: z.string(), records: z.array(Envelope).min(1).max(200) }).parse(await req.json());
      return json(200, await sync().push(body.caseId, body.token, body.records));
    },

    "POST /api/sync/pull": async (req) => {
      const body = z.object({ caseId: z.string().regex(/^[0-9a-f]{32}$/), token: z.string(), after: z.number().int().nonnegative() }).parse(await req.json());
      return json(200, await sync().pull(body.caseId, body.token, body.after));
    },
  };

  function guard(req: Request, url: URL): Response | undefined {
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(url.host)) return json(403, { error: "bad host" });
    if (url.pathname.startsWith("/v1/")) {
      // Local tools: bearer key only (browsers can't read the key, so pages can't use this route).
      return req.headers.get("authorization") === `Bearer ${deps.localApiKey}` ? undefined : json(401, { error: { message: "missing or wrong local API key", type: "auth" } });
    }
    if (req.headers.get("x-zireh") !== "1") return json(403, { error: "missing x-zireh header" });
    const origin = req.headers.get("origin");
    if (origin && !deps.allowedOrigins.includes(origin)) return json(403, { error: "origin not allowed" });
    return undefined;
  }

  return async (req) => {
    const url = new URL(req.url);
    const cancelMatch = req.method === "POST" && /^\/api\/research\/([0-9a-f]{32})\/cancel$/.exec(url.pathname);
    const sendMatch = req.method === "POST" && /^\/api\/research\/([0-9a-f]{32})\/send$/.exec(url.pathname);
    const route = sendMatch ? async () => {
      const approve = approvals.get(sendMatch[1]!);
      if (!approve) return json(409, { error: "This run is not waiting for review" });
      approvals.delete(sendMatch[1]!);
      approve();
      return json(200, { approved: true });
    } : cancelMatch ? async () => {
      const controller = activeRuns.get(cancelMatch[1]!);
      if (!controller) return json(404, { error: "unknown or completed run" });
      controller.abort();
      return json(200, { cancelled: true });
    } : routes[`${req.method} ${url.pathname}`];
    if (!route) return json(404, { error: "not found" });
    const denied = guard(req, url);
    if (denied) return denied;
    try {
      return await route(req, url);
    } catch (err) {
      if (err instanceof z.ZodError) return json(400, { error: "bad request", issues: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
      if (err instanceof SyncError) return json(err.status, { error: "sync", message: err.message }); // keep 403/404 meaningful
      if (err instanceof InsufficientFunds) return json(402, { error: "insufficient_funds", message: err.message });
      if (err instanceof RelayCallError) return json(err.code === "insufficient_funds" ? 402 : 502, { error: err.code, message: err.message });
      return json(500, { error: "internal", message: (err as Error).message.slice(0, 300) });
    }
  };
}
