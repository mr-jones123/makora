// The `makora-repl` extension: the `python` tool the model is offered, and the `llm` tool its cells call.
import { defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { llmTool } from "./llm-tool.ts";
import { createPythonTool, type PythonToolOptions } from "./python-tool.ts";

/** The REPL of one session: its extension, and the `python` tool, which is all the model is offered. */
export interface Repl {
	readonly extension: Extension;
	readonly python: ToolRegistration;
}

/** The REPL over `options`' kernels. */
export function createRepl(options: PythonToolOptions): Repl {
	const python = createPythonTool(options);
	return { python, extension: defineExtension({ name: "makora-repl", tools: [python, llmTool] }) };
}
