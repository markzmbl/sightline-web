import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../src/components/composer/Composer";

afterEach(cleanup);

function setup(props: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSubmit = props.onSubmit ?? vi.fn();
  render(<Composer placeholder="Ask a question about your data…" {...props} onSubmit={onSubmit} />);
  const box = screen.getByRole("textbox") as HTMLTextAreaElement;
  const type = (value: string) => fireEvent.change(box, { target: { value } });
  return { onSubmit, box, type };
}

describe("Composer", () => {
  it("submits the trimmed text on Enter and clears the box", () => {
    const { onSubmit, box, type } = setup();
    type("  OEE by line last week  ");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("OEE by line last week");
    expect(box.value).toBe("");
  });

  it("does not submit on Shift+Enter", () => {
    const { onSubmit, box, type } = setup();
    type("first line");
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(box.value).toBe("first line");
  });

  it("does not submit while an input method is composing", () => {
    const { onSubmit, box, type } = setup();
    type("売上");
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    fireEvent.keyDown(box, { key: "Enter", keyCode: 229 });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(box.value).toBe("売上");
  });

  it("does not submit empty or blank text", () => {
    const { onSubmit, box, type } = setup();
    fireEvent.keyDown(box, { key: "Enter" });
    type("   \n ");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("hands its text box to a page that moves focus to it", () => {
    const ref = createRef<HTMLTextAreaElement>();
    setup({ ref });
    expect(ref.current).toBe(screen.getByRole("textbox"));
    ref.current?.focus();
    expect(document.activeElement).toBe(ref.current);
  });

  it("submits from the Send button too", () => {
    const { onSubmit, type } = setup();
    type("Scrap rate");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSubmit).toHaveBeenCalledWith("Scrap rate");
  });

  it("offers Stop while working with an empty box, and Send once there is text", () => {
    const onStop = vi.fn();
    const { type } = setup({ working: true, onStop });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledTimes(1);

    type("by shift instead");
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("shows no Stop when idle", () => {
    setup({ working: false, onStop: vi.fn() });
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("clears only once a returned promise resolves", async () => {
    let resolve: (value: unknown) => void = () => undefined;
    const onSubmit = vi.fn(() => new Promise((r) => (resolve = r)));
    const { box, type } = setup({ onSubmit });
    type("Claims per region");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe("Claims per region");
    await act(async () => resolve({ thread_id: "t1", run_id: "r1" }));
    expect(box.value).toBe("");
  });

  it("keeps the text when the returned promise rejects", async () => {
    const onSubmit = vi.fn(() => Promise.reject(new Error("422")));
    const { box, type } = setup({ onSubmit });
    type("Claims per region");
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(box.value).toBe("Claims per region");
    // And it can be sent again.
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("does not submit while disabled", () => {
    const { onSubmit, box } = setup({ disabled: true });
    fireEvent.change(box, { target: { value: "anything" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
