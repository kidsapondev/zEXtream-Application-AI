# Local Coder

Terminal IDE ที่ปุ่ม "เขียนโค้ดให้หน่อย" คือโมเดลที่รันบนการ์ดจอเครื่องนี้

พิมพ์บอกว่าอยากได้อะไร โมเดลในเครื่องจะอ่าน/เขียนไฟล์จริงให้ แล้วแสดงทุก tool call
ที่มันเรียกออกมาเป็นรายการ — เพื่อให้ตรวจงานได้จริง ไม่ใช่แค่เชื่อคำรายงานของมัน

## นี่คือทางเข้าที่สามของ subsystem เดิม

โมเดลตัวเดียวกัน sandbox เดียวกัน ต่างกันแค่ว่าใครขับ loop:

| ทางเข้า | ใครขับ loop |
|---|---|
| หน้าแชทเว็บของโปรเจกต์ | NestJS backend |
| IDE ที่รองรับ MCP (VS Code, Cursor, Claude Code) | IDE นั้น ๆ |
| **แอปนี้** | แอปนี้ ผ่าน MCP client ของตัวเอง |

**ไม่มีการเขียน tool loop หรือ sandbox ชุดใหม่** — แอปนี้เป็น MCP client ที่ spawn
`host-bridge/dist/mcp-main.js` ตัวเดิม path containment, exec allowlist, tool loop และ
text-tool-call recovery ถูกใช้ซ้ำทั้งหมด รายละเอียดทั้งหมดอยู่ใน
[`../.claude/skills/gpu-workspace-coding/SKILL.md`](../.claude/skills/gpu-workspace-coding/SKILL.md)

## ติดตั้ง

ต้องมี Python 3.13+ และ Node 24+ และ host-bridge ที่ build แล้ว

```
pnpm --filter host-bridge build
cd ide
python -m pip install --user -e .
```

การติดตั้งแบบ `-e` จำเป็น ไม่ใช่ทางเลือก — package อยู่ใน `src/` ถ้าไม่ติดตั้ง
`python -m local_coder` จะหาไม่เจอ (ส่วน `pythonpath` ใน `pyproject.toml` ใช้กับ pytest เท่านั้น)

ตั้งค่า sandbox ใน `host-bridge/.env` (แอปอ่านไฟล์นี้เอง ไม่ต้องตั้ง env ในเชลล์):

```
BRIDGE_WORKSPACE_ROOT=D:\path\to\โฟลเดอร์ที่ยอมให้โมเดลแตะ
BRIDGE_EXEC_ALLOWLIST=git,npm,pnpm,node,python
MCP_AGENT_MODEL=qwen2.5-coder:14b
```

## รัน

ดับเบิลคลิก **`local-coder.bat`** ที่ root ของ repo — ตัวมันจะตรวจ Python, MCP server ที่ build แล้ว,
`host-bridge/.env` และ Ollama ให้ก่อน แล้วบอกวิธีแก้ถ้าขาดอะไร

หรือรันเองจากเชลล์:

```
cd ide
python -m local_coder
```

| ปุ่ม | ทำอะไร |
|---|---|
| พิมพ์ในช่องล่างแล้ว Enter | ส่งงานให้โมเดลในเครื่องทำ |
| `ctrl+s` | บันทึกไฟล์ที่เปิดอยู่ |
| `ctrl+r` | โหลด tree ใหม่ |
| `ctrl+l` | ไปที่ช่องพิมพ์งาน |
| `ctrl+q` | ออก |

## Log

ทุก session เขียน transcript ไว้ที่ `logs/ide/<วันเวลา>.txt` และทุกครั้งที่สั่งงานผ่าน
`scripts/delegate.mjs` จะเขียนไว้ที่ `logs/delegate/` — เพราะการสั่งงานคือการมอบสิทธิ์เขียนไฟล์
ให้โมเดลที่ไม่มีใครนั่งดู scrollback ของ terminal หายไปเมื่อปิดหน้าต่าง แต่ไฟล์ยังอยู่

## เทสต์

```
cd ide
python -m pytest -q
```

เทสต์ทั้งชุดรันโดยไม่แตะ Ollama ไม่ spawn subprocess และไม่แตะไฟล์จริงเลย — ใช้ `FakeBackend`
ใน `tests/conftest.py` แทน จึงรันจบในไม่ถึงวินาที ซึ่งจำเป็น เพราะเทสต์คือสัญญาณเดียวที่บอก
โมเดลว่างานที่มันเพิ่งเขียนใช้ได้หรือไม่

## โครงสร้าง

| ไฟล์ | หน้าที่ | ใครเขียน |
|---|---|---|
| `protocols.py` | สัญญาทุกอย่างที่โมดูลอื่นยึด | Claude |
| `mcp_client.py` | คุย JSON-RPC กับ MCP server ผ่าน stdio | Claude |
| `workspace.py` | โครงต้นไม้ไฟล์ + cache | **โมเดลในเครื่อง** |
| `history.py` | ประวัติการสั่งงานใน session | **โมเดลในเครื่อง** |
| `diff.py` | unified diff พร้อมเลขบรรทัดสองฝั่ง | Claude (โมเดลทำพลาดตรงเลขบรรทัด) |
| `errors.py` | แปลง error เป็นข้อความที่บอกวิธีแก้ | Claude |
| `app.py` | ประกอบทั้งหมด + เส้นทางความผิดพลาด | Claude |

การแบ่งนี้ไม่ใช่เรื่องบังเอิญ — งานที่มีกฎชัดและมีเทสต์รออยู่ delegate ได้ ส่วนการออกแบบ
interface และการต่อชิ้นส่วนเข้าด้วยกันคือจุดที่โมเดลเล็กพลาดแล้วพังทั้งระบบ
