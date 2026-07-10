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
| Phase 2 | Authentication และ users                    | `[~]` | Flow หลักเสร็จ แต่ refresh rotation ยังมี race condition  |
| Phase 3 | Angular shell และ design system             | `[x]` | Login/register/layout และ components หลักมีแล้ว           |
| Phase 4 | Chat session และ Ollama streaming           | `[~]` | ใช้งานได้ แต่ error/ownership/socket lifecycle ยังต้องแก้ |
| Phase 5 | Code artifacts และ Monaco Editor            | `[~]` | Source และ Docker build ผ่าน แต่ยังไม่ได้ E2E จริงครบถ้วน |
| Phase 6 | Claude/OpenAI และ provider settings         | `[ ]` | มีเพียง enum/type; runtime ยังรองรับเฉพาะ Ollama          |
| Phase 7 | Security hardening และ production readiness | `[ ]` | Rate limiting, Helmet, observability และ E2E ยังไม่มี     |

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
- [ ] ตรวจ `login.md`; หากมี credential จริงให้ลบจาก Git history และเปลี่ยนรหัสผ่าน
- [ ] เพิ่ม `.idea/` ลง `.gitignore` หากไม่ต้องการแชร์ IDE configuration

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

- [ ] เพิ่ม root scripts สำหรับ build/test/lint ทั้ง workspace เช่น `build`, `test`, `lint`, `check`
- [ ] เพิ่ม CI pipeline เพื่อรัน install, generate Prisma, build, test และ lint ทุก commit
- [ ] กำหนด line-ending policy ด้วย `.gitattributes` เพื่อลด warning LF/CRLF บน Windows
- [ ] กำหนด license ให้ชัดเจน หรือยืนยันว่าเป็น proprietary project
- [ ] ลบ Nest/Angular starter README ที่ไม่เกี่ยวข้อง หรือเปลี่ยนให้ลิงก์กลับ root README

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
- [ ] เพิ่ม cleanup policy สำหรับ refresh tokens ที่หมดอายุหรือ revoked แล้ว
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
- [ ] เปลี่ยน duplicate-email response จาก `UnauthorizedException` เป็น `ConflictException`
- [ ] ป้องกัน account enumeration ด้วยข้อความและ timing ที่เหมาะสม
- [ ] เพิ่ม rate limiting ให้ register, login และ refresh
- [ ] ตรวจ trusted proxy/IP handling ก่อนบันทึก `req.ip` ใน production

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

- [ ] เพิ่ม route `/settings/providers` หรือซ่อนปุ่ม settings จนกว่า Phase 6 จะพร้อม
- [ ] เพิ่ม rename/archive/delete session controls ใน UI
- [ ] เพิ่ม confirmation ก่อนลบ session
- [ ] เพิ่ม loading, empty และ error states ที่สม่ำเสมอ
- [ ] เพิ่ม toast/notification service
- [ ] เพิ่ม accessibility: labels, focus management, keyboard navigation และ ARIA states
- [ ] เพิ่ม mobile layout และตรวจ split-pane บนหน้าจอเล็ก
- [ ] เพิ่ม frontend component/store tests

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
- [ ] ตรวจว่า global REST auth guard ไม่รบกวน WebSocket handlers และเพิ่ม gateway-specific guard/test ให้ชัดเจน
- [ ] Validate WebSocket payloads แทนการเชื่อ type จาก client
- [ ] จำกัดขนาด `content`, `model`, filename และ artifact content

### P1 — Streaming correctness

- [x] ครอบ streaming pipeline ด้วย `catch` ที่ finalize message ทุก failure path
- [x] ย้าย `getProvider()`, registry setup และ parser processing เข้า error boundary เดียวกัน
- [x] หาก provider ไม่มีอยู่ ให้ reject ก่อนสร้าง assistant message หรือ finalize เป็น `error`
- [ ] ป้องกัน send ซ้อนหลาย stream ใน session เดียว หรือกำหนด concurrency policy ให้ชัดเจน
- [ ] ยกเลิก active streams ก่อนลบ session
- [ ] จัดการ client disconnect ระหว่าง stream
- [ ] กำหนด timeout สำหรับ Ollama request และ stream inactivity
- [ ] ตรวจ malformed/non-JSON lines จาก Ollama โดยไม่ทำให้ message ค้าง
- [ ] ปรับ session title อัตโนมัติจากข้อความแรก หากต้องการ UX แบบ chat application

### P1 — Frontend state race

- [ ] ป้องกัน HTTP response ของ session เก่าเขียนทับ session ใหม่
- [ ] Deduplicate message เมื่อ REST history และ socket event มาถึงใกล้กัน
- [ ] Disable หรือควบคุม Send ขณะกำลังส่ง/stream ตาม concurrency policy
- [ ] แสดงสถานะ socket disconnected/reconnecting
- [ ] แสดง upstream error ที่เข้าใจง่าย
- [ ] Scroll ไปข้อความล่าสุดอย่างเหมาะสม

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
- [ ] ยืนยัน reload session แล้วยังเห็นไฟล์ล่าสุด
- [x] ยืนยัน user edit สร้าง revision และ diff ถูกต้อง
- [ ] ทดสอบ stop generation กลาง code fence
- [ ] ทดสอบ malformed/unterminated/multiple code fences

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
- [~] จำกัดขนาดและจำนวน artifacts ต่อ message/session (จำกัดขนาด revision 1 MiB แล้ว; ยังไม่มี quota ต่อ message/session)
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
- [ ] เลือก encryption format สำหรับ API key แบบ authenticated encryption
- [ ] Validate `API_KEY_ENCRYPTION_KEY` เป็น key length/encoding ที่ถูกต้อง ไม่ใช่เพียง non-empty string
- [ ] สร้าง service สำหรับ encrypt/decrypt/rotate API keys
- [ ] ห้ามคืน decrypted key ผ่าน API หรือ log
- [ ] Implement OpenAI provider
- [ ] Implement Claude provider
- [ ] Register providers ใน `AiModule` และ `AiProviderFactory`
- [ ] เพิ่ม provider capability metadata เช่น models, streaming, max tokens
- [ ] เพิ่ม `/settings/providers` route และ page
- [ ] เพิ่ม wizard/modal สำหรับเพิ่ม API key และทดสอบ connection
- [ ] เพิ่ม model selector ตอนสร้างหรือแก้ session
- [ ] จำกัด DTO ให้เลือกเฉพาะ provider ที่ configured และ runtime รองรับ
- [ ] เพิ่ม endpoint ทดสอบ provider โดยไม่เปิดเผย key
- [ ] เพิ่ม key update/delete และ revocation flow
- [ ] เพิ่ม error mapping ของแต่ละ provider
- [ ] เพิ่ม tests ด้วย mocked upstream responses

เกณฑ์รับงาน:

- user บันทึกและลบ API key ได้โดยไม่มี plaintext key ใน database/log/response
- provider ทั้งสาม stream ผ่าน interface เดียวกัน
- session ไม่สามารถเลือก provider ที่ยังไม่ได้ configure
- settings route ไม่เป็น dead route

---

## Phase 7 — Security hardening และ Production readiness

### Security

- [ ] เพิ่ม Helmet และกำหนด CSP ให้รองรับ Monaco อย่างปลอดภัย
- [ ] เพิ่ม rate limiting สำหรับ REST และ WebSocket events
- [ ] เพิ่ม request/body size limits
- [ ] เพิ่ม WebSocket event validation pipe/schema
- [ ] กำหนด CORS allowlist แทนค่า origin เดียวแบบคลุมเครือ
- [ ] เพิ่ม secure headers ใน Nginx
- [ ] บังคับ HTTPS ใน production
- [ ] ตรวจ cookie flags ใน topology จริง
- [ ] เพิ่ม account lockout/backoff ที่ไม่เปิดช่อง DoS
- [ ] เพิ่ม audit log สำหรับ login, logout, token reuse และ provider-key changes
- [ ] ตรวจ dependency vulnerabilities และกำหนด update policy
- [ ] Threat-model cross-user access, token theft, prompt injection และ artifact filename attacks

### Reliability

- [ ] เพิ่ม graceful shutdown ให้ active streams
- [ ] เพิ่ม timeout/retry/circuit breaker สำหรับ AI providers
- [ ] เพิ่ม database connection/readiness checks
- [ ] กำหนด backup/restore procedure สำหรับ PostgreSQL
- [ ] เพิ่ม cleanup สำหรับ stale streaming artifacts และ refresh tokens
- [ ] เพิ่ม pagination และ retention policy
- [ ] ทดสอบ server restart ระหว่าง active stream
- [ ] ทดสอบ migration rollback/forward strategy

### Observability

- [ ] Structured JSON logging
- [ ] Correlation/request ID สำหรับ REST และ WebSocket
- [ ] Metrics: request rate, error rate, stream duration, first-token latency และ active streams
- [ ] Health/readiness endpoints แยกกัน
- [ ] Error reporting และ alerting
- [ ] ห้าม log prompts, tokens หรือ API keys โดยไม่มี explicit policy

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
- [ ] `OllamaProvider` parsing, abort และ upstream errors
- [ ] `ActiveStreamRegistry` register/stop/release
- [ ] Angular `AuthStore`, `ChatStore` และ `ArtifactStore`

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
3. [ ] Implement Claude provider
4. [ ] Implement OpenAI provider
5. [ ] เพิ่ม model selection และ provider connection test
6. [ ] เพิ่ม provider integration tests

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
