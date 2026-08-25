# Local-GPU coding agent (MCP)

เอกสารนี้อธิบายวิธีให้ IDE ที่รองรับ MCP (Model Context Protocol) — VS Code, Cursor, Claude
Code, JetBrains, Windsurf ฯลฯ — เรียกใช้โมเดลที่รันบน GPU เครื่องนี้ผ่าน Ollama เป็น coding
agent เพิ่มเติมได้ นอกเหนือจาก agent หลักของ IDE เอง

ระบบนี้เป็น **ทางเข้าที่สอง** สู่ subsystem เดียวกับที่อธิบายไว้ใน
[`.claude/skills/gpu-workspace-coding/SKILL.md`](../.claude/skills/gpu-workspace-coding/SKILL.md)
(ทางเข้าแรกคือ web chat UI ของโปรเจกต์นี้เอง) — โมเดล, sandbox และเครื่องมือ read/write/search
ที่ใช้เป็นชุดเดียวกันทั้งหมด สิ่งที่ต่างกันคือ "ใครเป็นคนขับ loop"

## สองทางเข้าถึงโมเดลเดียวกัน

**ทาง A — Web chat UI (มีอยู่แล้ว):** backend (`OllamaProvider.streamChat()`) เป็นคนขับ
tool loop เอง ผู้ใช้พิมพ์ข้อความในหน้าเว็บ โมเดลตอบกลับผ่าน WebSocket streaming

```text
Browser (หน้าแชท)
  └─ WebSocket ───> NestJS backend (Docker)
                       └─ OllamaProvider.streamChat()   ← tool loop เดินอยู่ใน backend
                            ├─ POST host.docker.internal:11434/api/chat  (tools: [...])
                            └─ WorkspaceToolsService.execute()
                                 └─ WorkspaceBridgeClient ─http─> host-bridge (host, :4171)
                                                                    └─ /workspace/* → ดิสก์จริง
```

**ทาง B — IDE ผ่าน MCP (เอกสารนี้):** IDE เป็นคนขับ loop เอง — MCP server ใน `host-bridge/`
เป็นแค่ตัวยื่นเครื่องมือให้ IDE เรียก ไม่มี backend, ไม่มี Docker, ไม่มี WebSocket เกี่ยวข้องเลย

```text
IDE (VS Code / Cursor / Claude Code / …)
  └─ stdio ───> host-bridge/dist/mcp-main.js   ← MCP server, tool loop เดินอยู่ใน IDE
                  ├─ local_workspace_* ───────────> workspace.ts (sandbox เดียวกับทาง A)
                  └─ local_code_agent ──http──────> OLLAMA_BASE_URL (http://localhost:11434)
                        (รัน read/write/search/run loop ของตัวเองแล้วรายงานผลกลับเป็นข้อความ)
```

ใน IDE คุณมีเครื่องมือให้เลือกสองระดับ:

- ใช้ `local_workspace_read` / `write` / `list` / `search` โดยตรง — agent หลักของ IDE (เช่น
  Claude Code เอง) เป็นคนตัดสินใจแต่ละ step ด้วยตัวเอง แค่ยืมมือ tool พวกนี้ไปแตะไฟล์ใน sandbox
- ใช้ `local_code_agent` — มอบงานทั้งก้อนให้โมเดลที่รันบน GPU เครื่องนี้ไปคิด loop เองทั้งหมด
  (อ่าน/เขียน/ค้นหา/รันคำสั่ง) แล้วรายงานกลับมาเป็นสรุปทุก step ที่ทำ

ไม่ว่าจะเข้าทางไหน sandbox ที่แตะได้คือโฟลเดอร์เดียวกัน (`BRIDGE_WORKSPACE_ROOT`) และกฎ
ความปลอดภัยชุดเดียวกัน — ดูหัวข้อ [Security](#security) ด้านล่าง

## เครื่องมือ (MCP tools) ที่ server นี้ยื่นให้

| Tool | Input | ทำอะไร |
|---|---|---|
| `local_code_agent` | `task` (required), `path` (optional), `model` (optional) | Tool หลัก — รันโมเดล local ใน loop อ่าน/เขียน/ค้นหา/รันคำสั่งต่อ workspace แล้วรายงานทุก step ที่ทำ |
| `local_workspace_read` | `path` | อ่านไฟล์เดียวใน sandbox |
| `local_workspace_write` | `path`, `content` | เขียนไฟล์เดียวลง sandbox |
| `local_workspace_list` | `path` (optional) | list เนื้อหาของ directory |
| `local_workspace_search` | `query`, `path` (optional) | ค้นหาข้อความในไฟล์ |
| `local_model_status` | ไม่มี | ตรวจว่า Ollama ติดต่อได้ไหม, โมเดลที่ติดตั้งพร้อมระบุว่าตัวไหนรองรับ tool calling, workspace root, exec allowlist |

## ข้อกำหนดเบื้องต้น (Prerequisites)

- **Ollama ติดตั้งและเปิดอยู่** บนเครื่องเดียวกับที่ IDE รัน (หรือเครื่องที่ `OLLAMA_BASE_URL`
  ชี้ถึง)
- **มีโมเดลอย่างน้อยหนึ่งตัวที่ประกาศ capability `tools`** — ตรวจด้วย:

  ```bash
  curl -s localhost:11434/api/tags | grep -o '"capabilities":\[[^]]*\]'
  ```

  โมเดลที่ verify แล้วว่าใช้งานได้จริงบนเครื่องนี้คือ `qwen2.5-coder:14b` (Q4_K_M, context
  32k) — บนการ์ดจอ 16 GB โหลดอยู่ที่ราว 93% GPU / 7% CPU (RTX 5070 Ti, Ollama 0.32.15)
- **Node.js 24 หรือใหม่กว่า** (ตรงกับ requirement ของ repo ส่วนอื่น) — MCP server รันด้วย
  `node`, ไม่ต้องใช้ pnpm/Docker ตอนรันจริง (ใช้ pnpm แค่ตอน build)

## การติดตั้ง (Setup)

1. **ตั้งค่า sandbox บนเครื่อง host** — คัดลอก `host-bridge/.env.example` เป็น
   `host-bridge/.env` แล้วตั้ง `BRIDGE_WORKSPACE_ROOT` ให้ชี้ไปยังโฟลเดอร์เฉพาะที่ยอมให้โมเดล
   local แตะได้ (ห้ามชี้ไปที่ repo checkout จริง — ดู [Security](#security)) ถ้าต้องการให้
   `local_code_agent` รันคำสั่งได้ด้วย ให้ตั้ง `BRIDGE_EXEC_ALLOWLIST` เพิ่ม (ค่าเริ่มต้นว่าง =
   ปิด exec) ตัวแปรสองตัวที่เพิ่มเข้ามาเฉพาะสำหรับ MCP:

   | ตัวแปร | จำเป็น | ค่าเริ่มต้น | รายละเอียด |
   |---|---|---|---|
   | `OLLAMA_BASE_URL` | ไม่ | `http://localhost:11434` | MCP server คุยกับ Ollama ตรง ๆ (ไม่ผ่าน Docker) |
   | `MCP_AGENT_MODEL` | ไม่ | โมเดลตัวแรกที่ติดตั้งและประกาศ capability `tools` | บังคับให้ `local_code_agent` ใช้โมเดลนี้เสมอ ไม่ต้องเดา |

2. **Build host-bridge:**

   ```bash
   pnpm --filter host-bridge build
   ```

   entry point ของ MCP server คือ `host-bridge/dist/mcp-main.js` — สั่งรันตรง ๆ ได้ด้วย
   `pnpm --filter host-bridge start:mcp` (ปกติไม่ต้องรันเอง เพราะ IDE จะเป็นคน spawn process
   นี้เองตามที่ลงทะเบียนไว้ในขั้นถัดไป)

3. **ลงทะเบียน server ใน IDE** — ดูหัวข้อ [การลงทะเบียนต่อ IDE](#การลงทะเบียนต่อ-ide) ด้านล่าง
   ตามเครื่องมือที่ใช้

4. **ตรวจสอบว่าใช้งานได้จริง** — ในแชทของ IDE เรียก tool `local_model_status` (พิมพ์ขอให้
   agent เรียก tool นี้ หรือถ้า IDE มีปุ่ม "list tools" ให้กดเรียกตรง ๆ) ควรได้ผลว่า Ollama
   ติดต่อได้, มีโมเดลที่รองรับ tools อย่างน้อยหนึ่งตัว, และ workspace root/exec allowlist
   ตรงกับที่ตั้งไว้ใน `host-bridge/.env`

## การลงทะเบียนต่อ IDE

ทุก config ด้านล่าง verify shape จริงจาก documentation ล่าสุดของแต่ละเครื่องมือ (สิงหาคม 2026)
— ที่ verify ไม่ได้จะระบุไว้ตรง ๆ แทนที่จะเดา

### Claude Code

ใช้คำสั่ง `claude mcp add` โดยระบุ path ของ `command`/`args` และตัวแปร env ด้วย `--env`:

```bash
claude mcp add --env BRIDGE_WORKSPACE_ROOT=C:\path\to\workspace \
  --env OLLAMA_BASE_URL=http://localhost:11434 \
  --transport stdio zextream-local-agent \
  -- node D:\AI\zEXtream-Application-AI\host-bridge\dist\mcp-main.js
```

หมายเหตุไวยากรณ์ที่ verify มาจาก doc จริง (ไม่ใช่จากความจำ):

- `--` (double dash) คั่นระหว่าง option ของ `claude mcp add` เอง กับคำสั่ง/argument ที่จะรัน
  server จริง ๆ ทุกอย่างหลัง `--` ถูกส่งต่อแบบไม่แตะต้อง
- `--env` รับได้หลายค่า (`KEY=value`) แต่ต้องมี option อื่นคั่นระหว่าง `--env` ตัวสุดท้ายกับชื่อ
  server เสมอ — ถ้าชื่อ server ตามหลัง `--env` ทันที CLI จะอ่านชื่อนั้นเป็นคู่ `KEY=value` อีกคู่
- ค่าเริ่มต้น (ไม่ใส่ `--scope`) คือ **local scope** — ใช้ได้เฉพาะ project ปัจจุบันและเก็บไว้ใน
  `~/.claude.json` ของผู้ใช้คนนั้นคนเดียว ไม่แชร์กับทีม ถ้าต้องการแชร์ผ่าน version control
  ให้เพิ่ม `--scope project` ซึ่งจะเขียนลง `.mcp.json` ที่ root ของ repo แทน (รูปแบบเดียวกับ
  `.mcp.json.example` ในเอกสารนี้ — คัดลอกไฟล์นั้นเป็น `.mcp.json` แล้วแก้ path ก็ใช้แทนคำสั่ง
  ข้างต้นได้เลย)

ตรวจสถานะด้วย `claude mcp list` (ควรเห็น `zextream-local-agent` เป็น `✔ Connected`) หรือใน
session ให้พิมพ์ `/mcp`

### VS Code

**ใช้ได้ตั้งแต่ VS Code 1.102 ขึ้นไป** (MCP support ออกเป็น GA ในเดือนกรกฎาคม 2025/1.102) —
เวอร์ชันก่อนหน้าอาจไม่มี UI/schema ตรงตามนี้

สร้าง `.vscode/mcp.json` ในโปรเจกต์ (คัดลอกจาก `.vscode/mcp.json.example` แล้วแก้ path) —
schema ของ VS Code ใช้ key `servers` (ไม่ใช่ `mcpServers`) และ **ต้องระบุ `"type": "stdio"`
อย่างชัดเจน** เพราะ VS Code ไม่เดา transport จาก field อื่นให้:

```json
{
  "servers": {
    "zextream-local-agent": {
      "type": "stdio",
      "command": "node",
      "args": ["D:\\AI\\zEXtream-Application-AI\\host-bridge\\dist\\mcp-main.js"],
      "env": {
        "BRIDGE_WORKSPACE_ROOT": "C:\\path\\to\\workspace",
        "OLLAMA_BASE_URL": "http://localhost:11434"
      }
    }
  }
}
```

เปิด Command Palette แล้วรัน **MCP: List Servers** เพื่อตรวจว่า VS Code เห็น server และ
connect สำเร็จ

### Cursor

สร้าง `.cursor/mcp.json` ที่ root ของโปรเจกต์ (เฉพาะโปรเจกต์นี้) หรือ `~/.cursor/mcp.json`
(ใช้ได้ทุกโปรเจกต์) — schema ของ Cursor ใช้ key `mcpServers` (เหมือน Claude Code) ไม่มี field
`type`:

```json
{
  "mcpServers": {
    "zextream-local-agent": {
      "command": "node",
      "args": ["D:\\AI\\zEXtream-Application-AI\\host-bridge\\dist\\mcp-main.js"],
      "env": {
        "BRIDGE_WORKSPACE_ROOT": "C:\\path\\to\\workspace",
        "OLLAMA_BASE_URL": "http://localhost:11434"
      }
    }
  }
}
```

ตรวจใน Cursor Settings > MCP ว่า server ขึ้นสถานะ connected และมี tool list ปรากฏ

### JetBrains / Windsurf และ MCP client อื่น ๆ

ไม่ได้ verify shape เฉพาะของสองตัวนี้ผ่าน web search ในรอบที่เขียนเอกสารนี้ — โดยหลักการ MCP
client ที่รองรับ stdio transport ทุกตัวควรรับ config รูปแบบเดียวกับ `.mcp.json.example`
(`command` + `args` + `env`) ได้ตรง ๆ แต่ให้ตรวจ documentation ของแต่ละตัวเองก่อนใช้งานจริง
แทนที่จะเดาจากเอกสารนี้

## ตัวอย่างการใช้งานจริง

จาก IDE (เช่น Claude Code หรือ Copilot Chat ใน VS Code) พิมพ์ทำนองนี้เพื่อมอบงานให้โมเดล
local:

> ใช้ tool `local_code_agent` ให้เปลี่ยนชื่อฟังก์ชัน `getUserData` เป็น `fetchUserProfile`
> ทุกจุดที่เรียกใช้ในโฟลเดอร์ `src/legacy/`

agent ของ IDE จะเรียก `local_code_agent` พร้อม `task` ตามนั้น (และอาจใส่ `path` เจาะจงโฟลเดอร์)
— โมเดล local จะวน list/search/read/write เองจนเสร็จ แล้วรายงานกลับมาเป็นรายการไฟล์ที่แก้ พร้อม
สรุปแต่ละ step

### เมื่อไหร่ควร delegate ให้โมเดล local

พูดตรง ๆ: โมเดล 14B ที่รันบนการ์ดจอเครื่องนี้ **ไม่ใช่ตัวแทนโมเดล frontier** — ความสามารถในการ
วางแผนหลาย step, เข้าใจ context ซับซ้อน หรือแก้ edge case ที่ต้องคิดเยอะ ด้อยกว่าเห็นได้ชัด
สิ่งที่คุ้มค่าจะโยนให้มันทำคืองานเชิงกลไก (mechanical) ที่ปริมาณมากแต่ไม่ต้องคิดมาก เช่น:

- rename ตัวแปร/ฟังก์ชันซ้ำ ๆ หลายจุด
- generate boilerplate ที่มี pattern ชัดเจน
- แก้ไขซ้ำ ๆ แบบเดิมในหลายไฟล์ (repetitive edits)
- scaffolding รอบแรกที่ยังต้องรีวิว/แก้ต่อแน่ ๆ

งานพวกนี้ถ้าโยนให้โมเดล cloud ที่คิดเงินต่อ token จะเสียโควตาโดยไม่จำเป็น — โยนให้โมเดล local
แทนได้ ไม่มีค่าใช้จ่ายต่อ token เลยเพราะรันบนฮาร์ดแวร์ตัวเอง แลกกับที่บางครั้งต้องลองใหม่ (retry)
เพราะโมเดลใช้ tool ผิดหรือหลุด loop ก่อนงานเสร็จ

## Security

- **Sandbox boundary เดียวกับทาง A** — ทุก path ที่ tool พวกนี้แตะถูกตรวจ containment สองรอบ
  ใน `host-bridge/src/workspace.ts` (รอบแรกบน path ที่ resolve แล้ว, รอบสองบน
  `fs.realpath`'d path เพื่อดัก symlink ที่ชี้ออกนอก sandbox) — โมเดล local ไม่มีทางแตะไฟล์นอก
  `BRIDGE_WORKSPACE_ROOT` ได้ไม่ว่าจะเข้าทาง web chat หรือ MCP
- **Exec เป็น opt-in เสมอ** — `local_code_agent` จะรันคำสั่งได้ก็ต่อเมื่อตั้ง
  `BRIDGE_EXEC_ALLOWLIST` ไว้ใน `host-bridge/.env` เท่านั้น ค่าเริ่มต้นว่างเปล่า = ปิด
  **ห้าม allowlist shell (`cmd`, `powershell`, `bash`, `sh`) เด็ดขาด** — exec spawn คำสั่งตรง ๆ
  โดยไม่ผ่าน shell ดังนั้นถ้า allowlist shell ไว้ จะเท่ากับเปิดให้รันคำสั่งอะไรก็ได้ผ่าน
  argument ของ shell นั้น (ตัว allowlist จะไม่มีความหมายอีกต่อไป)
- **MCP server ไม่มี token** — ต่างจาก HTTP bridge (`/workspace/*`, `/claude`, `/codex`) ที่ต้อง
  ใช้ `HOST_BRIDGE_TOKEN` เพราะ port นั้นเปิดรับ request จากอะไรก็ได้บนเครือข่ายของ host เครื่อง
  นั้น MCP server ไม่เปิด port เลย — มันถูก **IDE เป็นคน spawn process ผ่าน stdio โดยตรง**
  ใครก็ตามที่สั่ง spawn process นี้ได้ (เช่น มีสิทธิ์รัน IDE บนเครื่องนั้นอยู่แล้ว) คือคนที่ trust
  ได้อยู่แล้วโดยนิยาม — stdio + การที่ IDE เป็นคน launch process เองคือ trust boundary ในตัว
  มันเอง ไม่ต้องมี token ซ้อนอีกชั้น

## Troubleshooting

### Ollama ติดต่อไม่ได้

`local_model_status` จะรายงานว่าติดต่อ Ollama ไม่ได้ — ตรวจว่า Ollama เปิดอยู่จริงและ
`OLLAMA_BASE_URL` (default `http://localhost:11434`) ถูกต้อง:

```bash
curl -s http://localhost:11434/api/tags
```

### ไม่มีโมเดลที่รองรับ tool calling

`local_model_status` จะแสดงรายชื่อโมเดลที่ติดตั้งพร้อมบอกว่าตัวไหนรองรับ `tools` — ถ้าไม่มีเลย
ให้ดึงโมเดลที่รองรับมาก่อน เช่น `qwen2.5-coder:14b` แล้วตรวจซ้ำด้วยคำสั่ง `curl` ในหัวข้อ
[Prerequisites](#ข้อกำหนดเบื้องต้น-prerequisites) ด้านบน

### `BRIDGE_WORKSPACE_ROOT` ยังไม่ได้ตั้งค่า

ทุก tool ที่แตะไฟล์ (`local_workspace_*`, `local_code_agent`) จะตอบกลับเป็น error ทันที —
ตรวจว่า `host-bridge/.env` มีค่านี้ตั้งไว้จริง แล้ว build/รัน MCP server ใหม่ (ตัวแปร env
ถูกอ่านตอน process เริ่มทำงาน ไม่ hot-reload)

### Server ขึ้นใน IDE แต่ทุก call ล้มเหลว

สาเหตุที่พบบ่อยที่สุดคือ path ผิด — ตรวจว่า `args` ใน config ชี้ไปยัง
`host-bridge/dist/mcp-main.js` ที่ build แล้วจริง (ไม่ใช่ `src/mcp-main.ts` ที่ยังไม่ compile)
และ path เป็น absolute path ตรงกับเครื่องที่รัน IDE จริง ๆ (ไม่ใช่ path ตัวอย่างที่คัดลอกมาโดย
ไม่แก้)

### VRAM ตึง ทำให้ tool loop ช้าลงเรื่อย ๆ

การ์ดจอ 16 GB รองรับโมเดล 14B แบบ Q4 ที่ context 32k ได้พอดี (ราว 93% GPU / 7% CPU ตอนโหลด) —
loop ที่ยาว (หลาย step ของ `local_code_agent`) จะสะสม context ขึ้นเรื่อย ๆ และดัน CPU spill
มากขึ้นตามไปด้วย ทำให้แต่ละ step ช้าลง ก่อนจะสรุปว่า loop มีปัญหา ให้ลองลด `num_ctx` ของ Ollama
ลงก่อน — อาการช้าที่เพิ่มขึ้นเรื่อย ๆ ระหว่าง loop มักมาจากตรงนี้มากกว่าตัว loop เอง
