import { describe, it, expect, beforeEach } from "vitest";

import { cfProxyCandidatesFor, rememberCfProxy } from "../tg/proxyProviders";
import { setSetting } from "../db/repos/settings";
import { useTestDb } from "./helpers/db";

const POOL = [
  { id: "p1", name: "Proxy One", url: "http://u:p@1.1.1.1:8080" },
  { id: "p2", name: "Proxy Two", url: "http://u:p@2.2.2.2:8080" },
  { id: "p3", name: "Proxy Three", url: "http://u:p@3.3.3.3:8080" },
];

// The pool and the per-host memory are both settings, so these run against a real database
// instead of a stubbed `prepare`. Each test starts empty and seeds its own pool.
useTestDb();

beforeEach(async () => {
  await setSetting("proxies", JSON.stringify(POOL));
});

describe("cfProxyCandidatesFor", () => {
  it("leads with the job proxy and offers the rest of the pool", async () => {
    const got = await cfProxyCandidatesFor({ primaryUrl: POOL[1].url });
    expect(got.map((c) => c.id)).toEqual(["p2", "p1", "p3"]);
  });

  it("keeps to the single pinned exit when the pool is not to be tried", async () => {
    const got = await cfProxyCandidatesFor({
      primaryUrl: POOL[0].url,
      proxyId: "p3",
      tryAll: false,
    });
    expect(got).toEqual([{ id: "p3", label: "Proxy Three", url: POOL[2].url }]);
  });

  it("pins a chosen exit first, with the pool behind it", async () => {
    const got = await cfProxyCandidatesFor({ primaryUrl: POOL[0].url, proxyId: "p3" });
    expect(got.map((c) => c.id)).toEqual(["p3", "p1", "p2"]);
  });

  it("runs without a proxy when direct is pinned", async () => {
    const got = await cfProxyCandidatesFor({ proxyId: "direct", tryAll: false });
    expect(got).toEqual([{ id: "direct", label: "direct", url: undefined }]);
  });

  it("leads with the exit that last cleared the host, unless one is pinned", async () => {
    await rememberCfProxy("app.example.com", "p3");
    expect(
      (await cfProxyCandidatesFor({ primaryUrl: POOL[0].url, host: "app.example.com" })).map(
        (c) => c.id,
      ),
    ).toEqual(["p3", "p1", "p2"]);
    expect(
      (
        await cfProxyCandidatesFor({
          primaryUrl: POOL[0].url,
          host: "app.example.com",
          proxyId: "p2",
        })
      ).map((c) => c.id),
    ).toEqual(["p2", "p1", "p3"]);
  });

  it("caps how many exits are offered", async () => {
    expect(await cfProxyCandidatesFor({ primaryUrl: POOL[0].url, max: 2 })).toHaveLength(2);
  });

  it("offers an exit once: refused ones are not repeated on a retry", async () => {
    const first = await cfProxyCandidatesFor({ primaryUrl: POOL[0].url, max: 2 });
    expect(first.map((c) => c.id)).toEqual(["p1", "p2"]);
    const second = await cfProxyCandidatesFor({
      primaryUrl: POOL[0].url,
      max: 2,
      exclude: first.map((c) => c.id),
    });
    expect(second.map((c) => c.id)).toEqual(["p3"]);
    expect(
      await cfProxyCandidatesFor({
        primaryUrl: POOL[0].url,
        exclude: ["p1", "p2", "p3"],
      }),
    ).toEqual([]);
  });

  it("reaches exits sitting past one attempt's window, imports included", async () => {
    const big = [
      ...POOL,
      { id: "pp:webshare:1", name: "Webshare A", url: "http://u:p@4.4.4.4:8080" },
      { id: "pp:webshare:2", name: "Webshare B", url: "http://u:p@5.5.5.5:8080" },
    ];
    await setSetting("proxies", JSON.stringify(big));
    const first = await cfProxyCandidatesFor({ primaryUrl: POOL[0].url, max: 3 });
    const second = await cfProxyCandidatesFor({
      primaryUrl: POOL[0].url,
      max: 3,
      exclude: first.map((c) => c.id),
    });
    expect(second.map((c) => c.id)).toEqual(["pp:webshare:1", "pp:webshare:2"]);
  });

  it("drops a pinned exit that has already been refused", async () => {
    expect(
      await cfProxyCandidatesFor({ proxyId: "p3", tryAll: false, exclude: ["p3"] }),
    ).toEqual([]);
  });
});
