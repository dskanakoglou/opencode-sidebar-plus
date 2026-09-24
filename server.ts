// Server half: gives the agent a `todo` tool. OpenCode v2 removed `todowrite`, so
// without this the sidebar has no task list to show. The tool is stateless: the
// agent sends its whole list each call and the sidebar reads the latest call.
import type { Plugin } from "@opencode/plugin"
import { normalizeTodos, TODO_STATUSES, TODO_TOOL, todoSummary } from "./src/derive.ts"

const ICON = { pending: "[ ]", in_progress: "[~]", completed: "[x]", cancelled: "[-]" } as const

const plugin: Plugin.Plugin = {
  id: "sidebar-plus",
  async setup(ctx) {
    if (ctx.options?.todo === false) return
    const registration = await ctx.tool.transform((editor) => {
      editor.add({
        name: TODO_TOOL,
        // kept short: it is sent with every request, and workshop models have 16k windows
        description:
          "Track a multi-step task as a to-do list shown to the user. Send the FULL list every call: when you plan, when an item starts, when it is done. Keep one item in_progress. Skip for one-step requests.",
        input: {
          type: "object",
          properties: {
            todos: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  content: { type: "string" },
                  status: { type: "string", enum: [...TODO_STATUSES] },
                },
                required: ["content", "status"],
                additionalProperties: false,
              },
            },
          },
          required: ["todos"],
          additionalProperties: false,
        },
        // a direct tool: in code mode the model first tries to call it directly and fails
        options: { codemode: false },
        execute: async (input) => {
          const items = normalizeTodos(input) ?? []
          const lines = items.map((item) => `${ICON[item.status]} ${item.text}`).join("\n")
          return {
            content: items.length ? `To-do updated (${todoSummary(items)} done):\n${lines}` : "To-do list cleared.",
            metadata: { items },
          }
        },
      })
    })
    return () => registration.dispose()
  },
}

export default plugin
