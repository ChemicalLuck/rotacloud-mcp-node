import { McpServer } from "@modelcontextprotocol/server";
// Stable v2 moved the stdio transport to its own subpath.
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { RotaCloud } from "./client.js";
import { registerTools } from "./tools.js";

const server = new McpServer({ name: "rotacloud-mcp-node", version: "1.0.0" });
const rc = new RotaCloud();

function makeTool(name, description, schema, callFn) {
  server.registerTool(name, { description, inputSchema: schema }, async (params) => {
    try {
      const { data, totalCount, links } = await callFn(params);
      const payload =
        totalCount === undefined ? data : { meta: { total_count: totalCount, links }, data };
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err.detail ?? err.message }] };
    }
  });
}

registerTools(makeTool, rc);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
