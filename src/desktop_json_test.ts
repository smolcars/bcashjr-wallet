import { callDesktopJson, desktopJsonHandler } from "./desktop_json.ts";

Deno.test("desktop JSON preserves nested decimals, strings, and fractional screen scale", async () => {
  const request = {
    devicePixelRatio: 1.25,
    settings: { btcFeeRate: 1.1, blakeFeeRate: 1.5 },
    text: 'åäö 😀 "quoted" \\ newline\n',
  };
  const handler = desktopJsonHandler((value: typeof request) => value);
  const response = await callDesktopJson(async (wireRequest) => {
    if (typeof wireRequest !== "string") throw new Error("Native request must be a string");
    const wireResponse = await handler(wireRequest);
    if (typeof wireResponse !== "string") throw new Error("Native response must be a string");
    return wireResponse;
  }, request);
  if (JSON.stringify(response) !== JSON.stringify(request)) {
    throw new Error("Desktop JSON changed the payload");
  }
});

Deno.test("desktop JSON preserves void, null, and primitive results", async () => {
  for (const result of [undefined, null, false, 1.5, "recovery phrase"]) {
    const actual = await callDesktopJson(desktopJsonHandler(() => result), { method: "test" });
    if (actual !== result) throw new Error("Desktop JSON changed the result");
  }
});

Deno.test("desktop JSON carries sync and async errors through a string response", async () => {
  for (
    const fail of [
      () => {
        throw new Error("Invalid fee: 1.5");
      },
      () => Promise.reject(new Error("Invalid fee: 1.5")),
    ]
  ) {
    const handler = desktopJsonHandler(fail);
    const wireResponse = await handler("{}");
    if (typeof wireResponse !== "string" || JSON.parse(wireResponse).ok !== false) {
      throw new Error("Error escaped the string transport");
    }
    try {
      await callDesktopJson(handler, {});
    } catch (error) {
      if (error instanceof Error && error.message === "Invalid fee: 1.5") continue;
      throw error;
    }
    throw new Error("Desktop error was swallowed");
  }
});

Deno.test("desktop JSON rejects malformed input without dispatching it", async () => {
  let called = false;
  const handler = desktopJsonHandler(() => {
    called = true;
  });
  const response = JSON.parse(await handler("{broken"));
  if (called || response.ok !== false || typeof response.error !== "string") {
    throw new Error("Malformed request reached the handler");
  }
});

Deno.test("desktop JSON rejects malformed response envelopes", async () => {
  for (const response of ["null", "{}", "[]", '{"ok":"true"}', "not JSON"]) {
    try {
      await callDesktopJson(() => Promise.resolve(response), {});
    } catch {
      continue;
    }
    throw new Error(`Malformed desktop response was accepted: ${response}`);
  }
});
