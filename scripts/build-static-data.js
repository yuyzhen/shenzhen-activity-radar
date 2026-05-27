import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT || 5188);
const server = spawn(process.execPath, ["server.js"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"]
});

let settled = false;
const stop = () => {
  if (!server.killed) server.kill();
};

try {
  await waitForServer(PORT);
  const response = await fetch(`http://localhost:${PORT}/api/events?refresh=1`);
  if (!response.ok) throw new Error(`API returned ${response.status}`);
  const data = await response.json();
  await mkdir(new URL("../public/data", import.meta.url), { recursive: true });
  await writeFile(new URL("../public/data/events.json", import.meta.url), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  settled = true;
  console.log(`Wrote ${data.events.length} events to public/data/events.json`);
} finally {
  stop();
  if (!settled) {
    server.stderr?.pipe(process.stderr);
    server.stdout?.pipe(process.stdout);
  }
}

async function waitForServer(port) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://localhost:${port}/api/events`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  throw new Error("Server did not become ready in time");
}
