# rotacloud-mcp-node

An MCP server exposing the [RotaCloud API](https://rotacloud-api-docs.netlify.app/) to Claude and other MCP clients. It covers all **129 documented v1 operations** across 36 resources — shifts, attendance, leave, users, locations, roles, timesheets and the rest.

Tools are generated from RotaCloud's published OpenAPI specification (`vendor/openapi.json`), so parameter names, types and descriptions come straight from the documentation.

## Installation

### As a Claude Desktop extension

Download `rotacloud-mcp-node.mcpb` and open it with Claude Desktop. You will be prompted for your RotaCloud API key, which you can generate from within your RotaCloud account.

### Manual / development

```bash
npm install
export ROTACLOUD_API_KEY="your-api-key-here"
node server/index.js
```

Add it to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "rotacloud": {
      "command": "node",
      "args": ["/absolute/path/to/rotacloud-mcp-node/server/index.js"],
      "env": {
        "ROTACLOUD_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `ROTACLOUD_API_KEY` | yes | API key generated from your RotaCloud account |
| `ROTACLOUD_USER_ID` | no | Act on behalf of this user by default (sends the `User` header) |

By default requests are made as an anonymous user with administrative permissions. Setting `ROTACLOUD_USER_ID` makes every request act as that user instead. Tools whose behaviour depends on the acting user — `me_*`, `messages_*`, `leave_requests_*`, `swap_requests_*` and `unavailability_requests_*` — also accept an `as_user` argument to override it per call.

## Tools

Tools are named `{resource}_{action}`, e.g. `shifts_list`, `shifts_create`, `users_retrieve`, `leave_requests_approve`.

Names are derived from each operation's summary in the API documentation rather than from its HTTP method, because in this API the two often disagree — `DELETE /users_clocked_in/{id}` clocks a user *out*, and `POST /swap_requests/{id}` *denies* a swap. The tool names reflect what the operation actually does: `users_clocked_in_clock_out`, `swap_requests_deny_shift_admin`.

### Dates and times

RotaCloud mixes three formats, and the tools follow the API exactly:

- **Unix epoch seconds** for shift and attendance times (`start_time`, `in_time`, and the `start`/`end` range filters on `/shifts`, `/attendance`, `/availability`, `/pay_periods` …). These tools also accept an ISO 8601 string and convert it for you.
- **`YYYY-MM-DD` strings** for leave, day notes, TOIL and user dates (`start_date`, `end_date`, `dob` …).
- **`HH:MM` strings** for logbook event times and availability windows.

### Pagination

List endpoints accept `limit` and `offset`. Responses that are paginated are returned as:

```json
{
  "meta": { "total_count": 137, "links": { "next": "…", "last": "…" } },
  "data": [ … ]
}
```

Results are **not** auto-paginated — each call returns one page, so a wide date range cannot flood the context. Follow `meta.links.next` or increment `offset` to page through.

### Request bodies

Write tools list every field documented for that endpoint, but accept unknown fields too. RotaCloud's published body schemas are derived from example payloads and under-describe reality (for instance `role_rates` is documented with the example's literal role IDs as keys), so rejecting undocumented fields would block valid writes. Each write tool's description includes the documented example payload.

## Resources

- `accounts` (1)
- `attendance` (5)
- `attendance_approved` (2)
- `availability` (2)
- `day_notes` (5)
- `days_off` (3)
- `days_off_patterns` (5)
- `documents` (6)
- `groups` (5)
- `holiday_allowances` (2)
- `holiday_allowances_custom` (3)
- `leave` (5)
- `leave_embargoes` (5)
- `leave_requests` (6)
- `leave_types` (1)
- `locations` (5)
- `logbook_categories` (5)
- `logbook_events` (5)
- `me` (2)
- `messages` (2)
- `pay_periods` (3)
- `pins` (1)
- `roles` (5)
- `settings` (1)
- `shifts` (5)
- `shifts_acknowledged` (1)
- `shifts_published` (2)
- `swap_requests` (5)
- `terminals` (5)
- `terminals_active` (3)
- `timezones` (2)
- `toil_accruals` (4)
- `toil_allowance` (1)
- `unavailability_requests` (6)
- `users` (5)
- `users_clocked_in` (5)

## Scope

This server covers the **v1 API** as published at <https://rotacloud-api-docs.netlify.app/>. RotaCloud's official Node SDK exposes some additional v2 endpoints (invoices, v2 logbook, user onboarding) which are not part of the public documentation and are not included here.

## Regenerating

`server/tools.js` is generated and committed. To pick up a newer version of the API:

```bash
curl -o vendor/openapi.json https://rotacloud-api-docs.netlify.app/openapi.json
npm run generate
```

The generator fails loudly if two operations would produce the same tool name.

## Building

```bash
npm run build   # mcpb pack
```

Check the contents of the resulting `.mcpb` before distributing it — `mcpb pack` sweeps local dotfiles into the bundle.

## License

MIT
