// One isolated Compose project per run, ephemeral ports and unconditional cleanup.
const project = `bcashjr-it-${crypto.randomUUID().slice(0, 12)}`;
const file = new URL("./compose.yml", import.meta.url).pathname;
const compose = ["compose", "-p", project, "-f", file];
async function docker(args: string[], capture = false) {
  const result = await new Deno.Command("docker", {
    args: [...compose, ...args],
    stdout: capture ? "piped" : "inherit",
    stderr: "inherit",
  }).output();
  if (!result.success) throw new Error(`docker compose ${args.join(" ")} failed (${result.code})`);
  return capture ? new TextDecoder().decode(result.stdout).trim() : "";
}
const logs = new URL("../../artifacts/integration/", import.meta.url);
await Deno.mkdir(logs, { recursive: true });
let code = 1;
try {
  await docker(["build"]);
  await docker(["up", "-d"]);
  const env: Record<string, string> = { BCASHJR_INTEGRATION: "1" };
  for (
    const [service, port, name] of [
      ["bitcoin", "18443", "BTC_RPC"],
      ["knots", "18443", "BLAKE_RPC"],
      ["bitcoin-api", "8999", "BTC_API"],
      ["knots-api", "8999", "BLAKE_API"],
    ]
  ) {
    env[name] = `http://${await docker(["port", service, port], true)}`;
    if (name.endsWith("API")) env[name] += "/api/v1";
  }
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["test", "-A", "--fail-fast", "tests/integration/wallet_test.ts"],
    env,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  code = result.code;
} finally {
  try {
    const result = await new Deno.Command("docker", {
      args: [...compose, "logs", "--no-color"],
      stdout: "piped",
      stderr: "piped",
    }).output();
    await Deno.writeFile(new URL("compose.log", logs), result.stdout);
  } finally {
    await docker(["down", "--volumes", "--remove-orphans"]);
  }
}
Deno.exit(code);
