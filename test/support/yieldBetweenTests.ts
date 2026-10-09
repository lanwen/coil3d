import { afterEach } from "vitest";
import { yieldToEventLoop } from "./yieldToEventLoop";

afterEach(yieldToEventLoop);
