import { canonicalJson, sha256Hex } from "@zireh/crypto";
import type { ChatModel } from "@zireh/llm";
import {
  ChatPaidRequest,
  MintRequest,
  SearchPaidRequest,
  TopupQuoteRequest,
  type ModelPrice,
  type RelayError,
  type RelayInfo,
  type SearchHit,
  type Settlement,
} from "@zireh/schema";
import { actualCost, blankOutputCount, maxCost, MintError, sum, type Mint } from "@zireh/wallet";
import type { PaymentWatcher, SimulatedWatcher } from "@zireh/zcash";
import { z } from "zod";

export type SearchFn = (query: string, maxResults: number) => Promise<SearchHit[]>;

/** Stored responses by requestId, so a re-sent call returns the same result and never pays twice. */
export interface ResponseStore {
  get(requestId: string): StoredResponse | undefined;
  put(requestId: string, response: StoredResponse): void;
  acknowledge(requestId: string): void;
}
export interface StoredResponse {
  readonly status: number;
  readonly body: unknown;
}

/** Remove answer material while keeping the financial recovery response. */
export function settlementOnly(response: StoredResponse): StoredResponse | undefined {
  if (response.status === 0) return response;
  if ((response.body as { outputsHash?: string })?.outputsHash) return response;
  const body = response.body as Record<string, unknown>;
  if (!body || typeof body !== "object" || !body.settlement) return undefined;
  return { status: response.status, body: {
    settlement: body.settlement,
    answerExpired: true,
    ...(typeof body.model === "string" ? { model: body.model, content: "" } : {}),
    ...(Array.isArray(body.hits) ? { hits: [] } : {}),
    ...(body.error ? { error: body.error, message: "Answer expired; settlement is retained" } : {}),
  } };
}

export function memoryResponseStore(ttlMs = 15 * 60 * 1000, now: () => number = Date.now): ResponseStore {
  const items = new Map<string, { at: number; response: StoredResponse }>();
  return {
    get(id) {
      const hit = items.get(id);
      if (!hit) return undefined;
      if (now() - hit.at > ttlMs) {
        const financial = settlementOnly(hit.response);
        if (!financial) { items.delete(id); return undefined; }
        hit.response = financial;
      }
      return hit.response;
    },
    put(id, response) { items.set(id, { at: now(), response }); },
    acknowledge(id) {
      const hit = items.get(id);
      if (hit) hit.response = settlementOnly(hit.response) ?? hit.response;
    },
  };
}

export interface RelayAdmission {
  readonly quoteLimit: number;
  quote(credits: number): boolean;
  call(maximumCredits: number): boolean;
}
export interface RelayDeps {
  readonly admission?: RelayAdmission;
  readonly mint: Mint;
  readonly watcher: PaymentWatcher;
  readonly models: ReadonlyMap<string, { readonly upstream: ChatModel; readonly price: ModelPrice }>;
  readonly search?: SearchFn;
  readonly searchPrice: number;
  readonly responses: ResponseStore;
  /** Aggregate counters only. The relay never logs prompts, answers or coins. */
  readonly onEvent?: (event: "chat" | "search" | "topup" | "refund", credits: number) => void;
}

/** Response-store marker: coins burned, no reply yet. Never sent to clients as a status. */
const REDEEMED = 0;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const fail = (status: number, error: RelayError["error"], message: string, settlement?: Settlement) =>
  json(status, settlement ? { error, message, settlement } : { error, message });

async function parse<S extends z.ZodType>(req: Request, schema: S): Promise<z.infer<S> | Response> {
  const body: unknown = await req.json().catch(() => undefined);
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : fail(400, "bad_request", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
}

/**
 * The relay as a fetch-style handler: verifies coins, calls upstream, returns change.
 * It holds the Token Factory key; clients only ever reach it over Tor.
 */
export function createRelay(deps: RelayDeps): (req: Request) => Promise<Response> {
  const inFlight = new Map<string, Promise<StoredResponse>>();

  function resume(requestId: string, blanks: z.infer<typeof ChatPaidRequest>["changeOutputs"]): Response | Promise<Response> | undefined {
    // A retry while the first attempt is still running in this process waits for it.
    const running = inFlight.get(requestId);
    if (running) {
      return running.then((r) => json(r.status, r.body));
    }
    const stored = deps.responses.get(requestId);
    if (stored && stored.status !== REDEEMED) return json(stored.status, stored.body);
    if (stored) {
      // Coins were burned but the relay stopped before answering (crash). Refund in full,
      // using the blank outputs this retry carries, and remember the refund.
      const refunded = (stored.body as { redeemed: number }).redeemed;
      const settlement: Settlement = { requestId, charged: 0, usage: { prompt_tokens: 0, completion_tokens: 0 }, change: deps.mint.change(blanks, refunded) };
      const response = { status: 502, body: { error: "upstream_error", message: "the relay restarted before answering; refunded", settlement } };
      deps.responses.put(requestId, response);
      deps.onEvent?.("refund", refunded);
      return json(response.status, response.body);
    }
    return undefined;
  }

  /**
   * Shared settlement path for every paid call: idempotency, hold check, burn, upstream, change.
   * The requestId acts as a bearer secret for its own result: it is 128 random bits, chosen by
   * the client and only ever sent to the relay inside Tor.
   */
  async function paid(
    requestId: string,
    proofs: z.infer<typeof ChatPaidRequest>["proofs"],
    blanks: z.infer<typeof ChatPaidRequest>["changeOutputs"],
    hold: number,
    work: () => Promise<{ body: Record<string, unknown>; cost: number; usage: Settlement["usage"] }>,
    kind: "chat" | "search",
  ): Promise<Response> {
    const replay = resume(requestId, blanks);
    if (replay) return replay;
    const paidAmount = sum(proofs);
    if (paidAmount < hold) return fail(402, "insufficient_funds", `this call needs ${hold} credits, got ${paidAmount}`);
    if (blanks.length < blankOutputCount(paidAmount)) return fail(400, "bad_request", "not enough blank outputs for change");

    const task = (async (): Promise<StoredResponse> => {
      if (deps.admission && !deps.admission.call(hold)) return { status: 429, body: { error: "limit_exceeded", message: "Daily demo provider budget exhausted; no coins were spent" } };
      try {
        deps.mint.redeem(proofs, () => deps.responses.put(requestId, { status: REDEEMED, body: { redeemed: paidAmount } }));
      } catch (err) {
        if (err instanceof MintError) {
          const code = err.code === "bad_request" ? "bad_request" : err.code;
          return { status: 400, body: { error: code, message: err.message } }; // nothing burned; not stored
        }
        throw err;
      }
      let result: Awaited<ReturnType<typeof work>>;
      try {
        result = await work();
      } catch (err) {
        const refund: Settlement = { requestId, charged: 0, usage: { prompt_tokens: 0, completion_tokens: 0 }, change: deps.mint.change(blanks, paidAmount) };
        deps.onEvent?.("refund", paidAmount);
        const response = { status: 502, body: { error: "upstream_error", message: (err as Error).message.slice(0, 200), settlement: refund } };
        deps.responses.put(requestId, response);
        return response;
      }
      const charged = Math.min(result.cost, paidAmount);
      const settlement: Settlement = { requestId, charged, usage: result.usage, change: deps.mint.change(blanks, paidAmount - charged) };
      deps.onEvent?.(kind, charged);
      const response = { status: 200, body: { ...result.body, settlement } };
      deps.responses.put(requestId, response);
      return response;
    })();

    inFlight.set(requestId, task);
    try {
      const r = await task;
      return json(r.status, r.body);
    } finally {
      inFlight.delete(requestId);
    }
  }

  const routes: Record<string, (req: Request, url: URL) => Promise<Response>> = {
    "POST /v1/settlement/ack": async (req) => {
      const body = await parse(req, z.object({ requestId: z.string().regex(/^[0-9a-f]{32}$/) }));
      if (body instanceof Response) return body;
      deps.responses.acknowledge(body.requestId);
      return json(200, { ok: true });
    },
    "GET /v1/info": async () => {
      const info: RelayInfo = {
        keyset: deps.mint.keyset,
        prices: [...deps.models.values()].map((m) => m.price),
        searchPrice: deps.searchPrice,
        searchEnabled: deps.search !== undefined,
        network: deps.watcher.network,
      };
      return json(200, info);
    },

    "POST /v1/topup/quote": async (req) => {
      const body = await parse(req, TopupQuoteRequest);
      if (body instanceof Response) return body;
      if (deps.admission && (body.credits > deps.admission.quoteLimit || !deps.admission.quote(body.credits))) return fail(429, "limit_exceeded", `Demo top-ups are limited to ${deps.admission.quoteLimit} credits per quote and a shared daily budget`);
      return json(200, deps.watcher.quote(body.credits));
    },

    "GET /v1/topup/state": async (_req, url) => {
      try {
        return json(200, { state: deps.watcher.state(url.searchParams.get("quoteId") ?? "") });
      } catch {
        return fail(404, "not_found", "unknown quote");
      }
    },

    "POST /v1/topup/simulate": async (req) => {
      const watcher = deps.watcher as Partial<SimulatedWatcher>;
      if (deps.watcher.network !== "simulated" || !watcher.simulatePayment) return fail(404, "not_found", "not a simulated network");
      const body = await parse(req, z.object({ quoteId: z.string() }));
      if (body instanceof Response) return body;
      try {
        watcher.simulatePayment(body.quoteId);
        return json(200, { state: deps.watcher.state(body.quoteId) });
      } catch (err) {
        return fail(400, "bad_request", (err as Error).message);
      }
    },

    "POST /v1/topup/mint": async (req) => {
      const body = await parse(req, MintRequest);
      if (body instanceof Response) return body;
      const outputsHash = sha256Hex(canonicalJson(body.outputs));
      const stored = deps.responses.get(`topup:${body.quoteId}`);
      if (stored) {
        const minted = stored.body as { outputsHash: string; signatures: unknown };
        return minted.outputsHash === outputsHash ? json(200, { signatures: minted.signatures }) : fail(409, "bad_request", "quote already minted with different outputs");
      }
      let state;
      try {
        state = deps.watcher.state(body.quoteId);
      } catch {
        return fail(404, "not_found", "unknown quote");
      }
      if (state !== "confirmed") return fail(402, "quote_unpaid", `quote is ${state}`);
      const { credits } = deps.watcher.lookup(body.quoteId);
      let signatures;
      try {
        signatures = deps.mint.issue(body.outputs, credits); // throws unless outputs total exactly the paid credits
      } catch (err) {
        return fail(400, "bad_request", (err as Error).message);
      }
      deps.watcher.markMinted(body.quoteId, () => deps.responses.put(`topup:${body.quoteId}`, { status: 200, body: { outputsHash, signatures } }));
      deps.onEvent?.("topup", credits);
      return json(200, { signatures });
    },

    "POST /v1/chat": async (req) => {
      const body = await parse(req, ChatPaidRequest);
      if (body instanceof Response) return body;
      const replay = resume(body.requestId, body.changeOutputs);
      if (replay) return replay;
      const model = deps.models.get(body.request.model);
      if (!model) return fail(404, "unknown_model", `model ${body.request.model} is not offered`);
      const hold = maxCost(model.price, body.request.messages, body.request.max_tokens);
      return paid(body.requestId, body.proofs, body.changeOutputs, hold, async () => {
        const r = await model.upstream.chat(body.request.messages, {
          maxTokens: body.request.max_tokens,
          ...(body.request.temperature !== undefined ? { temperature: body.request.temperature } : {}),
        });
        return { body: { content: r.content, model: r.model }, cost: actualCost(model.price, r.usage), usage: r.usage };
      }, "chat");
    },

    "POST /v1/search": async (req) => {
      const body = await parse(req, SearchPaidRequest);
      if (body instanceof Response) return body;
      const replay = resume(body.requestId, body.changeOutputs);
      if (replay) return replay;
      const search = deps.search;
      if (!search) return fail(404, "not_found", "search is not enabled on this relay");
      return paid(body.requestId, body.proofs, body.changeOutputs, deps.searchPrice, async () => ({
        body: { hits: await search(body.query, body.maxResults) },
        cost: deps.searchPrice,
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      }), "search");
    },
  };

  return async (req) => {
    const url = new URL(req.url);
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return fail(404, "not_found", "no such route");
    try {
      return await route(req, url);
    } catch (err) {
      return fail(503, "upstream_error", `internal error: ${(err as Error).message.slice(0, 120)}`);
    }
  };
}
