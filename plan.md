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
| Phase 2 | Authentication และ users                    | `[x]` | Auth P0 ทั้งหมดปิดแล้ว รวมทั้ง integration test suite เต็มรูปแบบกับ PostgreSQL จริง |
| Phase 3 | Angular shell และ design system             | `[x]` | Login/register/layout, design system, session management UI, model-selector, toasts, responsive layout, accessibility pass เสร็จแล้ว |
| Phase 4 | Chat session และ Ollama streaming           | `[x]` | Backend streaming correctness, frontend state race และ WebSocket integration test suite (real socket.io-client) เสร็จแล้ว |
| Phase 5 | Code artifacts และ Monaco Editor            | `[x]` | ยืนยันจริงครบด้วย Ollama จริง: token streaming, Monaco progressive code generation, แก้โค้ดแล้วเกิด revision ใหม่, reload แล้วข้อมูลยังอยู่ — ดู "หมายเหตุจาก session ล่าสุด" ด้านล่าง |
| Phase 6 | Claude/OpenAI และ provider settings         | `[x]` | Provider configuration model, providers ทั้งสาม, capability metadata, per-user gating, connection-test UI/endpoint และ model-selector ทั้งสร้าง/แก้ session ครบแล้ว; เพิ่ม Socket.IO E2E ยืนยันจริงแล้วว่า (1) `chat:send` ที่ระบุ provider ที่ user ยังไม่ได้ configure key ถูก reject ด้วย `WsException` และไม่มี message ถูกสร้างใน DB (2) credential ของ user A ใช้กับ `chat:send` ของ user B ไม่ได้ แม้จะเป็น provider เดียวกัน — ทดสอบผ่าน fixture credential ที่ encrypt จริงผ่าน `ProviderSettingsService.upsertApiKey()` ไม่ใช่ API key จริง (ดู `backend/test/websocket.e2e-spec.ts` describe "provider runtime gating"); full e2e suite 51/51 ผ่าน, unit tests 162/162 ผ่าน |
| Phase 7 | Security hardening และ production readiness | `[~]` | Helmet/CSP, CORS allowlist, rate limiting (REST+WS), audit log, structured logging, health checks, metrics, backup/restore, deployment hardening, file-based secrets, CI image scan, optional Sentry error reporting, license เสร็จหมด; account lockout ตัดสินใจไม่ทำแล้ว; manual test ทั้ง 2 รายการทำจริงแล้ว (server restart กลาง stream, migration rollback) — พบว่า graceful-shutdown hook ไม่ทำงานจริงใน dev topology (signal ไม่ลงถึง Nest process ผ่าน `pnpm start:dev`/`nest --watch`) แม้ reconcile backstop จะกู้ message ที่ค้างได้ถูกต้อง; prod topology (`node dist/src/main.js` ตรง ๆ) ยังไม่ได้ทดสอบแยก — ดูรายละเอียดเต็มใน Phase 7 → Reliability |

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
- [x] กำหนด license ให้ชัดเจน หรือยืนยันว่าเป็น proprietary project — เพิ่ม `LICENSE` (proprietary/all-rights-reserved) ที่ root, ตั้ง `"license": "UNLICENSED"` ให้ตรงกันทุก workspace package (`package.json` ที่ root, `frontend`, `backend` เดิม, `packages/shared-types`, `e2e`), อัปเดต README's License section
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

- [x] เพิ่ม integration test ที่รัน migrations บน database ว่าง (`backend/test/migrations-empty-db.e2e-spec.ts` — สร้าง throwaway database จริงใน Postgres instance เดียวกัน รัน `pnpm exec prisma migrate deploy` ตรงกับคำสั่งที่ `docker-compose.yml`'s `migrate` service ใช้ ยืนยัน table/`_prisma_migrations` ครบ แล้ว drop database ทิ้ง; รันจริงผ่านแล้วทั้งกับ `docker compose up -d postgres` และกับ standalone container แยก)
- [x] ทดสอบ cascade delete ของ user/session/message/artifact (`backend/test/cascade-delete.e2e-spec.ts` — ยืนยันจาก migration SQL จริงว่า user→session/refresh_token/provider_credential, session→message/code_artifact, message→code_artifact ทั้งหมด `ON DELETE CASCADE`; ส่วน `code_artifacts.parent_artifact_id` (revision chain) เป็น `ON DELETE SET NULL` ไม่ cascade — มี test คุมทั้งสามกรณี)
- [x] ตรวจ compatibility ของ `uuidv7()` กับ PostgreSQL environment ทุกแห่งที่จะ deploy — ยืนยันแล้วว่าเป็น native builtin function ของ PostgreSQL 18 (RFC 9562 version-7 UUID) ไม่ใช่ extension (`pgcrypto`/`uuid-ossp`); ไม่มี `CREATE EXTENSION` ใน migration ใดเลย และ `docker-compose.yml` pin `postgres:18.4-alpine` ตรงกันพอดี ทดสอบจริงทั้งเรียก `SELECT uuidv7()` ตรงๆ และ insert row จริงแล้วตรวจ format ของ id ที่ได้ (`backend/test/migrations-empty-db.e2e-spec.ts`, `backend/test/cascade-delete.e2e-spec.ts`)
- [x] เพิ่ม cleanup policy สำหรับ refresh tokens ที่หมดอายุหรือ revoked แล้ว (`RefreshTokenCleanupService` ดู Phase 7 → Reliability)
- [x] พิจารณา pagination สำหรับ messages, sessions และ artifact revisions — เพิ่ม optional `limit`/`offset` query params (offset-based, ไม่ใช่ cursor-based — เลือกเพราะ list ทุกอันถูก scope ด้วย user/session เดียวอยู่แล้ว ไม่ใช่ global feed ขนาดใหญ่ ทำให้ downside ของ OFFSET/LIMIT ไม่มีนัยสำคัญที่ scale นี้ และง่ายกว่า cursor มากในแง่ backward compatibility) ให้ `GET /api/chat/sessions`, `GET /api/chat/sessions/:id/messages` และ `GET /api/chat/sessions/:sessionId/artifacts/revisions`; ค่า default page size คือ 50 เมื่อขอ pagination แต่ไม่ระบุ `limit`; เมื่อไม่ส่ง `limit`/`offset` เลย endpoint คืนค่าเหมือนเดิมทุกประการ (มี test ยืนยันทั้ง omitted-params case และ paginated case ใน `backend/test/pagination.e2e-spec.ts`) — ดู `backend/src/chat/dto/pagination-query.dto.ts` สำหรับ rationale เต็ม; `MessagesService.listForSession()` ที่ `ChatGateway` เรียกแบบไม่มี pagination เพื่อสร้าง AI context ยังคืนค่าครบทุก message เหมือนเดิม ไม่ถูกกระทบ. **retention policy ยังไม่ได้ทำ** — pagination วางฐานให้ retention ทำต่อได้ แต่การตัดสินใจว่าจะเก็บข้อมูลนานเท่าไหร่/ลบแบบไหนเป็น product decision ที่ต้องตัดสินใจแยก ไม่อยู่ในขอบเขตรอบนี้ (เป็น code-only pass)
- [x] ปรับ `listLatestForSession()` ให้ query เฉพาะ revision ล่าสุดจาก database แทนโหลดทุก revision เข้า memory — เปลี่ยนเป็น `SELECT DISTINCT ON (filename) ... ORDER BY filename, revision DESC` ผ่าน `$queryRaw`/`Prisma.sql` (parameterized, ไม่ string-interpolate `sessionId`) แทนการ `findMany` ทุก revision แล้ว reduce ใน memory; method signature และ return shape (`Promise<CodeArtifact[]>`) ไม่เปลี่ยน จึงไม่กระทบ `ChatGateway`/`ArtifactsController` ที่เรียกอยู่; พิสูจน์ behavior-equivalence ด้วย `backend/test/artifacts-latest-revision.e2e-spec.ts` ซึ่ง reimplement algorithm เดิมแยกต่างหากแล้วเทียบกับ session ที่มีหลายไฟล์ หลาย revision ต่อไฟล์ ผ่านทั้ง service เรียกตรงและผ่าน REST endpoint

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

- [x] Register สำเร็จและ duplicate email (`backend/test/auth.e2e-spec.ts`)
- [x] Login รหัสผ่านถูก/ผิด และ inactive user (`backend/test/auth.e2e-spec.ts`)
- [x] Refresh สำเร็จ (`backend/test/auth.e2e-spec.ts`)
- [x] Refresh token หมดอายุ (`backend/test/auth.e2e-spec.ts` — ตั้ง `expiresAt` ของ DB row ให้อยู่ในอดีตตรงๆ แทนการรอ JWT หมดอายุจริง)
- [x] Refresh token reuse detection (`backend/test/auth.e2e-spec.ts` — ยืนยันว่า token family ทั้งหมดถูก revoke)
- [x] Concurrent refresh สอง request (`backend/test/app.e2e-spec.ts`)
- [x] Logout แล้ว refresh ไม่ได้ (`backend/test/auth.e2e-spec.ts`)
- [x] Hard reload แล้ว restore session ได้ (`backend/test/auth.e2e-spec.ts` — จำลอง flow ของ frontend app initializer: refresh ด้วย cookie อย่างเดียวไม่มี Authorization header แล้วยืนยัน access token ใหม่เรียก REST ได้จริง; ฝั่ง browser จริงยืนยันเพิ่มใน `e2e/tests/auth-and-chat.spec.ts` ผ่าน `page.reload()`)
- [x] หลาย tab ใช้ refresh cookie เดียวกัน (`backend/test/app.e2e-spec.ts` ระดับ HTTP; `e2e/tests/refresh-token-race.spec.ts` ระดับ browser จริง — เปิดสอง page ใน context เดียวกัน บังคับให้ยิง `/api/auth/refresh` พร้อมกันจริงๆ ด้วย network-level gate แล้วยืนยันว่ามี tab หนึ่งใช้งานได้เสมอ และ tab ที่แพ้ race จะ redirect ไป `/login` สะอาดๆ ไม่ค้าง)

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
- [x] กำหนด timeout สำหรับ Ollama request และ stream inactivity — **ปรับแก้จากการทดสอบจริง**: `OLLAMA_CONNECT_TIMEOUT_MS` เดิม 10s สั้นเกินไปจริง — ทดสอบกับ Ollama จริง (โมเดล 14B ~14.6GB) พบว่า cold load (ครั้งแรกหรือหลัง idle นานจน unload) ใช้เวลาเกิน 10s ได้จริง ทำให้ request แรกของ session ล้มเหลวเสมอ จึงปรับเป็น 90s; ระหว่างแก้พบบั๊กที่สองด้วย: `armInactivityTimer()` เดิมถูกเรียกตั้งแต่ก่อน fetch() เริ่ม ทำให้ inactivity timer (30s) แข่งกับ connect timer และ misreport "stream timed out จาก inactivity" ทั้งที่จริงคือ "ยังเชื่อมต่อ/รอโมเดลโหลดอยู่" — แก้โดยเลื่อนการ arm inactivity timer ไปเริ่มหลัง connect สำเร็จเท่านั้น ยืนยันด้วย unit test เดิม (`OllamaProvider.spec.ts`) และทดสอบจริงกับ Ollama cold/warm สองรอบ
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

- [x] WebSocket connection ด้วย token ถูกต้อง/ผิด/หมดอายุ (`backend/test/websocket.e2e-spec.ts` ผ่าน `socket.io-client` จริงต่อ server จริง)
- [x] Join session ตัวเองและปฏิเสธ session ของ user อื่น (`backend/test/websocket.e2e-spec.ts`)
- [x] Send → created → token → updated ครบลำดับ (`backend/test/websocket.e2e-spec.ts` — ยืนยัน created(user) → created(assistant, streaming) → updated(error) ครบลำดับผ่าน socket จริง กับ Ollama ที่ unreachable จริงตาม config; ไม่มี `chat:token` เพราะ fetch ล้มเหลวก่อนได้ response ซึ่งเป็น error path จริงที่ deterministic กว่าการรอ Ollama จริง)
- [x] Stop generation ของตัวเอง (`backend/test/chat-stop.e2e-spec.ts` — ใช้ black-hole TCP server แทน Ollama จริงเพื่อจำลอง stream ที่ค้างจริง แล้วยืนยัน `chat:stop` ทำให้ finalize เป็น `stopped` ผ่าน socket จริง; abort mechanics ระดับ unit ถูกคุมโดย `active-stream-registry.service.spec.ts` อยู่แล้ว)
- [x] ปฏิเสธ stop generation ของ user อื่น (`backend/test/chat-stop.e2e-spec.ts`)
- [~] Ollama unavailable, HTTP error, malformed stream และ timeout — unavailable (connection refused) ยืนยันผ่าน WS e2e เต็มเส้นทางแล้ว (`websocket.e2e-spec.ts`); HTTP error/malformed-line/timeout ยืนยันแล้วที่ unit level เท่านั้น (`ollama.provider.spec.ts`) ไม่ได้ทำซ้ำผ่าน real socket เพราะพฤติกรรมเดียวกันหลังออกจาก provider (finalize เป็น `error` พร้อม emit `chat:message:updated`) ถูกยืนยันแล้วด้วยเคส unavailable
- [x] Server restart แล้ว reconcile stuck message (`backend/test/websocket.e2e-spec.ts` — insert message ด้วย `streamingStatus: 'streaming'` ตรงๆ ผ่าน Prisma จำลอง crash กลาง stream แล้วเรียก `GET /messages` จริงยืนยันว่า `reconcileStuckMessages()` ทำงานจริงกับ DB จริง)
- [x] Logout/login คนละบัญชีใน browser instance เดิม — ฝั่ง backend socket identity ยืนยันแล้ว (`backend/test/websocket.e2e-spec.ts` — reconnect socket instance เดิมด้วย auth ใหม่ mirror `SocketService.setAccessToken()`); ฝั่ง browser จริงยืนยันเพิ่มใน `e2e/tests/identity-switch.spec.ts`

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

- [x] ออกแบบ provider configuration model ต่อ user (`ProviderCredential` ใน Prisma schema: `(userId, provider)` unique, encrypted API key ต่อ provider ต่อ user; `ProviderSettingsService` ให้ list/upsert/remove/hasApiKey/getApiKeyForRuntime/testConnection และ per-user gating ใน session create/send — ดู Phase 6)
- [x] เลือก encryption format สำหรับ API key แบบ authenticated encryption
- [x] Validate `API_KEY_ENCRYPTION_KEY` เป็น key length/encoding ที่ถูกต้อง ไม่ใช่เพียง non-empty string
- [x] สร้าง service สำหรับ encrypt/decrypt/rotate API keys
- [x] ห้ามคืน decrypted key ผ่าน API หรือ log
- [x] Implement OpenAI provider (`backend/src/ai/providers/openai.provider.ts`, SSE parsing + error mapping)
- [x] Implement Claude provider (`backend/src/ai/providers/claude.provider.ts`, Anthropic SSE event parsing + error mapping)
- [x] Register providers ใน `AiModule` และ `AiProviderFactory`
- [x] เพิ่ม provider capability metadata เช่น models, streaming, max tokens (`ProviderSettingsService.listForUser()` คืน `models: string[]` ต่อ provider แล้ว; ollama ว่างเพราะไม่มี fixed catalog)
- [x] เพิ่ม `/settings/providers` route และ page
- [x] เพิ่ม wizard/modal สำหรับเพิ่ม API key และทดสอบ connection (API key form ไม่แสดงค่าเดิม, ปุ่ม `Test connection` เรียก `POST /api/settings/providers/:provider/test` และแสดงผลผ่าน toast/error state)
- [x] เพิ่ม model selector ตอนสร้างหรือแก้ session — `app-new-session-dialog` (`frontend/src/app/features/chat/new-session-dialog/`) เปิดจากปุ่ม "+" เมื่อผู้ใช้มี provider ที่ `configured` มากกว่าแค่ ollama; สำหรับ session เดิม ปุ่มเปลี่ยน provider ใน session list ใช้ dialog เดียวกันและบันทึกผ่าน `PATCH /api/chat/sessions/:id` พร้อม backend re-check ว่า key ของ provider ปลายทางยัง configured อยู่จริง
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
- [x] เพิ่ม rate limiting สำหรับ REST และ WebSocket events — REST เสร็จแล้ว (throttle เดิมบน auth + เพิ่มใหม่บน `POST /api/chat/sessions`); WebSocket เสร็จแล้วในรอบถัดมาด้วย `WsRateLimiterService` (`backend/src/realtime/ws-rate-limiter.service.ts`) — per-socket fixed-window limiter เพราะ `ThrottlerGuard` ของ NestJS ไม่ครอบ `@SubscribeMessage` handlers; จำกัด `chat:send` 10/min, `session:join`/`session:leave` 30/min, `chat:stop` 20/min, `artifact:edit` 60/min ต่อ socket และล้าง state ตอน disconnect
- [x] เพิ่ม request/body size limits — จำกัด JSON/urlencoded body ที่ 256kb ผ่าน `app.useBodyParser()` ใน `main.ts`
- [x] เพิ่ม WebSocket event validation pipe/schema — มีอยู่แล้วจากรอบก่อนหน้า (`@UsePipes(ValidationPipe)` + `WsValidationFilter` ใน `chat.gateway.ts`) ตรวจสอบแล้วว่ายังอยู่
- [x] กำหนด CORS allowlist แทนค่า origin เดียวแบบคลุมเครือ — `CORS_ORIGIN` รองรับ comma-separated list พร้อม validate ด้วย zod, ค่าว่างจะปิด CORS แทนที่จะ fallback เป็น allow-all
- [x] เพิ่ม secure headers ใน Nginx — `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, CSP ใน `frontend/nginx.conf`
- [x] บังคับ HTTPS ใน production — redirect ตาม `X-Forwarded-Proto` ใน `frontend/nginx.conf` (ไม่ terminate TLS เอง เพราะ repo ไม่ได้ provision cert)
- [x] ตรวจ cookie flags ใน topology จริง — ตรวจแล้วว่า `secure: NODE_ENV === 'production'` ใน `auth.controller.ts` ถูกต้อง สอดคล้องกับการบังคับ HTTPS ข้างต้น ไม่ต้องแก้
- [ ] เพิ่ม account lockout/backoff ที่ไม่เปิดช่อง DoS — ตัดสินใจไม่เพิ่มกลไกใหม่: per-account lockout เปิดช่อง DoS ต่อเหยื่อได้ตามที่ plan.md เตือนไว้ และ IP-based throttle เดิม (5/min login) บวกกับ reuse-detection ที่ revoke ทั้ง token family (audit-logged ใหม่) ถือว่าเพียงพอสำหรับรอบนี้ ดูเหตุผลเต็มใน `docs/threat-model.md`
- [x] เพิ่ม audit log สำหรับ login, logout, token reuse และ provider-key changes — เพิ่ม `AuditLogService` (`backend/src/common/audit-log.service.ts`) และ wire เข้า `auth.service.ts` ครบ (register, login success/failure, refresh success, reuse detection, logout) และ `ProviderSettingsService` สำหรับ provider-key upsert/remove โดย log เฉพาะ event, user id, provider และ outcome ไม่บันทึก API key
- [x] ตรวจ dependency vulnerabilities และกำหนด update policy — รัน `pnpm audit`: ไม่มี high/critical, พบ moderate/low ทั้งหมดอยู่ใน transitive deps (`dompurify` ผ่าน `monaco-editor`, `esbuild`/`@babel/core` ผ่าน Angular build tooling, `@hono/node-server` ผ่าน Prisma dev tooling) ซึ่งต้องรอ upstream bump ไม่ใช่ direct dependency ที่ bump ตรงๆได้ อัพเดต `prettier` (patch, semver-safe) แล้ว ส่วนที่เหลือ (`@eslint/js`, `eslint`, `typescript`, `@types/node` เป็น major bump) ไม่แตะเพราะเสี่ยง breaking change
- [x] Threat-model cross-user access, token theft, prompt injection และ artifact filename attacks — `docs/threat-model.md`

### Reliability

- [x] เพิ่ม graceful shutdown ให้ active streams — `app.enableShutdownHooks()` + `AppShutdownService` (`backend/src/common/app-shutdown.service.ts`) เดิม บวก `ActiveStreamRegistry` implement `OnApplicationShutdown` เองโดยตรงในรอบถัดมา (`backend/src/chat/active-stream-registry.service.ts`) — abort ทุก stream ที่ยังทำงานอยู่ตอน SIGTERM/SIGINT ผ่าน path เดียวกับ user-initiated `chat:stop` (finalize เป็น `stopped` และ emit `chat:message:updated`) เลือกวิธีนี้แทนการ inject registry เข้า `AppShutdownService` เพื่อเลี่ยง cross-module coupling; `reconcileStuckMessages()` ยังคุ้มครอง data-loss กรณี restart แบบไม่ graceful (crash) อยู่เหมือนเดิม
- [x] เพิ่ม timeout/retry/circuit breaker สำหรับ AI providers — timeout เดิม (`ollama.provider.ts` connect-timeout + inactivity-timeout ผ่าน `AbortController`) บวก retry+circuit breaker ใหม่: `fetchWithRetry()` (`backend/src/ai/providers/fetch-with-retry.ts`) ทำ exponential backoff สูงสุด 3 ครั้งสำหรับ network error/429/5xx เฉพาะตอนเชื่อมต่อครั้งแรก (ไม่ retry หลัง stream เริ่มแล้วเพื่อไม่ให้ client เห็นเนื้อหาซ้ำ); `CircuitBreakerService` (`backend/src/ai/circuit-breaker.service.ts`) เปิด circuit ต่อ provider หลัง 5 ครั้งติดต่อกันที่ upstream ล้มเหลวจริง (network/5xx เท่านั้น) cooldown 30 วิ — **ตั้งใจไม่นับ 401/403/429 เป็นความล้มเหลวของ circuit breaker เพราะเป็นปัญหาเฉพาะ API key ของผู้ใช้คนเดียว ไม่ใช่สัญญาณว่า provider ทั้งระบบล่ม** การนับรวมจะทำให้ผู้ใช้คนหนึ่งใส่ key ผิดแล้วไป lock provider นั้นสำหรับผู้ใช้ทุกคน มี regression test ยืนยันเรื่องนี้โดยเฉพาะ
- [x] เพิ่ม database connection/readiness checks — `GET /api/health/ready` ใหม่ (`backend/src/health/`) ping Postgres ด้วย `SELECT 1`; `GET /api/health` เดิมเป็น liveness
- [x] กำหนด backup/restore procedure สำหรับ PostgreSQL — `docs/backup-restore.md` พร้อมทดสอบจริงแล้ว (`pg_dump`/`pg_restore` กับ container ที่รันอยู่จริง ดูรายละเอียดในเอกสาร)
- [x] เพิ่ม cleanup สำหรับ stale streaming artifacts และ refresh tokens — เพิ่ม `RefreshTokenCleanupService` (`@Cron` รายวัน, ลบ token ที่หมดอายุ/ถูก revoke เกิน 30 วัน) ส่วน stale streaming artifacts: `reconcileStuckMessages()` เดิมที่ทำงานตอนเปิด session ถือว่าเพียงพอแล้ว ไม่ได้เพิ่ม periodic sweep เพราะยังไม่พบ gap จริงที่ on-load reconciliation ไม่ครอบคลุม
- [x] เพิ่ม pagination และ retention policy — pagination เสร็จแล้วในรอบถัดมา (`limit`/`offset` บน session list, message history และ artifact revisions ดู Phase 1) โดย agent ที่ตอนแรกถูกกันไว้เพราะชนไฟล์กัน; retention policy (นโยบายเก็บข้อมูลนานเท่าไหร่) ยังเป็นการตัดสินใจเชิงผลิตภัณฑ์ที่ยังไม่ได้ทำ ไม่ใช่งาน code
- [x] ทดสอบ server restart ระหว่าง active stream — ทดสอบจริงกับ dev docker-compose stack ที่รันอยู่ (`docker compose ps` → backend/postgres healthy) และ Ollama จริงที่ reachable (`qwen2.5-coder:14b`): สร้าง user/session จริงผ่าน REST, เปิด socket.io client จริง, ยิง `chat:send` ที่ prompt ยาวจนเห็น `chat:token` จริงไหลเข้ามาก่อน (ยืนยันว่ากำลัง stream จริง ไม่ใช่ restart ก่อน provider เริ่มทำงาน) แล้วรอ 1.5 วิให้ stream ไปต่ออีกหน่อยก่อนสั่ง `docker compose restart backend`. ผลที่พบ (สอง finding แยกกัน):
  1. **`ActiveStreamRegistry.onApplicationShutdown()` (graceful path) ไม่ทำงานจริงใน dev topology** — เทียบ log ก่อน/หลัง restart แล้วไม่มี log จาก `AppShutdownService`/graceful-shutdown เลย มีแต่ process ตายห้วน ๆ แล้ว `nest start --watch` compile ใหม่ทันที ต้นเหตุน่าจะมาจาก dev image ใช้ `CMD ["pnpm", "start:dev"]` (→ `nest start --watch`) ซึ่งเป็น process chain หลายชั้นที่ signal forwarding ของ SIGTERM ไม่ลงไปถึง Nest process จริง (เทียบกับ prod stage ที่ `CMD ["node", "dist/src/main.js"]` เรียก node ตรง ๆ เป็น PID 1 — ยังไม่ได้ทดสอบ topology นี้แยกต่างหาก จึงยังไม่ยืนยันว่า prod จะมีปัญหาเดียวกันหรือไม่ ทิ้งเป็น follow-up ถ้าต้องการ guarantee การ shutdown แบบ graceful จริงจังในโปรดักชัน)
  2. **Backstop `reconcileStuckMessages()` ทำงานถูกต้อง** — เรียก `GET /api/chat/sessions/:id/messages` หลัง restart แล้วเห็น assistant message ที่ค้างอยู่ที่ `streamingStatus: 'streaming'` ถูกแปลงเป็น `streamingStatus: 'error'`, `errorMessage: 'Generation was interrupted.'` โดยอัตโนมัติ (endpoint นี้เรียก reconcile ทุกครั้งที่โหลด) — ไม่มี message ค้างสถานะ `streaming` ตลอดไป ไม่มี data corruption แม้ graceful path จะไม่ทำงาน — ลบ test user/session ออกจาก dev DB แล้วหลังทดสอบเสร็จ
- [x] ทดสอบ migration rollback/forward strategy — ทดสอบจริงกับ dedicated e2e test Postgres (`zextream-e2e-test-postgres`, ไม่แตะ dev database ที่มีข้อมูลจริงสะสมมาทั้ง session): `pg_dump -Fc` เก็บ baseline ก่อน, จำลอง forward migration ด้วย `ALTER TABLE users ADD COLUMN rollback_test_marker text` แล้วยืนยันว่าคอลัมน์ถูกเพิ่มจริง (`\d users`), จากนั้นจำลอง rollback ตาม procedure ใน `docs/backup-restore.md` จริง ๆ (`dropdb`/`createdb` แล้ว `pg_restore --clean --if-exists` จาก baseline dump) แล้วยืนยันว่าคอลัมน์ทดสอบหายไปและ schema กลับมาครบ 7 ตาราง ตรงกับก่อนหน้า, `prisma migrate status` แสดง "Database schema is up to date!" เหมือนเดิม, และรัน e2e suite เต็มรูปแบบ (51/51 ผ่าน) ยืนยันว่า database ที่ restore แล้วใช้งานได้จริงไม่ใช่แค่ schema ตรงแต่ query ไม่ได้ — ระหว่างทางเจอ Windows/Git-Bash path-mangling bug ตัวเดียวกับที่ `docs/backup-restore.md` เตือนไว้แล้วสำหรับ `docker cp`/`docker exec` path arguments (ต้อง escape ด้วย doubled-leading-slash หรือ stream ผ่าน stdin แทน `docker cp` ตรง ๆ) — ยืนยันว่าคำเตือนในเอกสารนั้นถูกต้องและจำเป็นจริง ไม่ใช่ทฤษฎี. **ข้อสรุป**: กลยุทธ์ rollback ของ repo นี้คือ backup-then-restore (ไม่มี down-migration) และผ่านการทดสอบจริงแล้วว่าใช้งานได้; ยังไม่ได้ทำ full destructive cycle (`docker compose down -v`) กับ dev stack ที่มีข้อมูลจริงอยู่ตามที่ `docs/backup-restore.md` แนะนำไว้ว่าควรทำก่อนเชื่อมั่นในโปรดักชัน — ทิ้งเป็น follow-up ที่ต้องทำกับ disposable stack เท่านั้น ไม่ใช่ dev stack ที่ใช้ร่วมกันอยู่ตอนนี้

### Observability

- [x] Structured JSON logging — `nestjs-pino` wire เข้า `app.module.ts`/`main.ts`, redact header/body ที่มี secret (`backend/src/common/logger.config.ts`)
- [x] Correlation/request ID สำหรับ REST และ WebSocket — REST: `X-Request-Id` (รับจาก header เดิมหรือ generate ใหม่, echo กลับใน response) ผ่าน pino-http `genReqId`; **WebSocket ข้ามรอบนี้โดยตั้งใจ** เพื่อเลี่ยงแตะ `chat.gateway.ts` ที่อีก agent กำลังแก้ไขอยู่
- [x] Metrics: request rate, error rate, stream duration, first-token latency และ active streams — ทำเฉพาะส่วนที่ทำได้สะอาดจากไฟล์ของตัวเอง: HTTP request rate/error rate/duration ผ่าน `MetricsMiddleware` + `GET /api/metrics` (Prometheus format, `backend/src/common/metrics.*`); **stream duration, first-token latency, active-stream gauge ยังไม่มี** เพราะต้อง hook เข้า `ActiveStreamRegistry` เหมือนข้อ graceful-shutdown ด้านบน
- [x] Health/readiness endpoints แยกกัน — ดู Reliability ด้านบน
- [x] Error reporting และ alerting — เพิ่ม Sentry แบบ optional/off-by-default: `backend/src/common/sentry.ts` (`initSentry()`, no-op ถ้าไม่ตั้ง `SENTRY_DSN`) + `SentryExceptionFilter` (report เฉพาะ error ที่ไม่ใช่ 4xx routine) ฝั่ง backend; `frontend/src/app/core/sentry.ts` ฝั่ง frontend ที่ fetch DSN จาก `GET /api/config` (public endpoint ใหม่ ไม่ใช่ความลับ เพราะ Sentry browser DSN ออกแบบมาให้ public อยู่แล้ว) แล้วค่อย init — เลือก Sentry เพราะมี SDK ทางการทั้ง NestJS/Angular และ free tier ใช้งานได้จริงโดยไม่ต้องพึ่ง vendor อื่น; ยืนยันจริงแล้วด้วย DSN ปลอมผ่าน docker stack จริง (`/api/config` ส่ง DSN ถูกต้อง, `window.__SENTRY__` ถูกตั้งค่าจริงในเบราว์เซอร์) ก่อนลบ DSN ทดสอบออก ระหว่างทางเจอบั๊กจริง 2 จุดที่แก้แล้ว: (1) `docker-compose.yml` ไม่ได้ pass `SENTRY_DSN`/`SENTRY_ENVIRONMENT` เข้า container เลย และ (2) `ConfigService.get()` ของ NestJS fallback ไปอ่าน `process.env` ดิบเมื่อ key เป็น `undefined` ใน validated config ทำให้ `${VAR:-}` (empty string) หลุดผ่าน `??` ไปเป็น "configured but blank" แทนที่จะเป็น `null` — แก้เป็น `||` ที่จุดใช้งานแทน
- [x] ห้าม log prompts, tokens หรือ API keys โดยไม่มี explicit policy — ตรวจ log ใหม่ทั้งหมดที่เพิ่มเอง (audit log, pino redact list, metrics) ไม่มีการ log ค่า password/JWT/refresh-token/API key เลย มีเฉพาะ event type, user id, ip, outcome

### Deployment

- [x] ใช้ production secrets จาก secret manager — ยังไม่เลือก vendor เฉพาะเจาะจง (ต้องให้เจ้าของโปรเจกต์ตัดสินใจ) แต่ทำ mechanism แบบ vendor-agnostic ที่ใช้ได้กับทุกเจ้า: backend รองรับ `<KEY>_FILE` (`DATABASE_URL_FILE`, `JWT_ACCESS_SECRET_FILE`, `JWT_REFRESH_SECRET_FILE`, `API_KEY_ENCRYPTION_KEY_FILE`) อ่านค่าจากไฟล์แทน env ตรง (`backend/src/config/env.validation.ts`, unit test 6 เคส) + `docker-compose.secrets.yml` overlay ที่ใช้งานได้จริงกับ Docker Compose secrets — ยืนยันจริงแล้วด้วยการรัน stack เต็มรูปแบบผ่าน overlay นี้พร้อม secret files จริง เห็น backend อ่านค่าจาก `/run/secrets/*` และ boot สำเร็จ `{"database":"connected"}`; วิธีเดียวกันนี้ใช้กับ Vault agent template, Kubernetes Secret ที่ mount เป็นไฟล์ หรือ secret manager เจ้าไหนก็ได้ที่ render ค่าลงไฟล์ได้ ไม่ต้องแก้ code เพิ่ม
- [x] ตรวจ production Docker image ด้วย non-root user — backend prod stage เพิ่ม `USER node` (uid 1000 ในตัว `node:24-alpine`); frontend prod stage เปลี่ยนจาก `nginx:alpine` เป็น `nginxinc/nginx-unprivileged:1.29.8-alpine` (รัน worker+master เป็น uid 101 `nginx` ทั้งคู่ ฟัง port 8080 แทน 80) ยืนยันจริงด้วย `docker exec ... whoami`/`id` กับ container ที่รันอยู่จริงทั้งสอง service ผ่าน `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build` (ดู `docs/deployment.md`); ระหว่างตรวจพบและแก้ bug เดิมที่ไม่เกี่ยวกับ non-root โดยตรงด้วย: prod stage ไม่เคย copy `backend/prisma.config.ts` เข้า image (ทำให้ `prisma migrate deploy` fail) และ `CMD` ชี้ผิดที่ (`dist/main.js` ไม่มีจริง ต้องเป็น `dist/src/main.js`) — แก้ทั้งคู่ใน `backend/Dockerfile` แล้วยืนยันว่า stack รันได้ครบ healthy
- [x] เพิ่ม image health checks — compose-level (ตาม convention เดิมของ `postgres` ใน `docker-compose.yml`) ไม่ใช่ Dockerfile `HEALTHCHECK`: `backend` เพิ่มใน `docker-compose.yml` (ใช้ port 3000 เดียวกันทั้ง dev/prod), `frontend` เพิ่มใน `docker-compose.prod.yml` เท่านั้นเพราะ internal port ต่างกันระหว่าง dev (`ng serve` port 4200) กับ prod (nginx port 8080); ยืนยันจริงว่าทั้งสอง service ขึ้นเป็น `healthy` ใน `docker compose ps` หลัง deploy จริง
- [x] Pin base-image versions/digests ตาม policy — `node:24-alpine` (unpinned) → `node:24.18.0-alpine3.24` (ตรวจ digest ตรงกับที่ unpinned tag resolve ในเวลาที่ pin จริง), `nginx:alpine` → `nginxinc/nginx-unprivileged:1.29.8-alpine`; เลือกระดับ version+alpine pin แบบเดียวกับ `postgres:18.4-alpine` ที่มีอยู่แล้ว ไม่ทำ full digest pin (`@sha256:...`) เพราะ over-engineering สำหรับ repo ที่ยังไม่มี formal supply-chain policy ตามที่ประเมินไว้
- [x] ตั้ง Nginx WebSocket/read timeout — ยืนยันว่า `/ws/` มี `proxy_read_timeout 3600s;` เดิมอยู่ครบ, เพิ่ม `proxy_send_timeout 3600s;` คู่กัน (เดิมมีแค่ read ฝั่งเดียว ซึ่งพลาด timeout ฝั่ง nginx→backend เวลา relay client frame บน connection ที่ idle นาน ๆ); เพิ่ม `proxy_read_timeout 60s;`/`proxy_send_timeout 60s;` ให้ `/api/` อย่างชัดเจน (ค่าเดิมคือ nginx default 60s อยู่แล้ว แต่ pin ไว้ให้เห็นความต่างจาก WS แบบตั้งใจ ไม่ใช่บังเอิญ)
- [x] กำหนด resource limits สำหรับ backend/frontend/database — เพิ่ม `deploy.resources.limits`/`reservations` ใน `docker-compose.prod.yml` ให้ทั้งสาม service (backend/postgres: 512MB reserved/1GB cap, 0.25/1.0 CPU; frontend: 128MB reserved/256MB cap, 0.1/0.5 CPU) เป็นจุดเริ่มต้นที่ยังไม่ได้ผ่าน load test จริง ต้องปรับตาม production load จริงภายหลัง (บันทึกไว้ใน `docs/deployment.md`); ยืนยันว่า `limits` มีผลจริงแม้ไม่ใช้ Swarm ด้วย `docker inspect --format 'Memory=... NanoCpus=...'` กับ container ที่รันอยู่จริง
- [x] เพิ่ม CI build และ image scan — เพิ่ม job `image-scan` ใน `.github/workflows/ci.yml` build image `backend`/`frontend` จริงแล้ว scan ด้วย Trivy (เลือกเพราะ open-source, ไม่ต้องมี account/API key เหมือน Snyk จึงรันได้จริงในรอบนี้โดยไม่ต้องรอ credential จากเจ้าของโปรเจกต์) อัปโหลดผลเป็น SARIF เข้า GitHub Security tab — ตั้งใจไม่ fail build อัตโนมัติ (`exit-code: '0'`) เพราะการกำหนด severity threshold ที่ block merge ได้เป็นการตัดสินใจเชิงนโยบายของเจ้าของโปรเจกต์ ไม่ใช่งาน mechanical
- [x] เพิ่ม deployment และ rollback runbook — `docs/deployment.md` ครอบคลุม deploy จาก clean checkout (env vars ที่ต้องตั้งจริงก่อน deploy, ลำดับ `postgres`→`migrate`→`backend`→`frontend`), rollback (ไม่มีปุ่ม rollback อัตโนมัติ เป็นการ deploy โค้ดเก่ากลับด้วยมือ) และเตือนตรง ๆ ว่า Prisma migrations ไม่ reversible อัตโนมัติ — repo นี้ยังไม่มี down-migration เขียนไว้เลยสักตัว ถ้า rollback ต้องการ schema downgrade จริงต้องเขียน down-migration เองแล้วตรวจสอบก่อนรัน ไม่ใช่ operation ที่ automate ได้ในตอนนี้

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

- [x] Auth endpoints กับ PostgreSQL จริงใน test container (`backend/test/auth.e2e-spec.ts` เพิ่มเติมจาก `app.e2e-spec.ts` เดิม)
- [x] Session ownership ทุก REST endpoint
- [x] Artifact ownership และ revisions (`backend/test/artifacts-ownership.e2e-spec.ts` — สร้าง artifact ตรงผ่าน Prisma ใต้ session ของ user A แล้วยืนยันว่า user B ได้ 403 ทั้ง list และ revisions endpoint, และ unauthenticated ได้ 401)
- [~] Socket.IO connection/join/send/stop/edit — connection/join/send/stop ยืนยันผ่าน `socket.io-client` จริงแล้ว (`backend/test/websocket.e2e-spec.ts`, `backend/test/chat-stop.e2e-spec.ts`); `artifact:edit` ยังมีเฉพาะ unit-level coverage เดิม (`chat.gateway.spec.ts`) ไม่ได้เพิ่ม real-socket e2e ให้รอบนี้
- [x] Cross-user negative tests
- [x] Prisma migrations บน empty database (`backend/test/migrations-empty-db.e2e-spec.ts`)

### Browser E2E

Playwright suite ที่ `e2e/` (root-level, ขับทั้ง frontend จริง + backend จริง — ดู `e2e/README.md` สำหรับวิธีรัน) รัน `pnpm --filter e2e test:e2e:browser` ผ่านแล้ว 5 tests, skip 2 tests ที่ต้องมี Ollama จริง:

- [x] Register → login → create chat (`e2e/tests/auth-and-chat.spec.ts`)
- [x] Send prompt → เห็น token streaming — **ยืนยันจริงแล้วด้วยมือ** ผ่าน Ollama จริงที่ reachable บนเครื่อง (`qwen2.5-coder:14b`, ~14.6GB) ผ่าน `docker compose` dev stack: ส่งข้อความจริง เห็น token stream เข้ามาและ AI ตอบถูกต้อง ระหว่างตรวจพบและแก้บั๊กจริง 2 จุดด้วย (ดู Phase 4 P1 ด้านล่าง: connect-timeout สั้นเกินไปสำหรับ cold model load, และ inactivity timer แข่งกับ connect timer ผิดจังหวะ) — automated `e2e/tests/ai-dependent.spec.ts` ยังเป็น `test.skip()` เหมือนเดิมเพราะ CI ทั่วไปไม่มี Ollama ติดตั้ง ไม่ใช่เพราะ feature ใช้งานไม่ได้
- [x] Generate code → เห็น Monaco progressive stream — ยืนยันจริงแล้วด้วยมือพร้อมกับข้างบน: สั่งสร้างไฟล์ `.py`/`.js` จริง เห็นโค้ดขึ้นใน Monaco ถูกต้อง, syntax highlighting ทำงาน, ไฟล์ปรากฏใน tab
- [x] Edit code → revision เพิ่ม — ยืนยันจริงแล้วด้วยมือ: แก้โค้ดใน Monaco หลังจาก AI สร้างไฟล์ (ผ่าน artifact จริงจาก AI stream ตามที่ตั้งใจไว้ ไม่ต้องมี path แยกที่ไม่พึ่ง AI), เกิด Revision 2 (origin: user) ถัดจาก Revision 1 (origin: ai) ใน revision history ถูกต้อง, reload หน้าแล้ว title/session/ไฟล์/เนื้อหายังอยู่ครบ
- [x] Reload → session/messages/artifacts กลับมาครบ (`e2e/tests/auth-and-chat.spec.ts` — reload จริงด้วย `page.reload()` ยืนยัน session/message กลับมา; ไม่มี artifact ในเคสนี้เพราะไม่มี AI จริงสร้างให้)
- [x] Stop generation (`e2e/tests/stop-generation.spec.ts` — กดปุ่ม Stop ถ้าทันหน้าต่าง streaming สั้นๆ ของ Ollama unreachable, ยืนยัน composer กลับมาใช้งานได้ปกติไม่ค้างไม่ว่าทางไหน)
- [x] Logout → login อีก user → socket identity เปลี่ยนถูกต้อง (`e2e/tests/identity-switch.spec.ts` — ยืนยัน user ใหม่ไม่เห็น session/ข้อความของ user เดิมแม้ navigate ตรงไป URL เดิม)
- [x] เปิดหลาย tabs และทดสอบ refresh token race (`e2e/tests/refresh-token-race.spec.ts` — สอง page ใน browser context เดียวกัน, บังคับ race จริงด้วย network-level gate ที่ `/api/auth/refresh`, ยืนยันว่ามี tab หนึ่งใช้งานได้เสมอและ tab ที่แพ้ race redirect ไป `/login` สะอาดๆ)

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

1. [x] ออกแบบ encrypted provider credentials
2. [x] สร้าง settings API/UI
3. [x] Implement Claude provider
4. [x] Implement OpenAI provider
5. [x] เพิ่ม model selection และ provider connection test
6. [~] เพิ่ม provider integration tests (provider/error mapping unit tests ครอบคลุม mocked upstream แล้ว; ยังไม่มี integration test ผ่าน Socket.IO/test container จริง)

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
