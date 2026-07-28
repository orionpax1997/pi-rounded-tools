/**
 * Pi Rounded Tools — rounded frames for tool calls and results.
 *
 * Re-registers the built-in tools (read, write, edit, bash, grep, find, ls)
 * with `renderShell: "self"` and wraps each tool call / result in a frame
 * drawn with Unicode rounded-corner characters (╭ ╮ ╰ ╯ ─ │).
 *
 * No left color bar, no theme matching — just the corners.
 * Border color follows `theme.fg("border", …)` so it adapts to your theme.
 *
 * Implementation note: we don't reimplement the inner rendering — we just
 * call the built-in `renderCall` / `renderResult` and wrap the returned
 * component in a `RoundedFrame`. That way bash's preview, read's syntax
 * highlighting, edit's diff stats, etc. all stay exactly as pi ships them.
 *
 * Install: drop this file at `~/.pi/agent/extensions/rounded-tools.ts`
 *          then run `/reload` inside pi.
 */

import type {
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";

// ─── Rounded-corner frame ────────────────────────────────────────────────
//
// Three modes let call + result stack into one continuous frame:
//   - "closed"      → ╭ ── ╮ / │ x │ / ╰ ── ╯ (standalone box)
//   - "open-bottom" → ╭ ── ╮ / │ x │        (top of a stacked frame)
//   - "open-top"    →        │ x │ / ╰ ── ╯ (bottom of a stacked frame)

type FrameMode = "closed" | "open-bottom" | "open-top";

class RoundedFrame implements Component {
	constructor(
		private readonly inner: Component,
		private readonly border: (text: string) => string,
		private readonly mode: FrameMode = "closed",
	) {}

	invalidate(): void {
		this.inner.invalidate?.();
	}

	// pi's built-in tool renderers cache the previously-returned component
	// via `context.lastComponent` and call mutating methods on it
	// (`Text.setText`, `Container.clear`/`addChild`, `invalidate`) so they
	// can re-render in place during streaming. Once we wrap the inner in a
	// RoundedFrame, pi hands our wrapper back to the inner renderer on the
	// next render — but pi's try/catch around `callRenderer(...)` falls
	// back to a plain `createCallFallback()` text node if the inner
	// renderer throws, which would make the border vanish on every
	// Ctrl+O toggle. Forward these methods to the inner so the original
	// renderers work unchanged; calls on a wrapper whose inner lacks the
	// method are no-ops thanks to optional chaining.
	setText(text: string): void {
		(this.inner as any).setText?.(text);
	}

	clear(): void {
		(this.inner as any).clear?.();
	}

	addChild(child: any): void {
		(this.inner as any).addChild?.(child);
	}

	render(width: number): string[] {
		if (width < 4) {
			return this.inner.render(width);
		}

		const innerWidth = Math.max(1, width - 4); // │ + space + content + space + │
		const horizontal = "─".repeat(Math.max(0, width - 2));
		const innerLines = this.inner.render(innerWidth);
		const side = this.border("│");

		const out: string[] = [];

		if (this.mode !== "open-top") {
			out.push(this.border("╭" + horizontal + "╮"));
		}

		if (innerLines.length > 0) {
			for (const line of innerLines) {
				const vis = visibleWidth(line);
				const pad = " ".repeat(Math.max(0, innerWidth - vis));
				out.push(side + " " + line + pad + " " + side);
			}
		} else if (this.mode === "closed") {
			// Standalone closed frame with no content: draw a placeholder row
			// so the box still has visual presence. Skipped for open-top /
			// open-bottom since they pair with another half-frame and a fake
			// empty row would show up as a stray blank line in the middle.
			out.push(side + " ".repeat(width - 2) + side);
		}

		if (this.mode !== "open-bottom") {
			out.push(this.border("╰" + horizontal + "╯"));
		}
		return out;
	}
}

const frame = (
	inner: Component,
	theme: { fg: (color: string, text: string) => string },
	mode: FrameMode = "closed",
	colorKey: string = "border",
): Component => new RoundedFrame(inner, (t) => theme.fg(colorKey, t), mode);

/**
 * Pick a border color key based on the tool's runtime state.
 *
 *   - still running (`context.isPartial`) → warning (yellow)
 *   - finished with an error (`context.isError`) → error (red)
 *   - finished successfully → border (theme default)
 *
 * Both `renderCall` and `renderResult` go through this picker, so when
 * they stack into one continuous frame, the borders match. pi re-renders
 * the whole component on every state transition (args streaming → done,
 * partial → final), and `context.isPartial` flips accordingly, so call
 * and result always pick the same color at any given moment.
 *
 * Mirrors pi's own 3-state scheme (`toolPendingBg` / `toolSuccessBg` /
 * `toolErrorBg`) — see `theme.js`.
 */
function borderColorFor(
	context: { isPartial?: boolean; isError?: boolean } | undefined,
): string {
	if (context?.isPartial) return "warning";
	if (context?.isError) return "error";
	return "border";
}

// ─── Helpers ─────────────────────────────────────────────────────────────

type ToolDef = {
	name: string;
	renderCall?: (args: any, theme: any, context: any) => Component;
	renderResult?: (
		result: any,
		options: any,
		theme: any,
		context: any,
	) => Component;
	execute: (id: string, params: any, signal: any, onUpdate: any) => Promise<any>;
	[key: string]: any;
};

/**
 * Wrap a built-in tool definition in rounded frames.
 *
 * We spread the original definition first so we preserve every metadata
 * field (promptSnippet / promptGuidelines / prepareArguments /
 * constrainedSampling / executionMode / …) — only the renderers and
 * `renderShell` are overwritten. This keeps the tool's LLM-facing prompt
 * data intact, edit's argument pre-processing intact, etc.
 */
function wrapBuiltin(def: ToolDef) {
	return {
		...def,
		renderShell: "self" as const,
		renderCall: (args: any, theme: any, context: any) => {
			// Hide our (or any) previous wrapper from the inner renderer so it
			// doesn't treat a RoundedFrame as its own lastComponent — that
			// would either throw (`Text.setText` is missing) or nest frames
			// (`inner = previous RoundedFrame` → we re-wrap it). Forcing the
			// inner to allocate fresh costs one Text/Container per render but
			// keeps every render independent and CC-protect against future
			// tool changes.
			const inner: Component = def.renderCall
				? def.renderCall(args, theme, { ...context, lastComponent: undefined })
				: { render: () => [] };
			// During execution pi re-renders every tick (e.g. bash's elapsed
			// timer). Skip the frame then — keeping its borders stable avoids
			// redraw flicker — and only wrap it once the tool settles.
			if (context?.isPartial) return inner;
			return frame(inner, theme, "open-bottom", borderColorFor(context));
		},
		renderResult: (result: any, options: any, theme: any, context: any) => {
			const inner: Component = def.renderResult
				? def.renderResult(result, options, theme, { ...context, lastComponent: undefined })
				: { render: () => [] };
			if (context?.isPartial) return inner;
			return frame(inner, theme, "open-top", borderColorFor(context));
		},
	};
}

// ─── Tool re-registrations ───────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	const tools: ToolDef[] = [
		createReadToolDefinition(cwd),
		createWriteToolDefinition(cwd),
		createEditToolDefinition(cwd),
		createBashToolDefinition(cwd),
		createGrepToolDefinition(cwd),
		createFindToolDefinition(cwd),
		createLsToolDefinition(cwd),
	];

	for (const def of tools) {
		pi.registerTool(wrapBuiltin(def));
	}
}