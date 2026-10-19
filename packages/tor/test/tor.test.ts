import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { directTransport, newCircuitTag, torTransport } from "../src/index.ts";

/** A tiny SOCKS5 server that records the username of each connection, then refuses it. */
function fakeSocks(): Promise<{ port: number; users: string[]; close: () => void }> {
  const users: string[] = [];
  const server = createServer((sock) => {
    let stage = 0;
    sock.on("data", (buf: Buffer) => {
      if (stage === 0) {
        stage = 1;
        sock.write(Buffer.from([0x05, 0x02])); // choose username/password auth
      } else if (stage === 1) {
        stage = 2;
        const ulen = buf[1]!;
        users.push(buf.subarray(2, 2 + ulen).toString());
        sock.write(Buffer.from([0x01, 0x00])); // auth ok
      } else {
        sock.end(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); // connection refused
      }
    });
    sock.on("error", () => {});
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, users, close: () => server.close() });
    }),
  );
}

describe("torTransport", () => {
  it("uses a distinct SOCKS identity per circuit tag", async () => {
    const socks = await fakeSocks();
    const transport = torTransport({ host: "127.0.0.1", port: socks.port });
    const a = newCircuitTag();
    const b = newCircuitTag();
    await transport.fetchFor(a)("http://example.invalid/").catch(() => {});
    await transport.fetchFor(b)("http://example.invalid/").catch(() => {});
    await transport.fetchFor(a)("http://example.invalid/").catch(() => {});
    socks.close();
    expect(socks.users).toEqual([a, b, a]);
    expect(a).not.toBe(b);
  });

  it("never falls back to a direct connection when the proxy is down", async () => {
    const transport = torTransport({ host: "127.0.0.1", port: 1 });
    await expect(transport.fetchFor(newCircuitTag())("http://example.invalid/")).rejects.toThrow();
  });
});

describe("directTransport", () => {
  it("is labeled direct and uses the given fetch", async () => {
    const t = directTransport(async () => new Response("ok"));
    expect(t.kind).toBe("direct");
    expect(await (await t.fetchFor("x")("http://a.test")).text()).toBe("ok");
  });
});
