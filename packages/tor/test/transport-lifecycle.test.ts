import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ close: vi.fn(), fetch: vi.fn() }));
vi.mock("fetch-socks", () => ({ socksDispatcher: () => ({ close: mock.close, destroy: async () => {} }) }));
vi.mock("undici", () => ({ fetch: mock.fetch }));
import { torTransport } from "../src/transport.ts";
beforeEach(() => { vi.clearAllMocks(); mock.close.mockResolvedValue(undefined); mock.fetch.mockResolvedValue(new Response("ok")); });

describe("Tor dispatcher lifecycle", () => {
  it("closes each call's dispatcher while allowing the returned body to be read", async () => {
    const transport = torTransport({ host: "127.0.0.1", port: 1 });
    const response = await transport.fetchFor("first")("http://relay.test");
    expect(mock.close).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe("ok");
  });
  it("also closes the dispatcher when the request fails", async () => {
    mock.fetch.mockRejectedValue(new Error("network failed"));
    await expect(torTransport({ host: "127.0.0.1", port: 1 }).fetchFor("failed")("http://relay.test")).rejects.toThrow("network failed");
    expect(mock.close).toHaveBeenCalledTimes(1);
  });
});
