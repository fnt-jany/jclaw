import { request } from "node:http";

const WAKE_PORT = Math.max(1024, Number(process.env.JCLAW_CRON_WAKE_PORT ?? "4317") || 4317);
const WAKE_HOST = "127.0.0.1";
const WAKE_PATH = "/wake";

export function getCronWakePort(): number {
  return WAKE_PORT;
}

export async function notifyCronWorkerWake(reason: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = request(
      {
        host: WAKE_HOST,
        port: WAKE_PORT,
        path: WAKE_PATH,
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        }
      },
      (res) => {
        const status = res.statusCode ?? 500;
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (status >= 200 && status < 300) {
            resolve();
            return;
          }
          reject(new Error(body.trim() || `wake notify failed with status ${status}`));
        });
      }
    );

    req.setTimeout(5000, () => {
      req.destroy(new Error("wake notify timed out"));
    });

    req.on("error", (err) => {
      reject(err instanceof Error ? err : new Error(String(err)));
    });

    req.end(JSON.stringify({ reason, ts: new Date().toISOString() }));
  });
}
