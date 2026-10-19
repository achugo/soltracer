import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { abortWhenClientLeaves } from "../src/abort-on-close.ts";

function fakeResponse() {
  return Object.assign(new EventEmitter(), { writableEnded: false });
}

describe("abortWhenClientLeaves", () => {
  it("aborts when the connection closes before the response is finished", () => {
    const res = fakeResponse();
    const signal = abortWhenClientLeaves(res);
    res.emit("close");
    expect(signal.aborted).toBe(true);
  });

  it("does not abort after a completed response", () => {
    const res = fakeResponse();
    const signal = abortWhenClientLeaves(res);
    res.writableEnded = true;
    res.emit("close");
    expect(signal.aborted).toBe(false);
  });
});
