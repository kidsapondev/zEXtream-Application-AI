# zEXtream-Application-AI — แผนงานและสถานะโครงการ

เอกสารนี้สรุปสิ่งที่พัฒนาเสร็จแล้ว งานที่ยังต้องตรวจยืนยัน และงานที่ควรทำต่อ โดยอ้างอิงจาก source code ปัจจุบัน, Git history, Claude session เดิม, Docker task output และผล build/test ที่ตรวจล่าสุด

อัปเดตสถานะล่าสุด: 11 กรกฎาคม 2026 (Asia/Bangkok)

## สัญลักษณ์สถานะ

- `[x]` เสร็จแล้วและมี source code อยู่ใน repository
- `[~]` ทำแล้วบางส่วน แต่ยังขาดการทดสอบหรือมี defect ที่ต้องแก้
- `[ ]` ยังไม่ได้ทำ
- `P0` ต้องแก้ก่อนใช้งานจริง เพราะกระทบ security หรือข้อมูลผู้ใช้
- `P1` ต้องแก้ก่อนถือว่า feature สมบูรณ์
- `P2` งานเพิ่มคุณภาพ ความสะดวก หรือ production readiness

## สรุปภาพรวม

| Phase   | งาน                                         | สถานะ | หมายเหตุ                                                  |
| ------- | ------------------------------------------- | ----- | --------------------------------------------------------- |
| Phase 0 | Repository และ project foundation           | `[x]` | Monorepo, pnpm, Docker และเอกสารหลักพร้อมแล้ว             |
| Phase 1 | PostgreSQL และ Prisma                       | `[x]` | Schema และ migrations หลักพร้อมใช้งาน                     |
| Phase 2 | Authentication และ users                    | `[x]` | Auth P0 ทั้งหมดปิดแล้ว (atomic rotation, timing-safe login, rate limiting, trusted proxy); เหลือเฉพาะ integration test coverage เพิ่มเติม |
| Phase 3 | Angular shell และ design system             | `[x]` | Login/register/layout, design system, session management UI (rename/archive/delete), toasts, responsive layout, accessibility pass เสร็จแล้ว |
| Phase 4 | Chat session และ Ollama streaming           | `[x]` | Backend streaming correctness (concurrency/timeout/disconnect/malformed line) และ frontend state race (stale response/dedup/scroll/connection banner) เสร็จแล้ว; เหลือ WS integration test suite |
| Phase 5 | Code artifacts และ Monaco Editor            | `[~]` | Source และ Docker build ผ่าน, live-verified end-to-end; เหลือ artifact ownership integration tests |
| Phase 6 | Claude/OpenAI และ provider settings         | `[~]` | Claude/OpenAI providers, registry, capability metadata, per-user gating, connection-test endpoint implemented; เหลือ model-selector UI และ provider integration tests กับ mocked upstream |
| Phase 7 | Security hardening และ production readiness | `[~]` | Helmet/CSP, CORS allowlist, audit log, structured logging, health checks, metrics, backup/restore (ทดสอบจริงแล้ว) เสร็จ; เหลือ WS rate limiting, deployment section (ต้องตัดสินใจ infra) |

## สถานะ Repository

### Canonical working copy

- Path: `D:\AI\zEXtream-Application-AI`
- Branch: `main`
- Remote: `https://github.com/kidsapondev/zEXtream-Application-AI.git`
- Commit ล่าสุด ณ เวลาอัปเดตแผน: `46a0dd3` — `[EDIT] Plan`
- Local branch ตรงกับ `origin/main`

### Working copy เดิมที่เลิกใช้

- Path: `D:\AI\chat-workspace`
- ห้ามแก้ source ต่อใน directory นี้ เพื่อป้องกัน source แยกจาก canonical working copy

### งานจัดระเบียบ Repository

- [x] กำหนด `D:\AI\zEXtream-Application-AI` เป็น canonical working copy
- [x] กำหนดให้หยุดแก้ source ใน `D:\AI\chat-workspace`
- [~] ตรวจ `login.md`; หากมี credential จริงให้ลบจาก Git history และเปลี่ยนรหัสผ่าน (เป็น test credential เท่านั้น (`test3@example.com`), ลบออกจาก tracked files และ `.gitignore` แล้วโดย session ก่อนหน้า, ลบไฟล์ untracked ที่ค้างอยู่ใน working copy แล้ว; ยังไม่ได้ rewrite Git history เพราะเป็น destructive operation ที่ต้องยืนยันจากผู้ใช้ก่อน — commit `0e58258` ยังมี blob นี้อยู่)
- [x] เพิ่ม `.idea/` ลง `.gitignore` หากไม่ต้องการแชร์ IDE configuration

เกณฑ์รับงาน:

- เหลือ working copy หลักเพียงตำแหน่งที่ทีมตกลงกัน
- branch หลักตรงกับ remote
- `git status` สะอาดหลัง sync
- ไม่มี credential จริงอยู่ใน tracked files หรือ Git history

---

## Phase 0 — Project foundation

### เสร็จแล้ว

- [x] สร้าง pnpm workspace
- [x] แยก package เป็น `frontend`, `backend` และ `packages/shared-types`
- [x] กำหนด Node.js 24+ และ pnpm 11
- [x] สร้าง Dockerfiles สำหรับ frontend และ backend
- [x] สร้าง Docker Compose base, development override และ production override
- [x] ตั้ง PostgreSQL health check
- [x] แยก migration service ให้รัน `prisma migrate deploy` ก่อน backend
- [x] ตั้ง Nginx ให้เสิร์ฟ Angular และ proxy `/api/` กับ `/ws/`
- [x] ตั้ง Angular development proxy
- [x] เพิ่ม root `.gitignore` สำหรับ `node_modules` และ build outputs ทุก workspace
- [x] เพิ่ม `README.md` ภาษาไทยแบบละเอียด
- [x] Backend production build ผ่าน
- [x] Frontend production build ผ่าน

### ต้องปรับปรุง

- [x] เพิ่ม root scripts สำหรับ build/test/lint ทั้ง workspace เช่น `build`, `test`, `lint`, `check`
- [x] เพิ่ม CI pipeline เพื่อรัน install, generate Prisma, build, test และ lint ทุก commit (`.github/workflows/ci.yml`)
- [x] กำหนด line-ending policy ด้วย `.gitattributes` เพื่อลด warning LF/CRLF บน Windows
- [ ] กำหนด license ให้ชัดเจน หรือยืนยันว่าเป็น proprietary project (ต้องตัดสินใจโดยเจ้าของโปรเจกต์)
- [x] ลบ Nest/Angular starter README ที่ไม่เกี่ยวข้อง หรือเปลี่ยนให้ลิงก์กลับ root README

เกณฑ์รับงาน:

- คำสั่งตรวจทั้ง repository รันได้จาก root เพียงคำสั่งเดียว
- CI ผ่านบน clean checkout
- ไม่มี generated output หรือ dependency directory ถูก track

---

## Phase 1 — Database และ Prisma

### เสร็จแล้ว

- [x] สร้าง `User` และ `RefreshToken`
- [x] สร้าง `ChatSession` และ `Message`
- [x] สร้าง `CodeArtifact` พร้อม revision chain
- [x] เพิ่ม enums สำหรับ user role, provider, message role, stream status และ artifact origin
- [x] กำหนด cascade delete จาก user → sessions → messages/artifacts
- [x] เพิ่ม indexes สำหรับ session list, message history และ artifact revisions
- [x] เพิ่ม unique constraint `(sessionId, filename, revision)`
- [x] เพิ่ม migrations สำหรับ auth, chat/messages และ code artifacts
- [x] เชื่อม Prisma ผ่าน PostgreSQL adapter
- [x] เชื่อม Prisma lifecycle กับ NestJS module

### ต้องทำต่อ

- [ ] เพิ่ม integration test ที่รัน migrations บน database ว่าง
- [ ] ทดสอบ cascade delete ของ user/session/message/artifact
- [ ] ตรวจ compatibility ของ `uuidv7()` กับ PostgreSQL environment ทุกแห่งที่จะ deploy
- [x] เพิ่ม cleanup policy สำหรับ refresh tokens ที่หมดอายุหรือ revoked แล้ว (`RefreshTokenCleanupService` ดู Phase 7 → Reliability)
- [ ] พิจารณา pagination สำหรับ messages, sessions และ artifact revisions
- [ ] ปรับ `listLatestForSession()` ให้ query เฉพาะ revision ล่าสุดจาก database แทนโหลดทุก revision เข้า memory

เกณฑ์รับงาน:

- migration deploy ผ่านทั้ง database ใหม่และ database ที่มี migration เดิม
- integration tests ยืนยัน constraints และ cascade behavior
- query session/artifact ยังตอบสนองได้เมื่อมีข้อมูลจำนวนมาก

---

## Phase 2 — Authentication และ User management

### เสร็จแล้ว

- [x] Register ด้วย email, password และ display name
- [x] Normalize email เป็น lowercase และ trim ก่อน query/create
- [x] Hash password ด้วย Argon2id
- [x] Login ด้วย Passport local strategy
- [x] Access JWT ผ่าน Bearer token
- [x] Refresh JWT ผ่าน httpOnly cookie
- [x] Refresh-token family และ replacement chain
- [x] Revoke token ตอน logout
- [x] ตรวจ token reuse และ revoke token family
- [x] ตรวจ `isActive` ตอน login/refresh
- [x] Global access-token guard สำหรับ REST endpoints
- [x] Public decorator สำหรับ health และ auth endpoints
- [x] Frontend เก็บ access token ใน memory
- [x] Frontend app initializer ลอง refresh ตอน hard reload
- [x] HTTP interceptor refresh และ retry เมื่อเจอ `401`
- [x] ป้องกัน refresh request ซ้ำพร้อมกันภายใน browser tab เดียว
- [x] มี `/api/users/me`

### P0 — ต้องแก้ก่อนใช้งานจริง

- [x] ทำ refresh-token rotation ให้เป็น atomic transaction
  - lock หรือ conditional update token เดิมว่า `revokedAt` ต้องยังเป็น `null`
  - สร้าง token ใหม่และ revoke token เดิมใน transaction เดียว
  - ป้องกันหลาย browser tabs refresh token เดียวกันพร้อมกันแล้วได้ token ใหม่หลายใบ
- [x] ตรวจ `tokenHash` กับ refresh token ที่ได้รับจริง หรือถ้าไม่ใช้ให้ทบทวน design และลบ field ที่ทำให้เข้าใจผิด
- [x] เปลี่ยน duplicate-email response จาก `UnauthorizedException` เป็น `ConflictException`
- [x] ป้องกัน account enumeration ด้วยข้อความและ timing ที่เหมาะสม
- [x] เพิ่ม rate limiting ให้ register, login และ refresh
- [x] ตรวจ trusted proxy/IP handling ก่อนบันทึก `req.ip` ใน production

### P1 — Tests ที่ต้องเพิ่ม

- [ ] Register สำเร็จและ duplicate email
- [ ] Login รหัสผ่านถูก/ผิด และ inactive user
- [ ] Refresh สำเร็จ
- [ ] Refresh token หมดอายุ
- [ ] Refresh token reuse detection
- [x] Concurrent refresh สอง request
- [ ] Logout แล้ว refresh ไม่ได้
- [ ] Hard reload แล้ว restore session ได้
- [x] หลาย tab ใช้ refresh cookie เดียวกัน

เกณฑ์รับงาน:

- token เดิมหมุนได้สำเร็จเพียงครั้งเดียว
- concurrent refresh ไม่สร้าง valid descendants มากกว่าหนึ่งเส้นทาง
- logout และ reuse detection revoke token ตาม policy ที่กำหนด
- auth integration tests ผ่านทั้งหมด

---

## Phase 3 — Frontend shell และ Design system

### เสร็จแล้ว

- [x] Angular standalone application
- [x] Zoneless change detection
- [x] Route `/login`, `/register`, `/chat`, `/chat/:sessionId`
- [x] Auth guard และ return URL หลัง login
- [x] Login form พร้อม validation และ loading state
- [x] Register form พร้อม validation และ loading state
- [x] App shell, icon rail และ secondary sidebar
- [x] Design-system components ได้แก่ badge, card, page header, segmented tabs และ stat card
- [x] Chat session sidebar
- [x] New chat และ logout actions
- [x] Responsive split layout สำหรับ chat/editor
- [x] Shared styles และ design tokens

### ต้องทำต่อ

- [x] เพิ่ม route `/settings/providers` หรือซ่อนปุ่ม settings จนกว่า Phase 6 จะพร้อม
- [x] เพิ่ม rename/archive/delete session controls ใน UI (`session-list-item.component.ts` — inline rename, archive hides session from the active list via existing `isArchived` update endpoint, no new "archived view" added since none was requested)
- [x] เพิ่ม confirmation ก่อนลบ session (`ds-confirm-dialog` — focus-trapped, closes on Escape/backdrop, wired to delete only)
- [x] เพิ่ม loading, empty และ error states ที่สม่ำเสมอ (session list loading/empty, chat thread loading/empty/error, shared `.hint`/`.hint--error` styles)
- [x] เพิ่ม toast/notification service (`ToastService` + `ds-toast-stack`, mounted in `app.html`; wired into rename/archive/delete, provider save/remove, and WS `exception` events)
- [x] เพิ่ม accessibility: labels, focus management, keyboard navigation และ ARIA states (icon-button `aria-label`s, confirm-dialog focus trap/Escape, code-editor tab-close converted from a non-semantic nested `<span>` to a real sibling `<button>`)
- [x] เพิ่ม mobile layout และตรวจ split-pane บนหน้าจอเล็ก
- [x] เพิ่ม frontend component/store tests (`chat.store.spec.ts`, `session-list.store.spec.ts`, `toast.service.spec.ts`, extended `socket.service.spec.ts`)

เกณฑ์รับงาน:

- ไม่มีปุ่มที่นำไป dead route
- ทุก async action มี loading และ error feedback
- navigation ใช้งานได้ด้วย keyboard
- responsive layout ผ่าน viewport หลักที่กำหนด

---

## Phase 4 — Chat session และ Ollama streaming

### เสร็จแล้ว

- [x] REST API สำหรับ list/create/update/delete session
- [x] ตรวจ ownership ก่อนอ่าน แก้ไข หรือลบ session ผ่าน REST
- [x] โหลด message history ตาม session
- [x] Reconcile message ที่ค้าง `streaming` เป็น `error` ตอนโหลด history
- [x] Shared WebSocket event contracts
- [x] Socket.IO gateway ที่ path `/ws/socket.io`
- [x] ตรวจ access token ตอน WebSocket connection
- [x] Join/leave room ตาม session
- [x] บันทึก user message และ assistant placeholder
- [x] Ollama provider adapter
- [x] Stream token จาก Ollama ไปยัง frontend
- [x] Stop generation ด้วย `AbortController`
- [x] บันทึกสถานะ `complete`, `error` และ `stopped`
- [x] Chat UI แสดงข้อความและสถานะ generating/error
- [x] Docker rebuild ของ Phase 4/5 ผ่าน

### P0 — Security และ session lifecycle

- [x] ตรวจ ownership ใน `chat:stop`
  - query message และ session owner ก่อน abort
  - ไม่ให้ user หนึ่งหยุด stream ของอีก user แม้ทราบ message ID
- [x] Disconnect socket ตอน logout
- [x] Reconnect/re-authenticate socket เมื่อ login เป็น user ใหม่
- [x] ออกแบบการ refresh token สำหรับ socket reconnect เมื่อ access token หมดอายุ
- [x] ตรวจว่า global REST auth guard ไม่รบกวน WebSocket handlers และเพิ่ม gateway-specific guard/test ให้ชัดเจน
- [x] Validate WebSocket payloads แทนการเชื่อ type จาก client
- [x] จำกัดขนาด `content`, `model`, filename และ artifact content

### P1 — Streaming correctness

- [x] ครอบ streaming pipeline ด้วย `catch` ที่ finalize message ทุก failure path
- [x] ย้าย `getProvider()`, registry setup และ parser processing เข้า error boundary เดียวกัน
- [x] หาก provider ไม่มีอยู่ ให้ reject ก่อนสร้าง assistant message หรือ finalize เป็น `error`
- [x] ป้องกัน send ซ้อนหลาย stream ใน session เดียว หรือกำหนด concurrency policy ให้ชัดเจน (`ActiveStreamRegistry.hasActiveStream()`/`register(messageId, sessionId)`; นโยบายคือ 1 stream ต่อ session เอกสารไว้ใน doc comment ของ `ActiveStreamRegistry`)
- [x] ยกเลิก active streams ก่อนลบ session (`ActiveStreamRegistry.stopAllForSession()` เรียกจาก `ChatSessionsService.remove()`)
- [x] จัดการ client disconnect ระหว่าง stream (`ChatGateway` implements `OnGatewayDisconnect`; ยืนยันด้วย regression test ว่า `finalizeAssistantMessage`/emit ยังทำงานแม้ client ที่เริ่ม stream disconnect ระหว่างทาง)
- [x] กำหนด timeout สำหรับ Ollama request และ stream inactivity (`OLLAMA_CONNECT_TIMEOUT_MS` 10s, `OLLAMA_STREAM_INACTIVITY_TIMEOUT_MS` 30s ใน `ollama.provider.ts`)
- [x] ตรวจ malformed/non-JSON lines จาก Ollama โดยไม่ทำให้ message ค้าง (skip บรรทัดที่ parse ไม่ได้และ stream ต่อ แทนที่จะ fail ทั้ง stream; มี test คุม)
- [x] ปรับ session title อัตโนมัติจากข้อความแรก หากต้องการ UX แบบ chat application (`deriveSessionTitle()` ใน `chat.gateway.ts` + `ChatSessionsService.setTitleIfDefault()`)

### P1 — Frontend state race

- [x] ป้องกัน HTTP response ของ session เก่าเขียนทับ session ใหม่ (`ChatStore.loadSession()` ใช้ generation counter + session-id guard ก่อน `.set(history)`, ตาม pattern เดิมใน `ArtifactStore`)
- [x] Deduplicate message เมื่อ REST history และ socket event มาถึงใกล้กัน (`ChatStore.upsertMessage()` key ด้วย message id ทั้ง `chat:message:created` และ `chat:message:updated`)
- [x] Disable หรือควบคุม Send ขณะกำลังส่ง/stream ตาม concurrency policy (`ChatStore.isStreaming` computed จาก `streamingStatus === 'streaming'`; composer's Send ปิดใช้งาน, Stop ยังกดได้เสมอ)
- [x] แสดงสถานะ socket disconnected/reconnecting (`SocketService.connectionState` signal ผูกกับ Socket.IO connect/disconnect/reconnect events; banner ใน `chat-workspace.component.html`)
- [x] แสดง upstream error ที่เข้าใจง่าย (`message.errorMessage` ยังแสดงใน chat thread เหมือนเดิม; error ที่เกิดก่อนสร้าง message เช่น "no API key" หรือ "stream already in progress" มาเป็น WS `exception` event และ toast ผ่าน `ChatStore`)
- [x] Scroll ไปข้อความล่าสุดอย่างเหมาะสม (`ChatThreadComponent` ใช้ `afterRenderEffect` + scroll-position threshold — auto-scroll เฉพาะเมื่อผู้ใช้อยู่ใกล้ล่างสุดอยู่แล้ว)

### Tests ที่ต้องเพิ่ม

- [ ] WebSocket connection ด้วย token ถูกต้อง/ผิด/หมดอายุ
- [ ] Join session ตัวเองและปฏิเสธ session ของ user อื่น
- [ ] Send → created → token → updated ครบลำดับ
- [ ] Stop generation ของตัวเอง
- [ ] ปฏิเสธ stop generation ของ user อื่น
- [ ] Ollama unavailable, HTTP error, malformed stream และ timeout
- [ ] Server restart แล้ว reconcile stuck message
- [ ] Logout/login คนละบัญชีใน browser instance เดิม

เกณฑ์รับงาน:

- ทุก assistant message จบด้วย `complete`, `stopped` หรือ `error`
- ไม่มี message ค้าง `streaming` จาก application exception ปกติ
- socket identity ตรงกับ user ปัจจุบันเสมอ
- cross-user WebSocket tests ถูกปฏิเสธทั้งหมด

---

## Phase 5 — Code artifacts และ Monaco Editor

### เสร็จแล้ว

- [x] เพิ่ม `CodeArtifact` schema และ migration
- [x] เพิ่ม `ArtifactsModule`, controller และ service
- [x] List revision ล่าสุดของแต่ละ filename
- [x] List revision history ตาม filename
- [x] สร้าง revision พร้อม `parentArtifactId`
- [x] เพิ่ม system prompt convention `language:relative/path.ext`
- [x] สร้าง incremental `ArtifactStreamParser`
- [x] แยก prose ออกจาก fenced code ระหว่าง AI stream
- [x] Emit artifact start/chunk/end events
- [x] บันทึก AI artifact เมื่อ fence จบ
- [x] สร้าง Monaco loader และ editor wrapper
- [x] เพิ่ม Monaco assets ใน Angular build
- [x] เพิ่ม artifact store
- [x] เพิ่ม file tabs และ split-pane editor
- [x] เพิ่ม Monaco diff editor component
- [x] สร้าง user revision เมื่อแก้เนื้อหา
- [x] Backend และ frontend build ผ่าน
- [x] Docker image rebuild และ restart สำเร็จ

### ยังไม่ได้ยืนยันจาก Claude session เดิม

- [x] ทดสอบ end-to-end ด้วย prompt ที่ทำให้ Ollama ตอบ fenced code จริง
- [x] ยืนยันว่า code ปรากฏใน Monaco แบบ progressive streaming
- [x] ยืนยัน artifact row และ revision ถูกบันทึกถูกต้องใน PostgreSQL
- [x] ยืนยัน reload session แล้วยังเห็นไฟล์ล่าสุด
- [x] ยืนยัน user edit สร้าง revision และ diff ถูกต้อง
- [x] ทดสอบ stop generation กลาง code fence
- [x] ทดสอบ malformed/unterminated/multiple code fences

### P0/P1 — Defects ที่ต้องแก้

- [x] นำ artifact revision ล่าสุดกลับเข้า AI context
  - ปัจจุบัน history ส่งเฉพาะ `Message.content`
  - code ถูกแยกออกจาก message จึงหายจาก context รอบถัดไป
  - ต้องกำหนดรูปแบบ context ที่รวม filename, language และ content ล่าสุด
- [x] รวม user-edited artifact เข้า context ก่อน follow-up generation
- [x] Debounce การ save จาก Monaco
  - ปัจจุบันทุก keystroke สร้าง WebSocket event และ database revision
  - กำหนด debounce เช่น 500–1000 ms หรือใช้ explicit Save
- [x] ทำ revision creation ให้ concurrency-safe
  - ป้องกันสอง request อ่าน latest revision เดียวกันแล้ว insert revision number ซ้ำ
  - ใช้ transaction isolation, advisory lock, counter หรือ retry unique conflict
- [x] กรอง artifact socket events ด้วย current session ID
- [x] ป้องกัน stale artifact HTTP response ตอนเปลี่ยน session
- [x] แก้ parser ให้ยอมรับ closing fence ที่ EOF โดยไม่มี newline
- [x] กำหนด behavior เมื่อ stream หยุดกลาง fence: save partial, discard หรือ mark incomplete
- [x] Sanitize/normalize filename และป้องกัน path traversal หากอนาคตเขียนไฟล์ลง filesystem
- [x] จำกัดขนาดและจำนวน artifacts ต่อ message/session
- [x] ใช้ revision จริงจาก server ใน `artifact:stream:end` แทนสร้าง DTO revision `0` ฝั่ง client
- [x] Dispose Monaco diff models เมื่อเปลี่ยน model/destroy เพื่อป้องกัน memory leak

### Artifact E2E test matrix

| กรณี                           | ผลที่คาดหวัง                                                       |
| ------------------------------ | ------------------------------------------------------------------ |
| Fence มี language และ filename | สร้างไฟล์ชื่อตรงตาม fence                                          |
| Fence ไม่มี filename           | สร้าง `snippet-1.<ext>`                                            |
| Fence ไม่มี language           | ใช้ `text`/`txt`                                                   |
| หลาย fences คนละไฟล์           | สร้าง artifact แยกทุกไฟล์                                          |
| ไฟล์ชื่อเดิมรอบถัดไป           | revision เพิ่มและ parent ถูกต้อง                                   |
| Closing fence แบ่งข้าม token   | parser ยังปิด block ถูกต้อง                                        |
| Closing fence ไม่มี newline    | ไม่เก็บ backticks เข้า content                                     |
| Stop กลาง fence                | จบตาม policy ที่กำหนดและไม่ค้าง streaming                          |
| User แก้หลายครั้งรวดเร็ว       | ไม่มี unique conflict และไม่สร้าง revision ทุก keystrokeเกินจำเป็น |
| Reload browser                 | โหลด revision ล่าสุดถูกต้อง                                        |
| Follow-up “แก้ไฟล์เดิม”        | AI ได้รับ artifact content ล่าสุดใน context                        |

เกณฑ์รับงาน Phase 5:

- artifact streaming ผ่าน E2E matrix
- revision ไม่มี duplicate/conflict ภายใต้ concurrent edits
- follow-up prompt เห็น code ล่าสุด
- stop/error ไม่ทิ้ง temporary artifact หรือ streaming message ค้าง

---

## Phase 6 — Claude/OpenAI providers และ Settings

### สิ่งที่มีแล้ว

- [x] Type `AiProviderKey` มี `ollama`, `claude`, `openai`
- [x] Prisma enum รองรับทั้งสาม provider
- [x] Provider interface และ factory pattern มีแล้ว
- [x] Environment มี `API_KEY_ENCRYPTION_KEY` placeholder

### งานที่ต้องทำ

- [ ] ออกแบบ provider configuration model ต่อ user
- [x] เลือก encryption format สำหรับ API key แบบ authenticated encryption
- [x] Validate `API_KEY_ENCRYPTION_KEY` เป็น key length/encoding ที่ถูกต้อง ไม่ใช่เพียง non-empty string
- [x] สร้าง service สำหรับ encrypt/decrypt/rotate API keys
- [x] ห้ามคืน decrypted key ผ่าน API หรือ log
- [x] Implement OpenAI provider (`backend/src/ai/providers/openai.provider.ts`, SSE parsing + error mapping)
- [x] Implement Claude provider (`backend/src/ai/providers/claude.provider.ts`, Anthropic SSE event parsing + error mapping)
- [x] Register providers ใน `AiModule` และ `AiProviderFactory`
- [x] เพิ่ม provider capability metadata เช่น models, streaming, max tokens (`ProviderSettingsService.listForUser()` คืน `models: string[]` ต่อ provider แล้ว; ollama ว่างเพราะไม่มี fixed catalog)
- [x] เพิ่ม `/settings/providers` route และ page
- [~] เพิ่ม wizard/modal สำหรับเพิ่ม API key และทดสอบ connection (มี API key form แล้ว; backend connection-test endpoint พร้อมแล้ว — `POST /api/settings/providers/:provider/test`; ฝั่ง UI ยังไม่ได้ต่อปุ่ม test เข้ากับ endpoint นี้)
- [ ] เพิ่ม model selector ตอนสร้างหรือแก้ session (ยังเป็นงาน frontend UI; backend มีเฉพาะ model catalog ให้เลือกใช้แล้วผ่าน `models` field ด้านบน)
- [x] จำกัด DTO ให้เลือกเฉพาะ provider ที่ configured และ runtime รองรับ (`ENABLED_PROVIDERS` ขยายเป็นทั้งสาม provider ที่ runtime รองรับ + per-user key check ใน `ChatSessionsService.create()` และ `ChatGateway.onChatSend()` ผ่าน `ProviderSettingsService`)
- [x] เพิ่ม endpoint ทดสอบ provider โดยไม่เปิดเผย key (`POST /api/settings/providers/:provider/test`)
- [x] เพิ่ม key update/delete และ revocation flow
- [x] เพิ่ม error mapping ของแต่ละ provider (401/403 → invalid key, 429 → rate limited, 5xx → temporarily unavailable, อื่น ๆ → HTTP status/upstream message)
- [x] เพิ่ม tests ด้วย mocked upstream responses (`claude.provider.spec.ts`, `openai.provider.spec.ts`, เพิ่มเติมใน `provider-settings.service.spec.ts`; ไม่มี real network call)

เกณฑ์รับงาน:

- user บันทึกและลบ API key ได้โดยไม่มี plaintext key ใน database/log/response
- provider ทั้งสาม stream ผ่าน interface เดียวกัน
- session ไม่สามารถเลือก provider ที่ยังไม่ได้ configure
- settings route ไม่เป็น dead route

---

## Phase 7 — Security hardening และ Production readiness

### Security

- [x] เพิ่ม Helmet และกำหนด CSP ให้รองรับ Monaco อย่างปลอดภัย — Helmet ใน `backend/src/main.ts` (default-deny CSP, API ตอบ JSON เท่านั้นจึง CSP มีผลจำกัด) และ CSP เต็มรูปแบบ (รวม `worker-src blob: data:` และ `style-src 'unsafe-inline'` สำหรับ Monaco) ใน `frontend/nginx.conf` ซึ่งเป็นจุดที่เสิร์ฟ HTML จริง
- [ ] เพิ่ม rate limiting สำหรับ REST และ WebSocket events — REST เสร็จแล้ว (throttle เดิมบน auth + เพิ่มใหม่บน `POST /api/chat/sessions`); **WebSocket ยังไม่มี** เพราะ `ThrottlerGuard` ของ NestJS ไม่ครอบ `@SubscribeMessage` handlers และการ implement per-socket token-bucket ต้องแก้ `backend/src/realtime/chat.gateway.ts` ซึ่งเป็นไฟล์ที่อีก agent กำลังแก้ไขพร้อมกันอยู่ ทิ้งไว้เป็น follow-up
- [x] เพิ่ม request/body size limits — จำกัด JSON/urlencoded body ที่ 256kb ผ่าน `app.useBodyParser()` ใน `main.ts`
- [x] เพิ่ม WebSocket event validation pipe/schema — มีอยู่แล้วจากรอบก่อนหน้า (`@UsePipes(ValidationPipe)` + `WsValidationFilter` ใน `chat.gateway.ts`) ตรวจสอบแล้วว่ายังอยู่
- [x] กำหนด CORS allowlist แทนค่า origin เดียวแบบคลุมเครือ — `CORS_ORIGIN` รองรับ comma-separated list พร้อม validate ด้วย zod, ค่าว่างจะปิด CORS แทนที่จะ fallback เป็น allow-all
- [x] เพิ่ม secure headers ใน Nginx — `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, CSP ใน `frontend/nginx.conf`
- [x] บังคับ HTTPS ใน production — redirect ตาม `X-Forwarded-Proto` ใน `frontend/nginx.conf` (ไม่ terminate TLS เอง เพราะ repo ไม่ได้ provision cert)
- [x] ตรวจ cookie flags ใน topology จริง — ตรวจแล้วว่า `secure: NODE_ENV === 'production'` ใน `auth.controller.ts` ถูกต้อง สอดคล้องกับการบังคับ HTTPS ข้างต้น ไม่ต้องแก้
- [ ] เพิ่ม account lockout/backoff ที่ไม่เปิดช่อง DoS — ตัดสินใจไม่เพิ่มกลไกใหม่: per-account lockout เปิดช่อง DoS ต่อเหยื่อได้ตามที่ plan.md เตือนไว้ และ IP-based throttle เดิม (5/min login) บวกกับ reuse-detection ที่ revoke ทั้ง token family (audit-logged ใหม่) ถือว่าเพียงพอสำหรับรอบนี้ ดูเหตุผลเต็มใน `docs/threat-model.md`
- [x] เพิ่ม audit log สำหรับ login, logout, token reuse และ provider-key changes — เพิ่ม `AuditLogService` (`backend/src/common/audit-log.service.ts`) และ wire เข้า `auth.service.ts` ครบ (register, login success/failure, refresh success, reuse detection, logout); **provider-key changes ยังไม่ได้ทำ** เพราะ `provider-settings/**` เป็นไฟล์ที่อีก agent กำลังแก้ไขอยู่ — ทิ้ง `AuditLogService.record('provider_credential.upsert'/'remove', ...)` ไว้เป็น follow-up ที่ทำได้ง่ายเมื่อไฟล์นิ่งแล้ว
- [x] ตรวจ dependency vulnerabilities และกำหนด update policy — รัน `pnpm audit`: ไม่มี high/critical, พบ moderate/low ทั้งหมดอยู่ใน transitive deps (`dompurify` ผ่าน `monaco-editor`, `esbuild`/`@babel/core` ผ่าน Angular build tooling, `@hono/node-server` ผ่าน Prisma dev tooling) ซึ่งต้องรอ upstream bump ไม่ใช่ direct dependency ที่ bump ตรงๆได้ อัพเดต `prettier` (patch, semver-safe) แล้ว ส่วนที่เหลือ (`@eslint/js`, `eslint`, `typescript`, `@types/node` เป็น major bump) ไม่แตะเพราะเสี่ยง breaking change
- [x] Threat-model cross-user access, token theft, prompt injection และ artifact filename attacks — `docs/threat-model.md`

### Reliability

- [ ] เพิ่ม graceful shutdown ให้ active streams — เพิ่ม `app.enableShutdownHooks()` และ `AppShutdownService` (`backend/src/common/app-shutdown.service.ts`) แล้ว แต่การ drain active stream จริงต้อง hook เข้า `ActiveStreamRegistry` (`backend/src/chat/active-stream-registry.service.ts`) ซึ่งเพิ่ง merge เข้ามาจากอีก agent ระหว่างรอบนี้แต่ยังไม่นิ่ง (test ของ provider ที่เกี่ยวข้องยัง flaky ระหว่างทำงาน) จึงยังไม่ wire เข้าไปเพื่อเลี่ยง merge conflict กับงานที่กำลังทำอยู่ — `reconcileStuckMessages()` ยังคุ้มครอง data-loss กรณี restart กลาง stream อยู่ ไม่ใช่ silent gap
- [ ] เพิ่ม timeout/retry/circuit breaker สำหรับ AI providers — timeout เสร็จแล้วโดยอีก agent (`ollama.provider.ts` มี connect-timeout + inactivity-timeout ผ่าน `AbortController`); **retry และ circuit breaker ยังไม่มี** ในโค้ดปัจจุบัน (ตรวจแล้วด้วย grep) จึงยังไม่ติ๊กจนกว่าจะเพิ่ม
- [x] เพิ่ม database connection/readiness checks — `GET /api/health/ready` ใหม่ (`backend/src/health/`) ping Postgres ด้วย `SELECT 1`; `GET /api/health` เดิมเป็น liveness
- [x] กำหนด backup/restore procedure สำหรับ PostgreSQL — `docs/backup-restore.md` พร้อมทดสอบจริงแล้ว (`pg_dump`/`pg_restore` กับ container ที่รันอยู่จริง ดูรายละเอียดในเอกสาร)
- [x] เพิ่ม cleanup สำหรับ stale streaming artifacts และ refresh tokens — เพิ่ม `RefreshTokenCleanupService` (`@Cron` รายวัน, ลบ token ที่หมดอายุ/ถูก revoke เกิน 30 วัน) ส่วน stale streaming artifacts: `reconcileStuckMessages()` เดิมที่ทำงานตอนเปิด session ถือว่าเพียงพอแล้ว ไม่ได้เพิ่ม periodic sweep เพราะยังไม่พบ gap จริงที่ on-load reconciliation ไม่ครอบคลุม
- [ ] เพิ่ม pagination และ retention policy — ข้ามรอบนี้ เพราะจะต้องแก้ `chat-sessions.service.ts` ซึ่งเป็นไฟล์ของอีก agent ที่กำลังแก้ไขอยู่ ทิ้งไว้เป็น follow-up
- [ ] ทดสอบ server restart ระหว่าง active stream — ยังไม่ได้ทดสอบจริง เพราะต้องมี full stack + AI provider ทำงานอยู่พร้อม active stream ซึ่งไม่พร้อมใช้งานในรอบนี้ (backup/restore ทดสอบจริงแล้วแยกต่างหาก ดูด้านบน); ทิ้งเป็น manual test procedure ที่ยังต้องทำ
- [ ] ทดสอบ migration rollback/forward strategy — ยังไม่ได้ทำ ทิ้งไว้เป็น follow-up

### Observability

- [x] Structured JSON logging — `nestjs-pino` wire เข้า `app.module.ts`/`main.ts`, redact header/body ที่มี secret (`backend/src/common/logger.config.ts`)
- [x] Correlation/request ID สำหรับ REST และ WebSocket — REST: `X-Request-Id` (รับจาก header เดิมหรือ generate ใหม่, echo กลับใน response) ผ่าน pino-http `genReqId`; **WebSocket ข้ามรอบนี้โดยตั้งใจ** เพื่อเลี่ยงแตะ `chat.gateway.ts` ที่อีก agent กำลังแก้ไขอยู่
- [x] Metrics: request rate, error rate, stream duration, first-token latency และ active streams — ทำเฉพาะส่วนที่ทำได้สะอาดจากไฟล์ของตัวเอง: HTTP request rate/error rate/duration ผ่าน `MetricsMiddleware` + `GET /api/metrics` (Prometheus format, `backend/src/common/metrics.*`); **stream duration, first-token latency, active-stream gauge ยังไม่มี** เพราะต้อง hook เข้า `ActiveStreamRegistry` เหมือนข้อ graceful-shutdown ด้านบน
- [x] Health/readiness endpoints แยกกัน — ดู Reliability ด้านบน
- [ ] Error reporting และ alerting — ต้องเลือก provider (Sentry/Datadog/ฯลฯ) ซึ่งเป็นการตัดสินใจด้าน infra แบบเดียวกับ secret manager ใน Deployment section จึงไม่ทำในรอบนี้ — structured log + `/api/metrics` เป็น raw signal ที่พร้อมให้ tool แบบนี้ต่อยอดได้เมื่อเลือกแล้ว
- [x] ห้าม log prompts, tokens หรือ API keys โดยไม่มี explicit policy — ตรวจ log ใหม่ทั้งหมดที่เพิ่มเอง (audit log, pino redact list, metrics) ไม่มีการ log ค่า password/JWT/refresh-token/API key เลย มีเฉพาะ event type, user id, ip, outcome

### Deployment

- [ ] ใช้ production secrets จาก secret manager
- [ ] ตรวจ production Docker image ด้วย non-root user
- [ ] เพิ่ม image health checks
- [ ] Pin base-image versions/digests ตาม policy
- [ ] ตั้ง Nginx WebSocket/read timeout
- [ ] กำหนด resource limits สำหรับ backend/frontend/database
- [ ] เพิ่ม CI build และ image scan
- [ ] เพิ่ม deployment และ rollback runbook

เกณฑ์รับงาน:

- ผ่าน security checklist และ cross-user tests
- deploy จาก clean checkout ได้โดยไม่ใช้ไฟล์ local ที่ไม่ได้ document
- มี logs/metrics เพียงพอสำหรับวิเคราะห์ stream failure
- backup และ restore ถูกทดสอบจริง

---

## Test strategy

### สถานะปัจจุบัน

- [x] Backend unit smoke test ผ่าน 1 test
- [x] Frontend unit smoke test ผ่าน 1 test
- [x] Backend build ผ่าน
- [x] Frontend build ผ่าน
- [~] Backend ESLint ทั้ง repository ยังไม่ผ่านจาก baseline เดิม; ไฟล์ที่แก้ในรอบนี้ผ่าน lint แล้ว
- [~] Test suite ยังไม่ครอบคลุม business logic หลัก แต่มี auth/stream/socket security coverage เพิ่มแล้ว

### Unit tests ที่ควรเพิ่มก่อน

- [x] `ArtifactStreamParser` ทุก boundary condition
- [x] `AuthService` token rotation/reuse/concurrency
- [x] `ArtifactsService` revision selection/concurrency
- [x] `OllamaProvider` parsing, abort และ upstream errors (รวม timeout ใหม่และ malformed line)
- [x] `ActiveStreamRegistry` register/stop/release (รวม `stopAllForSession` และ stop/release ของ id ที่ไม่รู้จัก/ถูก release แล้ว)
- [~] Angular `AuthStore`, `ChatStore` และ `ArtifactStore` (`ChatStore` และ `ArtifactStore` มี spec ครบ — stale-response guard, dedup, streaming guard, exception toast, debounce/revision; `AuthStore` ยังไม่มี spec โดยเฉพาะ)

### Integration tests

- [x] Auth endpoints กับ PostgreSQL จริงใน test container
- [x] Session ownership ทุก REST endpoint
- [ ] Artifact ownership และ revisions
- [ ] Socket.IO connection/join/send/stop/edit
- [x] Cross-user negative tests
- [ ] Prisma migrations บน empty database

### Browser E2E

- [ ] Register → login → create chat
- [ ] Send prompt → เห็น token streaming
- [ ] Generate code → เห็น Monaco progressive stream
- [ ] Edit code → revision เพิ่ม
- [ ] Reload → session/messages/artifacts กลับมาครบ
- [ ] Stop generation
- [ ] Logout → login อีก user → socket identity เปลี่ยนถูกต้อง
- [ ] เปิดหลาย tabs และทดสอบ refresh token race

### Quality gate ที่แนะนำ

ทุก pull request ควรผ่าน:

```bash
pnpm install --frozen-lockfile
pnpm --filter backend exec prisma generate
pnpm --filter backend build
pnpm --filter frontend build
pnpm --filter backend test --runInBand
pnpm --filter frontend exec ng test --watch=false
pnpm --filter backend exec eslint "{src,apps,libs,test}/**/*.ts"
```

---

## ลำดับงานที่แนะนำ

### Milestone A — ทำ baseline ให้ปลอดภัยและเสถียร

1. [~] เลือก canonical repository และจัดการ `login.md` (ถอดจาก tracked files แล้ว; ยังไม่ได้ rewrite Git history)
2. [x] แก้ socket disconnect/re-authentication ตอน logout/login
3. [x] เพิ่ม ownership check ให้ `chat:stop`
4. [x] ทำ streaming error boundary ให้ finalize message เสมอ
5. [x] จำกัด provider ให้เหลือเฉพาะ Ollama จนกว่า provider อื่นพร้อม
6. [x] ทำ refresh-token rotation ให้ atomic
7. [x] เพิ่ม auth/WebSocket ownership integration tests

Milestone A ถือว่าเสร็จเมื่อไม่มี cross-user access, socket identity leak หรือ message ค้างจาก known failure paths

### Milestone B — ทำ Phase 5 ให้สมบูรณ์

1. [x] เพิ่ม artifacts ล่าสุดเข้า AI context
2. [x] Debounce/explicit-save editor
3. [x] ทำ revision concurrency-safe
4. [x] แก้ parser EOF closing fence
5. [x] ป้องกัน stale session/artifact state
6. [~] ทำ Artifact E2E test matrix (ยืนยัน Ollama streaming, create/edit revision จริงแล้ว; ยังไม่ครบทุกกรณี)
7. [x] เพิ่ม revision/diff UI ที่ใช้งานได้จริง

Milestone B ถือว่าเสร็จเมื่อสร้าง แก้ reload และสั่ง AI แก้ไฟล์เดิมได้ต่อเนื่องโดยข้อมูลไม่หาย

### Milestone C — Multi-provider

1. [ ] ออกแบบ encrypted provider credentials
2. [ ] สร้าง settings API/UI
3. [x] Implement Claude provider
4. [x] Implement OpenAI provider
5. [ ] เพิ่ม model selection และ provider connection test (connection-test endpoint เสร็จแล้วฝั่ง backend; model selection ยังเป็นงาน frontend UI ที่ยังไม่ได้ทำ)
6. [ ] เพิ่ม provider integration tests (มีเฉพาะ unit tests ที่ mock `global.fetch`; ยังไม่มี integration test ผ่าน Socket.IO/test container จริง)

### Milestone D — Production readiness

1. [ ] Rate limiting, Helmet และ payload limits
2. [ ] Logging, metrics และ error reporting
3. [ ] CI/CD และ container scanning
4. [ ] Backup/restore และ deployment runbook
5. [ ] Full browser E2E และ security regression suite
6. [ ] Performance/load test สำหรับ concurrent streams

---

## งานที่ทำได้ทันทีในรอบถัดไป

แนะนำให้เริ่มจากชุดงานนี้ เพราะแก้ความเสี่ยงสูงสุดและไม่ต้องรอ Phase 6:

- [x] เพิ่ม `SocketService.disconnect()` และเรียกจาก logout
- [x] สร้าง socket ใหม่หลัง login/refresh identity change
- [x] เพิ่ม message ownership query และตรวจใน `chat:stop`
- [x] ย้าย provider lookup/stream/parser/finalize เข้า error boundary เดียว
- [x] Reject `claude`/`openai` session creation ชั่วคราว หรือ implement provider registry validation
- [x] เพิ่ม unit tests สำหรับ parser และ integration test สำหรับ WebSocket ownership
- [x] เพิ่ม debounce ให้ Monaco edit
- [x] ทำ artifact revision insert ให้ retry/lock เมื่อชน unique constraint
- [x] ส่ง artifact content ล่าสุดเข้า AI context
- [x] รัน Artifact E2E ด้วย Ollama จริง

## Definition of Done ของแต่ละงาน

งานหนึ่งจะถือว่าเสร็จเมื่อครบทุกข้อ:

- [ ] Source code ถูก implement และ review แล้ว
- [ ] มี tests ครอบคลุม happy path และ failure path สำคัญ
- [ ] Build และ lint ผ่าน
- [ ] ไม่มีข้อมูลลับหรือ generated files ถูก commit
- [ ] API/WebSocket contracts และ README/plan ถูกอัปเดตถ้ามีพฤติกรรมเปลี่ยน
- [ ] Database change มี migration และทดสอบ deploy แล้ว
- [ ] Security/ownership ถูกตรวจสำหรับ operation ที่อ่านหรือแก้ข้อมูล user
- [ ] มีวิธีตรวจสอบผลซ้ำได้ ไม่อาศัยเพียงการทดสอบด้วยมือครั้งเดียว

## หมายเหตุจาก Claude session เดิม

- Claude session เดิม `85b1d178-826d-4116-819b-a19247a4e6bc` หยุดเพราะชน session limit เวลาประมาณ 00:33
- Background Docker rebuild ของ Phase 5 จบด้วย exit code `0`
- Notification ที่แสดง `stopped` บางรายการเกิดจาก session teardown; task output จริงของ rebuild และ wait commands จบแล้ว
- Claude Code process ปัจจุบันที่เปิดกับ `zEXtream-Application-AI` เป็น interactive process แบบ idle และไม่พบ source change หลังเริ่ม session
- Docker development stack ที่เริ่มจาก working copy เดิมอาจยังใช้ชื่อ project `chat-workspace`; ให้ปิด stack เดิมก่อนเริ่ม stack ชื่อ `zextream-application-ai` เพื่อไม่ให้ container หรือ port ชนกัน
- สิ่งที่ยังขาดจาก Phase 5 คือ functional E2E verification ไม่ใช่การเขียน source ขั้นต้น
