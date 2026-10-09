// A vitest worker answers its task-update RPC to the main process only when its
// event loop turns, and the RPC gives up after a fixed 60 s. Geometry work is
// synchronous and a test that awaits it never turns the loop, so a stretch of
// tests (or one long loop) that runs past 60 s ends the run with an unhandled
// `Timeout calling "onTaskUpdate"` although every test passed (issue #302).
// A macrotask yield lets the loop turn: yieldBetweenTests.ts does it after every test,
// and a long loop inside one test calls this itself.
export const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
