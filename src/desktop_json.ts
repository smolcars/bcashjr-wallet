// Laufey's native JSON number conversion follows LC_NUMERIC. Keep application
// data inside strings in both directions so JavaScript handles all numbers.
// Upstream: https://github.com/littledivy/laufey/issues/125
export function desktopJsonHandler<T>(handler: (request: T) => unknown | Promise<unknown>) {
  return async (request: string): Promise<string> => {
    try {
      if (typeof request !== "string") throw new Error("Malformed desktop request");
      const result = await handler(JSON.parse(request) as T);
      return JSON.stringify({ ok: true, result });
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

export async function callDesktopJson<T>(
  binding: (request: string) => Promise<string>,
  request: unknown,
): Promise<T> {
  const response = await binding(JSON.stringify(request));
  if (typeof response !== "string") throw new Error("Malformed desktop response");
  const envelope = JSON.parse(response);
  if (!envelope || typeof envelope.ok !== "boolean") {
    throw new Error("Malformed desktop response");
  }
  if (!envelope.ok) {
    throw new Error(
      typeof envelope.error === "string" ? envelope.error : "Desktop request failed",
    );
  }
  return envelope.result as T;
}
