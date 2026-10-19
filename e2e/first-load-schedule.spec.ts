import { expect, test } from "@playwright/test";
import { expectSettled } from "./settled";

type LogEntry = { event: "request" | "response"; resolution: string };
type LoggedWindow = Window & { __workerLog?: LogEntry[] };

const SLOW_DRAFT_MS = 700;

test("on the first load the final is requested only after the draft response arrives", async ({ page }) => {
  await page.addInitScript((slowDraftMs) => {
    const log: LogEntry[] = [];
    (window as LoggedWindow).__workerLog = log;
    const resolutionById = new Map<number, string>();
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        this.addEventListener("message", (ev: MessageEvent<{ id: number }>) => {
          log.push({ event: "response", resolution: resolutionById.get(ev.data.id) ?? "?" });
        });
      }
      postMessage(message: { id: number; resolution: string }) {
        const send = () => {
          resolutionById.set(message.id, message.resolution);
          log.push({ event: "request", resolution: message.resolution });
          super.postMessage(message);
        };
        if (message.resolution === "draft") window.setTimeout(send, slowDraftMs);
        else send();
      }
    } as typeof Worker;
  }, SLOW_DRAFT_MS);

  await page.goto("/");
  await expect(page.getByTestId("download-stl")).toBeEnabled();
  await expectSettled(page);

  const log = (await page.evaluate(() => (window as LoggedWindow).__workerLog)) ?? [];
  const steps = log.map((e) => `${e.event} ${e.resolution}`);
  expect(steps).toEqual(["request draft", "response draft", "request final", "response final"]);
});
